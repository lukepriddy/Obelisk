import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Tour, Zone } from '../types';
import {
  createMap, styleFor, circleFeature, isSatelliteKey, rasterUrlTemplate,
  detectMaxNativeZoom, DEFAULT_MAP_STYLE,
} from '../services/mapStyle';

type Tool = 'select' | 'draw' | 'place-start';

export interface EditorMapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  getZoom: () => number;
}

interface EditorMapProps {
  tour: Tour;
  zones: Zone[];
  styleKey: string;
  activeTool: Tool;
  selectedZoneId: string | null;
  showSatelliteLabels: boolean;
  zoomRef: React.MutableRefObject<number>;
  onMapClick: (lat: number, lng: number) => void;
  onZoneClick: (id: string) => void;
  onZoneDragEnd: (id: string, lat: number, lng: number) => void;
  onStartDragEnd: (lat: number, lng: number) => void;
}

const LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

// Editor colour language (mirrors the player): selected→blue, locked→yellow,
// character→purple, discoverable→pink, audio→green.
function zoneColor(type: string, locked: boolean, selected: boolean): string {
  return selected ? '#3b82f6' : locked ? '#f59e0b' : type === 'character' ? '#8b5cf6' : type === 'discoverable' ? '#ec4899' : '#10b981';
}

const ZONE_LAYERS: maplibregl.LayerSpecification[] = [
  { id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] } },
  { id: 'zone-line', type: 'line', source: 'zones', filter: ['!=', ['get', 'dashed'], true], paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'weight'] } },
  { id: 'zone-line-dashed', type: 'line', source: 'zones', filter: ['==', ['get', 'dashed'], true], paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'weight'], 'line-dasharray': [2, 3] } },
];

const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const EditorMap = forwardRef<EditorMapHandle, EditorMapProps>((props, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const zoneMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const startMarkerRef = useRef<maplibregl.Marker | null>(null);
  const rasterZoomCache = useRef<Record<string, number>>({});
  const zonesDataRef = useRef<GeoJSON.FeatureCollection>(emptyFC);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, zoom) => mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? 15, duration: 1200 }),
    getZoom: () => mapRef.current?.getZoom() ?? 0,
  }), []);

  const buildZonesData = (): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: props.zones.map(z => {
      const isSelected = props.selectedZoneId === z.id;
      const isLocked = z.lock_type === 'passphrase';
      const color = zoneColor(z.type, isLocked, isSelected);
      return circleFeature(z.lng, z.lat, z.radius, {
        id: z.id, color, fillOpacity: isSelected ? 0.3 : 0.18, weight: isSelected ? 3 : 2, dashed: !z.is_visible,
      });
    }),
  });

  const attachOverlays = (map: maplibregl.Map) => {
    // Satellite reference labels below the zones, above imagery.
    if (propsRef.current.showSatelliteLabels) {
      if (!map.getSource('sat-labels')) map.addSource('sat-labels', { type: 'raster', tiles: [LABELS_URL], tileSize: 256, maxzoom: 19 });
      if (!map.getLayer('sat-labels')) map.addLayer({ id: 'sat-labels', type: 'raster', source: 'sat-labels' });
    }
    if (!map.getSource('zones')) map.addSource('zones', { type: 'geojson', data: zonesDataRef.current });
    ZONE_LAYERS.forEach(l => { if (!map.getLayer(l.id)) map.addLayer(l); });
  };

  const mergeOverlays: NonNullable<Parameters<maplibregl.Map['setStyle']>[1]>['transformStyle'] = (_prev, next) => {
    const sources = { ...next.sources, zones: { type: 'geojson', data: zonesDataRef.current } as maplibregl.SourceSpecification };
    const layers = [...next.layers];
    if (propsRef.current.showSatelliteLabels) {
      sources['sat-labels'] = { type: 'raster', tiles: [LABELS_URL], tileSize: 256, maxzoom: 19 };
      layers.push({ id: 'sat-labels', type: 'raster', source: 'sat-labels' });
    }
    layers.push(...ZONE_LAYERS);
    return { ...next, sources, layers };
  };

  // ── Init ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const { tour } = props;
    zonesDataRef.current = buildZonesData();
    const hasStart = tour.lat !== 0 || tour.lng !== 0;
    const map = createMap({
      container: containerRef.current,
      center: hasStart ? [tour.lng, tour.lat] : [-73.9857, 40.7484],
      zoom: tour.start_zoom ?? 15,
      styleKey: props.styleKey || DEFAULT_MAP_STYLE,
      maxzoom: 19,
    });
    mapRef.current = map;

    map.on('styledata', () => { try { attachOverlays(map); } catch { /* mid-swap */ } });
    map.on('zoomend', () => { propsRef.current.zoomRef.current = map.getZoom(); });

    // Click: place (draw/place-start) or select an existing zone.
    map.on('click', (e) => {
      const tool = propsRef.current.activeTool;
      if (tool === 'draw' || tool === 'place-start') {
        propsRef.current.onMapClick(e.lngLat.lat, e.lngLat.lng);
        return;
      }
      const feats = map.getLayer('zone-fill') ? map.queryRenderedFeatures(e.point, { layers: ['zone-fill'] }) : [];
      const id = feats[0]?.properties?.id;
      if (id) propsRef.current.onZoneClick(String(id));
    });

    if (isSatelliteKey(props.styleKey)) {
      detectMaxNativeZoom(rasterUrlTemplate(props.styleKey), tour.lng || -73.9857, tour.lat || 40.7484).then(mz => {
        rasterZoomCache.current[props.styleKey] = mz;
        if (mz > 19 && mapRef.current && propsRef.current.styleKey === props.styleKey) {
          mapRef.current.setStyle(styleFor(props.styleKey, mz), { transformStyle: mergeOverlays });
        }
      });
    }

    return () => {
      zoneMarkersRef.current.forEach(m => m.remove());
      zoneMarkersRef.current.clear();
      startMarkerRef.current?.remove();
      startMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Style switches ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    (async () => {
      let maxzoom = 19;
      if (isSatelliteKey(props.styleKey)) {
        if (rasterZoomCache.current[props.styleKey] == null) {
          rasterZoomCache.current[props.styleKey] = await detectMaxNativeZoom(rasterUrlTemplate(props.styleKey), props.tour.lng || -73.9857, props.tour.lat || 40.7484);
        }
        maxzoom = rasterZoomCache.current[props.styleKey];
      }
      if (cancelled || !mapRef.current) return;
      mapRef.current.setStyle(styleFor(props.styleKey, maxzoom), { transformStyle: mergeOverlays });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.styleKey, props.showSatelliteLabels]);

  // ── Zones (circles + draggable centre dots) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    zonesDataRef.current = buildZonesData();
    (map.getSource('zones') as maplibregl.GeoJSONSource | undefined)?.setData(zonesDataRef.current);

    const wanted = new Set(props.zones.map(z => z.id));
    for (const [id, m] of zoneMarkersRef.current) {
      if (!wanted.has(id)) { m.remove(); zoneMarkersRef.current.delete(id); }
    }
    for (const zone of props.zones) {
      const isSelected = props.selectedZoneId === zone.id;
      const isLocked = zone.lock_type === 'passphrase';
      const color = zoneColor(zone.type, isLocked, isSelected);
      const d = isSelected ? 16 : 13;
      let marker = zoneMarkersRef.current.get(zone.id);
      if (!marker) {
        const el = document.createElement('div');
        marker = new maplibregl.Marker({ element: el, draggable: props.activeTool === 'select' });
        marker.setLngLat([zone.lng, zone.lat]).addTo(map);
        el.addEventListener('click', (ev) => { ev.stopPropagation(); propsRef.current.onZoneClick(zone.id); });
        marker.on('dragend', () => {
          if (propsRef.current.activeTool !== 'select') return;
          const ll = marker!.getLngLat();
          propsRef.current.onZoneDragEnd(zone.id, ll.lat, ll.lng);
        });
        zoneMarkersRef.current.set(zone.id, marker);
      }
      marker.setLngLat([zone.lng, zone.lat]);
      marker.setDraggable(props.activeTool === 'select');
      const el = marker.getElement();
      el.style.cssText = `width:${d}px;height:${d}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5);opacity:${props.activeTool === 'draw' ? 0.5 : 1};cursor:${props.activeTool === 'select' ? 'grab' : 'pointer'}`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.zones, props.selectedZoneId, props.activeTool]);

  // ── Start pin ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { tour } = props;
    const hasStart = tour.lat !== 0 || tour.lng !== 0;
    if (!hasStart) { startMarkerRef.current?.remove(); startMarkerRef.current = null; return; }
    if (!startMarkerRef.current) {
      const el = document.createElement('div');
      el.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="background:#10b981;width:22px;height:22px;border-radius:50%;border:3px solid white;box-shadow:0 0 0 2px #10b981,0 2px 8px rgba(16,185,129,0.5)"></div>
        <div style="background:#10b981;color:white;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;letter-spacing:0.05em">START</div>
      </div>`;
      const marker = new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -11], draggable: true });
      marker.setLngLat([tour.lng, tour.lat]).addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        propsRef.current.onStartDragEnd(ll.lat, ll.lng);
      });
      startMarkerRef.current = marker;
    } else {
      startMarkerRef.current.setLngLat([tour.lng, tour.lat]);
    }
  }, [props.tour.lat, props.tour.lng]);

  // ── Cursor by tool ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = props.activeTool === 'select' ? 'grab' : 'crosshair';
  }, [props.activeTool]);

  return <div ref={containerRef} className="absolute inset-0" style={{ background: '#09090b' }} />;
});

EditorMap.displayName = 'EditorMap';
