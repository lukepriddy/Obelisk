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

import React, { useState, useRef, useEffect } from 'react';
import { GeneratePickerMap, GeneratePreviewMap, PickerHandle } from './GenerateMaps';
import {
  X, Search, MapPin, FileText, Sparkles, ChevronDown, ChevronUp,
  Volume2, Mic, Lock, ArrowLeft, Loader2, RefreshCw, Wand2,
  Upload, Trash2, CheckCircle2, Plus,
} from 'lucide-react';
import { supabase } from '../services/supabaseClient';
import { createTour, createZone, updateZone } from '../services/db';

// ── Draft types ───────────────────────────────────────────────────────────────

interface DraftZone {
  order: number;
  title: string;
  /** 'discoverable' only ever comes from an import: a collectible the player
   *  picks up. Generate produces audio and character zones only. */
  type: 'audio' | 'character' | 'discoverable';
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
  voice_instructions: string | null;
  lock_hint: string | null;
  lock_passphrase: string | null;

  // ── Import only ──────────────────────────────────────────────────────────
  /** The creator's own words, sliced out of their document on the server.
   *  Present only on imports; never touched by the model. */
  script?: string;
  /** Which of the fields above the model wrote, so the UI can mark them. */
  generated_fields?: string[];
  /** Where the coordinates came from. */
  placement?: 'from_document' | 'interpolated' | 'laid_out';
  /** Reads as a character even though imports land on audio. */
  suggested_type?: 'audio' | 'character' | 'discoverable';
  type_is_explicit?: boolean;
  speaker_name?: string | null;
  source_lines?: [number, number];

  // Settings taken from instructions written into the script. Null means the
  // script did not ask, so the zone keeps its default.
  on_end?: 'loop' | 'stop' | 'destroy' | null;
  on_exit?: 'pause' | 'stop' | 'keep' | null;
  is_visible?: boolean | null;
  is_mystery?: boolean | null;
  rewards?: { resource_id: string; amount: number }[];
  requirements?: { resource_id: string; amount: number; consume: boolean }[];
  /** Points at a zone NUMBER. Resolved to a real id after the zones exist. */
  requires_zone_order?: number | null;
  /** Plain-language list of what was applied, for the review screen. */
  applied_settings?: string[];
}

interface ImportResource {
  id: string;
  name: string;
  description: string;
}

/** How the model read the document, shown so the creator can correct the
 *  reasoning rather than fixing twenty zones one at a time. */
interface ImportReading {
  convention: string;
  interpretation: string;
  mechanics: string[];
  speakers: { name: string; description: string; zones: number }[];
}

interface SetAsideBlock {
  kind: string;
  label: string;
  lines: [number, number];
  text: string;
}

interface ExperienceDraft {
  title: string;
  subtitle: string;
  description: string;
  summary: string;
  zones: DraftZone[];
  // Import only.
  reading?: ImportReading;
  resources?: ImportResource[];
  set_aside?: SetAsideBlock[];
  flags?: string[];
}

interface Props {
  userId: string;
  onClose: () => void;
  onBuilt: (tourId: string) => void;
}

type Phase = 'input' | 'generating' | 'review';

/**
 * Two different jobs behind one modal.
 *
 * 'generate' invents an experience from a brief and the map around you.
 * 'import' takes a script that is already written and does the tedious part:
 * cutting it into zones, filling in the scaffolding, dropping pins. Import is
 * the default because it is the one that saves a week of work.
 */
type Mode = 'import' | 'generate';

// ── Generating steps ──────────────────────────────────────────────────────────

const STEPS = [
  'Scanning the area for locations…',
  'Researching local history…',
  'Reading your brief…',
  'Crafting the narrative arc…',
  'Placing characters and zones…',
  'Finalizing your experience…',
];

const IMPORT_STEPS = [
  'Reading your script end to end…',
  'Working out how it is sectioned…',
  'Finding the speakers…',
  'Cutting it into zones…',
  'Writing the parts you left blank…',
  'Placing the zones…',
];

/** Matches the editor's own cap on a voiceover script. */
const MAX_SCRIPT_CHARS = 10000;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Display distances in US units; meters stay internal (Overpass + zone radii use meters).
// Feet all the way to a mile: a walking experience lives well inside that range,
// and "1,050 ft" is a distance you can picture where "0.2 mi" is not.
const formatDistance = (meters: number) => {
  const feet = meters * 3.28084;
  if (feet < 100)  return `${Math.round(feet)} ft`;
  if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
  if (feet < 5280) return `${(Math.round(feet / 50) * 50).toLocaleString()} ft`;
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

const zoneTypeColor = (type: DraftZone['type'], locked: boolean) =>
  locked ? 'text-amber-400 bg-amber-400/10 border-amber-400/30'
  : type === 'character' ? 'text-indigo-400 bg-indigo-400/10 border-indigo-400/30'
  : type === 'discoverable' ? 'text-violet-400 bg-violet-400/10 border-violet-400/30'
  : 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30';

const ZoneTypeIcon: React.FC<{ type: DraftZone['type']; locked: boolean; size?: number }> = ({ type, locked, size = 13 }) =>
  locked ? <Lock size={size} />
  : type === 'character' ? <Mic size={size} />
  : type === 'discoverable' ? <Sparkles size={size} />
  : <Volume2 size={size} />;

// ── Main component ────────────────────────────────────────────────────────────

export const GenerateExperienceModal: React.FC<Props> = ({ userId, onClose, onBuilt }) => {
  // ── Phase ────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('input');
  const [mode, setMode]   = useState<Mode>('import');

  // ── Import ───────────────────────────────────────────────────────────────
  const [docText, setDocText]   = useState('');
  // Zone size for laid-out zones. Defaults to 10 m because the creator's own
  // hand-built experiences average 6 to 7 m, not the 15 to 40 a generated one
  // uses. A [[radius: n]] in the script overrides it per zone.
  const [zoneRadius, setZoneRadius] = useState(10);
  const [isImport, setIsImport] = useState(false);
  const docInputRef             = useRef<HTMLInputElement>(null);

  // ── Input ────────────────────────────────────────────────────────────────
  const [startPin, setStartPin]     = useState<[number, number] | null>(null);
  const [startLabel, setStartLabel] = useState('');
  const [endPin, setEndPin]         = useState<[number, number] | null>(null);
  const [flyTarget, setFlyTarget]   = useState<[number, number] | null>(null);
  const [brief, setBrief]           = useState('');
  const [pdfFile, setPdfFile]       = useState<File | null>(null);
  const [radiusMeters, setRadiusMeters] = useState(500);
  const pdfInputRef                 = useRef<HTMLInputElement>(null);
  const mapRef                      = useRef<PickerHandle | null>(null);

  // Fly the picker to a freshly searched location.
  useEffect(() => {
    if (flyTarget) mapRef.current?.flyTo(flyTarget[0], flyTarget[1], 16);
  }, [flyTarget]);

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
    const c = mapRef.current?.getCenter();
    if (c) {
      setEndPin([c[0], c[1]]);
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
        setError('Generation failed. Please try again, and if you pasted a lot of text, try a shorter brief.');
        setPhase('input');
        return;
      }

      setDraft(data.draft as ExperienceDraft);
      setPhase('review');
    } catch {
      clearInterval(stepTimerRef.current!);
      setError('Something went wrong. Please try again.');
      setPhase('input');
    }
  };

  // ── Import ───────────────────────────────────────────────────────────────
  const runImport = async () => {
    if (docText.trim().length < 40) return;
    setError(null);
    setPhase('generating');
    setGenStep(0);

    stepTimerRef.current = setInterval(() => {
      setGenStep(prev => Math.min(prev + 1, IMPORT_STEPS.length - 1));
    }, 3600);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('generate-experience', {
        body: {
          type: 'import',
          document: docText,
          // Only used for scripts with no coordinates of their own. Where the
          // creator wrote coordinates, those win.
          startLat: startPin?.[0],
          startLng: startPin?.[1],
          endLat: endPin?.[0],
          endLng: endPin?.[1],
          defaultRadius: zoneRadius,
        },
      });

      clearInterval(stepTimerRef.current!);

      if (fnError || !data?.draft) {
        // The edge function returns a specific message for the cases a creator
        // can act on — no start point, nothing that reads as zone content, a
        // script too long for one pass. Prefer it over a generic apology.
        const fromFn = (data as { error?: string } | null)?.error;
        setError(fromFn || 'Import failed. Please try again.');
        setPhase('input');
        return;
      }

      setDraft(data.draft as ExperienceDraft);
      setIsImport(true);
      setPhase('review');
    } catch {
      clearInterval(stepTimerRef.current!);
      setError('Something went wrong. Please try again.');
      setPhase('input');
    }
  };

  const loadDocFile = async (file: File) => {
    const text = await file.text();
    setDocText(text);
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
        setError('Refinement failed. Please try again.');
      } else {
        setDraft(data.draft as ExperienceDraft);
        setFeedback('');
        setExpandedZone(null);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    }

    setRefining(false);
  };

  // ── Build ─────────────────────────────────────────────────────────────────
  const buildExperience = async () => {
    // An imported script may carry its own coordinates, in which case no start
    // pin was ever needed — so the pin is only required for generation.
    if (!draft || (!startPin && !isImport)) return;
    setBuilding(true);
    setError(null);

    const sortedZones = [...draft.zones].sort((a, b) => a.order - b.order);
    const tourLat = sortedZones[0]?.lat ?? startPin?.[0] ?? 0;
    const tourLng = sortedZones[0]?.lng ?? startPin?.[1] ?? 0;

    // Collectibles found in the script become the tour's resources, so the
    // zones that grant and require them have something real to point at.
    const importedResources = (draft.resources ?? []).map(r => ({
      id: r.id,
      name: r.name,
      type: 'item' as const,
      color: '#10b981',
      image_url: null,
      starting_amount: 0,
      show_in_hud: true,
    }));

    const tour = await createTour({
      owner_id:  userId,
      title:     draft.title,
      description: draft.description,
      welcome_subtitle: draft.subtitle || undefined,
      is_public: false,
      lat: tourLat,
      lng: tourLng,
      map_style: 'satellite',
      ...(importedResources.length
        ? { progression_enabled: true, progression_resources: importedResources }
        : {}),
    });

    if (!tour) {
      setError('Failed to create experience. Please try again.');
      setBuilding(false);
      return;
    }

    // Zone number to real id, filled as we go, so gating written as "after
    // zone 4" can be resolved once the zones actually exist.
    const idByOrder = new Map<number, string>();

    for (const dz of sortedZones) {
      // Normalize: a "character" without a prompt can't hold a conversation,
      // so treat it as an audio zone and the editor opens on the right settings
      const zoneType = dz.type === 'discoverable'
        ? 'discoverable'
        : dz.type === 'character' && dz.character_prompt?.trim() ? 'character' : 'audio';
      const created = await createZone({
        tour_id:    tour.id,
        title:      dz.title,
        type:       zoneType,
        lat:        dz.lat,
        lng:        dz.lng,
        radius:     dz.radius,
        description: dz.description ?? '',
        entry_message: dz.entry_message ?? undefined,
        // Null means the script never asked, so the column default stands.
        is_visible:  dz.is_visible ?? true,
        ...(dz.on_end  ? { on_end:  dz.on_end }  : {}),
        ...(dz.on_exit ? { on_exit: dz.on_exit } : {}),
        ...(dz.is_mystery ? { is_mystery: true } : {}),
        ...(dz.rewards?.length      ? { progression_rewards: dz.rewards }           : {}),
        ...(dz.requirements?.length ? { progression_requirements: dz.requirements } : {}),
        character_prompt:  dz.character_prompt  ?? undefined,
        voice_instructions: dz.voice_instructions ?? undefined,
        character_bio:     dz.character_bio     ?? undefined,
        greeting_message:  dz.greeting_message  ?? undefined,
        voice_style:       dz.voice_style       ?? undefined,
        voice_enabled:     false,
        // The imported script lands in the voiceover field, which is what the
        // zone editor reads to open on its AI-voiceover tab with the text
        // already in place — one button from here to finished audio.
        voiceover_script:  dz.script ? dz.script.slice(0, MAX_SCRIPT_CHARS) : undefined,
        lock_type:         dz.locked ? 'passphrase' : 'none',
        lock_hint:         dz.lock_hint         ?? undefined,
        lock_passphrase:   dz.lock_passphrase   ?? undefined,
      });
      if (created) idByOrder.set(dz.order, created.id);
    }

    // Second pass. requires_zone_id needs an id that did not exist when the
    // zone was created, so gating is wired up only once every zone is in.
    for (const dz of sortedZones) {
      if (!dz.requires_zone_order) continue;
      const self   = idByOrder.get(dz.order);
      const target = idByOrder.get(dz.requires_zone_order);
      if (self && target) await updateZone(self, { requires_zone_id: target });
    }

    onBuilt(tour.id);
  };

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
              {phase === 'review'
                ? draft?.title || 'Review Draft'
                : mode === 'import' ? 'Import a Script' : 'Generate Experience'}
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {phase === 'input' && (mode === 'import'
                ? 'Paste what you have written. Your words are kept exactly'
                : 'Search your start location, then drag pins to fine-tune')}
              {phase === 'generating' && (mode === 'import' ? 'Reading your script…' : 'Building your experience…')}
              {phase === 'review'     && (isImport
                ? 'Check how it was read, then build'
                : 'Review zones, give feedback, then build')}
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

              {/* ── Mode ── */}
              <div className="px-5 pt-5">
                <div className="grid grid-cols-2 gap-2 p-1 bg-zinc-900 border border-zinc-800 rounded-2xl">
                  {([
                    ['import',   'I have a script', 'Paste it, I cut the zones'],
                    ['generate', 'Start from scratch', 'Invent one from a brief'],
                  ] as [Mode, string, string][]).map(([m, label, sub]) => (
                    <button
                      key={m}
                      onClick={() => { setMode(m); setError(null); }}
                      className={`px-3 py-2.5 rounded-xl text-left transition-colors ${
                        mode === m
                          ? 'bg-indigo-600/20 border border-indigo-500/50'
                          : 'border border-transparent hover:bg-zinc-800/60'
                      }`}
                    >
                      <span className={`block text-sm font-bold ${mode === m ? 'text-indigo-300' : 'text-zinc-400'}`}>
                        {label}
                      </span>
                      <span className="block text-[10px] text-zinc-500 mt-0.5 leading-tight">{sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Import: the script itself ── */}
              {mode === 'import' && (
                <div className="px-5 pt-5">
                  <div className="flex items-baseline justify-between mb-2">
                    <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      Your script
                    </label>
                    <span className="text-[10px] tabular-nums text-zinc-600 ml-2 shrink-0">
                      {docText.length.toLocaleString()} characters
                    </span>
                  </div>
                  <textarea
                    value={docText}
                    onChange={e => setDocText(e.target.value)}
                    rows={10}
                    placeholder={'Paste the whole thing: headings, dialogue, coordinates, puzzle keys and all.\n\nYour words are copied across exactly as written. Nothing is rewritten.'}
                    className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-zinc-600 resize-y placeholder-zinc-600 leading-relaxed font-mono"
                  />
                  <input
                    ref={docInputRef}
                    type="file"
                    accept=".txt,.md,.markdown,text/plain,text/markdown"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) loadDocFile(f); }}
                  />
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      onClick={() => docInputRef.current?.click()}
                      className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <Upload size={12} /> Load a .txt or .md file
                    </button>
                    {docText && (
                      <button
                        onClick={() => setDocText('')}
                        className="flex items-center gap-1.5 text-[11px] text-zinc-600 hover:text-red-400 transition-colors ml-auto"
                      >
                        <Trash2 size={12} /> Clear
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
                    Paste plain text rather than a PDF. Text keeps your exact characters:
                    hieroglyphs, ciphers, spaced letters, where PDF extraction mangles them.
                  </p>

                  {/* The directive reference lives here, beside the script it
                      applies to. It first sat under the zone-size slider,
                      where a lone line of code read as a validation error
                      rather than an example. */}
                  <details className="mt-3 group">
                    <summary className="cursor-pointer list-none text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1.5">
                      <ChevronDown size={11} className="group-open:rotate-180 transition-transform" />
                      You can tell it what to do, right inside the script
                    </summary>
                    <div className="mt-2 pl-4 border-l border-zinc-800">
                      <p className="text-[11px] text-zinc-500 leading-relaxed mb-2">
                        Put any of these on their own line inside a section. They are stripped out
                        before your words are used, so a player never hears them. The last six
                        direct a character: without them a chat has no objective and nothing to hold back.
                      </p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {[
                          ['[[character]]', 'someone to talk to'],
                          ['[[discoverable]]', 'a collectible'],
                          ['[[locked: PIER]]', 'needs a passphrase'],
                          ['[[hint: shift back two]]', 'shown when locked'],
                          ['[[loop]]', 'audio repeats'],
                          ['[[on exit: keep]]', 'keeps playing'],
                          ['[[hidden]]', 'not on the map'],
                          ['[[mystery]]', 'unknown until found'],
                          ['[[radius: 6]]', 'this zone only'],
                          ['[[requires zone: 2]]', 'after zone 2'],
                          ['[[persona: …]]', 'who they are'],
                          ['[[wants: …]]', 'their objective'],
                          ['[[reveals: …]]', 'and what unlocks it'],
                          ['[[asks: …]]', 'what they put to you'],
                          ['[[never: …]]', 'a hard limit'],
                          ['[[voice: Charon]]', 'pick the voice'],
                        ].map(([code, what]) => (
                          <div key={code} className="flex items-baseline gap-2 min-w-0">
                            <code className="text-[10px] font-mono text-zinc-300 bg-zinc-800 px-1 py-0.5 rounded shrink-0">
                              {code}
                            </code>
                            <span className="text-[10px] text-zinc-600 truncate">{what}</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] text-zinc-600 leading-relaxed mt-2">
                        Plain English works too, it is just less certain to be caught.
                      </p>
                    </div>
                  </details>
                </div>
              )}

              {/* ── Start location search (above the map, not on it) ── */}
              <div className="px-5 pt-5 pb-3">
                <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  {mode === 'import' ? 'Where to lay the zones out' : 'Start location'}
                  {mode === 'import' && (
                    <span className="text-zinc-600 font-normal normal-case tracking-normal">
                      (only used for zones with no coordinates in your script)
                    </span>
                  )}
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
                        placeholder="Search address or place, e.g. Washington Square Park"
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
                  <GeneratePickerMap
                    ref={mapRef}
                    startPin={startPin}
                    endPin={endPin}
                    radiusMeters={mode === 'import' ? zoneRadius : radiusMeters}
                    onStartMove={setStartPin}
                    onEndMove={setEndPin}
                  />

                  {/* Pre-search empty state */}
                  {!startPin && (
                    <div className="absolute inset-0 z-[700] flex items-center justify-center pointer-events-none bg-black/30">
                      <div className="bg-zinc-900/90 backdrop-blur border border-zinc-700 rounded-2xl px-5 py-3 text-center shadow-xl">
                        <p className="text-white font-semibold text-sm">Search for your start location above</p>
                        {mode === 'import' && (
                          <p className="text-zinc-400 text-xs mt-1">
                            Skip this if your script already has coordinates
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* End point row — routing is a generate-mode concern. An
                    import follows the order the script is written in. */}
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

                {mode === 'import' && (
                  <p className="text-[11px] text-zinc-600 mt-2">
                    {endPin
                      ? 'Zones without coordinates of their own are spread evenly from start to end, in script order.'
                      : 'Add an end point and the zones will run evenly between the two. Without one they curve away from the start.'}
                  </p>
                )}

                {startPin && mode === 'generate' && (
                  <p className="text-[11px] text-zinc-600 mt-2">
                    Zoom in and drag the pins to set exact spots.
                    {!endPin && ' Adding an end point drops a pin at the center of the map view.'}
                  </p>
                )}
              </div>

              <div className="px-5 pb-5 mt-5 flex flex-col gap-5">

                {/* One slider, one slot, both modes.
                    The circle on the map is the POI search area when
                    generating and one zone at actual size when importing.
                    Different meanings, but the same control in the same place,
                    because a setting that moves between tabs reads as a bug. */}
                <div>
                  <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                    {mode === 'import' ? 'Zone size: ' : 'Search radius: '}
                    <span className="text-zinc-300">
                      {formatDistance(mode === 'import' ? zoneRadius : radiusMeters)}
                    </span>
                    <span className="text-zinc-600 font-normal normal-case ml-1">
                      (shown as circle on map)
                    </span>
                  </label>
                  {mode === 'import' ? (
                    <>
                      <input
                        type="range" min={3} max={60} step={1}
                        value={zoneRadius}
                        onChange={e => setZoneRadius(Number(e.target.value))}
                        className="w-full accent-emerald-500"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                        <span>{formatDistance(3)}</span>
                        <span>Yours average {formatDistance(7)}</span>
                        <span>{formatDistance(60)}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        type="range" min={50} max={2000} step={25}
                        value={radiusMeters}
                        onChange={e => setRadiusMeters(Number(e.target.value))}
                        className="w-full accent-emerald-500"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                        <span>{formatDistance(50)}</span><span>Walking distance</span><span>{formatDistance(2000)}</span>
                      </div>
                    </>
                  )}
                </div>

                {/* Brief */}
                {mode === 'generate' && (
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                      Brief <span className="text-zinc-600 font-normal normal-case">(optional: theme, characters, tone, story beats)</span>
                    </label>
                    <span className={`text-[10px] tabular-nums ml-2 shrink-0 ${brief.length > 2800 ? 'text-amber-400' : 'text-zinc-600'}`}>
                      {brief.length}/3000
                    </span>
                  </div>
                  <textarea
                    value={brief}
                    onChange={e => setBrief(e.target.value.slice(0, 3000))}
                    rows={4}
                    placeholder="Describe your theme, characters, and tone…"
                    className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-zinc-600 resize-none placeholder-zinc-600 leading-relaxed"
                  />
                </div>

                )}

                {/* PDF */}
                {mode === 'generate' && (
                <div>
                  <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                    Reference document <span className="text-zinc-600 font-normal normal-case">(optional: script, research, character bible…)</span>
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
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-zinc-800 shrink-0">
              <button
                onClick={mode === 'import' ? runImport : generate}
                disabled={mode === 'import' ? docText.trim().length < 40 : !startPin}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg"
              >
                {mode === 'import' ? <FileText size={16} /> : <Sparkles size={16} />}
                {mode === 'import' ? 'Build zones from my script' : 'Generate Experience'}
              </button>
              {mode === 'generate' && !startPin && (
                <p className="text-center text-xs text-zinc-600 mt-2">Set a start location to continue</p>
              )}
              {mode === 'import' && docText.trim().length < 40 && (
                <p className="text-center text-xs text-zinc-600 mt-2">Paste your script to continue</p>
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
              <p className="text-white font-semibold text-base mb-1">
                {(mode === 'import' ? IMPORT_STEPS : STEPS)[genStep]}
              </p>
              <div className="flex items-center justify-center gap-1.5 mt-3">
                {(mode === 'import' ? IMPORT_STEPS : STEPS).map((_, i) => (
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
              {mode === 'import'
                ? 'Reading the whole script before cutting anything, so the sectioning matches what you meant. Usually 20 to 40 seconds.'
                : 'Researching real local history and crafting your narrative. This usually takes 20–40 seconds.'}
            </p>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            REVIEW PHASE
        ══════════════════════════════════════════════════════════════════ */}
        {phase === 'review' && draft && (
          <>
            <div className="flex-1 overflow-y-auto">

              {/* ── How the script was read ──
                  Shown before the zones on purpose. If the reading is wrong,
                  correcting the reading is one decision; correcting twenty
                  zones one at a time is an afternoon. */}
              {isImport && draft.reading && (
                <div className="px-5 pt-5">
                  <div className="bg-indigo-500/5 border border-indigo-500/30 rounded-2xl p-4">
                    <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-2">How I read it</p>
                    {draft.reading.convention && (
                      <p className="text-xs text-zinc-400 mb-2">
                        <span className="text-zinc-500">Sectioning: </span>{draft.reading.convention}
                      </p>
                    )}
                    <p className="text-sm text-zinc-300 leading-relaxed">{draft.reading.interpretation}</p>

                    {draft.reading.mechanics.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {draft.reading.mechanics.map((m, i) => (
                          <li key={i} className="text-xs text-zinc-400 flex gap-2">
                            <span className="text-indigo-400 shrink-0">·</span>{m}
                          </li>
                        ))}
                      </ul>
                    )}

                    {draft.reading.speakers.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-indigo-500/20">
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Speakers</p>
                        <div className="flex flex-wrap gap-1.5">
                          {draft.reading.speakers.map((s, i) => (
                            <span
                              key={i}
                              title={s.description}
                              className="text-[11px] px-2 py-1 rounded-lg bg-zinc-800 text-zinc-300 border border-zinc-700"
                            >
                              {s.name}
                              {s.zones > 1 && <span className="text-zinc-500"> ×{s.zones}</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Collectibles lifted out of the script. These become the
                  tour's progression resources, so the zones that grant and
                  require them have something real to point at. */}
              {isImport && !!draft.resources?.length && (
                <div className="px-5 pt-3">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                    <p className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-1">
                      Collectibles
                    </p>
                    <p className="text-[11px] text-zinc-600 mb-3">
                      Set up on the experience so zones can hand them out and ask for them.
                      Colors and icons are yours to change afterwards.
                    </p>
                    <div className="space-y-1.5">
                      {draft.resources.map(r => {
                        const from = draft.zones.filter(z => z.rewards?.some(w => w.resource_id === r.id));
                        const needs = draft.zones.filter(z => z.requirements?.some(w => w.resource_id === r.id));
                        return (
                          <div key={r.id} className="flex items-baseline gap-2 text-xs">
                            <span className="text-zinc-200 font-medium shrink-0">{r.name}</span>
                            <span className="text-zinc-600 truncate flex-1">{r.description}</span>
                            <span className="text-[10px] text-zinc-500 shrink-0 tabular-nums">
                              {from.length ? `from ${from.map(z => z.order).join(', ')}` : 'never granted'}
                              {needs.length ? ` · needed at ${needs.map(z => z.order).join(', ')}` : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Things worth a second look before building. */}
              {isImport && !!draft.flags?.length && (
                <div className="px-5 pt-3">
                  <div className="bg-amber-500/5 border border-amber-500/30 rounded-2xl p-4">
                    <p className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">Worth checking</p>
                    <ul className="space-y-1.5">
                      {draft.flags.map((f, i) => (
                        <li key={i} className="text-xs text-amber-200/80 leading-relaxed flex gap-2">
                          <span className="text-amber-500 shrink-0">·</span>{f}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Blocks that were deliberately NOT made into zones. Listed so
                  nothing the creator wrote can disappear without them seeing. */}
              {isImport && !!draft.set_aside?.length && (
                <div className="px-5 pt-3">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-1">
                      Set aside, not turned into zones
                    </p>
                    <p className="text-[11px] text-zinc-600 mb-3">
                      Kept out of the walk on purpose. Copy anything you still need.
                    </p>
                    <div className="space-y-2">
                      {draft.set_aside.map((b, i) => (
                        <details key={i} className="group">
                          <summary className="cursor-pointer text-xs text-zinc-300 flex items-center gap-2 list-none">
                            <ChevronDown size={12} className="text-zinc-600 group-open:rotate-180 transition-transform shrink-0" />
                            <span className="font-medium">{b.label}</span>
                            <span className="text-[10px] text-zinc-600">
                              {b.kind.replace(/_/g, ' ')} · lines {b.lines[0]} to {b.lines[1]}
                            </span>
                          </summary>
                          <pre className="mt-2 ml-5 text-[11px] text-zinc-400 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                            {b.text}
                          </pre>
                        </details>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Summary */}
              <div className="px-5 pt-5 pb-3">
                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                  <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-1">
                    {isImport ? 'Experience' : 'AI Summary'}
                  </p>
                  {!isImport && <p className="text-sm text-zinc-300 leading-relaxed">{draft.summary}</p>}
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
                  <div className="rounded-xl overflow-hidden border border-zinc-800 relative" style={{ height: 200 }}>
                    <GeneratePreviewMap zones={draft.zones} startPin={startPin} endPin={endPin} />
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
                            {/* Imports always land on audio: a first-person
                                monologue reads the same whether it is a
                                recording or someone to talk to, so guessing
                                wrong would mean undoing work. The suggestion
                                shows here and the character fields are already
                                filled, so switching is one tap in the editor. */}
                            {!zone.type_is_explicit && zone.suggested_type && zone.suggested_type !== 'audio' && (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border text-indigo-400 bg-indigo-400/10 border-indigo-400/30">
                                reads as {zone.suggested_type}
                              </span>
                            )}
                            {zone.placement === 'from_document' && (
                              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border text-emerald-400 bg-emerald-400/10 border-emerald-400/30">
                                <MapPin size={8} /> your coordinates
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-zinc-500 mt-0.5 truncate">
                            {zone.speaker_name ? `${zone.speaker_name} · ` : ''}{zone.location_name}
                          </p>
                          {/* Everything the script told us to switch on, shown
                              on the card rather than left to be discovered in
                              the editor or, worse, in the field. */}
                          {!!zone.applied_settings?.length && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {zone.applied_settings.map((s, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700"
                                >
                                  {s}
                                </span>
                              ))}
                            </div>
                          )}
                          {!isOpen && (
                            <p className="text-xs text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                              {zone.script || zone.description}
                            </p>
                          )}
                        </div>
                        {isOpen
                          ? <ChevronUp size={14} className="text-zinc-500 shrink-0 mt-1" />
                          : <ChevronDown size={14} className="text-zinc-500 shrink-0 mt-1" />}
                      </button>

                      {isOpen && (
                        <div className="px-4 pb-4 pt-1 border-t border-zinc-800 space-y-3">
                          {/* The creator's own words, first and unstyled —
                              sliced from their document by line number and
                              never passed through the model. */}
                          {zone.script && (
                            <div>
                              <div className="flex items-baseline justify-between mb-1">
                                <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                  Your script, kept exactly
                                </p>
                                {zone.source_lines && (
                                  <span className="text-[10px] text-zinc-600 tabular-nums">
                                    lines {zone.source_lines[0]} to {zone.source_lines[1]}
                                  </span>
                                )}
                              </div>
                              <pre className="text-xs text-zinc-200 bg-zinc-950 border border-emerald-500/20 rounded-lg p-3 whitespace-pre-wrap break-words leading-relaxed max-h-56 overflow-y-auto">
                                {zone.script}
                              </pre>
                              <p className="text-[10px] text-zinc-600 mt-1">
                                Goes into the zone's voiceover script, ready to generate audio from.
                              </p>
                            </div>
                          )}

                          <div>
                            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                              Description
                              {zone.generated_fields?.includes('description') && (
                                <span className="ml-1.5 text-indigo-400/70 font-normal normal-case tracking-normal">
                                  written for you
                                </span>
                              )}
                            </p>
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

              {/* Refine is GENERATE-ONLY, and deliberately so.
                  Refining sends the whole draft to the model and asks for the
                  whole draft back. On an import that would push the creator's
                  script through the model — the one thing this pipeline exists
                  to prevent — and a paraphrased cipher or transposed glyph
                  would be invisible until a player was stuck in a park. Fixes
                  to an import belong in the zone editor, where the text is
                  only ever edited by hand. */}
              {isImport ? (
                <div className="px-5 pb-6">
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3">
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Imports aren't refined by the AI, because that would mean sending your script
                      back through it. Build now and edit anything you want in the zone editor,
                      or go back and adjust the script itself.
                    </p>
                  </div>
                </div>
              ) : (
              <div className="px-5 pb-6">
                <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Request changes</p>
                <div className="flex gap-2">
                  <textarea
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    rows={2}
                    placeholder="Describe the changes you want…"
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
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-zinc-800 shrink-0 flex gap-3">
              <button
                onClick={() => { setPhase('input'); setDraft(null); setIsImport(false); setError(null); }}
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
