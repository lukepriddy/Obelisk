import React, { useRef, useState } from 'react';
import { Gem, ImageIcon, KeyRound, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { ProgressionResource, Tour } from '../types';
import { uploadImage } from '../services/storageService';

interface ProgressionSettingsProps {
  tour: Tour;
  onUpdate: (updates: Partial<Tour>) => void;
}

export const ProgressionSettings: React.FC<ProgressionSettingsProps> = ({ tour, onUpdate }) => {
  const resources = tour.progression_resources || [];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadResourceId, setUploadResourceId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const updateResources = (next: ProgressionResource[]) => {
    onUpdate({ progression_resources: next });
  };

  const updateResource = (id: string, updates: Partial<ProgressionResource>) => {
    updateResources(resources.map(resource =>
      resource.id === id ? { ...resource, ...updates } : resource
    ));
  };

  const addResource = () => {
    const resource: ProgressionResource = {
      id: crypto.randomUUID(),
      name: resources.length === 0 ? 'Points' : `Resource ${resources.length + 1}`,
      type: 'currency',
      color: tour.accent_color || '#10b981',
      image_url: null,
      starting_amount: 0,
      show_in_hud: true,
    };
    onUpdate({
      progression_enabled: true,
      progression_resources: [...resources, resource],
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const resourceId = uploadResourceId;
    e.target.value = '';
    if (!file || !resourceId) return;

    setUploadError(null);
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('Icon is too large (max 5 MB).');
      return;
    }
    if (file.type === 'image/heic' || file.type === 'image/heif') {
      setUploadError('HEIC images are not supported. Use PNG, WebP, or JPEG.');
      return;
    }

    setUploading(true);
    const url = await uploadImage(file, `${tour.id}/progression`);
    setUploading(false);
    if (!url) {
      setUploadError('Icon upload failed. Try again.');
      return;
    }
    updateResource(resourceId, { image_url: url });
  };

  return (
    <div className="border-t border-zinc-800 pt-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            <Gem size={14} className="text-emerald-400" /> Player Progression
          </h4>
          <p className="text-[10px] text-zinc-500 mt-1">Optional points, collectibles, and keys.</p>
        </div>
        <button
          type="button"
          onClick={() => onUpdate({ progression_enabled: !tour.progression_enabled })}
          className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
            tour.progression_enabled ? 'bg-emerald-500' : 'bg-zinc-700'
          }`}
          aria-label={tour.progression_enabled ? 'Disable progression' : 'Enable progression'}
        >
          <span className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white transition-transform ${
            tour.progression_enabled ? 'translate-x-4' : 'translate-x-0'
          }`} />
        </button>
      </div>

      {tour.progression_enabled && (
        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleImageUpload}
          />

          {resources.map(resource => (
            <div key={resource.id} className="border border-zinc-700 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setUploadResourceId(resource.id);
                    fileInputRef.current?.click();
                  }}
                  className="w-20 h-20 rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0 text-zinc-500 hover:text-emerald-400"
                  title="Upload icon"
                >
                  {uploading && uploadResourceId === resource.id
                    ? <Loader2 size={16} className="animate-spin" />
                    : resource.image_url
                      ? <img src={resource.image_url} alt="" className="w-full h-full object-contain p-1" />
                      : <ImageIcon size={17} />
                  }
                </button>
                <div className="flex-1 min-w-0 space-y-2">
                  <input
                    type="text"
                    value={resource.name}
                    onChange={e => updateResource(resource.id, { name: e.target.value })}
                    className="w-full h-10 bg-zinc-800 border border-zinc-700 rounded px-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                    placeholder="Resource name"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => updateResource(resource.id, { type: 'currency' })}
                      className={`h-8 flex-1 rounded text-[10px] font-bold flex items-center justify-center gap-1 ${
                        resource.type === 'currency' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-500'
                      }`}
                    >
                      <Gem size={11} /> Crncy
                    </button>
                    <button
                      type="button"
                      onClick={() => updateResource(resource.id, { type: 'item' })}
                      className={`h-8 flex-1 rounded text-[10px] font-bold flex items-center justify-center gap-1 ${
                        resource.type === 'item' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-500'
                      }`}
                    >
                      <KeyRound size={11} /> Item
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => updateResources(resources.filter(item => item.id !== resource.id))}
                  className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-red-400 shrink-0"
                  aria-label={`Delete ${resource.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase mb-1">Starting amount</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={resource.starting_amount}
                    onChange={e => updateResource(resource.id, { starting_amount: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-full h-10 bg-zinc-800 border border-zinc-700 rounded px-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase mb-1">Color</label>
                  <input
                    type="color"
                    value={resource.color || '#10b981'}
                    onChange={e => updateResource(resource.id, { color: e.target.value })}
                    className="w-full h-10 bg-zinc-800 border border-zinc-700 rounded cursor-pointer"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={resource.show_in_hud}
                  onChange={e => updateResource(resource.id, { show_in_hud: e.target.checked })}
                  className="accent-emerald-500"
                />
                Show in player counter
              </label>
            </div>
          ))}

          {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}

          <button
            type="button"
            onClick={addResource}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-zinc-700 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/50 text-xs font-semibold"
          >
            <Plus size={14} /> Add currency or item
          </button>

          {resources.length === 0 && (
            <p className="text-[10px] text-zinc-600 text-center">
              Add a resource before assigning rewards to zones.
            </p>
          )}

          {resources.length > 0 && (
            <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-400">
              Next, open a zone and use its Progression section to award these resources or require them to unlock the zone.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
