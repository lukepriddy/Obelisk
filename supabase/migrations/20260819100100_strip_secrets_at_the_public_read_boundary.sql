-- Keep puzzle answers and character personas out of what players are served.
--
-- An earlier attempt stripped them in build_tour_snapshot and was reverted: the
-- stored snapshot is the authoritative copy of APPROVED content, and three
-- things depend on it carrying everything.
--   1. moderate-tour reviews the personas in the candidate snapshot.
--   2. The content hash is taken over the snapshot, so a persona edit must
--      change the hash and trigger a fresh review. Stripped, an edited persona
--      would look already-approved and skip moderation entirely.
--   3. gemini-chat reads the persona out of the snapshot to be the character.
--
-- What must not carry them is the thing handed to anyone with a link. Before
-- this, every published experience shipped its own answers: three in Shmerg,
-- two in Central Park Walk, readable in the page data without walking a step.
--
-- lock_hint stays. It is meant to be read.
create or replace view public.public_tours
with (security_invoker = false) as
  select
    t.id, t.is_public, t.is_listed,
    jsonb_set(t.published_snapshot, '{zones}', coalesce((
      select jsonb_agg(z - 'lock_passphrase' - 'character_prompt' order by ord)
      from jsonb_array_elements(t.published_snapshot->'zones') with ordinality as e(z, ord)
    ), '[]'::jsonb)) as published_snapshot
  from public.tours t
  where t.is_public = true and t.published_snapshot is not null;

grant select on public.public_tours to anon, authenticated;
