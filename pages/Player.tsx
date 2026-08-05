import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PlayerMap } from '../components/PlayerMap';
import { WelcomePreviewMap, WelcomePreviewHandle } from '../components/WelcomePreviewMap';
import { getTourById, getZonesByTourId, startSession, endSession, recordZoneVisit } from '../services/db';
import { audioService } from '../services/audioService';
import {
  canMeetProgressionRequirements,
  grantZoneRewards,
  hasProgressionRequirements,
  loadPlayerProgress,
  resetPlayerProgress,
  unlockProgressionZone,
} from '../services/progressionService';
import { getDistance, calculateAttenuation } from '../utils/geo';
import { trailStats, trailSummary, formatDistance } from '../utils/trail';
import { PLAYER_TERMS_VERSION } from '../constants/playerTerms';
import { PlayerProgress, ProgressionReward, Tour, Zone } from '../types';
import { FONT_STYLES, MAP_STYLES, DEFAULT_MAP_STYLE } from '../constants';
import { Loader2, PlayCircle, Volume2, MessageCircle, Lock, X, KeyRound, ChevronUp, Copy, Check, MapPin, ArrowLeft, Menu, Layers, Locate, RotateCcw, ZoomIn, ZoomOut, Backpack, Gem, Trash2, Info, RefreshCw, LogOut, Bug, Navigation, ChevronRight, Camera } from 'lucide-react';
import { ChatInterface } from '../components/ChatInterface';
import { ARCameraOverlay } from '../components/ARCameraOverlay';
import { CalibrationScreen } from '../components/CalibrationScreen';

// Player map style options, in selector order (Satellite HD default first).
const PLAYER_MAP_STYLE_ORDER = ['satellite-hd', 'satellite', 'voyager', 'dark', 'light', 'streets'] as const;

// Live layout-vs-visual viewport numbers, rendered inside Debug mode. Exists to
// turn "there's a hairline strip on the right" reports into exact figures: if
// innerWidth and visualViewport.width disagree (or scale ≠ 1), that delta IS
// the strip, and we know precisely how many px the edge-bleed must cover.
const ViewportStats: React.FC<{ labelColor: string; valueColor: string }> = ({ labelColor, valueColor }) => {
  const [, force] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    const bump = () => force(n => n + 1);
    vv?.addEventListener('resize', bump);
    vv?.addEventListener('scroll', bump);
    window.addEventListener('resize', bump);
    return () => {
      vv?.removeEventListener('resize', bump);
      vv?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
    };
  }, []);
  const vv = window.visualViewport;
  return (
    <>
      <span style={{ color: labelColor }}>Layout vw</span>
      <span className="text-right font-mono" style={{ color: valueColor }}>{window.innerWidth}px</span>
      <span style={{ color: labelColor }}>Visual vw</span>
      <span className="text-right font-mono" style={{ color: valueColor }}>
        {vv ? `${vv.width.toFixed(1)}px @${vv.scale.toFixed(3)}x ol:${vv.offsetLeft.toFixed(1)}` : 'n/a'}
      </span>
    </>
  );
};

/**
 * The blur behind a bottom sheet, as its own in-viewport layer.
 *
 * `backdrop-filter` samples the *backdrop root*, which is the viewport — but
 * `overlay-edge-bleed` deliberately pushes a surface 16px past both screen
 * edges, into a region with no backdrop to sample. Putting both on the same
 * element is undefined territory, and iOS Safari resolves it by leaving the
 * overhang unpainted on the first composite: a strip of sharp, undimmed map
 * down the right edge, which then disappears once the layer is warm and never
 * comes back that session. That "only the first time" signature is the tell.
 *
 * So the two jobs are split. The bled wrapper keeps the flat tint, where
 * overhanging is well-defined, and the blur lives here at a plain `inset-0`
 * where it always has something to sample. Same split as the AR overlay, for
 * the same underlying reason. See docs/mobile-player-edge-seams.md.
 *
 * Nothing behind this needs to react to it, and it must not swallow the
 * tap-to-dismiss on the wrapper, hence `pointer-events-none`.
 */
/** Length of public/calibration-tone.m4a, rounded up. Used to keep heavy
 *  background work off the audio path while the tone is still sounding. */
const TONE_DURATION_MS = 5000;

const SheetBlur: React.FC = () => (
  <div className="fixed inset-0 backdrop-blur-sm pointer-events-none" aria-hidden="true" />
);

/**
 * The strip of sheet colour that runs off both screen edges, behind the sheet.
 *
 * `overlay-edge-bleed` used to be carried by the sheet itself, which killed the
 * seam but cost the corners: a 40px radius on a surface hanging 16px past each
 * edge leaves only the shallow tail of the curve on screen — it starts to bend,
 * then the screen cuts it. (At the screen edge the card's top sits just 8px
 * below its flat top, so you see 24px of horizontal curve instead of 40px.)
 *
 * So the sheet now sits at true viewport width, where its corners render in
 * full, and this skirt takes over the overhang — starting *below* the corner
 * radius, so it never fills in the curve it exists to make visible. Every row
 * of the sheet body still has colour running past both edges; the only band
 * where iOS could expose a hairline is the corner band, where the map is
 * legitimately visible anyway and a gap reads as the corner rather than a seam.
 *
 * Same split as SheetBlur and the AR overlay: keep the bleed and the visible
 * shape on separate layers. See docs/mobile-player-edge-seams.md.
 *
 * Only below 512px (max-w-lg), where the sheet is genuinely full-width. Wider
 * than that it is a centred card with map either side, and a skirt would just
 * be a 16px ledge sticking out of it.
 */
const SheetSkirt: React.FC<{ color: string; radius?: number }> = ({ color, radius = 40 }) => (
  <div
    aria-hidden="true"
    className="hidden max-[512px]:block absolute left-[-16px] right-[-16px] bottom-0 pointer-events-none"
    style={{ top: radius, backgroundColor: color }}
  />
);

export const Player: React.FC = () => {
  const { tourId } = useParams<{ tourId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === '1';
  const gpsDebugEnabled = searchParams.get('debug') === 'gps';
  
  const [tour, setTour] = useState<Tour | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsDebugLog, setGpsDebugLog] = useState<string[]>([]);
  const [showGpsRetry, setShowGpsRetry] = useState(false);
  const [retryingGps, setRetryingGps] = useState(false);
  const [audioStarted, setAudioStarted] = useState(false);
  // Covers the map between Begin and a settled GPS fix. A layer, never a step
  // in front of startAudio() — see docs/calibration-screen.md.
  const [calibrating, setCalibrating] = useState(false);
  const [showAudioResume, setShowAudioResume] = useState(false);
  const [resumingAudio, setResumingAudio] = useState(false);
  // Background audio prefetch progress — null when idle/complete.
  const [prefetchStatus, setPrefetchStatus] = useState<{ done: number; total: number } | null>(null);
  const [bottomBarHeight, setBottomBarHeight] = useState(104);
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const [topBarHeight, setTopBarHeight] = useState(56);
  const topBarRef = useRef<HTMLDivElement | null>(null);
  const [simulationMode, setSimulationMode] = useState(isPreview);
  const [activeZones, setActiveZones] = useState<{id: string, title: string, volume: number, replayable: boolean}[]>([]);
  const [activeMediaZone, setActiveMediaZone] = useState<Zone | null>(null);
  const dismissedMediaZoneIdsRef = useRef<Set<string>>(new Set());
  // Map style — starts at the tour's chosen style, user can override in-session
  const [mapStyleOverride, setMapStyleOverride] = useState<string | null>(null);
  const [welcomeMapInteractive, setWelcomeMapInteractive] = useState(false);
  const welcomeMapRef = useRef<WelcomePreviewHandle | null>(null);
  const [showPlayerMenu, setShowPlayerMenu] = useState(false);
  const [playerMenuView, setPlayerMenuView] = useState<'main' | 'about' | 'progress'>('main');
  const [showDebug, setShowDebug] = useState(false);

  // Optional local-first progression
  const [playerProgress, setPlayerProgress] = useState<PlayerProgress | null>(null);
  const playerProgressRef = useRef<PlayerProgress | null>(null);
  const [showInventory, setShowInventory] = useState(false);

  // Character Interaction
  const [activeCharacterZone, setActiveCharacterZone] = useState<Zone | null>(null);

  // Set of zone ids currently "active" (playing / open) — drives the blue map
  // highlight. Memoised so PlayerMap only rebuilds when it actually changes.
  const activeZoneIds = useMemo(
    () => new Set<string>([
      ...activeZones.map(z => z.id),
      ...(activeCharacterZone ? [activeCharacterZone.id] : []),
    ]),
    [activeZones, activeCharacterZone],
  );
  // persistedCharacterZone keeps the last character zone so the chat
  // session (and history) survives briefly leaving the zone radius.
  const [persistedCharacterZone, setPersistedCharacterZone] = useState<Zone | null>(null);
  const persistedCharZoneRef = useRef<Zone | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [arCameraZone, setArCameraZone] = useState<Zone | null>(null);
  const [activeARZone, setActiveARZone] = useState<Zone | null>(null);
  // Incremented only when entering a *different* character zone, so the
  // ChatInterface re-mounts for a fresh session.  Re-entering the same
  // zone keeps history alive.
  const [chatKey, setChatKey] = useState(0);
  // Once the player opens chat for the first time in a zone session, we never
  // show the full character card again — only the circle.  Reset on new zone.
  const [chatEverOpened, setChatEverOpened] = useState(false);
  // Stickiness: delay clearing activeCharacterZone so brief exits don't
  // dismiss the "Talk to" button or break an open conversation.
  const charZoneExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref mirror of showChat so the interval callback (stale closure) can read
  // the current value without being listed as a dependency.
  const showChatRef = useRef(false);
  // Ref mirror of activeCharacterZone — lets the audio loop read the current
  // zone without depending on it (which would restart the interval on every entry/exit).
  const activeCharZoneRef = useRef<Zone | null>(null);

  // Map follow mode — set to false when user manually pans; "Follow" button restores it.
  const [followUser, setFollowUser] = useState(true);


  // Tour info sheet — two states so the CSS transition has a painted starting
  // point before it runs (avoids the mount-flash that animate-in causes).
  const [tourInfoMounted, setTourInfoMounted] = useState(false);
  const [tourInfoVisible, setTourInfoVisible] = useState(false);
  const [coordsCopied, setCoordsCopied] = useState(false);
  const sheetDragStartY = useRef<number>(0);

  const openTourInfo  = () => { setTourInfoMounted(true); requestAnimationFrame(() => setTourInfoVisible(true)); };
  const closeTourInfo = () => { setTourInfoVisible(false); setTimeout(() => setTourInfoMounted(false), 380); };
  const closePlayerMenu = () => {
    setShowPlayerMenu(false);
    window.setTimeout(() => setPlayerMenuView('main'), 250);
  };

  const exitExperience = () => {
    audioService.stopAll();
    setShowAudioResume(false);
    closePlayerMenu();
    setShowInventory(false);
    setShowChat(false);
    setArCameraZone(null);
    setShowDebug(false);
    setActiveZones([]);
    setActiveMediaZone(null);
    setActiveCharacterZone(null);
    activeCharZoneRef.current = null;
    setAudioStarted(false);
    setCalibrating(false);
    if (sessionIdRef.current) {
      endSession(sessionIdRef.current);
      sessionIdRef.current = null;
    }
  };

  const restartExperience = () => {
    if (!tour) return;
    if (!window.confirm('Start over? This clears visited zones, chats, items, and progress for this experience.')) return;

    zones.forEach(zone => {
      try { sessionStorage.removeItem(`obelisk_chat_${zone.id}`); } catch {}
    });
    try { if (tourId) localStorage.removeItem(`obelisk_zonestate_${tourId}`); } catch {}

    const emptySet = new Set<string>();
    visitedZoneIdsRef.current = emptySet;
    unlockedZoneIdsRef.current = new Set();
    prevZoneIdsRef.current = new Set();
    recordedVisitsRef.current = new Set();
    setVisitedZoneIds(emptySet);
    dismissedMediaZoneIdsRef.current = new Set();
    setPersistedCharacterZone(null);
    persistedCharZoneRef.current = null;
    setChatEverOpened(false);
    setChatKey(key => key + 1);
    setPassphraseChallenge(null);
    passphraseChallengeRef.current = null;
    setPassphraseInput('');
    setPassphraseError(false);

    if (tour.progression_enabled) {
      const reset = resetPlayerProgress(tour.id, tour.progression_resources || []);
      playerProgressRef.current = reset;
      setPlayerProgress(reset);
    }

    exitExperience();
  };

  // HUD notification
  const [hudNotification, setHudNotification] = useState<{ title: string; message: string; imageUrl?: string; featured?: boolean } | null>(null);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Passphrase challenge
  const [passphraseChallenge, setPassphraseChallenge] = useState<Zone | null>(null);
  const [passphraseInput, setPassphraseInput] = useState('');
  const [passphraseError, setPassphraseError] = useState(false);
  // Bumped after the keyboard is dismissed to REMOUNT the passphrase modal.
  // iOS can leave a fixed element painted a few px off after the keyboard
  // closes while every JS metric reads in-sync — recreating the element is the
  // one deterministic repaint. Also gates autoFocus so the remount doesn't
  // reopen the keyboard.
  const [lockNudge, setLockNudge] = useState(0);
  // A locked zone whose modal was dismissed while the player is still inside —
  // shown as a small tappable pill so they can reopen it without leaving.
  const [minimizedLock, setMinimizedLock] = useState<Zone | null>(null);
  const minimizedLockRef = useRef<Zone | null>(null);
  useEffect(() => { minimizedLockRef.current = minimizedLock; }, [minimizedLock]);

  // Zone state tracking. The ref feeds the audio loop while state redraws the
  // map immediately when a prerequisite zone becomes available.
  const [visitedZoneIds, setVisitedZoneIds] = useState<Set<string>>(new Set());
  const visitedZoneIdsRef = useRef<Set<string>>(new Set());
  const unlockedZoneIdsRef = useRef<Set<string>>(new Set());
  const prevZoneIdsRef = useRef<Set<string>>(new Set());
  // Discoverable zones have a second, smaller threshold (collect_radius) for
  // actual pickup, distinct from the outer radius used for the hint chime —
  // tracked separately so pickup fires once per crossing, not once per tick.
  const prevCollectZoneIdsRef = useRef<Set<string>>(new Set());
  // Serialized copy of the last activeZones payload. The 200ms loop builds a
  // fresh array every tick; without this comparison that meant a full Player
  // re-render (map included) five times a second even while standing still.
  const lastActiveZonesJsonRef = useRef('');
  const passphraseChallengeRef = useRef<Zone | null>(null);

  // Simulation ref to avoid state lag in drag handlers
  const simPosRef = useRef<[number, number] | null>(null);
  const gpsFixRef = useRef<{ pos: [number, number]; accuracy: number; timestamp: number } | null>(null);

  // Analytics: session ID for the current play; null in preview mode or before Begin.
  const sessionIdRef = useRef<string | null>(null);
  // Tracks which zone IDs have already been recorded this session so we don't double-count.
  const recordedVisitsRef = useRef<Set<string>>(new Set());
  // Swipe-up detection on bottom bar

  useEffect(() => {
    if (tourId) loadTour(tourId);
    return () => {
      audioService.stopAll();
      // Clear all timers so they don't fire against unmounted component state.
      if (hudTimerRef.current)          clearTimeout(hudTimerRef.current);
      if (charZoneExitTimerRef.current) clearTimeout(charZoneExitTimerRef.current);
      // End analytics session (best-effort — covers back-button and SPA navigation).
      if (sessionIdRef.current) endSession(sessionIdRef.current);
    };
  }, [tourId]);

  // Keep the ref in sync so the audio-loop closure always has the latest zone
  // without needing activeCharacterZone in the interval's dependency array.
  useEffect(() => { activeCharZoneRef.current = activeCharacterZone; }, [activeCharacterZone]);

  // Lock body scroll while the Player is mounted so iOS can't rubber-band
  // the page behind the fixed map UI. Restored on unmount.
  useEffect(() => {
    const body = document.body;
    const prev = { overflow: body.style.overflow, position: body.style.position, width: body.style.width };
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.width    = '100%';
    return () => {
      body.style.overflow = prev.overflow;
      body.style.position = prev.position;
      body.style.width    = prev.width;
    };
  }, []);

  // Keep the ref in sync so the interval callback always has the latest value
  useEffect(() => { showChatRef.current = showChat; }, [showChat]);

  // When the player closes chat while OUTSIDE the zone, give them a 10s
  // window (in case they want to re-enter), then clear the persisted zone.
  useEffect(() => {
    if (!showChat && activeCharacterZone === null && persistedCharacterZone) {
      const timer = setTimeout(() => {
        setPersistedCharacterZone(null);
        persistedCharZoneRef.current = null;
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [showChat, activeCharacterZone, persistedCharacterZone]);

  const showHud = (
    title: string,
    message: string,
    options?: { durationMs?: number; imageUrl?: string; featured?: boolean },
  ) => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    setHudNotification({
      title,
      message,
      imageUrl: options?.imageUrl,
      featured: options?.featured,
    });
    hudTimerRef.current = setTimeout(() => setHudNotification(null), options?.durationMs ?? 5000);
  };

  const appendGpsDebug = (message: string) => {
    if (!gpsDebugEnabled) return;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setGpsDebugLog(prev => [...prev.slice(-7), `${stamp} ${message}`]);
  };

  const applyGpsFix = (pos: GeolocationPosition) => {
    const newPos: [number, number] = [pos.coords.latitude, pos.coords.longitude];
    const accuracy = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : Infinity;
    const now = Date.now();
    const prev = gpsFixRef.current;
    appendGpsDebug(`fix accuracy=${Number.isFinite(accuracy) ? Math.round(accuracy) : 'unknown'}m`);

    // GPS often emits a stale coarse fix before the real high-accuracy fix.
    // Keep the best recent fix unless the new reading is comparable or the old
    // one is getting stale, so the marker does not jump to a worse location.
    const shouldAccept =
      !prev ||
      accuracy <= prev.accuracy * 1.35 ||
      now - prev.timestamp > 12000;

    if (!shouldAccept) return;

    let acceptedPos = newPos;
    if (prev) {
      const movement = getDistance(
        prev.pos[0],
        prev.pos[1],
        newPos[0],
        newPos[1],
      );
      const jitterRadius = Math.max(
        3,
        Math.min(prev.accuracy, accuracy) * 0.45,
      );

      // GPS fixes wander slightly even when the phone is stationary. Smooth
      // movement inside the current accuracy envelope while allowing larger,
      // deliberate movement to update immediately.
      if (movement < jitterRadius && now - prev.timestamp < 8000) {
        const smoothing = 0.22;
        acceptedPos = [
          prev.pos[0] + (newPos[0] - prev.pos[0]) * smoothing,
          prev.pos[1] + (newPos[1] - prev.pos[1]) * smoothing,
        ];
      }
    }

    gpsFixRef.current = { pos: acceptedPos, accuracy, timestamp: now };
    setUserPos(acceptedPos);
    setGpsAccuracy(Number.isFinite(accuracy) ? accuracy : null);
    simPosRef.current = acceptedPos;
    setGpsError(null);
    setShowGpsRetry(false);
    setRetryingGps(false);
  };

  const isZoneAccessible = (zone: Zone): boolean => {
    if (zone.requires_zone_id && !visitedZoneIdsRef.current.has(zone.requires_zone_id)) return false;
    if (zone.lock_type === 'passphrase' && !unlockedZoneIdsRef.current.has(zone.id)) return false;
    if (
      tour?.progression_enabled &&
      playerProgressRef.current &&
      !canMeetProgressionRequirements(zone, playerProgressRef.current)
    ) return false;
    return true;
  };

  // The audio loop remains the source of truth for activating zones. Keep a
  // direct render-time check for the optional camera affordance as well: a
  // fresh GPS position can paint the player dot before the next loop tick has
  // published `activeARZone`. This prevents a nearby camera object from
  // appearing to have no entry point during that brief state gap.
  const nearbyARZone = useMemo(() => {
    if (!audioStarted || !userPos) return null;

    const positionReliable =
      simulationMode || (gpsFixRef.current?.accuracy ?? Infinity) <= 100;
    if (!positionReliable) return null;

    return zones.find(zone => {
      if (!zone.ar_config?.enabled || !zone.ar_config.asset_url) return false;
      if (!isZoneAccessible(zone)) return false;
      return getDistance(userPos[0], userPos[1], zone.lat, zone.lng) < zone.radius;
    }) || null;
    // isZoneAccessible reads the current refs for visits, locks, and progress.
    // Those interactions also update component state, which refreshes this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioStarted, userPos, zones, simulationMode, tour, playerProgress]);

  const visibleARZone = activeARZone || nearbyARZone;

  // ── Zone-state persistence ─────────────────────────────────────────────────
  // Mobile browsers reclaim background tabs aggressively; without this, a
  // mid-tour refresh or tab kill re-locks every sequenced and passphrase zone
  // and the player would have to re-walk the route. Progression (currency /
  // items) already persists via progressionService — this covers the visited
  // and unlocked sets. Skipped in preview so creator test runs start fresh.
  const zoneStateStorageKey = (id: string) => `obelisk_zonestate_${id}`;

  const persistZoneState = () => {
    if (isPreview || !tourId) return;
    try {
      localStorage.setItem(zoneStateStorageKey(tourId), JSON.stringify({
        visited: [...visitedZoneIdsRef.current],
        unlocked: [...unlockedZoneIdsRef.current],
      }));
    } catch { /* storage unavailable — session still works, just not durable */ }
  };

  const markZoneVisited = (zoneId: string) => {
    if (visitedZoneIdsRef.current.has(zoneId)) return;
    const next = new Set([...visitedZoneIdsRef.current, zoneId]);
    visitedZoneIdsRef.current = next;
    setVisitedZoneIds(next);
    persistZoneState();
  };

  const applyProgressionForZone = (zone: Zone): ProgressionReward[] => {
    if (!tour?.progression_enabled || !playerProgressRef.current) return [];

    let next = playerProgressRef.current;
    if (hasProgressionRequirements(zone)) {
      next = unlockProgressionZone(zone, next);
    }
    const result = grantZoneRewards(zone, next);
    next = result.progress;
    playerProgressRef.current = next;
    setPlayerProgress(next);
    return result.granted;
  };

  const rewardMessage = (rewards: ProgressionReward[]) => {
    const resources = tour?.progression_resources || [];
    return rewards
      .map(reward => {
        const resource = resources.find(item => item.id === reward.resource_id);
        return resource ? `+${reward.amount} ${resource.name}` : '';
      })
      .filter(Boolean)
      .join(' · ');
  };

  const completeZoneEntry = (zone: Zone) => {
    markZoneVisited(zone.id);
    const rewards = applyProgressionForZone(zone);
    const messages = [
      zone.type !== 'character' ? zone.entry_message : '',
      rewardMessage(rewards),
    ].filter(Boolean);
    if (messages.length > 0) {
      const isDiscoverable = zone.type === 'discoverable';
      showHud(zone.title, messages.join('\n'), {
        durationMs: isDiscoverable || rewards.length > 0 ? 8000 : 5000,
        imageUrl: isDiscoverable ? zone.zone_image_url : undefined,
        featured: isDiscoverable && !!zone.zone_image_url,
      });
    }
  };

  const handlePassphraseSubmit = () => {
    const zone = passphraseChallenge;
    if (!zone) return;
    const correct = (zone.lock_passphrase || '').trim().toLowerCase();
    if (passphraseInput.trim().toLowerCase() === correct) {
      unlockedZoneIdsRef.current = new Set([...unlockedZoneIdsRef.current, zone.id]);
      persistZoneState();
      if (zone.type !== 'discoverable') {
        completeZoneEntry(zone);
      }
      passphraseChallengeRef.current = null;
      setPassphraseChallenge(null);
      setMinimizedLock(null);
      setPassphraseInput('');
      setPassphraseError(false);
    } else {
      setPassphraseError(true);
    }
  };

  // Audio Engine Loop
  useEffect(() => {
    // Held while the calibration screen is up. audioStarted flips inside the
    // Begin tap — it has to, for iOS's audio grant — so without this a player
    // standing inside a zone hears it start behind the calibration screen and
    // then walks into an experience already mid-sentence.
    if (calibrating) return;
    if (!audioStarted || !userPos || zones.length === 0) return;

    const interval = setInterval(() => {
      const currentPos = simPosRef.current || userPos;
      // Zone events need a trustworthy position. The coarse network fix that
      // unsticks Chrome's "Waiting for GPS signal" hang can be off by a
      // kilometer — good enough to show the marker and unlock Begin, not good
      // enough to fire zones, grant rewards, or record visits. Until accuracy
      // tightens, treat the player as outside every zone (audio fades out via
      // the normal exit path). Simulation coordinates are always exact.
      const positionReliable =
        simulationMode || (gpsFixRef.current?.accuracy ?? Infinity) <= 100;
      const audioUpdates: {
        id: string;
        volume: number;
        loop?: boolean;
        destroyOnEnd?: boolean;
        exitBehavior?: 'stop' | 'pause' | 'keep';
        fadeIn?: number;
        fadeOut?: number;
      }[] = [];
      const activeState: { id: string; title: string; volume: number; replayable: boolean }[] = [];
      let foundCharZone: Zone | null = null;
      let foundMediaZone: Zone | null = null;
      let foundARZone: Zone | null = null;
      const currentZoneIds = new Set<string>();
      const currentCollectZoneIds = new Set<string>();

      zones.forEach(zone => {
        const dist = getDistance(currentPos[0], currentPos[1], zone.lat, zone.lng);
        // Hysteresis: easier in than out. GPS wobbles a few meters even while
        // standing still, so a player parked on the boundary would otherwise
        // flap in/out — restarting 'stop'-mode audio from the top each flap.
        // Once inside, the player doesn't count as "out" until they're a
        // margin BEYOND the edge (4–12 m, scaled to the zone's size).
        const wasInside = prevZoneIdsRef.current.has(zone.id);
        const exitMargin = Math.max(4, Math.min(12, zone.radius * 0.15));
        const effectiveRadius = zone.radius + (wasInside ? exitMargin : 0);
        const insideZone = dist < effectiveRadius;
        const prereqMet = !zone.requires_zone_id || visitedZoneIdsRef.current.has(zone.requires_zone_id);
        const progressionMet =
          !tour?.progression_enabled ||
          !playerProgressRef.current ||
          canMeetProgressionRequirements(zone, playerProgressRef.current);

        if (positionReliable && insideZone && prereqMet && progressionMet) {
          currentZoneIds.add(zone.id);

          // Zone entry event
          if (!prevZoneIdsRef.current.has(zone.id)) {
            const isLocked = zone.lock_type === 'passphrase' && !unlockedZoneIdsRef.current.has(zone.id);

            if (isLocked && prereqMet) {
              // Only show passphrase modal if none is already shown
              if (!passphraseChallengeRef.current) {
                passphraseChallengeRef.current = zone;
                setLockNudge(0);
                setPassphraseChallenge(zone);
              }
            } else if (prereqMet && zone.type !== 'discoverable') {
              // Discoverables grant on crossing the smaller collect_radius,
              // handled separately below — not on the outer hint radius.
              completeZoneEntry(zone);
            }

            // Analytics: record first visit to each zone (once per session).
            if (sessionIdRef.current && !recordedVisitsRef.current.has(zone.id) && tourId) {
              recordedVisitsRef.current.add(zone.id);
              recordZoneVisit(sessionIdRef.current, zone.id, tourId);
            }
          }

          // Only activate zone if it's accessible
          if (isZoneAccessible(zone)) {
            if (!foundARZone && zone.ar_config?.enabled && zone.ar_config.asset_url) {
              foundARZone = zone;
            }
            if (zone.type === 'character') {
              foundCharZone = zone;
            } else if (zone.type !== 'discoverable') {
              // Discoverables intentionally produce no "Now Playing" card and
              // no media-zone card — the hint plays silently, pickup is instant.
              if (
                !foundMediaZone &&
                (zone.zone_image_url || (!zone.media_url && zone.description)) &&
                !dismissedMediaZoneIdsRef.current.has(zone.id)
              ) {
                foundMediaZone = zone;
              }
              if (zone.media_url) {
                const zoneVolume = Math.min(1, Math.max(0, Number(zone.volume ?? 1.0)));
                let volume = zone.use_attenuation
                  // effectiveRadius (not radius): inside the hysteresis band
                  // attenuation must stay above the engine's exit threshold.
                  ? calculateAttenuation(dist, effectiveRadius)
                  : 1.0;
                volume = volume * zoneVolume;
                activeState.push({
                  id: zone.id,
                  title: zone.title,
                  volume: Math.min(100, Math.round(volume * 100)),
                  // A non-looping track that already finished can be replayed from the card.
                  replayable: zone.on_end !== 'loop' && audioService.hasFinished(zone.id),
                });
              }
            }
          }
        }

        // Discoverables reuse the exact same attenuation pipeline as audio
        // zones for their hint chime — the outer `radius` is the "you're
        // getting warm" boundary. Once collected, force volume to 0 (still
        // included every tick so the existing fade-out actually runs).
        const discoverableCollected =
          zone.type === 'discoverable' &&
          !!playerProgressRef.current?.granted_zone_ids.includes(zone.id);

        if (zone.type === 'audio' || zone.type === 'discoverable') {
          let volume = 0;
          if (positionReliable && !discoverableCollected && insideZone && isZoneAccessible(zone)) {
            const zoneVolume = Math.min(1, Math.max(0, Number(zone.volume ?? 1.0)));
            volume = zone.use_attenuation ? calculateAttenuation(dist, effectiveRadius) : 1.0;
            volume = volume * zoneVolume;
          }
          audioUpdates.push({
            id: zone.id,
            volume,
            loop: zone.on_end === 'loop',
            destroyOnEnd: zone.on_end === 'destroy',
            exitBehavior: zone.on_exit,
            fadeIn: zone.fade_in,
            fadeOut: zone.fade_out,
          });
        }

        // Pickup: crossing the inner collect_radius (defaults to the outer
        // radius when unset), independent of the outer-radius "entry" event
        // above — a discoverable has two meaningful thresholds where every
        // other zone type has one.
        if (positionReliable && zone.type === 'discoverable' && !discoverableCollected && isZoneAccessible(zone)) {
          const collectRadius = zone.collect_radius ?? zone.radius;
          if (dist <= collectRadius) {
            currentCollectZoneIds.add(zone.id);
            if (!prevCollectZoneIdsRef.current.has(zone.id)) {
              completeZoneEntry(zone);
            }
          }
        }
      });

      prevCollectZoneIdsRef.current = currentCollectZoneIds;

      // Left a locked zone (modal open or minimized pill) → clear it so the ref
      // resets and re-entry prompts again cleanly.
      const lockedZone = passphraseChallengeRef.current || minimizedLockRef.current;
      if (lockedZone && !currentZoneIds.has(lockedZone.id)) {
        passphraseChallengeRef.current = null;
        setPassphraseChallenge(null);
        setMinimizedLock(null);
      }

      prevZoneIdsRef.current = currentZoneIds;
      dismissedMediaZoneIdsRef.current = new Set(
        [...dismissedMediaZoneIdsRef.current].filter(id => currentZoneIds.has(id))
      );
      audioService.updateVolumes(audioUpdates);
      // If an interruption latch is blocking audio a zone wants RIGHT NOW,
      // surface the tap-to-resume banner — regardless of how the interruption
      // happened (backgrounding between zones, Siri, alarm, declined call).
      // Previously the banner only appeared if audio was mid-playback at
      // background time, so the next zone could stay silent with no way out.
      // A zone can be visual-only (for example an AR object) and therefore
      // contributes a volume update without an actual media element. Only
      // surface audio recovery when something playable is in Now Playing.
      // Otherwise the no-audio zone repeatedly shows then immediately hides
      // the recovery card, which also obscures its camera prompt.
      if (audioService.isInterruptionPaused() && activeState.length > 0) {
        setShowAudioResume(true);
      }
      // Only push new state when the payload actually changed — volumes are
      // rounded to whole percent, so this is stable while standing still.
      const activeStateJson = JSON.stringify(activeState);
      if (activeStateJson !== lastActiveZonesJsonRef.current) {
        lastActiveZonesJsonRef.current = activeStateJson;
        setActiveZones(activeState);
      }
      setActiveMediaZone(foundMediaZone);
      setActiveARZone(foundARZone);

      if (foundCharZone?.id !== activeCharZoneRef.current?.id) {
        if (foundCharZone) {
          // Entered a character zone — apply immediately, cancel any exit timer
          if (charZoneExitTimerRef.current) {
            clearTimeout(charZoneExitTimerRef.current);
            charZoneExitTimerRef.current = null;
          }
          setActiveCharacterZone(foundCharZone);

          // If this is a DIFFERENT zone from what's persisted, start a fresh session
          if (persistedCharZoneRef.current?.id !== foundCharZone.id) {
            // Clear the old zone's saved chat history so it doesn't bleed through
            if (persistedCharZoneRef.current?.id) {
              try { sessionStorage.removeItem(`obelisk_chat_${persistedCharZoneRef.current.id}`); } catch {}
            }
            persistedCharZoneRef.current = foundCharZone;
            setPersistedCharacterZone(foundCharZone);
            setChatKey(k => k + 1);
            setShowChat(false);
            setChatEverOpened(false);
          }
        } else {
          // Left the zone.
          if (showChatRef.current) {
            // Mid-conversation — never auto-dismiss while the player is engaged.
            // Cancel any pending exit timer so it doesn't fire mid-chat.
            if (charZoneExitTimerRef.current) {
              clearTimeout(charZoneExitTimerRef.current);
              charZoneExitTimerRef.current = null;
            }
          } else if (!charZoneExitTimerRef.current) {
            // Not chatting and no timer running — start one.
            // We deliberately do NOT restart the timer if it's already running so
            // that rapid drag events in sim mode can't keep resetting the window.
            charZoneExitTimerRef.current = setTimeout(() => {
              setActiveCharacterZone(null);
              charZoneExitTimerRef.current = null;
              // persistedCharacterZone lives on for 10 more seconds (see useEffect)
              // so re-entry within that window continues the conversation.
            }, 12000);
          }
        }
      }
    }, 200);

    return () => {
      clearInterval(interval);
      // Intentionally do NOT clear charZoneExitTimerRef here — the timer must
      // survive interval restarts that happen when userPos changes (sim dragging).
    };
    // activeCharacterZone intentionally excluded — we read it via activeCharZoneRef
    // so the interval doesn't restart on every zone entry/exit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioStarted, calibrating, userPos, zones, tour, simulationMode]);

  // Safari audio remains intentionally paused after backgrounding or locking.
  // When the player returns, wait for an explicit tap before rebuilding and
  // restarting active zone audio.
  useEffect(() => {
    if (!audioStarted) return;
    let interruptedActiveAudio = false;

    const showRecoveryWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!interruptedActiveAudio) {
        // Nothing audible was interrupted (phone pocketed between zones —
        // the common case on a walking tour). Try a silent recovery so the
        // NEXT zone can play without a tap; if the context refuses to resume
        // without a gesture, the geofencing loop will surface the tap-to-
        // resume banner the moment a zone actually needs it.
        void audioService.clearInterruptionIfIdle();
        return;
      }
      interruptedActiveAudio = false;
      setShowAudioResume(true);
    };

    const markBackgrounded = () => {
      interruptedActiveAudio =
        interruptedActiveAudio || audioService.hasActiveAudio();
      audioService.prepareForInterruption();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        markBackgrounded();
        return;
      }
      showRecoveryWhenVisible();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', markBackgrounded);
    window.addEventListener('pageshow', showRecoveryWhenVisible);
    window.addEventListener('focus', showRecoveryWhenVisible);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', markBackgrounded);
      window.removeEventListener('pageshow', showRecoveryWhenVisible);
      window.removeEventListener('focus', showRecoveryWhenVisible);
    };
  }, [audioStarted]);

  // Keep the screen awake during an active experience — screen sleep is the
  // single biggest source of audio interruptions on a walking tour. The OS
  // releases the lock automatically on backgrounding; re-acquire when visible.
  // Unsupported browsers (or denied requests) fail silently and change nothing.
  useEffect(() => {
    if (!audioStarted) return;
    let lock: { release?: () => Promise<void> } | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const wakeLock = (navigator as any).wakeLock;
        if (!wakeLock?.request) return;
        const acquired = await wakeLock.request('screen');
        if (cancelled) { void acquired?.release?.(); return; }
        lock = acquired;
      } catch { /* low battery, unsupported, or denied — non-fatal */ }
    };

    void acquire();
    const reacquireWhenVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', reacquireWhenVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', reacquireWhenVisible);
      try { void lock?.release?.(); } catch { /* already released */ }
    };
  }, [audioStarted]);

  useEffect(() => {
    if (!audioStarted || !bottomBarRef.current) return;

    const bottomBar = bottomBarRef.current;
    const updateBottomBarHeight = () => {
      setBottomBarHeight(Math.ceil(bottomBar.getBoundingClientRect().height));
    };

    updateBottomBarHeight();
    const observer = new ResizeObserver(updateBottomBarHeight);
    observer.observe(bottomBar);
    window.addEventListener('resize', updateBottomBarHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBottomBarHeight);
    };
  }, [audioStarted]);

  // Measure the top bar (its height varies with the safe-area inset) so the map
  // can be inset to sit exactly below it — see the map wrapper.
  useEffect(() => {
    if (!topBarRef.current) return;
    const topBar = topBarRef.current;
    const update = () => setTopBarHeight(Math.ceil(topBar.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(topBar);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [audioStarted]);

  useEffect(() => {
    if (showAudioResume && activeZones.length === 0) setShowAudioResume(false);
  }, [showAudioResume, activeZones.length]);

  useEffect(() => {
    if (!showAudioResume) return;
    const timer = window.setTimeout(() => {
      // Never auto-dismiss while the latch is still blocking wanted audio —
      // the loop would re-show it anyway; avoid the 12s flicker.
      if (!audioService.isInterruptionPaused()) setShowAudioResume(false);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [showAudioResume]);

  const handleTappedAudioResume = async () => {
    if (resumingAudio) return;
    setShowAudioResume(false);
    setResumingAudio(true);
    const recovered = await audioService.restartActiveAudioFromBeginning();
    setResumingAudio(false);
    if (!recovered) setShowAudioResume(true);
  };

  // GPS Watcher
  useEffect(() => {
    if (simulationMode) return;
    if (!navigator.geolocation) {
      setGpsError('Location is not available in this browser.');
      appendGpsDebug('geolocation unavailable');
      return;
    }

    appendGpsDebug('starting geolocation');
    const retryTimer = window.setTimeout(() => {
      if (!gpsFixRef.current) {
        appendGpsDebug('no gps callback after 8s');
        setShowGpsRetry(true);
      }
    }, 8000);

    // Tiered acquisition. Chrome on phones can stall indefinitely on a fresh
    // high-accuracy request — maximumAge: 0 forbids returning the cached
    // last-known position, and when the provider stalls the timeout clock
    // never runs, so NEITHER callback fires and the player is stuck on
    // "Waiting for GPS signal". This cache-friendly low-accuracy request
    // nearly always answers within a couple of seconds and unsticks the UI;
    // the high-accuracy watch below then refines it. applyGpsFix already
    // prefers better-accuracy fixes, so a coarse fix never overwrites a good
    // one — and zone triggers are separately gated on accuracy, so a
    // kilometer-off network fix can't fire zones.
    navigator.geolocation.getCurrentPosition(
      pos => {
        appendGpsDebug('coarse fix success');
        applyGpsFix(pos);
      },
      err => {
        appendGpsDebug(`coarse fix error code=${err.code}`);
      },
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 8000 }
    );

    navigator.geolocation.getCurrentPosition(
      pos => {
        appendGpsDebug('getCurrentPosition success');
        applyGpsFix(pos);
      },
      err => {
        appendGpsDebug(`getCurrentPosition error code=${err.code}`);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
    );

    // The continuous watch is wrapped in a restartable helper because iOS
    // Safari sometimes silently kills watchPosition after the page has been
    // backgrounded — position freezes and zones stop triggering with no error.
    // We re-arm it on every return to foreground, plus a watchdog restarts it
    // if fixes go stale while the page is visible.
    let watchId: number | null = null;
    const startWatch = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = navigator.geolocation.watchPosition(
        pos => {
          appendGpsDebug('watchPosition success');
          applyGpsFix(pos);
        },
        (err) => {
          console.error(err);
          appendGpsDebug(`watchPosition error code=${err.code}`);
          if (err.code === err.PERMISSION_DENIED) {
            setGpsError('Location access was denied. Please enable location services and reload to play this experience.');
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            setGpsError('Your location could not be determined. Please check your GPS signal and try again.');
          } else if (err.code === err.TIMEOUT) {
            setGpsError('GPS is taking too long. Try stepping outside or checking your location settings.');
          } else {
            setGpsError('Could not get your location. Please check your device settings and try again.');
          }
        },
        // maximumAge 3000: a three-second-old fix is identical at walking speed,
        // and allowing it avoids Chrome's pathological fresh-fix-only path.
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
      );
    };
    startWatch();

    const rearmOnForeground = () => {
      if (document.visibilityState !== 'visible') return;
      appendGpsDebug('foreground — re-arming watch');
      startWatch();
    };
    document.addEventListener('visibilitychange', rearmOnForeground);
    window.addEventListener('pageshow', rearmOnForeground);

    const staleWatchdog = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const last = gpsFixRef.current;
      if (last && Date.now() - last.timestamp > 30000) {
        appendGpsDebug('fixes stale >30s while visible — restarting watch');
        startWatch();
      }
    }, 15000);

    return () => {
      window.clearTimeout(retryTimer);
      window.clearInterval(staleWatchdog);
      document.removeEventListener('visibilitychange', rearmOnForeground);
      window.removeEventListener('pageshow', rearmOnForeground);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [simulationMode]);

  const retryGpsFromTap = () => {
    if (!navigator.geolocation || retryingGps) return;
    setRetryingGps(true);
    setGpsError(null);
    appendGpsDebug('manual retry tapped');

    let settled = false;
    let manualRetryTimeout: number;
    const finishRetry = (keepRetryVisible: boolean) => {
      if (settled) return false;
      settled = true;
      window.clearTimeout(manualRetryTimeout);
      setRetryingGps(false);
      setShowGpsRetry(keepRetryVisible);
      return true;
    };

    manualRetryTimeout = window.setTimeout(() => {
      if (!finishRetry(true)) return;
      appendGpsDebug('manual retry no callback after 15s');
      setGpsError('Chrome did not return a GPS response. Try Safari, or reset Chrome location permission and reload.');
    }, 15000);

    // Cache-friendly coarse request in parallel — the same escape hatch the
    // startup path uses, since the retry previously re-issued the exact
    // fresh-high-accuracy request that was already hanging. First callback
    // wins via the settled flag; a coarse failure stays silent so the
    // high-accuracy request below drives any error message.
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (!finishRetry(false)) return;
        appendGpsDebug('manual retry coarse success');
        applyGpsFix(pos);
      },
      err => {
        appendGpsDebug(`manual retry coarse error code=${err.code}`);
      },
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 8000 }
    );

    navigator.geolocation.getCurrentPosition(
      pos => {
        if (!finishRetry(false)) return;
        appendGpsDebug('manual retry success');
        applyGpsFix(pos);
      },
      err => {
        if (!finishRetry(true)) return;
        appendGpsDebug(`manual retry error code=${err.code}`);
        if (err.code === err.PERMISSION_DENIED) {
          setGpsError('Location access was denied. Please enable location services and reload to play this experience.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setGpsError('Your location could not be determined. Please check your GPS signal and try again.');
        } else if (err.code === err.TIMEOUT) {
          setGpsError('GPS is taking too long. Try stepping outside or checking your location settings.');
        } else {
          setGpsError('Could not get your location. Please check your device settings and try again.');
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
    );
  };

  const loadTour = async (id: string) => {
   try {
    const t = await getTourById(id);
    if (!t) { setNotFound(true); setLoading(false); return; }
    setTour(t);
    if (t.progression_enabled) {
      const progress = loadPlayerProgress(t.id, t.progression_resources || []);
      playerProgressRef.current = progress;
      setPlayerProgress(progress);
    } else {
      playerProgressRef.current = null;
      setPlayerProgress(null);
    }
    const z = await getZonesByTourId(id);
    setZones(z);

    // Restore visited/unlocked state from a previous session on this device,
    // pruned to zones that still exist (creator may have edited the tour).
    if (!isPreview) {
      try {
        const raw = localStorage.getItem(zoneStateStorageKey(id));
        if (raw) {
          const saved = JSON.parse(raw) as { visited?: string[]; unlocked?: string[] };
          const zoneIds = new Set(z.map(zone => zone.id));
          const visited = new Set((saved.visited ?? []).filter(zid => zoneIds.has(zid)));
          const unlocked = new Set((saved.unlocked ?? []).filter(zid => zoneIds.has(zid)));
          visitedZoneIdsRef.current = visited;
          unlockedZoneIdsRef.current = unlocked;
          setVisitedZoneIds(visited);
        }
      } catch { /* corrupted saved state falls back to a fresh run */ }
    }

    // In preview/sim mode seed position at the tour start point.
    // In GPS mode leave userPos null — the watchPosition callback will set it
    // once the device gets a real fix, preventing fake zone triggers.
    if (isPreview) {
      setUserPos([t.lat, t.lng]);
      simPosRef.current = [t.lat, t.lng];
    }

    setLoading(false);
   } catch (e) {
    // Any unexpected load failure resolves into the "not found" state instead of
    // hanging forever on "Loading Experience…".
    console.error('loadTour failed:', e);
    setNotFound(true);
    setLoading(false);
   }
  };

  const startAudio = async () => {
    setShowAudioResume(false);
    // Both of these must happen inside the gesture. The tone doubles as the
    // audio test and as iOS's unlock; deferring it past an await would lose
    // the grant, which fails silently and only on real phones.
    setCalibrating(true);
    try {
      const tone = new Audio('/calibration-tone.m4a');
      tone.volume = 0.7;
      void tone.play().catch(() => { /* a test, not a gate */ });
    } catch { /* ditto */ }
    // Create and silently prime media elements inside the Begin gesture so the
    // first real zone playback is less likely to be blocked or routed badly.
    zones
      .filter(z => z.type === 'audio' || z.type === 'discoverable')
      .forEach(z => audioService.loadAudio(z.id, z.media_url));

    // Kick the audio engine off inside the Begin gesture, but DON'T await it
    // before showing the experience — that wait (up to 1.5s) is what made the
    // button feel like it hung. The engine warms up behind the map; the 2s
    // zone entry delay covers the rest, and updateVolumes no-ops until unlocked.
    void Promise.race([
      audioService.init().then(() => audioService.primeLoadedAudio()),
      new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
    ]).catch(() => { /* non-fatal — tap-to-resume covers a failed unlock */ });

    setAudioStarted(true);

    // Middle-ground prefetch: begin fully downloading every zone's audio in
    // the background, nearest to the start point first, WITHOUT blocking the
    // walk. Zones reached before their download finishes stream as before;
    // everything else becomes immune to cellular dead spots.
    if (tour) {
      const ordered = zones
        .filter(z => (z.type === 'audio' || z.type === 'discoverable') && z.media_url)
        .sort((a, b) =>
          getDistance(tour.lat, tour.lng, a.lat, a.lng) - getDistance(tour.lat, tour.lng, b.lat, b.lng))
        .map(z => z.id);
      // Held back until the calibration tone has finished. Downloading and
      // decoding every zone's audio at once is heavy enough to make a
      // concurrently playing element stutter, which is why the blips were
      // audible on a first open and never on a replay — by then this has
      // already run. Nothing depends on prefetch starting promptly: zones
      // reached before their download finishes simply stream, exactly as they
      // did before prefetch existed.
      window.setTimeout(() => {
        void audioService.prefetchAll(ordered, (done, total) => {
          setPrefetchStatus(total > 0 && done < total ? { done, total } : null);
        });
      }, TONE_DURATION_MS);
    }

    // Start analytics session — skip in preview mode so creator test-runs don't pollute data.
    if (!isPreview && tour?.id) {
      startSession(tour.id, PLAYER_TERMS_VERSION).then(id => { sessionIdRef.current = id; });
    }
  };

  if (notFound) return (
    <div className="flex flex-col h-screen items-center justify-center bg-zinc-950 px-6 text-center gap-4">
      <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
        <MapPin size={28} className="text-zinc-600" />
      </div>
      <h2 className="text-white font-bold text-lg">Experience not found</h2>
      <p className="text-zinc-500 text-sm max-w-xs leading-relaxed">
        This experience may have been removed or made private. Check your link and try again.
      </p>
      <button
        onClick={() => navigate(-1 as any)}
        className="mt-1 px-6 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl font-semibold text-sm transition-colors"
      >
        Go Back
      </button>
    </div>
  );

  if (loading || !tour) return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 text-white">
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        <span className="text-sm text-zinc-400">Loading Experience…</span>
      </div>
    </div>
  );

  // ── Player theme tokens ───────────────────────────────────────────────────
  // Welcome screen always uses the tour's own bg/text/accent colors.
  // Everything else (bars, cards, sheet, HUD) uses these fixed theme tokens so
  // a bad tour color choice can never break the player chrome.
  const isDark  = (tour.player_theme || 'dark') === 'dark';
  const accent  = tour.accent_color || '#10b981';
  // The welcome and calibration screens use the tour's own colours, but until
  // now they fell back to a hardcoded dark when none were set — so choosing the
  // light theme changed the chrome and left those two screens black. An accent
  // would apply while the theme appeared to do nothing. Explicit colours still
  // win; only the fallback follows the theme.
  // Scrim behind the bottom sheets. Dark mode dims; light mode does not.
  //
  // The dim used to apply in both themes, on the reasoning that the scrim's
  // contrast partner is the sheet rather than the page. That holds in the
  // abstract and looked wrong in practice: the top bar is opaque and sits
  // *under* the sheet overlay, so the dim landed on it too and turned a white
  // bar grey — a hard two-tone band across the top of a light-themed screen,
  // white sheet below, grey chrome above.
  //
  // Light mode now leans on blur alone for separation, which does the same job
  // (kills detail behind the sheet) without changing anyone's luminance, so the
  // bar keeps its colour and the screen reads as one surface. Dark mode is
  // unchanged — a dim over dark chrome was never the problem.
  const scrim = isDark ? 'bg-black/60' : '';
  const scrimStrong = isDark ? 'bg-black/70' : '';
  const themedBg   = tour.bg_color   || (isDark ? '#09090b' : '#fafaf9');
  const themedText = tour.text_color || (isDark ? '#ffffff' : '#0f172a');
  const th = {
    // Top / bottom bars + all slide-up sheets share this dark surface (#09090b),
    // so header, footer, and every sheet are one seamless colour. Only the small
    // pill/floating elements use the lighter grey (cardBg / zinc-900) to stand
    // out against it.
    barBg:       isDark ? '#09090b'              : '#ffffff',
    barBorder:   isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    barText:     isDark ? '#ffffff'              : '#09090b',
    barMuted:    isDark ? '#71717a'              : '#52525b',
    // Floating cards (Now Playing, Character card)
    cardBg:      isDark ? 'rgba(24,24,27,0.95)' : 'rgba(255,255,255,0.95)',
    cardBorder:  isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
    cardText:    isDark ? '#ffffff'              : '#09090b',
    cardMuted:   isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)',
    // Info sheet — same dark surface as the bars (see barBg note).
    sheetBg:     isDark ? '#09090b'              : '#ffffff',
    sheetText:   isDark ? '#ffffff'              : '#09090b',
    sheetMuted:  isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)',
    sheetHandle: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
    sheetBorder: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    // HUD
    hudBg:       isDark ? 'rgba(24,24,27,0.96)' : 'rgba(255,255,255,0.96)',
    hudText:     isDark ? '#ffffff'              : '#09090b',
  };

  // Top bar height constant (used to offset floating elements)
  const TOP_BAR = 56; // px, matches h-14

  // In GPS mode userPos is null until the device gets a fix.
  // Use the tour start point as the map center fallback so Leaflet never crashes.
  const mapCenter: [number, number] = userPos ?? [tour.lat, tour.lng];

  return (
    <div className="h-full relative bg-zinc-950 overflow-hidden">

      {/* ── MAP (MapLibre) ── */}
      {/* Inset to sit exactly BETWEEN the top and bottom bars rather than edge to
          edge. The bars are opaque, so the area under them showed nothing anyway —
          but keeping the WebGL canvas out from under them is what eliminates the
          Safari-only bright hairline at the bars' edges (no overlap = nothing for
          Safari's compositor to leak). Kept mounted but hidden until Begin so it
          can pre-warm tiles. */}
      <div
        className="absolute left-0 right-0"
        style={{
          top: `${topBarHeight}px`,
          bottom: `${bottomBarHeight}px`,
          visibility: audioStarted ? 'visible' : 'hidden',
        }}
      >
        <PlayerMap
          tour={tour}
          zones={zones}
          activeZoneIds={activeZoneIds}
          visitedZoneIds={visitedZoneIds}
          playerProgress={playerProgress}
          userPos={userPos}
          gpsAccuracy={gpsAccuracy}
          styleKey={mapStyleOverride || tour.map_style || DEFAULT_MAP_STYLE}
          simulationMode={simulationMode}
          followUser={followUser}
          onDragAway={() => setFollowUser(false)}
          onSimMove={(pos) => { setUserPos(pos); simPosRef.current = pos; }}
        />
      </div>

      {/* ── WELCOME SCREEN (z-2000, covers map + bars) ── */}
      {/* Sits above the map but below chat and the AR view, so it covers the
          lurching dot without ever trapping a player under a later overlay. */}
      {calibrating && tour && (
        <CalibrationScreen
          accent={tour.accent_color || '#10b981'}
          bg={themedBg}
          textColor={themedText}
          fontFamily={FONT_STYLES[tour.font_style || 'sans']?.fontFamily}
          accuracy={gpsFixRef.current?.accuracy ?? null}
          distanceToStart={userPos ? getDistance(userPos[0], userPos[1], tour.lat, tour.lng) : null}
          furthestMeters={trailStats(tour, zones).furthestMeters}
          prefetch={prefetchStatus}
          gpsUnavailable={Boolean(gpsError) || simulationMode}
          startLat={tour.lat}
          startLng={tour.lng}
          onReady={() => setCalibrating(false)}
          onBack={() => { setCalibrating(false); exitExperience(); }}
        />
      )}

      {!audioStarted && tour && (() => {
        const bg         = themedBg;
        const accent     = tour.accent_color || '#10b981';
        const textColor  = themedText;
        const fontFamily = FONT_STYLES[tour.font_style || 'sans']?.fontFamily;

        const copyCoords = () => {
          navigator.clipboard.writeText(`${tour.lat.toFixed(6)}, ${tour.lng.toFixed(6)}`);
          setCoordsCopied(true);
          setTimeout(() => setCoordsCopied(false), 2000);
        };

        return (
          <div
            className="overlay-edge-bleed fixed inset-0 z-[2000] flex flex-col overflow-hidden"
            style={{ backgroundColor: bg, fontFamily }}
          >
            {/* ── HEADER — natural height, flex shrink-0 ── */}
            <div
              className="shrink-0 text-center"
              style={{
                backgroundColor: bg,
                paddingTop: 'calc(env(safe-area-inset-top, 0px) + 24px)',
                paddingBottom: '16px',
              }}
            >
              <div className="w-full max-w-sm mx-auto px-5">
                <h1 className="text-3xl font-bold leading-tight" style={{ color: textColor }}>{tour.title}</h1>
                {tour.welcome_subtitle && (
                  <p className="text-base font-medium mt-1.5" style={{ color: accent }}>{tour.welcome_subtitle}</p>
                )}
                {/* Distance, shape and time, before anyone commits. Someone
                    deciding what to do with an afternoon needs this here, not
                    after they've started walking. */}
                {(() => {
                  const summary = trailSummary(trailStats(tour, zones), tour.duration_minutes);
                  return summary ? (
                    <p className="text-xs mt-2 opacity-60" style={{ color: textColor }}>{summary}</p>
                  ) : null;
                })()}
              </div>
            </div>

            {/* ── SCROLL AREA — takes all remaining space between header and footer ── */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ scrollbarWidth: 'none', overscrollBehavior: 'none' }}
            >
              <div className="w-full max-w-sm mx-auto px-5 flex flex-col items-center text-center gap-5 py-4">

                {tour.welcome_image_url && (
                  <img src={tour.welcome_image_url} alt={tour.title} className="w-40 h-40 object-cover rounded-2xl" />
                )}

                {/* Someone who opened a shared link from another town needs to
                    be told so. Without this the welcome screen looks identical
                    whether you're standing at the start or three states away,
                    and the first sign anything is wrong is a map where nothing
                    ever triggers. The threshold is generous — under a mile is a
                    walk, and saying "you're 400 ft away" would be noise. */}
                {(() => {
                  if (!userPos) return null;
                  const away = getDistance(userPos[0], userPos[1], tour.lat, tour.lng);
                  if (!Number.isFinite(away) || away < 1600) return null;
                  return (
                    <div className="w-full rounded-xl border border-white/10 p-4 text-left" style={{ backgroundColor: `${textColor}0d` }}>
                      <p className="text-sm font-semibold" style={{ color: textColor }}>
                        You're {formatDistance(away)} away
                      </p>
                      <p className="text-xs opacity-70 mt-1 leading-relaxed" style={{ color: textColor }}>
                        This one happens at a specific place — you'll need to be there for it
                        to play. Keep the link, or get directions to the starting point.
                      </p>
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${tour.lat},${tour.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold"
                        style={{ color: accent }}
                      >
                        <Navigation size={13} /> Directions to the start
                      </a>
                    </div>
                  );
                })()}

                {tour.description && (
                  <p className="text-sm leading-relaxed opacity-80 w-full whitespace-pre-wrap" style={{ color: textColor, textAlign: tour.description_align === 'left' ? 'left' : 'center' }}>{tour.description}</p>
                )}

                <div className="relative w-full aspect-[4/3] max-h-[240px] rounded-xl overflow-hidden border border-white/10">
                  <WelcomePreviewMap
                    ref={welcomeMapRef}
                    lat={tour.lat}
                    lng={tour.lng}
                    zoom={tour.start_zoom ?? 18}
                    styleKey={tour.map_style || DEFAULT_MAP_STYLE}
                    interactive={welcomeMapInteractive}
                  />
                  {!welcomeMapInteractive ? (
                    <button
                      type="button"
                      onClick={() => setWelcomeMapInteractive(true)}
                      className="absolute inset-0 z-[500] flex items-center justify-center bg-black/5 active:bg-black/10"
                      aria-label="Explore map"
                    >
                      <span className="rounded-full px-3 py-1.5 text-xs font-semibold backdrop-blur-md border border-white/15 shadow-lg" style={{ backgroundColor: `${bg}cc`, color: textColor }}>
                        Tap to explore map
                      </span>
                    </button>
                  ) : (
                    <>
                      <div
                        className="absolute top-2 left-2 z-[500] flex flex-col overflow-hidden rounded-lg backdrop-blur-md border border-white/15 shadow-lg"
                        style={{ backgroundColor: `${bg}dd`, color: textColor }}
                      >
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); welcomeMapRef.current?.zoomIn(); }}
                          className="w-11 h-11 flex items-center justify-center active:bg-white/15"
                          aria-label="Zoom in"
                          title="Zoom in"
                        >
                          <ZoomIn size={20} />
                        </button>
                        <div className="h-px bg-white/15" />
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); welcomeMapRef.current?.zoomOut(); }}
                          className="w-11 h-11 flex items-center justify-center active:bg-white/15"
                          aria-label="Zoom out"
                          title="Zoom out"
                        >
                          <ZoomOut size={20} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setWelcomeMapInteractive(false)}
                        className="absolute top-2 right-2 z-[500] rounded-full px-3 py-1.5 text-xs font-semibold backdrop-blur-md border border-white/15 shadow-lg"
                        style={{ backgroundColor: `${bg}dd`, color: textColor }}
                      >
                        Done
                      </button>
                    </>
                  )}
                </div>

                <button
                  onClick={copyCoords}
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-medium border border-white/10 transition-colors"
                  style={{ color: coordsCopied ? accent : textColor }}
                >
                  {coordsCopied
                    ? <span key="copied" className="flex items-center justify-center gap-2 w-full"><Check size={14} /> Copied!</span>
                    : <span key="coords" className="flex items-center justify-center gap-2 w-full"><Copy size={14} /> Copy start coordinates</span>}
                </button>

                <p className="text-xs opacity-40" style={{ color: textColor }}>Headphones are recommended.</p>

              </div>
            </div>

            {/* ── FOOTER — natural height, flex shrink-0 ── */}
            <div
              className="shrink-0"
              style={{
                backgroundColor: bg,
                paddingTop: '12px',
                paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
              }}
            >
              <div className="w-full max-w-sm mx-auto px-5 flex flex-col gap-3">
                {gpsError && (
                  <div className="w-full rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300 leading-snug text-center">
                    {gpsError}
                  </div>
                )}
                {!isPreview && !userPos && !gpsError && (
                  <div className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-center gap-2 text-sm" style={{ color: textColor }}>
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin opacity-60" />
                    <span className="opacity-60">Waiting for GPS signal…</span>
                  </div>
                )}
                {!isPreview && !userPos && showGpsRetry && (
                  <button
                    type="button"
                    onClick={retryGpsFromTap}
                    disabled={retryingGps}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold transition-colors active:opacity-70 disabled:opacity-50"
                    style={{ color: textColor }}
                  >
                    {retryingGps ? 'Checking GPS...' : 'Still waiting? Retry GPS'}
                  </button>
                )}
                <button
                  onClick={startAudio}
                  disabled={!isPreview && !userPos}
                  className="flex items-center justify-center gap-2 text-white w-full py-4 rounded-2xl text-lg font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: accent }}
                >
                  <PlayCircle size={22} /> Begin
                </button>

                {/* Assent sits directly against Begin, because that is the
                    action it refers to and proximity is what makes a clickwrap
                    notice count for anything. Kept to one line: the full safety
                    text is on the calibration screen a moment later, and a wall
                    of text here would be scrolled past rather than read. */}
                <p
                  className="text-[11px] leading-relaxed text-center px-1"
                  style={{ color: textColor, opacity: 0.5 }}
                >
                  By tapping Begin you confirm you are 13 or older and agree to
                  the{' '}
                  <a
                    href="/player-terms"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                    style={{ color: accent, opacity: 0.9 }}
                  >
                    terms for playing
                  </a>
                  , including that you take part at your own risk.
                </p>

                {/* The real-world safety notice moved to the calibration screen.
                    As background text here it was wallpaper people scrolled
                    past; shown at the moment of commitment, after Begin, it is
                    a beat they actually read — and this screen gets its space
                    back. Still shown before anyone walks anywhere. */}
                {/* Players never sign up, so this is the only place they can
                    reach the privacy policy — and the app reads their GPS. */}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="block text-[11px] text-center underline underline-offset-2"
                  style={{ color: textColor, opacity: 0.4 }}
                >
                  How your location is used
                </a>
              </div>
            </div>
          </div>
        );
      })()}

      {gpsDebugEnabled && (
        <div className="fixed left-3 right-3 top-3 z-[6000] pointer-events-none">
          <div className="mx-auto max-w-sm rounded-2xl border border-amber-500/40 bg-zinc-950/90 px-3 py-2 text-[11px] text-amber-100 shadow-2xl backdrop-blur-md">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-bold uppercase tracking-wider text-amber-300">GPS Debug</span>
              <span className="font-mono text-amber-200/70">{userPos ? `${userPos[0].toFixed(5)}, ${userPos[1].toFixed(5)}` : 'no fix'}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-amber-100/80">
              <span>Geolocation</span><span className="text-right">{navigator.geolocation ? 'available' : 'missing'}</span>
              <span>Accuracy</span><span className="text-right">{gpsAccuracy ? `${Math.round(gpsAccuracy)}m` : '—'}</span>
              <span>Error</span><span className="text-right truncate">{gpsError || 'none'}</span>
            </div>
            {/* ── AR trigger diagnostic — spells out why (or why not) the
                 "Camera object nearby" card resolves, so field testing doesn't
                 devolve into guesswork. Only rendered under ?debug=gps. ── */}
            {(() => {
              const arZones = zones.filter(z => z.ar_config?.enabled && z.ar_config.asset_url);
              const withDist = userPos
                ? arZones.map(z => ({ z, d: getDistance(userPos[0], userPos[1], z.lat, z.lng) })).sort((a, b) => a.d - b.d)
                : [];
              const nearest = withDist[0];
              const reliable = simulationMode || (gpsFixRef.current?.accuracy ?? Infinity) <= 100;
              return (
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-amber-500/30 pt-1.5 text-amber-100/80">
                  <span>Started</span><span className="text-right">{audioStarted ? 'yes' : 'NO — tap Begin'}</span>
                  <span>AR zones w/ asset</span><span className="text-right">{arZones.length}</span>
                  {nearest ? (<>
                    <span>Nearest AR zone</span><span className="text-right truncate">{nearest.z.title || '(untitled)'}</span>
                    <span>Distance / radius</span><span className={`text-right ${nearest.d < nearest.z.radius ? 'text-emerald-300' : 'text-red-300'}`}>{Math.round(nearest.d)}m / {nearest.z.radius}m</span>
                    <span>Pos reliable</span><span className={`text-right ${reliable ? '' : 'text-red-300'}`}>{reliable ? 'yes' : 'NO (>100m)'}</span>
                    <span>Accessible</span><span className={`text-right ${isZoneAccessible(nearest.z) ? '' : 'text-red-300'}`}>{isZoneAccessible(nearest.z) ? 'yes' : 'NO (gated)'}</span>
                  </>) : (<><span>Nearest AR zone</span><span className="text-right text-red-300">{userPos ? 'none in tour' : 'no fix'}</span></>)}
                  <span>Card resolves</span><span className={`text-right font-bold ${visibleARZone ? 'text-emerald-300' : 'text-red-300'}`}>{visibleARZone ? 'YES' : 'no'}</span>
                </div>
              );
            })()}
            <div className="mt-1.5 space-y-0.5 font-mono text-[10px] text-amber-100/70">
              {gpsDebugLog.length > 0 ? gpsDebugLog.map((line, index) => <div key={index}>{line}</div>) : <div>waiting for geolocation events</div>}
            </div>
          </div>
        </div>
      )}

      {/* ── TOUR INFO SHEET — smooth CSS transition ── */}
      {/* absolute (not fixed) so the dimming scrim shares the map's exact box.
          The map is `absolute inset-0` in this same player root; a `fixed`
          scrim resolves to the viewport instead, and on iOS those two boxes
          disagree by a pixel or two — the map used to peek past the scrim's
          right edge. Sharing the root's coordinate system removes the gap. */}
      {tourInfoMounted && tour && (
        <div
          className="overlay-edge-bleed fixed inset-0 z-[2000] flex items-end justify-center px-4 md:px-0"
          style={{
            // Was a hardcoded rgba(0,0,0,0.55) — the one sheet that ignored the
            // theme entirely, so on a light tour it dropped a near-black wash
            // over the white top bar while every other sheet used the (lighter)
            // themed scrim. Now it follows the same rule as the rest.
            backgroundColor: isDark ? 'rgba(0,0,0,0.55)' : 'transparent',
            opacity: tourInfoVisible ? 1 : 0,
            transition: 'opacity 0.3s',
          }}
          onClick={closeTourInfo}
        >
          {/* This sheet was also the only one without the blur, so in light mode
              — where the dim is now gone — it would have had no separation from
              the map at all. */}
          <SheetBlur />
          <div
            className="relative z-10 -mb-px w-full max-w-lg"
            style={{
              transform: tourInfoVisible ? 'translateY(0)' : 'translateY(100%)',
              transition: 'transform 0.38s cubic-bezier(0.32, 0.72, 0, 1)',
            }}
          >
          <SheetSkirt color={th.sheetBg} />
          <div
            className="relative w-full flex flex-col rounded-t-[40px] shadow-2xl"
            style={{
              backgroundColor: th.sheetBg,
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => { sheetDragStartY.current = e.touches[0].clientY; }}
            onTouchEnd={(e) => {
              if (e.changedTouches[0].clientY - sheetDragStartY.current > 60) closeTourInfo();
            }}
          >
            {/* Handle */}
            <div className="flex flex-col items-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full" style={{ backgroundColor: th.sheetHandle }} />
            </div>

            <div className="px-8 pt-3 pb-6 flex flex-col gap-4">
              {/* Header — mirrors the welcome screen's centred stack. It used to
                  be a left-aligned avatar+title row sitting above a centred
                  description, which read as the title being skewed left. The
                  close button is absolute so it can't offset the centring. */}
              <div className="relative flex flex-col items-center text-center gap-3">
                <button
                  onClick={closeTourInfo}
                  className="absolute -top-1 -right-2 p-1.5 rounded-full"
                  style={{ color: th.sheetMuted }}
                  aria-label="Close details"
                >
                  <X size={18} />
                </button>
                {tour.welcome_image_url && (
                  <img
                    src={tour.welcome_image_url}
                    alt=""
                    className="w-20 h-20 object-cover rounded-2xl shadow-lg"
                  />
                )}
                <div className="min-w-0 w-full">
                  <h2 className="font-bold text-xl leading-tight break-words" style={{ color: th.sheetText }}>{tour.title}</h2>
                  {tour.welcome_subtitle && (
                    <p className="text-sm mt-1" style={{ color: accent }}>{tour.welcome_subtitle}</p>
                  )}
                </div>
              </div>

              {/* Description */}
              {tour.description && (
                <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: th.sheetMuted, textAlign: tour.description_align === 'left' ? 'left' : 'center' }}>
                  {tour.description}
                </p>
              )}

              {/* Coordinates */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${tour.lat.toFixed(6)}, ${tour.lng.toFixed(6)}`);
                  setCoordsCopied(true);
                  setTimeout(() => setCoordsCopied(false), 2500);
                }}
                className="flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-medium border"
                style={{
                  borderColor: th.sheetBorder,
                  color: coordsCopied ? accent : th.sheetMuted,
                }}
              >
                {coordsCopied
                  ? <span key="copied" className="flex items-center justify-center gap-2 w-full"><Check size={14} /> Copied!</span>
                  : <span key="coords" className="flex items-center justify-center gap-2 w-full"><MapPin size={14} /> {tour.lat.toFixed(5)}, {tour.lng.toFixed(5)}</span>}
              </button>
            </div>
          </div>
          </div>
        </div>
      )}

      {/* ── FLOATING PANEL — Now Playing + Character card, centered above bottom bar ── */}
      {/* While chat is open: hidden on mobile (chat is full-screen), kept visible on
          desktop anchored bottom-left so it never collides with the chat panel (bottom-right) */}
      {audioStarted && (
        <div
          className={`fixed z-[1500] flex-col items-end gap-2 w-full max-w-sm px-4 ${
            showChat ? 'hidden md:flex left-2' : 'flex left-1/2 -translate-x-1/2'
          }`}
          style={{
            bottom: `${bottomBarHeight + 12}px`,
            maxHeight: `calc(100dvh - ${bottomBarHeight + 84}px)`,
          }}
        >
          {/* ── Character presence ─────────────────────────────────────────────
               Two states, one design language:
               • First entry (chatEverOpened=false): compact encounter card
               • After first chat (chatEverOpened=true): ambient presence orb
               Both use a pulsing ring to signal the character is "alive".
               Hidden entirely while the chat is open — redundant next to it.  */}
          {showChat ? null : activeCharacterZone && chatEverOpened ? (
            /* ── Ambient orb — appears after first conversation ── */
            <button
              onClick={() => setShowChat(true)}
              className="self-end flex flex-col items-center gap-1.5 animate-in zoom-in-75 duration-300"
              aria-label={`Continue with ${activeCharacterZone.title}`}
            >
              <div className="relative shrink-0" style={{ width: 80, height: 80 }}>
                {/* Pulsing outer ring — "the being is present" */}
                <span
                  className="absolute inset-0 rounded-full animate-ping"
                  style={{ backgroundColor: accent, opacity: 0.25, animationDuration: '2.5s' }}
                />
                {/* Character artwork sits on an opaque card surface so the
                    minimized control remains clearly tappable over any map. */}
                <div
                  className="absolute inset-0 rounded-full overflow-hidden shadow-2xl flex items-center justify-center"
                  style={{ backgroundColor: isDark ? '#18181b' : '#ffffff', boxShadow: `0 0 20px ${accent}45` }}
                >
                  {activeCharacterZone.character_image_url
                    ? <img src={activeCharacterZone.character_image_url} alt={activeCharacterZone.title} className="w-[70%] h-[70%] object-contain" />
                    : <div className="w-full h-full flex items-center justify-center"><MessageCircle size={22} color={accent} /></div>
                  }
                </div>
              </div>
            </button>

          ) : activeCharacterZone ? (
            /* ── Encounter card — first appearance in zone ── */
            <div
              className="w-full max-h-full rounded-2xl animate-in slide-in-from-bottom-4 duration-400 flex flex-col overflow-hidden"
              style={{
                backgroundColor: th.cardBg,
                border: `1px solid ${accent}40`,
                backdropFilter: 'blur(20px)',
                boxShadow: `0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px ${accent}20`,
              }}
            >
              {/* Avatar + pulse ring */}
              <div className="flex flex-col items-center pt-6 pb-2 min-h-0">
                <div className="relative mb-3 shrink-0" style={{ width: 88, height: 88 }}>
                  <span
                    className="absolute inset-0 rounded-full animate-ping"
                    style={{ backgroundColor: accent, opacity: 0.2, animationDuration: '2.5s' }}
                  />
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ filter: `drop-shadow(0 0 12px ${accent}35)` }}
                  >
                    {activeCharacterZone.character_image_url
                      ? <img src={activeCharacterZone.character_image_url} alt={activeCharacterZone.title} className="w-full h-full object-contain" />
                      : <div className="w-full h-full flex items-center justify-center"><MessageCircle size={26} color={accent} /></div>
                    }
                  </div>
                </div>
                <h3 className="font-bold text-base tracking-tight" style={{ color: th.cardText }}>
                  {activeCharacterZone.title}
                </h3>
                {(activeCharacterZone.character_bio || activeCharacterZone.description) && (
                  <p className="text-xs mt-1.5 text-center px-6 leading-relaxed overflow-y-auto min-h-0 overscroll-contain" style={{ color: th.cardMuted }}>
                    {activeCharacterZone.character_bio || activeCharacterZone.description}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="px-4 pt-2 pb-5 flex gap-2 shrink-0">
                <button
                  onClick={() => setChatEverOpened(true)}
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-opacity active:opacity-60"
                  style={{ backgroundColor: `${accent}20`, border: `1px solid ${accent}40` }}
                  aria-label="Dismiss"
                >
                  <X size={14} color={accent} />
                </button>
                <button
                  onClick={() => { setChatEverOpened(true); setShowChat(true); }}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 active:opacity-80 transition-opacity"
                  style={{ backgroundColor: accent, boxShadow: `0 2px 16px ${accent}55` }}
                >
                  <MessageCircle size={15} color="white" />
                  <span className="text-white">{activeCharacterZone.title}</span>
                </button>
                {activeCharacterZone.ar_config?.enabled && (
                  <button
                    onClick={() => setArCameraZone(activeCharacterZone)}
                    className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-opacity active:opacity-60"
                    style={{ backgroundColor: `${accent}20`, border: `1px solid ${accent}40` }}
                    aria-label="View in camera"
                    title="View in camera"
                  >
                    <Camera size={15} color={accent} />
                  </button>
                )}
              </div>
            </div>
          ) : null}

          {/* Media-zone content — additive to the existing audio card. */}
          {activeMediaZone && (
            <div
              className="w-full rounded-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300"
              style={{
                backgroundColor: th.cardBg,
                border: `1px solid ${th.cardBorder}`,
                backdropFilter: 'blur(18px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              }}
            >
              <div className="flex items-start gap-3 p-3">
                {activeMediaZone.zone_image_url && (
                  <img
                    src={activeMediaZone.zone_image_url}
                    alt={activeMediaZone.title}
                    className="w-20 h-20 rounded-xl object-cover shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0 py-0.5">
                  <h3 className="font-bold text-sm leading-tight" style={{ color: th.cardText }}>
                    {activeMediaZone.title}
                  </h3>
                  {activeMediaZone.description && (
                    <p className="text-xs mt-1.5 leading-relaxed whitespace-pre-wrap" style={{ color: th.cardMuted }}>
                      {activeMediaZone.description}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    dismissedMediaZoneIdsRef.current.add(activeMediaZone.id);
                    setActiveMediaZone(null);
                  }}
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 active:opacity-60"
                  style={{ color: th.cardMuted }}
                  aria-label="Dismiss zone details"
                >
                  <X size={16} />
                </button>
              </div>
              {activeMediaZone.ar_config?.enabled && (
                <div className="px-3 pb-3">
                  <button
                    onClick={() => setArCameraZone(activeMediaZone)}
                    className="w-full rounded-xl py-2.5 flex items-center justify-center gap-2 text-sm font-bold active:opacity-70 transition-opacity"
                    style={{
                      backgroundColor: `${accent}20`,
                      border: `1px solid ${accent}55`,
                      color: accent,
                    }}
                  >
                    <Camera size={15} /> View in camera
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Now Playing card — rendered below character presence so it sits closer to the bottom bar */}
          {activeZones.length > 0 && (
            <div
              className="w-full px-4 py-2.5 rounded-2xl"
              style={{
                backgroundColor: th.cardBg,
                border: `1px solid ${th.cardBorder}`,
                backdropFilter: 'blur(14px)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              }}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Volume2 className="animate-pulse shrink-0" size={12} style={{ color: accent }} />
                  <span className="font-bold uppercase text-[9px] tracking-widest" style={{ color: accent }}>Now Playing</span>
                </div>
                <button
                  type="button"
                  onClick={handleTappedAudioResume}
                  disabled={resumingAudio}
                  className="w-7 h-7 -my-1 flex items-center justify-center rounded-lg active:opacity-60 disabled:opacity-40"
                  style={{ color: th.cardMuted }}
                  aria-label="Restart audio"
                  title="Restart audio"
                >
                  <RotateCcw size={12} className={resumingAudio ? 'animate-spin' : ''} />
                </button>
              </div>
              <div className="space-y-1">
                {activeZones.map((az, idx) => (
                  <div key={idx} className="flex justify-between items-center gap-3">
                    <span className="text-xs truncate" style={{ color: th.cardText }}>{az.title}</span>
                    {az.replayable ? (
                      <button
                        onClick={() => { audioService.replayZone(az.id); setActiveZones(prev => prev.map(z => z.id === az.id ? { ...z, replayable: false } : z)); }}
                        className="flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold transition-opacity active:opacity-60"
                        style={{ backgroundColor: `${accent}22`, color: accent }}
                      >
                        <RotateCcw size={10} /> Replay
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] tabular-nums" style={{ color: th.cardMuted }}>{az.volume}%</span>
                        <div className="w-16 h-1 rounded-full overflow-hidden" style={{ backgroundColor: `${accent}33` }}>
                          <div
                            className="h-full transition-all duration-300"
                            style={{
                              width: az.volume > 0 ? `${Math.max(4, az.volume)}%` : '0%',
                              backgroundColor: accent,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CHAT INTERFACE ────────────────────────────────────────────────────
           Mounted only while showChat is true. History is persisted in
           sessionStorage (keyed by zone.id) inside ChatInterface itself, so
           reopening always restores the exact conversation — no greeting re-fires.
           key={chatKey} forces a fresh mount only when entering a new zone.   */}
      {persistedCharacterZone && showChat && (
        <ChatInterface
          key={chatKey}
          zone={persistedCharacterZone}
          theme={tour.player_theme || 'dark'}
          accent={accent}
          onClose={() => setShowChat(false)}
          onUnlock={(zoneId) => {
            unlockedZoneIdsRef.current = new Set([...unlockedZoneIdsRef.current, zoneId]);
            persistZoneState();
            const unlockedZone = zones.find(z => z.id === zoneId);
            if (unlockedZone) showHud('Zone Unlocked', `${unlockedZone.title} is now accessible.`);
          }}
        />
      )}

      {arCameraZone && (
        <ARCameraOverlay
          zone={arCameraZone}
          userPosition={userPos}
          gpsAccuracy={gpsAccuracy}
          accent={accent}
          onClose={() => setArCameraZone(null)}
        />
      )}

      {/* ── LOCATE BUTTON — floats over map top-right when user has panned away ── */}
      {audioStarted && !simulationMode && userPos && !followUser && (
        <button
          onClick={() => setFollowUser(true)}
          title="Re-center on my location"
          className="absolute z-[1400] animate-in fade-in duration-200 active:scale-90 transition-transform"
          style={{
            top: `calc(${TOP_BAR + 10}px + env(safe-area-inset-top, 0px))`,
            right: '12px',
            width: '36px',
            height: '36px',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: th.cardBg,
            border: `1px solid ${accent}40`,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            color: accent,
          }}
        >
          <Locate size={16} />
        </button>
      )}

      {/* ── HUD NOTIFICATION — drops below top bar ── */}
      {/* ── Background prefetch pill — informational only, never blocks ── */}
      {audioStarted && prefetchStatus && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-[1500] pointer-events-none"
          style={{ top: `calc(${TOP_BAR + 64}px + env(safe-area-inset-top, 0px))` }}
        >
          <div className="flex items-center gap-1.5 rounded-full bg-zinc-950/80 border border-white/10 px-3 py-1 text-[10px] text-zinc-300 backdrop-blur">
            <Loader2 size={10} className="animate-spin" />
            Preparing audio {prefetchStatus.done}/{prefetchStatus.total}
          </div>
        </div>
      )}

      {showAudioResume && audioStarted && (
        <div
          className="absolute left-4 right-4 z-[1700] animate-in slide-in-from-top-4 duration-300"
          style={{ top: `calc(${TOP_BAR + 12}px + env(safe-area-inset-top, 0px))` }}
        >
          <div
            className="max-w-sm mx-auto backdrop-blur-xl rounded-2xl shadow-2xl p-3 flex items-center gap-3"
            style={{
              backgroundColor: th.hudBg,
              border: `1px solid ${accent}55`,
              boxShadow: `0 10px 35px rgba(0,0,0,0.45), 0 0 20px ${accent}18`,
            }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${accent}20`, color: accent }}
            >
              <Volume2 size={19} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold" style={{ color: th.hudText }}>Audio check</div>
              <p className="text-[11px] leading-snug mt-0.5" style={{ color: th.barMuted }}>
                Locking your device can disrupt audio.
              </p>
            </div>
            <button
              type="button"
              onClick={handleTappedAudioResume}
              disabled={resumingAudio}
              className="h-10 px-3 rounded-xl text-white text-xs font-bold flex items-center gap-1.5 shrink-0 active:scale-95 transition-transform disabled:opacity-60"
              style={{ backgroundColor: accent }}
            >
              <PlayCircle size={15} />
              {resumingAudio ? 'Starting...' : 'Tap to resume'}
            </button>
          </div>
        </div>
      )}

      {/* AR is an optional camera mode, not a bottom-card feature. Keep its
          entry point in a dedicated, persistent position so it remains clear
          when a zone also has audio, images, character chat, or notices. */}
      {audioStarted && visibleARZone && !arCameraZone && (
        <div
          className="absolute left-4 right-4 z-[1600] animate-in slide-in-from-top-4 duration-300"
          style={{ top: `calc(${TOP_BAR + (showAudioResume ? 92 : 12)}px + env(safe-area-inset-top, 0px))` }}
        >
          <div
            className="max-w-sm mx-auto rounded-2xl shadow-2xl p-3 flex items-center gap-3 backdrop-blur-xl"
            style={{
              backgroundColor: th.hudBg,
              border: `1px solid ${accent}55`,
              boxShadow: `0 10px 35px rgba(0,0,0,0.45), 0 0 20px ${accent}18`,
            }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accent}20` }}>
              <Camera size={19} color={accent} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold" style={{ color: th.hudText }}>Camera object nearby</p>
              <p className="text-[11px] leading-snug mt-0.5 truncate" style={{ color: th.barMuted }}>{visibleARZone.title}</p>
            </div>
            <button
              type="button"
              onClick={() => setArCameraZone(visibleARZone)}
              className="h-10 px-3 rounded-xl text-white text-xs font-bold flex items-center gap-1.5 shrink-0 active:scale-95 transition-transform"
              style={{ backgroundColor: accent }}
            >
              <Camera size={15} /> Open camera
            </button>
          </div>
        </div>
      )}

      {hudNotification && (
        <div
          className="absolute left-4 right-4 z-[1500] animate-in slide-in-from-top-4 duration-300"
          style={{ top: `calc(${TOP_BAR + 12}px + env(safe-area-inset-top, 0px))` }}
        >
          <div
            className={`backdrop-blur rounded-2xl shadow-2xl ${hudNotification.featured ? 'p-4' : 'p-4 flex items-start gap-3'}`}
            style={{
              backgroundColor: th.hudBg,
              border: `1px solid ${accent}40`,
            }}
          >
            {hudNotification.featured ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {hudNotification.imageUrl && (
                      <img
                        src={hudNotification.imageUrl}
                        alt=""
                        className="w-16 h-16 rounded-2xl object-cover shrink-0 shadow-lg"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: accent }}>Discovered</div>
                      <div className="font-bold text-base leading-tight" style={{ color: th.hudText }}>{hudNotification.title}</div>
                    </div>
                  </div>
                  <button onClick={() => setHudNotification(null)} className="shrink-0 p-1 -mr-1 -mt-1 active:opacity-60" style={{ color: th.barMuted }}>
                    <X size={18} />
                  </button>
                </div>
                <p className="text-sm leading-snug whitespace-pre-wrap" style={{ color: th.hudText }}>{hudNotification.message}</p>
              </div>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ backgroundColor: `${accent}20`, border: `1px solid ${accent}40` }}>
                  {hudNotification.imageUrl
                    ? <img src={hudNotification.imageUrl} alt="" className="w-full h-full rounded-full object-cover" />
                    : <MapPin size={14} style={{ color: accent }} />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-widest mb-0.5" style={{ color: accent }}>{hudNotification.title}</div>
                  <p className="text-sm leading-snug whitespace-pre-wrap" style={{ color: th.hudText }}>{hudNotification.message}</p>
                </div>
                <button onClick={() => setHudNotification(null)} className="shrink-0 p-1 -mr-1 -mt-1 active:opacity-60" style={{ color: th.barMuted }}>
                  <X size={18} />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── CREATOR DEBUG ── */}
      {isPreview && showDebug && audioStarted && (
        <div
          className="absolute left-4 right-4 z-[1500]"
          style={{ top: `calc(${TOP_BAR + 12}px + env(safe-area-inset-top, 0px))` }}
        >
          <div
            className="max-w-sm mx-auto rounded-2xl px-4 py-3 shadow-2xl backdrop-blur-md"
            style={{ backgroundColor: th.cardBg, border: `1px solid ${accent}40` }}
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <Bug size={14} style={{ color: accent }} />
                <span className="text-xs font-bold" style={{ color: th.cardText }}>Debug mode</span>
              </div>
              <button
                type="button"
                onClick={() => setShowDebug(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg active:opacity-60"
                style={{ color: th.cardMuted }}
                aria-label="Close debug mode"
              >
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]" style={{ color: th.cardMuted }}>
              <span>Mode</span>
              <span className="text-right font-semibold" style={{ color: th.cardText }}>{simulationMode ? 'Simulation' : 'GPS'}</span>
              <span>Accuracy</span>
              <span className="text-right font-semibold" style={{ color: th.cardText }}>{gpsAccuracy ? `${Math.round(gpsAccuracy)} m` : '—'}</span>
              <span>Position</span>
              <span className="text-right font-mono" style={{ color: th.cardText }}>
                {userPos ? `${userPos[0].toFixed(5)}, ${userPos[1].toFixed(5)}` : 'Waiting'}
              </span>
              <span>Active zones</span>
              <span className="text-right font-semibold truncate" style={{ color: th.cardText }}>
                {activeZones.length > 0 ? activeZones.map(zone => zone.title).join(', ') : 'None'}
              </span>
              <ViewportStats labelColor={th.cardMuted} valueColor={th.cardText} />
            </div>
          </div>
        </div>
      )}

      {/* ── PROGRESSION INVENTORY ── */}
      {showInventory && tour.progression_enabled && playerProgress && (
        <div
          className={`overlay-edge-bleed fixed inset-0 z-[2500] ${scrim} flex items-end justify-center px-4 md:px-0`}
          onClick={() => setShowInventory(false)}
        >
          <SheetBlur />
          {/* relative z-10 keeps the sheet above SheetBlur. Without it the sheet
              is a static in-flow box while the blur layer is positioned, and
              positioned elements paint above static siblings — so the blur
              lands on top of the sheet instead of behind it. */}
          <div className="relative z-10 -mb-px w-full max-w-lg">
          <SheetSkirt color={th.sheetBg} />
          <div
            className="relative w-full flex flex-col rounded-t-[40px] shadow-2xl"
            style={{
              backgroundColor: th.sheetBg,
              color: th.sheetText,
              maxHeight: 'calc(100dvh - 72px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-col items-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 rounded-full" style={{ backgroundColor: th.sheetHandle }} />
            </div>

            <div
              className="px-8 pt-3 overflow-y-auto overscroll-contain"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 88px)' }}
            >
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ backgroundColor: `${accent}20`, color: accent }}
                  >
                    <Backpack size={20} />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">Progress</h3>
                    <p className="text-xs" style={{ color: th.sheetMuted }}>Saved on this device</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowInventory(false)}
                  className="w-9 h-9 flex items-center justify-center rounded-full"
                  style={{ color: th.sheetMuted }}
                  aria-label="Close progress"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-2">
                {(tour.progression_resources || []).map(resource => (
                  <div
                    key={resource.id}
                    className="flex items-center gap-3 py-3 border-b last:border-b-0"
                    style={{ borderColor: th.sheetBorder }}
                  >
                    <div
                      className="w-11 h-11 rounded-xl overflow-hidden flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${resource.color || accent}22`, color: resource.color || accent }}
                    >
                      {resource.image_url
                        ? <img src={resource.image_url} alt="" className="w-full h-full object-contain p-1" />
                        : resource.type === 'item' ? <KeyRound size={19} /> : <Gem size={19} />
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">{resource.name}</p>
                      <p className="text-[10px] uppercase tracking-wider" style={{ color: th.sheetMuted }}>
                        {resource.type}
                      </p>
                    </div>
                    <span className="text-xl font-bold tabular-nums">
                      {playerProgress.balances[resource.id] || 0}
                    </span>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  if (!window.confirm('Reset all progression for this experience on this device?')) return;
                  const reset = resetPlayerProgress(tour.id, tour.progression_resources || []);
                  playerProgressRef.current = reset;
                  setPlayerProgress(reset);
                  setShowInventory(false);
                }}
                className="mt-6 flex items-center justify-center gap-2 w-full py-3 rounded-xl text-xs font-semibold border"
                style={{ color: th.sheetMuted, borderColor: th.sheetBorder }}
              >
                <Trash2 size={13} /> Reset progress
              </button>
            </div>
          </div>
          </div>
        </div>
      )}

      {/* ── PLAYER MENU ── */}
      {showPlayerMenu && audioStarted && (
        <div
          className={`overlay-edge-bleed fixed inset-0 z-[2600] ${scrim} flex items-end justify-center px-4 md:px-0`}
          onClick={closePlayerMenu}
        >
          <SheetBlur />
          {/* relative z-10: see the progression sheet above — keeps the sheet
              above SheetBlur rather than under it. */}
          <div className="relative z-10 -mb-px w-full max-w-lg">
          <SheetSkirt color={th.sheetBg} />
          <div
            className="relative w-full rounded-t-[40px] shadow-2xl flex flex-col"
            style={{
              backgroundColor: th.sheetBg,
              color: th.sheetText,
              height: 'min(680px, calc(100dvh - 96px))',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex flex-col items-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 rounded-full" style={{ backgroundColor: th.sheetHandle }} />
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              <div
                className="h-full flex transition-transform duration-300 ease-out"
                style={{
                  width: '200%',
                  transform: playerMenuView === 'main' ? 'translateX(0)' : 'translateX(-50%)',
                }}
              >
                {/* Main menu */}
                <div className="w-1/2 h-full px-8 pt-3 pb-6 overflow-y-auto overscroll-contain shrink-0">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-lg">Player menu</h3>
                    <button
                      type="button"
                      onClick={closePlayerMenu}
                      className="w-9 h-9 flex items-center justify-center rounded-full"
                      style={{ color: th.sheetMuted }}
                      aria-label="Close player menu"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  <div className="divide-y" style={{ borderColor: th.sheetBorder }}>
                    <button
                      type="button"
                      onClick={() => setPlayerMenuView('about')}
                      className="w-full min-h-14 py-3 flex items-center gap-3 text-left"
                    >
                      <Info size={18} style={{ color: accent }} />
                      <span className="flex-1 text-sm font-semibold">About this experience</span>
                      <ChevronRight size={16} style={{ color: th.sheetMuted }} />
                    </button>

                    {tour.progression_enabled && playerProgress && (
                      <button
                        type="button"
                        onClick={() => setPlayerMenuView('progress')}
                        className="w-full min-h-14 py-3 flex items-center gap-3 text-left"
                      >
                        <Backpack size={18} style={{ color: accent }} />
                        <span className="flex-1 text-sm font-semibold">Progress &amp; inventory</span>
                        <ChevronRight size={16} style={{ color: th.sheetMuted }} />
                      </button>
                    )}

                    <div className="py-4">
                      <div className="flex items-center gap-3 mb-3">
                        <Layers size={18} style={{ color: accent }} />
                        <span className="text-sm font-semibold">Map appearance</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        {PLAYER_MAP_STYLE_ORDER.map(key => {
                          const val = MAP_STYLES[key];
                          const active = (mapStyleOverride || tour.map_style || 'dark') === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setMapStyleOverride(key)}
                              className="h-10 rounded-xl text-[11px] font-semibold border"
                              style={{
                                color: active ? accent : th.sheetMuted,
                                borderColor: active ? `${accent}80` : th.sheetBorder,
                                backgroundColor: active ? `${accent}18` : 'transparent',
                              }}
                            >
                              {val.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="py-4">
                      <div className="flex items-center gap-3">
                        <Volume2 size={18} style={{ color: accent }} />
                        <div className="flex-1">
                          <p className="text-sm font-semibold">Audio help</p>
                          <p className="text-xs mt-0.5" style={{ color: th.sheetMuted }}>Having trouble with audio?</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => window.location.reload()}
                          className="h-10 px-3 rounded-xl text-xs font-bold flex items-center gap-2"
                          style={{ backgroundColor: `${accent}20`, color: accent }}
                        >
                          <RefreshCw size={14} />
                          Refresh player
                        </button>
                      </div>
                    </div>

                    {isPreview && (
                      <div className="py-4">
                        <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: th.sheetMuted }}>Creator preview</p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setSimulationMode(mode => !mode)}
                            className="flex-1 h-11 rounded-xl border flex items-center justify-center gap-2 text-xs font-semibold"
                            style={{
                              borderColor: th.sheetBorder,
                              color: simulationMode ? '#fbbf24' : accent,
                            }}
                          >
                            <Navigation size={15} />
                            {simulationMode ? 'Simulation' : 'GPS'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowDebug(value => !value);
                              closePlayerMenu();
                            }}
                            className="flex-1 h-11 rounded-xl border flex items-center justify-center gap-2 text-xs font-semibold"
                            style={{
                              borderColor: showDebug ? `${accent}80` : th.sheetBorder,
                              color: showDebug ? accent : th.sheetMuted,
                              backgroundColor: showDebug ? `${accent}18` : 'transparent',
                            }}
                          >
                            <Bug size={15} />
                            Debug mode
                          </button>
                        </div>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={restartExperience}
                      className="w-full min-h-14 py-3 flex items-center gap-3 text-left"
                    >
                      <RotateCcw size={18} style={{ color: th.sheetMuted }} />
                      <div className="flex-1">
                        <p className="text-sm font-semibold">Restart experience</p>
                        <p className="text-xs mt-0.5" style={{ color: th.sheetMuted }}>Clears visits, chats, items, and progress</p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={exitExperience}
                      className="w-full min-h-14 py-3 flex items-center gap-3 text-left"
                    >
                      <LogOut size={18} style={{ color: th.sheetMuted }} />
                      <div className="flex-1">
                        <p className="text-sm font-semibold">Exit experience</p>
                        <p className="text-xs mt-0.5" style={{ color: th.sheetMuted }}>Returns to welcome without deleting progress</p>
                      </div>
                    </button>
                  </div>
                </div>

                {/* About / Progress detail page */}
                <div className="w-1/2 h-full px-5 pt-3 pb-6 overflow-y-auto overscroll-contain shrink-0">
                  <div className="flex items-center gap-2 mb-5">
                    <button
                      type="button"
                      onClick={() => setPlayerMenuView('main')}
                      className="w-9 h-9 -ml-2 flex items-center justify-center rounded-full active:opacity-60"
                      style={{ color: th.sheetMuted }}
                      aria-label="Back to player menu"
                    >
                      <ArrowLeft size={19} />
                    </button>
                    <h3 className="font-bold text-lg flex-1">
                      {playerMenuView === 'progress' ? 'Progress & inventory' : 'About this experience'}
                    </h3>
                    <button
                      type="button"
                      onClick={closePlayerMenu}
                      className="w-9 h-9 flex items-center justify-center rounded-full"
                      style={{ color: th.sheetMuted }}
                      aria-label="Close player menu"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  {playerMenuView === 'about' ? (
                    <div className="space-y-5">
                      <div className="flex items-center gap-4">
                        {tour.welcome_image_url && (
                          <img
                            src={tour.welcome_image_url}
                            alt=""
                            className="w-16 h-16 rounded-xl object-cover shrink-0"
                          />
                        )}
                        <div className="min-w-0">
                          <h4 className="font-bold text-xl leading-tight">{tour.title}</h4>
                          {tour.welcome_subtitle && (
                            <p className="text-sm mt-1" style={{ color: accent }}>{tour.welcome_subtitle}</p>
                          )}
                        </div>
                      </div>

                      {tour.description && (
                        <p
                          className="text-sm leading-relaxed whitespace-pre-wrap"
                          style={{ color: th.sheetMuted, textAlign: tour.description_align === 'left' ? 'left' : 'center' }}
                        >
                          {tour.description}
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(`${tour.lat.toFixed(6)}, ${tour.lng.toFixed(6)}`);
                          setCoordsCopied(true);
                          window.setTimeout(() => setCoordsCopied(false), 2000);
                        }}
                        className="w-full min-h-12 px-4 rounded-xl border flex items-center justify-center gap-2 text-sm font-semibold"
                        style={{ color: th.sheetMuted, borderColor: th.sheetBorder }}
                      >
                        {coordsCopied ? <Check size={15} /> : <MapPin size={15} />}
                        {coordsCopied ? 'Copied' : `${tour.lat.toFixed(5)}, ${tour.lng.toFixed(5)}`}
                      </button>
                    </div>
                  ) : playerMenuView === 'progress' && playerProgress ? (
                    <div>
                      <p className="text-xs mb-4" style={{ color: th.sheetMuted }}>Saved on this device</p>
                      <div className="space-y-1">
                        {(tour.progression_resources || []).map(resource => (
                          <div
                            key={resource.id}
                            className="flex items-center gap-3 py-3 border-b last:border-b-0"
                            style={{ borderColor: th.sheetBorder }}
                          >
                            <div
                              className="w-11 h-11 rounded-xl overflow-hidden flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${resource.color || accent}22`, color: resource.color || accent }}
                            >
                              {resource.image_url
                                ? <img src={resource.image_url} alt="" className="w-full h-full object-contain p-1" />
                                : resource.type === 'item' ? <KeyRound size={19} /> : <Gem size={19} />
                              }
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm truncate">{resource.name}</p>
                              <p className="text-[10px] uppercase tracking-wider" style={{ color: th.sheetMuted }}>{resource.type}</p>
                            </div>
                            <span className="text-xl font-bold tabular-nums">
                              {playerProgress.balances[resource.id] || 0}
                            </span>
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm('Reset all progression for this experience on this device?')) return;
                          const reset = resetPlayerProgress(tour.id, tour.progression_resources || []);
                          playerProgressRef.current = reset;
                          setPlayerProgress(reset);
                        }}
                        className="mt-6 flex items-center justify-center gap-2 w-full py-3 rounded-xl text-xs font-semibold border"
                        style={{ color: th.sheetMuted, borderColor: th.sheetBorder }}
                      >
                        <Trash2 size={13} /> Reset progress
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          </div>
        </div>
      )}

      {/* ── PASSPHRASE MODAL ── */}
      {/* Minimized locked-zone pill — reopens the passphrase modal without needing
          to leave and re-enter the zone. */}
      {audioStarted && minimizedLock && !passphraseChallenge && (
        <button
          onClick={() => { setMinimizedLock(null); setLockNudge(0); setPassphraseChallenge(minimizedLock); setPassphraseInput(''); setPassphraseError(false); }}
          className="absolute z-[1600] left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2.5 rounded-full bg-zinc-900/95 backdrop-blur border border-amber-500/50 shadow-xl active:opacity-80 animate-in slide-in-from-bottom-2"
          style={{ bottom: `calc(${bottomBarHeight}px + env(safe-area-inset-bottom, 0px) + 16px)` }}
        >
          <Lock size={15} className="text-amber-400" />
          <span className="text-white text-sm font-semibold max-w-[160px] truncate">{minimizedLock.title}</span>
          <span className="text-amber-400/70 text-xs shrink-0">Unlock</span>
        </button>
      )}

      {passphraseChallenge && (
        <div
          // key remounts the whole fixed layer after each keyboard dismissal —
          // the only reliable repaint for iOS's painted-offset state (see
          // lockNudge). Entrance animations only play on the first mount so
          // the remount is invisible.
          key={`${passphraseChallenge.id}:${lockNudge}`}
          className={`overlay-edge-bleed fixed inset-0 z-[2500] ${scrimStrong} flex items-end justify-center overflow-y-auto px-4 md:px-0 ${lockNudge === 0 ? 'animate-in fade-in' : ''}`}
          style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}
        >
          <SheetBlur />
          {/* Bottom-anchored sheet flush with the screen edge (safe-area padding
              lives inside), matching the other slide-ups — continuous dark grey,
              no gap. Amber accent kept on the TOP edge only (1px, same as the
              input's focus border); no border on the sides/bottom. */}
          {/* This sheet stays dark in both themes by design, so its skirt takes
              the same literal colour rather than th.sheetBg. */}
          <div className={`relative z-10 -mb-px w-full max-w-lg ${lockNudge === 0 ? 'animate-in slide-in-from-bottom-4' : ''}`}>
          <SheetSkirt color="#09090b" />
          <div
            className="relative border-t border-amber-500 rounded-t-[40px] w-full px-8 pt-6 max-h-[calc(100dvh-16px)] overflow-y-auto"
            style={{ backgroundColor: '#09090b', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}
          >
            <div className="w-10 h-1 bg-zinc-700 rounded-full mx-auto mb-5" />
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
                <Lock className="text-amber-400" size={20} />
              </div>
              <div>
                <h3 className="font-bold text-white text-base">{passphraseChallenge.title}</h3>
                <p className="text-xs text-amber-400/80 uppercase tracking-wider">Locked Zone</p>
              </div>
            </div>
            {passphraseChallenge.lock_hint && (
              <div className="bg-zinc-800/80 border border-zinc-700 rounded-xl p-3 mb-4 text-sm text-zinc-300 italic">
                "{passphraseChallenge.lock_hint}"
              </div>
            )}
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <KeyRound size={13} /> Enter Passphrase
            </label>
            <input
              type="text"
              autoFocus={lockNudge === 0}
              onBlur={() => {
                // Keyboard dismissed → schedule the remount nudge, unless focus
                // just moved to another field (don't yank a reopened keyboard).
                window.setTimeout(() => {
                  const ae = document.activeElement;
                  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
                  setLockNudge(n => n + 1);
                }, 350);
              }}
              className={`w-full bg-zinc-800 border rounded-xl px-4 py-3.5 text-white text-base font-mono tracking-wider focus:outline-none transition-colors mb-1 ${passphraseError ? 'border-red-500' : 'border-zinc-600 focus:border-amber-500'}`}
              style={{ fontSize: '16px' }}
              value={passphraseInput}
              onChange={(e) => { setPassphraseInput(e.target.value); setPassphraseError(false); }}
              onKeyDown={(e) => e.key === 'Enter' && handlePassphraseSubmit()}
              placeholder="..."
            />
            {passphraseError && <p className="text-red-400 text-xs mb-3">Incorrect passphrase. Try again.</p>}
            <div className="flex gap-3 mt-4 sticky bottom-0 pt-3 pb-1" style={{ backgroundColor: '#09090b' }}>
              <button
                onClick={() => {
                  // Minimize to a pill instead of fully dismissing — keep the ref
                  // set so the entry event doesn't auto-reopen it while inside.
                  setMinimizedLock(passphraseChallenge);
                  setPassphraseChallenge(null);
                  setPassphraseInput('');
                  setPassphraseError(false);
                }}
                className="flex-1 py-3.5 rounded-xl bg-zinc-800 text-zinc-400 text-sm font-medium active:bg-zinc-700"
              >
                Cancel
              </button>
              <button onClick={handlePassphraseSubmit} className="flex-1 py-3.5 rounded-xl bg-amber-600 active:bg-amber-700 text-white text-sm font-bold">
                Unlock
              </button>
            </div>
          </div>
          </div>
        </div>
      )}

      {/* ── TOP BAR ── */}
      {/* Opaque, plain fixed bar. It doesn't need to hide any map underneath —
          the map is inset to start BELOW this bar (see the map wrapper), so no
          canvas ever sits under it. That's what finally killed the Safari-only
          bright hairline: with no overlap, there's nothing for Safari's compositor
          to leak at the edge. */}
      <div
        ref={topBarRef}
        className="overlay-edge-bleed fixed top-0 left-0 right-0 z-[1000]"
        style={{
          backgroundColor: th.barBg,
          borderBottom: `1px solid ${th.barBorder}`,
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >
        <div className="flex items-center h-14 px-3 gap-2">

          {audioStarted ? (
            <button
              onClick={exitExperience}
              className="w-10 h-10 flex items-center justify-center rounded-xl shrink-0 active:opacity-60 transition-opacity"
              style={{ color: th.barMuted }}
            >
              <ArrowLeft size={20} />
            </button>
          ) : (
            <div className="w-10 shrink-0" />
          )}

          <div className="flex-1 flex items-center justify-center gap-2">
            <MapPin size={18} style={{ color: accent }} className="shrink-0" />
            <span className="font-bold tracking-tight" style={{ color: th.barText }}>Obelisk</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {tour.progression_enabled && playerProgress && (tour.progression_resources || []).length > 0 && (
              <button
                type="button"
                onClick={() => setShowInventory(true)}
                className="h-10 min-w-10 px-2 flex items-center justify-center gap-1.5 rounded-xl active:opacity-60 transition-opacity"
                style={{ color: accent }}
                title="Progress and inventory"
              >
                {(() => {
                  const visible = (tour.progression_resources || []).find(resource => resource.show_in_hud);
                  if (!visible) return <Backpack size={18} />;
                  return (
                    <>
                      <span
                        className="w-5 h-5 rounded-md overflow-hidden flex items-center justify-center"
                        style={{ backgroundColor: `${visible.color || accent}22`, color: visible.color || accent }}
                      >
                        {visible.image_url
                          ? <img src={visible.image_url} alt="" className="w-full h-full object-contain p-0.5" />
                          : visible.type === 'item' ? <KeyRound size={12} /> : <Gem size={12} />
                        }
                      </span>
                      <span className="text-xs font-bold tabular-nums">
                        {playerProgress.balances[visible.id] || 0}
                      </span>
                    </>
                  );
                })()}
              </button>
            )}
            <button
              onClick={() => {
                setPlayerMenuView('main');
                setShowPlayerMenu(true);
              }}
              className="w-10 h-10 flex items-center justify-center rounded-xl active:opacity-60 transition-opacity"
              style={{ color: th.barMuted }}
              aria-label="Open player menu"
            >
              <Menu size={20} />
            </button>
          </div>

        </div>
      </div>

      {/* ── BOTTOM BAR ── */}
      {audioStarted && (
        <div
          ref={bottomBarRef}
          // overlay-edge-bleed gives the same 10px side shield as every other
          // full-bleed surface. Height is unchanged, so the bottomBarHeight
          // measurement below stays correct.
          className="overlay-edge-bleed fixed bottom-0 left-0 right-0 z-[1000]"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <button
            onClick={openTourInfo}
            // No backdrop-blur: barBg is opaque, so the blur did nothing but let
            // Safari tint/re-composite the footer (grey-ish, and shifting after a
            // blurred sheet opened) — that was the footer's color inconsistency.
            className="w-full flex flex-col items-center gap-1.5 pt-2.5 pb-3"
            style={{
              backgroundColor: th.barBg,
              borderTop: `1px solid ${th.barBorder}`,
            }}
          >
            <div className="w-9 h-[3px] rounded-full" style={{ backgroundColor: th.sheetHandle }} />
            <span className="font-bold text-base tracking-tight mt-0.5 px-6 text-center leading-snug" style={{ color: th.barText }}>
              {tour.title}
            </span>
            <span className="flex items-center gap-1 text-xs" style={{ color: th.barMuted }}>
              {tour.welcome_subtitle
                ? <span className="truncate max-w-[220px]">{tour.welcome_subtitle}</span>
                : <span>Tap for details</span>
              }
              <ChevronUp size={11} className="shrink-0" />
            </span>
          </button>
        </div>
      )}

    </div>
  );
};
