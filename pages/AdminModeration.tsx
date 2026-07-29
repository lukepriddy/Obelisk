import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShieldAlert, Check, X, EyeOff, Home, RefreshCw } from 'lucide-react';
import { supabase } from '../services/db';

/**
 * The human end of the moderation gate.
 *
 * Most tours never reach here: the automatic review in `moderate-tour`
 * resolves pass or fail on its own. This queue holds the leftovers — genuinely
 * ambiguous verdicts and review outages — plus anything a player reported.
 *
 * Access is decided by the `admin-moderation` edge function against the
 * `platform_admins` table, not by anything in this file. A non-admin who
 * navigates here simply gets an empty result and a "not available" message;
 * hiding the route in the client would be decoration, not security.
 */

interface QueueTour {
  id: string;
  title: string;
  description: string;
  owner_id: string;
  moderation_status: string;
  moderation_reason: string | null;
  moderation_categories: string[] | null;
  moderated_at: string | null;
  is_public: boolean;
}

interface Report {
  id: number;
  tour_id: string;
  reason: string;
  created_at: string;
  tours?: { title: string; owner_id: string; is_public: boolean } | null;
}

interface AccessRequest {
  email: string;
  request_note: string | null;
  requested_at: string | null;
}

export const AdminModeration: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [queue, setQueue] = useState<QueueTour[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = async (body: Record<string, unknown>) => {
    const { data, error: fnError } = await supabase.functions.invoke('admin-moderation', { body });
    if (fnError) {
      // 404 is what a non-admin gets — the endpoint doesn't confirm it exists.
      const status = (fnError as { context?: Response }).context?.status;
      if (status === 404 || status === 401) { setDenied(true); return null; }
      throw fnError;
    }
    return data;
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await call({ action: 'list' });
      if (data) {
        setQueue(data.queue ?? []);
        setReports(data.reports ?? []);
        setAccessRequests(data.accessRequests ?? []);
      }
    } catch {
      setError('Could not load the queue. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await call(body);
      // Approving can succeed while the invite email fails; that distinction
      // matters, so don't swallow it behind a generic refresh.
      if (result?.message) setNotice(result.message);
      else if (result?.invited) setNotice('Invited — they\'ve been emailed a sign-up link.');
      await load();
    } catch {
      setError('That action failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-zinc-950 text-emerald-500">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-400 px-6 text-center">
        <p className="text-sm">This page isn't available.</p>
        <button onClick={() => navigate('/')} className="text-emerald-400 text-sm font-semibold">
          Back to dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-200">
      <div className="max-w-3xl mx-auto px-5 py-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <ShieldAlert size={20} className="text-amber-400" />
            <h1 className="font-bold text-lg">Moderation</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>
            <button
              onClick={() => navigate('/')}
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
              title="Dashboard"
            >
              <Home size={16} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-950/70 border border-red-900 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {notice && (
          <div className="mb-4 rounded-lg bg-emerald-950/60 border border-emerald-900 px-3 py-2 text-sm text-emerald-200">
            {notice}
          </div>
        )}

        {/* ── Access requests ──
            First, because while Obelisk is invite-only this is the section
            with anything in it. Approving here is what actually lets someone
            create an account. */}
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-3">
            Access requests ({accessRequests.length})
          </h2>
          {accessRequests.length === 0 ? (
            <p className="text-sm text-zinc-500">Nobody's asked for access yet.</p>
          ) : (
            <div className="space-y-3">
              {accessRequests.map(r => (
                <article key={r.email} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-bold text-sm truncate">{r.email}</h3>
                    {r.requested_at && (
                      <span className="text-[11px] text-zinc-500 shrink-0">
                        {new Date(r.requested_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {r.request_note ? (
                    <p className="text-xs text-zinc-300 mt-2 leading-relaxed whitespace-pre-wrap">
                      “{r.request_note}”
                    </p>
                  ) : (
                    <p className="text-xs text-zinc-600 mt-2 italic">No answer given.</p>
                  )}
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => act(`ia-${r.email}`, { action: 'decide_access', email: r.email, decision: 'approve' })}
                      disabled={!!busy}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                    >
                      {busy === `ia-${r.email}` ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Invite
                    </button>
                    <button
                      onClick={() => act(`id-${r.email}`, { action: 'decide_access', email: r.email, decision: 'decline' })}
                      disabled={!!busy}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50"
                    >
                      {busy === `id-${r.email}` ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                      Decline
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ── Awaiting review ── */}
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-3">
            Awaiting review ({queue.length})
          </h2>
          {queue.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing queued. Automatic review is handling everything.
            </p>
          ) : (
            <div className="space-y-3">
              {queue.map(t => (
                <article key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <h3 className="font-bold text-sm">{t.title || 'Untitled'}</h3>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed line-clamp-3">
                    {t.description}
                  </p>
                  {t.moderation_reason && (
                    <p className="text-xs text-amber-300 mt-2 leading-relaxed">
                      {t.moderation_reason}
                    </p>
                  )}
                  {t.moderation_categories?.length ? (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {t.moderation_categories.map(c => (
                        <span key={c} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-950 text-amber-300">
                          {c}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => act(`a-${t.id}`, { action: 'decide', tourId: t.id, decision: 'approve' })}
                      disabled={!!busy}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                    >
                      {busy === `a-${t.id}` ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Approve and publish
                    </button>
                    <button
                      onClick={() => act(`r-${t.id}`, { action: 'decide', tourId: t.id, decision: 'reject' })}
                      disabled={!!busy}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50"
                    >
                      {busy === `r-${t.id}` ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                      Reject
                    </button>
                  </div>
                  <a
                    href={`/player/${t.id}?preview=1`}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-center text-[11px] text-zinc-500 hover:text-zinc-300 mt-2"
                  >
                    Open in player to review
                  </a>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ── Player reports ── */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-3">
            Reports ({reports.length})
          </h2>
          {reports.length === 0 ? (
            <p className="text-sm text-zinc-500">No open reports.</p>
          ) : (
            <div className="space-y-3">
              {reports.map(r => (
                <article key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-bold text-sm truncate">
                        {r.tours?.title || 'Deleted experience'}
                      </h3>
                      <p className="text-[11px] text-zinc-500 mt-0.5">
                        {new Date(r.created_at).toLocaleString()}
                        {r.tours?.is_public === false && ' · already offline'}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-300 mt-2 leading-relaxed">{r.reason}</p>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => act(`u-${r.id}`, { action: 'force_unpublish', tourId: r.tour_id })}
                      disabled={!!busy || !r.tours}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold bg-red-700 hover:bg-red-600 text-white disabled:opacity-50"
                    >
                      {busy === `u-${r.id}` ? <Loader2 size={13} className="animate-spin" /> : <EyeOff size={13} />}
                      Take offline
                    </button>
                    <button
                      onClick={() => act(`d-${r.id}`, { action: 'resolve_report', reportId: r.id })}
                      disabled={!!busy}
                      className="flex-1 py-2 rounded-lg text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
