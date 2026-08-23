/**
 * The closing card: what a player sees once the experience is over.
 *
 * The bookend to the welcome screen, and the only place the app asks for money.
 * That placement is the whole point. By the time this appears somebody has
 * walked the entire route, so a donation reads as a thank-you; anywhere earlier
 * it reads as a toll gate in front of content they have not had yet.
 */
import React, { useRef, useState } from 'react';
import { Flag, Heart, ImageIcon, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { DonationLink, Tour, Zone } from '../types';
import { uploadImage, ICON_MAX_EDGE } from '../services/storageService';
import { donationUrlError } from '../utils/donationLinks';

interface Props {
  tour: Tour;
  zones?: Zone[];
  onUpdate: (updates: Partial<Tour>) => void;
}

export const ClosingCardSettings: React.FC<Props> = ({ tour, zones, onUpdate }) => {
  const links = tour.donation_links || [];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadIndex, setUploadIndex] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const setLinks = (next: DonationLink[]) => onUpdate({ donation_links: next });
  const updateLink = (i: number, patch: Partial<DonationLink>) =>
    setLinks(links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const handleQrUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const index = uploadIndex;
    e.target.value = '';
    if (!file || index === null) return;
    setUploading(true);
    setUploadError(null);
    const url = await uploadImage(file, `${tour.id}/donation`, {
      maxEdge: ICON_MAX_EDGE * 2,
      onError: setUploadError,
    });
    setUploading(false);
    setUploadIndex(null);
    if (url) updateLink(index, { qr_url: url });
  };

  return (
    <div className="border-t border-zinc-800 pt-5">
      <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
        <Flag size={13} /> Closing Card
      </label>

      {/* Marked, not inferred. Zones come back ordered by when they were made,
          so "the last zone" is whichever was created most recently, which stops
          being the ending the first time one is added in the middle. */}
      <p className="text-[10px] text-zinc-500 mb-2">
        Which zone ends the experience. Finishing it brings up the closing card.
      </p>
      <select
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
        value={tour.ending_zone_id || ''}
        onChange={(e) => onUpdate({ ending_zone_id: e.target.value || null })}
      >
        <option value="">No closing card</option>
        {(zones || []).map(z => <option key={z.id} value={z.id}>{z.title}</option>)}
      </select>

      {tour.ending_zone_id && (
        <>
          <div className="mt-4">
            <label className="block text-[11px] font-semibold text-zinc-400 mb-1.5">Closing message</label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none resize-none leading-relaxed"
              rows={3}
              value={tour.closing_message || ''}
              onChange={(e) => onUpdate({ closing_message: e.target.value.slice(0, 1000) })}
              placeholder="Thanks for walking it."
            />
          </div>

          <div className="mt-5 pt-4 border-t border-zinc-800">
            <label className="block text-[11px] font-semibold text-zinc-400 mb-1.5 flex items-center gap-1.5">
              <Heart size={11} /> Support links <span className="text-zinc-600 font-normal">optional</span>
            </label>
            <p className="text-[10px] text-zinc-500 mb-2 leading-relaxed">
              Each link becomes a button on the card. Add one below.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleQrUpload}
            />

            <div className="flex flex-col gap-3">
              {links.map((link, i) => {
                const urlError = link.url.trim() ? donationUrlError(link.url) : null;
                return (
                  <div key={i} className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-3">
                    <div className="flex gap-2 mb-2">
                      <input
                        className="w-28 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-emerald-500"
                        value={link.label}
                        onChange={(e) => updateLink(i, { label: e.target.value.slice(0, 24) })}
                        placeholder="PayPal"
                      />
                      <input
                        className={`flex-1 min-w-0 bg-zinc-800 border rounded px-2 py-1.5 text-xs text-white outline-none font-mono ${
                          urlError ? 'border-red-500/60' : 'border-zinc-700 focus:border-emerald-500'
                        }`}
                        value={link.url}
                        onChange={(e) => updateLink(i, { url: e.target.value.trim() })}
                        placeholder="https://paypal.me/you"
                      />
                      <button
                        onClick={() => setLinks(links.filter((_, idx) => idx !== i))}
                        className="text-zinc-500 hover:text-red-400 transition-colors shrink-0 px-1"
                        aria-label="Remove link"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                    {urlError && <p className="text-[10px] text-red-400 mb-2">{urlError}</p>}

                    <div className="flex items-center gap-2">
                      {link.qr_url ? (
                        <>
                          <img src={link.qr_url} alt="" className="w-9 h-9 rounded bg-white p-0.5 object-contain" />
                          <span className="text-[10px] text-zinc-500 flex-1">QR added</span>
                          <button
                            onClick={() => updateLink(i, { qr_url: null })}
                            className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors"
                          >
                            Remove
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => { setUploadIndex(i); fileInputRef.current?.click(); }}
                          disabled={uploading}
                          className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                        >
                          {uploading && uploadIndex === i
                            ? <Loader2 size={11} className="animate-spin" />
                            : <Upload size={11} />}
                          Add the QR from your {link.label || 'payment'} app
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {uploadError && <p className="text-[10px] text-red-400 mt-2">{uploadError}</p>}

            <button
              onClick={() => setLinks([...links, { label: '', url: '', qr_url: null }])}
              className="flex items-center gap-1.5 mt-3 text-xs text-zinc-400 hover:text-emerald-400 transition-colors"
            >
              <Plus size={13} /> Add a support link
            </button>

            {links.length > 0 && (
              <div className="mt-4">
                <label className="block text-[11px] font-semibold text-zinc-400 mb-1.5">
                  Line above the buttons <span className="text-zinc-600 font-normal">not a link</span>
                </label>
                <input
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
                  value={tour.donation_note || ''}
                  onChange={(e) => onUpdate({ donation_note: e.target.value.slice(0, 200) })}
                  placeholder="If this was worth a coffee…"
                />
              </div>
            )}

            <p className="text-[10px] text-zinc-600 mt-3 leading-relaxed">
              <ImageIcon size={9} className="inline mb-px" /> Any https link: PayPal, Venmo, Ko-fi, your own site.
              The QR is the image your payment app gives you, not a generated one, so players see the code they recognise.
            </p>
          </div>
        </>
      )}
    </div>
  );
};
