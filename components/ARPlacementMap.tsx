import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  createMap, circleFeature, isSatelliteKey, rasterUrlTemplate, detectMaxNativeZoom,
  DEFAULT_MAP_STYLE,
} from '../services/mapStyle';
import { bearingTo, destinationPoint, offsetFrom } from '../utils/geo';

/**
 * Where an AR object stands, placed on the real map.
 *
 * This replaced a radial pad that mapped distance linearly onto a 120px radius
 * and capped at 60m. Two problems: the cap was arbitrary, and no dial can span
 * the range creators actually want. At a rim of one mile, a 2ft placement sits
 * a third of a pixel from the centre.
 *
 * A map has no such limit, because zoom does the scaling. It also shows what is
 * *between* the player and the object, which is what decides whether a distant
 * placement reads as a thing in the world or a sticker on the screen: nothing in
 * the AR stack occludes, so a giant behind a treeline draws straight over it.
 *
 * Position is stored as distance + bearing from the zone, never as absolute
 * coordinates, so moving the zone later carries the object with it.
 */

const OBJECT_COLOR = '#38bdf8';
const ZONE_COLOR = '#f59e0b';
// Screen-space length of the rotation arm. Converted to metres against the
// current zoom each render so the handle stays the same size on screen whether
// the object is 2ft or half a mile out.
const HANDLE_PX = 46;

const toFeet = (m: number) => m * 3.28084;
const fromFeet = (ft: number) => ft / 3.28084;

/** Feet under a quarter mile, miles beyond it. Never metric: creator-facing. */
export const formatGroundDistance = (meters: number): string => {
  const feet = toFeet(meters);
  if (feet < 1000) return `${Math.round(feet)} ft`;
  return `${(feet / 5280).toFixed(feet / 5280 < 10 ? 2 : 1)} mi`;
};

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinal = (deg: number) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const norm = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * Metres covered by one CSS pixel at this latitude and zoom.
 *
 * The constant is 78271.5, not the 156543 you see in most tile-maths snippets.
 * That figure assumes 256px tiles; MapLibre uses 512px ones, so the world is
 * 512 * 2^zoom pixels wide and every metres-per-pixel result is half as large.
 * Using the 256px constant makes anything sized through it come out at double.
 */
const metersPerPixel = (lat: number, zoom: number) =>
  (78271.516964 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

interface Props {
  zoneLat: number;
  zoneLng: number;
  zoneRadius: number;
  distance: number;   // metres from the zone centre
  bearing: number;    // degrees clockwise from north
  facing: number;     // the object's own rotation
  altitude: number;   // metres
  styleKey?: string;
  onChange: (patch: {
    ground_distance_m?: number;
    ground_bearing_degrees?: number;
    facing_degrees?: number;
  }) => void;
}

export const ARPlacementMap: React.FC<Props> = ({
  zoneLat, zoneLng, zoneRadius, distance, bearing, facing, altitude, styleKey, onChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const objectMarkerRef = useRef<maplibregl.Marker | null>(null);
  const handleMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [zoom, setZoom] = useState(18);
  // Which marker is under the finger, so the re-render can leave that one alone
  // and still update the other. Tracking this as a boolean was a bug: the
  // handle was repositioned to its fixed arm length on every frame of its own
  // drag, fighting the finger, which showed up as the arm flickering long and
  // short. It only needs to snap back when the drag ends.
  const draggingRef = useRef<'object' | 'handle' | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const objectPoint = destinationPoint(zoneLat, zoneLng, bearing, distance);

  // ── Init once ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const key = styleKey || DEFAULT_MAP_STYLE;
    const map = createMap({
      container: containerRef.current,
      center: [zoneLng, zoneLat],
      zoom: 18,
      styleKey: key,
      attribution: false,
    });
    mapRef.current = map;

    // The map initialises before the surrounding form has settled its width, so
    // the WebGL canvas gets sized to whatever the container was at that instant
    // and never catches up: visible as bars either side, and worse than
    // cosmetic, because MapLibre projects through the canvas, so an undersized
    // one throws off every screen-space measurement taken from the map,
    // including the rotation arm's length.
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(containerRef.current);

    // Pinch works, but a fallback matters on a small embedded map where a
    // two-finger gesture is easy to start on the wrong element. Compass hidden:
    // rotation is already a two-finger gesture and the arrow tracks it.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('zoom', () => setZoom(map.getZoom()));
    // Rotating the map changes the arrow's screen angle without changing any
    // prop, so nothing would re-render it. Bump zoom state to force the update.
    map.on('rotate', () => setZoom(map.getZoom()));

    map.on('load', () => {
      map.addSource('zone', { type: 'geojson', data: circleFeature(zoneLng, zoneLat, zoneRadius, {}) });
      map.addLayer({
        id: 'zone-fill', type: 'fill', source: 'zone',
        paint: { 'fill-color': ZONE_COLOR, 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'zone-line', type: 'line', source: 'zone',
        paint: { 'line-color': ZONE_COLOR, 'line-width': 1.5, 'line-opacity': 0.7 },
      });
      // Sight line from where players arrive to what they are looking at.
      map.addSource('sight', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      });
      map.addLayer({
        id: 'sight-line', type: 'line', source: 'sight',
        paint: { 'line-color': OBJECT_COLOR, 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
      });

      if (isSatelliteKey(key)) {
        detectMaxNativeZoom(rasterUrlTemplate(key), zoneLng, zoneLat).catch(() => {});
      }
    });

    // Zone centre: fixed, this is where players actually arrive.
    const centreEl = document.createElement('div');
    centreEl.innerHTML =
      `<div style="width:14px;height:14px;border-radius:50%;background:${ZONE_COLOR};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.6)"></div>`;
    new maplibregl.Marker({ element: centreEl }).setLngLat([zoneLng, zoneLat]).addTo(map);

    // The object. Draggable: this sets distance and bearing together.
    //
    // Built once here rather than re-rendered on each update. Rewriting
    // innerHTML every frame would replace the very element the finger is
    // dragging, and only the arrow's angle actually changes: the update below
    // just sets a transform attribute.
    const objectEl = document.createElement('div');
    objectEl.style.cursor = 'grab';
    objectEl.innerHTML =
      `<svg width="40" height="40" viewBox="0 0 40 40" style="display:block;overflow:visible">
         <circle cx="20" cy="20" r="11" fill="${OBJECT_COLOR}" stroke="white" stroke-width="2"/>
         <g data-arrow transform="rotate(0 20 20)">
           <polygon points="20,2 25.5,11.5 14.5,11.5" fill="white" stroke="${OBJECT_COLOR}" stroke-width="1"/>
         </g>
       </svg>`;
    const objectMarker = new maplibregl.Marker({ element: objectEl, draggable: true })
      .setLngLat([objectPoint.lng, objectPoint.lat])
      .addTo(map);
    objectMarkerRef.current = objectMarker;

    objectMarker.on('dragstart', () => { draggingRef.current = 'object'; });
    objectMarker.on('drag', () => {
      const { lat, lng } = objectMarker.getLngLat();
      // offsetFrom, not getDistance: it inverts destinationPoint exactly, so
      // the marker reads back to the point it was dropped on rather than
      // creeping by the flat-vs-spherical difference.
      const offset = offsetFrom(zoneLat, zoneLng, lat, lng);
      onChangeRef.current({
        ground_distance_m: offset.meters,
        ground_bearing_degrees: Math.round(offset.bearingDegrees),
      });
    });
    objectMarker.on('dragend', () => { draggingRef.current = null; });

    // Rotation arm. A second draggable marker rather than a custom pointer
    // handler inside the first: MapLibre already solves dragging correctly at
    // every zoom, and two markers cannot fight each other for the same gesture.
    const handleEl = document.createElement('div');
    handleEl.style.cursor = 'grab';
    handleEl.innerHTML =
      `<div style="width:16px;height:16px;border-radius:50%;background:white;border:2px solid ${OBJECT_COLOR};box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>`;
    const handleMarker = new maplibregl.Marker({ element: handleEl, draggable: true })
      .setLngLat([objectPoint.lng, objectPoint.lat])
      .addTo(map);
    handleMarkerRef.current = handleMarker;

    handleMarker.on('dragstart', () => { draggingRef.current = 'handle'; });
    handleMarker.on('drag', () => {
      const object = objectMarker.getLngLat();
      const handle = handleMarker.getLngLat();
      // Only the angle is read. The distance the finger happens to be at is
      // ignored, and the arm springs back to its fixed length on release.
      onChangeRef.current({
        facing_degrees: Math.round(bearingTo(object.lat, object.lng, handle.lat, handle.lng)),
      });
    });
    handleMarker.on('dragend', () => {
      draggingRef.current = null;
      // Snap back explicitly. Waiting for the next render would not do it: the
      // final drag frame may not change facing at all, and then nothing
      // re-renders and the arm stays wherever the finger left it.
      const object = objectMarker.getLngLat();
      const handle = handleMarker.getLngLat();
      const angle = bearingTo(object.lat, object.lng, handle.lat, handle.lng);
      const arm = HANDLE_PX * metersPerPixel(object.lat, map.getZoom());
      const snapped = destinationPoint(object.lat, object.lng, angle, arm);
      handleMarker.setLngLat([snapped.lng, snapped.lat]);
    });

    return () => { resize.disconnect(); map.remove(); mapRef.current = null; };
    // Init-only: later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Zone geometry ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource('zone') as maplibregl.GeoJSONSource | undefined;
    source?.setData(circleFeature(zoneLng, zoneLat, zoneRadius, {}) as GeoJSON.Feature);
  }, [zoneLat, zoneLng, zoneRadius]);

  // ── Object, rotation arm and sight line follow the config ──────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (draggingRef.current !== 'object') {
      objectMarkerRef.current?.setLngLat([objectPoint.lng, objectPoint.lat]);
    }

    // Arm length in metres for a constant on-screen size. Left alone while the
    // handle itself is being dragged, so the arm follows the finger instead of
    // being snatched back to this length every frame.
    if (draggingRef.current !== 'handle') {
      const armMeters = HANDLE_PX * metersPerPixel(objectPoint.lat, zoom);
      const armEnd = destinationPoint(objectPoint.lat, objectPoint.lng, facing, armMeters);
      handleMarkerRef.current?.setLngLat([armEnd.lng, armEnd.lat]);
    }

    // Point the arrow where the object faces. Counter-rotated by the map's own
    // bearing so it keeps indicating real-world north when the creator rotates
    // the map. Only the transform changes; the SVG itself was built at init.
    const arrow = objectMarkerRef.current?.getElement().querySelector('[data-arrow]');
    arrow?.setAttribute('transform', `rotate(${facing - map.getBearing()} 20 20)`);

    const sight = map.getSource('sight') as maplibregl.GeoJSONSource | undefined;
    sight?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[zoneLng, zoneLat], [objectPoint.lng, objectPoint.lat]] },
    } as GeoJSON.Feature);
  }, [objectPoint.lat, objectPoint.lng, facing, zoom, zoneLat, zoneLng]);

  /** Frame the zone and the object together. Never automatic: it would yank the
   *  view mid-drag. The creator asks for it. */
  const fitBoth = () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = new maplibregl.LngLatBounds([zoneLng, zoneLat], [zoneLng, zoneLat]);
    bounds.extend([objectPoint.lng, objectPoint.lat]);
    // Include the whole zone circle, not just its centre.
    for (const b of [0, 90, 180, 270]) {
      const edge = destinationPoint(zoneLat, zoneLng, b, zoneRadius);
      bounds.extend([edge.lng, edge.lat]);
    }
    map.fitBounds(bounds, { padding: 56, maxZoom: 20, duration: 400 });
  };

  // ── Readout ────────────────────────────────────────────────────────────────
  const lookUp = distance < 0.5
    ? 90
    : Math.round((Math.atan2(altitude, distance) * 180) / Math.PI);

  // Graded rather than a single threshold. The old pad said nothing until 80
  // degrees, but tracking starts struggling around 45: that is roughly where a
  // phone's frame fills with sky, and sky gives the tracker nothing to hold.
  const angleNote =
    lookUp >= 75 ? { tone: 'text-red-400', text: 'Players look almost straight up. This is the least stable placement there is, and the object will drift and wobble as they walk toward it.' }
    : lookUp >= 60 ? { tone: 'text-amber-400', text: 'A steep view. Expect visible wobble as players get close, since the camera sees mostly sky.' }
    : lookUp >= 45 ? { tone: 'text-amber-400', text: 'Getting steep. Tracking holds better when some ground stays in the frame.' }
    : lookUp >= 30 ? { tone: 'text-zinc-400', text: 'A comfortable angle. Ground stays in shot, which is what keeps tracking locked.' }
    : { tone: 'text-zinc-500', text: 'A shallow angle, with ground and horizon in shot. This is the steadiest kind of placement.' };

  // No occlusion anywhere in the AR stack, so at range the sight line is the
  // whole game. Stated once distance makes it matter, and never as a limit.
  const showSightlineNote = toFeet(distance) >= 500;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-bold text-zinc-400 uppercase">Placement</label>
        <button
          type="button"
          onClick={fitBoth}
          className="text-[10px] font-bold text-sky-400 hover:text-sky-300"
        >
          Fit to view
        </button>
      </div>

      <div ref={containerRef} className="w-full h-64 rounded-xl overflow-hidden bg-zinc-800" />

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[10px] font-bold text-zinc-500 uppercase mb-1">Distance (ft)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={Math.round(toFeet(distance))}
            onChange={e => {
              const feet = Number(e.target.value);
              if (Number.isFinite(feet) && feet >= 0) {
                onChange({ ground_distance_m: fromFeet(feet) });
              }
            }}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-bold text-zinc-500 uppercase mb-1">Direction (°)</span>
          <input
            type="number"
            min={0}
            max={359}
            step={1}
            value={Math.round(norm(bearing))}
            onChange={e => {
              const deg = Number(e.target.value);
              if (Number.isFinite(deg)) onChange({ ground_bearing_degrees: norm(deg) });
            }}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-100"
          />
        </label>
      </div>

      <div className="mt-2 text-center">
        <p className="text-sm font-semibold text-zinc-100">
          {distance < 0.5
            ? 'At the centre of the zone'
            : `${formatGroundDistance(distance)} to the ${cardinal(bearing)}`}
        </p>
        <p className="text-xs text-zinc-400">
          Facing {cardinal(facing)} ({Math.round(norm(facing))}°)
        </p>
        <p className="text-xs mt-1 text-zinc-300">
          Players look up ≈ <span className="font-bold">{lookUp}°</span>
        </p>
        <p className={`text-[11px] mt-1 ${angleNote.tone}`}>{angleNote.text}</p>
        {showSightlineNote && (
          <p className="text-[11px] text-zinc-500 mt-1">
            At this range the sight line decides everything. Nothing hides the
            object, so anything between the player and it, buildings, trees, a
            ridge, will be drawn straight through. Open ground, water or a long
            street is where a distant object looks real.
          </p>
        )}
      </div>
    </div>
  );
};
