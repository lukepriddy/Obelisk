-- Three items from the platform pass.

-- ── 1. Admins can read the error log ────────────────────────────────────────
-- client_events had an insert policy and no select policy, so nobody could read
-- 200+ collected entries — including the run of crypto.randomUUID failures on
-- older Safari that nothing ever surfaced.
--
-- A policy filters rows you already have privilege to read; it cannot grant the
-- privilege. The policy alone did nothing until the table grant followed.
-- Deliberately does NOT reference tours: today's analytics regression came from
-- exactly that shape, a policy depending on another table's read permission.
drop policy if exists events_select_admin on public.client_events;
create policy events_select_admin on public.client_events
  for select using (public.is_platform_admin((select auth.uid())));

grant select on public.client_events to authenticated;

-- ── 2. Retention ────────────────────────────────────────────────────────────
-- A function that must be CALLED, not a schedule. Deletion has no undo and the
-- right cutoff is a judgement.
--
-- ORDER MATTERS and the wrong order corrupts rather than errors:
-- zone_visits.session_id is ON DELETE SET NULL, so removing sessions first
-- leaves orphaned visits and analytics that quietly disagree with itself.
create or replace function public.purge_old_telemetry(
  p_days integer default 400,
  p_dry_run boolean default true
)
returns table(what text, rows_affected bigint)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(p_days, 30));
  n_visits bigint; n_sessions bigint; n_events bigint;
begin
  select count(*) into n_visits   from public.zone_visits     where visited_at < cutoff;
  select count(*) into n_sessions from public.player_sessions where started_at < cutoff;
  select count(*) into n_events   from public.client_events   where created_at < cutoff;

  if not p_dry_run then
    delete from public.zone_visits     where visited_at < cutoff;
    delete from public.player_sessions where started_at < cutoff;
    delete from public.client_events   where created_at < cutoff;
  end if;

  return query
    select 'cutoff'::text, extract(epoch from (now() - cutoff))::bigint / 86400
    union all select 'zone_visits', n_visits
    union all select 'player_sessions', n_sessions
    union all select 'client_events', n_events;
end;
$function$;

revoke execute on function public.purge_old_telemetry(integer, boolean) from public, anon, authenticated;
grant  execute on function public.purge_old_telemetry(integer, boolean) to service_role;

-- ── 3. Empty-string media urls ──────────────────────────────────────────────
-- Some zones stored '' rather than NULL for "no audio". Every consumer treats
-- both as absent, so this is hygiene with no behavioural change — except that
-- media_url lives inside published_snapshot, so normalising it would light up
-- "Changes not published" on a dozen live tours, each needing a republish and a
-- paid review to clear a change nobody made.
--
-- The snapshot is therefore re-promoted alongside, but ONLY for tours already
-- in sync. A tour with genuine unpublished edits keeps them unpublished;
-- silently promoting a creator's pending draft would be far worse than the bug
-- being fixed. The in-sync set is captured BEFORE the zones change, because the
-- update itself moves draft_hash.
do $$
declare in_sync uuid[];
begin
  select coalesce(array_agg(t.id), '{}')
    into in_sync
    from public.tours t
   where t.published_snapshot is not null
     and t.draft_hash is not distinct from t.published_content_hash;

  update public.zones set media_url = null where media_url = '';

  update public.tours t
     set published_snapshot = public.build_tour_snapshot(t.id),
         published_hash     = public.tour_snapshot_hash(
                                public.build_tour_snapshot(t.id),
                                public.current_moderation_policy_version())
   where t.id = any(in_sync);
end $$;
