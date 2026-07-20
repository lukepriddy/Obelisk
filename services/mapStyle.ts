// ── Shared MapLibre plumbing ─────────────────────────────────────────────────
// One home for how every map surface (player, welcome preview, editor, generate
// modal) builds its base style, detects the sharpest available satellite zoom,
// draws metre-radius zone circles, and initialises a map configured for
// two-finger rotate with tilt disabled.

import maplibregl from 'maplibre-gl';
import circle from '@turf/circle';
import { MAP_STYLES, DEFAULT_MAP_STYLE } from '../constants';

export { DEFAULT_MAP_STYLE };

// CARTO's free, keyless vector GL styles — the vector twins of the raster
// dark/light/voyager tiles. Vector gives smooth zoom, crisp labels and rotation
// with no Mapbox account or billing.
const VECTOR_STYLES: Record<string, string> = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
};

// Raster keys backed by satellite imagery — these get per-location max-native-
// zoom detection so each spot renders as sharp as its imagery allows.
const SATELLITE_KEYS = new Set(['satellite', 'satellite-hd']);

export function isVectorStyle(key: string): boolean {
  return key in VECTOR_STYLES;
}

// Leaflet-style templates use {s} (subdomain) and {r} (retina) tokens MapLibre
// doesn't understand. Expand {s} into explicit subdomains and drop {r}.
function rasterTiles(url: string): string[] {
  const base = url.replace('{r}', '');
  return base.includes('{s}')
    ? ['a', 'b', 'c'].map(s => base.replace('{s}', s))
    : [base];
}

export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latR = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
  return [x, y];
}

// Probe how deep THIS location's imagery actually goes. Real tiles are sizeable
// JPEGs; Esri's "Map data not yet available" placeholder is ~2.5KB. Walk up from
// the floor until a placeholder (or failed fetch) appears, then cap there — so
// every experience gets its sharpest imagery with no gray tiles, no billing.
export async function detectMaxNativeZoom(
  urlTemplate: string,
  lng: number,
  lat: number,
  floor = 17,
  ceil = 21,
): Promise<number> {
  let best = floor;
  for (let z = floor; z <= ceil; z++) {
    const [x, y] = lngLatToTile(lng, lat, z);
    const url = urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) break;
      const b = await r.blob();
      if (b.size > 5000) best = z; else break;
    } catch {
      break;
    }
  }
  return best;
}

function rasterStyle(key: string, maxzoom: number): maplibregl.StyleSpecification {
  const s = MAP_STYLES[key] || MAP_STYLES[DEFAULT_MAP_STYLE];
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: rasterTiles(s.url), tileSize: 256, maxzoom, attribution: s.attribution },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// Resolve a style key to something MapLibre's `style` / setStyle accepts.
// Vector → a CARTO GL style URL. Raster → an inline style spec capped at the
// given native zoom (default 19; pass a detected value for satellite).
export function styleFor(key: string, maxzoom = 19): string | maplibregl.StyleSpecification {
  return VECTOR_STYLES[key] ?? rasterStyle(key, maxzoom);
}

export function isSatelliteKey(key: string): boolean {
  return SATELLITE_KEYS.has(key);
}

// Resolve the raster tile-URL template for a key (used for zoom detection).
export function rasterUrlTemplate(key: string): string {
  return (MAP_STYLES[key] || MAP_STYLES[DEFAULT_MAP_STYLE]).url;
}

// ── Zone geometry ────────────────────────────────────────────────────────────
// MapLibre has no metre-radius circle primitive, so turn each zone into a 64-gon
// GeoJSON polygon. Callers attach their own display props (color/opacity/etc.).
export function circleFeature(
  lng: number,
  lat: number,
  radiusMeters: number,
  properties: Record<string, unknown>,
): GeoJSON.Feature {
  const f = circle([lng, lat], Math.max(radiusMeters, 1) / 1000, { steps: 64, units: 'kilometers' });
  f.properties = properties;
  return f;
}

// ── Map creation ─────────────────────────────────────────────────────────────
export interface CreateMapOptions {
  container: HTMLElement;
  center: [number, number]; // [lng, lat]
  zoom: number;
  styleKey?: string;
  maxzoom?: number;         // raster native-zoom cap
  maxZoom?: number;         // interaction max
  interactive?: boolean;
  attribution?: boolean;
}

// Initialise a MapLibre map with the product's interaction policy: two-finger
// rotate ON (like Google/Apple nav), tilt/pitch OFF (deemed not useful here).
export function createMap(opts: CreateMapOptions): maplibregl.Map {
  const key = opts.styleKey || DEFAULT_MAP_STYLE;
  const map = new maplibregl.Map({
    container: opts.container,
    style: styleFor(key, opts.maxzoom ?? 19),
    center: opts.center,
    zoom: opts.zoom,
    maxZoom: opts.maxZoom ?? 22,
    pitch: 0,
    bearing: 0,
    pitchWithRotate: false,             // rotating must never tilt
    interactive: opts.interactive ?? true,
    attributionControl: opts.attribution === false ? false : { compact: true },
  });
  // No 3D tilt gesture; keep pinch-zoom and two-finger rotate.
  map.touchPitch.disable();
  if (opts.interactive !== false) map.scrollZoom.enable();
  return map;
}
