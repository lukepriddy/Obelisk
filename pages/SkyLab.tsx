/**
 * SkyLab — throwaway AR prototype. NOT wired into the player.
 *
 * v2. The first pass mapped bearing→x and elevation→y linearly, which is only
 * valid near the horizon: azimuth compresses by cos(elevation), so near the
 * zenith — exactly where "passes overhead" lives — it threw the object wildly
 * off. This version does a real projection: build the object's direction as a
 * world vector, rotate it into device space with the W3C orientation matrix,
 * then perspective-project. That behaves correctly at every elevation
 * including straight up.
 *
 * Two modes, so failures are diagnosable in isolation:
 *   • celestial — object pinned to a fixed bearing/elevation, no GPS involved.
 *     Validates the projection + compass alone.
 *   • anchor    — pinned to a real coordinate at an altitude. Adds GPS.
 * If celestial is solid and anchor is not, the fault is GPS/bearing, not math.
 *
 * Rendering runs on rAF against refs; React state is only touched ~8x/sec for
 * the HUD. (v1 called setState on every orientation event — 60 re-renders/sec.)
 */
import React, { useEffect, useRef, useState } from 'react';
import { getDistance } from '../utils/geo';

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const bearingTo = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

/**
 * Device→Earth rotation matrix from the W3C DeviceOrientation Euler angles
 * (intrinsic Z-X'-Y''). Earth frame is X=East, Y=North, Z=Up. Device frame is
 * X=screen right, Y=screen top, Z=out of the screen toward the viewer — so the
 * REAR camera looks along -Z.
 */
const deviceToEarth = (alphaDeg: number, betaDeg: number, gammaDeg: number) => {
  const x = toRad(betaDeg);
  const y = toRad(gammaDeg);
  const z = toRad(alphaDeg);
  const cX = Math.cos(x), sX = Math.sin(x);
  const cY = Math.cos(y), sY = Math.sin(y);
  const cZ = Math.cos(z), sZ = Math.sin(z);

  return [
    cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY,
    cY * sZ + cZ * sX * sY,  cZ * cX, sZ * sY - cZ * cY * sX,
    -cX * sY,                sX,      cX * cY,
  ];
};

/** Earth→Device: transpose of the above, applied to a world vector. */
const earthToDevice = (m: number[], v: number[]) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/** Unit vector toward bearing/elevation in the Earth frame. */
const skyVector = (bearingDeg: number, elevDeg: number) => {
  const b = toRad(bearingDeg);
  const e = toRad(elevDeg);
  return [Math.cos(e) * Math.sin(b), Math.cos(e) * Math.cos(b), Math.sin(e)];
};

// Rough rear-camera FOV in portrait; only affects spread, not direction.
const HFOV = 63;
const VFOV = 95;

const OBJECT_SIZE_M = 25;
const MAX_ANGULAR_DEG = 45; // stop the disc swallowing the screen up close
const NEAR_M = 50;
const FAR_M = 350;

const STORAGE_KEY = 'obelisk_skylab_anchor_v2';

interface Anchor { lat: number; lng: number }
type Mode = 'celestial' | 'anchor';

export const SkyLab: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const objRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('celestial');
  const [altitude, setAltitude] = useState(60);
  const [testBearing, setTestBearing] = useState(0);
  const [testElev, setTestElev] = useState(45);

  // Hot data lives in refs — rAF reads it, React never re-renders for it.
  const orient = useRef({
    alpha: 0, beta: 0, gamma: 0,
    heading: null as number | null, source: '—', count: 0,
    // Circular EMA accumulators for the NORTH OFFSET (sin/cos so the 359°→0°
    // seam doesn't spike). Not for alpha — alpha must stay raw and consistent
    // with beta/gamma or the gimbal compensation breaks.
    aSin: 0, aCos: 1, primed: false,
    offset: 0, offsetLocked: false, wellConditioned: false,
    // Raw heading samples over the last second — the jitter measurement.
    samples: [] as { t: number; deg: number }[],
    jitter: 0,
  });
  const [smoothing, setSmoothing] = useState(true);
  const smoothingRef = useRef(true);
  useEffect(() => { smoothingRef.current = smoothing; }, [smoothing]);
  const posRef = useRef<{ lat: number; lng: number; acc: number } | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const lastBearing = useRef<number | null>(null);
  const smoothPos = useRef<{ x: number; y: number } | null>(null);
  const modeRef = useRef(mode);
  const altRef = useRef(altitude);
  const testRef = useRef({ b: testBearing, e: testElev });

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { altRef.current = altitude; }, [altitude]);
  useEffect(() => { testRef.current = { b: testBearing, e: testElev }; }, [testBearing, testElev]);

  const [hud, setHud] = useState({
    heading: '—', source: '—', evts: 0, acc: '—',
    dist: '—', objB: '—', objE: '—', state: 'waiting',
    jitter: 0, offset: '—', cond: false,
  });

  const [anchor, setAnchor] = useState<Anchor | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const a = raw ? (JSON.parse(raw) as Anchor) : null;
      anchorRef.current = a;
      return a;
    } catch { return null; }
  });

  const start = async () => {
    setError(null);
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    const motionPromise: Promise<string> =
      typeof DOE?.requestPermission === 'function'
        ? DOE.requestPermission().catch((e: any) => `threw: ${e?.name || ''} ${e?.message || e}`)
        : Promise.resolve('granted');
    const cameraPromise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    const motion = await motionPromise;
    if (motion !== 'granted') {
      cameraPromise.then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
      setError(
        motion.startsWith('threw:')
          ? `Motion request rejected (${motion.slice(7).trim()}). iPhone: Settings → Apps → Safari → Advanced → Motion & Orientation Access must be ON.`
          : 'Motion & Orientation denied — the compass drives everything here.',
      );
      return;
    }

    try {
      const stream = await cameraPromise;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setError('Camera access failed. Allow camera for this site and reload.');
      return;
    }

    const onOrient = (e: DeviceOrientationEvent) => {
      const w = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      const o = orient.current;
      o.count += 1;

      // Store the device's OWN triple, unmodified and unsmoothed. These three
      // are only meaningful together: near beta=+/-90 (phone upright, camera at
      // the horizon) the ZXY decomposition is singular and alpha/gamma swing
      // hard against each other while describing the same real orientation.
      // Substituting alpha from the compass — or smoothing the angles
      // individually — breaks that compensation and the object goes wild.
      // v3 did both. Hence: stable looking up (beta~0), chaotic at the horizon.
      if (typeof e.alpha === 'number') o.alpha = e.alpha;
      if (typeof e.beta === 'number') o.beta = e.beta;
      if (typeof e.gamma === 'number') o.gamma = e.gamma;

      if (typeof w.webkitCompassHeading === 'number') {
        o.heading = w.webkitCompassHeading;
        o.source = 'webkit';
      } else if (typeof e.alpha === 'number') {
        o.heading = (360 - e.alpha) % 360;
        o.source = e.absolute ? 'absolute' : 'relative(!)';
      }

      if (o.heading !== null) {
        // Jitter = angular spread of RAW heading over the last second.
        const now = performance.now();
        o.samples.push({ t: now, deg: o.heading });
        while (o.samples.length && now - o.samples[0].t > 1000) o.samples.shift();
        if (o.samples.length > 2) {
          let sx = 0, sy = 0;
          for (const s of o.samples) { sx += Math.cos(toRad(s.deg)); sy += Math.sin(toRad(s.deg)); }
          const meanDeg = (toDeg(Math.atan2(sy, sx)) + 360) % 360;
          let maxDev = 0;
          for (const s of o.samples) {
            let d = Math.abs(s.deg - meanDeg) % 360;
            if (d > 180) d = 360 - d;
            if (d > maxDev) maxDev = d;
          }
          o.jitter = maxDev;
        }
      }
    };
    window.addEventListener('deviceorientationabsolute', onOrient as EventListener);
    window.addEventListener('deviceorientation', onOrient as EventListener);

    navigator.geolocation.watchPosition(
      p => { posRef.current = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; },
      err => setError(`GPS error (${err.code}): ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    );
    navigator.geolocation.getCurrentPosition(
      p => { posRef.current ??= { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; },
      () => {},
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 8000 },
    );

    try { await (navigator as any).wakeLock?.request('screen'); } catch { /* non-fatal */ }
    setRunning(true);
  };

  // ── Render loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let hudAt = 0;

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const o = orient.current;
      const el = objRef.current;
      if (!el) return;

      let bearing: number | null = null;
      let elevation: number | null = null;
      let dist = 0;
      let state = 'ok';

      if (modeRef.current === 'celestial') {
        // No GPS, no parallax — pure projection + compass test.
        bearing = testRef.current.b;
        elevation = testRef.current.e;
        dist = 1000;
      } else {
        const p = posRef.current;
        const a = anchorRef.current;
        if (!p || !a) {
          state = !a ? 'no anchor' : 'no gps';
        } else {
          dist = getDistance(p.lat, p.lng, a.lat, a.lng);
          // Inside GPS noise the bearing is meaningless and spins. Freeze the
          // last good one; the object is nearly overhead there anyway.
          const noiseFloor = Math.max(5, p.acc);
          if (dist > noiseFloor) {
            bearing = bearingTo(p.lat, p.lng, a.lat, a.lng);
            lastBearing.current = bearing;
          } else {
            bearing = lastBearing.current ?? 0;
            state = 'overhead (bearing held)';
          }
          elevation = Math.min(89.5, toDeg(Math.atan2(altRef.current, Math.max(dist, 0.5))));
        }
      }

      if (bearing === null || elevation === null) {
        el.style.display = 'none';
      } else {
        const m = deviceToEarth(o.alpha, o.beta, o.gamma);

        // ── True-north alignment, kept OUT of the matrix ────────────────────
        // The matrix maps device -> an earth frame whose azimuth origin is
        // arbitrary (iOS alpha isn't north-referenced). Rather than corrupt the
        // triple by injecting the compass into alpha, estimate the constant
        // azimuth offset between that frame and true north, and rotate the
        // OBJECT's bearing by it instead.
        //
        // Offset is only observable when the device's +Y (top) axis has a solid
        // horizontal projection. That's degenerate exactly when the phone is
        // upright (top at the zenith) — the same pose as gimbal lock — so we
        // only refresh the estimate when well-conditioned and hold it otherwise.
        // Conveniently, "tilted back looking at the sky" is well-conditioned.
        const yEast = m[1];
        const yNorth = m[4];
        const horiz = Math.hypot(yEast, yNorth);
        if (o.heading !== null && horiz > 0.35) {
          const azInFrame = (toDeg(Math.atan2(yEast, yNorth)) + 360) % 360;
          const measured = toRad(((o.heading - azInFrame) % 360 + 360) % 360);
          const k = smoothingRef.current ? 0.05 : 1; // offset is ~constant: smooth hard
          if (!o.primed) {
            o.aSin = Math.sin(measured); o.aCos = Math.cos(measured); o.primed = true;
          } else {
            o.aSin += (Math.sin(measured) - o.aSin) * k;
            o.aCos += (Math.cos(measured) - o.aCos) * k;
          }
          o.offsetLocked = true;
        }
        const northOffset = o.primed ? (toDeg(Math.atan2(o.aSin, o.aCos)) + 360) % 360 : 0;
        o.offset = northOffset;
        o.wellConditioned = horiz > 0.35;

        const bearingInFrame = ((bearing - northOffset) % 360 + 360) % 360;
        const v = earthToDevice(m, skyVector(bearingInFrame, elevation));
        // Rear camera looks along -Z in device space.
        const depth = -v[2];
        if (depth <= 0.02) {
          el.style.display = 'none';
          state = 'behind you';
        } else {
          const w = window.innerWidth;
          const h = window.innerHeight;
          const x = w / 2 + (v[0] / depth) * ((w / 2) / Math.tan(toRad(HFOV / 2)));
          const y = h / 2 - (v[1] / depth) * ((h / 2) / Math.tan(toRad(VFOV / 2)));

          const slant = modeRef.current === 'celestial'
            ? 1000
            : Math.sqrt(dist * dist + altRef.current * altRef.current);
          const angular = Math.min(
            MAX_ANGULAR_DEG,
            toDeg(2 * Math.atan(OBJECT_SIZE_M / (2 * Math.max(slant, 1)))),
          );
          const size = (angular / VFOV) * h;
          const opacity = modeRef.current === 'celestial'
            ? 1
            : clamp01((FAR_M - dist) / (FAR_M - NEAR_M));

          if (opacity < 0.01) {
            el.style.display = 'none';
            smoothPos.current = null;
          } else {
            // Smooth the PROJECTED POSITION, not the Euler angles. This is
            // downstream of the matrix so it can't desync the triple, and it
            // takes the edge off residual magnetometer noise. Snap rather than
            // glide on big jumps so it doesn't visibly slide across the screen.
            let px = x, py = y;
            if (smoothingRef.current) {
              const prev = smoothPos.current;
              if (prev && Math.hypot(x - prev.x, y - prev.y) < window.innerWidth * 0.4) {
                px = prev.x + (x - prev.x) * 0.18;
                py = prev.y + (y - prev.y) * 0.18;
              }
              smoothPos.current = { x: px, y: py };
            }
            el.style.display = 'block';
            el.style.width = `${size}px`;
            el.style.height = `${size}px`;
            el.style.opacity = `${opacity}`;
            el.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%)`;
          }
        }
      }

      if (t - hudAt > 125) {
        hudAt = t;
        const p = posRef.current;
        setHud({
          heading: o.heading === null ? '—' : `${o.heading.toFixed(0)}°`,
          source: o.source,
          evts: o.count,
          acc: p ? `${p.acc.toFixed(0)}m` : '—',
          dist: modeRef.current === 'celestial' ? 'n/a' : (posRef.current && anchorRef.current ? `${dist.toFixed(0)}m` : '—'),
          objB: bearing === null ? '—' : `${bearing.toFixed(0)}°`,
          objE: elevation === null ? '—' : `${elevation.toFixed(0)}°`,
          state,
          jitter: o.jitter,
          offset: o.primed ? `${o.offset.toFixed(0)}°` : 'not set',
          cond: o.wellConditioned,
        });
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const dropAnchorHere = () => {
    const p = posRef.current;
    if (!p) return;
    const a = { lat: p.lat, lng: p.lng };
    anchorRef.current = a;
    lastBearing.current = null;
    setAnchor(a);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); } catch {}
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black overflow-hidden">
      <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />

      <div
        ref={objRef}
        className="absolute top-0 left-0 rounded-full pointer-events-none will-change-transform"
        style={{
          display: 'none',
          background: 'radial-gradient(circle at 38% 34%, #6b7280 0%, #374151 45%, #1f2937 100%)',
          boxShadow: '0 0 40px rgba(0,0,0,0.55)',
        }}
      />

      {!running && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center bg-zinc-950">
          <h1 className="text-white text-xl font-bold">Sky Lab v2</h1>
          <p className="text-zinc-400 text-sm leading-relaxed max-w-xs">
            Starts in <strong className="text-zinc-200">celestial</strong> mode: an object fixed due
            north at 45°. No GPS involved — it only proves the compass and projection.
          </p>
          <button onClick={start} className="mt-2 px-6 py-3 rounded-xl bg-emerald-600 text-white font-semibold">
            Start camera
          </button>
          {error && <p className="text-red-400 text-xs max-w-xs leading-relaxed">{error}</p>}
        </div>
      )}

      {running && (
        <>
          <div className="absolute left-3 right-3 top-3 rounded-xl bg-black/70 backdrop-blur px-3 py-2 text-[11px] text-emerald-200 font-mono leading-relaxed">
            <div className="grid grid-cols-2 gap-x-3">
              <span>heading</span>
              <span className="text-right">{hud.heading} <span className="text-emerald-400/60">{hud.source}</span></span>
              <span>orient evts</span>
              <span className={`text-right ${hud.evts === 0 ? 'text-red-400' : ''}`}>{hud.evts}</span>
              <span>compass jitter</span>
              <span className={`text-right font-bold ${
                hud.jitter > 15 ? 'text-red-400' : hud.jitter > 6 ? 'text-amber-300' : 'text-emerald-300'
              }`}>
                ±{hud.jitter.toFixed(0)}° {hud.jitter > 15 ? 'BAD' : hud.jitter > 6 ? 'meh' : 'good'}
              </span>
              <span>north offset</span>
              <span className={`text-right ${hud.cond ? 'text-emerald-300' : 'text-zinc-500'}`}>
                {hud.offset} {hud.cond ? 'live' : 'held'}
              </span>
              <span>gps acc</span><span className="text-right">{hud.acc}</span>
              <span>distance</span><span className="text-right">{hud.dist}</span>
              <span>obj bearing</span><span className="text-right">{hud.objB}</span>
              <span>obj elev</span><span className="text-right">{hud.objE}</span>
              <span>state</span><span className="text-right text-amber-300">{hud.state}</span>
            </div>
          </div>

          <div className="absolute left-3 right-3 bottom-3 flex flex-col gap-2">
            <div className="flex gap-2">
              {(['celestial', 'anchor'] as Mode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold ${
                    mode === m ? 'bg-emerald-600 text-white' : 'bg-black/70 text-zinc-300'
                  }`}
                >
                  {m}
                </button>
              ))}
              <button
                onClick={() => setSmoothing(s => !s)}
                className={`px-3 py-2 rounded-xl text-xs font-bold ${
                  smoothing ? 'bg-sky-600 text-white' : 'bg-black/70 text-zinc-400'
                }`}
              >
                smooth {smoothing ? 'on' : 'off'}
              </button>
            </div>

            {mode === 'celestial' ? (
              <div className="rounded-xl bg-black/70 backdrop-blur px-3 py-2 space-y-1">
                <label className="flex items-center justify-between text-[11px] text-zinc-300 font-mono">
                  <span>test bearing</span><span>{testBearing}°</span>
                </label>
                <input type="range" min="0" max="359" value={testBearing}
                  onChange={e => setTestBearing(Number(e.target.value))}
                  className="w-full accent-emerald-500" />
                <label className="flex items-center justify-between text-[11px] text-zinc-300 font-mono">
                  <span>test elevation</span><span>{testElev}°</span>
                </label>
                <input type="range" min="0" max="89" value={testElev}
                  onChange={e => setTestElev(Number(e.target.value))}
                  className="w-full accent-emerald-500" />
              </div>
            ) : (
              <>
                <div className="rounded-xl bg-black/70 backdrop-blur px-3 py-2">
                  <label className="flex items-center justify-between text-[11px] text-zinc-300 font-mono">
                    <span>altitude</span><span>{altitude}m</span>
                  </label>
                  <input type="range" min="10" max="200" step="5" value={altitude}
                    onChange={e => setAltitude(Number(e.target.value))}
                    className="w-full accent-emerald-500" />
                </div>
                <button
                  onClick={dropAnchorHere}
                  className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold text-sm"
                >
                  {anchor ? 'Re-drop anchor here' : 'Drop anchor here'}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};
