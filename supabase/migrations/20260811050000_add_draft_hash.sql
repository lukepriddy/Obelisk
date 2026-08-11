-- "Changes not published": tell a creator, outside the editor, that what
-- players are walking is not what they last saved.
--
-- Two hashes on the row, both maintained by the database, so the badge is an
-- exact statement about content rather than a guess from timestamps. A
-- timestamp comparison would light up after any save, including a save that
-- changed nothing, and a badge that cries wolf is worse than no badge.
--
-- Content-only, deliberately. tour_snapshot_hash() mixes in the moderation
-- policy version because it answers "may this reuse an old approval". This
-- answers a different question - "is the draft the same as what is live" - and
-- must not change when the policy version is bumped, or every tour on the
-- dashboard would claim to have unpublished changes overnight.
create or replace function public.tour_content_hash(p_snapshot jsonb)
returns text
language sql
immutable
as $function$
  select case when p_snapshot is null then null else
    encode(sha256(convert_to(p_snapshot::text, 'utf8')), 'hex')
  end;
$function$;

alter table public.tours
  add column if not exists draft_hash             text,
  add column if not exists published_content_hash text;

comment on column public.tours.draft_hash is
  'Content hash of the CURRENT draft, maintained by trigger on tours and zones. '
  'Differs from published_content_hash exactly when there are unpublished changes.';

-- Recompute both hashes for one tour. SECURITY DEFINER so the nested write is a
-- privileged caller and takes enforce_moderation_gate''s early return - these
-- columns are locked against clients below.
--
-- The guard in the WHERE clause is what stops this recursing: the nested update
-- fires this trigger again, but by then the value matches, no row is updated,
-- and no further trigger runs.
create or replace function public.refresh_tour_hashes(p_tour_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  new_draft text;
begin
  new_draft := public.tour_content_hash(public.build_tour_snapshot(p_tour_id));

  update public.tours t
  set draft_hash = new_draft,
      published_content_hash = public.tour_content_hash(t.published_snapshot)
  where t.id = p_tour_id
    and (t.draft_hash is distinct from new_draft
      or t.published_content_hash is distinct from public.tour_content_hash(t.published_snapshot));
end;
$function$;

create or replace function public.tours_refresh_hashes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.refresh_tour_hashes(new.id);
  return null;
end;
$function$;

create or replace function public.zones_refresh_tour_hashes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.refresh_tour_hashes(coalesce(new.tour_id, old.tour_id));
  return null;
end;
$function$;

drop trigger if exists refresh_hashes on public.tours;
create trigger refresh_hashes
  after insert or update on public.tours
  for each row execute function public.tours_refresh_hashes();

drop trigger if exists refresh_tour_hashes on public.zones;
create trigger refresh_tour_hashes
  after insert or update or delete on public.zones
  for each row execute function public.zones_refresh_tour_hashes();

-- Same lock as every other field the creator must not be able to write. A
-- forged draft_hash would make the badge lie in the one direction that matters:
-- claiming a draft is live when it is not.
create or replace function public.enforce_moderation_gate()
returns trigger
language plpgsql
as $function$
begin
  if public.is_privileged_caller() then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    new.moderation_status   := 'unmoderated';
    new.moderation_reason   := null;
    new.moderation_categories := null;
    new.moderated_at        := null;
    new.is_public           := false;
    new.published_snapshot  := null;
    new.published_hash      := null;
    new.published_content_hash := null;
    new.draft_review_status     := null;
    new.draft_review_reason     := null;
    new.draft_review_categories := null;
    new.draft_reviewed_at       := null;
    return new;
  end if;

  if new.moderation_status     is distinct from old.moderation_status
  or new.moderation_reason     is distinct from old.moderation_reason
  or new.moderation_categories is distinct from old.moderation_categories
  or new.moderated_at          is distinct from old.moderated_at then
    raise exception 'Moderation fields can only be set by the review service.'
      using errcode = 'check_violation';
  end if;

  if new.published_snapshot is distinct from old.published_snapshot
  or new.published_hash     is distinct from old.published_hash then
    raise exception 'The published version can only be set by the review service.'
      using errcode = 'check_violation';
  end if;

  if new.draft_hash             is distinct from old.draft_hash
  or new.published_content_hash is distinct from old.published_content_hash then
    raise exception 'Publication state is maintained by the database.'
      using errcode = 'check_violation';
  end if;

  if new.draft_review_status     is distinct from old.draft_review_status
  or new.draft_review_reason     is distinct from old.draft_review_reason
  or new.draft_review_categories is distinct from old.draft_review_categories
  or new.draft_reviewed_at       is distinct from old.draft_reviewed_at then
    raise exception 'Review results can only be set by the review service.'
      using errcode = 'check_violation';
  end if;

  if new.is_public and not old.is_public then
    if public.is_platform_admin(new.owner_id) then
      if new.moderation_status is distinct from 'approved' then
        new.moderation_status := 'approved';
        new.moderation_reason := 'owner is platform admin';
        new.moderated_at      := now();
      end if;
    elsif new.moderation_status <> 'approved' then
      raise exception 'This experience must pass review before it can be published.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$function$;

revoke execute on function public.tour_content_hash(jsonb) from public, anon, authenticated;
revoke execute on function public.refresh_tour_hashes(uuid) from public, anon, authenticated;

-- Backfill every existing tour.
do $$
declare r record;
begin
  for r in select id from public.tours loop
    perform public.refresh_tour_hashes(r.id);
  end loop;
end $$;
