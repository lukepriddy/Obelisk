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
  /** Sends a magic-link email. Returns error string or null. */
  signInWithEmail: async (email: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });
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

  if (error) console.error('updateTour:', error);
};

export const deleteTour = async (tourId: string): Promise<void> => {
  const { error } = await supabase.from('tours').delete().eq('id', tourId);
  if (error) console.error('deleteTour:', error);
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

  if (error) console.error('updateZone:', error);
};

export const deleteZone = async (zoneId: string): Promise<void> => {
  const { error } = await supabase.from('zones').delete().eq('id', zoneId);
  if (error) console.error('deleteZone:', error);
};

export { supabase };
