import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  createMap, styleFor, circleFeature, isSatelliteKey, rasterUrlTemplate,
  detectMaxNativeZoom, DEFAULT_MAP_STYLE,
} from '../services/mapStyle';

type LatLng = [number, number];

const pinHTML = (label: string, color: string, size = 28) =>
  `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:3px solid white;box-shadow:0 2px 10px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;cursor:grab"><span style="color:white;font-size:11px;font-weight:900;line-height:1">${label}</span></div>`;

const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// Detect + apply the sharpest satellite zoom once, shared by both maps.
function useSatelliteSharpen(mapRef: React.MutableRefObject<maplibregl.Map | null>, key: string, lng: number, lat: number) {
  useEffect(() => {
    if (!isSatelliteKey(key)) return;
    let cancelled = false;
    detectMaxNativeZoom(rasterUrlTemplate(key), lng, lat).then(mz => {
      if (!cancelled && mz > 19 && mapRef.current) mapRef.current.setStyle(styleFor(key, mz));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ── Interactive location picker ──────────────────────────────────────────────
export interface PickerHandle {
  getCenter: () => LatLng | null;
  flyTo: (lat: number, lng: number, zoom?: number) => void;
}

interface PickerProps {
  startPin: LatLng | null;
  endPin: LatLng | null;
  radiusMeters: number;
  styleKey?: string;
  onStartMove: (p: LatLng) => void;
  onEndMove: (p: LatLng) => void;
}

export const GeneratePickerMap = forwardRef<PickerHandle, PickerProps>((props, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const startRef = useRef<maplibregl.Marker | null>(null);
  const endRef = useRef<maplibregl.Marker | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const key = props.styleKey || DEFAULT_MAP_STYLE;
  const center: LatLng = props.startPin ?? [40.748, -73.986];

  useImperativeHandle(ref, () => ({
    getCenter: () => {
      const c = mapRef.current?.getCenter();
      return c ? [c.lat, c.lng] : null;
    },
    flyTo: (lat, lng, zoom) => mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? 16, duration: 1100 }),
  }), []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = createMap({
      container: containerRef.current,
      center: [center[1], center[0]],
      zoom: props.startPin ? 16 : 3,
      styleKey: key,
      maxzoom: 19,
    });
    mapRef.current = map;
    map.on('styledata', () => {
      if (!map.getSource('radius')) map.addSource('radius', { type: 'geojson', data: emptyFC });
      if (!map.getLayer('radius-fill')) map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#10b981', 'fill-opacity': 0.07 } });
      if (!map.getLayer('radius-line')) map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#10b981', 'line-width': 1.5, 'line-dasharray': [6, 4] } });
      syncRadius();
    });
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSatelliteSharpen(mapRef, key, center[1], center[0]);

  const syncRadius = () => {
    const { startPin, radiusMeters } = propsRef.current;
    const data = startPin ? { type: 'FeatureCollection', features: [circleFeature(startPin[1], startPin[0], radiusMeters, {})] } as GeoJSON.FeatureCollection : emptyFC;
    (mapRef.current?.getSource('radius') as maplibregl.GeoJSONSource | undefined)?.setData(data);
  };

  // Start pin (+ radius).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (props.startPin) {
      if (!startRef.current) {
        const el = document.createElement('div');
        el.innerHTML = pinHTML('S', '#10b981');
        const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([props.startPin[1], props.startPin[0]]).addTo(map);
        m.on('dragend', () => { const ll = m.getLngLat(); propsRef.current.onStartMove([ll.lat, ll.lng]); });
        startRef.current = m;
      } else {
        startRef.current.setLngLat([props.startPin[1], props.startPin[0]]);
      }
    } else if (startRef.current) {
      startRef.current.remove(); startRef.current = null;
    }
    syncRadius();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.startPin, props.radiusMeters]);

  // End pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (props.endPin) {
      if (!endRef.current) {
        const el = document.createElement('div');
        el.innerHTML = pinHTML('E', '#6366f1');
        const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([props.endPin[1], props.endPin[0]]).addTo(map);
        m.on('dragend', () => { const ll = m.getLngLat(); propsRef.current.onEndMove([ll.lat, ll.lng]); });
        endRef.current = m;
      } else {
        endRef.current.setLngLat([props.endPin[1], props.endPin[0]]);
      }
    } else if (endRef.current) {
      endRef.current.remove(); endRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.endPin]);

  return <div ref={containerRef} className="absolute inset-0" />;
});
GeneratePickerMap.displayName = 'GeneratePickerMap';

// ── Static draft preview ─────────────────────────────────────────────────────
export interface PreviewZone { order: number; lat: number; lng: number; radius: number; type: 'audio' | 'character' | 'discoverable'; locked: boolean }

interface PreviewProps {
  zones: PreviewZone[];
  startPin: LatLng | null;
  endPin: LatLng | null;
  styleKey?: string;
}

export const GeneratePreviewMap: React.FC<PreviewProps> = ({ zones, startPin, endPin, styleKey }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const key = styleKey || DEFAULT_MAP_STYLE;
  const center: LatLng = zones[0] ? [zones[0].lat, zones[0].lng] : [40.748, -73.986];

  const zonesFC = (): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: zones.map(z => circleFeature(z.lng, z.lat, z.radius, {
      color: z.locked ? '#f59e0b' : z.type === 'character' ? '#6366f1' : z.type === 'discoverable' ? '#a78bfa' : '#10b981',
    })),
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = createMap({
      container: containerRef.current,
      center: [center[1], center[0]],
      zoom: 15,
      styleKey: key,
      maxzoom: 19,
      interactive: false,
      attribution: false,
    });
    mapRef.current = map;
    map.on('styledata', () => {
      if (!map.getSource('zones')) map.addSource('zones', { type: 'geojson', data: zonesFC() });
      if (!map.getLayer('zones-fill')) map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
      if (!map.getLayer('zones-line')) map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': ['get', 'color'], 'line-width': 1 } });
    });
    return () => { markersRef.current.forEach(m => m.remove()); markersRef.current = []; map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSatelliteSharpen(mapRef, key, center[1], center[0]);

  // Rebuild markers + circles when the draft changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    (map.getSource('zones') as maplibregl.GeoJSONSource | undefined)?.setData(zonesFC());
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    const add = (lng: number, lat: number, html: string) => {
      const el = document.createElement('div'); el.innerHTML = html;
      markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map));
    };
    if (startPin) add(startPin[1], startPin[0], pinHTML('S', '#10b981'));
    if (endPin) add(endPin[1], endPin[0], pinHTML('E', '#6366f1'));
    zones.forEach(z => add(z.lng, z.lat, pinHTML(String(z.order), z.locked ? '#f59e0b' : z.type === 'character' ? '#6366f1' : z.type === 'discoverable' ? '#a78bfa' : '#10b981', 26)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, startPin, endPin]);

  return <div ref={containerRef} className="absolute inset-0" />;
};
