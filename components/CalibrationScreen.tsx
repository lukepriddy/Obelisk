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

/** Same file the Begin gesture plays, replayed on demand from here. */
const TONE_SRC = '/calibration-tone.m4a';

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
  /** Background audio prefetch, purely informational. Never gates.
   *  In practice this no longer fires: downloading is deferred to the "I'm
   *  ready" tap, so nothing is in flight while this screen is up, and the same
   *  counter appears over the map instead. Kept because it costs nothing and
   *  stays correct if prefetch ever moves earlier again. */
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
  const [showAudioHelp, setShowAudioHelp] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const mountedAt = useRef(Date.now());
  const [prefetchVisible, setPrefetchVisible] = useState(false);
  const releasedRef = useRef(false);
  const toneRef = useRef<HTMLAudioElement | null>(null);

  // A tap is its own gesture, so a fresh element is allowed to play even on
  // iOS. Reused across taps so rapid presses restart rather than overlap.
  const replayTone = () => {
    try {
      const tone = toneRef.current ?? new Audio(TONE_SRC);
      toneRef.current = tone;
      tone.volume = 0.7;
      tone.currentTime = 0;
      setReplaying(true);
      window.setTimeout(() => setReplaying(false), 1200);
      void tone.play().catch(() => setReplaying(false));
    } catch { setReplaying(false); }
  };

  useEffect(() => {
    const id = window.setInterval(() => setElapsed(Date.now() - mountedAt.current), 200);
    return () => window.clearInterval(id);
  }, []);

  const prefetchPending = Boolean(prefetch && prefetch.done < prefetch.total);

  // Only surface the counter once downloading has genuinely been pending for a
  // moment. Prefetch starts after the tone, and on a small tour it finishes
  // almost instantly, so the line flashed on and off too fast to read.
  // Depends on the boolean, NOT the prefetch object: the object's identity
  // changes on every progress tick, which would restart the timer forever and
  // mean the line never appeared at all on a slow download.
  useEffect(() => {
    if (!prefetchPending) { setPrefetchVisible(false); return; }
    const id = window.setTimeout(() => setPrefetchVisible(true), 600);
    return () => window.clearTimeout(id);
  }, [prefetchPending]);

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
    onReady();
  };

  // Deliberately no auto-release. An earlier version let returning players
  // straight through, which made the screen flash open and shut on a second
  // visit while zones were still downloading — and zones reload every time, so
  // "returning" buys nothing. Everyone gets the same beat and taps to start.

  const progress = radiusFor(accuracy);
  // Wide and uncertain down to tight and confident — but never to nothing.
  // A previous version settled at 0.08, which collapsed the whole composition
  // to a dot at exactly the moment it should feel resolved, and left the
  // screen looking empty. The locked size sits just inside where a good fix
  // lands, so the contraction still reads as the ring finding its answer.
  const ringScale = ready ? 0.52 : 0.55 + progress * 0.45;

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
      className="overlay-edge-bleed fixed inset-0 z-[2200] flex flex-col overflow-hidden md:justify-center"
      style={{ backgroundColor: bg, color: textColor, fontFamily }}
    >
      {/* Never scrolls. An earlier attempt at the too-short-viewport problem
          made this column scrollable, which was the wrong shape entirely: the
          primary button drifted below the fold, and the whole screen slid
          under a finger instead of sitting still.

          What actually has to be guaranteed is that the text and the button are
          on screen. The instrument does not: it is the one element that can
          spill past the edges and lose nothing, because it reads as a ring
          radiating outward either way. So the panel below is fixed, this region
          takes whatever height is left, and the rings are centred inside it and
          allowed to overflow — clipped by overflow-hidden rather than pushing
          anything off screen. */}
      <div className="relative flex-1 min-h-0 overflow-hidden md:flex-none md:overflow-visible">
        {/* Anchored to the BOTTOM of the region, not centred in it. Centring
            would let a short screen clip the status text along with the rings,
            and the text is the half that has to stay readable. Anchored here,
            the wording sits immediately above the fixed panel and never moves,
            while the rings extend upward from it and simply run off the top
            edge when there is not enough room.

            All of that is a phone problem. From md up there is height to spare,
            so the column returns to normal flow, the region stops stretching,
            and the root centres the whole composition instead of leaving it
            sitting on the floor of a tall window. Everything below md is
            untouched. */}
        <div
          className="absolute inset-x-0 bottom-0 mx-auto flex flex-col items-center px-8 text-center w-full max-w-sm md:static"
        >

        {/* An instrument coming into focus. Graduated rings counter-rotate
            while the fix is loose and halt on lock; the accuracy ring's radius
            tracks live GPS accuracy, so the centre of the image is still a
            picture of the real wait rather than a dressed-up bar.
            It deliberately HOLDS at full size when ready — an earlier version
            collapsed to a dot, which put the dullest frame at the climax. */}
        <div
          className="relative flex items-center justify-center"
          // Sized against width alone. It no longer needs a height cap: the
          // region clips it, so on a short screen it overflows the top rather
          // than shrinking or shoving the text down.
          style={{ width: 'min(19rem, 74vw)', aspectRatio: '1 / 1' }}
          aria-hidden="true"
        >
          {/* Outer graduation: sparse, slow, clockwise. */}
          <span
            className="absolute rounded-full"
            style={{
              width: '100%', height: '100%',
              border: `1px dashed ${accent}`,
              opacity: ready ? 0.42 : 0.2,
              animation: 'calibrate-spin 48s linear infinite',
              animationPlayState: ready ? 'paused' : 'running',
              transition: 'opacity 0.9s ease',
            }}
          />

          {/* Inner graduation: dense, faster, anticlockwise. The opposed
              directions are what make it read as an instrument rather than a
              loading spinner. */}
          <span
            className="absolute rounded-full"
            style={{
              width: '76%', height: '76%',
              border: `1px dashed ${accent}`,
              opacity: ready ? 0.3 : 0.14,
              animation: 'calibrate-spin-rev 29s linear infinite',
              animationPlayState: ready ? 'paused' : 'running',
              transition: 'opacity 0.9s ease',
            }}
          />

          {!ready && [0, 1, 2].map(i => (
            <span
              key={i}
              className="absolute rounded-full border"
              style={{
                width: '100%', height: '100%',
                borderColor: accent,
                animation: `calibrate-ripple 3.4s cubic-bezier(0.2,0.6,0.3,1) ${i * 1.13}s infinite`,
              }}
            />
          ))}

          {/* The accuracy ring — the honest part. */}
          <span
            className="absolute rounded-full border-2"
            style={{
              width: '100%', height: '100%',
              borderColor: accent,
              transform: `scale(${ringScale})`,
              opacity: ready ? 0.85 : 0.5,
              boxShadow: ready ? `0 0 40px -6px ${accent}` : 'none',
              transition: 'transform 1.4s cubic-bezier(0.2,0.6,0.3,1), opacity 0.8s ease, box-shadow 0.8s ease',
            }}
          />

          {/* Fires once on lock and travels out past everything. This is the
              moment the screen exists for; mounting it only when ready is what
              makes it play exactly once. */}
          {ready && (
            <span
              className="absolute rounded-full border-2"
              style={{
                width: '100%', height: '100%',
                borderColor: accent,
                animation: 'calibrate-lock 1.1s cubic-bezier(0.15,0.7,0.25,1) forwards',
              }}
            />
          )}

          {/* Soft body inside the ring, so the settled state has weight instead
              of being an outline around nothing. Two elements because the bloom
              keyframes animate `transform`, which would otherwise override the
              inline scale and detach the body from the ring it belongs to —
              the wrapper carries the radius, the child carries the breathing. */}
          <span
            className="absolute"
            style={{
              width: '100%', height: '100%',
              transform: `scale(${ringScale})`,
              transition: 'transform 1.4s cubic-bezier(0.2,0.6,0.3,1)',
            }}
          >
            <span
              className="absolute inset-0 rounded-full"
              style={{
                background: `radial-gradient(circle, ${accent}38 0%, ${accent}00 70%)`,
                opacity: ready ? 1 : 0.45,
                animation: ready ? 'calibrate-bloom 4.5s ease-in-out infinite' : 'none',
                transition: 'opacity 0.8s ease',
              }}
            />
          </span>

          <span
            className="absolute rounded-full"
            style={{
              width: 12, height: 12,
              backgroundColor: accent,
              boxShadow: `0 0 ${ready ? 34 : 20}px ${accent}`,
              transform: ready ? 'scale(1.15)' : 'scale(1)',
              transition: 'transform 0.7s cubic-bezier(0.2,0.6,0.3,1), box-shadow 0.8s ease',
            }}
          />
        </div>

        {/* Fixed height so a line appearing or disappearing cannot nudge the
            rings. Now 5.25rem rather than 7rem: the extra was reserved for the
            prefetch counter, which used to arrive partway through and leave
            again, and no longer runs during this screen at all. Downloading
            waits for the tap now, so the space it was holding was simply a gap.
            Still enough for the status line over a two-line subtitle, which is
            the tallest the wording gets ("Head to the starting point and open
            it again from there"). Because this column is anchored to the bottom
            of its region, shortening it lowers the rings by the same amount. */}
        <div className="mt-10 w-full max-w-xs flex flex-col items-center" style={{ minHeight: '5.25rem' }}>
          <p className="text-lg font-semibold">{statusLine}</p>

          {/* "Ready" over "give it a moment" read as the screen contradicting
              itself, so the line becomes the next instruction once it settles. */}
          <p className="mt-2 text-sm opacity-60 leading-relaxed">
            {tooFar
              ? 'Head to the starting point and open it again from there.'
              : ready
                ? 'Tap below when you want to start.'
                : 'Hold your phone up and give it a moment.'}
          </p>

          {prefetchVisible && prefetch && !tooFar && (
            <p className="mt-3 text-xs opacity-40 tabular-nums">
              Preparing audio {prefetch.done}/{prefetch.total}
            </p>
          )}
        </div>

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
      </div>

      <div
        className="shrink-0 px-8 pt-5 w-full max-w-sm mx-auto"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 28px)' }}
      >
        {/* The audio check. No API can answer this — on iOS the silent switch
            and system volume are both invisible to the page — so the only way
            to know is to ask. Being able to hear it again on demand is what
            turns that from a claim into something the player can verify. */}
        {!tooFar && (
          <div className="mb-6 text-center">
            {showAudioHelp && (
              <p className="text-sm leading-relaxed opacity-70 mb-3">
                Check the switch on the side of your phone — it silences audio even
                when the volume is up. Turn the volume up, then play it again.
              </p>
            )}

            <button
              type="button"
              onClick={replayTone}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border text-sm transition-opacity active:opacity-60"
              style={{ borderColor: `${textColor}26`, color: textColor, opacity: replaying ? 1 : 0.75 }}
            >
              <Volume2 size={15} style={{ color: replaying ? accent : undefined }} />
              {replaying ? 'Playing…' : 'Play the chime again'}
            </button>

            {!showAudioHelp && (
              <button
                type="button"
                onClick={() => setShowAudioHelp(true)}
                className="block mx-auto mt-2 text-xs underline opacity-45"
              >
                I didn’t hear anything
              </button>
            )}
          </div>
        )}

        <p className="text-[11px] leading-relaxed opacity-40 text-center mb-5">
          Stay aware of your surroundings. Watch for traffic, obey local laws,
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
        ) : (
          // Everyone taps to start, every time. The zones reload on each open,
          // so releasing returning players automatically only meant the screen
          // flashed past while audio was still downloading behind it.
          <button
            type="button"
            onClick={release}
            disabled={!ready}
            className="w-full py-4 rounded-2xl font-bold text-white transition-opacity disabled:opacity-30"
            style={{ backgroundColor: accent }}
          >
            {ready ? 'I’m ready' : 'Just a moment…'}
          </button>
        )}
      </div>
    </div>
  );
};
