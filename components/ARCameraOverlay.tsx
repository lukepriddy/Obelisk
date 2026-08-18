import React, { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, X } from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ARObjectConfig, Zone } from '../types';
import { getDistance, bearingTo, destinationPoint } from '../utils/geo';
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
  /**
   * The tour's background colour. Used for the backdrop behind the camera: the
   * intro screen before the feed starts, and the letterbox bars around it once
   * it does. Hardcoded black before, which made this the one screen that did
   * not match the status bar band above it after everything else was unified.
   */
  bg?: string;
  onClose: () => void;
}

type Phase = 'intro' | 'starting' | 'ready' | 'error';

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

/**
 * How far the camera must actually travel before the object is anchored.
 *
 * A single camera recovers depth only from parallax, which requires the phone
 * to *translate* — rotation gives it nothing. Placing at scene-build time
 * anchors against the weakest depth map of the session, and everything after
 * is the engine correcting that guess: the sudden jumps and rescaling that
 * show up most at close range, where the same error is worth several times
 * more on screen.
 *
 * Measured as the extent of the camera's bounding box, NOT the summed path
 * length. Early tracking is noisy, and summing frame-to-frame movement lets
 * jitter accumulate until a phone sitting still on a table "passes". Jitter
 * rattles around inside a tiny box; a real side-step grows it immediately.
 */
const PARALLAX_EXTENT_M = 0.4;
/** Nobody gets trapped behind a movement requirement — place regardless. */
const SCAN_TIMEOUT_MS = 10000;
/** Long enough not to pop, short enough not to read as an effect. */
const REVEAL_MS = 350;

/** Compass bearing from one coordinate to another, degrees from true north. */
// bearingTo and destinationPoint now live in utils/geo.ts so the placement
// editor computes the object's coordinate with the identical formula. If the
// editor used its own maths the marker a creator drags and the object a player
// sees would sit in slightly different places, and the gap grows with distance.

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
): {
  position: THREE.Vector3;
  facing: number;
  groundDistance: number;
  anchor: { lat: number; lng: number } | null;
} {
  // The object's real coordinate: the zone, plus any offset the creator set.
  // Stored relative to the zone rather than as absolute coordinates, so moving
  // a zone in the editor carries its object along instead of stranding it.
  let anchorLat = zone.lat;
  let anchorLng = zone.lng;
  const offset = config.ground_distance_m ?? 0;
  if (config.behavior !== 'flyover' && offset) {
    const point = destinationPoint(zone.lat, zone.lng, config.ground_bearing_degrees ?? 0, offset);
    anchorLat = point.lat;
    anchorLng = point.lng;
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
    // The object's real coordinate, kept so live GPS can be compared against
    // it later. Only meaningful when we had a fix to derive it from.
    anchor: userPosition ? { lat: anchorLat, lng: anchorLng } : null,
  };
}

/**
 * Where the object should sit in the engine's local frame right now, given a
 * live fix. Mirrors the rotation done at start, but measured from the camera's
 * current tracked position rather than the origin.
 */
function localTargetFrom(
  playerLat: number, playerLng: number,
  anchor: { lat: number; lng: number },
  headingAtStart: number,
  cameraPosition: THREE.Vector3,
  altitude: number,
): THREE.Vector3 {
  const north = (anchor.lat - playerLat) * 111_320;
  const east = (anchor.lng - playerLng) * 111_320 * Math.cos(toRad(playerLat));
  const h = toRad(headingAtStart);
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  return new THREE.Vector3(
    cameraPosition.x + (east * cos - north * sin),
    // Height stays as configured — it's relative to where the camera started,
    // and shouldn't follow the phone up and down.
    altitude,
    cameraPosition.z - (north * cos + east * sin),
  );
}

/**
 * The field of drifting points behind the "View in camera" card.
 *
 * Before this, the screen waiting for the tap was flat black, which reads as
 * something failing to load rather than something about to happen. What is
 * drawn is a rough picture of the job the tracker is about to do: features
 * appearing, linking to their neighbours, and dissolving as the view changes.
 *
 * Laid out once at module load from a fixed seed, never per render. The
 * positions have to be stable across re-renders or the field would resample
 * itself and jump, and there is no reason to pay for the maths again.
 *
 * Two layers at different drift rates and amplitudes: that difference is the
 * whole depth cue. A single layer, however many points, looks like a flat sheet.
 * Everything animates on opacity and transform only, because this sits directly
 * in front of loading a very heavy AR engine and must not compete for the main
 * thread.
 */
const INTRO_FIELD = (() => {
  // Small deterministic PRNG. Math.random would give a different field on every
  // reload, and a fixed layout can be tuned by eye and stay tuned.
  let seed = 20260807;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  // Laid out 100 x 200, roughly a phone's proportions. A square viewBox
  // stretched to a tall screen turns every point into an oval, and correcting
  // that with a preserved aspect ratio instead would crop away half the field.
  // Authoring at the shape it will be displayed at avoids both.
  const layer = (count: number) =>
    Array.from({ length: count }, () => ({
      x: +(rnd() * 100).toFixed(2),
      y: +(rnd() * 200).toFixed(2),
      delay: +(rnd() * 7).toFixed(2),
      dur: +(4.5 + rnd() * 4).toFixed(2),
      r: +(0.34 + rnd() * 0.5).toFixed(2),
    }));

  const near = layer(20);
  const far = layer(34);

  // Link only near-layer points that are genuinely close. A distance threshold
  // rather than nearest-neighbour: it leaves some points unlinked, which is
  // what stops the mesh looking like a deliberate lattice.
  const edges: { x1: number; y1: number; x2: number; y2: number; delay: number; dur: number }[] = [];
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (Math.hypot(near[i].x - near[j].x, near[i].y - near[j].y) > 26) continue;
      edges.push({
        x1: near[i].x, y1: near[i].y, x2: near[j].x, y2: near[j].y,
        delay: +(rnd() * 8).toFixed(2),
        dur: +(5.5 + rnd() * 4).toFixed(2),
      });
    }
  }
  return { near, far, edges };
})();

const IntroField: React.FC<{ accent: string }> = ({ accent }) => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
    {/* Sits low and off-centre so the composition has a horizon rather than a
        bullseye, and so the brightest part is not behind the card. */}
    <div
      className="absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{
        width: '150vmin', height: '150vmin',
        background: `radial-gradient(circle, ${accent}2b 0%, ${accent}0d 42%, transparent 70%)`,
        animation: 'ar-glow 9s ease-in-out infinite',
      }}
    />
    <svg
      className="absolute inset-0 w-full h-full"
      viewBox="0 0 100 200"
      preserveAspectRatio="xMidYMid slice"
    >
      <g style={{ animation: 'ar-drift-far 26s ease-in-out infinite', transformOrigin: 'center' }}>
        {INTRO_FIELD.far.map((p, i) => (
          <circle
            key={`f${i}`} cx={p.x} cy={p.y} r={p.r * 0.62} fill={accent}
            style={{ animation: `ar-twinkle ${p.dur * 1.3}s ease-in-out ${p.delay}s infinite`, opacity: 0 }}
          />
        ))}
      </g>
      <g style={{ animation: 'ar-drift-near 19s ease-in-out infinite', transformOrigin: 'center' }}>
        {INTRO_FIELD.edges.map((e, i) => (
          <line
            key={`e${i}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
            stroke={accent} strokeWidth={0.14}
            style={{ animation: `ar-edge ${e.dur}s ease-in-out ${e.delay}s infinite`, opacity: 0 }}
          />
        ))}
        {INTRO_FIELD.near.map((p, i) => (
          <circle
            key={`n${i}`} cx={p.x} cy={p.y} r={p.r} fill={accent}
            style={{ animation: `ar-twinkle ${p.dur}s ease-in-out ${p.delay}s infinite`, opacity: 0 }}
          />
        ))}
      </g>
    </svg>
  </div>
);

export const ARCameraOverlay: React.FC<ARCameraOverlayProps> = ({
  zone, userPosition, gpsAccuracy, accent = '#10b981', bg = '#09090b', onClose,
}) => {
  // ?ar-debug=1 shows the engine's raw tracking status. Not linked anywhere;
  // it's for diagnosing "why isn't it staying put" in the field.
  const arDebug = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('ar-debug') === '1';
  // GPS position correction is a per-zone creator setting, off unless enabled.
  // Measured in the field: at ~16m it made a close object visibly worse (GPS is
  // accurate to 2-4m, which is ~11 degrees of apparent movement at that range),
  // while at ~200m the same error is under a degree and invisible. So it only
  // pays for distant placements, and the creator is the one who knows which.
  // ?ar-converge=1/0 still overrides it, for A/B testing in the field.
  const convergeOverride = typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('ar-converge');
  const converge = convergeOverride != null
    ? convergeOverride !== '0'
    : configFor(zone).converge === true;
  const driftRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef(configFor(zone));
  const objectRef = useRef<THREE.Object3D | null>(null);
  const placementRef = useRef<ReturnType<typeof localPlacement> | null>(null);
  const runningRef = useRef(false);

  // ── Slow GPS convergence ──────────────────────────────────────────────────
  // The object's local position comes from a single GPS + compass reading taken
  // at start, so it inherits that reading's error (GPS is +/-3-10m) and then
  // accumulates whatever the tracking drifts by. Recomputing where the object
  // ought to be from live GPS and easing towards it fixes both: drift gets
  // corrected, and averaging GPS across a session beats the one sample we
  // opened with.
  //
  // It has to be slow. GPS jitters by metres between fixes, and applying that
  // directly is exactly the swimming that made the old compass version
  // unusable. With a ~20s time constant the object never visibly jumps; it
  // just ends up in a better place than it started.
  const targetWorldRef = useRef<{ lat: number; lng: number } | null>(null);
  const headingRef = useRef<number>(0);
  const livePositionRef = useRef<[number, number] | null>(userPosition);
  livePositionRef.current = userPosition;
  const liveAccuracyRef = useRef<number | null | undefined>(gpsAccuracy);
  liveAccuracyRef.current = gpsAccuracy;
  const lastFrameRef = useRef<number>(0);
  // Recovering from lost tracking is the one case where slow correction is
  // wrong. When the engine relocalises it can re-establish its origin in a
  // different place, so the object reappears offset — and easing back over
  // twenty seconds means watching it sit in the wrong spot. Detecting the
  // reset and converging hard for a moment puts it back before it's noticed.
  const lastCameraRef = useRef<THREE.Vector3 | null>(null);
  const fastUntilRef = useRef(0);

  // Materials of the placed object, cached so the flyover fade can set opacity
  // without walking the scene graph every frame.
  const fadeMaterialsRef = useRef<THREE.Material[]>([]);

  // ── Parallax scan ─────────────────────────────────────────────────────────
  // The object stays hidden until the camera has genuinely moved, so it is
  // anchored against a depth map the engine actually believes in.
  const scanBoxRef = useRef<{ min: THREE.Vector3; max: THREE.Vector3 } | null>(null);
  const scanStartedAtRef = useRef(0);
  const placedAtRef = useRef(0);
  const [scanExtent, setScanExtent] = useState(0);

  const [phase, setPhase] = useState<Phase>('intro');
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  // Startup has several steps that can each fail for unrelated reasons
  // (engine download, motion permission, camera permission, WebGL context).
  // A single "could not start" message hides which one, so the underlying
  // error is kept and shown — the alternative is guessing from a black screen.
  const [detail, setDetail] = useState<string | null>(null);
  const stepRef = useRef<string>('idle');
  // Live tracking quality from the engine. The ref mirrors the state so the
  // per-frame handler can tell whether anything actually changed without
  // reading React state.
  const [tracking, setTracking] = useState<{ status: string; reason: string }>({ status: '', reason: '' });
  const trackingRef = useRef<{ status: string; reason: string }>({ status: '', reason: '' });

  useEffect(() => { configRef.current = configFor(zone); }, [zone]);

  // The debug figures live in refs so the per-frame handler can write them
  // without re-rendering. That leaves the readout frozen between tracking
  // changes, which is useless for watching a correction converge — so when the
  // overlay is on, repaint it twice a second. Off entirely otherwise.
  const [, setDebugTick] = useState(0);
  useEffect(() => {
    if (!arDebug || phase !== 'ready') return;
    const id = setInterval(() => setDebugTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, [arDebug, phase]);

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
      // Collected once for the flyover fade. Traversing the model every frame
      // to find its materials would be wasteful, and a GLB can have many.
      const materials: THREE.Material[] = [];
      object.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!(mesh as THREE.Mesh).isMesh) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) if (material) materials.push(material);
      });
      fadeMaterialsRef.current = materials;
      // Upright by construction: the engine's frame is gravity-aligned, so
      // yaw is the only rotation that needs setting. The old pipeline had to
      // carry an explicit world-up vector to stop objects rolling with the
      // phone; here that cannot happen.
      object.rotation.y = toRad(-placement.facing);
      // Added to the scene but withheld. Its real position is computed once the
      // parallax scan passes, against the camera pose at that moment rather
      // than the origin as it stood at second zero.
      object.visible = false;
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
      targetWorldRef.current = placementRef.current.anchor;
      headingRef.current = heading ?? 0;
      lastFrameRef.current = 0;
      lastCameraRef.current = null;
      scanBoxRef.current = null;
      scanStartedAtRef.current = 0;
      placedAtRef.current = 0;
      fastUntilRef.current = 0;

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
          onUpdate: ({ processCpuResult }: { processCpuResult?: Record<string, any> }) => {
            // Tracking quality decides whether the object is genuinely anchored
            // or merely rotating with the phone. Until the engine has enough
            // visible texture and some sideways movement to establish depth, it
            // falls back to rotation only — which looks like the object walking
            // along with you. Surfacing that lets the player fix it by moving,
            // rather than concluding the feature is broken.
            const reality = processCpuResult?.reality;
            if (reality?.trackingStatus) {
              const status = String(reality.trackingStatus).toUpperCase();
              const reason = reality.trackingReason ? String(reality.trackingReason).toUpperCase() : '';
              // onUpdate runs every frame; only touch React when it changes.
              if (status !== trackingRef.current.status || reason !== trackingRef.current.reason) {
                // Coming back to NORMAL after a loss is the moment the origin
                // may have shifted underneath us.
                if (status === 'NORMAL' && trackingRef.current.status && trackingRef.current.status !== 'NORMAL') {
                  fastUntilRef.current = performance.now() + 3000;
                }
                trackingRef.current = { status, reason };
                setTracking({ status, reason });
              }
            }

            const object = objectRef.current;
            const config = configRef.current;
            if (!object) return;

            // ── Parallax scan, then place ────────────────────────────────────
            {
              const { camera } = window.XR8.Threejs.xrScene();
              const p = camera.position;
              const box = scanBoxRef.current;
              if (!box) {
                scanBoxRef.current = { min: p.clone(), max: p.clone() };
                scanStartedAtRef.current = performance.now();
              } else {
                box.min.min(p);
                box.max.max(p);
              }

              if (!object.visible) {
                const b = scanBoxRef.current!;
                // Largest single-axis displacement. Walking towards the object
                // counts as readily as stepping sideways — both give the
                // triangulation baseline the tracker needs.
                const extent = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
                if (arDebug) setScanExtent(extent);

                const movedEnough = extent >= PARALLAX_EXTENT_M
                  && trackingRef.current.status === 'NORMAL';
                const waitedTooLong = performance.now() - scanStartedAtRef.current > SCAN_TIMEOUT_MS;
                if (!movedEnough && !waitedTooLong) return;

                // Re-derive the position from the settled frame where possible.
                // localTargetFrom works from the camera's CURRENT pose, so the
                // anchor no longer inherits the origin's opening guess.
                const anchorNow = targetWorldRef.current;
                const hereNow = livePositionRef.current;
                if (anchorNow && hereNow && config.behavior !== 'flyover') {
                  object.position.copy(localTargetFrom(
                    hereNow[0], hereNow[1], anchorNow, headingRef.current, p, config.altitude_m,
                  ));
                }
                object.visible = true;
                placedAtRef.current = performance.now();
              }
            }

            // Reveal fade. Multiplied into whatever opacity the behaviour wants
            // rather than assigned, so it composes with the flyover loop fade
            // instead of being overwritten by it a frame later.
            const reveal = placedAtRef.current
              ? Math.min(1, (performance.now() - placedAtRef.current) / REVEAL_MS)
              : 1;
            if (reveal < 1 && config.behavior !== 'flyover') {
              for (const material of fadeMaterialsRef.current) {
                material.transparent = true;
                // A transparent material that still writes depth occludes its
                // own far side, so the model looks hollow mid-fade.
                material.depthWrite = false;
                material.opacity = reveal;
              }
            } else if (config.behavior !== 'flyover' && placedAtRef.current && reveal >= 1) {
              for (const material of fadeMaterialsRef.current) {
                if (!material.transparent) continue;
                material.transparent = false;
                material.depthWrite = true;
                material.opacity = 1;
              }
            }


            // ── Ease towards where live GPS says the object belongs ──
            // Only for static objects; a flyover defines its own path below.
            // Skipped while the fix is poor, since correcting towards a bad
            // reading is worse than keeping the one we opened with.
            const anchor = targetWorldRef.current;
            const here = livePositionRef.current;
            const accuracy = liveAccuracyRef.current;
            if (
              converge && anchor && here && config.behavior !== 'flyover'
              && (accuracy == null || accuracy <= 25)
              && trackingRef.current.status === 'NORMAL'
            ) {
              const now = performance.now();
              const dt = lastFrameRef.current ? Math.min(0.5, (now - lastFrameRef.current) / 1000) : 0;
              lastFrameRef.current = now;
              if (dt > 0) {
                const { camera } = window.XR8.Threejs.xrScene();

                // A tracked camera can't teleport. Anything faster than about
                // 10 m/s is the engine re-establishing its origin, not the
                // player sprinting — the other tell that we've relocalised.
                const previous = lastCameraRef.current;
                if (previous && previous.distanceTo(camera.position) / dt > 10) {
                  fastUntilRef.current = performance.now() + 3000;
                }
                lastCameraRef.current = camera.position.clone();

                const target = localTargetFrom(
                  here[0], here[1], anchor, headingRef.current, camera.position, config.altitude_m,
                );
                // Normally ~20s, so individual GPS fixes barely register and
                // only their average moves the object. Briefly 0.4s after a
                // reset, to put it back where it belongs before the player
                // reads the new position as correct. Frame-rate independent
                // either way.
                const tau = performance.now() < fastUntilRef.current ? 0.4 : 20;
                object.position.lerp(target, 1 - Math.exp(-dt / tau));
                if (arDebug) driftRef.current = object.position.distanceTo(target);
              }
            }

            // Flyovers drift along their configured path. Static objects need
            // nothing further — the engine holds them in place by itself.
            if (config.behavior !== 'flyover') return;
            const duration = Math.max(8, config.flight_duration_seconds || 30);
            const span = Math.max(30, config.flight_distance_m || 180);
            const progress = ((performance.now() / 1000) % duration) / duration;
            const along = (progress - 0.5) * span;

            // The path is one-directional, so at the wrap the object would jump
            // the whole span backwards in a single frame. Fading it out over the
            // last stretch and back in over the first hides the reset: it flies
            // away, then arrives again, instead of teleporting mid-air.
            const FADE = 0.12;
            const loopOpacity = progress < FADE ? progress / FADE
              : progress > 1 - FADE ? (1 - progress) / FADE
              : 1;
            // Composed with the reveal rather than replacing it, so a flyover
            // arriving mid-loop still fades in instead of snapping to whatever
            // the loop position happens to imply.
            const opacity = loopOpacity * reveal;
            const fading = opacity < 0.999;
            for (const material of fadeMaterialsRef.current) {
              material.transparent = fading;
              // Transparent materials that still write depth occlude their own
              // far side, so a model can look hollow mid-fade.
              material.depthWrite = !fading;
              material.opacity = opacity;
            }
            // Convert the compass bearing into the engine's local frame the same
            // way the static placement does — by subtracting the session's start
            // heading. This previously subtracted placement.facing, which is the
            // object's own rotation (facing_degrees − headingAtStart), so the
            // start heading ended up added rather than subtracted and the path
            // pointed somewhere different depending on which way the player
            // happened to be facing when they opened the camera.
            const direction = toRad((config.flight_bearing_degrees ?? 0) - headingRef.current);
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
    <>
      {/* The backdrop is a separate fixed layer so it can carry
          overlay-edge-bleed (see docs/mobile-player-edge-seams.md) without
          dragging the edge-anchored chrome below off-screen with it. The
          content layer stays at a true inset-0 so `px-4` still means 4 from
          the real screen edge. Both are position:fixed, as the class requires.

          Takes the tour's background rather than black. This is what shows
          behind the intro screen and in the letterbox bars around the camera
          feed, and while it was hardcoded black it was the only surface left
          that did not match the status bar band above it. */}
      <div
        className="fixed inset-0 z-[5000] overlay-edge-bleed"
        style={{ backgroundColor: bg }}
        aria-hidden="true"
      />
    <div className="fixed inset-0 z-[5000] text-white overflow-hidden">
      {/* inset-0 + margin auto centres an element with an intrinsic aspect,
          and the max- constraints make it behave like object-fit: contain on
          any screen shape. The backing store is sized to match in start(). */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 m-auto max-w-full max-h-full"
        style={{ aspectRatio: '3 / 4' }}
      />

      {/* Only while waiting for the tap. Once the camera is live it would be
          drawing over the real world for no reason, and competing for frames
          with the tracker. */}
      {phase === 'intro' && <IntroField accent={accent} />}

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
            Hold your phone up and move it slowly.
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

      {phase === 'ready' && (() => {
        // An object only stays put once the engine has real depth. Before that
        // it rotates with the phone and appears to follow you as you walk, so
        // the honest thing is to say what would fix it.
        const degraded = tracking.status && tracking.status !== 'NORMAL';
        // Until the object is anchored, the guidance IS the task rather than a
        // warning — the movement it asks for is what earns the placement.
        const scanning = !placedAtRef.current;
        const hint = scanning ? 'Move your phone slowly side to side to read the space'
          : !degraded ? null
          : tracking.reason === 'INSUFFICIENT_FEATURES' ? 'Point at something with more detail'
          : tracking.reason === 'INSUFFICIENT_LIGHT' ? 'Too dark to track, more light will help'
          : tracking.reason === 'EXCESSIVE_MOTION' || tracking.reason === 'MOTION' ? 'Move a little slower'
          : tracking.reason === 'RELOCALIZING' ? 'Finding your place again…'
          : 'Move your phone slowly side to side';
        return (
          <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col items-center gap-1.5 pointer-events-none px-5">
            <div className={`rounded-full backdrop-blur px-3 py-1.5 text-[11px] ${
              degraded ? 'bg-amber-950/80 text-amber-200' : 'bg-black/65 text-zinc-200'
            }`}>
              {hint ?? (config.behavior === 'flyover' ? 'Flyover active' : 'Look around to find it')}
            </div>
            {arDebug && (
              <div className="rounded bg-black/80 px-2 py-1 text-[10px] font-mono text-emerald-300">
                {tracking.status || 'no status'}{tracking.reason ? ` · ${tracking.reason}` : ''}
                {' · '}conv {converge ? 'on' : 'off'}
                {' · '}scan {scanExtent.toFixed(2)}m{placedAtRef.current ? ' ✓' : ''}
                {converge && ` · off by ${driftRef.current.toFixed(1)}m`}
                {converge && performance.now() < fastUntilRef.current && ' · RESYNC'}
              </div>
            )}
          </div>
        );
      })()}

      {modelError && phase === 'ready' && (
        <div className="absolute inset-x-5 bottom-[max(4rem,calc(env(safe-area-inset-bottom)+3rem))] rounded-xl bg-red-950/90 px-3 py-2 text-xs text-red-200 text-center">
          {modelError}
        </div>
      )}
    </div>
    </>
  );
};
