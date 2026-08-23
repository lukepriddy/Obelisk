-- Check a passphrase without ever shipping it.
--
-- The player compared the answer in the browser, which meant every puzzle
-- answer had to be sent to every player inside the published snapshot. Anyone
-- with a share link could read the JSON and solve the whole experience without
-- walking a step.
--
-- Comparison matches what the client used to do: trimmed, case-insensitive.
create or replace function public.check_zone_passphrase(p_zone_id uuid, p_attempt text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.zones z join public.tours t on t.id = z.tour_id
    where z.id = p_zone_id
      and z.lock_type = 'passphrase'
      and coalesce(z.lock_passphrase, '') <> ''
      and lower(btrim(z.lock_passphrase)) = lower(btrim(coalesce(p_attempt, '')))
      -- Only answerable when the experience is live, or when the asker owns it
      -- and is testing. Otherwise this would confirm guesses against drafts.
      and (t.is_public is true or t.owner_id = (select auth.uid()))
  );
$$;
revoke execute on function public.check_zone_passphrase(uuid, text) from public;
grant execute on function public.check_zone_passphrase(uuid, text) to anon, authenticated;
