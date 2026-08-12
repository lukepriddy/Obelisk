-- Audit findings 1 (partial) and 3, from docs/platform-audit-2026-08-11.md.

-- ── Anonymous callers no longer need the zones table ────────────────────────
-- Before draft/live the player read zones directly, so anonymous SELECT on
-- every zone of a public tour was load-bearing. It is not any more: the player
-- reads them out of published_snapshot, api/render.ts stopped querying the
-- table, and api/sitemap.ts never touched it. What the grant still did was hand
-- anyone 14 zone passphrases and 18 character personas for the asking.
--
-- Checked before applying: all 12 public tours have a snapshot, so no anonymous
-- reader was relying on the fallback path in getPublishedTour().
drop policy if exists zones_select on public.zones;
create policy zones_select on public.zones
  for select using (
    exists (
      select 1 from public.tours t
      where t.id = zones.tour_id
        and t.owner_id = (select auth.uid())
    )
  );

-- ── Pin search_path ─────────────────────────────────────────────────────────
-- These all qualify their own calls, so there is no known exploit path today.
-- The point is that without a pinned search_path the safety of
-- enforce_moderation_gate — the boundary the whole publishing system rests on —
-- depends on every future edit remembering to qualify. Pinning makes it
-- structural rather than a habit.
alter function public.enforce_moderation_gate()            set search_path to 'public';
alter function public.is_privileged_caller()               set search_path to 'public';
alter function public.sync_is_listed()                     set search_path to 'public';
alter function public.enforce_tour_quota()                 set search_path to 'public';
alter function public.current_tos_version()                set search_path to 'public';
alter function public.current_moderation_policy_version()  set search_path to 'public';
alter function public.build_tour_snapshot(uuid)            set search_path to 'public';
alter function public.tour_snapshot_hash(jsonb, text)      set search_path to 'public';
alter function public.tour_content_hash(jsonb)             set search_path to 'public';
alter function public.default_moderation_daily_limit()     set search_path to 'public';
