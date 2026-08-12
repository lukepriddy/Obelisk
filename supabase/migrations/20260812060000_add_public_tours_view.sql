-- Audit finding 1, the remaining half: signed-in users could read each other's
-- drafts.
--
-- Column grants closed the anonymous case but cannot close this one. RLS
-- decides which ROWS you may read, grants decide which COLUMNS, and neither can
-- express "these columns, but only for rows you do not own". The editor
-- legitimately needs every column of its own tours, so `authenticated` cannot
-- simply be narrowed. A view can: fixed columns over fixed rows.
--
-- security_invoker is left off (the default), so the view runs with its owner's
-- rights and does not consult tours' RLS. That is what will let the table
-- policy become owner-only without the player losing access. It also means the
-- WHERE clause here IS the access rule.
--
-- Additive. Nothing reads it until the client deploy that accompanies it.
create or replace view public.public_tours as
select
  t.id,
  t.is_public,
  t.is_listed,
  t.published_snapshot
from public.tours t
where t.is_public = true
  and t.published_snapshot is not null;

comment on view public.public_tours is
  'What the public may read of a tour: the approved snapshot plus live visibility flags. The player, api/render.ts and api/sitemap.ts read this, never public.tours. Drafts, review verdicts and ownership are not here.';

grant select on public.public_tours to anon, authenticated;
