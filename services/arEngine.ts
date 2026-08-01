/**
 * Loader for the 8th Wall AR engine.
 *
 * The engine is a ~megabyte WASM bundle served from a CDN, so it is fetched
 * the first time someone opens a camera view rather than on every page load —
 * most players never open one. Once loaded it stays for the session.
 *
 * Attribution and the full licence notice are on /licenses; a visible credit
 * appears on the camera intro card.
 */

import * as THREE from 'three';

const ENGINE_SRC = 'https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js';

declare global {
  interface Window {
    XR8?: any;
    XRExtras?: any;
    THREE?: unknown;
  }
}

/**
 * The engine's ThreeJS pipeline module reads `THREE` off `window` rather than
 * accepting an injected instance — it predates bundlers being the norm and
 * expects three.js to have come from a script tag. Our three is an ES import,
 * so the global has to be set by hand or `XR8.Threejs.pipelineModule()` throws
 * "window.THREE does not exist".
 *
 * Assigning our bundled copy also guarantees the engine and our scene code
 * share one instance; two copies of three.js would silently fail instanceof
 * checks between them.
 */
function exposeThreeGlobal() {
  if (!window.THREE) window.THREE = THREE;
}

let loadPromise: Promise<any> | null = null;

/**
 * Resolve with the XR8 global, loading the engine if needed.
 * Rejects if the script can't be fetched — callers should treat that as
 * "AR unavailable" rather than a fatal error, since it usually means a
 * blocked CDN or an offline device.
 */
export function loadArEngine(timeoutMs = 20000): Promise<any> {
  exposeThreeGlobal();
  if (window.XR8) return Promise.resolve(window.XR8);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const finish = () => {
      if (window.XR8) resolve(window.XR8);
      else reject(new Error('engine loaded but XR8 missing'));
    };

    // The engine dispatches `xrloaded` once its WASM is ready; the script's
    // own onload fires earlier than that.
    window.addEventListener('xrloaded', finish, { once: true });

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${ENGINE_SRC}"]`);
    if (!existing) {
      const script = document.createElement('script');
      script.src = ENGINE_SRC;
      script.async = true;
      script.crossOrigin = 'anonymous';
      // Without this the SLAM chunk is fetched lazily on first use, which
      // stalls the camera for several seconds at exactly the wrong moment.
      script.setAttribute('data-preload-chunks', 'slam');
      script.onerror = () => {
        loadPromise = null;
        reject(new Error('could not load the AR engine'));
      };
      document.head.appendChild(script);
    }

    setTimeout(() => {
      if (!window.XR8) {
        loadPromise = null;
        reject(new Error('AR engine timed out'));
      }
    }, timeoutMs);
  });

  return loadPromise;
}

/**
 * Ask for motion access, which iOS gates behind a user gesture.
 *
 * The compass reading this unlocks is only used once, to work out which way
 * the camera was pointing when the session started. After that the engine's
 * visual tracking takes over, so a mediocre reading costs a small rotation
 * offset rather than the drifting object the old compass pipeline produced.
 */
export async function requestMotionAccess(): Promise<boolean> {
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DOE?.requestPermission !== 'function') return true; // Android / older iOS
  try {
    return (await DOE.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Read the device's compass heading, in degrees clockwise from true north.
 * Resolves null if no heading arrives — the caller then places the object
 * relative to whichever way the camera happens to be facing.
 */
/**
 * Continuous compass feed, for correcting accumulated SLAM yaw drift.
 *
 * Deliberately not used to drive orientation — driving from the compass
 * directly is what made the pre-SLAM version swim, because the magnetometer
 * jitters by several degrees between readings. It is used only as an absolute
 * reference that, unlike an integrated gyro, has no drift to accumulate. Heavy
 * smoothing downstream turns the jitter into noise around a stable mean while
 * leaving the slow bias we actually want to remove.
 *
 * `accuracy` is iOS's `webkitCompassAccuracy` in degrees; -1 means the
 * magnetometer is uncalibrated and the heading must not be trusted. Android
 * exposes no equivalent, hence null.
 */
export type HeadingSample = { heading: number; accuracy: number | null };

export function watchHeading(onSample: (sample: HeadingSample) => void): () => void {
  const handler = (event: DeviceOrientationEvent) => {
    const webkit = event as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    if (typeof webkit.webkitCompassHeading === 'number') {
      onSample({
        heading: webkit.webkitCompassHeading,
        accuracy: typeof webkit.webkitCompassAccuracy === 'number' ? webkit.webkitCompassAccuracy : null,
      });
      return;
    }
    if (event.absolute && typeof event.alpha === 'number') {
      onSample({ heading: (360 - event.alpha) % 360, accuracy: null });
    }
  };

  window.addEventListener('deviceorientationabsolute', handler as EventListener);
  window.addEventListener('deviceorientation', handler as EventListener);
  return () => {
    window.removeEventListener('deviceorientationabsolute', handler as EventListener);
    window.removeEventListener('deviceorientation', handler as EventListener);
  };
}

export function readHeading(timeoutMs = 3000): Promise<number | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('deviceorientationabsolute', handler as EventListener);
      window.removeEventListener('deviceorientation', handler as EventListener);
      resolve(value);
    };

    const handler = (event: DeviceOrientationEvent) => {
      const webkit = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
      if (typeof webkit.webkitCompassHeading === 'number') return finish(webkit.webkitCompassHeading);
      // Android reports alpha counter-clockwise from north.
      if (event.absolute && typeof event.alpha === 'number') return finish((360 - event.alpha) % 360);
    };

    window.addEventListener('deviceorientationabsolute', handler as EventListener);
    window.addEventListener('deviceorientation', handler as EventListener);
    setTimeout(() => finish(null), timeoutMs);
  });
}
