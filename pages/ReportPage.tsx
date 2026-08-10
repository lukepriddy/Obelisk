import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapPin, ArrowLeft, Check, Loader2 } from 'lucide-react';
import { supabase } from '../services/supabaseClient';

/**
 * Public route for reporting an experience, reachable without an account and
 * without opening the experience itself.
 *
 * The report path that already existed lives in the player menu, which assumes
 * the person complaining is playing. The person most likely to have a serious
 * objection is not: a landowner who finds strangers in their driveway, or a
 * rights holder who finds their recording in a zone. Asking them to install and
 * play the thing they are objecting to before they can object is hostile, and
 * it is the shape of complaint that has actually cost this kind of product
 * money — the Pokémon GO settlement was landowners, not injuries.
 *
 * So: no sign-in, no app, one page, and only two required fields — what is
 * wrong, and how to reply. Everything else is whatever they happen to know.
 * A landowner has an address and no tour id; a rights holder has a link and no
 * idea where it is.
 */

const KINDS = [
  { value: 'property',  label: 'It sends people onto my property' },
  { value: 'safety',    label: 'It sends people somewhere dangerous' },
  { value: 'copyright', label: 'It uses my work without permission' },
  { value: 'privacy',   label: 'It exposes private information' },
  { value: 'other',     label: 'Something else' },
];

export const ReportPage: React.FC = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Prefilled when the link came from a player menu, empty when someone found
  // this page cold. Both are normal entry points.
  const [kind, setKind] = useState('property');
  const [tourUrl, setTourUrl] = useState(params.get('url') || '');
  const [locationText, setLocationText] = useState('');
  const [claim, setClaim] = useState('');
  const [relationship, setRelationship] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('submit-takedown', {
        body: {
          kind,
          tour_url: tourUrl,
          location_text: locationText,
          claim,
          relationship,
          contact_name: contactName,
          contact_email: contactEmail,
        },
      });
      // Non-2xx arrives as an error with the body on error.context.
      let payload: Record<string, unknown> | null = data ?? null;
      if (invokeError && (invokeError as { context?: Response }).context) {
        payload = await (invokeError as unknown as { context: Response }).context
          .json().catch(() => null);
      }
      if (payload?.ok === true) { setSent(true); return; }
      setError(typeof payload?.error === 'string'
        ? payload.error
        : 'Could not send that. Please try again.');
    } catch {
      setError('Could not send that. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const field = 'w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm ' +
    'text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-600';
  const label = 'block text-xs font-bold text-zinc-400 uppercase tracking-wide mb-1.5';

  if (sent) {
    return (
      <div className="min-h-full bg-zinc-950 px-4 py-10 overflow-y-auto">
        <div className="w-full max-w-2xl mx-auto">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-4">
              <Check size={22} className="text-emerald-400" />
            </div>
            <h1 className="text-xl font-bold text-white mb-2">Report received</h1>
            <p className="text-sm text-zinc-400 leading-relaxed max-w-md mx-auto">
              We have it, and we will reply to the address you gave within 15
              days. If an experience is putting people at risk we take it
              offline straight away and work out the details afterwards.
            </p>
            <button
              onClick={() => navigate('/')}
              className="mt-6 text-sm font-bold text-emerald-400 hover:text-emerald-300"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-950 px-4 py-10 overflow-y-auto">
      <div className="w-full max-w-2xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-300 mb-6"
        >
          <ArrowLeft size={16} /> Back
        </button>

        <div className="flex items-center gap-2 mb-2">
          <MapPin size={20} className="text-emerald-500" />
          <span className="font-bold text-white">Obelisk</span>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">Report an experience</h1>
        <p className="text-sm text-zinc-400 leading-relaxed mb-7 max-w-xl">
          Experiences are made by independent creators who choose their own
          locations. We do not visit them or verify them in advance. If one is
          sending people somewhere it should not, tell us here. You do not need
          an account, and you do not need to have used it.
        </p>

        <form onSubmit={submit} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-5">
          <div>
            <span className={label}>What is the problem?</span>
            <div className="flex flex-col gap-2">
              {KINDS.map(option => (
                <label key={option.value} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="kind"
                    value={option.value}
                    checked={kind === option.value}
                    onChange={() => setKind(option.value)}
                    className="accent-emerald-500 w-4 h-4"
                  />
                  <span className="text-sm text-zinc-200">{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Both optional and both offered, because which one a reporter has
              depends entirely on how they found the problem. A landowner has an
              address; someone sent a link has a URL. */}
          <div>
            <label className={label} htmlFor="location">Where is it? <span className="text-zinc-600 normal-case font-normal">(address, or a description of the place)</span></label>
            <input
              id="location" className={field} value={locationText}
              onChange={e => setLocationText(e.target.value)}
              placeholder="e.g. the orchard track off Western Ave, Marlboro NY"
            />
          </div>

          <div>
            <label className={label} htmlFor="url">Link to the experience <span className="text-zinc-600 normal-case font-normal">(if you have one)</span></label>
            <input
              id="url" className={field} value={tourUrl}
              onChange={e => setTourUrl(e.target.value)}
              placeholder="https://obelisk.place/player/…"
            />
          </div>

          <div>
            <label className={label} htmlFor="claim">What is happening? <span className="text-emerald-500 normal-case font-normal">Required</span></label>
            <textarea
              id="claim" className={`${field} min-h-28 resize-y`} value={claim}
              onChange={e => setClaim(e.target.value)}
              placeholder="What you have seen, and what you would like us to do about it."
              required
            />
          </div>

          <div>
            <label className={label} htmlFor="relationship">Your connection to it <span className="text-zinc-600 normal-case font-normal">(optional)</span></label>
            <input
              id="relationship" className={field} value={relationship}
              onChange={e => setRelationship(e.target.value)}
              placeholder="e.g. I own the land, I manage the site, I made the recording"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={label} htmlFor="name">Your name <span className="text-zinc-600 normal-case font-normal">(optional)</span></label>
              <input
                id="name" className={field} value={contactName}
                onChange={e => setContactName(e.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="email">Email <span className="text-emerald-500 normal-case font-normal">Required</span></label>
              <input
                id="email" type="email" className={field} value={contactEmail}
                onChange={e => setContactEmail(e.target.value)}
                placeholder="so we can reply"
                required
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-400 leading-relaxed">{error}</p>
          )}

          <button
            type="submit"
            disabled={sending}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold flex items-center justify-center gap-2"
          >
            {sending ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : 'Send report'}
          </button>

          <p className="text-[11px] text-zinc-500 leading-relaxed">
            We reply to every report within 15 days. Anything that looks like a
            real-world hazard comes offline straight away, without waiting to
            hear from the creator. Your email is used to reply to this report
            and nothing else.
          </p>
        </form>
      </div>
    </div>
  );
};
