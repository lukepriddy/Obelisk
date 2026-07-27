import React, { useRef } from 'react';

/**
 * Top-down placement pad for a static AR object. One direct-manipulation
 * control that replaces two confusing 0–359° sliders:
 *   • drag the object pin  → sets its ground offset (distance + bearing)
 *   • drag the facing arrow → sets which way it faces
 * Centred on the viewer, because in AR what matters is where the object sits
 * relative to where the player stands. The live "look up ≈ N°" readout warns
 * when the object is near-overhead, where azimuth is unstable and it swivels.
 */
interface ARPlacementPadProps {
  distance: number;   // ground_distance_m
  bearing: number;    // ground_bearing_degrees
  facing: number;     // facing_degrees
  altitude: number;   // altitude_m — feeds the viewing-angle readout
  maxDistance?: number;
  onChange: (updates: { ground_distance_m?: number; ground_bearing_degrees?: number; facing_degrees?: number }) => void;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinal = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const norm = (deg: number) => Math.round(((deg % 360) + 360) % 360);

const CX = 150;
const CY = 150;
const PAD_R = 120;

export const ARPlacementPad: React.FC<ARPlacementPadProps> = ({
  distance, bearing, facing, altitude, maxDistance = 60, onChange,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<'pin' | 'face' | null>(null);

  const pinXY = (): [number, number] => {
    const r = (Math.min(distance, maxDistance) / maxDistance) * PAD_R;
    return [CX + r * Math.sin(bearing * Math.PI / 180), CY - r * Math.cos(bearing * Math.PI / 180)];
  };

  const toLocal = (e: React.PointerEvent): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width * 300, (e.clientY - rect.top) / rect.height * 300];
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const [mx, my] = toLocal(e);
    if (dragRef.current === 'pin') {
      const dx = mx - CX;
      const dy = my - CY;
      const b = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
      const d = Math.min(maxDistance, Math.max(0, Math.hypot(dx, dy) / PAD_R * maxDistance));
      onChange({ ground_distance_m: Math.round(d), ground_bearing_degrees: Math.round(b) });
    } else {
      const [px, py] = pinXY();
      const f = ((Math.atan2(mx - px, -(my - py)) * 180 / Math.PI) + 360) % 360;
      onChange({ facing_degrees: Math.round(f) });
    }
  };

  const start = (which: 'pin' | 'face') => (e: React.PointerEvent) => {
    dragRef.current = which;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const end = () => { dragRef.current = null; };

  const [px, py] = pinXY();
  const fx = px + 30 * Math.sin(facing * Math.PI / 180);
  const fy = py - 30 * Math.cos(facing * Math.PI / 180);
  const viewAngle = distance < 0.5 ? 90 : Math.round(Math.atan2(altitude, distance) * 180 / Math.PI);
  const steep = viewAngle >= 80;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-bold text-zinc-400 uppercase">Placement</label>
        <button
          type="button"
          onClick={() => onChange({ facing_degrees: norm(bearing + 180) })}
          className="text-[10px] font-bold text-sky-400 hover:text-sky-300"
        >
          Aim at player
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox="0 0 300 300"
        className="w-full max-w-[280px] mx-auto block touch-none select-none rounded-xl bg-zinc-800"
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerLeave={end}
      >
        <circle cx={CX} cy={CY} r={PAD_R} fill="none" stroke="#3f3f46" strokeDasharray="3 4" />
        <circle cx={CX} cy={CY} r={70} fill="none" stroke="#27272a" strokeDasharray="2 5" />
        <text x={CX} y={20} textAnchor="middle" fill="#71717a" fontSize={11}>N</text>
        <text x={CX} y={292} textAnchor="middle" fill="#71717a" fontSize={11}>S</text>
        <text x={286} y={154} textAnchor="middle" fill="#71717a" fontSize={11}>E</text>
        <text x={14} y={154} textAnchor="middle" fill="#71717a" fontSize={11}>W</text>

        <line x1={CX} y1={CY} x2={px} y2={py} stroke="#3f3f46" />
        <circle cx={CX} cy={CY} r={9} fill="#3f3f46" stroke="#a1a1aa" />
        <circle cx={CX} cy={CY} r={2.5} fill="#a1a1aa" />
        <text x={CX} y={CY + 22} textAnchor="middle" fill="#a1a1aa" fontSize={10}>you</text>

        <line x1={px} y1={py} x2={fx} y2={fy} stroke="#fbbf24" strokeWidth={2.5} />
        <circle cx={fx} cy={fy} r={7} fill="#78350f" stroke="#fbbf24" strokeWidth={2} onPointerDown={start('face')} style={{ cursor: 'grab' }} />

        <circle cx={px} cy={py} r={13} fill="#0ea5e9" stroke="#fff" strokeWidth={2} onPointerDown={start('pin')} style={{ cursor: 'grab' }} />
        <text x={px} y={py + 4} textAnchor="middle" fill="#fff" fontSize={11} style={{ pointerEvents: 'none' }}>obj</text>
      </svg>

      <div className="mt-2 rounded-lg bg-zinc-800/60 px-3 py-2">
        <p className="text-sm font-semibold text-zinc-100">{Math.round(distance)} m to the {cardinal(bearing)}</p>
        <p className="text-xs text-zinc-400">Facing {cardinal(facing)} ({norm(facing)}°)</p>
        <p className={`text-xs mt-1 ${steep ? 'text-amber-400' : 'text-zinc-300'}`}>
          Players look up ≈ <span className="font-bold">{viewAngle}°</span>
        </p>
        {steep && (
          <p className="text-[11px] text-amber-400 mt-1">Nearly overhead — may swivel. Drag the object farther out.</p>
        )}
      </div>
    </div>
  );
};
