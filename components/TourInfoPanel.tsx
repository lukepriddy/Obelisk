import React, { useState, useRef } from 'react';
import { Tour, Zone } from '../types';
import { MAP_STYLES, FONT_STYLES, DEFAULT_MAP_STYLE } from '../constants';
import { uploadImage } from '../services/storageService';
import { MediaPicker } from './MediaPicker';
import { Image as ImageIcon, Type, Palette, AlignLeft, AlignCenter, Upload, MapPin, Eye, Settings, Globe, Lock, Loader2, Sun, Moon, X, Tag as TagIcon, Clock, Route, EyeOff } from 'lucide-react';
import { ProgressionSettings } from './ProgressionSettings';
import { ClosingCardSettings } from './ClosingCardSettings';
import { trailStats, formatDistance, suggestDuration } from '../utils/trail';

interface TourInfoPanelProps {
  tour: Tour;
  /** Used only to derive the route stats that anchor the duration estimate. */
  zones?: Zone[];
  /** Measured average from completed sessions, when there are any. */
  measuredSeconds?: number | null;
  completedSessions?: number;
  onUpdate: (updates: Partial<Tour>) => void;
  /** Save the draft, then submit it for review. Only offered for a tour that
   *  is already live, where saving alone no longer changes what players get. */
  onPublishChanges?: () => void;
  publishing?: boolean;
  /** Transient message about the submission itself, not about the content —
   *  "you just did this, wait a minute". Not a review verdict. */
  publishNotice?: string | null;
}

const ACCENT_PRESETS = ['#10b981','#6366f1','#f59e0b','#ef4444','#3b82f6','#ec4899'];
const BG_PRESETS     = ['#0f172a','#111827','#ffffff','#fafaf9','#1e293b','#18181b'];
const TEXT_PRESETS   = ['#ffffff','#f1f5f9','#1e293b','#0f172a','#94a3b8','#d1fae5'];

// File-type and size validation now lives in services/storageService.ts so
// every upload path shares one set of rules; it reports failures via onError.

export const TourInfoPanel: React.FC<TourInfoPanelProps> = ({
  tour, zones = [], measuredSeconds, completedSessions = 0, onUpdate,
  onPublishChanges, publishing = false, publishNotice = null,
}) => {
  const [tagDraft, setTagDraft] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pickingImage, setPickingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const accent  = tour.accent_color || '#10b981';
  const bg      = tour.bg_color     || '#09090b';
  const textCol = tour.text_color   || '#ffffff';
  const font    = FONT_STYLES[tour.font_style || 'sans'];

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImageError(null);

    setImageUploading(true);
    const url = await uploadImage(file, tour.id, { onError: setImageError });
    setImageUploading(false);

    if (url) onUpdate({ welcome_image_url: url });
  };

  return (
    <div className="text-zinc-200 pb-20">
      <h3 className="text-emerald-400 font-bold uppercase tracking-wider text-sm mb-4">Experience Settings</h3>

      {/* Tabs */}
      <div className="flex bg-zinc-800 rounded p-1 mb-5">
        <button
          onClick={() => setTab('edit')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded transition-colors ${tab === 'edit' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          <Settings size={12} /> Edit
        </button>
        <button
          onClick={() => setTab('preview')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded transition-colors ${tab === 'preview' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          <Eye size={12} /> Preview
        </button>
      </div>

      {tab === 'preview' ? (
        /* ── PREVIEW ── */
        <div className="rounded-xl overflow-hidden border border-zinc-800 shadow-xl" style={{ backgroundColor: bg, fontFamily: font.fontFamily }}>
          {tour.welcome_image_url && (
            <div className="flex justify-center pt-5 px-5">
              <img src={tour.welcome_image_url} alt="" className="w-32 h-32 object-cover rounded-xl" />
            </div>
          )}
          <div className="px-4 py-4 text-center space-y-2">
            <p className="font-bold text-base leading-tight" style={{ color: textCol }}>{tour.title || 'Tour Title'}</p>
            {tour.welcome_subtitle && (
              <p className="text-xs opacity-80" style={{ color: accent }}>{tour.welcome_subtitle}</p>
            )}
            {tour.description && (
              <p className="text-xs leading-relaxed line-clamp-3 opacity-70" style={{ color: textCol }}>{tour.description}</p>
            )}
            <div className="pt-1">
              <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
                <MapPin size={10} /> Starting location
              </span>
            </div>
            <div className="pt-1">
              <span className="inline-block px-4 py-1.5 rounded-full text-xs font-bold text-white" style={{ backgroundColor: accent }}>
                Start
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* ── EDIT ── */
        <div className="space-y-5">

          {/* Title */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
              <Type size={13} /> Title
            </label>
            <input
              type="text"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              value={tour.title}
              onChange={(e) => onUpdate({ title: e.target.value })}
            />
          </div>

          {/* Tags — creator-side only; group experiences like folders */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
              <TagIcon size={13} /> Tags
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {(tour.tags || []).map(tag => (
                <span key={tag} className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
                  {tag}
                  <button
                    type="button"
                    onClick={() => onUpdate({ tags: (tour.tags || []).filter(t => t !== tag) })}
                    className="w-4 h-4 flex items-center justify-center rounded text-zinc-500 hover:text-red-400"
                    aria-label={`Remove tag ${tag}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {(tour.tags || []).length === 0 && (
                <span className="text-[11px] text-zinc-600">No tags yet.</span>
              )}
            </div>
            <input
              type="text"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              placeholder="Type a tag, press Enter…"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                // Normalised so "Halloween" and "halloween" don't become two folders.
                const tag = tagDraft.trim().toLowerCase().slice(0, 32);
                if (!tag) return;
                const existing = tour.tags || [];
                if (!existing.includes(tag)) onUpdate({ tags: [...existing, tag] });
                setTagDraft('');
              }}
            />
            <p className="text-[10px] text-zinc-500 mt-1">Used to group and filter on your dashboard. Players never see these.</p>
          </div>

          {/* Subtitle */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
              <Type size={13} /> Subtitle
            </label>
            <input
              type="text"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              value={tour.welcome_subtitle || ''}
              onChange={(e) => onUpdate({ welcome_subtitle: e.target.value })}
              placeholder="Tagline under the title…"
            />
          </div>

          {/* How long it takes — planning information, so it has to be here
              rather than discovered mid-walk. Distance and shape come free from
              the zone coordinates; only the time needs the creator. */}
          {(() => {
            const stats = trailStats(tour, zones);
            const suggestion = suggestDuration(stats, measuredSeconds, completedSessions);
            return (
              <div>
                <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
                  <Clock size={13} /> How long it takes
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    className="w-24 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                    value={tour.duration_minutes ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (!raw) return onUpdate({ duration_minutes: null });
                      const n = Math.round(Number(raw));
                      if (Number.isFinite(n)) onUpdate({ duration_minutes: Math.min(1440, Math.max(1, n)) });
                    }}
                    placeholder="—"
                  />
                  <span className="text-xs text-zinc-400">minutes</span>
                  {suggestion && tour.duration_minutes !== suggestion.minutes && (
                    <button
                      type="button"
                      onClick={() => onUpdate({ duration_minutes: suggestion.minutes })}
                      className="ml-auto text-[11px] font-bold text-sky-400 hover:text-sky-300"
                    >
                      Use {suggestion.minutes}
                    </button>
                  )}
                </div>

                {stats.zoneCount > 0 && (
                  <p className="text-[10px] text-zinc-500 mt-1.5 flex items-center gap-1.5">
                    <Route size={11} className="shrink-0" />
                    {formatDistance(stats.distanceMeters)} across {stats.zoneCount}{' '}
                    {stats.zoneCount === 1 ? 'stop' : 'stops'}
                    {stats.furthestMeters > 0
                      ? ` · furthest is ${formatDistance(stats.furthestMeters)} from the start`
                      : ''}
                  </p>
                )}

                {suggestion && (
                  <p className={`text-[10px] mt-1 ${suggestion.basis === 'measured' ? 'text-emerald-500' : 'text-zinc-500'}`}>
                    {suggestion.note}
                  </p>
                )}

                <p className="text-[10px] text-zinc-500 mt-1">
                  Shown before anyone starts, so they can tell whether they have time for it.
                </p>
              </div>
            );
          })()}

          {/* Description */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-zinc-400 uppercase flex items-center gap-2">
                <AlignLeft size={13} /> Description / Instructions
              </label>
              {/* Alignment toggle — longer text often reads better left-aligned */}
              <div className="flex items-center gap-0.5 bg-zinc-800 border border-zinc-700 rounded p-0.5">
                <button
                  onClick={() => onUpdate({ description_align: 'center' })}
                  title="Center"
                  className={`p-1 rounded transition-colors ${(tour.description_align || 'center') === 'center' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  <AlignCenter size={13} />
                </button>
                <button
                  onClick={() => onUpdate({ description_align: 'left' })}
                  title="Left"
                  className={`p-1 rounded transition-colors ${tour.description_align === 'left' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  <AlignLeft size={13} />
                </button>
              </div>
            </div>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none resize-y break-words"
              rows={4}
              value={tour.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              placeholder="Describe the experience…"
              style={{ textAlign: tour.description_align === 'left' ? 'left' : 'center' }}
            />
          </div>

          {/* Image */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <ImageIcon size={13} /> Cover Image
            </label>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
            <div className="flex gap-2">
              <button
                onClick={() => !imageUploading && fileInputRef.current?.click()}
                className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300 transition-colors disabled:opacity-60"
                disabled={imageUploading}
              >
                {imageUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {imageUploading ? 'Uploading…' : 'Upload'}
              </button>
              <input
                type="text"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                value={tour.welcome_image_url || ''}
                onChange={(e) => { setImageError(null); onUpdate({ welcome_image_url: e.target.value }); }}
                placeholder="or paste URL..."
              />
            </div>
            <button
              onClick={() => setPickingImage(true)}
              className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              <ImageIcon size={10} /> Reuse an image from this experience
            </button>
            {pickingImage && (
              <MediaPicker
                tourId={tour.id}
                kind="image"
                currentUrl={tour.welcome_image_url}
                onPick={(url) => { setImageError(null); onUpdate({ welcome_image_url: url }); }}
                onClose={() => setPickingImage(false)}
              />
            )}
            {/* Says what the field is actually for. Most creators fill it once
                they know it's the picture that shows up when someone shares the
                link — which is cheaper than generating fallback cards for the
                ones who don't. */}
            <p className={`text-[10px] mt-1.5 ${tour.welcome_image_url ? 'text-zinc-500' : 'text-amber-500/80'}`}>
              {tour.welcome_image_url
                ? 'Shown on the welcome screen, and as the preview when this link is shared.'
                : 'Without one, sharing this link shows no picture, just the title. Worth adding.'}
            </p>
            {imageError && (
              <p className="mt-1.5 text-xs text-red-400 leading-snug">{imageError}</p>
            )}
            {tour.welcome_image_url && (
              <div className="mt-2 flex justify-center">
                <img
                  src={tour.welcome_image_url}
                  alt="Cover"
                  className="w-24 h-24 object-cover rounded-xl border border-zinc-700"
                  onError={(e) => (e.currentTarget.style.display = 'none')}
                />
              </div>
            )}
          </div>

          {/* Map Style */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <MapPin size={13} /> Map Style
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(MAP_STYLES).map(([key, style]) => (
                <button
                  key={key}
                  onClick={() => onUpdate({ map_style: key })}
                  className={`py-2 px-3 rounded text-xs font-medium transition-colors border ${
                    (tour.map_style || DEFAULT_MAP_STYLE) === key
                      ? 'bg-emerald-600 border-emerald-500 text-white'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  {style.label}
                </button>
              ))}
            </div>
          </div>

          {/* Player Theme */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Eye size={13} /> Player Theme
            </label>
            <div className="flex bg-zinc-800 rounded p-1 gap-1">
              <button
                onClick={() => onUpdate({ player_theme: 'dark' })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${(tour.player_theme || 'dark') === 'dark' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Moon size={12} /> Dark
              </button>
              <button
                onClick={() => onUpdate({ player_theme: 'light' })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${tour.player_theme === 'light' ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Sun size={12} /> Light
              </button>
            </div>
            <p className="text-[10px] text-zinc-500 mt-1.5">Controls the player UI chrome. Your accent color still comes through on buttons and indicators.</p>
          </div>

          {/* Font Style */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Type size={13} /> Font Style
            </label>
            <div className="flex gap-1.5">
              {Object.entries(FONT_STYLES).map(([key, f]) => (
                <button
                  key={key}
                  onClick={() => onUpdate({ font_style: key })}
                  className={`flex-1 py-2 px-2 rounded text-xs font-medium transition-colors border ${
                    (tour.font_style || 'sans') === key
                      ? 'bg-emerald-600 border-emerald-500 text-white'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                  }`}
                  style={{ fontFamily: f.fontFamily }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Accent Color */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Palette size={13} /> Accent Color
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {ACCENT_PRESETS.map((color) => (
                <button
                  key={color}
                  onClick={() => onUpdate({ accent_color: color })}
                  className="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                  style={{ backgroundColor: color, borderColor: accent === color ? 'white' : 'transparent' }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="color" className="w-8 h-8 rounded cursor-pointer bg-transparent border-0" value={accent} onChange={(e) => onUpdate({ accent_color: e.target.value })} />
              <input type="text" className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none" value={accent} onChange={(e) => onUpdate({ accent_color: e.target.value })} />
            </div>
          </div>

          {/* Background Color */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Palette size={13} /> Background Color
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {BG_PRESETS.map((color) => (
                <button
                  key={color}
                  onClick={() => onUpdate({ bg_color: color })}
                  className="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                  style={{ backgroundColor: color, borderColor: bg === color ? 'white' : 'transparent' }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="color" className="w-8 h-8 rounded cursor-pointer bg-transparent border-0" value={bg} onChange={(e) => onUpdate({ bg_color: e.target.value })} />
              <input type="text" className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none" value={bg} onChange={(e) => onUpdate({ bg_color: e.target.value })} />
            </div>
          </div>

          {/* Player progression */}
          <ProgressionSettings tour={tour} onUpdate={onUpdate} />

          {/* How it ends, and the only place money is asked for */}
          <ClosingCardSettings tour={tour} zones={zones} onUpdate={onUpdate} />

          {/* Visibility */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Globe size={13} /> Visibility
            </label>
            {/* Three states, because is_public was doing two jobs: deciding who
                can open the link, and deciding whether it may appear in
                listings. Unlisted separates them — fully playable by anyone
                holding the link, absent from search, maps and place pages.
                Listed-but-private is not offered because it cannot exist; a
                database constraint rejects it. */}
            <div className="flex bg-zinc-800 rounded p-1">
              <button
                onClick={() => onUpdate({ is_public: true, is_listed: true })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${tour.is_public && tour.is_listed !== false ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Globe size={12} /> Public
              </button>
              <button
                onClick={() => onUpdate({ is_public: true, is_listed: false })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${tour.is_public && tour.is_listed === false ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <EyeOff size={12} /> Unlisted
              </button>
              <button
                onClick={() => onUpdate({ is_public: false, is_listed: false })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${!tour.is_public ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Lock size={12} /> Private
              </button>
            </div>
            {/* Live tour: saving edits no longer changes what players get.
                The approved version stays up until a new one passes review,
                so pushing changes live is now a separate, deliberate act. */}
            {tour.is_public && (
              <div className="mt-2 rounded bg-zinc-800/60 border border-zinc-700 px-3 py-2">
                <p className="text-[11px] text-zinc-300 leading-snug">
                  Players are seeing the last approved version. Your edits are
                  saved but not live yet.
                </p>
                {onPublishChanges && (
                  <button
                    onClick={onPublishChanges}
                    disabled={publishing}
                    className="mt-2 w-full py-2 text-xs font-bold rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {publishing ? 'Checking…' : 'Publish changes'}
                  </button>
                )}
                {publishNotice ? (
                  <p className="text-[10px] text-zinc-400 leading-snug mt-1.5">
                    {publishNotice}
                  </p>
                ) : (
                  <p className="text-[10px] text-zinc-500 leading-snug mt-1.5">
                    If the check does not pass, the version players are walking
                    right now stays exactly as it is.
                  </p>
                )}
              </div>
            )}

            {/* Verdict on the DRAFT. Shown whether or not the tour is live,
                because the whole point is that a live tour can have a rejected
                draft without anything happening to the live version. */}
            {tour.draft_review_status === 'rejected' && (
              <div className="mt-2 rounded bg-red-950/70 border border-red-900 px-3 py-2">
                <p className="text-[11px] font-bold text-red-300">Changes not approved</p>
                <p className="text-[11px] text-red-200/90 leading-snug mt-0.5">
                  {tour.draft_review_reason || 'These changes did not pass review.'}
                </p>
                <p className="text-[10px] text-red-200/60 leading-snug mt-1">
                  {tour.is_public
                    ? 'Your live version is untouched. Edit the flagged content and submit again.'
                    : 'Edit the flagged content, then set it to Public and save again.'}
                </p>
              </div>
            )}
            {tour.draft_review_status === 'pending_review' && (
              <div className="mt-2 rounded bg-amber-950/70 border border-amber-900 px-3 py-2">
                <p className="text-[11px] font-bold text-amber-300">Waiting on a manual check</p>
                <p className="text-[11px] text-amber-200/90 leading-snug mt-0.5">
                  {tour.draft_review_reason || 'These changes need a manual check before they can go live.'}
                </p>
                {tour.is_public && (
                  <p className="text-[10px] text-amber-200/60 leading-snug mt-1">
                    Your live version is unaffected and still playable.
                  </p>
                )}
              </div>
            )}

            {tour.is_public && tour.is_listed !== false && (
              <p className="text-[10px] text-zinc-500 mt-1.5 leading-snug">
                Playable by anyone with the link, and can appear in search and on place pages.
              </p>
            )}
            {tour.is_public && tour.is_listed === false && (
              <p className="text-[10px] text-zinc-500 mt-1.5 leading-snug">
                Playable by anyone with the link, but kept out of search, maps and
                place pages. Good for sharing with friends, or testing.
              </p>
            )}
            {!tour.is_public && !tour.draft_review_status && (
              <p className="text-[10px] text-zinc-500 mt-1.5 leading-snug">
                Setting this to Public runs a quick content check when you save.
              </p>
            )}
          </div>

          {/* Text Color */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Type size={13} /> Text Color
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {TEXT_PRESETS.map((color) => (
                <button
                  key={color}
                  onClick={() => onUpdate({ text_color: color })}
                  className="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                  style={{ backgroundColor: color, borderColor: textCol === color ? 'white' : 'transparent' }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="color" className="w-8 h-8 rounded cursor-pointer bg-transparent border-0" value={textCol} onChange={(e) => onUpdate({ text_color: e.target.value })} />
              <input type="text" className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none" value={textCol} onChange={(e) => onUpdate({ text_color: e.target.value })} />
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
