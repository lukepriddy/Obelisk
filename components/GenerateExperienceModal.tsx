/**
 * GenerateExperienceModal
 *
 * Three-phase flow:
 *   input     → Search sets start pin · drag pins to fine-tune · optional end pin
 *   generating → Animated progress while edge function runs
 *   review    → Draft zone cards + mini-map + feedback/refine loop → Build
 *
 * Interaction grammar: search gets you close, zoom gets you closer,
 * drag is the only thing that moves a pin. Map clicks do nothing.
 */

import React, { useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  X, Search, MapPin, FileText, Sparkles, ChevronDown, ChevronUp,
  Volume2, Mic, Lock, ArrowLeft, Loader2, RefreshCw, Wand2,
  Upload, Trash2, CheckCircle2, Plus,
} from 'lucide-react';
import { supabase } from '../services/supabaseClient';
import { createTour, createZone } from '../services/db';
import { MAP_STYLES } from '../constants';

// ── Draft types ───────────────────────────────────────────────────────────────

interface DraftZone {
  order: number;
  title: string;
  type: 'audio' | 'character';
  locked: boolean;
  lat: number;
  lng: number;
  radius: number;
  location_name: string;
  description: string;
  entry_message: string | null;
  character_prompt: string | null;
  character_bio: string | null;
  greeting_message: string | null;
  voice_style: string | null;
  lock_hint: string | null;
  lock_passphrase: string | null;
}

interface ExperienceDraft {
  title: string;
  subtitle: string;
  description: string;
  summary: string;
  zones: DraftZone[];
}

interface Props {
  userId: string;
  onClose: () => void;
  onBuilt: (tourId: string) => void;
}

type Phase = 'input' | 'generating' | 'review';

// ── Leaflet icons ─────────────────────────────────────────────────────────────

const makePin = (label: string, color: string) => L.divIcon({
  html: `<div style="background:${color};width:28px;height:28px;border-radius:50%;border:3px solid white;
    box-shadow:0 2px 10px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;cursor:grab;">
    <span style="color:white;font-size:11px;font-weight:900;line-height:1">${label}</span></div>`,
  className: '', iconSize: [28, 28], iconAnchor: [14, 14],
});

const startIcon = makePin('S', '#10b981');
const endIcon   = makePin('E', '#6366f1');

const zoneMarkerIcon = (num: number, type: 'audio' | 'character', locked: boolean) => L.divIcon({
  html: `<div style="background:${locked ? '#f59e0b' : type === 'character' ? '#6366f1' : '#10b981'};
    width:26px;height:26px;border-radius:50%;border:2px solid white;
    box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
    <span style="color:white;font-size:11px;font-weight:900;line-height:1">${num}</span></div>`,
  className: '', iconSize: [26, 26], iconAnchor: [13, 13],
});

// ── Map helpers ───────────────────────────────────────────────────────────────

const FlyTo: React.FC<{ lat: number; lng: number; zoom?: number }> = ({ lat, lng, zoom = 16 }) => {
  const map = useMap();
  React.useEffect(() => { map.flyTo([lat, lng], zoom, { duration: 1.1 }); }, [lat, lng]); // eslint-disable-line
  return null;
};

// Captures the Leaflet map instance so the form can read the current center
const MapRefCapture: React.FC<{ mapRef: React.MutableRefObject<L.Map | null> }> = ({ mapRef }) => {
  const map = useMap();
  React.useEffect(() => { mapRef.current = map; }, [map, mapRef]);
  return null;
};

// ── Generating steps ──────────────────────────────────────────────────────────

const STEPS = [
  'Scanning the area for locations…',
  'Researching local history…',
  'Reading your brief…',
  'Crafting the narrative arc…',
  'Placing characters and zones…',
  'Finalizing your experience…',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Display distances in US units; meters stay internal (Overpass + zone radii use meters)
const formatDistance = (meters: number) => {
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
  return `${(meters / 1609.34).toFixed(1)} mi`;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const zoneTypeColor = (type: 'audio' | 'character', locked: boolean) =>
  locked ? 'text-amber-400 bg-amber-400/10 border-amber-400/30'
  : type === 'character' ? 'text-indigo-400 bg-indigo-400/10 border-indigo-400/30'
  : 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30';

const ZoneTypeIcon: React.FC<{ type: 'audio' | 'character'; locked: boolean; size?: number }> = ({ type, locked, size = 13 }) =>
  locked ? <Lock size={size} /> : type === 'character' ? <Mic size={size} /> : <Volume2 size={size} />;

// ── Main component ────────────────────────────────────────────────────────────

export const GenerateExperienceModal: React.FC<Props> = ({ userId, onClose, onBuilt }) => {
  // ── Phase ────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('input');

  // ── Input ────────────────────────────────────────────────────────────────
  const [startPin, setStartPin]     = useState<[number, number] | null>(null);
  const [startLabel, setStartLabel] = useState('');
  const [endPin, setEndPin]         = useState<[number, number] | null>(null);
  const [flyTarget, setFlyTarget]   = useState<[number, number] | null>(null);
  const [brief, setBrief]           = useState('');
  const [pdfFile, setPdfFile]       = useState<File | null>(null);
  const [radiusMeters, setRadiusMeters] = useState(500);
  const pdfInputRef                 = useRef<HTMLInputElement>(null);
  const mapRef                      = useRef<L.Map | null>(null);

  // ── Start search ─────────────────────────────────────────────────────────
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState<any[]>([]);
  const [searching, setSearching]   = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const debounceRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Review ───────────────────────────────────────────────────────────────
  const [draft, setDraft]           = useState<ExperienceDraft | null>(null);
  const [feedback, setFeedback]     = useState('');
  const [refining, setRefining]     = useState(false);
  const [building, setBuilding]     = useState(false);
  const [expandedZone, setExpandedZone] = useState<number | null>(null);

  // ── Shared ───────────────────────────────────────────────────────────────
  const [error, setError]           = useState<string | null>(null);
  const [genStep, setGenStep]       = useState(0);
  const stepTimerRef                = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Search → sets the start pin ──────────────────────────────────────────
  const runSearch = async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
        { headers: { 'Accept-Language': 'en' } }
      );
      setResults(await res.json());
      setDropdownOpen(true);
    } catch {}
    setSearching(false);
  };

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length > 2) {
      debounceRef.current = setTimeout(() => runSearch(v), 400);
    } else {
      setResults([]);
    }
  };

  const pickResult = (r: any) => {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lon);
    const shortName = r.display_name.split(',').slice(0, 2).join(',').trim();
    setStartPin([lat, lng]);
    setStartLabel(shortName);
    setFlyTarget([lat, lng]);
    setQuery('');
    setResults([]);
    setDropdownOpen(false);
  };

  const clearStart = () => {
    setStartPin(null);
    setStartLabel('');
  };

  // ── End pin: dropped at current map center, then dragged ─────────────────
  const addEndPin = () => {
    const m = mapRef.current;
    if (m) {
      const c = m.getCenter();
      setEndPin([c.lat, c.lng]);
    } else if (startPin) {
      setEndPin([startPin[0] + 0.0012, startPin[1] + 0.0012]);
    }
  };

  // ── Generate ─────────────────────────────────────────────────────────────
  const generate = async () => {
    if (!startPin) return;
    setError(null);
    setPhase('generating');
    setGenStep(0);

    stepTimerRef.current = setInterval(() => {
      setGenStep(prev => Math.min(prev + 1, STEPS.length - 1));
    }, 3200);

    try {
      let pdfBase64: string | undefined;
      let pdfMimeType: string | undefined;
      if (pdfFile) {
        pdfBase64   = await fileToBase64(pdfFile);
        pdfMimeType = pdfFile.type || 'application/pdf';
      }

      const { data, error: fnError } = await supabase.functions.invoke('generate-experience', {
        body: {
          type: 'generate',
          startLat: startPin[0],
          startLng: startPin[1],
          endLat:   endPin?.[0],
          endLng:   endPin?.[1],
          radiusMeters,
          brief: brief.trim() || undefined,
          pdfBase64,
          pdfMimeType,
        },
      });

      clearInterval(stepTimerRef.current!);

      if (fnError || !data?.draft) {
        setError('Generation failed — please try again. If you pasted a lot of text, try a shorter brief.');
        setPhase('input');
        return;
      }

      setDraft(data.draft as ExperienceDraft);
      setPhase('review');
    } catch {
      clearInterval(stepTimerRef.current!);
      setError('Something went wrong — please try again.');
      setPhase('input');
    }
  };

  // ── Refine ───────────────────────────────────────────────────────────────
  const refine = async () => {
    if (!draft || !feedback.trim()) return;
    setRefining(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('generate-experience', {
        body: { type: 'refine', draft, feedback: feedback.trim() },
      });

      if (fnError || !data?.draft) {
        setError('Refinement failed — please try again.');
      } else {
        setDraft(data.draft as ExperienceDraft);
        setFeedback('');
        setExpandedZone(null);
      }
    } catch {
      setError('Something went wrong — please try again.');
    }

    setRefining(false);
  };

  // ── Build ─────────────────────────────────────────────────────────────────
  const buildExperience = async () => {
    if (!draft || !startPin) return;
    setBuilding(true);
    setError(null);

    const sortedZones = [...draft.zones].sort((a, b) => a.order - b.order);
    const tourLat = sortedZones[0]?.lat ?? startPin[0];
    const tourLng = sortedZones[0]?.lng ?? startPin[1];

    const tour = await createTour({
      owner_id:  userId,
      title:     draft.title,
      description: draft.description,
      welcome_subtitle: draft.subtitle || undefined,
      is_public: false,
      lat: tourLat,
      lng: tourLng,
    });

    if (!tour) {
      setError('Failed to create experience — please try again.');
      setBuilding(false);
      return;
    }

    for (const dz of sortedZones) {
      await createZone({
        tour_id:    tour.id,
        title:      dz.title,
        type:       dz.type,
        lat:        dz.lat,
        lng:        dz.lng,
        radius:     dz.radius,
        description: dz.description ?? '',
        entry_message: dz.entry_message ?? undefined,
        is_visible:  true,
        character_prompt:  dz.character_prompt  ?? undefined,
        character_bio:     dz.character_bio     ?? undefined,
        greeting_message:  dz.greeting_message  ?? undefined,
        voice_style:       dz.voice_style       ?? undefined,
        lock_type:         dz.locked ? 'passphrase' : 'none',
        lock_hint:         dz.lock_hint         ?? undefined,
        lock_passphrase:   dz.lock_passphrase   ?? undefined,
      });
    }

    onBuilt(tour.id);
  };

  const mapTile = MAP_STYLES.satellite;

  // ────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[3000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 md:p-6">
      <div className="w-full h-full md:h-auto md:max-h-[92vh] md:max-w-2xl bg-zinc-950 md:rounded-2xl border border-zinc-800 shadow-2xl flex flex-col overflow-hidden">

        {/* ── HEADER ── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-800 shrink-0">
          {phase === 'review' && (
            <button
              onClick={() => { setPhase('input'); setDraft(null); setError(null); }}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors mr-1"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
            <Sparkles size={15} className="text-indigo-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-white text-base leading-tight">
              {phase === 'review' ? draft?.title || 'Review Draft' : 'Generate Experience'}
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {phase === 'input'      && 'Search your start location, then drag pins to fine-tune'}
              {phase === 'generating' && 'Building your experience…'}
              {phase === 'review'     && 'Review zones, give feedback, then build'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── ERROR BANNER ── */}
        {error && (
          <div className="mx-5 mt-4 bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3 rounded-xl shrink-0">
            {error}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            INPUT PHASE
        ══════════════════════════════════════════════════════════════════ */}
        {phase === 'input' && (
          <>
            <div className="flex-1 overflow-y-auto">

              {/* ── Start location search (above the map, not on it) ── */}
              <div className="px-5 pt-5 pb-3">
                <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  Start location
                </label>

                {startPin ? (
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-emerald-500/50 bg-emerald-500/10">
                    <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                    <span className="text-sm font-medium flex-1 truncate text-emerald-300">{startLabel || 'Start point'}</span>
                    <span className="text-[10px] text-emerald-500/70 shrink-0 hidden sm:block">drag pin to fine-tune</span>
                    <button
                      onClick={clearStart}
                      className="text-zinc-500 hover:text-zinc-200 transition-colors shrink-0 p-0.5"
                      aria-label="Clear start location"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 focus-within:border-zinc-600 rounded-xl px-3 py-2.5 transition-colors">
                      <Search size={14} className="text-zinc-500 shrink-0" />
                      <input
                        value={query}
                        onChange={handleQueryChange}
                        onKeyDown={e => e.key === 'Enter' && runSearch(query)}
                        onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
                        onFocus={() => results.length > 0 && setDropdownOpen(true)}
                        placeholder="Search address or place — e.g. Washington Square Park"
                        className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none"
                        autoFocus
                      />
                      {searching && <Loader2 size={13} className="animate-spin text-zinc-500 shrink-0" />}
                    </div>

                    {dropdownOpen && results.length > 0 && (
                      <div className="absolute z-[900] top-full mt-1 left-0 right-0 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden max-h-52 overflow-y-auto">
                        {results.map((r: any, i: number) => (
                          <button
                            key={i}
                            onMouseDown={() => pickResult(r)}
                            className="w-full text-left px-3 py-2.5 text-xs text-zinc-300 hover:bg-zinc-800 border-b border-zinc-800 last:border-0 leading-relaxed"
                          >
                            <span className="line-clamp-1">{r.display_name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Map: pan, zoom, drag pins. Clicks do nothing. ── */}
              <div className="px-5">
                <div className="rounded-xl overflow-hidden border border-zinc-800 relative" style={{ height: 340 }}>
                  <MapContainer
                    center={startPin ?? [40.748, -73.986]}
                    zoom={startPin ? 16 : 3}
                    style={{ height: '100%', width: '100%' }}
                  >
                    <TileLayer url={mapTile.url} attribution={mapTile.attribution} maxNativeZoom={19} maxZoom={22} />
                    <MapRefCapture mapRef={mapRef} />
                    {flyTarget && <FlyTo lat={flyTarget[0]} lng={flyTarget[1]} zoom={16} />}

                    {startPin && (
                      <>
                        <Marker
                          position={startPin}
                          icon={startIcon}
                          draggable
                          eventHandlers={{
                            dragend: (e: any) => {
                              const ll = e.target.getLatLng();
                              setStartPin([ll.lat, ll.lng]);
                            },
                          }}
                        />
                        <Circle
                          center={startPin}
                          radius={radiusMeters}
                          pathOptions={{ color: '#10b981', fillColor: '#10b981', fillOpacity: 0.07, weight: 1.5, dashArray: '6 4' }}
                        />
                      </>
                    )}

                    {endPin && (
                      <Marker
                        position={endPin}
                        icon={endIcon}
                        draggable
                        eventHandlers={{
                          dragend: (e: any) => {
                            const ll = e.target.getLatLng();
                            setEndPin([ll.lat, ll.lng]);
                          },
                        }}
                      />
                    )}
                  </MapContainer>

                  {/* Pre-search empty state */}
                  {!startPin && (
                    <div className="absolute inset-0 z-[700] flex items-center justify-center pointer-events-none bg-black/30">
                      <div className="bg-zinc-900/90 backdrop-blur border border-zinc-700 rounded-2xl px-5 py-3 text-center shadow-xl">
                        <p className="text-white font-semibold text-sm">Search for your start location above</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* End point row */}
                <div className="flex items-center gap-3 mt-3">
                  {endPin ? (
                    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-indigo-500/50 bg-indigo-500/10 flex-1 min-w-0">
                      <CheckCircle2 size={14} className="text-indigo-400 shrink-0" />
                      <span className="text-sm font-medium text-indigo-300 truncate">End point placed</span>
                      <span className="text-[10px] text-indigo-400/60 shrink-0 hidden sm:block">drag pin to fine-tune</span>
                      <button
                        onClick={() => setEndPin(null)}
                        className="ml-auto text-zinc-500 hover:text-zinc-200 transition-colors shrink-0 p-0.5"
                        aria-label="Remove end point"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={addEndPin}
                      disabled={!startPin}
                      className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Plus size={14} className="text-indigo-400" />
                      Add end point
                      <span className="text-[10px] text-zinc-600 font-normal">optional</span>
                    </button>
                  )}
                </div>

                {startPin && (
                  <p className="text-[11px] text-zinc-600 mt-2">
                    Zoom in and drag the pins to set exact spots.
                    {!endPin && ' Adding an end point drops a pin at the center of the map view.'}
                  </p>
                )}
              </div>

              <div className="px-5 pb-5 mt-5 flex flex-col gap-5">

                {/* Radius */}
                <div>
                  <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                    Search radius — <span className="text-zinc-300">{formatDistance(radiusMeters)}</span>
                    <span className="text-zinc-600 font-normal normal-case ml-1">(shown as circle on map)</span>
                  </label>
                  <input
                    type="range" min={200} max={2000} step={100}
                    value={radiusMeters}
                    onChange={e => setRadiusMeters(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                    <span>{formatDistance(200)}</span><span>Walking distance</span><span>{formatDistance(2000)}</span>
                  </div>
                </div>

                {/* Brief */}
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      Brief <span className="text-zinc-600 font-normal normal-case">(optional — theme, characters, tone, story beats)</span>
                    </label>
                    <span className={`text-[10px] tabular-nums ml-2 shrink-0 ${brief.length > 2800 ? 'text-amber-400' : 'text-zinc-600'}`}>
                      {brief.length}/3000
                    </span>
                  </div>
                  <textarea
                    value={brief}
                    onChange={e => setBrief(e.target.value.slice(0, 3000))}
                    rows={4}
                    placeholder="e.g. A ghost tour of Victorian Dublin focused on the 1916 Rising. Main character is a spectral journalist named Eileen. Atmospheric and melancholy in tone…"
                    className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-zinc-600 resize-none placeholder-zinc-600 leading-relaxed"
                  />
                </div>

                {/* PDF */}
                <div>
                  <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                    Reference document <span className="text-zinc-600 font-normal normal-case">(optional — script, research, character bible…)</span>
                  </label>
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept=".pdf,application/pdf,.doc,.docx,text/plain"
                    className="hidden"
                    onChange={e => setPdfFile(e.target.files?.[0] ?? null)}
                  />
                  {pdfFile ? (
                    <div className="flex items-center gap-3 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3">
                      <FileText size={16} className="text-indigo-400 shrink-0" />
                      <span className="text-sm text-zinc-300 flex-1 truncate">{pdfFile.name}</span>
                      <button
                        onClick={() => { setPdfFile(null); if (pdfInputRef.current) pdfInputRef.current.value = ''; }}
                        className="text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => pdfInputRef.current?.click()}
                      className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-600 text-zinc-400 hover:text-zinc-200 rounded-xl px-4 py-3 text-sm transition-colors"
                    >
                      <Upload size={14} />
                      Upload PDF or document
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-zinc-800 shrink-0">
              <button
                onClick={generate}
                disabled={!startPin}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg"
              >
                <Sparkles size={16} />
                Generate Experience
              </button>
              {!startPin && (
                <p className="text-center text-xs text-zinc-600 mt-2">Set a start location to continue</p>
              )}
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            GENERATING PHASE
        ══════════════════════════════════════════════════════════════════ */}
        {phase === 'generating' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8 py-16">
            <div className="relative w-20 h-20">
              <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20 animate-ping" />
              <div className="absolute inset-2 rounded-full border-2 border-indigo-400/30 animate-ping" style={{ animationDelay: '0.4s' }} />
              <div className="absolute inset-0 rounded-full flex items-center justify-center">
                <Sparkles size={28} className="text-indigo-400 animate-pulse" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-white font-semibold text-base mb-1">{STEPS[genStep]}</p>
              <div className="flex items-center justify-center gap-1.5 mt-3">
                {STEPS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1 rounded-full transition-all duration-500 ${
                      i <= genStep ? 'bg-indigo-500 w-6' : 'bg-zinc-700 w-3'
                    }`}
                  />
                ))}
              </div>
            </div>
            <p className="text-zinc-600 text-xs text-center max-w-xs">
              Researching real local history and crafting your narrative. This usually takes 20–40 seconds.
            </p>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            REVIEW PHASE
        ══════════════════════════════════════════════════════════════════ */}
        {phase === 'review' && draft && (
          <>
            <div className="flex-1 overflow-y-auto">

              {/* Summary */}
              <div className="px-5 pt-5 pb-3">
                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                  <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-1">AI Summary</p>
                  <p className="text-sm text-zinc-300 leading-relaxed">{draft.summary}</p>
                  {draft.subtitle && (
                    <p className="text-xs text-zinc-500 mt-2 italic">"{draft.subtitle}"</p>
                  )}
                  <div className="flex items-center gap-3 mt-3 pt-3 border-t border-zinc-800">
                    <span className="text-xs text-zinc-500">{draft.zones.length} zones</span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-xs text-zinc-500">
                      {draft.zones.filter(z => z.type === 'character').length} characters
                    </span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-xs text-zinc-500">
                      {draft.zones.filter(z => z.locked).length} locked
                    </span>
                  </div>
                </div>
              </div>

              {/* Mini-map */}
              {draft.zones.length > 0 && (
                <div className="px-5 pb-3">
                  <div className="rounded-xl overflow-hidden border border-zinc-800" style={{ height: 200 }}>
                    <MapContainer
                      center={[draft.zones[0].lat, draft.zones[0].lng]}
                      zoom={15}
                      style={{ height: '100%', width: '100%' }}
                      zoomControl={false}
                      scrollWheelZoom={false}
                      dragging={false}
                      attributionControl={false}
                    >
                      <TileLayer url={mapTile.url} maxNativeZoom={19} maxZoom={22} />
                      {startPin && <Marker position={startPin} icon={startIcon} />}
                      {endPin   && <Marker position={endPin}   icon={endIcon}   />}
                      {draft.zones.map(z => (
                        <React.Fragment key={z.order}>
                          <Marker position={[z.lat, z.lng]} icon={zoneMarkerIcon(z.order, z.type, z.locked)} />
                          <Circle
                            center={[z.lat, z.lng]}
                            radius={z.radius}
                            pathOptions={{
                              color: z.locked ? '#f59e0b' : z.type === 'character' ? '#6366f1' : '#10b981',
                              fillOpacity: 0.12, weight: 1,
                            }}
                          />
                        </React.Fragment>
                      ))}
                    </MapContainer>
                  </div>
                </div>
              )}

              {/* Zone cards */}
              <div className="px-5 pb-3 flex flex-col gap-2">
                <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Zones</p>
                {[...draft.zones].sort((a, b) => a.order - b.order).map(zone => {
                  const isOpen = expandedZone === zone.order;
                  const colorClass = zoneTypeColor(zone.type, zone.locked);
                  return (
                    <div key={zone.order} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setExpandedZone(isOpen ? null : zone.order)}
                        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition-colors"
                      >
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5 border ${colorClass}`}>
                          {zone.order}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-white text-sm">{zone.title}</span>
                            <span className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${colorClass}`}>
                              <ZoneTypeIcon type={zone.type} locked={zone.locked} size={9} />
                              {zone.locked ? 'Locked' : zone.type}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 mt-0.5 truncate">{zone.location_name}</p>
                          {!isOpen && (
                            <p className="text-xs text-zinc-400 mt-1 line-clamp-2 leading-relaxed">{zone.description}</p>
                          )}
                        </div>
                        {isOpen
                          ? <ChevronUp size={14} className="text-zinc-500 shrink-0 mt-1" />
                          : <ChevronDown size={14} className="text-zinc-500 shrink-0 mt-1" />}
                      </button>

                      {isOpen && (
                        <div className="px-4 pb-4 pt-1 border-t border-zinc-800 space-y-3">
                          <div>
                            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Description</p>
                            <p className="text-xs text-zinc-300 leading-relaxed">{zone.description}</p>
                          </div>
                          {zone.entry_message && (
                            <div>
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Entry message</p>
                              <p className="text-xs text-zinc-400 italic">"{zone.entry_message}"</p>
                            </div>
                          )}
                          {zone.character_prompt && (
                            <div>
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Character prompt</p>
                              <p className="text-xs text-zinc-300 leading-relaxed">{zone.character_prompt}</p>
                            </div>
                          )}
                          {zone.character_bio && (
                            <div>
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Player-facing bio</p>
                              <p className="text-xs text-zinc-400">{zone.character_bio}</p>
                            </div>
                          )}
                          {zone.greeting_message && (
                            <div>
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Opening line</p>
                              <p className="text-xs text-zinc-400 italic">"{zone.greeting_message}"</p>
                            </div>
                          )}
                          {zone.voice_style && (
                            <div>
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Voice</p>
                              <p className="text-xs text-zinc-400">{zone.voice_style}</p>
                            </div>
                          )}
                          {zone.locked && (
                            <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-3 space-y-1.5">
                              {zone.lock_hint && (
                                <div>
                                  <p className="text-[10px] font-bold text-amber-400/70 uppercase tracking-wider mb-0.5">Hint</p>
                                  <p className="text-xs text-amber-300/80 italic">"{zone.lock_hint}"</p>
                                </div>
                              )}
                              {zone.lock_passphrase && (
                                <div>
                                  <p className="text-[10px] font-bold text-amber-400/70 uppercase tracking-wider mb-0.5">Passphrase</p>
                                  <p className="text-xs text-amber-300 font-mono">{zone.lock_passphrase}</p>
                                </div>
                              )}
                            </div>
                          )}
                          <div className="flex gap-4 pt-1">
                            <div>
                              <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-wider">Coords</p>
                              <p className="text-[10px] text-zinc-500 font-mono">{zone.lat.toFixed(5)}, {zone.lng.toFixed(5)}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-wider">Radius</p>
                              <p className="text-[10px] text-zinc-500">{formatDistance(zone.radius)}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Feedback */}
              <div className="px-5 pb-6">
                <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Request changes</p>
                <div className="flex gap-2">
                  <textarea
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    rows={2}
                    placeholder="e.g. Make zone 3 a character instead of audio. Give the detective a grittier voice. Add a passphrase zone near the end."
                    disabled={refining}
                    className="flex-1 bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-zinc-600 resize-none placeholder-zinc-600 leading-relaxed disabled:opacity-50"
                  />
                  <button
                    onClick={refine}
                    disabled={!feedback.trim() || refining}
                    className="flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    {refining ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                    {refining ? 'Updating' : 'Refine'}
                  </button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-zinc-800 shrink-0 flex gap-3">
              <button
                onClick={() => { setPhase('input'); setDraft(null); setError(null); }}
                className="px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-semibold transition-colors"
              >
                Start over
              </button>
              <button
                onClick={buildExperience}
                disabled={building}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl font-bold text-sm bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {building ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                {building ? 'Building…' : 'Build Experience'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
