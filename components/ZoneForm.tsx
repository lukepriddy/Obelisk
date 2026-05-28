import React, { useRef, useState, useEffect } from 'react';
import { Zone, ZoneExitBehavior, ZoneEndBehavior } from '../types';
import { SAMPLE_AUDIO_FILES, VOICES, CHARACTER_TEMPLATES } from '../constants';
import { uploadAudio, uploadImage } from '../services/storageService';
import { geminiService } from '../services/geminiService';
import { audioService } from '../services/audioService';

// Module-level cache — survives re-renders, resets on page refresh.
// Keyed by voice name; value is the decoded AudioBuffer ready to play.
const voiceSampleCache = new Map<string, AudioBuffer>();
import { Music, AlertCircle, Clock, Volume2, EyeOff, Radio, PlayCircle, Upload, Link as LinkIcon, FileAudio, ListMusic, Bot, MessageSquare, Lock, Unlock, GitBranch, Bell, Sparkles, KeySquare, ImageIcon, X, Trash2, Play, Pause, Loader2 } from 'lucide-react';

// ── Mini audio preview player ───────────────────────────────────────────────
const AudioPreview: React.FC<{ url: string }> = ({ url }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // Reset state whenever the source URL changes
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setDuration(0);
  }, [url]);

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

  return (
    <div className="flex items-center gap-2.5 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 mt-2">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (a && a.duration && !isDragging.current) setProgress(a.currentTime / a.duration);
        }}
        onLoadedMetadata={() => {
          if (audioRef.current) setDuration(audioRef.current.duration);
        }}
        onEnded={() => { setPlaying(false); setProgress(0); }}
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
}

type AudioSourceType = 'preset' | 'upload' | 'url';

export const ZoneForm: React.FC<ZoneFormProps> = ({ zone, onUpdate, onDelete, zonesList }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [sourceType, setSourceType] = useState<AudioSourceType>('upload');
  const [fileName, setFileName] = useState<string>('');
  const [showAllVoices, setShowAllVoices] = useState(false);
  const [audioUploading, setAudioUploading] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  // null = idle, string = voice currently loading or playing
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);

  const playVoiceSample = async (voiceName: string) => {
    if (previewingVoice) return; // already loading or playing
    setPreviewingVoice(voiceName);

    try {
      // Ensure AudioContext is running (requires a user gesture — this IS one)
      if (audioService.context?.state === 'suspended') {
        await audioService.context.resume();
      }

      // Serve from cache if we already generated this voice
      let buffer = voiceSampleCache.get(voiceName);

      if (!buffer) {
        const { audioBuffer } = await geminiService.generateCharacterResponse(
          [],
          'Welcome. I\'m glad you found me here. There\'s much to discover on this journey.',
          'You are demonstrating your voice. Speak the sample text naturally and clearly. Keep it brief.',
          voiceName,
        );
        if (audioBuffer) {
          voiceSampleCache.set(voiceName, audioBuffer);
          buffer = audioBuffer;
        }
      }

      if (buffer && audioService.context) {
        const ctx = audioService.context;
        if (ctx.state === 'suspended') await ctx.resume();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0);
        src.onended = () => setPreviewingVoice(null);
        return; // onended will clear previewingVoice
      }
    } catch {
      // silent fail — just clear the spinner
    }

    setPreviewingVoice(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    e.target.value = '';

    setAudioUploading(true);
    const url = await uploadAudio(file, zone.tour_id);
    setAudioUploading(false);

    if (url) {
      onUpdate({ media_url: url });
    } else {
      // Fallback to blob URL so the builder stays usable even if storage isn't set up yet
      onUpdate({ media_url: URL.createObjectURL(file) });
    }
  };

  return (
    <div className="text-zinc-200 pb-20">
      <div className="mb-6">
        <h3 className="text-emerald-400 font-bold uppercase tracking-wider text-sm mb-4">Zone Properties</h3>
        
        {/* Type Selector */}
        <div className="flex bg-zinc-800 rounded p-1 mb-6">
             <button 
               onClick={() => onUpdate({ type: 'audio' })}
               className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded transition-colors ${zone.type !== 'character' ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
             >
               <Music size={14} /> Audio Zone
             </button>
             <button 
               onClick={() => onUpdate({ type: 'character' })}
               className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded transition-colors ${zone.type === 'character' ? 'bg-indigo-500 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
             >
               <Bot size={14} /> AI Character
             </button>
        </div>

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
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none resize-none"
            rows={2}
            value={zone.description || ''}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder="Short description for the player..."
          />
        </div>
      </div>

      {/* Entry Message — applies to all zone types */}
      <div className="mb-6">
        <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
          <Bell size={14} /> Entry Message
        </label>
        <textarea
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none resize-none"
          rows={2}
          value={zone.entry_message || ''}
          onChange={(e) => onUpdate({ entry_message: e.target.value })}
          placeholder="Text shown on screen when player enters this zone..."
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
            <p className="text-[10px] text-zinc-500 mt-1.5">Tap to load a starting prompt. You can customise it after.</p>
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
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                e.target.value = '';
                setImageUploading(true);
                const url = await uploadImage(file, zone.tour_id);
                setImageUploading(false);
                onUpdate({ character_image_url: url ?? URL.createObjectURL(file) });
              }}
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
            <p className="text-[10px] text-zinc-500 mt-1.5">Shown on the character card and in the chat header.</p>
          </div>

          {/* Player-Facing Bio */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <MessageSquare size={14} /> Player-Facing Description
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-none min-h-[130px]"
              value={zone.character_bio || ''}
              onChange={(e) => onUpdate({ character_bio: e.target.value })}
              placeholder="e.g. A weathered lighthouse keeper who has watched ships come and go for forty years. He knows every secret the harbour holds."
            />
            <p className="text-[10px] text-zinc-500 mt-1">Shown on the card players see before starting the conversation. Keep it evocative — set the scene.</p>
          </div>

          {/* Character Persona */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <MessageSquare size={14} /> Persona & Instructions
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-indigo-500/50 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-none min-h-[130px]"
              value={zone.character_prompt || ''}
              onChange={(e) => onUpdate({ character_prompt: e.target.value })}
              placeholder="Example: You are a grumpy troll living under this bridge. You demand a riddle to pass. Keep your answers short and in character."
            />
            <p className="text-[10px] text-zinc-400 mt-1.5">
              Defines the AI's personality, knowledge, and goals. Be specific — the more detail, the better the character.
            </p>
          </div>

          {/* Greeting Message */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1.5">
              Opening Line <span className="normal-case font-normal text-zinc-500">(optional)</span>
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none resize-none"
              rows={2}
              value={zone.greeting_message || ''}
              onChange={(e) => onUpdate({ greeting_message: e.target.value })}
              placeholder="e.g. Well, well... a visitor. I haven't had company in a very long time."
            />
            <p className="text-[10px] text-zinc-500 mt-1">Script the character's exact first words. Leave blank for an auto-generated greeting.</p>
          </div>

          {/* Voice Picker */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2">Voice</label>
            <div className="grid grid-cols-2 gap-2">
              {(showAllVoices ? INTERLEAVED_VOICES : INTERLEAVED_VOICES.slice(0, 4)).map(v => {
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
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          playVoiceSample(v.name);
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click(); }}
                        title={voiceSampleCache.has(v.name) ? 'Play sample' : 'Generate & play sample'}
                        className={`p-1 rounded transition-colors shrink-0 -mr-1 cursor-pointer ${
                          previewingVoice === v.name
                            ? 'text-indigo-400'
                            : previewingVoice
                            ? 'text-zinc-700 cursor-not-allowed'
                            : 'text-zinc-500 hover:text-white'
                        }`}
                      >
                        {previewingVoice === v.name
                          ? <Loader2 size={11} className="animate-spin" />
                          : <Volume2 size={11} />
                        }
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            {/* If the selected voice is hidden, always surface it */}
            {!showAllVoices && zone.voice_style && !INTERLEAVED_VOICES.slice(0, 4).find(v => v.name === zone.voice_style) && (() => {
              const v = VOICES.find(v => v.name === zone.voice_style);
              return v ? (
                <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-indigo-600/20 border-indigo-500 text-white text-xs">
                  <span className="font-semibold">{v.name}</span>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${v.gender === 'F' ? 'bg-pink-500/20 text-pink-400' : 'bg-blue-500/20 text-blue-400'}`}>{v.gender}</span>
                  <span className="text-indigo-300 ml-1">{v.description}</span>
                  <span className="ml-auto text-[10px] text-indigo-400">Selected</span>
                </div>
              ) : null;
            })()}
            <button
              onClick={() => setShowAllVoices(s => !s)}
              className="mt-2 w-full text-center text-xs text-zinc-400 hover:text-white py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              {showAllVoices ? `Show less` : `Show all ${VOICES.length} voices…`}
            </button>
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
                  onChange={(e) => onUpdate({ avatar_unlock_zone_id: e.target.value || undefined })}
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
              <span>Interaction Radius (m)</span>
              <span>{zone.radius}m</span>
            </div>
            <input
              type="range"
              min="5"
              max="500"
              step="5"
              className="w-full accent-indigo-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
              value={zone.radius}
              onChange={(e) => onUpdate({ radius: parseInt(e.target.value) })}
            />
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
      ) : (
        /* --- AUDIO SETTINGS --- */
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
          {/* Audio Source (Preset/Upload/Link) */}
           <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Music size={14} /> Audio Source
            </label>
            <div className="flex bg-zinc-800 rounded p-1 mb-3">
              <button onClick={() => setSourceType('upload')} className={`flex-1 py-1 text-xs rounded ${sourceType === 'upload' ? 'bg-emerald-600 text-white' : 'text-zinc-400'}`}>Upload</button>
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
              <AudioPreview key={zone.media_url} url={zone.media_url} />
            )}
          </div>

          {/* Volume & Radius */}
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                <span>Volume</span>
                <span>{Math.round((zone.volume || 1) * 10)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                className="w-full accent-emerald-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                value={zone.volume ?? 1}
                onChange={(e) => onUpdate({ volume: parseFloat(e.target.value) })}
              />
            </div>
            
            <div>
              <div className="flex justify-between text-xs font-bold text-zinc-400 uppercase mb-1">
                <span>Radius (m)</span>
                <span>{zone.radius}m</span>
              </div>
              <input
                type="range"
                min="5"
                max="500"
                step="5"
                className="w-full accent-blue-500 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                value={zone.radius}
                onChange={(e) => onUpdate({ radius: parseInt(e.target.value) })}
              />
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
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className={`w-4 h-4 border rounded transition-colors flex items-center justify-center ${zone.use_attenuation ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600 bg-transparent'}`}>
                {zone.use_attenuation && <div className="w-2 h-2 bg-white rounded-sm" />}
              </div>
              <input type="checkbox" className="hidden" checked={zone.use_attenuation} onChange={(e) => onUpdate({ use_attenuation: e.target.checked })} />
              <span className="text-sm text-zinc-300">Distance Attenuation</span>
            </label>
          </div>
          
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
                {(['loop', 'stop', 'destroy'] as ZoneEndBehavior[]).map(val => (
                  <button
                    key={val}
                    onClick={() => onUpdate({ on_end: val })}
                    className={`flex-1 py-1.5 text-xs rounded capitalize border transition-colors ${zone.on_end === val ? (val === 'destroy' ? 'bg-red-600/40 text-red-300 border-red-500/50' : 'bg-emerald-600 text-white border-emerald-500') : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                  >{val}</button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-500 mt-1">
                <strong className="text-zinc-400">Loop</strong> — repeats. &nbsp;
                <strong className="text-zinc-400">Stop</strong> — plays once per visit, replays on re-entry. &nbsp;
                <strong className="text-red-400">Destroy</strong> — plays once, then gone for the session.
              </p>
            </div>
          </div>
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
              onChange={(e) => onUpdate({ requires_zone_id: e.target.value || undefined })}
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

        {/* Lock Type */}
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

      {/* Delete Zone */}
      {onDelete && (
        <div className="mt-8 pt-5 border-t border-zinc-800">
          <button
            onClick={() => {
              if (window.confirm('Delete this zone? This cannot be undone (use Undo in the toolbar to restore it).')) {
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