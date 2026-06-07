import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import { getTourById, getZonesByTourId } from '../services/db';
import { audioService } from '../services/audioService';
import { getDistance, calculateAttenuation } from '../utils/geo';
import { Tour, Zone } from '../types';
import { FONT_STYLES, MAP_STYLES } from '../constants';
import { PlayCircle, Volume2, Mic, Lock, X, KeyRound, ChevronUp, Copy, Check, MapPin, ArrowLeft, Menu, Layers } from 'lucide-react';
import { ChatInterface } from '../components/ChatInterface';

// Custom icons
const UserIcon = L.divIcon({
  html: `<div style="background-color: #ef4444; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
  className: 'custom-user-icon',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

// Map controller to center on user
const MapRecenter = ({ lat, lng }: { lat: number, lng: number }) => {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], map.getZoom());
  }, [lat, lng, map]);
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

export const Player: React.FC = () => {
  const { tourId } = useParams<{ tourId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === '1';
  
  const [tour, setTour] = useState<Tour | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(true);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [audioStarted, setAudioStarted] = useState(false);
  const [simulationMode, setSimulationMode] = useState(isPreview);
  const [activeZones, setActiveZones] = useState<{title: string, volume: number}[]>([]);
  // Map style — starts at the tour's chosen style, user can override in-session
  const [mapStyleOverride, setMapStyleOverride] = useState<string | null>(null);
  const [showMapPicker, setShowMapPicker] = useState(false);

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

  // Zone state tracking (refs so interval closure always sees latest values)
  const visitedZoneIdsRef = useRef<Set<string>>(new Set());
  const unlockedZoneIdsRef = useRef<Set<string>>(new Set());
  const prevZoneIdsRef = useRef<Set<string>>(new Set());
  const passphraseChallengeRef = useRef<Zone | null>(null);

  // Simulation ref to avoid state lag in drag handlers
  const simPosRef = useRef<[number, number] | null>(null);
  // Swipe-up detection on bottom bar

  useEffect(() => {
    if (tourId) loadTour(tourId);
    return () => {
      audioService.stopAll();
    };
  }, [tourId]);

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

  const isZoneAccessible = (zone: Zone): boolean => {
    if (zone.requires_zone_id && !visitedZoneIdsRef.current.has(zone.requires_zone_id)) return false;
    if (zone.lock_type === 'passphrase' && !unlockedZoneIdsRef.current.has(zone.id)) return false;
    return true;
  };

  const handlePassphraseSubmit = () => {
    const zone = passphraseChallenge;
    if (!zone) return;
    const correct = (zone.lock_passphrase || '').trim().toLowerCase();
    if (passphraseInput.trim().toLowerCase() === correct) {
      unlockedZoneIdsRef.current = new Set([...unlockedZoneIdsRef.current, zone.id]);
      visitedZoneIdsRef.current = new Set([...visitedZoneIdsRef.current, zone.id]);
      passphraseChallengeRef.current = null;
      setPassphraseChallenge(null);
      setPassphraseInput('');
      setPassphraseError(false);
      if (zone.entry_message) showHud(zone.title, zone.entry_message);
    } else {
      setPassphraseError(true);
    }
  };

  // Audio Engine Loop
  useEffect(() => {
    if (!audioStarted || !userPos || zones.length === 0) return;

    const interval = setInterval(() => {
      const currentPos = simPosRef.current || userPos;
      const audioUpdates: { id: string; volume: number; loop?: boolean; destroyOnEnd?: boolean }[] = [];
      const activeState: {title: string, volume: number}[] = [];
      let foundCharZone: Zone | null = null;
      const currentZoneIds = new Set<string>();

      zones.forEach(zone => {
        const dist = getDistance(currentPos[0], currentPos[1], zone.lat, zone.lng);
        const insideZone = dist < zone.radius;

        if (insideZone) {
          currentZoneIds.add(zone.id);

          // Zone entry event
          if (!prevZoneIdsRef.current.has(zone.id)) {
            const prereqMet = !zone.requires_zone_id || visitedZoneIdsRef.current.has(zone.requires_zone_id);
            const isLocked = zone.lock_type === 'passphrase' && !unlockedZoneIdsRef.current.has(zone.id);

            if (isLocked && prereqMet) {
              // Only show passphrase modal if none is already shown
              if (!passphraseChallengeRef.current) {
                passphraseChallengeRef.current = zone;
                setPassphraseChallenge(zone);
              }
            } else if (prereqMet) {
              visitedZoneIdsRef.current = new Set([...visitedZoneIdsRef.current, zone.id]);
              if (zone.entry_message && zone.type !== 'character') showHud(zone.title, zone.entry_message);
            }
          }

          // Only activate zone if it's accessible
          if (isZoneAccessible(zone)) {
            if (zone.type === 'character') {
              foundCharZone = zone;
            } else {
              let volume = zone.use_attenuation
                ? calculateAttenuation(dist, zone.radius)
                : 1.0;
              volume = volume * (zone.volume ?? 1.0);
              activeState.push({ title: zone.title, volume: Math.round(volume * 100) });
            }
          }
        }

        if (zone.type === 'audio') {
          let volume = 0;
          if (insideZone && isZoneAccessible(zone)) {
            volume = zone.use_attenuation ? calculateAttenuation(dist, zone.radius) : 1.0;
            volume = volume * (zone.volume ?? 1.0);
          }
          audioUpdates.push({
            id: zone.id,
            volume,
            loop: zone.on_end === 'loop',
            destroyOnEnd: zone.on_end === 'destroy',
          });
        }
      });

      prevZoneIdsRef.current = currentZoneIds;
      audioService.updateVolumes(audioUpdates);
      setActiveZones(activeState);

      if (foundCharZone?.id !== activeCharacterZone?.id) {
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
            }, 20000);
          }
        }
      }
    }, 200);

    return () => {
      clearInterval(interval);
      // Intentionally do NOT clear charZoneExitTimerRef here — the timer must
      // survive interval restarts that happen when userPos changes (sim dragging).
    };
  }, [audioStarted, userPos, zones, activeCharacterZone]);

  // GPS Watcher
  useEffect(() => {
    if (simulationMode) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const newPos: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserPos(newPos);
        simPosRef.current = newPos;
        setGpsError(null); // clear any previous error on successful fix
      },
      (err) => {
        console.error(err);
        if (err.code === err.PERMISSION_DENIED) {
          setGpsError('Location access was denied. Please enable location services and reload to play this experience.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setGpsError('Your location could not be determined. Please check your GPS signal and try again.');
        } else {
          setGpsError('Could not get your location. Please try again or check your device settings.');
        }
      },
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [simulationMode]);

  const loadTour = async (id: string) => {
    const t = await getTourById(id);
    if (!t) { navigate('/'); return; }
    setTour(t);
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
    await audioService.init();
    zones.filter(z => z.type === 'audio').forEach(z => audioService.loadAudio(z.id, z.media_url));
    setAudioStarted(true);
  };

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
          {!simulationMode && userPos && <MapRecenter lat={userPos[0]} lng={userPos[1]} />}

          {/* Zones */}
          {zones.map(zone => {
             const isActive = activeZones.find(az => az.title === zone.title) || (activeCharacterZone?.id === zone.id);
             if (!zone.is_visible && !simulationMode) return null;

             const isChar = zone.type === 'character';
             const isLocked = zone.lock_type === 'passphrase';

             let color = isChar ? '#6366f1' : (isActive ? '#34d399' : '#5b6b7c');
             if (isLocked) color = '#f59e0b';

             return (
              <React.Fragment key={zone.id}>
                <Circle
                  center={[zone.lat, zone.lng]}
                  radius={zone.radius}
                  pathOptions={{
                    color,
                    fillColor: color,
                    fillOpacity: isActive ? 0.3 : 0.1,
                    weight: isLocked ? 2 : (isChar ? 2 : 1),
                    dashArray: isLocked ? '6 4' : (zone.is_visible ? undefined : '4 4')
                  }}
                />
              </React.Fragment>
             );
          })}

          {/* User Marker — only render when we have an actual position */}
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
            className="fixed inset-0 z-[2000] overflow-hidden"
            style={{ backgroundColor: bg, fontFamily }}
          >
            {/* ── SCROLL AREA — full height, padded to clear fixed header + footer ── */}
            <div
              className="absolute inset-0 overflow-y-auto"
              style={{ scrollbarWidth: 'none', overscrollBehavior: 'none', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 90px)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 110px)' }}
            >
              <div className="w-full max-w-sm mx-auto px-5 flex flex-col items-center text-center gap-5 pb-4">

                {tour.welcome_image_url && (
                  <img src={tour.welcome_image_url} alt={tour.title} className="w-40 h-40 object-cover rounded-2xl shadow-2xl" />
                )}

                {tour.description && (
                  <p className="text-sm leading-relaxed opacity-80" style={{ color: textColor }}>{tour.description}</p>
                )}

                <div className="w-full aspect-square rounded-xl overflow-hidden border border-white/10 shadow-lg">
                  <MapContainer
                    center={[tour.lat, tour.lng]}
                    zoom={tour.start_zoom ?? 18}
                    style={{ width: '100%', height: '100%' }}
                    zoomControl={true}
                    scrollWheelZoom={true}
                    attributionControl={false}
                  >
                    <TileLayer url={mapStyle.url} />
                    <Marker position={[tour.lat, tour.lng]} icon={StartMarkerIcon} />
                    <InvalidateSize />
                  </MapContainer>
                </div>

                <button
                  onClick={copyCoords}
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-medium border border-white/10 transition-colors"
                  style={{ color: coordsCopied ? accent : textColor }}
                >
                  {coordsCopied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy start coordinates</>}
                </button>

                <p className="text-xs opacity-40" style={{ color: textColor }}>Headphones are recommended.</p>

              </div>
            </div>

            {/* ── HEADER — absolutely positioned, always on top, solid background ── */}
            <div
              className="absolute top-0 left-0 right-0 z-10 text-center"
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

            {/* ── FOOTER — absolutely positioned, always on top, solid background ── */}
            <div
              className="absolute bottom-0 left-0 right-0 z-10"
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
                <p className="text-sm leading-relaxed" style={{ color: th.sheetMuted }}>
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
                {coordsCopied ? <><Check size={14} /> Copied!</> : <><MapPin size={14} /> {tour.lat.toFixed(5)}, {tour.lng.toFixed(5)}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── FLOATING PANEL — Now Playing + Character card, centered above bottom bar ── */}
      {/* Hidden when chat is open — the chat sheet occupies the bottom of the screen */}
      {audioStarted && !showChat && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-[1500] flex flex-col items-end gap-2 w-full max-w-sm px-4"
          style={{ bottom: 'calc(104px + env(safe-area-inset-bottom, 0px))' }}
        >
          {/* Now Playing card */}
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
              <div className="flex items-center gap-2 mb-1.5">
                <Volume2 className="animate-pulse shrink-0" size={12} style={{ color: accent }} />
                <span className="font-bold uppercase text-[9px] tracking-widest" style={{ color: accent }}>Now Playing</span>
              </div>
              <div className="space-y-1">
                {activeZones.map((az, idx) => (
                  <div key={idx} className="flex justify-between items-center gap-3">
                    <span className="text-xs truncate" style={{ color: th.cardText }}>{az.title}</span>
                    <div className="w-16 h-1 rounded-full overflow-hidden shrink-0" style={{ backgroundColor: `${accent}33` }}>
                      <div className="h-full transition-all duration-300" style={{ width: `${az.volume}%`, backgroundColor: accent }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Character presence ─────────────────────────────────────────────
               Two states, one design language:
               • First entry (chatEverOpened=false): compact encounter card
               • After first chat (chatEverOpened=true): ambient presence orb
               Both use a pulsing ring to signal the character is "alive".   */}
          {activeCharacterZone && chatEverOpened ? (
            /* ── Ambient orb — appears after first conversation ── */
            <button
              onClick={() => setShowChat(true)}
              className="self-end flex flex-col items-center gap-1.5 animate-in zoom-in-75 duration-300"
              aria-label={`Continue with ${activeCharacterZone.title}`}
            >
              <div className="relative" style={{ width: 80, height: 80 }}>
                {/* Pulsing outer ring — "the being is present" */}
                <span
                  className="absolute inset-0 rounded-full animate-ping"
                  style={{ backgroundColor: accent, opacity: 0.25 }}
                />
                {/* Avatar orb */}
                <div
                  className="absolute inset-0 rounded-full overflow-hidden shadow-2xl"
                  style={{ border: `2px solid ${accent}`, boxShadow: `0 0 20px ${accent}55` }}
                >
                  {activeCharacterZone.character_image_url
                    ? <img src={activeCharacterZone.character_image_url} alt={activeCharacterZone.title} className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: `${accent}30` }}><Mic size={22} color={accent} /></div>
                  }
                </div>
              </div>
              <span className="text-xs font-semibold tracking-wide" style={{ color: accent }}>
                {activeCharacterZone.title}
              </span>
            </button>

          ) : activeCharacterZone ? (
            /* ── Encounter card — first appearance in zone ── */
            <div
              className="w-full rounded-2xl animate-in slide-in-from-bottom-4 duration-400"
              style={{
                backgroundColor: th.cardBg,
                border: `1px solid ${accent}40`,
                backdropFilter: 'blur(20px)',
                boxShadow: `0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px ${accent}20`,
              }}
            >
              {/* Avatar + pulse ring */}
              <div className="flex flex-col items-center pt-6 pb-2">
                <div className="relative mb-3" style={{ width: 88, height: 88 }}>
                  <span
                    className="absolute inset-0 rounded-full animate-ping"
                    style={{ backgroundColor: accent, opacity: 0.2 }}
                  />
                  <div
                    className="absolute inset-0 rounded-full overflow-hidden shadow-xl"
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
                  <p className="text-xs mt-1.5 text-center px-6 leading-relaxed" style={{ color: th.cardMuted }}>
                    {activeCharacterZone.character_bio || activeCharacterZone.description}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="px-4 pt-2 pb-5 flex gap-2">
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

      {/* ── HUD NOTIFICATION — drops below top bar ── */}
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
              onClick={() => { audioService.stopAll(); setAudioStarted(false); }}
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
                  {Object.entries(MAP_STYLES).map(([key, val]) => {
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