-- Audit finding 1: stop serving drafts to anonymous callers.
--
-- APPLY THIS ONLY AFTER THE CLIENT CHANGE IS DEPLOYED. The player used to read
-- tours with select('*'); narrowing the grant first makes that request fail and
-- takes every public experience down. The deployed build must already be the
-- one that names its columns.
--
-- Column-level grants are the mechanism because RLS cannot express this: it
-- decides which ROWS you may read, not which parts of them. tours_select
-- deliberately lets anyone read a public tour, and that row carries the draft
-- the player is specifically not being shown, plus draft_review_reason, which
-- is the reviewer's explanation of why something was rejected.
--
-- What anonymous callers keep, and why each one:
--   id                  - the player and the sitemap both need it
--   is_public           - live visibility, read from the row not the snapshot
--   is_listed           - same, and api/render.ts uses it for the noindex tag
--   published_snapshot  - the approved content; the whole point
--   moderation_status   - api/sitemap.ts FILTERS on it, and filtering on a
--                         column requires SELECT on that column
--
-- Everything else — title, description, every styling field, the draft review
-- columns, the hashes, owner_id, coordinates — becomes invisible to anonymous
-- callers. The approved copies of those live inside published_snapshot, which
-- is exactly the distinction this feature exists to draw.
revoke select on public.tours from anon;
grant select (
  id,
  is_public,
  is_listed,
  published_snapshot,
  moderation_status
) on public.tours to anon;

-- NOT addressed here, deliberately, and worth knowing: a SIGNED-IN creator can
-- still read another creator's draft. tours_select allows any authenticated
-- user to read any public tour, and narrowing columns for `authenticated`
-- would break the editor, which legitimately needs every column of the tours
-- its user owns. Postgres cannot vary column visibility by row.
--
-- Closing that properly means a public-facing view carrying only the columns
-- above, with the player reading the view and tours_select reduced to owners
-- only. That is a larger change and a separate task. It matters less today
-- because signups are allowlisted, so every authenticated account is one Luke
-- invited — but it should not be left standing once signups open.
