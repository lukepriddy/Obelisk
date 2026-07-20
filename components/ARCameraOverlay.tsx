import React, { useEffect, useRef, useState } from 'react';
import { Camera, Compass, Loader2, X } from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ARObjectConfig, Zone } from '../types';
import { getDistance } from '../utils/geo';

interface ARCameraOverlayProps {
  zone: Zone;
  userPosition: [number, number] | null;
  onClose: () => void;
}

type Quaternion = [number, number, number, number];
type Phase = 'intro' | 'calibrating' | 'ready' | 'error';

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const bearingTo = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLng = toRad(lng2 - lng1);
  const y = Math.sin(deltaLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

const deviceToEarth = (alphaDeg: number, betaDeg: number, gammaDeg: number) => {
  const x = toRad(betaDeg);
  const y = toRad(gammaDeg);
  const z = toRad(alphaDeg);
  const cX = Math.cos(x), sX = Math.sin(x);
  const cY = Math.cos(y), sY = Math.sin(y);
  const cZ = Math.cos(z), sZ = Math.sin(z);

  return [
    cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY,
    cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX,
    -cX * sY, sX, cX * cY,
  ];
};

const earthToDevice = (m: number[], v: number[]) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

const skyVector = (bearingDeg: number, elevationDeg: number) => {
  const bearing = toRad(bearingDeg);
  const elevation = toRad(elevationDeg);
  return [
    Math.cos(elevation) * Math.sin(bearing),
    Math.cos(elevation) * Math.cos(bearing),
    Math.sin(elevation),
  ];
};

const matrixToQuaternion = (m: number[]): Quaternion => {
  const trace = m[0] + m[4] + m[8];
  let w: number;
  let x: number;
  let y: number;
  let z: number;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
  }
  const length = Math.hypot(w, x, y, z) || 1;
  return [w / length, x / length, y / length, z / length];
};

const quaternionToMatrix = ([w, x, y, z]: Quaternion) => [
  1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
  2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
  2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
];

const slerp = (from: Quaternion, to: Quaternion, amount: number): Quaternion => {
  let [bw, bx, by, bz] = to;
  let dot = from[0] * bw + from[1] * bx + from[2] * by + from[3] * bz;
  if (dot < 0) { dot = -dot; bw = -bw; bx = -bx; by = -by; bz = -bz; }
  if (dot > 0.9995) {
    const result: Quaternion = [
      from[0] + (bw - from[0]) * amount,
      from[1] + (bx - from[1]) * amount,
      from[2] + (by - from[2]) * amount,
      from[3] + (bz - from[3]) * amount,
    ];
    const length = Math.hypot(...result) || 1;
    return [result[0] / length, result[1] / length, result[2] / length, result[3] / length];
  }
  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const a = Math.sin((1 - amount) * theta) / sinTheta;
  const b = Math.sin(amount * theta) / sinTheta;
  return [from[0] * a + bw * b, from[1] * a + bx * b, from[2] * a + by * b, from[3] * a + bz * b];
};

const defaultConfig = (zone: Zone): ARObjectConfig => ({
  enabled: true,
  asset_url: zone.type === 'character' ? zone.character_image_url : zone.zone_image_url,
  asset_type: 'image',
  behavior: 'static',
  altitude_m: 25,
  scale_m: 3,
  facing_degrees: 0,
  flight_bearing_degrees: 0,
  flight_distance_m: 180,
  flight_duration_seconds: 30,
});

const configFor = (zone: Zone) => ({ ...defaultConfig(zone), ...(zone.ar_config || {}) });
const isGlbAsset = (config: ARObjectConfig) =>
  config.asset_type === 'glb' || Boolean(config.asset_url?.split('?')[0].toLowerCase().endsWith('.glb'));

const HFOV = 63;
const VFOV = 95;

export const ARCameraOverlay: React.FC<ARCameraOverlayProps> = ({ zone, userPosition, onClose }) => {
  const configRef = useRef(configFor(zone));
  const videoRef = useRef<HTMLVideoElement>(null);
  const objectRef = useRef<HTMLDivElement>(null);
  const threeHostRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; model: THREE.Group | null; mixer: THREE.AnimationMixer | null; lastFrame: number } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const orientationRef = useRef({ alpha: 0, beta: 0, gamma: 0, heading: null as number | null });
  const filterRef = useRef<{ value: Quaternion; at: number } | null>(null);
  const calibrationRef = useRef({ sin: 0, cos: 1, samples: 0, locked: false });
  const [phase, setPhase] = useState<Phase>('intro');
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [calibrationProgress, setCalibrationProgress] = useState(0);

  useEffect(() => {
    configRef.current = configFor(zone);
  }, [zone]);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  useEffect(() => () => stopCamera(), []);

  // GLB rendering is a transparent WebGL layer over the camera video. Its
  // projection is updated by the same loop as the 2D image path below.
  useEffect(() => {
    const config = configRef.current;
    const host = threeHostRef.current;
    if (!host || !isGlbAsset(config) || !config.asset_url || (phase !== 'calibrating' && phase !== 'ready')) return;

    setModelError(null);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(VFOV, window.innerWidth / window.innerHeight, 0.01, 100);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'absolute inset-0 w-full h-full pointer-events-none';
    host.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x1f2937, 2.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2, 4, 3);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x80bfff, 0.8);
    fillLight.position.set(-3, 1, -2);
    scene.add(fillLight);

    const state = { renderer, scene, camera, model: null as THREE.Group | null, mixer: null as THREE.AnimationMixer | null, lastFrame: performance.now() };
    threeRef.current = state;
    const loader = new GLTFLoader();
    loader.load(
      config.asset_url,
      gltf => {
        if (threeRef.current !== state) return;
        const model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        const center = bounds.getCenter(new THREE.Vector3());
        const maxDimension = Math.max(bounds.getSize(new THREE.Vector3()).x, bounds.getSize(new THREE.Vector3()).y, bounds.getSize(new THREE.Vector3()).z, 0.001);
        model.position.sub(center);
        model.scale.setScalar(1 / maxDimension);
        const pivot = new THREE.Group();
        pivot.add(model);
        pivot.visible = false;
        scene.add(pivot);
        state.model = pivot;
        if (gltf.animations.length) {
          state.mixer = new THREE.AnimationMixer(pivot);
          gltf.animations.forEach(clip => state.mixer?.clipAction(clip).play());
        }
      },
      undefined,
      () => setModelError('This GLB could not be loaded. Try a smaller .glb with embedded textures.'),
    );
    const resize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      scene.traverse(node => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.filter(Boolean).forEach(material => material.dispose?.());
      });
      renderer.dispose();
      renderer.domElement.remove();
      if (threeRef.current === state) threeRef.current = null;
    };
  }, [phase, zone]);

  const startCamera = async () => {
    setError(null);
    if (!userPosition) {
      setError('Location is still loading. Keep this zone open and try again in a moment.');
      setPhase('error');
      return;
    }
    const DeviceOrientation = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (typeof DeviceOrientation.requestPermission === 'function') {
        const permission = await DeviceOrientation.requestPermission();
        if (permission !== 'granted') throw new Error('Motion access was not allowed.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase('calibrating');
    } catch (cause) {
      stopCamera();
      setError(cause instanceof Error ? cause.message : 'Camera access could not be started.');
      setPhase('error');
    }
  };

  useEffect(() => {
    if (phase !== 'calibrating' && phase !== 'ready') return;
    const onOrientation = (event: DeviceOrientationEvent) => {
      const webkit = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
      const current = orientationRef.current;
      if (typeof event.alpha === 'number') current.alpha = event.alpha;
      if (typeof event.beta === 'number') current.beta = event.beta;
      if (typeof event.gamma === 'number') current.gamma = event.gamma;
      if (typeof webkit.webkitCompassHeading === 'number') current.heading = webkit.webkitCompassHeading;
      else if (typeof event.alpha === 'number') current.heading = (360 - event.alpha) % 360;
    };
    window.addEventListener('deviceorientationabsolute', onOrientation as EventListener);
    window.addEventListener('deviceorientation', onOrientation as EventListener);
    return () => {
      window.removeEventListener('deviceorientationabsolute', onOrientation as EventListener);
      window.removeEventListener('deviceorientation', onOrientation as EventListener);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'calibrating' && phase !== 'ready') return;
    let raf = 0;
    let progressAt = 0;
    const frame = (time: number) => {
      raf = requestAnimationFrame(frame);
      const object = objectRef.current;
      const three = threeRef.current;
      if (three) {
        three.mixer?.update(Math.min(0.1, Math.max(0, (time - three.lastFrame) / 1000)));
        three.lastFrame = time;
      }
      const usingGlb = isGlbAsset(configRef.current);
      const orientation = orientationRef.current;
      const calibration = calibrationRef.current;
      const rawMatrix = deviceToEarth(orientation.alpha, orientation.beta, orientation.gamma);
      const flat = Math.abs(orientation.beta) < 20 && Math.abs(orientation.gamma) < 20;

      if (!calibration.locked) {
        if (flat && orientation.heading !== null) {
          const frameAzimuth = (toDeg(Math.atan2(rawMatrix[1], rawMatrix[4])) + 360) % 360;
          const offset = ((orientation.heading - frameAzimuth) % 360 + 360) % 360;
          const radians = toRad(offset);
          if (calibration.samples === 0) {
            calibration.sin = Math.sin(radians);
            calibration.cos = Math.cos(radians);
          } else {
            calibration.sin += (Math.sin(radians) - calibration.sin) * 0.08;
            calibration.cos += (Math.cos(radians) - calibration.cos) * 0.08;
          }
          calibration.samples += 1;
        } else {
          calibration.samples = Math.max(0, calibration.samples - 3);
        }
        if (time - progressAt > 80) {
          progressAt = time;
          setCalibrationProgress(clamp(calibration.samples / 75, 0, 1));
        }
        if (calibration.samples < 75) {
          if (object) object.style.display = 'none';
          if (three?.model) three.model.visible = false;
          three?.renderer.render(three.scene, three.camera);
          return;
        }
        calibration.locked = true;
        setPhase('ready');
      }

      if (!userPosition) return;
      const config = configRef.current;
      const anchorLat = config.anchor_lat ?? zone.lat;
      const anchorLng = config.anchor_lng ?? zone.lng;
      let objectLat = anchorLat;
      let objectLng = anchorLng;
      let objectFacing = config.facing_degrees;
      if (config.behavior === 'flyover') {
        const duration = Math.max(8, config.flight_duration_seconds || 30);
        const span = Math.max(30, config.flight_distance_m || 180);
        const progress = (time / 1000 % duration) / duration;
        const along = (progress - 0.5) * span;
        const direction = config.flight_bearing_degrees ?? 0;
        objectLat += Math.cos(toRad(direction)) * along / 111_320;
        objectLng += Math.sin(toRad(direction)) * along / (111_320 * Math.cos(toRad(anchorLat)) || 1);
        objectFacing = direction;
      }

      const [userLat, userLng] = userPosition;
      const horizontalDistance = getDistance(userLat, userLng, objectLat, objectLng);
      const bearing = horizontalDistance > 1
        ? bearingTo(userLat, userLng, objectLat, objectLng)
        : 0;
      const elevation = Math.min(89.5, toDeg(Math.atan2(config.altitude_m, Math.max(horizontalDistance, 0.5))));
      const northOffset = (toDeg(Math.atan2(calibration.sin, calibration.cos)) + 360) % 360;
      const rawOrientation = matrixToQuaternion(rawMatrix);
      const previous = filterRef.current;
      if (!previous) filterRef.current = { value: rawOrientation, at: time };
      else {
        const elapsed = Math.min(100, Math.max(0, time - previous.at));
        filterRef.current = {
          value: slerp(previous.value, rawOrientation, 1 - Math.exp(-elapsed / 150)),
          at: time,
        };
      }

      const objectVector = skyVector(((bearing - northOffset) % 360 + 360) % 360, elevation);
      const deviceVector = earthToDevice(quaternionToMatrix(filterRef.current.value), objectVector);
      const depth = -deviceVector[2];
      if (depth <= 0.02) {
        if (object) object.style.display = 'none';
        if (three?.model) three.model.visible = false;
        three?.renderer.render(three.scene, three.camera);
        return;
      }

      const width = window.innerWidth;
      const height = window.innerHeight;
      const x = width / 2 + (deviceVector[0] / depth) * ((width / 2) / Math.tan(toRad(HFOV / 2)));
      const y = height / 2 - (deviceVector[1] / depth) * ((height / 2) / Math.tan(toRad(VFOV / 2)));
      const slantDistance = Math.sqrt(horizontalDistance ** 2 + config.altitude_m ** 2);
      const angularSize = Math.min(40, toDeg(2 * Math.atan(config.scale_m / (2 * Math.max(slantDistance, 1)))));
      const size = Math.max(28, (angularSize / VFOV) * height);
      const playerBearingFromObject = bearingTo(objectLat, objectLng, userLat, userLng);
      const facingDifference = Math.abs((((playerBearingFromObject - objectFacing) + 540) % 360) - 180);
      const facingScale = 0.35 + 0.65 * Math.max(0, Math.cos(toRad(facingDifference)));
      const distanceOpacity = config.behavior === 'flyover' ? clamp(1 - horizontalDistance / 260, 0, 1) : 1;
      if (distanceOpacity < 0.02 || x < -size || x > width + size || y < -size || y > height + size) {
        if (object) object.style.display = 'none';
        if (three?.model) three.model.visible = false;
        three?.renderer.render(three.scene, three.camera);
        return;
      }
      if (usingGlb) {
        if (object) object.style.display = 'none';
        if (three?.model) {
          // Keep the physical scale independent of the camera-space distance.
          // Models are normalized to one unit when loaded, then projected from
          // a stable virtual camera distance.
          const virtualDistance = 10;
          const position = new THREE.Vector3(deviceVector[0], deviceVector[1], deviceVector[2]).normalize().multiplyScalar(virtualDistance);
          const facingDevice = earthToDevice(
            quaternionToMatrix(filterRef.current.value),
            skyVector(((objectFacing - northOffset) % 360 + 360) % 360, 0),
          );
          const forward = new THREE.Vector3(facingDevice[0], facingDevice[1], facingDevice[2]).normalize();
          three.model.visible = true;
          three.model.position.copy(position);
          three.model.scale.setScalar(Math.max(0.002, virtualDistance * config.scale_m / Math.max(slantDistance, 1)));
          three.model.lookAt(position.clone().add(forward));
        }
        three?.renderer.render(three.scene, three.camera);
      } else if (object) {
        if (three?.model) three.model.visible = false;
        three?.renderer.render(three.scene, three.camera);
        object.style.display = 'block';
        object.style.width = `${size}px`;
        object.style.height = `${size}px`;
        object.style.opacity = `${distanceOpacity}`;
        object.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scaleX(${facingScale})`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, userPosition, zone.lat, zone.lng]);

  const close = () => {
    stopCamera();
    onClose();
  };
  const config = configFor(zone);

  return (
    <div className="fixed inset-0 z-[5000] bg-black text-white overflow-hidden">
      <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0 bg-black/10 pointer-events-none" />
      <div ref={threeHostRef} className="absolute inset-0 pointer-events-none" />
      <div ref={objectRef} className="absolute top-0 left-0 pointer-events-none will-change-transform" style={{ display: 'none' }}>
        {config.asset_url && !isGlbAsset(config) ? (
          <img src={config.asset_url} alt="" className="w-full h-full object-contain drop-shadow-2xl" />
        ) : !isGlbAsset(config) ? (
          <div className="w-full h-full rounded-full bg-emerald-400/80 border-2 border-white/70 shadow-[0_0_40px_rgba(16,185,129,0.7)]" />
        ) : null}
      </div>

      <div className="absolute top-0 inset-x-0 pt-[max(1rem,env(safe-area-inset-top))] px-4 flex items-center justify-between">
        <div className="rounded-xl bg-black/70 backdrop-blur px-3 py-2">
          <p className="text-sm font-bold leading-tight">{zone.title}</p>
          <p className="text-[11px] text-emerald-300">Camera view</p>
        </div>
        <button onClick={close} className="w-11 h-11 rounded-full bg-black/70 backdrop-blur flex items-center justify-center" aria-label="Close camera view">
          <X size={20} />
        </button>
      </div>

      {phase === 'intro' && (
        <div className="absolute inset-x-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-zinc-900/95 backdrop-blur p-5 shadow-2xl">
          <div className="flex items-center gap-3 mb-3"><Camera className="text-emerald-400" size={22} /><h2 className="font-bold">View in camera</h2></div>
          <p className="text-sm text-zinc-300 leading-relaxed">Open the camera to see this object placed in the world around you.</p>
          <button onClick={startCamera} className="w-full mt-4 py-3 rounded-xl bg-emerald-500 text-white font-bold active:opacity-80">Open camera</button>
        </div>
      )}

      {phase === 'calibrating' && (
        <div className="absolute inset-x-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-zinc-900/95 backdrop-blur p-5 shadow-2xl">
          <div className="flex items-center gap-3"><Compass className="text-emerald-400" size={22} /><div><h2 className="font-bold">Calibrating view</h2><p className="text-xs text-zinc-400 mt-0.5">Hold your phone flat for a moment.</p></div></div>
          <div className="h-1.5 rounded-full bg-zinc-700 overflow-hidden mt-4"><div className="h-full bg-emerald-400 transition-[width] duration-100" style={{ width: `${calibrationProgress * 100}%` }} /></div>
        </div>
      )}

      {phase === 'error' && (
        <div className="absolute inset-x-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-zinc-900/95 backdrop-blur p-5 shadow-2xl">
          <p className="text-sm text-zinc-200 leading-relaxed">{error || 'Camera view could not start.'}</p>
          <button onClick={() => setPhase('intro')} className="w-full mt-4 py-3 rounded-xl bg-zinc-700 text-white font-bold">Try again</button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-center pointer-events-none">
          <div className="rounded-full bg-black/65 backdrop-blur px-3 py-1.5 text-[11px] text-zinc-200">{config.behavior === 'flyover' ? 'Flyover active' : 'Object anchored'}</div>
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
