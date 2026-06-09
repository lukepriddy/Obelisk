/**
 * db.ts — Real Supabase data layer.
 * Drop-in replacement for mockSupabase; same helper signatures.
 */
import { supabase } from './supabaseClient';
import { Tour, Zone } from '../types';

const DEFAULT_ZONE_PROPS = {
  type: 'audio' as const,
  volume: 1.0,
  is_visible: true,
  show_progress: false,
  use_attenuation: true,
  fade_in: 0.5,
  fade_out: 2.0,
  on_exit: 'stop' as const,
  on_end: 'loop' as const,
  lock_type: 'none' as const,
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

export const getTourById = async (tourId: string): Promise<Tour | null> => {
  const { data, error } = await supabase
    .from('tours')
    .select('*')
    .eq('id', tourId)
    .single();

  if (error) { console.error('getTourById:', error); return null; }
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
  const { data, error } = await supabase
    .from('zones')
    .select('*')
    .eq('tour_id', tourId)
    .order('created_at', { ascending: true });

  if (error) { console.error('getZonesByTourId:', error); return []; }
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

export { supabase };
