import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
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
import { PlayerProgress, ProgressionReward, Tour, Zone } from '../types';
import { FONT_STYLES, MAP_STYLES } from '../constants';
import { PlayCircle, Volume2, Mic, Lock, X, KeyRound, ChevronUp, Copy, Check, MapPin, ArrowLeft, Menu, Layers, Locate, RotateCcw, ZoomIn, ZoomOut, Backpack, Gem, Trash2 } from 'lucide-react';
import { ChatInterface } from '../components/ChatInterface';

// Custom icons
const UserIcon = L.divIcon({
  html: `<div style="background-color: #ef4444; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
  className: 'custom-user-icon',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

const PLAYER_MAP_STYLE_ORDER = ['satellite', 'voyager', 'dark', 'light'] as const;

// Map controller — only re-centers when `enabled` (user hasn't manually panned away).
const MapRecenter = ({ lat, lng, enabled }: { lat: number; lng: number; enabled: boolean }) => {
  const map = useMap();
  useEffect(() => {
    if (enabled) map.setView([lat, lng], map.getZoom());
  }, [lat, lng, map, enabled]);
  return null;
};

// Detects a user-initiated drag so we can pause auto-follow.
const DragDetector = ({ onDrag }: { onDrag: () => void }) => {
  useMapEvents({ dragstart: onDrag });
  return null;
};

// Forces Leaflet to re-measure container after CSS aspect-ratio resolves
const InvalidateSize = () => {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => clearTimeout(t);
  }, [map]);
  return null;
};

// Leaflet reads interaction options only when the map is created. Toggle the
// handlers directly so the welcome preview can become interactive after a tap.
const WelcomeMapInteraction = ({ enabled }: { enabled: boolean }) => {
  const map = useMap();
  useEffect(() => {
    const handlers = [
      map.dragging,
      map.touchZoom,
      map.doubleClickZoom,
      map.boxZoom,
      map.keyboard,
    ];
    handlers.forEach(handler => enabled ? handler.enable() : handler.disable());
    map.getContainer().style.touchAction = enabled ? 'none' : 'pan-y';
    map.invalidateSize();
  }, [enabled, map]);
  return null;
};

export const Player: React.FC = () => {
  const { tourId } = useParams<{ tourId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === '1';
  
  const [tour, setTour] = useState<Tour | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [audioStarted, setAudioStarted] = useState(false);
  const [showAudioResume, setShowAudioResume] = useState(false);
  const [resumingAudio, setResumingAudio] = useState(false);
  const [simulationMode, setSimulationMode] = useState(isPreview);
  const [activeZones, setActiveZones] = useState<{id: string, title: string, volume: number, replayable: boolean}[]>([]);
  const [activeMediaZone, setActiveMediaZone] = useState<Zone | null>(null);
  const dismissedMediaZoneIdsRef = useRef<Set<string>>(new Set());
  // Map style — starts at the tour's chosen style, user can override in-session
  const [mapStyleOverride, setMapStyleOverride] = useState<string | null>(null);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [welcomeMapInteractive, setWelcomeMapInteractive] = useState(false);
  const welcomeMapRef = useRef<L.Map | null>(null);

  // Optional local-first progression
  const [playerProgress, setPlayerProgress] = useState<PlayerProgress | null>(null);
  const playerProgressRef = useRef<PlayerProgress | null>(null);
  const [showInventory, setShowInventory] = useState(false);

  // Character Interaction
  const [activeCharacterZone, setActiveCharacterZone] = useState<Zone | null>(null);
  // persistedCharacterZone keeps the last character zone so the chat
  // session (and history) survives briefly leaving the zone radius.
  const [persistedCharacterZone, setPersistedCharacterZone] = useState<Zone | null>(null);
  const persistedCharZoneRef = useRef<Zone | null>(null);
  const [showChat, setShowChat] = useState(false);
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

  // HUD notification
  const [hudNotification, setHudNotification] = useState<{ title: string; message: string } | null>(null);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Passphrase challenge
  const [passphraseChallenge, setPassphraseChallenge] = useState<Zone | null>(null);
  const [passphraseInput, setPassphraseInput] = useState('');
  const [passphraseError, setPassphraseError] = useState(false);

  // Zone state tracking. The ref feeds the audio loop while state redraws the
  // map immediately when a prerequisite zone becomes available.
  const [visitedZoneIds, setVisitedZoneIds] = useState<Set<string>>(new Set());
  const visitedZoneIdsRef = useRef<Set<string>>(new Set());
  const unlockedZoneIdsRef = useRef<Set<string>>(new Set());
  const prevZoneIdsRef = useRef<Set<string>>(new Set());
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

  const showHud = (title: string, message: string) => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    setHudNotification({ title, message });
    hudTimerRef.current = setTimeout(() => setHudNotification(null), 5000);
  };

  const applyGpsFix = (pos: GeolocationPosition) => {
    const newPos: [number, number] = [pos.coords.latitude, pos.coords.longitude];
    const accuracy = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : Infinity;
    const now = Date.now();
    const prev = gpsFixRef.current;

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

  const markZoneVisited = (zoneId: string) => {
    if (visitedZoneIdsRef.current.has(zoneId)) return;
    const next = new Set([...visitedZoneIdsRef.current, zoneId]);
    visitedZoneIdsRef.current = next;
    setVisitedZoneIds(next);
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
    if (messages.length > 0) showHud(zone.title, messages.join('\n'));
  };

  const handlePassphraseSubmit = () => {
    const zone = passphraseChallenge;
    if (!zone) return;
    const correct = (zone.lock_passphrase || '').trim().toLowerCase();
    if (passphraseInput.trim().toLowerCase() === correct) {
      unlockedZoneIdsRef.current = new Set([...unlockedZoneIdsRef.current, zone.id]);
      completeZoneEntry(zone);
      passphraseChallengeRef.current = null;
      setPassphraseChallenge(null);
      setPassphraseInput('');
      setPassphraseError(false);
    } else {
      setPassphraseError(true);
    }
  };

  // Audio Engine Loop
  useEffect(() => {
    if (!audioStarted || !userPos || zones.length === 0) return;

    const interval = setInterval(() => {
      const currentPos = simPosRef.current || userPos;
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
      const currentZoneIds = new Set<string>();

      zones.forEach(zone => {
        const dist = getDistance(currentPos[0], currentPos[1], zone.lat, zone.lng);
        const insideZone = dist < zone.radius;
        const prereqMet = !zone.requires_zone_id || visitedZoneIdsRef.current.has(zone.requires_zone_id);
        const progressionMet =
          !tour?.progression_enabled ||
          !playerProgressRef.current ||
          canMeetProgressionRequirements(zone, playerProgressRef.current);

        if (insideZone && prereqMet && progressionMet) {
          currentZoneIds.add(zone.id);

          // Zone entry event
          if (!prevZoneIdsRef.current.has(zone.id)) {
            const isLocked = zone.lock_type === 'passphrase' && !unlockedZoneIdsRef.current.has(zone.id);

            if (isLocked && prereqMet) {
              // Only show passphrase modal if none is already shown
              if (!passphraseChallengeRef.current) {
                passphraseChallengeRef.current = zone;
                setPassphraseChallenge(zone);
              }
            } else if (prereqMet) {
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
            if (zone.type === 'character') {
              foundCharZone = zone;
            } else {
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
                  ? calculateAttenuation(dist, zone.radius)
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

        if (zone.type === 'audio') {
          let volume = 0;
          if (insideZone && isZoneAccessible(zone)) {
            const zoneVolume = Math.min(1, Math.max(0, Number(zone.volume ?? 1.0)));
            volume = zone.use_attenuation ? calculateAttenuation(dist, zone.radius) : 1.0;
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
      });

      prevZoneIdsRef.current = currentZoneIds;
      dismissedMediaZoneIdsRef.current = new Set(
        [...dismissedMediaZoneIdsRef.current].filter(id => currentZoneIds.has(id))
      );
      audioService.updateVolumes(audioUpdates);
      setActiveZones(activeState);
      setActiveMediaZone(foundMediaZone);

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
  }, [audioStarted, userPos, zones, tour]);

  // Safari audio remains intentionally paused after backgrounding or locking.
  // When the player returns, wait for an explicit tap before rebuilding and
  // restarting active zone audio.
  useEffect(() => {
    if (!audioStarted) return;
    let interruptedActiveAudio = false;

    const showRecoveryWhenVisible = () => {
      if (document.visibilityState !== 'visible' || !interruptedActiveAudio) return;
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

  useEffect(() => {
    if (showAudioResume && activeZones.length === 0) setShowAudioResume(false);
  }, [showAudioResume, activeZones.length]);

  useEffect(() => {
    if (!showAudioResume) return;
    const timer = window.setTimeout(() => setShowAudioResume(false), 12000);
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
      return;
    }

    navigator.geolocation.getCurrentPosition(
      applyGpsFix,
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
    );

    const watchId = navigator.geolocation.watchPosition(
      applyGpsFix,
      (err) => {
        console.error(err);
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
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [simulationMode]);

  const loadTour = async (id: string) => {
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

    // In preview/sim mode seed position at the tour start point.
    // In GPS mode leave userPos null — the watchPosition callback will set it
    // once the device gets a real fix, preventing fake zone triggers.
    if (isPreview) {
      setUserPos([t.lat, t.lng]);
      simPosRef.current = [t.lat, t.lng];
    }

    setLoading(false);
  };

  const startAudio = async () => {
    setShowAudioResume(false);
    // Some browsers can leave AudioContext.resume() pending indefinitely.
    // Never block entry to the experience while the audio engine catches up.
    await Promise.race([
      audioService.init(),
      new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
    ]);
    zones.filter(z => z.type === 'audio').forEach(z => audioService.loadAudio(z.id, z.media_url));
    setAudioStarted(true);
    // Start analytics session — skip in preview mode so creator test-runs don't pollute data.
    if (!isPreview && tour?.id) {
      startSession(tour.id).then(id => { sessionIdRef.current = id; });
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
  const th = {
    // Top / bottom bars
    barBg:       isDark ? 'rgba(9,9,11,0.96)'   : 'rgba(255,255,255,0.96)',
    barBorder:   isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    barText:     isDark ? '#ffffff'              : '#09090b',
    barMuted:    isDark ? '#71717a'              : '#52525b',
    // Floating cards (Now Playing, Character card)
    cardBg:      isDark ? 'rgba(24,24,27,0.95)' : 'rgba(255,255,255,0.95)',
    cardBorder:  isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
    cardText:    isDark ? '#ffffff'              : '#09090b',
    cardMuted:   isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)',
    // Info sheet
    sheetBg:     isDark ? '#18181b'              : '#ffffff',
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
    <div className="h-full relative bg-zinc-950 overflow-hidden" onClick={() => setShowMapPicker(false)}>

      {/* ── FULL-SCREEN MAP ── */}
      {/* touch-action:none tells the browser to hand ALL touch events to Leaflet,
          preventing the vertical-scroll ghost that appears during pinch-to-zoom */}
      <div className="absolute inset-0" style={{ touchAction: 'none' }}>
        <MapContainer
          center={[tour.lat, tour.lng]}
          zoom={tour.start_zoom ?? 18}
          maxZoom={22}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
        >
          {(() => {
            const styleKey = mapStyleOverride || tour?.map_style || 'dark';
            const styleObj = MAP_STYLES[styleKey] || MAP_STYLES.dark;
            return (
              <TileLayer
                key={styleKey}
                url={styleObj.url}
                attribution={styleObj.attribution}
                maxNativeZoom={19}
                maxZoom={22}
              />
            );
          })()}
          
          <InvalidateSize />
          {!simulationMode && userPos && (
            <MapRecenter lat={userPos[0]} lng={userPos[1]} enabled={followUser} />
          )}
          {/* Pause auto-follow whenever the user manually pans the map */}
          {!simulationMode && <DragDetector onDrag={() => setFollowUser(false)} />}

          {/* Zones */}
          {zones.map(zone => {
             const isActive = activeZones.find(az => az.id === zone.id) || (activeCharacterZone?.id === zone.id);
             if (!zone.is_visible) return null;
             if (zone.requires_zone_id && !visitedZoneIds.has(zone.requires_zone_id)) return null;
             if (
               tour.progression_enabled &&
               playerProgress &&
               !canMeetProgressionRequirements(zone, playerProgress)
             ) return null;

             const isChar = zone.type === 'character';
             const isLocked = zone.lock_type === 'passphrase';

             // Universal colour language for the player:
             //   active (any type) → blue · inactive audio → green
             //   inactive character → purple · inactive locked → yellow
             // (Invisible zones are never drawn — handled above.)
             const ACTIVE = '#3b82f6'; // blue-500
             const color = isActive
               ? ACTIVE
               : isLocked ? '#f59e0b'   // amber/yellow
               : isChar   ? '#8b5cf6'   // violet/purple
               :            '#10b981';  // emerald/green

             return (
              <React.Fragment key={zone.id}>
                <Circle
                  center={[zone.lat, zone.lng]}
                  radius={zone.radius}
                  pathOptions={{
                    color,
                    fillColor: color,
                    fillOpacity: isActive ? 0.35 : 0.18,
                    weight: isActive ? 3 : 2,
                    dashArray: isLocked && !isActive ? '6 4' : undefined
                  }}
                />
              </React.Fragment>
             );
          })}

          {/* User Marker — only render when we have an actual position */}
          {userPos && gpsAccuracy && gpsAccuracy > 0 && (
            <Circle
              center={userPos}
              radius={Math.min(gpsAccuracy, 120)}
              pathOptions={{
                color: '#ef4444',
                fillColor: '#ef4444',
                fillOpacity: 0.08,
                weight: 1,
                dashArray: '4 4',
              }}
            />
          )}
          {userPos && (
            <Marker
              position={userPos}
              icon={UserIcon}
              draggable={simulationMode}
              eventHandlers={{
                drag: (e) => {
                  const marker = e.target;
                  const pos = marker.getLatLng();
                  const newPos: [number, number] = [pos.lat, pos.lng];
                  setUserPos(newPos);
                  simPosRef.current = newPos;
                }
              }}
            />
          )}
        </MapContainer>
      </div>

      {/* ── WELCOME SCREEN (z-2000, covers map + bars) ── */}
      {!audioStarted && tour && (() => {
        const bg         = tour.bg_color    || '#09090b';
        const accent     = tour.accent_color || '#10b981';
        const textColor  = tour.text_color   || '#ffffff';
        const fontFamily = FONT_STYLES[tour.font_style || 'sans']?.fontFamily;
        const mapStyle   = MAP_STYLES[tour.map_style || 'dark'] || MAP_STYLES.dark;

        const copyCoords = () => {
          navigator.clipboard.writeText(`${tour.lat.toFixed(6)}, ${tour.lng.toFixed(6)}`);
          setCoordsCopied(true);
          setTimeout(() => setCoordsCopied(false), 2000);
        };

        const StartMarkerIcon = L.divIcon({
          html: `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
            <div style="background:#10b981;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 0 2px #10b981,0 2px 8px rgba(16,185,129,0.5)"></div>
            <div style="background:#10b981;color:white;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;letter-spacing:0.05em">START</div>
          </div>`,
          className: '',
          iconSize: [60, 38],
          iconAnchor: [30, 11],
        });

        return (
          <div
            className="fixed inset-0 z-[2000] flex flex-col overflow-hidden"
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
              </div>
            </div>

            {/* ── SCROLL AREA — takes all remaining space between header and footer ── */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ scrollbarWidth: 'none', overscrollBehavior: 'none' }}
            >
              <div className="w-full max-w-sm mx-auto px-5 flex flex-col items-center text-center gap-5 py-4">

                {tour.welcome_image_url && (
                  <img src={tour.welcome_image_url} alt={tour.title} className="w-40 h-40 object-cover rounded-2xl shadow-2xl" />
                )}

                {tour.description && (
                  <p className="text-sm leading-relaxed opacity-80 w-full whitespace-pre-wrap" style={{ color: textColor, textAlign: tour.description_align === 'left' ? 'left' : 'center' }}>{tour.description}</p>
                )}

                <div className="relative w-full aspect-[4/3] max-h-[240px] rounded-xl overflow-hidden border border-white/10 shadow-lg">
                  <MapContainer
                    ref={welcomeMapRef}
                    center={[tour.lat, tour.lng]}
                    zoom={tour.start_zoom ?? 18}
                    style={{ width: '100%', height: '100%' }}
                    zoomControl={false}
                    scrollWheelZoom={false}
                    dragging={welcomeMapInteractive}
                    touchZoom={welcomeMapInteractive}
                    doubleClickZoom={welcomeMapInteractive}
                    boxZoom={false}
                    keyboard={false}
                    attributionControl={false}
                  >
                    <TileLayer url={mapStyle.url} />
                    <Marker position={[tour.lat, tour.lng]} icon={StartMarkerIcon} />
                    <InvalidateSize />
                    <WelcomeMapInteraction enabled={welcomeMapInteractive} />
                  </MapContainer>
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
                <button
                  onClick={startAudio}
                  disabled={!isPreview && !userPos}
                  className="flex items-center justify-center gap-2 text-white w-full py-4 rounded-2xl text-lg font-bold shadow-xl active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                  style={{ backgroundColor: accent }}
                >
                  <PlayCircle size={22} /> Begin
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── TOUR INFO SHEET — smooth CSS transition ── */}
      {tourInfoMounted && tour && (
        <div
          className="fixed inset-0 z-[2000] flex items-end justify-center"
          style={{
            backgroundColor: 'rgba(0,0,0,0.55)',
            opacity: tourInfoVisible ? 1 : 0,
            transition: 'opacity 0.3s',
          }}
          onClick={closeTourInfo}
        >
          <div
            className="w-full max-w-lg flex flex-col rounded-t-3xl shadow-2xl overflow-hidden"
            style={{
              backgroundColor: th.sheetBg,
              transform: tourInfoVisible ? 'translateY(0)' : 'translateY(100%)',
              transition: 'transform 0.38s cubic-bezier(0.32, 0.72, 0, 1)',
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

            <div className="px-6 pt-3 pb-6 flex flex-col gap-4">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {tour.welcome_image_url && (
                    <img src={tour.welcome_image_url} alt="" className="w-14 h-14 object-cover rounded-xl shrink-0 shadow-lg" />
                  )}
                  <div className="min-w-0">
                    <h2 className="font-bold text-xl leading-tight" style={{ color: th.sheetText }}>{tour.title}</h2>
                    {tour.welcome_subtitle && (
                      <p className="text-sm mt-0.5" style={{ color: accent }}>{tour.welcome_subtitle}</p>
                    )}
                  </div>
                </div>
                <button onClick={closeTourInfo} className="p-1.5 rounded-full shrink-0 mt-0.5" style={{ color: th.sheetMuted }}>
                  <X size={18} />
                </button>
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
      )}

      {/* ── FLOATING PANEL — Now Playing + Character card, centered above bottom bar ── */}
      {/* While chat is open: hidden on mobile (chat is full-screen), kept visible on
          desktop anchored bottom-left so it never collides with the chat panel (bottom-right) */}
      {audioStarted && (
        <div
          className={`absolute z-[1500] flex-col items-end gap-2 w-full max-w-sm px-4 ${
            showChat ? 'hidden md:flex left-2' : 'flex left-1/2 -translate-x-1/2'
          }`}
          style={{
            bottom: 'calc(104px + env(safe-area-inset-bottom, 0px))',
            maxHeight: 'calc(100dvh - 176px - env(safe-area-inset-bottom, 0px))',
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
                  className="absolute inset-0 rounded-2xl animate-ping"
                  style={{ backgroundColor: accent, opacity: 0.25, animationDuration: '2.5s' }}
                />
                {/* Character artwork */}
                <div
                  className="absolute inset-0 rounded-2xl overflow-hidden shadow-2xl"
                  style={{ border: `2px solid ${accent}`, boxShadow: `0 0 20px ${accent}55` }}
                >
                  {activeCharacterZone.character_image_url
                    ? <img src={activeCharacterZone.character_image_url} alt={activeCharacterZone.title} className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: `${accent}30` }}><Mic size={22} color={accent} /></div>
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
                    className="absolute inset-0 rounded-2xl animate-ping"
                    style={{ backgroundColor: accent, opacity: 0.2, animationDuration: '2.5s' }}
                  />
                  <div
                    className="absolute inset-0 rounded-2xl overflow-hidden shadow-xl"
                    style={{ border: `2px solid ${accent}`, boxShadow: `0 0 24px ${accent}44` }}
                  >
                    {activeCharacterZone.character_image_url
                      ? <img src={activeCharacterZone.character_image_url} alt={activeCharacterZone.title} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: `${accent}25` }}><Mic size={26} color={accent} /></div>
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
                  <Mic size={15} color="white" />
                  <span className="text-white">Speak to {activeCharacterZone.title}</span>
                </button>
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
          onClose={() => setShowChat(false)}
          onUnlock={(zoneId) => {
            unlockedZoneIdsRef.current = new Set([...unlockedZoneIdsRef.current, zoneId]);
            const unlockedZone = zones.find(z => z.id === zoneId);
            if (unlockedZone) showHud('Zone Unlocked', `${unlockedZone.title} is now accessible.`);
          }}
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

      {hudNotification && (
        <div
          className="absolute left-4 right-4 z-[1500] animate-in slide-in-from-top-4 duration-300"
          style={{ top: `calc(${TOP_BAR + 12}px + env(safe-area-inset-top, 0px))` }}
        >
          <div
            className="backdrop-blur rounded-2xl shadow-2xl p-4 flex items-start gap-3"
            style={{
              backgroundColor: th.hudBg,
              border: `1px solid ${accent}40`,
            }}
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
              style={{ backgroundColor: `${accent}20`, border: `1px solid ${accent}40` }}>
              <MapPin size={14} style={{ color: accent }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-widest mb-0.5" style={{ color: accent }}>{hudNotification.title}</div>
              <p className="text-sm leading-snug" style={{ color: th.hudText }}>{hudNotification.message}</p>
            </div>
            <button onClick={() => setHudNotification(null)} className="shrink-0 p-1 -mr-1 -mt-1 active:opacity-60" style={{ color: th.barMuted }}>
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* ── PROGRESSION INVENTORY ── */}
      {showInventory && tour.progression_enabled && playerProgress && (
        <div
          className="absolute inset-0 z-[2500] bg-black/60 backdrop-blur-sm flex items-end justify-center"
          onClick={() => setShowInventory(false)}
        >
          <div
            className="w-full max-w-lg flex flex-col rounded-t-3xl shadow-2xl overflow-hidden"
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
              className="px-6 pt-3 overflow-y-auto overscroll-contain"
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
      )}

      {/* ── PASSPHRASE MODAL ── */}
      {passphraseChallenge && (
        <div className="absolute inset-0 z-[2500] bg-black/70 backdrop-blur-sm flex items-end justify-center animate-in fade-in" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          <div className="bg-zinc-900 border border-amber-500/30 rounded-t-3xl shadow-2xl w-full max-w-lg p-6 pb-8 animate-in slide-in-from-bottom-4">
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
              autoFocus
              className={`w-full bg-zinc-800 border rounded-xl px-4 py-3.5 text-white text-base font-mono tracking-wider focus:outline-none transition-colors mb-1 ${passphraseError ? 'border-red-500' : 'border-zinc-600 focus:border-amber-500'}`}
              value={passphraseInput}
              onChange={(e) => { setPassphraseInput(e.target.value); setPassphraseError(false); }}
              onKeyDown={(e) => e.key === 'Enter' && handlePassphraseSubmit()}
              placeholder="..."
            />
            {passphraseError && <p className="text-red-400 text-xs mb-3">Incorrect passphrase. Try again.</p>}
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => { setPassphraseChallenge(null); passphraseChallengeRef.current = null; setPassphraseInput(''); setPassphraseError(false); }}
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
      )}

      {/* ── TOP BAR ── */}
      <div
        className="fixed top-0 left-0 right-0 z-[1000] backdrop-blur-md"
        style={{
          backgroundColor: th.barBg,
          borderBottom: `1px solid ${th.barBorder}`,
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >
        <div className="flex items-center h-14 px-3 gap-2">

          {audioStarted ? (
            <button
              onClick={() => {
                audioService.stopAll();
                setShowAudioResume(false);
                setAudioStarted(false);
              }}
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
            {isPreview && (
              <button
                onClick={() => setSimulationMode(!simulationMode)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg active:opacity-60 transition-opacity"
                title="Toggle GPS / Simulation"
              >
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${simulationMode ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                <span className={`text-[10px] font-bold uppercase tracking-wide ${simulationMode ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {simulationMode ? 'Sim' : 'GPS'}
                </span>
              </button>
            )}
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
            {/* Map style picker */}
            <div className="relative" onClick={e => e.stopPropagation()}>
              <button
                onClick={() => setShowMapPicker(p => !p)}
                className="w-10 h-10 flex items-center justify-center rounded-xl active:opacity-60 transition-opacity"
                style={{ color: mapStyleOverride ? accent : th.barMuted }}
                title="Change map style"
              >
                <Layers size={18} />
              </button>
              {showMapPicker && (
                <div
                  className="absolute right-0 top-full rounded-2xl shadow-2xl overflow-hidden z-[2000] w-36"
                  style={{ backgroundColor: th.cardBg, border: `1px solid ${th.cardBorder}` }}
                >
                  {PLAYER_MAP_STYLE_ORDER.map(key => {
                    const val = MAP_STYLES[key];
                    const active = (mapStyleOverride || tour?.map_style || 'dark') === key;
                    return (
                      <button
                        key={key}
                        onClick={() => { setMapStyleOverride(key); setShowMapPicker(false); }}
                        className="w-full px-4 py-2.5 text-left text-sm flex items-center justify-between"
                        style={{
                          color: active ? accent : th.cardText,
                          backgroundColor: active ? `${accent}18` : 'transparent',
                        }}
                      >
                        {val.label}
                        {active && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              onClick={openTourInfo}
              className="w-10 h-10 flex items-center justify-center rounded-xl active:opacity-60 transition-opacity"
              style={{ color: th.barMuted }}
            >
              <Menu size={20} />
            </button>
          </div>

        </div>
      </div>

      {/* ── BOTTOM BAR ── */}
      {audioStarted && (
        <div
          className="fixed bottom-0 left-0 right-0 z-[1000]"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <button
            onClick={openTourInfo}
            className="w-full backdrop-blur-md flex flex-col items-center gap-1.5 pt-2.5 pb-3"
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
