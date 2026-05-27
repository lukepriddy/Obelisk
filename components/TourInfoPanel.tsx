import React, { useState, useRef } from 'react';
import { Tour } from '../types';
import { MAP_STYLES, FONT_STYLES } from '../constants';
import { uploadImage } from '../services/storageService';
import { Image, Type, Palette, AlignLeft, Upload, MapPin, Eye, Settings, Globe, Lock, Loader2, Sun, Moon } from 'lucide-react';

interface TourInfoPanelProps {
  tour: Tour;
  onUpdate: (updates: Partial<Tour>) => void;
}

const ACCENT_PRESETS = ['#10b981','#6366f1','#f59e0b','#ef4444','#3b82f6','#ec4899'];
const BG_PRESETS     = ['#0f172a','#111827','#ffffff','#fafaf9','#1e293b','#18181b'];
const TEXT_PRESETS   = ['#ffffff','#f1f5f9','#1e293b','#0f172a','#94a3b8','#d1fae5'];

export const TourInfoPanel: React.FC<TourInfoPanelProps> = ({ tour, onUpdate }) => {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [imageUploading, setImageUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const accent  = tour.accent_color || '#10b981';
  const bg      = tour.bg_color     || '#09090b';
  const textCol = tour.text_color   || '#ffffff';
  const font    = FONT_STYLES[tour.font_style || 'sans'];

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImageUploading(true);
    const url = await uploadImage(file, tour.id);
    setImageUploading(false);
    onUpdate({ welcome_image_url: url ?? URL.createObjectURL(file) });
  };

  return (
    <div className="text-zinc-200 pb-20">
      <h3 className="text-emerald-400 font-bold uppercase tracking-wider text-sm mb-4">Tour Settings</h3>

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
              placeholder="Short tagline shown under the title..."
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-1 flex items-center gap-2">
              <AlignLeft size={13} /> Description / Instructions
            </label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none resize-none"
              rows={4}
              value={tour.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              placeholder="Describe the experience. Instructions, backstory, what to expect..."
            />
          </div>

          {/* Image */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Image size={13} /> Cover Image
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
                onChange={(e) => onUpdate({ welcome_image_url: e.target.value })}
                placeholder="or paste URL..."
              />
            </div>
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
                    (tour.map_style || 'dark') === key
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

          {/* Visibility */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
              <Globe size={13} /> Visibility
            </label>
            <div className="flex bg-zinc-800 rounded p-1">
              <button
                onClick={() => onUpdate({ is_public: true })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${tour.is_public ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Globe size={12} /> Public
              </button>
              <button
                onClick={() => onUpdate({ is_public: false })}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded transition-colors ${!tour.is_public ? 'bg-emerald-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Lock size={12} /> Private
              </button>
            </div>
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
