import React, { useRef, useState, useEffect } from 'react';
import { ProgressionResource, Zone, ZoneExitBehavior, ZoneEndBehavior } from '../types';
import { SAMPLE_AUDIO_FILES, VOICES, CHARACTER_TEMPLATES } from '../constants';
import { uploadAudio, uploadImage } from '../services/storageService';
import { supabase } from '../services/supabaseClient';
import { Music, AlertCircle, Clock, Volume2, EyeOff, Radio, PlayCircle, Upload, Link as LinkIcon, FileAudio, ListMusic, Bot, MessageSquare, Lock, Unlock, GitBranch, Bell, Sparkles, KeySquare, ImageIcon, X, Trash2, Play, Pause, Loader2, Gift, HelpCircle } from 'lucide-react';
import { ZoneProgressionSettings } from './ZoneProgressionSettings';

// ── Mini audio preview player ───────────────────────────────────────────────
const AudioPreview: React.FC<{ url: string; volume?: number }> = ({ url, volume = 1 }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadError, setLoadError] = useState(false);

  // Reset state whenever the source URL changes
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setDuration(0);
    setLoadError(false);
  }, [url]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.min(1, Math.max(0, volume));
    }
  }, [volume]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play().catch(() => {}); setPlaying(true); }
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const seekTo = (clientX: number) => {
    const bar = scrubRef.current;
    const a = audioRef.current;
    if (!bar || !a || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setProgress(ratio);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    seekTo(e.clientX);
    const onMove = (ev: MouseEvent) => { if (isDragging.current) seekTo(ev.clientX); };
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const remaining = duration > 0 ? duration * (1 - progress) : null;

  // A file that can't load means a silent zone for every player — say so
  // here in the editor instead of failing invisibly in the field.
  if (loadError) {
    return (
      <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mt-2 text-xs text-red-300">
        <AlertCircle size={13} className="shrink-0" />
        This audio can't be loaded — check the link or re-upload. Players would hear nothing.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 mt-2">
      <audio
        ref={audioRef}
        src={url}
        onLoadedMetadata={() => {
          if (audioRef.current) {
            audioRef.current.volume = Math.min(1, Math.max(0, volume));
            setDuration(audioRef.current.duration);
          }
        }}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (a && a.duration && !isDragging.current) setProgress(a.currentTime / a.duration);
        }}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onError={() => setLoadError(true)}
      />
      <button
        onClick={toggle}
        className="text-emerald-400 hover:text-emerald-300 shrink-0 transition-colors"
        title={playing ? 'Pause' : 'Play preview'}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      {/* Drag-to-scrub bar */}
      <div
        ref={scrubRef}
        className="flex-1 h-2 bg-zinc-800 rounded-full cursor-pointer relative group select-none"
        onMouseDown={handleMouseDown}
      >
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500 rounded-full pointer-events-none"
          style={{ width: `${progress * 100}%` }}
        />
        {/* Thumb — visible on hover or while dragging */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `calc(${progress * 100}% - 6px)` }}
        />
      </div>
      <span className="text-[10px] text-zinc-500 font-mono tabular-nums shrink-0 w-8 text-right">
        {remaining !== null ? fmt(remaining) : '—:——'}
      </span>
    </div>
  );
};

// Interleave male (left col) and female (right col) voices for the 2-col grid
const _males   = VOICES.filter(v => v.gender === 'M');
const _females = VOICES.filter(v => v.gender === 'F');
const INTERLEAVED_VOICES = _males.flatMap((m, i) => _females[i] ? [m, _females[i]] : [m]);

interface ZoneFormProps {
  zone: Zone;
  onUpdate: (updates: Partial<Zone>) => void;
  onDelete?: () => void;
  zonesList?: Zone[];
  progressionEnabled?: boolean;
  progressionResources?: ProgressionResource[];
}

type AudioSourceType = 'preset' | 'upload' | 'url' | 'ai';

const RADIUS_MIN_METERS = 2;
const RADIUS_MAX_METERS = 500;
const RADIUS_SLIDER_MAX = 1000;
const radiusToSlider = (radius: number) =>
  Math.round(
    Math.sqrt(
      (Math.min(RADIUS_MAX_METERS, Math.max(RADIUS_MIN_METERS, radius)) - RADIUS_MIN_METERS) /
      (RADIUS_MAX_METERS - RADIUS_MIN_METERS)
    ) * RADIUS_SLIDER_MAX
  );
const sliderToRadius = (value: number) =>
  Math.round(
    RADIUS_MIN_METERS +
    Math.pow(value / RADIUS_SLIDER_MAX, 2) * (RADIUS_MAX_METERS - RADIUS_MIN_METERS)
  );

interface ElevenVoice {
  voice_id: string;
  name: string;
  category: string;
  preview_url: string | null;
}

// Recently-used ElevenLabs voices (most recent first) so a creator's go-to
// voices float to the top of the picker. Stored locally to the browser.
const RECENT_VOICES_KEY = 'obelisk_recent_el_voices';
function getRecentVoiceIds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_VOICES_KEY) || '[]'); } catch { return []; }
}
function recordRecentVoice(id: string) {
  try {
    const next = [id, ...getRecentVoiceIds().filter(v => v !== id)].slice(0, 6);
    localStorage.setItem(RECENT_VOICES_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}
function sortByRecency<T extends { voice_id: string }>(voices: T[]): T[] {
  const recent = getRecentVoiceIds();
  const rank = (id: string) => { const i = recent.indexOf(id); return i === -1 ? Infinity : i; };
  return [...voices].sort((a, b) => rank(a.voice_id) - rank(b.voice_id));
}

// supabase-js returns data=null on non-2xx — the server's real message lives in
// error.context (a Response). Pull it out so users see actionable errors.
async function fnErrorMessage(error: unknown, data: { message?: string } | null): Promise<string | null> {
  if (data?.message) return data.message;
  try {
    const ctx = (error as { context?: Response })?.context;
    if (ctx && typeof ctx.json === 'function') {
      const j = await ctx.json();
      return j?.message || null;
    }
  } catch { /* fall through */ }
  return null;
}

export const ZoneForm: React.FC<ZoneFormProps> = ({
  zone,
  onUpdate,
  onDelete,
  zonesList,
  progressionEnabled = false,
  progressionResources = [],
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [sourceType, setSourceType] = useState<AudioSourceType>(() => {
    // A saved voiceover script means this zone's audio came from AI Voice —
    // open on that tab so the creator lands where they left off.
    if (zone.voiceover_script?.trim()) return 'ai';
    if (!zone.media_url || zone.media_url.startsWith('blob:')) return 'upload';
    if (SAMPLE_AUDIO_FILES.some(f => f.url === zone.media_url)) return 'preset';
    return 'url';
  });
  const [fileName, setFileName] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const [showAllVoices, setShowAllVoices] = useState(false);
  const [audioUploading, setAudioUploading] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);

  // AI voiceover (ElevenLabs) — the script is persisted on the zone so it
  // survives a save/reopen (derived from zone, not local state).
  const ttsScript = zone.voiceover_script || '';
  const [ttsVoiceId, setTtsVoiceId]           = useState('');
  const [ttsVoices, setTtsVoices]             = useState<ElevenVoice[] | null>(null);
  const [ttsVoicesError, setTtsVoicesError]   = useState<string | null>(null);
  const [ttsLoadingVoices, setTtsLoadingVoices] = useState(false);
  const [ttsGenerating, setTtsGenerating]     = useState(false);
  const [ttsError, setTtsError]               = useState<string | null>(null);
  const [ttsDone, setTtsDone]                 = useState(false);
  const characterVoiceEnabled = zone.voice_enabled === true;

  // Load the creator's ElevenLabs voices the first time the AI tab opens
  useEffect(() => {
    if (sourceType !== 'ai' || ttsVoices !== null || ttsLoadingVoices) return;
    setTtsLoadingVoices(true);
    setTtsVoicesError(null);
    supabase.functions.invoke('elevenlabs-tts', { body: { type: 'voices' } })
      .then(async ({ data, error }) => {
        if (error || !data?.voices) {
          const msg = await fnErrorMessage(error, data);
          setTtsVoicesError(msg || 'Could not load voices. Add your ElevenLabs API key in Dashboard → Settings.');
        } else {
          const ordered = sortByRecency(data.voices as ElevenVoice[]);
          setTtsVoices(ordered);
          if (ordered.length > 0) setTtsVoiceId(ordered[0].voice_id);
        }
      })
      .catch(() => setTtsVoicesError('Could not load voices. Add your ElevenLabs API key in Dashboard → Settings.'))
      .finally(() => setTtsLoadingVoices(false));
  }, [sourceType]); // eslint-disable-line react-hooks/exhaustive-deps

  const generateVoiceover = async () => {
    if (!ttsScript.trim() || !ttsVoiceId || ttsGenerating) return;
    setTtsGenerating(true);
    setTtsError(null);
    setTtsDone(false);
    try {
      const { data, error } = await supabase.functions.invoke('elevenlabs-tts', {
        body: { type: 'generate', text: ttsScript.trim(), voiceId: ttsVoiceId, tourId: zone.tour_id },
      });
      if (error || !data?.url) {
        const msg = await fnErrorMessage(error, data);
        setTtsError(msg || 'Voice generation failed — please try again.');
      } else {
        onUpdate({ media_url: data.url });
        recordRecentVoice(ttsVoiceId);
        setTtsDone(true);
      }
    } catch {
      setTtsError('Voice generation failed — please try again.');
    }
    setTtsGenerating(false);
  };

  // Cleanup voice preview audio when the form unmounts to prevent ghost playback
  useEffect(() => {
    return () => {
      if (voiceAudioRef.current) {
        voiceAudioRef.current.pause();
        voiceAudioRef.current.src = '';
        voiceAudioRef.current = null;
      }
    };
  }, []);

  const playVoiceSample = (voiceName: string, sampleUrl?: string) => {
    if (!sampleUrl) return;
    // Stop any currently playing sample
    if (voiceAudioRef.current) {
      voiceAudioRef.current.pause();
      voiceAudioRef.current.src = '';
    }
    if (playingVoice === voiceName) {
      // Tapping the same voice again stops it
      setPlayingVoice(null);
      return;
    }
    const audio = new Audio(sampleUrl);
    voiceAudioRef.current = audio;
    setPlayingVoice(voiceName);
    audio.play().catch(() => {});
    audio.onended = () => setPlayingVoice(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setUploadError(null);
    e.target.value = '';

    setAudioUploading(true);
    // Do NOT fall back to a blob: URL on failure — blob URLs can't be persisted
    // to the DB or played back after a reload. storageService reports the
    // specific reason (wrong type, too large, over quota) via onError.
    const url = await uploadAudio(file, zone.tour_id, { onError: setUploadError });
    setAudioUploading(false);

    if (url) onUpdate({ media_url: url });
  };

  const handleImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    field: 'character_image_url' | 'zone_image_url',
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImageUploadError(null);
    setImageUploading(true);
    const url = await uploadImage(file, zone.tour_id, { onError: setImageUploadError });
    setImageUploading(false);
    if (url) onUpdate({ [field]: url });
  };

  // A discoverable only ever grants a progression reward — it's a dead end
  // without at least one resource defined for the tour.
  const discoverableAvailable = progressionEnabled && progressionResources.length > 0;

  return (
    <div className="text-zinc-200 pb-20">
      <div className="mb-6">
        <h3 className="text-emerald-400 font-bold uppercase tracking-wider text-sm mb-4">Zone Properties</h3>
        
        {/* Type Selector */}
        <div className="flex bg-zinc-800 rounded p-1 mb-1">
             <button
               onClick={() => onUpdate({ type: 'audio' })}
               className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-bold rounded transition-colors whitespace-nowrap ${zone.type === 'audio' ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
             >
               <Music size={14} /> Media Zone
             </button>
             <button
               onClick={() => onUpdate({ type: 'character' })}
               className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-bold rounded transition-colors whitespace-nowrap ${zone.type === 'character' ? 'bg-indigo-500 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
             >
               <Bot size={14} /> AI Character
             </button>
             <button
               type="button"
               disabled={!discoverableAvailable}
               title={discoverableAvailable ? undefined : 'Enable Progression in Tour Settings first'}
               onClick={() => {
                 if (!discoverableAvailable) return;
                 // Reset to sensible discoverable defaults — small, hidden,
                 // and looping so the hint chime plays continuously on approach.
                 onUpdate({ type: 'discoverable', radius: 15, is_visible: false, use_attenuation: true, on_end: 'loop' });
               }}
               className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-bold rounded transition-colors whitespace-nowrap ${
                 zone.type === 'discoverable'
                   ? 'bg-pink-500 text-white shadow'
                   : discoverableAvailable ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-600 cursor-not-allowed'
               }`}
             >
               <Gift size={14} /> Discoverable
             </button>
        </div>
        <p className="text-[10px] text-zinc-500 mb-5 min-h-[1em]">
          {!discoverableAvailable && zone.type !== 'discoverable'
            ? 'Enable Progression in Tour Settings to add Discoverable zones.'
            : ''}
        </p>

        {/* Name */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-zinc-400 uppercase mb-1">Name</label>
          <input
            type="text"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none transition-colors"
            value={zone.title}
            onChange={(e) => onUpdate({ title: e.target.value })}
            placeholder="e.g. The Park Ranger"
          />
        </div>

        {/* Description / Caption */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-zinc-400 uppercase mb-1">Description</label>
          <textarea
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none resize-y break-words"
            rows={2}
            value={zone.description || ''}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder="Short description…"
          />
        </div>
      </div>

      {/* Entry Message — applies to all zone types */}
      <div className="mb-6">
        <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
          <Bell size={14} /> Entry Message
        </label>
        <textarea
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none resize-y break-words"
          rows={2}
          value={zone.entry_message || ''}
          onChange={(e) => onUpdate({ entry_message: e.target.value })}
          placeholder="Shown on screen on entry…"
        />
        <p className="text-[10px] text-zinc-500 mt-1">Leave blank for no on-screen notification.</p>
      </div>

      {zone.type === 'character' ? (
        /* --- AI CHARACTER SETTINGS --- */
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">

          {/* Persona Templates */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Sparkles size={14} /> Quick Templates
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {CHARACTER_TEMPLATES.map(t => (
                <button
                  key={t.label}
                  onClick={() => onUpdate({ character_prompt: t.prompt })}
                  className="flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-indigo-600/30 border border-zinc-700 hover:border-indigo-500/50 rounded-lg text-xs text-zinc-300 hover:text-white transition-all text-left"
                >
                  <span className="text-base leading-none">{t.icon}</span>
                  <span className="font-medium">{t.label}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-500 mt-1.5">Tap to load a starting prompt. You can customize it after.</p>
          </div>

          {/* Character Image */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <ImageIcon size={14} /> Character Avatar <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleImageUpload(e, 'character_image_url')}
            />
            {zone.character_image_url ? (
              <div className="relative w-24 h-24 group">
                <img
                  src={zone.character_image_url}
                  alt="Character avatar"
                  className="w-24 h-24 object-cover rounded-xl border border-zinc-700"
                />
                <button
                  onClick={() => onUpdate({ character_image_url: undefined })}
                  className="absolute -top-2 -right-2 z-10 w-6 h-6 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
                <button
                  onClick={() => imageInputRef.current?.click()}
                  className="absolute inset-0 rounded-xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold"
                >
                  Replace
                </button>
              </div>
            ) : (
              <button
                onClick={() => !imageUploading && imageInputRef.current?.click()}
                className="w-24 h-24 rounded-xl border-2 border-dashed border-zinc-700 hover:border-indigo-500 hover:bg-indigo-500/5 flex flex-col items-center justify-center gap-1.5 text-zinc-500 hover:text-indigo-400 transition-all"
              >
                {imageUploading
                  ? <Loader2 size={18} className="animate-spin" />
                  : <Upload size={18} />
                }
                <span className="text-[10px] font-bold uppercase tracking-wide">
                  {imageUploading ? 'Uploading' : 'Upload'}
                </span>
              </button>
            )}
            {imageUploadError && (
              <p className="text-xs text-red-400 mt-1.5 leading-snug">{imageUploadError}</p>
            )}
            {!imageUploadError && <p className="text-[10px] text-zinc-500 mt-1.5">Shown on the character card and in the chat header.</p>}
          </div>

          {/* Player-Facing Bio */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <MessageSquare size={14} /> Player-Facing Description
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-y break-words min-h-[130px]"
              value={zone.character_bio || ''}
              onChange={(e) => onUpdate({ character_bio: e.target.value })}
              placeholder="Who is this character?"
            />
            <p className="text-[10px] text-zinc-500 mt-1">Shown on the card players see before starting the conversation. Keep it evocative — set the scene.</p>
          </div>

          {/* Character Persona */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <MessageSquare size={14} /> Persona & Instructions
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-indigo-500/50 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-y break-words min-h-[130px]"
              value={zone.character_prompt || ''}
              onChange={(e) => onUpdate({ character_prompt: e.target.value })}
              placeholder="Personality, voice, goals…"
            />
            <p className="text-[10px] text-zinc-400 mt-1.5">
              Defines the AI's personality, knowledge, and goals. Be specific — the more detail, the better the character.
              E.g. "You are a grumpy troll under this bridge. You demand a riddle to pass. Keep answers short and in character."
            </p>
          </div>

          {/* Greeting Message */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1.5">
              Opening Line <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-y break-words"
              rows={2}
              value={zone.greeting_message || ''}
              onChange={(e) => onUpdate({ greeting_message: e.target.value })}
              placeholder="First line they speak…"
            />
            <p className="text-[10px] text-zinc-500 mt-1">Script the character's exact first words. Leave blank for an auto-generated greeting.</p>
          </div>

          {/* Voice Picker */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-zinc-400 uppercase">Voice</label>
              {/* Voiceover toggle — public player currently treats character chat as text-only */}
              <button
                type="button"
                onClick={() => onUpdate({ voice_enabled: !characterVoiceEnabled })}
                className="flex items-center gap-2 group"
                title={characterVoiceEnabled ? 'Saved for future voice mode' : 'Replies are text-only'}
              >
                <span className={`text-[10px] font-bold uppercase tracking-wider ${characterVoiceEnabled ? 'text-indigo-400' : 'text-zinc-500'}`}>
                  Voiceover {characterVoiceEnabled ? 'On' : 'Off'}
                </span>
                <span className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${characterVoiceEnabled ? 'bg-indigo-500' : 'bg-zinc-700'}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${characterVoiceEnabled ? 'left-3.5' : 'left-0.5'}`} />
                </span>
              </button>
            </div>
            <p className="text-[10px] text-zinc-500 mb-2 -mt-1">
              Public player replies are text-only for now. These settings are preserved for the rebuilt voice mode.
            </p>
            <div className={`grid grid-cols-2 gap-2 transition-opacity ${!characterVoiceEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              {(() => {
                if (showAllVoices) return INTERLEAVED_VOICES;
                const top4 = INTERLEAVED_VOICES.slice(0, 4);
                const sel = zone.voice_style || 'Kore';
                if (top4.some(v => v.name === sel)) return top4;
                // Surface the selected voice IN the grid (keep it to 4 = even columns)
                const selVoice = INTERLEAVED_VOICES.find(v => v.name === sel);
                return selVoice ? [selVoice, ...top4.slice(0, 3)] : top4;
              })().map(v => {
                const selected = (zone.voice_style || 'Kore') === v.name;
                return (
                  <button
                    key={v.name}
                    onClick={() => onUpdate({ voice_style: v.name })}
                    className={`relative flex flex-col items-start px-3 pt-2.5 pb-2 rounded-xl border text-left transition-all ${selected ? 'bg-indigo-600/20 border-indigo-500 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-white'}`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-semibold text-sm leading-tight">{v.name}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${v.gender === 'F' ? 'bg-pink-500/20 text-pink-400' : 'bg-blue-500/20 text-blue-400'}`}>{v.gender}</span>
                    </div>
                    <div className="flex items-end justify-between w-full mt-1">
                      <span className={`text-[10px] leading-tight ${selected ? 'text-indigo-300' : 'text-zinc-500'}`}>{v.description}</span>
                      {v.sampleUrl && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            playVoiceSample(v.name, v.sampleUrl);
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click(); }}
                          title={playingVoice === v.name ? 'Stop' : 'Play sample'}
                          className={`p-1 rounded transition-colors shrink-0 -mr-1 cursor-pointer ${
                            playingVoice === v.name ? 'text-indigo-400 animate-pulse' : 'text-zinc-500 hover:text-white'
                          }`}
                        >
                          <Volume2 size={11} />
                        </span>
                      )}

                    </div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setShowAllVoices(s => !s)}
              className="mt-2 w-full text-center text-xs text-zinc-400 hover:text-white py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              {showAllVoices ? `Show less` : `Show all ${VOICES.length} voices…`}
            </button>

            {/* Speaking style — prepended to every spoken line to lock accent/delivery */}
            <div className="mt-4">
              <label className="block text-[11px] font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
                Speaking style & accent
              </label>
              <textarea
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-y break-words"
                rows={2}
                value={zone.voice_instructions || ''}
                onChange={(e) => onUpdate({ voice_instructions: e.target.value.slice(0, 400) })}
                placeholder="e.g. Warm, slow Southern drawl"
              />
              <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
                Applied to every spoken line to keep the accent and delivery consistent. Describe the accent, pace, and mood — e.g. "Gravelly old fisherman, unhurried, with a faint Irish lilt."
              </p>
            </div>
          </div>

          {/* After Conversation — Avatar Unlock */}
          <div className="border-t border-zinc-800 pt-5">
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <KeySquare size={14} /> After Conversation Ends
            </label>
            {zonesList && zonesList.filter(z => z.id !== zone.id && z.lock_type === 'passphrase').length > 0 ? (
              <>
                <select
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                  value={zone.avatar_unlock_zone_id || ''}
                  onChange={(e) => onUpdate({ avatar_unlock_zone_id: e.target.value || null })}
                >
                  <option value="">— No automatic unlock —</option>
                  {zonesList
                    .filter(z => z.id !== zone.id && z.lock_type === 'passphrase')
                    .map(z => (
                      <option key={z.id} value={z.id}>{z.title}</option>
                    ))}
                </select>
                <p className="text-[10px] text-zinc-500 mt-1">Completing this conversation automatically unlocks the selected locked zone.</p>
              </>
            ) : (
              <p className="text-[10px] text-zinc-500 bg-zinc-800/40 rounded p-2">
                No passphrase-locked zones exist yet. Add a lock to another zone to use this feature.
              </p>
            )}
          </div>

          {/* Radius + Visibility */}
          <div className="border-t border-zinc-800 pt-4">
            <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
              <span>Interaction Radius</span>
              <span>{Math.round(zone.radius * 3.28084)} ft</span>
            </div>
            <input
              type="range"
              min="0"
              max={RADIUS_SLIDER_MAX}
              step="1"
              className="w-full accent-indigo-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
              value={radiusToSlider(zone.radius)}
              onChange={(e) => onUpdate({ radius: sliderToRadius(Number(e.target.value)) })}
            />
            {zone.radius < 15 && (
                <p className="text-[10px] text-amber-400/90 mt-1">
                  GPS is usually only accurate to 15–50 ft — a zone this small may not trigger reliably.
                </p>
              )}
          </div>

          <label className="flex items-center gap-3 cursor-pointer group">
            <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${!zone.is_visible ? 'bg-indigo-500 border-indigo-500' : 'border-zinc-600 bg-transparent'}`}>
              {!zone.is_visible && <div className="w-2 h-2 bg-white rounded-sm" />}
            </div>
            <input
              type="checkbox"
              className="hidden"
              checked={!zone.is_visible}
              onChange={(e) => onUpdate({ is_visible: !e.target.checked })}
            />
            <span className="text-sm text-zinc-300 group-hover:text-white transition-colors flex items-center gap-2">
              <EyeOff size={14} /> Invisible on Map
            </span>
          </label>
        </div>
      ) : zone.type === 'discoverable' ? (
        /* --- DISCOVERABLE SETTINGS --- */
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
          {/* Icon */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <ImageIcon size={14} /> Icon <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleImageUpload(e, 'zone_image_url')}
            />
            {zone.zone_image_url ? (
              <div className="relative w-24 h-24 group">
                <img
                  src={zone.zone_image_url}
                  alt="Discoverable icon"
                  className="w-24 h-24 object-cover rounded-xl border border-zinc-700"
                />
                <button
                  onClick={() => onUpdate({ zone_image_url: null })}
                  className="absolute -top-2 -right-2 z-10 w-6 h-6 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove icon"
                >
                  <X size={12} />
                </button>
                <button
                  onClick={() => imageInputRef.current?.click()}
                  className="absolute inset-0 rounded-xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold"
                >
                  Replace
                </button>
              </div>
            ) : (
              <button
                onClick={() => !imageUploading && imageInputRef.current?.click()}
                className="w-24 h-24 rounded-xl border-2 border-dashed border-zinc-700 hover:border-pink-500 hover:bg-pink-500/5 flex flex-col items-center justify-center gap-1.5 text-zinc-500 hover:text-pink-400 transition-all"
              >
                {imageUploading
                  ? <Loader2 size={18} className="animate-spin" />
                  : <Upload size={18} />
                }
                <span className="text-[10px] font-bold uppercase tracking-wide">
                  {imageUploading ? 'Uploading' : 'Upload'}
                </span>
              </button>
            )}
            {imageUploadError && (
              <p className="text-xs text-red-400 mt-1.5 leading-snug">{imageUploadError}</p>
            )}
            {!imageUploadError && (
              <p className="text-[10px] text-zinc-500 mt-1.5">
                Shown in the pickup notification. If "Hide Until Found" is on, players see a generic glyph instead until they collect it.
              </p>
            )}
          </div>

          {/* Hint Sound */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Music size={14} /> Hint Sound <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <div className="flex bg-zinc-800 rounded p-1 mb-3">
              <button onClick={() => setSourceType('upload')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'upload' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Upload</button>
              <button onClick={() => setSourceType('ai')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'ai' ? 'bg-indigo-600 text-white' : 'text-zinc-400'}`}>AI Voice</button>
              <button onClick={() => setSourceType('url')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'url' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Link</button>
              <button onClick={() => setSourceType('preset')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'preset' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Preset</button>
            </div>

            <div className="bg-zinc-800/50 rounded border border-zinc-800 p-3">
              {sourceType === 'preset' && (
                <select
                  className="w-full bg-zinc-900 text-sm text-white border border-zinc-700 rounded p-2"
                  value={zone.media_url.startsWith('data:') ? '' : zone.media_url}
                  onChange={(e) => onUpdate({ media_url: e.target.value })}
                >
                  <option value="" disabled>Select Demo Track</option>
                  {SAMPLE_AUDIO_FILES.map((file, idx) => (
                    <option key={idx} value={file.url}>{file.label}</option>
                  ))}
                </select>
              )}
              {sourceType === 'upload' && (
                <>
                  <div
                    onClick={() => !audioUploading && fileInputRef.current?.click()}
                    className={`border border-dashed border-zinc-700 p-4 text-center rounded transition-colors ${audioUploading ? 'cursor-wait opacity-60' : 'cursor-pointer hover:bg-zinc-800'}`}
                  >
                    <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileUpload} />
                    {audioUploading ? (
                      <span className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                        <Loader2 size={13} className="animate-spin" /> Uploading…
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">{fileName || 'Click to Upload'}</span>
                    )}
                  </div>
                  {uploadError && (
                    <p className="flex items-center gap-1.5 text-xs text-red-400 mt-1.5">
                      <AlertCircle size={12} className="shrink-0" /> {uploadError}
                    </p>
                  )}
                </>
              )}
              {sourceType === 'ai' && (
                <div className="space-y-3">
                  {ttsLoadingVoices && (
                    <p className="flex items-center gap-2 text-xs text-zinc-400 py-2">
                      <Loader2 size={13} className="animate-spin" /> Loading your ElevenLabs voices…
                    </p>
                  )}

                  {ttsVoicesError && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2.5 leading-relaxed">
                      <AlertCircle size={12} className="shrink-0 mt-0.5" /> {ttsVoicesError}
                    </p>
                  )}

                  {ttsVoices && ttsVoices.length > 0 && (
                    <>
                      {/* Script */}
                      <div>
                        <div className="flex items-baseline justify-between mb-1">
                          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Voiceover script</label>
                          <span className={`text-[10px] tabular-nums ${ttsScript.length > 9000 ? 'text-amber-400' : 'text-zinc-600'}`}>
                            {ttsScript.length}/10000
                          </span>
                        </div>
                        <textarea
                          value={ttsScript}
                          onChange={e => { onUpdate({ voiceover_script: e.target.value.slice(0, 10000) }); setTtsDone(false); }}
                          rows={4}
                          placeholder="Write the voiceover script…"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded p-2.5 text-xs text-white placeholder-zinc-600 leading-relaxed resize-y break-words whitespace-pre-wrap focus:outline-none focus:border-pink-500"
                        />
                      </div>

                      {/* Voice picker */}
                      <div>
                        <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Voice</label>
                        <div className="flex gap-2">
                          <select
                            value={ttsVoiceId}
                            onChange={e => setTtsVoiceId(e.target.value)}
                            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-white focus:outline-none focus:border-pink-500"
                          >
                            {ttsVoices.map(v => (
                              <option key={v.voice_id} value={v.voice_id}>
                                {v.name}{v.category === 'premade' ? '' : ` (${v.category})`}
                              </option>
                            ))}
                          </select>
                          {(() => {
                            const v = ttsVoices.find(x => x.voice_id === ttsVoiceId);
                            return v?.preview_url ? (
                              <button
                                onClick={() => playVoiceSample(v.name, v.preview_url!)}
                                className="px-2.5 shrink-0 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-white transition-colors"
                                title="Preview voice"
                              >
                                {playingVoice === v.name ? <Pause size={12} /> : <Play size={12} />}
                              </button>
                            ) : null;
                          })()}
                        </div>
                      </div>

                      {/* Generate */}
                      <button
                        onClick={generateVoiceover}
                        disabled={!ttsScript.trim() || ttsGenerating}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {ttsGenerating
                          ? <><Loader2 size={13} className="animate-spin" /> Generating voiceover…</>
                          : <><Sparkles size={13} /> Generate Voiceover</>}
                      </button>

                      {ttsError && (
                        <p className="flex items-start gap-1.5 text-xs text-red-400">
                          <AlertCircle size={12} className="shrink-0 mt-0.5" /> {ttsError}
                        </p>
                      )}
                      {ttsDone && (
                        <p className="text-xs text-emerald-400">
                          Voiceover saved as this zone's audio — preview it below. Generate again to replace it.
                        </p>
                      )}

                      <p className="text-[10px] text-zinc-600 leading-relaxed">
                        Generated once and saved with your experience — playback never uses your API quota.
                      </p>
                    </>
                  )}
                </div>
              )}
              {sourceType === 'url' && (
                 <input
                   type="text"
                   className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-white"
                   placeholder="https://"
                   value={zone.media_url}
                   onChange={(e) => onUpdate({ media_url: e.target.value })}
                 />
              )}
            </div>
            {zone.media_url && !zone.media_url.startsWith('blob:temp') && (
              <>
                <AudioPreview key={zone.media_url} url={zone.media_url} volume={zone.volume ?? 1} />
                <button
                  type="button"
                  onClick={() => { onUpdate({ media_url: '', voiceover_script: '' }); setFileName(''); setTtsDone(false); }}
                  className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={12} /> Remove hint sound
                </button>
              </>
            )}
            {!zone.media_url && (
              <p className="text-[10px] text-zinc-500 mt-2">
                Leave empty for a silent, purely audio-hunted discoverable — the player only ever hears their own footsteps.
              </p>
            )}
          </div>

          {zone.media_url && (
            <div>
              <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                <span>Volume</span>
                <span>{Math.round((zone.volume ?? 1) * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                className="w-full accent-pink-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                value={zone.volume ?? 1}
                onChange={(e) => onUpdate({ volume: Math.max(0.05, parseFloat(e.target.value)) })}
              />
            </div>
          )}

          {/* Hint + Collect radii */}
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                <span>Hint Radius</span>
                <span>{Math.round(zone.radius * 3.28084)} ft</span>
              </div>
              <input
                type="range"
                min="0"
                max={RADIUS_SLIDER_MAX}
                step="1"
                className="w-full accent-pink-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                value={radiusToSlider(zone.radius)}
                onChange={(e) => {
                  const nextRadius = sliderToRadius(Number(e.target.value));
                  const updates: Partial<Zone> = { radius: nextRadius };
                  if (zone.collect_radius != null && zone.collect_radius > nextRadius) {
                    updates.collect_radius = nextRadius;
                  }
                  onUpdate(updates);
                }}
              />
              <p className="text-[10px] text-zinc-500 mt-1">How far away the hint sound can be heard.</p>
              {zone.radius < 15 && (
                <p className="text-[10px] text-amber-400/90 mt-1">
                  GPS is usually only accurate to 15–50 ft — a zone this small may not trigger reliably.
                </p>
              )}
            </div>
            <div>
              <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                <span>Collect Radius</span>
                <span>{Math.round((zone.collect_radius ?? zone.radius) * 3.28084)} ft</span>
              </div>
              <input
                type="range"
                min="0"
                max={radiusToSlider(zone.radius)}
                step="1"
                className="w-full accent-pink-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                value={radiusToSlider(zone.collect_radius ?? zone.radius)}
                onChange={(e) => onUpdate({ collect_radius: Math.min(zone.radius, sliderToRadius(Number(e.target.value))) })}
              />
              <p className="text-[10px] text-zinc-500 mt-1">How close the player must walk to actually pick it up.</p>
            </div>
          </div>

          {/* Toggles */}
          <div className="space-y-2">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${zone.is_mystery ? 'bg-pink-500 border-pink-500' : 'border-zinc-600 bg-transparent'}`}>
                {zone.is_mystery && <div className="w-2 h-2 bg-white rounded-sm" />}
              </div>
              <input
                type="checkbox"
                className="hidden"
                checked={!!zone.is_mystery}
                onChange={(e) => onUpdate({ is_mystery: e.target.checked })}
              />
              <span className="text-sm text-zinc-300 group-hover:text-white transition-colors flex items-center gap-2">
                <HelpCircle size={14} /> Hide Until Found
              </span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${!zone.is_visible ? 'bg-pink-500 border-pink-500' : 'border-zinc-600 bg-transparent'}`}>
                {!zone.is_visible && <div className="w-2 h-2 bg-white rounded-sm" />}
              </div>
              <input type="checkbox" className="hidden" checked={!zone.is_visible} onChange={(e) => onUpdate({ is_visible: !e.target.checked })} />
              <span className="text-sm text-zinc-300 group-hover:text-white transition-colors flex items-center gap-2">
                <EyeOff size={14} /> Invisible on Map
              </span>
            </label>
            {zone.media_url && (
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${zone.use_attenuation ? 'bg-pink-500 border-pink-500' : 'border-zinc-600 bg-transparent'}`}>
                  {zone.use_attenuation && <div className="w-2 h-2 bg-white rounded-sm" />}
                </div>
                <input type="checkbox" className="hidden" checked={zone.use_attenuation} onChange={(e) => onUpdate({ use_attenuation: e.target.checked })} />
                <span className="text-sm text-zinc-300">Distance Attenuation</span>
              </label>
            )}
          </div>

          {zone.media_url && (
            <div className="grid grid-cols-2 gap-4 border-t border-zinc-800 pt-4">
              <div>
                <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                  <span>Fade In</span>
                  <span>{zone.fade_in > 0 ? `${zone.fade_in}s` : 'Off'}</span>
                </div>
                <input type="range" min="0" max="5" step="0.5" className="w-full h-1 bg-zinc-700 rounded accent-pink-500" value={zone.fade_in} onChange={(e) => onUpdate({ fade_in: parseFloat(e.target.value) })} />
              </div>
              <div>
                <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                  <span>Fade Out</span>
                  <span>{zone.fade_out > 0 ? `${zone.fade_out}s` : 'Off'}</span>
                </div>
                <input type="range" min="0" max="5" step="0.5" className="w-full h-1 bg-zinc-700 rounded accent-pink-500" value={zone.fade_out} onChange={(e) => onUpdate({ fade_out: parseFloat(e.target.value) })} />
              </div>
            </div>
          )}
        </div>
      ) : (
        /* --- MEDIA ZONE SETTINGS --- */
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
          {/* Optional media-zone image */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <ImageIcon size={14} /> Zone Image <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleImageUpload(e, 'zone_image_url')}
            />
            {zone.zone_image_url ? (
              <div className="relative w-24 h-24 group">
                <img
                  src={zone.zone_image_url}
                  alt="Zone image"
                  className="w-24 h-24 object-cover rounded-xl border border-zinc-700"
                />
                <button
                  onClick={() => onUpdate({ zone_image_url: null })}
                  className="absolute -top-2 -right-2 z-10 w-6 h-6 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove zone image"
                >
                  <X size={12} />
                </button>
                <button
                  onClick={() => imageInputRef.current?.click()}
                  className="absolute inset-0 rounded-xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold"
                >
                  Replace
                </button>
              </div>
            ) : (
              <button
                onClick={() => !imageUploading && imageInputRef.current?.click()}
                className="w-24 h-24 rounded-xl border-2 border-dashed border-zinc-700 hover:border-emerald-500 hover:bg-emerald-500/5 flex flex-col items-center justify-center gap-1.5 text-zinc-500 hover:text-emerald-400 transition-all"
              >
                {imageUploading
                  ? <Loader2 size={18} className="animate-spin" />
                  : <Upload size={18} />
                }
                <span className="text-[10px] font-bold uppercase tracking-wide">
                  {imageUploading ? 'Uploading' : 'Upload'}
                </span>
              </button>
            )}
            {imageUploadError && (
              <p className="text-xs text-red-400 mt-1.5 leading-snug">{imageUploadError}</p>
            )}
            {!imageUploadError && (
              <p className="text-[10px] text-zinc-500 mt-1.5">
                Shown with this zone's title and description. Audio is optional.
              </p>
            )}
          </div>

          {/* Audio Source (Preset/Upload/Link) */}
           <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Music size={14} /> Audio <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <div className="flex bg-zinc-800 rounded p-1 mb-3">
              <button onClick={() => setSourceType('upload')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'upload' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Upload</button>
              <button onClick={() => setSourceType('ai')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'ai' ? 'bg-indigo-600 text-white' : 'text-zinc-400'}`}>AI Voice</button>
              <button onClick={() => setSourceType('url')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'url' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Link</button>
              <button onClick={() => setSourceType('preset')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'preset' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Preset</button>
            </div>

            <div className="bg-zinc-800/50 rounded border border-zinc-800 p-3">
              {sourceType === 'preset' && (
                <select
                  className="w-full bg-zinc-900 text-sm text-white border border-zinc-700 rounded p-2"
                  value={zone.media_url.startsWith('data:') ? '' : zone.media_url}
                  onChange={(e) => onUpdate({ media_url: e.target.value })}
                >
                  <option value="" disabled>Select Demo Track</option>
                  {SAMPLE_AUDIO_FILES.map((file, idx) => (
                    <option key={idx} value={file.url}>{file.label}</option>
                  ))}
                </select>
              )}
              {sourceType === 'upload' && (
                <>
                  <div
                    onClick={() => !audioUploading && fileInputRef.current?.click()}
                    className={`border border-dashed border-zinc-700 p-4 text-center rounded transition-colors ${audioUploading ? 'cursor-wait opacity-60' : 'cursor-pointer hover:bg-zinc-800'}`}
                  >
                    <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileUpload} />
                    {audioUploading ? (
                      <span className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                        <Loader2 size={13} className="animate-spin" /> Uploading…
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">{fileName || 'Click to Upload'}</span>
                    )}
                  </div>
                  {uploadError && (
                    <p className="flex items-center gap-1.5 text-xs text-red-400 mt-1.5">
                      <AlertCircle size={12} className="shrink-0" /> {uploadError}
                    </p>
                  )}
                </>
              )}
              {sourceType === 'ai' && (
                <div className="space-y-3">
                  {ttsLoadingVoices && (
                    <p className="flex items-center gap-2 text-xs text-zinc-400 py-2">
                      <Loader2 size={13} className="animate-spin" /> Loading your ElevenLabs voices…
                    </p>
                  )}

                  {ttsVoicesError && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2.5 leading-relaxed">
                      <AlertCircle size={12} className="shrink-0 mt-0.5" /> {ttsVoicesError}
                    </p>
                  )}

                  {ttsVoices && ttsVoices.length > 0 && (
                    <>
                      {/* Script */}
                      <div>
                        <div className="flex items-baseline justify-between mb-1">
                          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Voiceover script</label>
                          <span className={`text-[10px] tabular-nums ${ttsScript.length > 9000 ? 'text-amber-400' : 'text-zinc-600'}`}>
                            {ttsScript.length}/10000
                          </span>
                        </div>
                        <textarea
                          value={ttsScript}
                          onChange={e => { onUpdate({ voiceover_script: e.target.value.slice(0, 10000) }); setTtsDone(false); }}
                          rows={4}
                          placeholder="Write the voiceover script…"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded p-2.5 text-xs text-white placeholder-zinc-600 leading-relaxed resize-y break-words whitespace-pre-wrap focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      {/* Voice picker */}
                      <div>
                        <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Voice</label>
                        <div className="flex gap-2">
                          <select
                            value={ttsVoiceId}
                            onChange={e => setTtsVoiceId(e.target.value)}
                            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                          >
                            {ttsVoices.map(v => (
                              <option key={v.voice_id} value={v.voice_id}>
                                {v.name}{v.category === 'premade' ? '' : ` (${v.category})`}
                              </option>
                            ))}
                          </select>
                          {(() => {
                            const v = ttsVoices.find(x => x.voice_id === ttsVoiceId);
                            return v?.preview_url ? (
                              <button
                                onClick={() => playVoiceSample(v.name, v.preview_url!)}
                                className="px-2.5 shrink-0 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-white transition-colors"
                                title="Preview voice"
                              >
                                {playingVoice === v.name ? <Pause size={12} /> : <Play size={12} />}
                              </button>
                            ) : null;
                          })()}
                        </div>
                      </div>

                      {/* Generate */}
                      <button
                        onClick={generateVoiceover}
                        disabled={!ttsScript.trim() || ttsGenerating}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {ttsGenerating
                          ? <><Loader2 size={13} className="animate-spin" /> Generating voiceover…</>
                          : <><Sparkles size={13} /> Generate Voiceover</>}
                      </button>

                      {ttsError && (
                        <p className="flex items-start gap-1.5 text-xs text-red-400">
                          <AlertCircle size={12} className="shrink-0 mt-0.5" /> {ttsError}
                        </p>
                      )}
                      {ttsDone && (
                        <p className="text-xs text-emerald-400">
                          Voiceover saved as this zone's audio — preview it below. Generate again to replace it.
                        </p>
                      )}

                      <p className="text-[10px] text-zinc-600 leading-relaxed">
                        Generated once and saved with your experience — playback never uses your API quota.
                      </p>
                    </>
                  )}
                </div>
              )}
              {sourceType === 'url' && (
                 <input
                   type="text"
                   className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-white"
                   placeholder="https://"
                   value={zone.media_url}
                   onChange={(e) => onUpdate({ media_url: e.target.value })}
                 />
              )}
            </div>
            {/* Preview player — shown whenever there's a valid URL */}
            {zone.media_url && !zone.media_url.startsWith('blob:temp') && (
              <>
                <AudioPreview key={zone.media_url} url={zone.media_url} volume={zone.volume ?? 1} />
                <button
                  type="button"
                  onClick={() => { onUpdate({ media_url: '', voiceover_script: '' }); setFileName(''); setTtsDone(false); }}
                  className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={12} /> Remove audio
                </button>
              </>
            )}
            {!zone.media_url && (
              <p className="text-[10px] text-zinc-500 mt-2">
                Leave audio empty for an image-only or text-only zone.
              </p>
            )}
          </div>

          {/* Audio volume + universal radius */}
          <div className="space-y-4">
            {zone.media_url && (
              <div>
                <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                  <span>Volume</span>
                  <span>{Math.round((zone.volume ?? 1) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  className="w-full accent-emerald-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                  value={zone.volume ?? 1}
                  onChange={(e) => onUpdate({ volume: Math.max(0.05, parseFloat(e.target.value)) })}
                />
              </div>
            )}
            
            <div>
              <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                <span>Radius</span>
                <span>{Math.round(zone.radius * 3.28084)} ft</span>
              </div>
              <input
                type="range"
                min="0"
                max={RADIUS_SLIDER_MAX}
                step="1"
                className="w-full accent-blue-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                value={radiusToSlider(zone.radius)}
                onChange={(e) => onUpdate({ radius: sliderToRadius(Number(e.target.value)) })}
              />
              {zone.radius < 15 && (
                <p className="text-[10px] text-amber-400/90 mt-1">
                  GPS is usually only accurate to 15–50 ft — a zone this small may not trigger reliably.
                </p>
              )}
            </div>
          </div>

          {/* Advanced Toggles */}
          <div className="space-y-2">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${!zone.is_visible ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600 bg-transparent'}`}>
                {!zone.is_visible && <div className="w-2 h-2 bg-white rounded-sm" />}
              </div>
              <input type="checkbox" className="hidden" checked={!zone.is_visible} onChange={(e) => onUpdate({ is_visible: !e.target.checked })} />
              <span className="text-sm text-zinc-300">Invisible on Map</span>
            </label>
            {zone.media_url && (
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${zone.use_attenuation ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600 bg-transparent'}`}>
                  {zone.use_attenuation && <div className="w-2 h-2 bg-white rounded-sm" />}
                </div>
                <input type="checkbox" className="hidden" checked={zone.use_attenuation} onChange={(e) => onUpdate({ use_attenuation: e.target.checked })} />
                <span className="text-sm text-zinc-300">Distance Attenuation</span>
              </label>
            )}
          </div>
          
          {zone.media_url && (
            <>
              <div className="grid grid-cols-2 gap-4 border-t border-zinc-800 pt-4">
                <div>
                  <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                    <span>Fade In</span>
                    <span>{zone.fade_in > 0 ? `${zone.fade_in}s` : 'Off'}</span>
                  </div>
                  <input type="range" min="0" max="5" step="0.5" className="w-full h-1 bg-zinc-700 rounded accent-emerald-500" value={zone.fade_in} onChange={(e) => onUpdate({ fade_in: parseFloat(e.target.value) })} />
                </div>
                <div>
                  <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                    <span>Fade Out</span>
                    <span>{zone.fade_out > 0 ? `${zone.fade_out}s` : 'Off'}</span>
                  </div>
                  <input type="range" min="0" max="5" step="0.5" className="w-full h-1 bg-zinc-700 rounded accent-emerald-500" value={zone.fade_out} onChange={(e) => onUpdate({ fade_out: parseFloat(e.target.value) })} />
                </div>
              </div>

              {/* Playback Behavior */}
              <div className="border-t border-zinc-800 pt-4 space-y-3">
                <div>
                  <label className="block text-xs font-bold text-zinc-400 uppercase mb-1.5">On Exit</label>
                  <div className="flex gap-1">
                    {(['stop', 'pause', 'keep'] as ZoneExitBehavior[]).map(val => (
                      <button
                        key={val}
                        onClick={() => onUpdate({ on_exit: val })}
                        className={`flex-1 py-1.5 text-xs rounded capitalize border transition-colors ${zone.on_exit === val ? 'bg-emerald-600 text-white border-emerald-500' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                      >{val}</button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-1">What happens when the player leaves this zone.</p>
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-400 uppercase mb-1.5">On End</label>
                  <div className="flex gap-1">
                    {(['stop', 'loop', 'destroy'] as ZoneEndBehavior[]).map(val => (
                      <button
                        key={val}
                        onClick={() => onUpdate({ on_end: val })}
                        className={`flex-1 py-1.5 text-xs rounded capitalize border transition-colors ${(zone.on_end || 'stop') === val ? (val === 'destroy' ? 'bg-red-600/40 text-red-300 border-red-500/50' : 'bg-emerald-600 text-white border-emerald-500') : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                      >{val}</button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-1">
                    <strong className="text-zinc-400">Stop</strong> — plays once per visit, replays on re-entry. &nbsp;
                    <strong className="text-zinc-400">Loop</strong> — repeats. &nbsp;
                    <strong className="text-red-400">Destroy</strong> — plays once, then gone for the session.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── GATING & SEQUENCE ─── */}
      <div className="border-t border-zinc-800 pt-5 mt-2 space-y-5">
        <h3 className="text-amber-400 font-bold uppercase tracking-wider text-sm flex items-center gap-2">
          <Lock size={14} /> Gating &amp; Sequence
        </h3>

        {/* Requires Zone */}
        {zonesList && zonesList.filter(z => z.id !== zone.id).length > 0 && (
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
              <GitBranch size={14} /> Requires Zone
            </label>
            <select
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white outline-none focus:border-amber-500"
              value={zone.requires_zone_id || ''}
              onChange={(e) => onUpdate({ requires_zone_id: e.target.value || null })}
            >
              <option value="">— No prerequisite —</option>
              {zonesList
                .filter(z => z.id !== zone.id)
                .map(z => (
                  <option key={z.id} value={z.id}>{z.title}</option>
                ))}
            </select>
            <p className="text-[10px] text-zinc-500 mt-1">Zone only activates after the selected zone has been visited.</p>
          </div>
        )}

        <div>
          <label className="block text-xs font-bold text-zinc-400 uppercase mb-2">Lock</label>
          <div className="flex bg-zinc-800 rounded p-1 mb-3">
            <button
              onClick={() => onUpdate({ lock_type: 'none' })}
              className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded transition-colors ${(zone.lock_type ?? 'none') === 'none' ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              <Unlock size={13} /> Open
            </button>
            <button
              onClick={() => onUpdate({ lock_type: 'passphrase' })}
              className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded transition-colors ${zone.lock_type === 'passphrase' ? 'bg-amber-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              <Lock size={13} /> Passphrase
            </button>
          </div>

          {zone.lock_type === 'passphrase' && (
            <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
              <div>
                <label className="block text-xs font-bold text-zinc-400 uppercase mb-1">Passphrase</label>
                <input
                  type="text"
                  className="w-full bg-zinc-800 border border-amber-500/50 rounded px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none font-mono tracking-wider"
                  value={zone.lock_passphrase || ''}
                  onChange={(e) => onUpdate({ lock_passphrase: e.target.value })}
                  placeholder="e.g. golden oak"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-400 uppercase mb-1">Hint <span className="normal-case font-normal text-zinc-500">(optional)</span></label>
                <input
                  type="text"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
                  value={zone.lock_hint || ''}
                  onChange={(e) => onUpdate({ lock_hint: e.target.value })}
                  placeholder="e.g. Look for the oldest tree in the park"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {progressionEnabled && progressionResources.length > 0 && (
        <ZoneProgressionSettings
          zone={zone}
          resources={progressionResources}
          onUpdate={onUpdate}
          showRequirements={zone.type !== 'discoverable'}
        />
      )}

      {/* Delete Zone */}
      {onDelete && (
        <div className="mt-8 pt-5 border-t border-zinc-800">
          <button
            onClick={() => {
              if (window.confirm('Delete this zone? You can restore it with Undo in the toolbar.')) {
                onDelete();
              }
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 transition-all text-sm font-medium"
          >
            <Trash2 size={14} /> Delete Zone
          </button>
        </div>
      )}
    </div>
  );
};
