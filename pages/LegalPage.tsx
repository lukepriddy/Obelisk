import React from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, ArrowLeft } from 'lucide-react';
import type { TermsSection } from '../constants/terms';

interface LegalPageProps {
  title: string;
  intro?: string;
  sections: TermsSection[];
  version: string;
}

/**
 * Shared layout for the terms and privacy pages.
 *
 * Both are public routes with no auth requirement: a creator should be able to
 * read the terms before deciding to sign up, and a player needs the privacy
 * policy without ever having an account. Previously the terms only existed
 * inside the publish dialog, which meant they could be accepted but never
 * re-read — a weak position if it ever mattered.
 *
 * Styling follows the auth screen: zinc-950 page, zinc-900 card, emerald
 * headings, so these don't read as bolted on.
 */
export const LegalPage: React.FC<LegalPageProps> = ({ title, intro, sections, version }) => {
  const navigate = useNavigate();

  return (
    <div className="min-h-full bg-zinc-950 px-4 py-10 overflow-y-auto">
      <div className="w-full max-w-2xl mx-auto">

        <div className="flex items-center justify-center gap-2 mb-8">
          <MapPin className="text-emerald-400" size={24} />
          <span className="text-white font-bold text-2xl tracking-tight">Obelisk</span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
          <h1 className="text-xl font-bold text-white mb-1">{title}</h1>
          {intro && (
            <p className="text-zinc-400 text-sm leading-relaxed mb-6">{intro}</p>
          )}

          <div className="space-y-6">
            {sections.map(section => (
              <section key={section.heading}>
                <h2 className="text-xs font-bold uppercase tracking-wide text-emerald-400 mb-2">
                  {section.heading}
                </h2>
                {section.body.map((para, i) => (
                  <p key={i} className="text-[13px] text-zinc-300 leading-relaxed mb-2">
                    {para}
                  </p>
                ))}
              </section>
            ))}
          </div>

          <p className="text-[11px] text-zinc-600 mt-8 pt-4 border-t border-zinc-800">
            Version {version}
          </p>
        </div>

        <button
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
          className="w-full mt-5 text-zinc-500 hover:text-zinc-300 text-xs font-medium flex items-center justify-center gap-1.5"
        >
          <ArrowLeft size={13} /> Back
        </button>
      </div>
    </div>
  );
};
