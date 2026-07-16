import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import circle from '@turf/circle';
import { getTourById, getZonesByTourId } from '../services/db';
import { MAP_STYLES } from '../constants';
import { Tour, Zone } from '../types';

// ── Style plumbing ──────────────────────────────────────────────────────────
// CARTO ships free, keyless *vector* GL styles — the vector twins of the raster
// tiles the app already uses. This is the whole point of the prototype: prove we
// can get vector rendering (smooth zoom, crisp labels, pitch/rotate) with NO
// Mapbox account or billing. Satellite has no free vector equivalent, so it
// stays raster (Esri). Same engine renders both.
const VECTOR_STYLES: Record<string, string> = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
};

// Leaflet tile templates use {s} (subdomain) and {r} (retina) tokens MapLibre
// doesn't understand. Expand {s} into an explicit subdomain list and drop {r}.
function rasterTiles(url: string): string[] {
  const base = url.replace('{r}', '');
  return base.includes('{s}')
    ? ['a', 'b', 'c'].map(s => base.replace('{s}', s))
    : [base];
}

function rasterStyle(key: string): maplibregl.StyleSpecification {
  const s = MAP_STYLES[key] || MAP_STYLES.satellite;
  // Esri World Imagery (and OSM streets) only have real tiles to ~z19. Cap the
  // source maxzoom there so MapLibre upscales its z19 tiles past that instead of
  // requesting tiles Esri doesn't have — which come back as gray "Map data not
  // yet available" placeholders. This mirrors Leaflet's maxNativeZoom={19}.
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster', tiles: rasterTiles(s.url), tileSize: 256,
        maxzoom: 19, attribution: s.attribution,
      },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

function styleFor(key: string): string | maplibregl.StyleSpecification {
  return VECTOR_STYLES[key] ?? rasterStyle(key);
}

// ── Zone geometry ────────────────────────────────────────────────────────────
// The known-hard part of leaving Leaflet: MapLibre has no meter-radius circle.
// turf.circle turns a centre + metre radius into a 64-gon GeoJSON polygon, which
// we render as one data-driven fill+line pair for ALL zones at once.
const ZONE_COLORS = {
  active: '#3b82f6', locked: '#f59e0b', character: '#8b5cf6',
  discoverable: '#ec4899', audio: '#10b981',
};

function zoneColor(z: Zone): string {
  if (z.lock_type === 'passphrase') return ZONE_COLORS.locked;
  if (z.type === 'character') return ZONE_COLORS.character;
  if (z.type === 'discoverable') return ZONE_COLORS.discoverable;
  return ZONE_COLORS.audio;
}

// Zone fill + outline, driven entirely by feature properties so one pair of
// layers renders every zone. Shared between the first-load path and the
// transformStyle merge used on style switches.
const ZONE_LAYERS: maplibregl.LayerSpecification[] = [
  {
    id: 'zone-fill', type: 'fill', source: 'zones',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] },
  },
  {
    id: 'zone-line', type: 'line', source: 'zones',
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'weight'] },
  },
];

function zonesToGeoJSON(zones: Zone[]): GeoJSON.FeatureCollection {
  const features = zones
    .filter(z => z.is_visible !== false)
    .map(z => {
      const color = zoneColor(z);
      const f = circle([z.lng, z.lat], (z.radius || 20) / 1000, {
        steps: 64,
        units: 'kilometers',
      });
      f.properties = { color, fillOpacity: 0.18, weight: 2, title: z.title };
      return f;
    });
  return { type: 'FeatureCollection', features };
}

export const MapLibreLab: React.FC = () => {
  const { tourId } = useParams();
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const zonesRef = useRef<Zone[]>([]);

  const [tour, setTour] = useState<Tour | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [styleKey, setStyleKey] = useState('dark');
  const [renderer, setRenderer] = useState<'vector' | 'raster'>('vector');
  const [hud, setHud] = useState({ zoom: 0, pitch: 0, bearing: 0 });
  const [userPos, setUserPos] = useState<[number, number] | null>(null);

  // Load a real tour so we're drawing real zones, not toy data.
  useEffect(() => {
    const id = tourId || '0a383c3d-dd52-407c-ac7c-d3978e9ce419'; // Blackwater Trail
    (async () => {
      const [t, z] = await Promise.all([getTourById(id), getZonesByTourId(id)]);
      setTour(t);
      setZones(z);
      if (t) setUserPos([t.lat, t.lng]);
    })();
  }, [tourId]);

  // Add zone circles (source + fill + line). Used for the FIRST style; switches
  // go through transformStyle (below) so the layers are never wiped mid-swap.
  const addZoneLayers = (map: maplibregl.Map, data: GeoJSON.FeatureCollection) => {
    if (map.getSource('zones')) {
      (map.getSource('zones') as maplibregl.GeoJSONSource).setData(data);
      return;
    }
    map.addSource('zones', { type: 'geojson', data });
    ZONE_LAYERS.forEach(l => map.addLayer(l));
  };

  // Init map once we have a tour to centre on.
  useEffect(() => {
    if (!tour || !containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleFor('dark'),
      center: [tour.lng, tour.lat],
      // Tours store start_zoom for satellite (up to 22); vector maps have nothing
      // to draw that deep, so cap the opening zoom for a fair comparison.
      zoom: Math.min(tour.start_zoom ?? 17, 18),
      pitch: 0,
      bearing: 0,
      maxZoom: 22,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    (window as unknown as { __map: maplibregl.Map }).__map = map;
    map.on('error', (e) => console.error('[maplibre error]', e && (e as { error?: Error }).error));

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    // Attach zone layers on 'styledata', which fires as soon as the style JSON is
    // parsed — well before glyphs/sprite resolve. (Don't gate on 'load'/'idle':
    // those wait for the sprite, which can hang, and we don't need it for our own
    // GeoJSON layers.) addZoneLayers is idempotent and re-adds after a setStyle
    // wipe, so calling it on every styledata is safe.
    const attachZones = () => {
      try { addZoneLayers(map, zonesToGeoJSON(zonesRef.current)); } catch { /* style mid-swap; next styledata retries */ }
    };
    map.on('styledata', attachZones);
    map.on('move', () => setHud({
      zoom: +map.getZoom().toFixed(1),
      pitch: Math.round(map.getPitch()),
      bearing: Math.round(map.getBearing()),
    }));

    // Draggable simulated-player marker — created here, inside the map's own
    // lifecycle, so it shares this effect's cleanup. (A separate effect leaked
    // the marker onto a StrictMode-discarded map and never re-attached.)
    const el = document.createElement('div');
    el.style.cssText =
      'width:20px;height:20px;border-radius:50%;background:#ef4444;border:3px solid white;box-shadow:0 0 0 2px #ef4444,0 2px 8px rgba(0,0,0,.5);cursor:grab';
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([tour.lng, tour.lat])
      .addTo(map);
    marker.on('drag', () => {
      const ll = marker.getLngLat();
      setUserPos([ll.lat, ll.lng]);
    });
    userMarkerRef.current = marker;

    return () => {
      marker.remove();
      userMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [tour]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push zone updates when they load after the map. The 'idle' handler reads
  // zonesRef, so keep it current; setData directly if the source is already up.
  useEffect(() => {
    zonesRef.current = zones;
    const map = mapRef.current;
    if (map?.getSource('zones')) {
      (map.getSource('zones') as maplibregl.GeoJSONSource).setData(zonesToGeoJSON(zones));
    }
  }, [zones]);

  const switchStyle = (key: string) => {
    setStyleKey(key);
    setRenderer(VECTOR_STYLES[key] ? 'vector' : 'raster');
    // transformStyle merges our zone source + layers INTO the incoming style, so
    // the switch never wipes them — no fragile re-add-after-load timing (which
    // breaks here anyway because the hung sprite keeps isStyleLoaded() false).
    mapRef.current?.setStyle(styleFor(key), {
      transformStyle: (_prev, next) => ({
        ...next,
        sources: { ...next.sources, zones: { type: 'geojson', data: zonesToGeoJSON(zonesRef.current) } },
        layers: [...next.layers, ...ZONE_LAYERS],
      }),
    });
  };

  const tilt = () => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ pitch: map.getPitch() > 10 ? 0 : 60, duration: 600 });
  };

  return (
    <div className="relative h-dvh w-full bg-zinc-950">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Controls */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <div className="flex flex-wrap gap-1 bg-zinc-900/90 backdrop-blur rounded-lg p-1 border border-white/10">
          {['dark', 'light', 'voyager', 'satellite', 'streets'].map(k => (
            <button
              key={k}
              onClick={() => switchStyle(k)}
              className={`px-2.5 py-1 rounded text-xs font-semibold ${
                styleKey === k ? 'bg-emerald-500 text-white' : 'text-zinc-300 hover:bg-white/10'
              }`}
            >
              {MAP_STYLES[k]?.label || k}
            </button>
          ))}
        </div>
        <button
          onClick={tilt}
          className="self-start px-2.5 py-1 rounded text-xs font-semibold bg-zinc-900/90 backdrop-blur text-zinc-200 border border-white/10 hover:bg-white/10"
        >
          Toggle 3D tilt
        </button>
      </div>

      {/* HUD */}
      <div className="absolute bottom-3 left-3 z-10 bg-zinc-900/90 backdrop-blur rounded-lg px-3 py-2 border border-white/10 text-xs text-zinc-300 font-mono">
        <div>{tour ? tour.title : 'loading…'} · {zones.length} zones</div>
        <div className="mt-0.5">
          <span className={renderer === 'vector' ? 'text-emerald-400' : 'text-amber-400'}>
            {renderer.toUpperCase()}
          </span>
          {' · '}zoom {hud.zoom} · pitch {hud.pitch}° · bearing {hud.bearing}°
        </div>
        {userPos && (
          <div className="mt-0.5 text-zinc-400">dot {userPos[0].toFixed(5)}, {userPos[1].toFixed(5)}</div>
        )}
        <div className="mt-0.5 text-zinc-500">drag red dot · right-drag to rotate/tilt</div>
      </div>
    </div>
  );
};
