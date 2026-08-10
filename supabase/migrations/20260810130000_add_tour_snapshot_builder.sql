-- Draft/live publishing, part 2: one definition of "the approved version".
--
-- Two places need to freeze a tour: the one-off backfill of the tours that are
-- already live, and the publish path every time a creator submits. Writing that
-- twice means two opinions about what a frozen copy contains, and those
-- opinions drift. Then "the version we reviewed" and "the version we serve"
-- stop being the same thing. So it lives here, once, and both callers use it.
--
-- Still inert against the deployed code: nothing calls this yet.

-- Columns that must never reach the public snapshot.
--
-- NOTE THE DIRECTION: this is a blocklist, so a column added to `tours` later
-- lands in the snapshot automatically. That is the right default - the player
-- already reads tours with select('*'), and the recurring bug in this codebase
-- is a new field being silently dropped, not an extra field appearing. But it
-- means anything private added to `tours` in future must be added here too.
--
--   owner_id            - identifies the creator, not part of the experience
--   is_public/is_listed - live visibility preferences, read from the live row
--   moderation_*        - the verdict about the snapshot, not its content
--   published_*         - the snapshot cannot contain itself
--   created_at          - bookkeeping
create or replace function public.build_tour_snapshot(p_tour_id uuid)
returns jsonb
language sql
stable
as $function$
  select case when t.id is null then null else jsonb_build_object(
    'version', 1,
    'tour', (to_jsonb(t) - 'owner_id' - 'is_public' - 'is_listed'
              - 'moderation_status' - 'moderation_reason' - 'moderation_categories'
              - 'moderated_at' - 'published_snapshot' - 'published_hash'
              - 'created_at'),
    'zones', coalesce((
      -- Ordered by created_at then id. The id tiebreak is not decoration: two
      -- zones created in the same millisecond would otherwise come back in
      -- whatever order the planner felt like, and the fingerprint below would
      -- change between two runs over identical content.
      select jsonb_agg(to_jsonb(z) order by z.created_at, z.id)
      from public.zones z
      where z.tour_id = t.id
    ), '[]'::jsonb)
  ) end
  from public.tours t
  where t.id = p_tour_id;
$function$;

comment on function public.build_tour_snapshot(uuid) is
  'Freeze a tour and its zones into the shape the public player reads. The only '
  'definition of what an approved version contains - used by both the backfill '
  'and the publish path. Returns null if the tour does not exist.';

-- The fingerprint, used to skip paying for a repeat review of identical
-- content.
--
-- Hashing the jsonb rather than a hand-built string is what makes this stable:
-- Postgres sorts keys and strips whitespace when a value becomes jsonb, so two
-- callers that assemble the same content in a different order still land on the
-- same fingerprint. That removes the whole category of accidental formatting
-- mismatches.
--
-- The policy version is mixed in so that changing the moderation rules
-- invalidates every existing approval rather than silently grandfathering
-- content that was judged under the old rules.
--
-- A matching fingerprint is NOT on its own permission to skip review. A tour
-- that was rejected or taken down must go through the gate again even if its
-- content is unchanged, so the caller checks that separately. The moment a
-- takedown happens, "the hash matches" and "this content is allowed" stop being
-- the same statement.
create or replace function public.tour_snapshot_hash(
  p_snapshot jsonb, p_policy_version text
)
returns text
language sql
immutable
as $function$
  select case when p_snapshot is null then null else
    encode(sha256(convert_to(p_policy_version || ':' || p_snapshot::text, 'utf8')), 'hex')
  end;
$function$;

comment on function public.tour_snapshot_hash(jsonb, text) is
  'Fingerprint of a snapshot under a given moderation policy version. Identical '
  'content under the same policy gives an identical fingerprint. Necessary but '
  'not sufficient to reuse an approval.';

-- Kept off the public API surface. Both real callers (the backfill and the
-- review service) are privileged, so nothing needs to reach these over
-- PostgREST, and an RPC that returns a whole tour is not worth exposing for no
-- reason.
revoke execute on function public.build_tour_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.tour_snapshot_hash(jsonb, text) from public, anon, authenticated;
