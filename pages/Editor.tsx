import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { getTourById, getZonesByTourId, createZone as dbCreateZone, updateZone as dbUpdateZone, deleteZone as dbDeleteZone, updateTour as dbUpdateTour } from '../services/db';
import { ZoneForm } from '../components/ZoneForm';
import { TourInfoPanel } from '../components/TourInfoPanel';
import { Tour, Zone, User } from '../types';
import { Save, Loader2, MousePointer2, PlusCircle, Trash2, Home, Search, Info, MapPin, Undo2 } from 'lucide-react';
import { MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, MAP_STYLES } from '../constants';

// Leaflet Icon Fix
const DefaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

const StartPinIcon = L.divIcon({
  html: `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
    <div style="background:#10b981;width:22px;height:22px;border-radius:50%;border:3px solid white;box-shadow:0 0 0 2px #10b981,0 2px 8px rgba(16,185,129,0.5)"></div>
    <div style="background:#10b981;color:white;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;letter-spacing:0.05em">START</div>
  </div>`,
  className: '',
  iconSize: [60, 38],
  iconAnchor: [30, 11],
});

interface EditorProps {
  user: User;
}

type Tool = 'select' | 'draw' | 'place-start';
type RightPanel = 'zone' | 'tour';

// Geocoding search — uses a map ref instead of useMap() so it can live outside MapContainer
const LocationSearch: React.FC<{ mapRef: React.RefObject<L.Map | null> }> = ({ mapRef }) => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!query.trim() || !mapRef.current) return;
    setLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`
      );
      const data = await res.json();
      if (data[0]) {
        mapRef.current.flyTo([parseFloat(data[0].lat), parseFloat(data[0].lon)], 15, { duration: 1.2 });
      }
    } catch (e) {
      console.error('Geocoding failed', e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-1 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg px-2 py-1.5 pointer-events-auto">
      <Search size={14} className="text-zinc-400 shrink-0" />
      <input
        className="bg-transparent text-white text-sm outline-none placeholder-zinc-500 w-40"
        placeholder="Jump to location..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && search()}
      />
      {loading && <Loader2 size={13} className="text-zinc-400 animate-spin shrink-0" />}
    </div>
  );
};

// Forces Leaflet to remeasure its container — fixes grey tile gaps after layout shifts
const InvalidateSize: React.FC<{ trigger: any }> = ({ trigger }) => {
  const map = useMap();
  useEffect(() => {
    // Small delay lets the CSS transition finish before measuring
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => clearTimeout(t);
  }, [map, trigger]);
  return null;
};

// Ensures scroll wheel zoom (= trackpad zoom) stays enabled after every render
const EnsureWheelZoom: React.FC = () => {
  const map = useMap();
  useEffect(() => {
    if (!map.scrollWheelZoom.enabled()) {
      console.warn('[EnsureWheelZoom] scrollWheelZoom was disabled — re-enabling');
      map.scrollWheelZoom.enable();
    }
  });
  return null;
};

// Component to handle map interactions based on active tool
const MapInteraction = ({
  tool,
  onMapClick
}: {
  tool: Tool,
  onMapClick: (e: L.LeafletMouseEvent) => void
}) => {
  const map = useMap();

  useEffect(() => {
    if (tool === 'draw' || tool === 'place-start') {
      map.getContainer().style.cursor = 'crosshair';
    } else {
      map.getContainer().style.cursor = 'grab';
    }
  }, [tool, map]);

  useMapEvents({
    click(e) {
      if (tool === 'draw' || tool === 'place-start') onMapClick(e);
    },
  });
  return null;
};

export const Editor: React.FC<EditorProps> = ({ user }) => {
  const { tourId } = useParams<{ tourId: string }>();
  const navigate = useNavigate();
  
  const [tour, setTour] = useState<Tour | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [rightPanel, setRightPanel] = useState<RightPanel>('zone');
  const mapRef = useRef<L.Map | null>(null);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [undoStack, setUndoStack] = useState<Array<{ type: 'create' | 'delete'; zone: Zone }>>([]);

  useEffect(() => {
    if (tourId) loadData(tourId);
  }, [tourId]);

  // ── Unsaved-changes guards ──────────────────────────────────────────────────
  // 1) Browser refresh / tab close — native "Leave site?" dialog
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);


  const loadData = async (id: string) => {
    const tourData = await getTourById(id);
    if (!tourData) { navigate('/'); return; }
    setTour(tourData);
    const zonesData = await getZonesByTourId(id);
    setZones(zonesData);
    setLoading(false);
  };

  const handleMapClick = async (e: L.LeafletMouseEvent) => {
    if (!tour) return;

    if (activeTool === 'place-start') {
      const updated = { ...tour, lat: e.latlng.lat, lng: e.latlng.lng };
      setTour(updated);
      setActiveTool('select');
      await dbUpdateTour(tour.id, { lat: e.latlng.lat, lng: e.latlng.lng });
      return;
    }

    if (activeTool === 'draw') {
      const newZone: Partial<Zone> = {
        tour_id: tour.id,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
        radius: 40,
        title: `Step ${zones.length + 1}`,
        media_url: '',
      };
      const tempId = 'temp_' + Date.now();
      const zoneWithId = { ...newZone, id: tempId } as Zone;
      setZones(prev => [...prev, zoneWithId]);
      setSelectedZoneId(tempId);
      setActiveTool('select');

      const saved = await dbCreateZone(newZone);
      if (saved) {
        setZones(prev => prev.map(z => z.id === tempId ? saved : z));
        setSelectedZoneId(saved.id);
        setUndoStack(prev => [...prev, { type: 'create', zone: saved }]);
      }
    }
  };

  const handleZoneClick = (id: string) => {
    setSelectedZoneId(id);
    setRightPanel('zone');
  };

  const updateZone = async (id: string, updates: Partial<Zone>) => {
    setZones(prev => prev.map(z => z.id === id ? { ...z, ...updates } : z));
    if (!id.startsWith('temp_')) await dbUpdateZone(id, updates);
  };

  const deleteZone = async (id: string) => {
    const zone = zones.find(z => z.id === id);
    if (!zone) return;
    setZones(prev => prev.filter(z => z.id !== id));
    setSelectedZoneId(null);
    if (!id.startsWith('temp_')) {
      await dbDeleteZone(id);
      setUndoStack(prev => [...prev, { type: 'delete', zone }]);
    }
  };

  const handleUndo = async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack(prev => prev.slice(0, -1));

    if (last.type === 'create') {
      // Undo a zone creation → delete it
      setZones(prev => prev.filter(z => z.id !== last.zone.id));
      setSelectedZoneId(null);
      await dbDeleteZone(last.zone.id);
    } else {
      // Undo a zone deletion → recreate it
      const restored = await dbCreateZone(last.zone);
      if (restored) {
        setZones(prev => [...prev, restored]);
        setSelectedZoneId(restored.id);
      }
    }
  };

  const updateTourFields = (updates: Partial<typeof tour>) => {
    if (!tour) return;
    setTour({ ...tour, ...updates });
    setHasUnsavedChanges(true);
  };

  const saveTour = async () => {
    if (!tour) return;
    setSaving(true);
    await dbUpdateTour(tour.id, {
      title: tour.title,
      description: tour.description,
      welcome_subtitle: tour.welcome_subtitle,
      welcome_image_url: tour.welcome_image_url,
      accent_color: tour.accent_color,
      bg_color: tour.bg_color,
      text_color: tour.text_color,
      font_style: tour.font_style,
      map_style: tour.map_style,
      player_theme: tour.player_theme,
      is_public: tour.is_public,
      lat: tour.lat,
      lng: tour.lng,
    });
    setSaving(false);
    setHasUnsavedChanges(false);
    setSavedOk(true);
    setTimeout(() => setSavedOk(false), 2000);
  };

  if (loading || !tour) return <div className="flex justify-center items-center h-full bg-zinc-950 text-emerald-500"><Loader2 className="animate-spin"/></div>;

  const selectedZone = zones.find(z => z.id === selectedZoneId);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-950">

      {/* 1. LEFT TOOLBAR */}
      <div className="w-16 flex flex-col items-center py-4 gap-3 bg-zinc-950 border-r border-zinc-800 z-30 shrink-0">
        <button
          onClick={() => {
            if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Leave without saving?')) return;
            navigate('/');
          }}
          className="p-2 mb-2 text-zinc-500 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors"
          title="Back to Dashboard"
        >
          <Home size={24} />
        </button>

        <div className="w-8 h-px bg-zinc-800" />

        {/* Select */}
        <button
          onClick={() => setActiveTool('select')}
          className={`p-3 rounded-lg transition-all ${activeTool === 'select' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-900/50' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
          title="Select / Move"
        >
          <MousePointer2 size={22} />
        </button>

        {/* Add Zone */}
        <button
          onClick={() => setActiveTool('draw')}
          className={`p-3 rounded-lg transition-all ${activeTool === 'draw' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-900/50' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
          title="Add Zone — click map to place"
        >
          <PlusCircle size={22} />
        </button>

        {/* Place / Move Start Pin */}
        <button
          onClick={() => setActiveTool('place-start')}
          className={`p-3 rounded-lg transition-all ${activeTool === 'place-start' ? 'bg-amber-500 text-white shadow-lg shadow-amber-900/50' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
          title={tour.lat === 0 && tour.lng === 0 ? 'Place Start Point — click map' : 'Move Start Point — click map'}
        >
          <MapPin size={22} />
        </button>

        <div className="w-8 h-px bg-zinc-800" />

        {/* Undo */}
        <button
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          className="p-3 rounded-lg transition-all text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed"
          title="Undo"
        >
          <Undo2 size={22} />
        </button>

      </div>

      {/* 2. CENTER MAP */}
      <div className="flex-1 relative h-full">
         {/* Map Header Overlay */}
         <div className="absolute top-4 left-4 right-4 z-[400] pointer-events-none flex justify-between items-start gap-2">
             <div className="bg-zinc-900/95 backdrop-blur border border-zinc-700 p-2 rounded-lg pointer-events-auto flex gap-4 items-center">
                 <div>
                   <input
                    className="bg-transparent text-white font-bold outline-none placeholder-zinc-500"
                    value={tour.title}
                    onChange={(e) => updateTourFields({ title: e.target.value })}
                  />
                  <div className="text-xs text-zinc-400">
                    {zones.length} Zones • {activeTool.toUpperCase()} MODE
                  </div>
                 </div>
                 <button
                   onClick={() => { setRightPanel('tour'); setSelectedZoneId(null); }}
                   className={`p-2 rounded text-white transition-colors ${rightPanel === 'tour' && !selectedZoneId ? 'bg-zinc-700' : 'hover:bg-zinc-700 text-zinc-400'}`}
                   title="Tour Settings"
                 >
                   <Info size={18} />
                 </button>
                 <div className="flex items-center gap-2">
                   {hasUnsavedChanges && !saving && (
                     <span className="text-[10px] text-amber-400 font-medium animate-pulse">Unsaved</span>
                   )}
                   {savedOk && !hasUnsavedChanges && (
                     <span className="text-[10px] text-emerald-400 font-medium">Saved ✓</span>
                   )}
                   <button
                     onClick={saveTour}
                     className={`relative p-2 rounded text-white transition-colors ${hasUnsavedChanges ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
                   >
                     {saving ? <Loader2 className="animate-spin" size={18}/> : <Save size={18}/>}
                   </button>
                 </div>
             </div>
             <LocationSearch mapRef={mapRef} />
         </div>

         <MapContainer
            ref={mapRef}
            center={tour.lat === 0 && tour.lng === 0 ? MAP_DEFAULT_CENTER : [tour.lat, tour.lng]}
            zoom={MAP_DEFAULT_ZOOM}
            style={{ height: '100%', width: '100%', background: '#09090b' }}
            zoomControl={false}
            scrollWheelZoom={true}
          >
            <TileLayer
              key={tour.map_style || 'dark'}
              url={(MAP_STYLES[tour.map_style || 'dark'] || MAP_STYLES.dark).url}
              attribution={(MAP_STYLES[tour.map_style || 'dark'] || MAP_STYLES.dark).attribution}
            />
            <EnsureWheelZoom />
            <MapInteraction tool={activeTool} onMapClick={handleMapClick} />
            <InvalidateSize trigger={`${selectedZoneId}-${rightPanel}`} />
            
            {zones.map(zone => (
              <React.Fragment key={zone.id}>
                {/* Visual Circle */}
                <Circle 
                  center={[zone.lat, zone.lng]}
                  radius={zone.radius}
                  pathOptions={(() => {
                    const isSelected = selectedZoneId === zone.id;
                    const isChar = zone.type === 'character';
                    const isLocked = zone.lock_type === 'passphrase';
                    // Match player colors: selected=emerald, char=indigo, locked=amber, audio=slate/teal
                    const baseColor = isSelected ? '#10b981' : isLocked ? '#f59e0b' : isChar ? '#6366f1' : (zone.is_visible ? '#5b6b7c' : '#475569');
                    return {
                      color: baseColor,
                      fillColor: baseColor,
                      fillOpacity: isSelected ? 0.25 : 0.12,
                      weight: isLocked ? 2 : isChar ? 2 : 1,
                      dashArray: zone.is_visible ? undefined : '5, 10',
                    };
                  })()}
                  eventHandlers={{
                    click: () => handleZoneClick(zone.id)
                  }}
                />
                
                {/* Draggable Center Marker */}
                <Marker 
                  position={[zone.lat, zone.lng]}
                  draggable={activeTool === 'select'}
                  opacity={activeTool === 'draw' ? 0.5 : 1}
                  eventHandlers={{
                    click: () => handleZoneClick(zone.id),
                    dragend: (e) => {
                      if (activeTool !== 'select') return;
                      const marker = e.target;
                      const position = marker.getLatLng();
                      updateZone(zone.id, { lat: position.lat, lng: position.lng });
                    }
                  }}
                />
              </React.Fragment>
            ))}
            {/* Start Location Pin — only shown once placed */}
            {(tour.lat !== 0 || tour.lng !== 0) && (
              <Marker
                position={[tour.lat, tour.lng]}
                icon={StartPinIcon}
                draggable={true}
                eventHandlers={{
                  dragend: (e) => {
                    const pos = e.target.getLatLng();
                    const updated = { ...tour, lat: pos.lat, lng: pos.lng };
                    setTour(updated);
                    dbUpdateTour(tour.id, { lat: pos.lat, lng: pos.lng });
                  }
                }}
              />
            )}
          </MapContainer>
      </div>

      {/* Place-start hint overlay */}
      {activeTool === 'place-start' && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[500] pointer-events-none">
          <div className="bg-amber-500 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg flex items-center gap-2">
            <MapPin size={14} /> Click the map to place the start point
          </div>
        </div>
      )}

      {/* No start point hint */}
      {tour.lat === 0 && tour.lng === 0 && activeTool !== 'place-start' && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[500] pointer-events-none">
          <div className="bg-zinc-900/95 border border-amber-500/50 text-amber-400 text-sm px-4 py-2 rounded-full shadow-lg flex items-center gap-2">
            <MapPin size={14} /> No start point set — use the flag tool to place one
          </div>
        </div>
      )}

      {/* 3. RIGHT PROPERTIES PANEL */}
      {(selectedZoneId || rightPanel === 'tour') && (
        <div className="w-80 bg-zinc-900 border-l border-zinc-800 p-4 shadow-2xl z-20 h-full overflow-y-auto shrink-0 animate-in slide-in-from-right-10 custom-scrollbar">
          {selectedZoneId && selectedZone ? (
            <ZoneForm
              zone={selectedZone}
              onUpdate={(u) => updateZone(selectedZone.id, u)}
              onDelete={() => deleteZone(selectedZone.id)}
              zonesList={zones}
            />
          ) : rightPanel === 'tour' && tour ? (
            <TourInfoPanel tour={tour} onUpdate={updateTourFields} />
          ) : (
            <div className="text-zinc-500 text-center mt-20">Select a zone</div>
          )}
        </div>
      )}
    </div>
  );
};