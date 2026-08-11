-- Draft/live publishing, part 4: a spend ceiling and a record of every paid
-- review. Still inert - nothing calls any of this until the publish path does.

-- ── The log ─────────────────────────────────────────────────────────────────
-- One row per real Gemini call. Written by the review service only.
--
-- tour_id deliberately survives the tour being deleted (set null, not cascade):
-- the reason a review exists is to be evidence later, and evidence that
-- disappears when the subject deletes the tour is not evidence. creator_id is
-- kept for the same reason.
create table if not exists public.moderation_runs (
  id                 uuid primary key default gen_random_uuid(),
  tour_id            uuid references public.tours(id) on delete set null,
  creator_id         uuid,
  content_hash       text,
  policy_version     text,
  model              text,
  verdict            text,
  reason             text,
  categories         text[],
  prompt_tokens      integer,
  output_tokens      integer,
  total_tokens       integer,
  estimated_cost_usd numeric(10,6),
  promoted           boolean not null default false,
  created_at         timestamptz not null default now()
);

create index if not exists moderation_runs_created_idx on public.moderation_runs (created_at desc);
create index if not exists moderation_runs_creator_idx on public.moderation_runs (creator_id, created_at desc);
create index if not exists moderation_runs_tour_idx    on public.moderation_runs (tour_id, created_at desc);

alter table public.moderation_runs enable row level security;

-- Creators cannot see the log at all - it holds verdicts and costs across the
-- whole platform. Platform admins can read it, which is what the eventual
-- admin dashboard will use. Nobody but the service role can write it.
drop policy if exists moderation_runs_admin_select on public.moderation_runs;
create policy moderation_runs_admin_select on public.moderation_runs
  for select using (public.is_platform_admin((select auth.uid())));

-- ── The daily ceiling ───────────────────────────────────────────────────────
-- The cooldown limits how OFTEN someone can publish; it does nothing about how
-- much they can spend, since one call a minute is still 1,440 paid calls a day.
-- And a creator who changes one word each time defeats the fingerprint cache.
-- So there is a hard ceiling on actual executions per account per day.
--
-- Hidden from creators by design: a visible limit tells someone exactly how
-- much free model time they are entitled to.
create or replace function public.default_moderation_daily_limit()
returns integer
language sql
immutable
as $function$
  select 15;
$function$;

-- Per-account override, for raising the ceiling for a creator who has a real
-- reason to need it. Service role only; no RLS policies means no client access.
create table if not exists public.moderation_daily_limits (
  user_id     uuid primary key,
  daily_limit integer not null check (daily_limit >= 0),
  note        text,
  updated_at  timestamptz not null default now()
);
alter table public.moderation_daily_limits enable row level security;

-- Days are UTC, not the creator's local midnight. Simpler to reason about, and
-- the ceiling is a spend guard rather than a promise about a calendar day.
create table if not exists public.moderation_quota_usage (
  user_id uuid not null,
  day     date not null default (now() at time zone 'utc')::date,
  used    integer not null default 0,
  primary key (user_id, day)
);
alter table public.moderation_quota_usage enable row level security;

/**
 * Take one slot from today's ceiling. Returns true if the caller may proceed.
 *
 * Atomic by construction: the whole thing is one INSERT ... ON CONFLICT DO
 * UPDATE, so Postgres takes a row lock and two simultaneous publishes cannot
 * both read "14 used" and both proceed. The WHERE on the update is what
 * enforces the ceiling - when it fails, no row is returned AND no row is
 * written, so a refused attempt costs nothing.
 *
 * Call this immediately before the model call, never before the cheap checks.
 * A publish that the fingerprint cache answers, or that the cooldown refuses,
 * must not consume a slot - the ceiling counts money actually spent.
 */
create or replace function public.consume_moderation_quota(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cap  integer;
  took integer;
begin
  select coalesce(
    (select daily_limit from public.moderation_daily_limits where user_id = p_user),
    public.default_moderation_daily_limit()
  ) into cap;

  if cap <= 0 then
    return false;
  end if;

  insert into public.moderation_quota_usage (user_id, day, used)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update
    set used = public.moderation_quota_usage.used + 1
    where public.moderation_quota_usage.used < cap
  returning used into took;

  return took is not null;
end;
$function$;

/**
 * Give a slot back.
 *
 * Only for the case where the model call never happened - a network failure or
 * a timeout before Gemini produced a billable response. NOT for a fail or
 * borderline verdict: those cost real money and must count.
 */
create or replace function public.release_moderation_quota(p_user uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update public.moderation_quota_usage
  set used = greatest(used - 1, 0)
  where user_id = p_user and day = (now() at time zone 'utc')::date;
$function$;

revoke execute on function public.consume_moderation_quota(uuid) from public, anon, authenticated;
revoke execute on function public.release_moderation_quota(uuid) from public, anon, authenticated;
revoke execute on function public.default_moderation_daily_limit() from public, anon, authenticated;
