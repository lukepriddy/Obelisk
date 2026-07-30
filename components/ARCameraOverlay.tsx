import React, { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, X } from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ARObjectConfig, Zone } from '../types';
import { getDistance } from '../utils/geo';
import { loadArEngine, requestMotionAccess, readHeading } from '../services/arEngine';

/**
 * Camera view for a zone's AR object.
 *
 * Position comes from the engine's visual tracking (SLAM), not from the
 * compass. That distinction is the whole feature: an earlier version derived
 * the object's screen position from the magnetometer every frame, which meant
 * heading noise moved the object — it drifted, swam near the horizon, and span
 * when viewed from directly underneath, because azimuth is undefined at the
 * zenith. None of that math exists any more.
 *
 * Now GPS and the compass are read exactly ONCE, to work out where the object
 * sits relative to the camera's starting pose. From then on the engine holds it
 * against real visual features, so walking around it behaves the way a real
 * object does. A poor initial compass reading costs a small rotation offset
 * rather than a permanently unstable object.
 *
 * The engine is proprietary (Niantic Spatial) and loaded from their CDN on
 * demand; see services/arEngine.ts and /licenses.
 */

interface ARCameraOverlayProps {
  zone: Zone;
  userPosition: [number, number] | null;
  gpsAccuracy?: number | null;
  /** The tour's accent colour, so the camera view matches the rest of it. */
  accent?: string;
  onClose: () => void;
}

type Phase = 'intro' | 'starting' | 'ready' | 'error';

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

/** Compass bearing from one coordinate to another, degrees from true north. */
const bearingTo = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLng = toRad(lng2 - lng1);
  const y = Math.sin(deltaLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

const defaultConfig = (zone: Zone): ARObjectConfig => ({
  enabled: true,
  asset_url: zone.type === 'character' ? zone.character_image_url : zone.zone_image_url,
  asset_type: 'image',
  behavior: 'static',
  altitude_m: 25,
  scale_m: 3,
  facing_degrees: 0,
  ground_distance_m: 15,
  ground_bearing_degrees: 0,
  flight_bearing_degrees: 0,
  flight_distance_m: 180,
  flight_duration_seconds: 30,
});

const configFor = (zone: Zone) => ({ ...defaultConfig(zone), ...(zone.ar_config || {}) });
const isGlbAsset = (config: ARObjectConfig) =>
  config.asset_type === 'glb' || Boolean(config.asset_url?.split('?')[0].toLowerCase().endsWith('.glb'));

/**
 * Where the object sits in the engine's local frame, in metres.
 *
 * The engine starts with the camera at the origin looking down -Z, with +Y up
 * and the frame gravity-aligned but yawed to wherever the phone happened to be
 * pointing. So a real-world bearing has to be expressed relative to that
 * starting heading.
 */
function localPlacement(
  config: ARObjectConfig,
  zone: Zone,
  userPosition: [number, number] | null,
  headingAtStart: number | null,
): { position: THREE.Vector3; facing: number; groundDistance: number } {
  // The object's real coordinate: the zone, plus any offset the creator set.
  let anchorLat = config.anchor_lat ?? zone.lat;
  let anchorLng = config.anchor_lng ?? zone.lng;
  const offset = config.ground_distance_m ?? 0;
  if (config.behavior !== 'flyover' && offset) {
    const bearing = toRad(config.ground_bearing_degrees ?? 0);
    anchorLat += (Math.cos(bearing) * offset) / 111_320;
    anchorLng += (Math.sin(bearing) * offset) / (111_320 * Math.cos(toRad(anchorLat)) || 1);
  }

  // Without a fix, fall back to placing it at its configured offset straight
  // ahead — still a real object in space, just not compass-aligned.
  let groundDistance = Math.max(offset, 1);
  let trueBearing = config.ground_bearing_degrees ?? 0;
  if (userPosition) {
    const [userLat, userLng] = userPosition;
    const measured = getDistance(userLat, userLng, anchorLat, anchorLng);
    // Below a metre the bearing is meaningless; keep it in front of the viewer.
    if (measured > 1) {
      groundDistance = measured;
      trueBearing = bearingTo(userLat, userLng, anchorLat, anchorLng);
    }
  }

  // Rotate the real-world bearing into the camera's starting frame.
  const relative = toRad(trueBearing - (headingAtStart ?? trueBearing));
  return {
    position: new THREE.Vector3(
      groundDistance * Math.sin(relative),
      config.altitude_m,
      -groundDistance * Math.cos(relative),
    ),
    facing: (config.facing_degrees ?? 0) - (headingAtStart ?? 0),
    groundDistance,
  };
}

export const ARCameraOverlay: React.FC<ARCameraOverlayProps> = ({
  zone, userPosition, accent = '#10b981', onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef(configFor(zone));
  const objectRef = useRef<THREE.Object3D | null>(null);
  const placementRef = useRef<ReturnType<typeof localPlacement> | null>(null);
  const runningRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('intro');
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  // Startup has several steps that can each fail for unrelated reasons
  // (engine download, motion permission, camera permission, WebGL context).
  // A single "could not start" message hides which one, so the underlying
  // error is kept and shown — the alternative is guessing from a black screen.
  const [detail, setDetail] = useState<string | null>(null);
  const stepRef = useRef<string>('idle');

  useEffect(() => { configRef.current = configFor(zone); }, [zone]);

  /** Stop the engine and release the camera. Safe to call more than once. */
  const stop = () => {
    if (!runningRef.current) return;
    runningRef.current = false;
    try { window.XR8?.stop?.(); } catch { /* already torn down */ }
    try { window.XR8?.clearCameraPipelineModules?.(); } catch { /* ditto */ }
  };

  useEffect(() => stop, []);

  const close = () => { stop(); onClose(); };

  /** Build the scene once the engine has a tracked camera. */
  const buildScene = () => {
    const config = configRef.current;
    const { scene } = window.XR8.Threejs.xrScene();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x1f2937, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 4, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x80bfff, 0.8);
    fill.position.set(-3, 1, -2);
    scene.add(fill);

    const placement = placementRef.current!;

    const place = (object: THREE.Object3D) => {
      object.position.copy(placement.position);
      // Upright by construction: the engine's frame is gravity-aligned, so
      // yaw is the only rotation that needs setting. The old pipeline had to
      // carry an explicit world-up vector to stop objects rolling with the
      // phone; here that cannot happen.
      object.rotation.y = toRad(-placement.facing);
      scene.add(object);
      objectRef.current = object;
    };

    if (isGlbAsset(config) && config.asset_url) {
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      draco.setWorkerLimit(1);
      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(
        config.asset_url,
        gltf => {
          const model = gltf.scene;
          const bounds = new THREE.Box3().setFromObject(model);
          const size = bounds.getSize(new THREE.Vector3());
          const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
          model.position.sub(bounds.getCenter(new THREE.Vector3()));
          const pivot = new THREE.Group();
          pivot.add(model);
          // Normalise to one unit, then scale to the creator's real-world size.
          // The engine tracks in metres, so this is a true physical dimension
          // rather than something faked from camera distance.
          pivot.scale.setScalar((1 / maxDimension) * Math.max(0.1, config.scale_m));
          place(pivot);
        },
        undefined,
        cause => {
          console.error('AR GLB load failed', cause);
          setModelError('This 3D model could not be loaded.');
        },
      );
    } else if (config.asset_url) {
      // A flat image is a billboard: it should face the viewer wherever they
      // stand, so it stays legible from any angle.
      new THREE.TextureLoader().load(
        config.asset_url,
        texture => {
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: texture, transparent: true }),
          );
          sprite.scale.setScalar(Math.max(0.1, config.scale_m));
          place(sprite);
        },
        undefined,
        () => setModelError('This image could not be loaded.'),
      );
    }
  };

  const start = async () => {
    setError(null);
    setDetail(null);
    setPhase('starting');

    try {
      // Motion access is gated behind this tap on iOS, so it has to happen
      // inside the gesture rather than on mount.
      // A refusal here isn't fatal: without a compass reading the object is
      // placed relative to wherever the camera is pointing instead of true
      // north, which is a rotation offset rather than a broken experience.
      stepRef.current = 'motion permission';
      await requestMotionAccess();

      stepRef.current = 'loading engine';
      const XR8 = await loadArEngine();

      stepRef.current = 'reading compass';
      const heading = await readHeading();

      stepRef.current = 'computing placement';
      placementRef.current = localPlacement(configRef.current, zone, userPosition, heading);

      stepRef.current = 'preparing canvas';
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('canvas element missing');
      // Render at the camera's own 3:4 shape rather than stretching to fill a
      // tall screen. Filling costs a third of the horizontal field of view —
      // measured at 36° versus 47° — because the engine keeps its vertical FOV
      // and throws the sides away. The bands this leaves above and below are
      // where the title and close button sit, so nothing is wasted and the
      // chrome stops covering the camera image.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const fit = Math.min(window.innerWidth / 3, window.innerHeight / 4);
      canvas.width = Math.round(fit * 3 * dpr);
      canvas.height = Math.round(fit * 4 * dpr);

      stepRef.current = 'configuring engine';
      if (!XR8.XrController || !XR8.Threejs || !XR8.GlTextureRenderer) {
        throw new Error(
          `engine modules missing (XrController:${!!XR8.XrController} Threejs:${!!XR8.Threejs} GlTextureRenderer:${!!XR8.GlTextureRenderer})`,
        );
      }
      XR8.XrController.configure({ disableWorldTracking: false });
      XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        {
          name: 'obelisk-ar',
          onStart: () => {
            try {
              buildScene();
              setPhase('ready');
            } catch (cause) {
              console.error('AR scene failed', cause);
              setError('The camera view could not start.');
              setPhase('error');
            }
          },
          onUpdate: () => {
            // Flyovers drift along their configured path. Static objects need
            // nothing here — the engine holds them in place by itself.
            const object = objectRef.current;
            const config = configRef.current;
            if (!object || config.behavior !== 'flyover') return;
            const duration = Math.max(8, config.flight_duration_seconds || 30);
            const span = Math.max(30, config.flight_distance_m || 180);
            const progress = ((performance.now() / 1000) % duration) / duration;
            const along = (progress - 0.5) * span;
            const direction = toRad((config.flight_bearing_degrees ?? 0) - (placementRef.current?.facing ?? 0));
            const base = placementRef.current!.position;
            object.position.set(
              base.x + Math.sin(direction) * along,
              base.y,
              base.z - Math.cos(direction) * along,
            );
          },
          // The engine reports camera and tracking failures here rather than by
          // rejecting run(), so this is the only place some of them surface.
          onException: (cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            console.error('AR pipeline exception', cause);
            stop();
            setError('Augmented reality could not start on this device.');
            setDetail(`pipeline: ${message}`);
            setPhase('error');
          },
        },
      ]);

      stepRef.current = 'starting engine';
      runningRef.current = true;
      await XR8.run({ canvas });
    } catch (cause) {
      console.error('AR start failed', cause);
      stop();
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        /engine|timed out|could not load/i.test(message)
          ? 'Augmented reality could not load. Check your connection and try again.'
          : 'The camera could not be started. Allow camera access and try again.',
      );
      setDetail(`${stepRef.current}: ${message}`);
      setPhase('error');
    }
  };

  const config = configFor(zone);

  return (
    <div className="fixed inset-0 z-[5000] bg-black text-white overflow-hidden">
      {/* inset-0 + margin auto centres an element with an intrinsic aspect,
          and the max- constraints make it behave like object-fit: contain on
          any screen shape. The backing store is sized to match in start(). */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 m-auto max-w-full max-h-full"
        style={{ aspectRatio: '3 / 4' }}
      />

      <div className="absolute top-0 inset-x-0 pt-[max(1rem,env(safe-area-inset-top))] px-4 flex items-center justify-between">
        <div className="rounded-xl bg-black/70 backdrop-blur px-3 py-2">
          <p className="text-sm font-bold leading-tight">{zone.title}</p>
          <p className="text-[11px]" style={{ color: accent }}>Camera view</p>
        </div>
        <button onClick={close} className="w-11 h-11 rounded-full bg-black/70 backdrop-blur flex items-center justify-center" aria-label="Close camera view">
          <X size={20} />
        </button>
      </div>

      {phase === 'intro' && (
        <div className="absolute inset-x-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-zinc-900/95 backdrop-blur p-5 shadow-2xl">
          {/* This screen isn't a second confirmation — it's where the camera and
              motion permissions get requested, which iOS only allows from a tap.
              So rather than repeat the button that got us here, it explains what
              the tracking needs: a slow pan to read the space. */}
          <div className="flex items-center gap-3 mb-3"><Camera style={{ color: accent }} size={22} /><h2 className="font-bold">View in camera</h2></div>
          <p className="text-sm text-zinc-300 leading-relaxed">
            Hold your phone up and move it slowly — it reads the space around you,
            then places the object in it.
          </p>
          <button
            onClick={start}
            className="w-full mt-4 py-3 rounded-xl text-white font-bold active:opacity-80"
            style={{ backgroundColor: accent }}
          >
            I'm ready
          </button>
          {/* Attribution is required by the AR engine's licence. It sits on
              this card rather than in the live camera view: the licence asks
              for credit in the material where the functionality is used, and
              this is the last thing read before it starts — putting chrome
              over the experience itself would cost the moment it exists for.
              Full copyright, licence reference, and warranty disclaimer are
              on /licenses. */}
          <p className="text-[10px] text-zinc-500 text-center mt-3 leading-snug">
            AR tracking by 8th Wall — Niantic Spatial ·{' '}
            <a href="/licenses" target="_blank" rel="noreferrer" className="underline hover:text-zinc-400">
              Notices
            </a>
          </p>
        </div>
      )}

      {phase === 'starting' && (
        <div className="absolute inset-x-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-zinc-900/95 backdrop-blur p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <Loader2 className="animate-spin" style={{ color: accent }} size={20} />
            <div>
              <h2 className="font-bold">Starting camera</h2>
              <p className="text-xs text-zinc-400 mt-0.5">Move the phone slowly so it can read the space around you.</p>
            </div>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="absolute inset-x-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-zinc-900/95 backdrop-blur p-5 shadow-2xl">
          <p className="text-sm text-zinc-200 leading-relaxed">{error || 'Camera view could not start.'}</p>
          {detail && (
            <p className="mt-2 text-[10px] font-mono text-zinc-500 leading-snug break-words">{detail}</p>
          )}
          <button onClick={() => setPhase('intro')} className="w-full mt-4 py-3 rounded-xl bg-zinc-700 text-white font-bold">Try again</button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-center pointer-events-none">
          <div className="rounded-full bg-black/65 backdrop-blur px-3 py-1.5 text-[11px] text-zinc-200">
            {config.behavior === 'flyover' ? 'Flyover active' : 'Look around to find it'}
          </div>
        </div>
      )}

      {modelError && phase === 'ready' && (
        <div className="absolute inset-x-5 bottom-[max(4rem,calc(env(safe-area-inset-bottom)+3rem))] rounded-xl bg-red-950/90 px-3 py-2 text-xs text-red-200 text-center">
          {modelError}
        </div>
      )}
    </div>
  );
};
