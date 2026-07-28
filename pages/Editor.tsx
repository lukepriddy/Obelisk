import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getTourById, getZonesByTourId, createZone as dbCreateZone, updateZone as dbUpdateZone, deleteZone as dbDeleteZone, updateTour as dbUpdateTour, requestPublish } from '../services/db';
import { ZoneForm } from '../components/ZoneForm';
import { TourInfoPanel } from '../components/TourInfoPanel';
import { EditorMap, EditorMapHandle } from '../components/EditorMap';
import { Tour, Zone, User } from '../types';
import { Save, Loader2, MousePointer2, PlusCircle, Home, Search, Info, MapPin, Undo2, Copy, X } from 'lucide-react';
import { MAP_DEFAULT_ZOOM, DEFAULT_MAP_STYLE } from '../constants';
import { isSatelliteKey } from '../services/mapStyle';

interface EditorProps {
  user: User;
}

type Tool = 'select' | 'draw' | 'place-start';
type RightPanel = 'zone' | 'tour';
type UndoEntry =
  | { type: 'create' | 'delete'; zone: Zone }
  | { type: 'edit'; tour: Tour; zones: Zone[] };

const isTextEditingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
};

const offsetDuplicatePosition = (zone: Zone): Pick<Zone, 'lat' | 'lng'> => {
  const offsetMeters = Math.min(Math.max(zone.radius * 0.35, 5), 18);
  const latOffset = offsetMeters / 111_320;
  const lngOffset = offsetMeters / (111_320 * Math.cos((zone.lat * Math.PI) / 180) || 1);
  return {
    lat: zone.lat + latOffset,
    lng: zone.lng + lngOffset,
  };
};

const cloneZoneForInsert = (zone: Zone): Partial<Zone> => {
  const { id: _id, ...fields } = zone as Zone & { created_at?: string };
  delete (fields as any).created_at;
  return {
    ...JSON.parse(JSON.stringify(fields)),
    ...offsetDuplicatePosition(zone),
    title: `Copy of ${zone.title || 'Zone'}`,
  };
};

// Geocoding search — drives the map via the EditorMap imperative handle.
const LocationSearch: React.FC<{ mapRef: React.RefObject<EditorMapHandle | null> }> = ({ mapRef }) => {
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
        mapRef.current.flyTo(parseFloat(data[0].lat), parseFloat(data[0].lon), 15);
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


export const Editor: React.FC<EditorProps> = ({ user }) => {
  const { tourId } = useParams<{ tourId: string }>();
  const navigate = useNavigate();
  
  const [tour, setTour] = useState<Tour | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [rightPanel, setRightPanel] = useState<RightPanel>('zone');
  const mapRef = useRef<EditorMapHandle | null>(null);
  
  // Editor map mirrors the tour's chosen map style (set in Tour Settings), so
  // what the creator places on is what the player will see. Defaults to satellite.
  const editorMapStyle = tour?.map_style || DEFAULT_MAP_STYLE;
  // Satellite imagery has no street/place labels — stack a labels overlay so
  // creators can still read where they're placing zones.
  const showSatelliteLabels = isSatelliteKey(editorMapStyle);
  // Tracks the current zoom level; saved with the tour so the player starts here.
  const editorMapZoomRef = useRef<number>(tour?.start_zoom ?? MAP_DEFAULT_ZOOM);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // True while the content review runs, so the Save button can say so.
  const [publishing, setPublishing] = useState(false);
  // The tour's is_public value as last known to the DATABASE — not the local
  // toggle. Publishing is detected as a false -> true change against this.
  const publishedRef = useRef(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const lastEditUndoRef = useRef<{ key: string; timestamp: number } | null>(null);

  // Pending zone updates — flushed on Save so all changes go out in one batch.
  const pendingZoneUpdatesRef = useRef<Map<string, Partial<Zone>>>(new Map());

  const pushEditUndo = (key: string) => {
    if (!tour) return;
    const now = Date.now();
    const last = lastEditUndoRef.current;
    if (last?.key === key && now - last.timestamp < 800) {
      lastEditUndoRef.current = { key, timestamp: now };
      return;
    }
    setUndoStack(prev => [...prev, { type: 'edit' as const, tour, zones }].slice(-60));
    lastEditUndoRef.current = { key, timestamp: now };
  };

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

  // 2) ⌘S / Ctrl+S keyboard shortcut — ref keeps the handler fresh every render.
  // Initialized with a no-op; the effect below syncs it before any user interaction.
  const saveTourRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => { saveTourRef.current = saveTour; });
  const copyBufferRef = useRef<Zone | null>(null);
  const duplicateZoneRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => { duplicateZoneRef.current = duplicateSelectedZone; });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveTourRef.current();
      }
      if (isTextEditingTarget(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndoRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const selected = zones.find(zone => zone.id === selectedZoneId && !zone.id.startsWith('temp_'));
        if (!selected) return;
        e.preventDefault();
        copyBufferRef.current = selected;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (!copyBufferRef.current && !selectedZoneId) return;
        e.preventDefault();
        pasteCopiedZoneRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateZoneRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedZoneId, zones]); // refs handle the actions; dependencies keep copy selection fresh

  const handleUndoRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const pasteCopiedZoneRef = useRef<() => Promise<void>>(() => Promise.resolve());


  const loadData = async (id: string) => {
    const tourData = await getTourById(id);
    if (!tourData) { navigate('/'); return; }
    setTour(tourData);
    publishedRef.current = tourData.is_public;
    // Sync the zoom ref now that we have the saved value — without this,
    // saving before the user zooms would reset start_zoom to MAP_DEFAULT_ZOOM.
    editorMapZoomRef.current = tourData.start_zoom ?? MAP_DEFAULT_ZOOM;
    const zonesData = await getZonesByTourId(id);
    setZones(zonesData);
    setLoading(false);
  };

  const handleMapClick = async (lat: number, lng: number) => {
    if (!tour) return;

    if (activeTool === 'place-start') {
      pushEditUndo('tour:start-location');
      const updated = { ...tour, lat, lng };
      setTour(updated);
      setActiveTool('select');
      await dbUpdateTour(tour.id, { lat, lng });
      return;
    }

    if (activeTool === 'draw') {
      const newZone: Partial<Zone> = {
        tour_id: tour.id,
        lat,
        lng,
        radius: 40,
        title: `Step ${zones.length + 1}`,
        media_url: '',
        voice_enabled: false,
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
        lastEditUndoRef.current = null;
      }
    }
  };

  const handleZoneClick = (id: string) => {
    setSelectedZoneId(id);
    setRightPanel('zone');
  };

  const updateZone = (id: string, updates: Partial<Zone>) => {
    pushEditUndo(`zone:${id}:${Object.keys(updates).sort().join(',')}`);
    setZones(prev => prev.map(z => z.id === id ? { ...z, ...updates } : z));
    if (!id.startsWith('temp_')) {
      // Merge into the pending queue — flushed when the user presses Save.
      const existing = pendingZoneUpdatesRef.current.get(id) ?? {};
      pendingZoneUpdatesRef.current.set(id, { ...existing, ...updates });
      setHasUnsavedChanges(true);
    }
  };

  const deleteZone = async (id: string) => {
    const zone = zones.find(z => z.id === id);
    if (!zone) return;
    setZones(prev => prev.filter(z => z.id !== id));
    setSelectedZoneId(null);
    if (!id.startsWith('temp_')) {
      await dbDeleteZone(id);
      setUndoStack(prev => [...prev, { type: 'delete', zone }]);
      lastEditUndoRef.current = null;
    }
  };

  const duplicateZone = async (source: Zone | null | undefined) => {
    if (!source || source.id.startsWith('temp_')) return;

    const tempId = 'temp_duplicate_' + Date.now();
    const optimisticZone = {
      ...source,
      ...offsetDuplicatePosition(source),
      id: tempId,
      title: `Copy of ${source.title || 'Zone'}`,
    };
    setZones(prev => [...prev, optimisticZone]);
    setSelectedZoneId(tempId);
    setRightPanel('zone');

    const saved = await dbCreateZone(cloneZoneForInsert(source));
    if (saved) {
      setZones(prev => prev.map(zone => zone.id === tempId ? saved : zone));
      setSelectedZoneId(saved.id);
      copyBufferRef.current = saved;
      setUndoStack(prev => [...prev, { type: 'create', zone: saved }]);
      lastEditUndoRef.current = null;
    } else {
      setZones(prev => prev.filter(zone => zone.id !== tempId));
      setSelectedZoneId(source.id);
    }
  };

  const duplicateSelectedZone = async () => {
    const source = zones.find(zone => zone.id === selectedZoneId && !zone.id.startsWith('temp_'));
    await duplicateZone(source);
  };

  const pasteCopiedZone = async () => {
    const source = copyBufferRef.current
      || zones.find(zone => zone.id === selectedZoneId && !zone.id.startsWith('temp_'));
    await duplicateZone(source);
  };
  pasteCopiedZoneRef.current = pasteCopiedZone;

  const handleUndo = async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack(prev => prev.slice(0, -1));

    lastEditUndoRef.current = null;

    if (last.type === 'edit') {
      const currentTour = tour;
      setTour(last.tour);
      setZones(last.zones);
      setSelectedZoneId(current =>
        current && last.zones.some(zone => zone.id === current) ? current : null
      );

      pendingZoneUpdatesRef.current.clear();
      last.zones.forEach(zone => {
        if (zone.id.startsWith('temp_')) return;
        const { id: _id, tour_id: _tourId, ...updates } = zone;
        pendingZoneUpdatesRef.current.set(zone.id, updates);
      });
      setHasUnsavedChanges(true);

      if (
        currentTour &&
        (currentTour.lat !== last.tour.lat || currentTour.lng !== last.tour.lng)
      ) {
        await dbUpdateTour(last.tour.id, { lat: last.tour.lat, lng: last.tour.lng });
      }
    } else if (last.type === 'create') {
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
  handleUndoRef.current = handleUndo;

  const updateTourFields = (updates: Partial<typeof tour>) => {
    if (!tour) return;
    pushEditUndo(`tour:${Object.keys(updates).sort().join(',')}`);
    setTour({ ...tour, ...updates });
    if (updates.progression_resources) {
      const validIds = new Set(updates.progression_resources.map(resource => resource.id));
      setZones(prev => prev.map(zone => {
        const progression_rewards = (zone.progression_rewards || [])
          .filter(reward => validIds.has(reward.resource_id));
        const progression_requirements = (zone.progression_requirements || [])
          .filter(requirement => validIds.has(requirement.resource_id));
        if (
          progression_rewards.length === (zone.progression_rewards || []).length &&
          progression_requirements.length === (zone.progression_requirements || []).length
        ) return zone;
        if (!zone.id.startsWith('temp_')) {
          const existing = pendingZoneUpdatesRef.current.get(zone.id) ?? {};
          pendingZoneUpdatesRef.current.set(zone.id, {
            ...existing,
            progression_rewards,
            progression_requirements,
          });
        }
        return { ...zone, progression_rewards, progression_requirements };
      }));
    }
    setHasUnsavedChanges(true);
  };

  const saveTour = async () => {
    if (!tour || saving) return; // guard against concurrent saves (e.g. Cmd+S spam)
    setSaving(true);
    setSaveError(null);

    // Flush all pending zone updates in parallel with the tour save.
    const zoneSaves = Array.from(pendingZoneUpdatesRef.current.entries()).map(
      ([id, updates]) => dbUpdateZone(id, updates)
    );

    // Publishing is gated: a DB trigger refuses `is_public = true` from the
    // client, so a false -> true transition has to go through the review
    // service instead of riding along in this batched update.
    const wantsToPublish = tour.is_public && !publishedRef.current;

    try {
      await Promise.all([
        ...zoneSaves,
        dbUpdateTour(tour.id, {
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
          description_align: tour.description_align,
          tags: tour.tags || [],
          ...(wantsToPublish ? {} : { is_public: tour.is_public }),
          lat: tour.lat,
          lng: tour.lng,
          start_zoom: editorMapZoomRef.current,
          progression_enabled: tour.progression_enabled,
          progression_resources: tour.progression_resources || [],
        }),
      ]);
      pendingZoneUpdatesRef.current.clear();

      if (wantsToPublish) {
        // Content is saved at this point, so the review reads exactly what the
        // creator sees. Admins come back approved immediately.
        setPublishing(true);
        const result = await requestPublish(tour.id);
        setPublishing(false);
        publishedRef.current = result.is_public;
        setTour(prev => prev && ({
          ...prev,
          is_public: result.is_public,
          moderation_status: result.status,
          moderation_reason: result.reason ?? null,
        }));
        if (!result.is_public) {
          // Leave the toggle showing the truth — still private — with the
          // reason attached so the creator knows what to change.
          setHasUnsavedChanges(false);
          setSaving(false);
          return;
        }
      } else {
        publishedRef.current = tour.is_public;
      }

      setHasUnsavedChanges(false);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (err) {
      console.error('saveTour failed:', err);
      setSaveError('Save failed — check your connection and try again.');
    } finally {
      setPublishing(false);
      setSaving(false);
    }
  };

  if (loading || !tour) return <div className="flex justify-center items-center h-full bg-zinc-950 text-emerald-500"><Loader2 className="animate-spin"/></div>;

  const selectedZone = zones.find(z => z.id === selectedZoneId);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-zinc-950">

      {/* 1. LEFT TOOLBAR */}
      <div className="hidden md:flex w-16 flex-col items-center py-4 gap-3 bg-zinc-950 border-r border-zinc-800 z-30 shrink-0">
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

        {/* Duplicate Zone */}
        <button
          onClick={duplicateSelectedZone}
          disabled={!selectedZone || selectedZone.id.startsWith('temp_')}
          className="p-3 rounded-lg transition-all text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed"
          title="Duplicate selected zone (⌘D or ⌘C then ⌘V)"
        >
          <Copy size={22} />
        </button>

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
      <div className="flex-1 min-w-0 relative h-full">
         {/* Map Header Overlay */}
         <div className="absolute top-2 left-2 right-2 md:top-4 md:left-4 md:right-4 z-[400] pointer-events-none flex justify-between items-start gap-2">
             <div className="bg-zinc-900/95 backdrop-blur border border-zinc-700 p-2 rounded-lg pointer-events-auto flex gap-2 md:gap-4 items-center min-w-0 flex-1 md:flex-initial">
                 <button
                   onClick={() => {
                     if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Leave without saving?')) return;
                     navigate('/');
                   }}
                   className="md:hidden p-1.5 shrink-0 text-zinc-400 hover:text-white rounded"
                   title="Back to Dashboard"
                 >
                   <Home size={18} />
                 </button>
                 <div className="min-w-0 flex-1">
                   <input
                    className="bg-transparent text-white font-bold outline-none placeholder-zinc-500 w-full min-w-0 text-sm md:text-base"
                    value={tour.title}
                    onChange={(e) => updateTourFields({ title: e.target.value })}
                  />
                  <div className="hidden sm:block text-xs text-zinc-400">
                    {zones.length} Zones • {activeTool.toUpperCase()} MODE
                  </div>
                 </div>
                 <button
                   onClick={() => { setRightPanel('tour'); setSelectedZoneId(null); }}
                   className={`p-2 shrink-0 rounded text-white transition-colors ${rightPanel === 'tour' && !selectedZoneId ? 'bg-zinc-700' : 'hover:bg-zinc-700 text-zinc-400'}`}
                   title="Tour Settings"
                 >
                   <Info size={18} />
                 </button>
                 <div className="flex items-center gap-2 shrink-0">
                   {saveError && (
                     <span className="hidden sm:inline text-xs text-red-400 font-medium max-w-[160px] truncate" title={saveError}>{saveError}</span>
                   )}
                   {hasUnsavedChanges && !saving && !saveError && (
                     <span className="hidden sm:inline text-xs text-amber-400 font-medium animate-pulse">Unsaved changes</span>
                   )}
                   {savedOk && !hasUnsavedChanges && !saveError && (
                     <span className="hidden sm:inline text-xs text-emerald-400 font-medium">Saved ✓</span>
                   )}
                   <button
                     onClick={saveTour}
                     disabled={saving}
                     title="Save (⌘S)"
                     className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded text-white text-xs font-semibold transition-all disabled:opacity-60 ${saveError ? 'bg-red-600 hover:bg-red-500' : hasUnsavedChanges ? 'bg-amber-500 hover:bg-amber-400 shadow-lg shadow-amber-900/40' : 'bg-emerald-600 hover:bg-emerald-500'}`}
                   >
                     {saving ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>}
                     {saveError ? 'Retry' : publishing ? 'Checking…' : 'Save'}
                   </button>
                 </div>
             </div>
             <div className="hidden md:block pointer-events-auto">
               <LocationSearch mapRef={mapRef} />
             </div>
         </div>

         <EditorMap
            ref={mapRef}
            tour={tour}
            zones={zones}
            styleKey={editorMapStyle}
            activeTool={activeTool}
            selectedZoneId={selectedZoneId}
            showSatelliteLabels={showSatelliteLabels}
            zoomRef={editorMapZoomRef}
            onMapClick={handleMapClick}
            onZoneClick={handleZoneClick}
            onZoneDragEnd={(id, lat, lng) => updateZone(id, { lat, lng })}
            onStartDragEnd={(lat, lng) => {
              pushEditUndo('tour:start-location');
              setTour({ ...tour, lat, lng });
              dbUpdateTour(tour.id, { lat, lng });
            }}
          />
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

      {/* MOBILE TOOLBAR — the left rail is desktop-only, so mirror its actions
          here within thumb reach. Hidden while the sheet is up (sheet owns the
          bottom of the screen). */}
      {!(selectedZoneId || rightPanel === 'tour') && (
        <div
          className="md:hidden fixed inset-x-2 bottom-2 z-[450] flex items-center justify-around gap-1 rounded-2xl bg-zinc-900/95 backdrop-blur border border-zinc-700 px-1 py-1.5 shadow-2xl"
          style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <button
            onClick={() => setActiveTool('select')}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 rounded-xl text-[10px] font-bold transition-all ${activeTool === 'select' ? 'bg-emerald-500 text-white' : 'text-zinc-400'}`}
          >
            <MousePointer2 size={19} /> Select
          </button>
          <button
            onClick={() => setActiveTool('draw')}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 rounded-xl text-[10px] font-bold transition-all ${activeTool === 'draw' ? 'bg-emerald-500 text-white' : 'text-zinc-400'}`}
          >
            <PlusCircle size={19} /> Add
          </button>
          <button
            onClick={() => setActiveTool('place-start')}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 rounded-xl text-[10px] font-bold transition-all ${activeTool === 'place-start' ? 'bg-amber-500 text-white' : 'text-zinc-400'}`}
          >
            <MapPin size={19} /> Start
          </button>
          <button
            onClick={duplicateSelectedZone}
            disabled={!selectedZone || selectedZone.id.startsWith('temp_')}
            className="flex-1 flex flex-col items-center gap-0.5 py-2 rounded-xl text-[10px] font-bold text-zinc-400 disabled:opacity-25"
          >
            <Copy size={19} /> Copy
          </button>
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            className="flex-1 flex flex-col items-center gap-0.5 py-2 rounded-xl text-[10px] font-bold text-zinc-400 disabled:opacity-25"
          >
            <Undo2 size={19} /> Undo
          </button>
        </div>
      )}

      {/* 3. RIGHT PROPERTIES PANEL */}
      {(selectedZoneId || rightPanel === 'tour') && (
        <div className="fixed inset-x-0 bottom-0 top-auto h-[65vh] rounded-t-2xl border-t z-[600] animate-in slide-in-from-bottom-10
                        md:static md:h-full md:w-80 md:max-w-[88vw] md:rounded-none md:border-t-0 md:border-l md:z-20 md:shrink-0 md:animate-in md:slide-in-from-right-10
                        bg-zinc-900 border-zinc-800 p-4 shadow-2xl overflow-y-auto overflow-x-hidden custom-scrollbar"
             style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
          {/* Sheet handle + close — mobile only; desktop dismisses via the map */}
          <div className="md:hidden sticky -top-4 -mx-4 -mt-4 mb-3 px-4 pt-2 pb-2 bg-zinc-900/95 backdrop-blur flex items-center justify-between border-b border-zinc-800">
            <div className="w-10 h-1 rounded-full bg-zinc-700" />
            <button
              onClick={() => { setSelectedZoneId(null); setRightPanel('zone'); }}
              className="p-1.5 -mr-1.5 text-zinc-400 hover:text-white"
              aria-label="Close panel"
            >
              <X size={18} />
            </button>
          </div>
          {selectedZoneId && selectedZone ? (
            selectedZone.id.startsWith('temp_') ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-zinc-500">
                <Loader2 size={22} className="animate-spin text-emerald-500" />
                <span className="text-sm">Creating zone…</span>
              </div>
            ) : (
            <ZoneForm
              key={selectedZone.id}
              zone={selectedZone}
              onUpdate={(u) => updateZone(selectedZone.id, u)}
              onDelete={() => deleteZone(selectedZone.id)}
              zonesList={zones}
              progressionEnabled={tour.progression_enabled === true}
              progressionResources={tour.progression_resources || []}
            />
            )
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
