import React, { useState } from 'react';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { TERMS_SECTIONS } from '../constants/terms';

interface TermsDialogProps {
  /** Version being accepted — comes from the server, not the bundle. */
  version: string;
  onAccept: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Shown the first time a creator publishes (and again after the terms change
 * materially). Publishing is the moment they take on responsibility for
 * sending real people to a real place, so that's where the agreement belongs
 * rather than buried in a frictionless passwordless signup.
 *
 * The checkbox is a deliberate second action: the risk that actually matters
 * here is physical, and it deserves more than an implicit "by continuing".
 */
export const TermsDialog: React.FC<TermsDialogProps> = ({ version, onAccept, onCancel }) => {
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const accept = async () => {
    if (!checked || saving) return;
    setSaving(true);
    await onAccept();
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[6000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="px-5 pt-5 pb-3 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <ShieldAlert size={20} className="text-amber-400 shrink-0" />
            <h2 className="font-bold text-zinc-100">Before you publish</h2>
          </div>
          <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
            Publishing sends real people to real places. Please read these terms —
            especially the first section — before your experience goes live.
          </p>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4 grow">
          {TERMS_SECTIONS.map(section => (
            <section key={section.heading}>
              <h3 className="text-xs font-bold uppercase tracking-wide text-emerald-400 mb-1.5">
                {section.heading}
              </h3>
              {section.body.map((para, i) => (
                <p key={i} className="text-[13px] text-zinc-300 leading-relaxed mb-1.5">
                  {para}
                </p>
              ))}
            </section>
          ))}
          <p className="text-[11px] text-zinc-500 pt-1">
            Version {version} ·{' '}
            <a href="/terms" target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
              Open in a new tab
            </a>
            {' · '}
            <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
              Privacy
            </a>
          </p>
        </div>

        <div className="px-5 py-4 border-t border-zinc-800 shrink-0 space-y-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
              className="mt-0.5 accent-emerald-500 w-4 h-4 shrink-0"
            />
            <span className="text-[13px] text-zinc-200 leading-snug">
              I accept these terms, and I confirm every location in this experience
              is somewhere the public may lawfully and safely go.
            </span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              disabled={saving}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50"
            >
              Not yet
            </button>
            <button
              onClick={accept}
              disabled={!checked || saving}
              className="flex-1 py-2.5 rounded-lg text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 flex items-center justify-center gap-2"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              Accept and publish
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
