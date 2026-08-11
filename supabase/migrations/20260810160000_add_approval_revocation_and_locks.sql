-- Draft/live publishing, part 5a: the two things the publish path needs before
-- it can be written. Still inert.

-- ── Revoking an approval ────────────────────────────────────────────────────
-- A matching fingerprint is NOT permission to skip review.
--
-- The bypass this closes: publish something that violates the rules, get taken
-- down, set the tour Private, set it Public again. The content is unchanged, so
-- its fingerprint still matches a past "pass", and a cache keyed on the
-- fingerprint alone would wave it straight back through. The moment a takedown
-- happens, "the hash matches" and "this content is allowed" stop being the same
-- statement, so the cache has to ask both questions.
--
-- A creator toggling their own tour Private and back with unchanged content is
-- a different case and should still reuse the approval. That is why this is
-- driven by rejection and admin takedown, not by is_public going false.
alter table public.moderation_runs
  add column if not exists revoked_at timestamptz;

comment on column public.moderation_runs.revoked_at is
  'Set when this approval must no longer satisfy the fingerprint cache: the '
  'tour was rejected, or an admin took it down. Identical content must then be '
  'reviewed again rather than reusing this verdict.';

create index if not exists moderation_runs_cache_idx
  on public.moderation_runs (content_hash, policy_version)
  where verdict = 'pass' and revoked_at is null;

/** Invalidate every past approval for a tour. Call on a fail verdict and on
 *  admin takedown. */
create or replace function public.revoke_tour_approvals(p_tour_id uuid)
returns integer
language sql
security definer
set search_path to 'public'
as $function$
  with updated as (
    update public.moderation_runs
    set revoked_at = now()
    where tour_id = p_tour_id and revoked_at is null
    returning 1
  )
  select count(*)::integer from updated;
$function$;

/** Is this exact content, under this exact policy, already approved and not
 *  since revoked? The only question the cache is allowed to ask. */
create or replace function public.approval_is_reusable(p_hash text, p_policy_version text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.moderation_runs
    where content_hash = p_hash
      and policy_version = p_policy_version
      and verdict = 'pass'
      and revoked_at is null
  );
$function$;

-- ── One review at a time, and a cooldown ────────────────────────────────────
-- The cooldown is per tour and covers ATTEMPTS, including the ones the cache
-- answers for free, so hammering the button cannot turn into a hot loop.
--
-- Note on "newest pending revision wins" from the design notes: that matters
-- for a queue where reviews run in the background. This review is synchronous -
-- the creator's browser waits for the verdict - so a second attempt arriving
-- mid-review is simply told the tour is busy. If review ever moves to a queue,
-- revisit this.
create table if not exists public.moderation_locks (
  tour_id         uuid primary key references public.tours(id) on delete cascade,
  locked_at       timestamptz,
  last_attempt_at timestamptz not null default now()
);
alter table public.moderation_locks enable row level security;

/**
 * Try to start a review. Returns 'ok', 'cooldown', or 'busy'.
 *
 * Atomic: one INSERT ... ON CONFLICT DO UPDATE whose WHERE clause carries both
 * conditions, so two simultaneous attempts cannot both win the lock. The loser
 * gets no row back and is told why by a cheap follow-up read.
 */
create or replace function public.begin_moderation_attempt(
  p_tour_id uuid,
  p_cooldown_seconds integer default 60,
  p_lock_ttl_seconds integer default 120
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  got uuid;
  is_busy boolean;
begin
  insert into public.moderation_locks (tour_id, locked_at, last_attempt_at)
  values (p_tour_id, now(), now())
  on conflict (tour_id) do update
    set locked_at = now(), last_attempt_at = now()
    where (public.moderation_locks.locked_at is null
           or public.moderation_locks.locked_at < now() - make_interval(secs => p_lock_ttl_seconds))
      and public.moderation_locks.last_attempt_at < now() - make_interval(secs => p_cooldown_seconds)
  returning tour_id into got;

  if got is not null then
    return 'ok';
  end if;

  -- Informational only: the refusal already happened above.
  select (locked_at is not null
          and locked_at >= now() - make_interval(secs => p_lock_ttl_seconds))
    into is_busy
  from public.moderation_locks where tour_id = p_tour_id;

  return case when coalesce(is_busy, false) then 'busy' else 'cooldown' end;
end;
$function$;

/** Finish a review, freeing the tour for the next attempt. The cooldown still
 *  applies; this only clears the in-progress flag. */
create or replace function public.end_moderation_attempt(p_tour_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update public.moderation_locks set locked_at = null where tour_id = p_tour_id;
$function$;

revoke execute on function public.revoke_tour_approvals(uuid) from public, anon, authenticated;
revoke execute on function public.approval_is_reusable(text, text) from public, anon, authenticated;
revoke execute on function public.begin_moderation_attempt(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.end_moderation_attempt(uuid) from public, anon, authenticated;
