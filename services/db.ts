/**
 * db.ts — Real Supabase data layer.
 * Drop-in replacement for mockSupabase; same helper signatures.
 */
import { supabase } from './supabaseClient';
import { logClientEvent } from './telemetry';
import { Tour, Zone, TourAnalytics } from '../types';

const DEFAULT_ZONE_PROPS = {
  type: 'audio' as const,
  volume: 1.0,
  is_visible: true,
  show_progress: false,
  use_attenuation: false,
  fade_in: 0.5,
  fade_out: 2.0,
  on_exit: 'stop' as const,
  on_end: 'stop' as const,
  lock_type: 'none' as const,
  voice_enabled: false,
};

// ── Auth helpers ──────────────────────────────────────────────────────────────

export const auth = {
  /** Sends a 6-digit OTP code to the given email address. */
  signInWithEmail: async (email: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithOtp({ email });
    return { error: error?.message ?? null };
  },

  /** Verifies the 6-digit OTP code the user typed in. */
  verifyOtp: async (email: string, token: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    return { error: error?.message ?? null };
  },

  signOut: async () => {
    await supabase.auth.signOut();
  },
};

// ── Tour helpers ──────────────────────────────────────────────────────────────

export const getToursByUser = async (userId: string): Promise<Tour[]> => {
  const { data, error } = await supabase
    .from('tours')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });

  if (error) { console.error('getToursByUser:', error); return []; }
  return (data ?? []) as Tour[];
};

/**
 * Retries a Supabase read that failed transiently (flaky cellular, brief
 * outage). PGRST116 ("no rows") is a real answer, not a failure — returned
 * immediately. Player-critical loads use this so one dropped request doesn't
 * become "Experience not found" or a silently zone-less tour.
 */
const withRetry = async <T>(
  run: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>,
): Promise<{ data: T | null; error: { code?: string; message?: string } | null }> => {
  let last: { data: T | null; error: { code?: string; message?: string } | null } = { data: null, error: null };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 600 : 1800));
    last = await run();
    if (!last.error || last.error.code === 'PGRST116') return last;
  }
  return last;
};

export const getTourById = async (tourId: string): Promise<Tour | null> => {
  const { data, error } = await withRetry<Tour>(() =>
    supabase.from('tours').select('*').eq('id', tourId).single()
  );

  if (error) {
    console.error('getTourById:', error);
    if (error.code !== 'PGRST116') {
      logClientEvent('tour_fetch_failed', error.message || 'unknown', { tourId });
    }
    return null;
  }
  return data as Tour;
};

export const createTour = async (partial: Partial<Tour>): Promise<Tour | null> => {
  const { data, error } = await supabase
    .from('tours')
    .insert(partial)
    .select()
    .single();

  if (error) { console.error('createTour:', error); return null; }
  return data as Tour;
};

export const updateTour = async (tourId: string, updates: Partial<Tour>): Promise<void> => {
  const { error } = await supabase
    .from('tours')
    .update(updates)
    .eq('id', tourId);

  if (error) { console.error('updateTour:', error); throw error; }
};

export const deleteTour = async (tourId: string): Promise<boolean> => {
  const { error } = await supabase.from('tours').delete().eq('id', tourId);
  if (error) { console.error('deleteTour:', error); return false; }
  return true;
};

// ── Zone helpers ──────────────────────────────────────────────────────────────

export const getZonesByTourId = async (tourId: string): Promise<Zone[]> => {
  const { data, error } = await withRetry<Zone[]>(() =>
    supabase.from('zones').select('*').eq('tour_id', tourId).order('created_at', { ascending: true })
  );

  if (error) {
    console.error('getZonesByTourId:', error);
    // An empty array here means the player walks a silent route with no
    // explanation — at least make the failure visible in telemetry.
    logClientEvent('zones_fetch_failed', error.message || 'unknown', { tourId });
    return [];
  }
  return (data ?? []) as Zone[];
};

export const createZone = async (partial: Partial<Zone>): Promise<Zone | null> => {
  const { data, error } = await supabase
    .from('zones')
    .insert({ ...DEFAULT_ZONE_PROPS, ...partial })
    .select()
    .single();

  if (error) { console.error('createZone:', error); return null; }
  return data as Zone;
};

export const updateZone = async (zoneId: string, updates: Partial<Zone>): Promise<void> => {
  const { error } = await supabase
    .from('zones')
    .update(updates)
    .eq('id', zoneId);

  if (error) { console.error('updateZone:', error); throw error; }
};

export const deleteZone = async (zoneId: string): Promise<void> => {
  const { error } = await supabase.from('zones').delete().eq('id', zoneId);
  if (error) console.error('deleteZone:', error);
};

/** Returns a map of tourId → zone count for a set of tour IDs in a single query. */
export const getZoneCountsByTourIds = async (tourIds: string[]): Promise<Record<string, number>> => {
  if (!tourIds.length) return {};
  const { data, error } = await supabase
    .from('zones')
    .select('tour_id')
    .in('tour_id', tourIds);

  if (error) { console.error('getZoneCountsByTourIds:', error); return {}; }

  const counts: Record<string, number> = {};
  tourIds.forEach(id => { counts[id] = 0; });
  (data ?? []).forEach((row: { tour_id: string }) => {
    counts[row.tour_id] = (counts[row.tour_id] ?? 0) + 1;
  });
  return counts;
};

/** Deep-clones a tour and all its zones, remapping cross-zone references. */
export const duplicateTour = async (tourId: string, ownerId: string): Promise<Tour | null> => {
  // 1. Fetch source tour
  const { data: src, error: te } = await supabase.from('tours').select('*').eq('id', tourId).single();
  if (te || !src) { console.error('duplicateTour — fetch tour:', te); return null; }

  // 2. Create new tour shell
  const { id: _id, created_at: _ca, ...tourFields } = src as any;
  const { data: newTour, error: ce } = await supabase
    .from('tours')
    .insert({ ...tourFields, title: `Copy of ${src.title}`, owner_id: ownerId })
    .select().single();
  if (ce || !newTour) { console.error('duplicateTour — create tour:', ce); return null; }

  // 3. Fetch source zones
  const { data: zones, error: ze } = await supabase.from('zones').select('*').eq('tour_id', tourId);
  if (ze || !zones?.length) return newTour as Tour;

  // 4. Insert cloned zones (without cross-refs first) and build old→new ID map
  const idMap = new Map<string, string>();
  const clonedZones: any[] = [];

  for (const zone of zones) {
    const { id: zid, tour_id: _tid, created_at: _zca, requires_zone_id: _r, avatar_unlock_zone_id: _a, ...zFields } = zone as any;
    const { data: nz, error: nze } = await supabase
      .from('zones')
      .insert({ ...zFields, tour_id: (newTour as any).id, requires_zone_id: null, avatar_unlock_zone_id: null })
      .select().single();
    if (nze || !nz) { console.error('duplicateTour — clone zone:', nze); continue; }
    idMap.set(zid, (nz as any).id);
    clonedZones.push({ old: zone, new: nz });
  }

  // 5. Second pass: restore cross-zone references using the ID map
  for (const { old: orig, new: nz } of clonedZones) {
    const updates: Record<string, string> = {};
    if (orig.requires_zone_id && idMap.has(orig.requires_zone_id))
      updates.requires_zone_id = idMap.get(orig.requires_zone_id)!;
    if (orig.avatar_unlock_zone_id && idMap.has(orig.avatar_unlock_zone_id))
      updates.avatar_unlock_zone_id = idMap.get(orig.avatar_unlock_zone_id)!;
    if (Object.keys(updates).length)
      await supabase.from('zones').update(updates).eq('id', (nz as any).id);
  }

  return newTour as Tour;
};

// ── Analytics helpers ─────────────────────────────────────────────────────────

/** Creates a player session when "Begin Experience" is tapped. Returns the new session ID.
 *  Goes through an RPC: a direct INSERT ... RETURNING can't work for anonymous
 *  players, because RETURNING requires the row to pass the owner-only SELECT
 *  policy on player_sessions. */
export const startSession = async (tourId: string): Promise<string | null> => {
  const { data, error } = await supabase.rpc('start_player_session', { p_tour_id: tourId });
  if (error) { console.error('startSession:', error); return null; }
  return (data as string | null);
};

/** Sets ended_at on the session. Best-effort — called on component unmount.
 *  Same RPC reasoning as startSession: a direct UPDATE ... eq('id') needs the
 *  row to pass the SELECT policy, which anonymous players never do. */
export const endSession = async (sessionId: string): Promise<void> => {
  const { error } = await supabase.rpc('end_player_session', { p_session_id: sessionId });
  if (error) console.error('endSession:', error);
};

/** Records a single zone visit (call once per zone per session). */
export const recordZoneVisit = async (
  sessionId: string,
  zoneId: string,
  tourId: string,
): Promise<void> => {
  const { error } = await supabase
    .from('zone_visits')
    .insert({ session_id: sessionId, zone_id: zoneId, tour_id: tourId });
  if (error) console.error('recordZoneVisit:', error);
};

/** Fetches aggregated analytics for a set of tour IDs in two queries. */
export const getAnalyticsByTourIds = async (tourIds: string[]): Promise<Record<string, TourAnalytics>> => {
  if (!tourIds.length) return {};

  const [{ data: sessions }, { data: visits }] = await Promise.all([
    supabase
      .from('player_sessions')
      .select('id, tour_id, started_at, ended_at')
      .in('tour_id', tourIds),
    supabase
      .from('zone_visits')
      .select('tour_id, zone_id')
      .in('tour_id', tourIds),
  ]);

  const result: Record<string, TourAnalytics> = {};

  for (const id of tourIds) {
    const ts = (sessions ?? []).filter((s: any) => s.tour_id === id);
    const vs = (visits  ?? []).filter((v: any) => v.tour_id === id);

    // Zone visit counts
    const zoneCounts: Record<string, number> = {};
    vs.forEach((v: any) => { zoneCounts[v.zone_id] = (zoneCounts[v.zone_id] ?? 0) + 1; });

    // Average duration (completed sessions only)
    const completed = ts.filter((s: any) => s.ended_at);
    const avgDuration = completed.length
      ? completed.reduce((sum: number, s: any) =>
          sum + (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000, 0)
        / completed.length
      : null;

    // Most recent session
    const sorted = [...ts].sort((a: any, b: any) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    result[id] = {
      tour_id: id,
      total_plays: ts.length,
      last_played: sorted[0]?.started_at ?? null,
      avg_duration_seconds: avgDuration,
      zone_visits: Object.entries(zoneCounts)
        .map(([zone_id, visit_count]) => ({ zone_id, visit_count }))
        .sort((a, b) => b.visit_count - a.visit_count),
    };
  }

  return result;
};

// ── API keys (BYOK — creators store their own provider keys) ────────────────

export const getApiKeys = async (userId: string): Promise<{ elevenlabs_key: string | null; gemini_key: string | null } | null> => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('elevenlabs_key, gemini_key')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) { console.error('getApiKeys:', error); return null; }
  return data;
};

// ── Publishing ───────────────────────────────────────────────────────────────
/**
 * Ask the review service to publish a tour.
 *
 * Publishing is not a plain `is_public = true` write: a database trigger
 * rejects that for ordinary creators. Only the `moderate-tour` edge function
 * (service role) can flip the flag, and only after an automatic content
 * review passes. Platform admins are exempt and publish immediately.
 */
export type PublishResult = {
  verdict: 'pass' | 'fail' | 'borderline';
  status: 'approved' | 'rejected' | 'pending_review';
  is_public: boolean;
  reason?: string | null;
  categories?: string[];
  /** Set when publishing was refused because the creator terms aren't accepted. */
  termsRequired?: boolean;
  requiredVersion?: string;
};

/** Which terms version is required, and whether this creator has accepted it. */
export const getTermsStatus = async (): Promise<{ version: string; accepted: boolean } | null> => {
  const { data, error } = await supabase.rpc('my_tos_status');
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return null;
  return { version: row.required_version, accepted: !!row.accepted };
};

/** Record acceptance of a terms version for the signed-in creator. */
export const acceptTerms = async (version: string): Promise<boolean> => {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return false;
  const { error } = await supabase
    .from('tos_acceptances')
    .insert({ user_id: userId, version });
  // A duplicate means they already accepted it — that's success, not failure.
  if (error && error.code !== '23505') {
    console.error('acceptTerms:', error);
    return false;
  }
  return true;
};

export const requestPublish = async (tourId: string): Promise<PublishResult> => {
  try {
    const { data, error } = await supabase.functions.invoke('moderate-tour', {
      body: { tourId },
    });

    // A non-2xx reply arrives as an error with the body on error.context, so
    // the terms case has to be read from either place.
    let payload: Record<string, unknown> | null = data ?? null;
    if (error && (error as { context?: Response }).context) {
      payload = await (error as unknown as { context: Response }).context
        .json().catch(() => null);
    }

    // 412 means the creator terms aren't accepted yet. That isn't a failed
    // review — it's a prerequisite the UI can resolve, then retry.
    if (payload?.error === 'terms_required') {
      return {
        verdict: 'borderline',
        status: 'pending_review',
        is_public: false,
        termsRequired: true,
        requiredVersion: typeof payload.requiredVersion === 'string'
          ? payload.requiredVersion : undefined,
      };
    }
    if (payload?.status) return payload as unknown as PublishResult;

    if (error || !data?.status) {
      console.error('requestPublish:', error ?? data);
      // Never report an unknown outcome as published.
      return {
        verdict: 'borderline',
        status: 'pending_review',
        is_public: false,
        reason: 'Review could not be completed. Check your connection and try again.',
      };
    }
    return data as PublishResult;
  } catch (err) {
    console.error('requestPublish:', err);
    return {
      verdict: 'borderline',
      status: 'pending_review',
      is_public: false,
      reason: 'Review could not be completed. Check your connection and try again.',
    };
  }
};

export const saveApiKeys = async (userId: string, keys: { elevenlabs_key?: string | null; gemini_key?: string | null }): Promise<boolean> => {
  const { error } = await supabase
    .from('api_keys')
    .upsert({ user_id: userId, ...keys, updated_at: new Date().toISOString() });
  if (error) { console.error('saveApiKeys:', error); return false; }
  return true;
};

export { supabase };
