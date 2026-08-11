/**
 * MediaPicker — choose a file this tour already has, instead of uploading it
 * again.
 *
 * Scoped to one tour on purpose. A library spanning every tour looks like a
 * small step further and is not: deleting a tour currently removes everything
 * under its storage prefix, which is correct only while nothing else can
 * reference those files, and published snapshots point at image URLs. Sharing
 * files across tours needs an ownership model and a cleanup rule that
 * understands snapshots. Within a single tour, none of that changes — the file
 * is already in that tour's folder either way.
 */

import React, { useEffect, useState } from 'react';
import { X, Loader2, Music, Check } from 'lucide-react';
import { listTourAudio, listTourImages, TourMediaFile } from '../services/storageService';

interface MediaPickerProps {
  tourId: string;
  kind: 'audio' | 'image';
  /** Highlighted as already chosen. */
  currentUrl?: string | null;
  onPick: (url: string) => void;
  onClose: () => void;
}

const prettySize = (bytes: number | null) => {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const prettyDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const MediaPicker: React.FC<MediaPickerProps> = ({
  tourId, kind, currentUrl, onPick, onClose,
}) => {
  const [files, setFiles] = useState<TourMediaFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (kind === 'audio' ? listTourAudio(tourId) : listTourImages(tourId))
      .then(result => { if (!cancelled) setFiles(result); });
    return () => { cancelled = true; };
  }, [tourId, kind]);

  // Escape closes, matching every other overlay in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
          <h3 className="text-sm font-bold text-white">
            {kind === 'audio' ? 'Audio in this experience' : 'Images in this experience'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-white rounded transition-colors"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto p-3">
          {files === null && (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}

          {files?.length === 0 && (
            <p className="text-xs text-zinc-500 text-center py-10 px-6 leading-relaxed">
              Nothing uploaded to this experience yet. Once you add
              {kind === 'audio' ? ' audio' : ' an image'}, it will show up here to
              reuse in other zones.
            </p>
          )}

          {kind === 'image' && files && files.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {files.map(file => (
                <button
                  key={file.path}
                  onClick={() => { onPick(file.url); onClose(); }}
                  className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-colors ${
                    file.url === currentUrl
                      ? 'border-emerald-500'
                      : 'border-transparent hover:border-zinc-600'
                  }`}
                  title={file.name}
                >
                  <img src={file.url} alt={file.name} className="w-full h-full object-cover" loading="lazy" />
                  {file.url === currentUrl && (
                    <span className="absolute top-1 right-1 bg-emerald-500 text-zinc-950 rounded-full p-0.5">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {kind === 'audio' && files && files.length > 0 && (
            <ul className="space-y-1.5">
              {files.map(file => (
                <li key={file.path}>
                  <div className={`flex items-center gap-2 rounded-lg border p-2 transition-colors ${
                    file.url === currentUrl
                      ? 'border-emerald-500/60 bg-emerald-500/10'
                      : 'border-zinc-800 hover:border-zinc-700'
                  }`}>
                    <Music size={14} className="text-zinc-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-zinc-200 truncate" title={file.name}>{file.name}</p>
                      <p className="text-[10px] text-zinc-500">
                        {[prettySize(file.sizeBytes), prettyDate(file.updatedAt)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    {/* Auditioning matters more for audio than for images: the
                        filenames are timestamps, so the only way to tell two
                        clips apart is to hear them. */}
                    <audio src={file.url} controls preload="none" className="h-7 max-w-[140px]" />
                    <button
                      onClick={() => { onPick(file.url); onClose(); }}
                      className="shrink-0 text-[11px] font-bold px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                    >
                      Use
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
