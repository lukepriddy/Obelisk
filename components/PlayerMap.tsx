import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Tour, Zone, PlayerProgress } from '../types';
import { canMeetProgressionRequirements } from '../services/progressionService';
import {
  styleFor, circleFeature, createMap, isSatelliteKey, rasterUrlTemplate,
  detectMaxNativeZoom, DEFAULT_MAP_STYLE,
} from '../services/mapStyle';

interface PlayerMapProps {
  tour: Tour;
  zones: Zone[];
  activeZoneIds: Set<string>;
  visitedZoneIds: Set<string>;
  playerProgress: PlayerProgress | null;
  userPos: [number, number] | null;
  gpsAccuracy: number | null;
  styleKey: string;
  simulationMode: boolean;
  followUser: boolean;
  onDragAway: () => void;
  onSimMove: (pos: [number, number]) => void;
}

const ACTIVE = '#3b82f6';

// GeoJSON overlay sources+layers we own on top of any base style. Kept in one
// place so they can be re-injected via setStyle's transformStyle after a base-
// style swap wipes custom sources/layers.
const OVERLAY_LAYERS: maplibregl.LayerSpecification[] = [
  { id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.08 } },
  { id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#ef4444', 'line-width': 1, 'line-dasharray': [4, 4] } },
  { id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] } },
  { id: 'zone-line', type: 'line', source: 'zones', filter: ['!=', ['get', 'dashed'], true], paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'weight'] } },
  { id: 'zone-line-dashed', type: 'line', source: 'zones', filter: ['==', ['get', 'dashed'], true], paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'weight'], 'line-dasharray': [3, 2] } },
];

const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const PlayerMap: React.FC<PlayerMapProps> = (props) => {
  const {
    tour, zones, activeZoneIds, visitedZoneIds, playerProgress,
    userPos, gpsAccuracy, styleKey, simulationMode, followUser,
    onDragAway, onSimMove,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const discMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const rasterZoomCache = useRef<Record<string, number>>({});

  // Latest values for use inside imperative map callbacks / transformStyle.
  const zonesDataRef = useRef<GeoJSON.FeatureCollection>(emptyFC);
  const accuracyDataRef = useRef<GeoJSON.FeatureCollection>(emptyFC);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Build the coloured zone-circle FeatureCollection from current props.
  const buildZonesData = (): GeoJSON.FeatureCollection => {
    const features: GeoJSON.Feature[] = [];
    for (const zone of zones) {
      if (!zone.is_visible) continue;
      if (zone.requires_zone_id && !visitedZoneIds.has(zone.requires_zone_id)) continue;
      if (tour.progression_enabled && playerProgress && !canMeetProgressionRequirements(zone, playerProgress)) continue;
      const isDisc = zone.type === 'discoverable';
      if (isDisc && playerProgress?.granted_zone_ids.includes(zone.id)) continue;

      const isActive = activeZoneIds.has(zone.id);
      const isChar = zone.type === 'character';
      const isLocked = zone.lock_type === 'passphrase';
      const color = isActive ? ACTIVE : isLocked ? '#f59e0b' : isChar ? '#8b5cf6' : isDisc ? '#ec4899' : '#10b981';
      features.push(circleFeature(zone.lng, zone.lat, zone.radius, {
        color, fillOpacity: isActive ? 0.35 : 0.18, weight: isActive ? 3 : 2, dashed: isLocked && !isActive,
      }));
    }
    return { type: 'FeatureCollection', features };
  };

  const buildAccuracyData = (): GeoJSON.FeatureCollection => {
    if (!userPos || !gpsAccuracy || gpsAccuracy <= 0) return emptyFC;
    return { type: 'FeatureCollection', features: [circleFeature(userPos[1], userPos[0], Math.min(gpsAccuracy, 120), {})] };
  };

  const attachOverlays = (map: maplibregl.Map) => {
    if (!map.getSource('zones')) map.addSource('zones', { type: 'geojson', data: zonesDataRef.current });
    if (!map.getSource('accuracy')) map.addSource('accuracy', { type: 'geojson', data: accuracyDataRef.current });
    OVERLAY_LAYERS.forEach(l => { if (!map.getLayer(l.id)) map.addLayer(l); });
  };

  // ── Init map (once) ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    zonesDataRef.current = buildZonesData();
    accuracyDataRef.current = buildAccuracyData();

    const map = createMap({
      container: containerRef.current,
      center: [tour.lng, tour.lat],
      zoom: tour.start_zoom ?? 18,
      styleKey: styleKey || DEFAULT_MAP_STYLE,
      maxzoom: 19,
    });
    mapRef.current = map;

    const onStyle = () => { try { attachOverlays(map); } catch { /* mid-swap */ } };
    map.on('styledata', onStyle);
    map.on('dragstart', () => { if (!propsRef.current.simulationMode) propsRef.current.onDragAway(); });

    // User marker (red dot); draggable in sim mode drives the fake position.
    const el = document.createElement('div');
    el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#ef4444;border:3px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3)';
    if (!userPos) el.style.display = 'none';
    const marker = new maplibregl.Marker({ element: el, draggable: simulationMode })
      .setLngLat([userPos ? userPos[1] : tour.lng, userPos ? userPos[0] : tour.lat])
      .addTo(map);
    marker.on('drag', () => {
      const ll = marker.getLngLat();
      propsRef.current.onSimMove([ll.lat, ll.lng]);
    });
    userMarkerRef.current = marker;

    // Kick off satellite max-native-zoom detection, then sharpen if deeper.
    if (isSatelliteKey(styleKey)) {
      detectMaxNativeZoom(rasterUrlTemplate(styleKey), tour.lng, tour.lat).then(mz => {
        rasterZoomCache.current[styleKey] = mz;
        if (mz > 19 && mapRef.current && propsRef.current.styleKey === styleKey) {
          mapRef.current.setStyle(styleFor(styleKey, mz), { transformStyle: mergeOverlays });
        }
      });
    }

    return () => {
      discMarkersRef.current.forEach(m => m.remove());
      discMarkersRef.current.clear();
      marker.remove();
      userMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // transformStyle callback: merge our overlay sources+layers into an incoming
  // base style so a style swap never wipes them (survives the sprite-load hang).
  const mergeOverlays: NonNullable<Parameters<maplibregl.Map['setStyle']>[1]>['transformStyle'] = (_prev, next) => ({
    ...next,
    sources: {
      ...next.sources,
      zones: { type: 'geojson', data: zonesDataRef.current },
      accuracy: { type: 'geojson', data: accuracyDataRef.current },
    },
    layers: [...next.layers, ...OVERLAY_LAYERS],
  });

  // ── Style switches ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    (async () => {
      let maxzoom = 19;
      if (isSatelliteKey(styleKey)) {
        if (rasterZoomCache.current[styleKey] == null) {
          rasterZoomCache.current[styleKey] = await detectMaxNativeZoom(rasterUrlTemplate(styleKey), tour.lng, tour.lat);
        }
        maxzoom = rasterZoomCache.current[styleKey];
      }
      if (cancelled || !mapRef.current) return;
      mapRef.current.setStyle(styleFor(styleKey, maxzoom), { transformStyle: mergeOverlays });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  // ── Zone data updates (colours change every geofence tick) ──
  useEffect(() => {
    zonesDataRef.current = buildZonesData();
    const src = mapRef.current?.getSource('zones') as maplibregl.GeoJSONSource | undefined;
    src?.setData(zonesDataRef.current);

    // Reconcile discoverable icon markers.
    const map = mapRef.current;
    if (!map) return;
    const wanted = new Map<string, Zone>();
    for (const zone of zones) {
      if (zone.type !== 'discoverable' || !zone.is_visible) continue;
      if (zone.requires_zone_id && !visitedZoneIds.has(zone.requires_zone_id)) continue;
      if (tour.progression_enabled && playerProgress && !canMeetProgressionRequirements(zone, playerProgress)) continue;
      if (playerProgress?.granted_zone_ids.includes(zone.id)) continue;
      wanted.set(zone.id, zone);
    }
    // remove stale
    for (const [id, m] of discMarkersRef.current) {
      if (!wanted.has(id)) { m.remove(); discMarkersRef.current.delete(id); }
    }
    // add new
    for (const [id, zone] of wanted) {
      if (discMarkersRef.current.has(id)) continue;
      const el = document.createElement('div');
      el.innerHTML = zone.is_mystery || !zone.zone_image_url
        ? `<div style="width:22px;height:22px;border-radius:50%;background:#ec4899;border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:800">?</div>`
        : `<div style="width:26px;height:26px;border-radius:50%;background-image:url('${zone.zone_image_url}');background-size:cover;background-position:center;border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5)"></div>`;
      const m = new maplibregl.Marker({ element: el }).setLngLat([zone.lng, zone.lat]).addTo(map);
      discMarkersRef.current.set(id, m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, activeZoneIds, visitedZoneIds, playerProgress]);

  // ── User position, accuracy, follow ──
  useEffect(() => {
    const map = mapRef.current;
    const marker = userMarkerRef.current;
    if (!map || !marker) return;

    marker.getElement().style.display = userPos ? '' : 'none';
    if (userPos) marker.setLngLat([userPos[1], userPos[0]]);
    accuracyDataRef.current = buildAccuracyData();
    (map.getSource('accuracy') as maplibregl.GeoJSONSource | undefined)?.setData(accuracyDataRef.current);

    // Only animate when the player has actually moved somewhere.
    //
    // GPS delivers a fix about once a second and the reported position jitters
    // by a metre or two even standing still, so an unconditional easeTo meant a
    // 500ms camera animation running roughly half the time the phone was out —
    // continuous WebGL repaint, and one of the larger heat sources on a walk.
    //
    // Below the threshold the camera is simply left alone; the user marker has
    // already been moved above, so the dot still tracks the jitter and only the
    // map stops chasing it. The threshold is in degrees of latitude: 1e-5 is
    // about 1.1m, comfortably inside GPS noise and far below anything a walker
    // would notice as the map failing to follow.
    if (!simulationMode && followUser && userPos) {
      const centre = map.getCenter();
      const movedFar =
        Math.abs(centre.lat - userPos[0]) > 1e-5 ||
        Math.abs(centre.lng - userPos[1]) > 1e-5;
      if (movedFar) map.easeTo({ center: [userPos[1], userPos[0]], duration: 500 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPos, gpsAccuracy, followUser, simulationMode]);

  // ── Sim-mode toggles marker draggability ──
  useEffect(() => {
    const marker = userMarkerRef.current;
    if (!marker) return;
    if (simulationMode) marker.setDraggable(true); else marker.setDraggable(false);
  }, [simulationMode]);

  return <div ref={containerRef} className="absolute inset-0" style={{ touchAction: 'none' }} />;
};
