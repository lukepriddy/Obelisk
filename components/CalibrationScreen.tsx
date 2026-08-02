import React, { useEffect, useRef, useState } from 'react';
import { Navigation, Volume2 } from 'lucide-react';

/**
 * The moment between tapping Begin and seeing the map.
 *
 * See docs/calibration-screen.md for why it exists and what the thresholds
 * mean. The short version: GPS needs a few seconds to converge, and revealing
 * the map before it does makes the dot lurch around in a way that reads as
 * broken software. This covers that with something honest to look at.
 *
 * It is a LAYER, not a step. `startAudio()` has already run inside the Begin
 * gesture by the time this mounts — restructuring that would lose iOS's audio
 * grant, which fails silently and only on real phones. This component never
 * touches audio start; it only plays the tone and watches numbers.
 */

/** The tone is audible for ~3.5s; revealing mid-ring feels like a mistake. */
const FLOOR_MS = 4000;
/** Past this, reveal regardless — see "Failure behaviour" in the doc. */
const CEILING_MS = 15000;
/** Tight enough that the dot won't visibly jump on reveal. */
const GOOD_ACCURACY_M = 25;
/** Beyond the tour's own footprint by this much and it isn't walkable now. */
const DISTANCE_MARGIN_M = 400;
const MIN_DISTANCE_GATE_M = 1600;

const HEARD_KEY = 'obelisk.audio.confirmed.v1';

export interface CalibrationScreenProps {
  accent: string;
  bg: string;
  textColor: string;
  fontFamily?: string;
  /** Live GPS accuracy in metres; null until the first fix lands. */
  accuracy: number | null;
  /** Metres from the player to the tour's start pin; null without a fix. */
  distanceToStart: number | null;
  /** Distance from the start to the outermost stop — sizes the distance gate. */
  furthestMeters: number;
  /** Background audio prefetch, purely informational. Never gates. */
  prefetch: { done: number; total: number } | null;
  /** True when geolocation failed outright — don't hold them here. */
  gpsUnavailable?: boolean;
  startLat: number;
  startLng: number;
  onReady: () => void;
  /** Return to the welcome screen. The only escape from the too-far state
   *  other than overriding it, so this screen is never a dead end. */
  onBack: () => void;
}

/** Accuracy spans ~1000m to ~5m, so a linear map sits pinned at the outer edge
 *  for almost the whole wait and then snaps. Log keeps the motion continuous. */
const radiusFor = (accuracy: number | null) => {
  if (accuracy == null) return 1;
  const clamped = Math.min(1000, Math.max(5, accuracy));
  return Math.min(1, Math.max(0, Math.log(clamped / 5) / Math.log(1000 / 5)));
};

export const CalibrationScreen: React.FC<CalibrationScreenProps> = ({
  accent, bg, textColor, fontFamily,
  accuracy, distanceToStart, furthestMeters, prefetch, gpsUnavailable,
  startLat, startLng, onReady, onBack,
}) => {
  const [elapsed, setElapsed] = useState(0);
  const [needsHeardConfirm] = useState(() => {
    try { return localStorage.getItem(HEARD_KEY) !== '1'; } catch { return false; }
  });
  const [showAudioHelp, setShowAudioHelp] = useState(false);
  const mountedAt = useRef(Date.now());
  const releasedRef = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed(Date.now() - mountedAt.current), 200);
    return () => window.clearInterval(id);
  }, []);

  const gate = Math.max(MIN_DISTANCE_GATE_M, furthestMeters + DISTANCE_MARGIN_M);
  const tooFar = distanceToStart != null && distanceToStart > gate;

  const floorDone = elapsed >= FLOOR_MS;
  const accurate = accuracy != null && accuracy <= GOOD_ACCURACY_M;
  const ceilingHit = elapsed >= CEILING_MS;
  // gpsUnavailable short-circuits the accuracy requirement: there will never be
  // a fix, and the welcome screen already surfaces that error properly.
  const settled = floorDone && (accurate || ceilingHit || gpsUnavailable);
  const ready = settled && !tooFar;

  const release = () => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    try { localStorage.setItem(HEARD_KEY, '1'); } catch { /* private mode */ }
    onReady();
  };

  // Auto-release only for returning players. First-timers confirm the tone by
  // hand, which is both the audio test and a deliberate start.
  useEffect(() => {
    if (ready && !needsHeardConfirm) release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, needsHeardConfirm]);

  const progress = radiusFor(accuracy);
  // 1 = wide and uncertain, 0 = locked on.
  const ringScale = ready ? 0.08 : 0.22 + progress * 0.78;

  // Ready has to win over the accuracy wording, or hitting the ceiling leaves
  // the screen saying "Finding your position" while the button is live —
  // which reads as the app contradicting itself.
  const statusLine = tooFar
    ? 'You’re too far from the start'
    : gpsUnavailable ? 'Starting without location'
    : ready ? 'Ready'
    : accuracy != null ? 'Finding your position'
    : 'Looking for satellites';

  return (
    <div
      className="overlay-edge-bleed fixed inset-0 z-[2200] flex flex-col"
      style={{ backgroundColor: bg, color: textColor, fontFamily }}
    >
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">

        {/* The rings are a picture of the actual wait: radius is driven by live
            accuracy, so it stalls when the fix stalls. Not a dressed-up bar. */}
        <div className="relative w-56 h-56 flex items-center justify-center" aria-hidden="true">
          {!ready && [0, 1, 2].map(i => (
            <span
              key={i}
              className="absolute rounded-full border"
              style={{
                width: '100%', height: '100%',
                borderColor: accent,
                animation: `calibrate-ripple 3s cubic-bezier(0.2,0.6,0.3,1) ${i * 1}s infinite`,
              }}
            />
          ))}

          <span
            className="absolute rounded-full border-2"
            style={{
              width: '100%', height: '100%',
              borderColor: accent,
              transform: `scale(${ringScale})`,
              opacity: ready ? 0.9 : 0.55,
              transition: 'transform 1.2s cubic-bezier(0.2,0.6,0.3,1), opacity 0.6s ease',
            }}
          />

          <span
            className="absolute rounded-full"
            style={{
              width: 14, height: 14,
              backgroundColor: accent,
              boxShadow: `0 0 24px ${accent}`,
              transform: ready ? 'scale(1.25)' : 'scale(1)',
              transition: 'transform 0.6s cubic-bezier(0.2,0.6,0.3,1)',
            }}
          />
        </div>

        <p className="mt-10 text-lg font-semibold">{statusLine}</p>

        <p className="mt-2 text-sm opacity-60 leading-relaxed max-w-xs">
          {tooFar
            ? 'Head to the starting point and open it again from there.'
            : 'Hold your phone up and give it a moment.'}
        </p>

        {prefetch && prefetch.done < prefetch.total && !tooFar && (
          <p className="mt-3 text-xs opacity-40 tabular-nums">
            Preparing audio {prefetch.done}/{prefetch.total}
          </p>
        )}

        {tooFar && (
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${startLat},${startLng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex items-center gap-2 text-sm font-bold"
            style={{ color: accent }}
          >
            <Navigation size={15} /> Directions to the start
          </a>
        )}
      </div>

      <div
        className="shrink-0 px-8"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 28px)' }}
      >
        {/* The audio check. No API can answer this — on iOS the silent switch
            and system volume are both invisible to the page — so the only way
            to know is to ask, and the only reasonable time is once. */}
        {needsHeardConfirm && !tooFar && (
          <div className="mb-6 text-center">
            {showAudioHelp ? (
              <div className="text-sm leading-relaxed opacity-70">
                <p className="font-semibold mb-1" style={{ color: textColor }}>No sound?</p>
                <p>Check the switch on the side of your phone — it silences audio
                   even when the volume is up. Then turn the volume up and tap below.</p>
              </div>
            ) : (
              <p className="text-sm opacity-70 flex items-center justify-center gap-2">
                <Volume2 size={15} /> You should have heard a soft chime
              </p>
            )}
            {!showAudioHelp && (
              <button
                type="button"
                onClick={() => setShowAudioHelp(true)}
                className="mt-1 text-xs underline opacity-50"
              >
                I didn’t hear anything
              </button>
            )}
          </div>
        )}

        <p className="text-[11px] leading-relaxed opacity-40 text-center mb-5">
          Stay aware of your surroundings — watch for traffic, obey local laws,
          and don’t enter private property. Locations are chosen by the creator
          of this experience. You take part at your own risk.
        </p>

        {tooFar ? (
          // Too far is never a dead end. Going back is the useful action from
          // ten miles away — the welcome screen has the description, the map and
          // the coordinates — but "go anyway" always stays available, because
          // someone about to drive there, or testing their own tour, knows more
          // about their situation than a radius check does.
          <div className="space-y-3">
            <button
              type="button"
              onClick={onBack}
              className="w-full py-4 rounded-2xl font-bold text-white"
              style={{ backgroundColor: accent }}
            >
              Back to the details
            </button>
            <button
              type="button"
              onClick={release}
              className="w-full py-2 text-sm font-semibold opacity-50"
              style={{ color: textColor }}
            >
              Go anyway
            </button>
          </div>
        ) : needsHeardConfirm ? (
          // Only first-timers get a button; returning players are released
          // automatically the moment the fix settles.
          <button
            type="button"
            onClick={release}
            disabled={!ready}
            className="w-full py-4 rounded-2xl font-bold text-white transition-opacity disabled:opacity-30"
            style={{ backgroundColor: accent }}
          >
            {ready ? 'I’m ready' : 'Just a moment…'}
          </button>
        ) : null}
      </div>
    </div>
  );
};
