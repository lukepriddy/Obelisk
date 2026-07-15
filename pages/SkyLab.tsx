/**
 * SkyLab — throwaway AR prototype. NOT wired into the player.
 *
 * Purpose: prove one thing — that an object anchored to a real coordinate,
 * hanging at an altitude above it, can be made to sit convincingly in the sky
 * through the camera as you walk toward, under, and past it.
 *
 * The "passes overhead" effect is NOT animated. The object never moves; the
 * player does. Elevation = atan(altitude / horizontal distance), so at 200m
 * out it hugs the horizon, at 30m it's high, and standing on the anchor it's
 * at 90° — directly overhead. Walk past and it sinks behind you. All of the
 * drama is real geometry.
 *
 * Deliberately simple: a flat grey disc positioned with CSS, no 3D engine, no
 * assets. A circle is rotation-invariant, so device roll can be ignored too.
 * This isolates the one genuinely risky unknown: compass accuracy.
 */
import React, { useEffect, useRef, useState } from 'react';
import { getDistance } from '../utils/geo';

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Initial great-circle bearing from point A to point B, degrees from north. */
const bearingTo = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

/** Wrap an angle difference into -180..180 so we can ask "how far off-axis". */
const norm180 = (deg: number) => {
  let d = ((deg + 180) % 360) - 180;
  if (d < -180) d += 360;
  return d;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Rough rear-camera field of view in portrait. Only affects how far off-centre
// the object drifts, not whether it points the right way — tune by eye.
const HFOV = 60;
const VFOV = 100;

// The object's notional physical size, used for apparent-size falloff.
const OBJECT_SIZE_M = 25;
// Fully opaque within NEAR_M, faded out by FAR_M — "receding" cue.
const NEAR_M = 50;
const FAR_M = 350;

const STORAGE_KEY = 'obelisk_skylab_anchor';

interface Anchor { lat: number; lng: number; alt: number }

export const SkyLab: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pos, setPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [beta, setBeta] = useState<number | null>(null);

  const [anchor, setAnchor] = useState<Anchor | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Anchor) : null;
    } catch { return null; }
  });
  const [altitude, setAltitude] = useState(anchor?.alt ?? 60);

  // ── Start: camera + orientation permission must happen in a user gesture ──
  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (e) {
      setError('Camera access failed. Allow camera for this site and reload.');
      return;
    }

    // iOS 13+ gates motion/orientation behind an explicit permission call.
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE?.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') {
          setError('Motion & Orientation access denied — the compass drives everything here.');
          return;
        }
      } catch {
        setError('Could not request motion access.');
        return;
      }
    }

    const onOrient = (e: DeviceOrientationEvent) => {
      const withWebkit = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      if (typeof withWebkit.webkitCompassHeading === 'number') {
        // iOS: already true-north referenced and clockwise.
        setHeading(withWebkit.webkitCompassHeading);
      } else if (e.absolute && typeof e.alpha === 'number') {
        // Android absolute: alpha counts counter-clockwise from north.
        setHeading((360 - e.alpha) % 360);
      }
      if (typeof e.beta === 'number') setBeta(e.beta);
    };
    window.addEventListener('deviceorientationabsolute', onOrient as EventListener);
    window.addEventListener('deviceorientation', onOrient as EventListener);

    navigator.geolocation.watchPosition(
      p => setPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      err => setError(`GPS error (${err.code}): ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    );
    // Coarse companion request — same Chrome anti-hang trick as the player.
    navigator.geolocation.getCurrentPosition(
      p => setPos(cur => cur ?? { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => {},
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 8000 },
    );

    try { await (navigator as any).wakeLock?.request('screen'); } catch { /* non-fatal */ }
    setRunning(true);
  };

  useEffect(() => {
    if (!anchor) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...anchor, alt: altitude })); } catch {}
  }, [anchor, altitude]);

  const dropAnchorHere = () => {
    if (!pos) return;
    setAnchor({ lat: pos.lat, lng: pos.lng, alt: altitude });
  };

  // ── The whole trick, in ~8 lines ──────────────────────────────────────────
  let view: {
    x: number; y: number; size: number; opacity: number;
    dist: number; bearing: number; elevation: number; dBearing: number; onScreen: boolean;
  } | null = null;

  if (pos && anchor && heading !== null && beta !== null) {
    const dist = getDistance(pos.lat, pos.lng, anchor.lat, anchor.lng);
    const objBearing = bearingTo(pos.lat, pos.lng, anchor.lat, anchor.lng);
    // Rises as you close in; 90° (straight up) when you're standing on it.
    const elevation = toDeg(Math.atan2(altitude, Math.max(dist, 0.5)));
    // Portrait: beta 90 = upright (looking at horizon), beta 0 = flat (zenith).
    const camElevation = 90 - beta;

    const dBearing = norm180(objBearing - heading);
    const dElev = elevation - camElevation;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = w / 2 + (dBearing / (HFOV / 2)) * (w / 2);
    const y = h / 2 - (dElev / (VFOV / 2)) * (h / 2);

    const slant = Math.sqrt(dist * dist + altitude * altitude);
    const angular = toDeg(2 * Math.atan(OBJECT_SIZE_M / (2 * Math.max(slant, 1))));
    const size = (angular / VFOV) * h;
    const opacity = clamp01((FAR_M - dist) / (FAR_M - NEAR_M));

    view = {
      x, y, size, opacity, dist, bearing: objBearing, elevation, dBearing,
      onScreen: Math.abs(dBearing) < HFOV && Math.abs(dElev) < VFOV,
    };
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black overflow-hidden">
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* The object — a plain disc. Rotation-invariant, so roll can be ignored. */}
      {running && view && view.onScreen && view.opacity > 0.01 && (
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            left: view.x,
            top: view.y,
            width: view.size,
            height: view.size,
            transform: 'translate(-50%, -50%)',
            opacity: view.opacity,
            background: 'radial-gradient(circle at 38% 34%, #6b7280 0%, #374151 45%, #1f2937 100%)',
            boxShadow: '0 0 40px rgba(0,0,0,0.55)',
          }}
        />
      )}

      {!running && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center bg-zinc-950">
          <h1 className="text-white text-xl font-bold">Sky Lab</h1>
          <p className="text-zinc-400 text-sm leading-relaxed max-w-xs">
            Drop an anchor, walk 150m away, turn around and walk back. The object should
            rise as you approach and pass directly overhead.
          </p>
          <button
            onClick={start}
            className="mt-2 px-6 py-3 rounded-xl bg-emerald-600 text-white font-semibold"
          >
            Start camera
          </button>
          {error && <p className="text-red-400 text-xs max-w-xs">{error}</p>}
        </div>
      )}

      {running && (
        <>
          {/* Debug HUD — this is the actual product of the experiment. */}
          <div className="absolute left-3 right-3 top-3 rounded-xl bg-black/70 backdrop-blur px-3 py-2 text-[11px] text-emerald-200 font-mono leading-relaxed">
            <div className="grid grid-cols-2 gap-x-3">
              <span>heading</span><span className="text-right">{heading?.toFixed(0) ?? '—'}°</span>
              <span>cam elev</span><span className="text-right">{beta !== null ? (90 - beta).toFixed(0) : '—'}°</span>
              <span>gps acc</span><span className="text-right">{pos ? `${pos.acc.toFixed(0)}m` : '—'}</span>
              {view ? (
                <>
                  <span>distance</span><span className="text-right">{view.dist.toFixed(0)}m</span>
                  <span>obj bearing</span><span className="text-right">{view.bearing.toFixed(0)}°</span>
                  <span>obj elev</span><span className="text-right">{view.elevation.toFixed(0)}°</span>
                  <span>turn</span>
                  <span className="text-right">
                    {Math.abs(view.dBearing) < 8
                      ? 'on target'
                      : `${view.dBearing > 0 ? 'right' : 'left'} ${Math.abs(view.dBearing).toFixed(0)}°`}
                  </span>
                </>
              ) : (
                <><span className="col-span-2 text-amber-300">waiting for gps / anchor…</span></>
              )}
            </div>
          </div>

          <div className="absolute left-3 right-3 bottom-3 flex flex-col gap-2">
            <div className="rounded-xl bg-black/70 backdrop-blur px-3 py-2">
              <label className="flex items-center justify-between text-[11px] text-zinc-300 font-mono">
                <span>altitude</span><span>{altitude}m</span>
              </label>
              <input
                type="range" min="10" max="200" step="5"
                value={altitude}
                onChange={e => setAltitude(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
            <button
              onClick={dropAnchorHere}
              disabled={!pos}
              className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold text-sm disabled:opacity-40"
            >
              {anchor ? 'Re-drop anchor here' : 'Drop anchor here'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
