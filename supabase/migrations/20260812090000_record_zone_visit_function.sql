-- Zone visits stopped recording for real players when public.tours became
-- owner-only. The insert policy validated the zone by reading `zones`, and
-- `zones` validates ownership by reading `tours`, so an anonymous player's
-- insert failed with "permission denied for table tours". Sessions kept working
-- because they already went through a SECURITY DEFINER function; visits went
-- straight at the table.
--
-- The deeper problem was the coupling: an analytics WRITE depended on a content
-- READ permission, so tightening what players may read silently switched off
-- what they may record.
create or replace function public.record_zone_visit(
  p_session_id uuid,
  p_zone_id    uuid,
  p_tour_id    uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- The zone must genuinely belong to the tour, and the tour must be readable
  -- by this caller — the same test start_player_session applies, so a player
  -- cannot record visits against someone else's private experience.
  if not exists (
    select 1
    from public.zones z
    join public.tours t on t.id = z.tour_id
    where z.id = p_zone_id
      and z.tour_id = p_tour_id
      and (t.is_public = true or t.owner_id = (select auth.uid()))
  ) then
    return;
  end if;

  -- The session must belong to the same tour, when one was supplied. Analytics
  -- that can be pointed at an arbitrary tour are worse than no analytics.
  if p_session_id is not null and not exists (
    select 1 from public.player_sessions s
    where s.id = p_session_id and s.tour_id = p_tour_id
  ) then
    return;
  end if;

  insert into public.zone_visits (session_id, zone_id, tour_id)
  values (p_session_id, p_zone_id, p_tour_id);
end;
$function$;

revoke execute on function public.record_zone_visit(uuid, uuid, uuid) from public;
grant  execute on function public.record_zone_visit(uuid, uuid, uuid) to anon, authenticated, service_role;

-- The direct-insert policy is now dead: it cannot succeed for an anonymous
-- player, and nothing else writes this table. Removing it leaves one rule to
-- reason about rather than two that have to agree.
drop policy if exists visits_insert on public.zone_visits;
