-- Draft/live publishing, part 3: give the tours that are already live a frozen
-- copy, so the readers added later have something to read.
--
-- Bump this string whenever the moderation prompt or the pass/fail rules
-- change. It is mixed into every fingerprint, so bumping it invalidates every
-- cached approval and the next publish of any tour pays for a fresh review
-- under the new rules. Same shape as current_tos_version, for the same reason:
-- a version that lives in code next to the thing it versions.
create or replace function public.current_moderation_policy_version()
returns text
language sql
immutable
as $function$
  select '2026-08-10'::text;
$function$;

-- The backfill freezes each live tour AS IT IS RIGHT NOW, which is the only
-- honest option available. These tours were reviewed when they were published
-- and some have been edited since - that unchecked-edit hole is the whole
-- reason for this work. Freezing the current draft at least makes the frozen
-- copy identical to what the public is being served today, so nobody's
-- experience changes at the moment the readers switch over.
--
-- Runs as a privileged caller, so enforce_moderation_gate takes its early
-- return and permits the write.
update public.tours t
set published_snapshot = public.build_tour_snapshot(t.id),
    published_hash     = public.tour_snapshot_hash(
                           public.build_tour_snapshot(t.id),
                           public.current_moderation_policy_version())
where t.is_public
  and t.moderation_status = 'approved'
  and t.published_snapshot is null;
