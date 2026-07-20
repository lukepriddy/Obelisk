import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  createMap, styleFor, isSatelliteKey, rasterUrlTemplate, detectMaxNativeZoom, DEFAULT_MAP_STYLE,
} from '../services/mapStyle';

export interface WelcomePreviewHandle {
  zoomIn: () => void;
  zoomOut: () => void;
}

interface WelcomePreviewMapProps {
  lat: number;
  lng: number;
  zoom: number;
  styleKey: string;
  interactive: boolean;
}

const START_MARKER_HTML =
  `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
    <div style="background:#10b981;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 0 2px #10b981,0 2px 8px rgba(16,185,129,0.5)"></div>
    <div style="background:#10b981;color:white;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;letter-spacing:0.05em">START</div>
  </div>`;

// Small non-interactive start-location preview on the welcome screen. Becomes
// pan/zoom-interactive when the player taps "explore"; exposes zoom in/out so the
// welcome overlay's own buttons can drive it.
export const WelcomePreviewMap = forwardRef<WelcomePreviewHandle, WelcomePreviewMapProps>(
  ({ lat, lng, zoom, styleKey, interactive }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    useImperativeHandle(ref, () => ({
      zoomIn: () => mapRef.current?.zoomIn(),
      zoomOut: () => mapRef.current?.zoomOut(),
    }), []);

    // Init once.
    useEffect(() => {
      if (!containerRef.current || mapRef.current) return;
      const key = styleKey || DEFAULT_MAP_STYLE;
      const map = createMap({
        container: containerRef.current,
        center: [lng, lat],
        zoom,
        styleKey: key,
        maxzoom: 19,
        attribution: false,
      });
      mapRef.current = map;

      const el = document.createElement('div');
      el.innerHTML = START_MARKER_HTML;
      new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -9] })
        .setLngLat([lng, lat])
        .addTo(map);

      if (isSatelliteKey(key)) {
        detectMaxNativeZoom(rasterUrlTemplate(key), lng, lat).then(mz => {
          if (mz > 19 && mapRef.current) mapRef.current.setStyle(styleFor(key, mz));
        });
      }

      return () => { map.remove(); mapRef.current = null; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Toggle interactivity (drag + pinch/scroll zoom). Rotate stays available so
    // the gesture set matches the main map; tilt is already disabled by createMap.
    useEffect(() => {
      const map = mapRef.current;
      if (!map) return;
      const handlers = [map.dragPan, map.scrollZoom, map.doubleClickZoom, map.touchZoomRotate, map.keyboard];
      handlers.forEach(h => (interactive ? h.enable() : h.disable()));
      map.getCanvas().style.cursor = interactive ? '' : 'default';
    }, [interactive]);

    return <div ref={containerRef} className="absolute inset-0" />;
  },
);

WelcomePreviewMap.displayName = 'WelcomePreviewMap';
