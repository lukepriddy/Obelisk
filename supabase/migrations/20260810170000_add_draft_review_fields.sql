-- Draft/live publishing, part 5b: separate "what we think of the draft" from
-- "what we approved for the public". Still inert.
--
-- moderation_status describes the LIVE version - the snapshot the public is
-- being served. Once a tour can be live while a new version is under review,
-- writing a failed verdict into that column would be a lie about the live
-- experience, and a costly one: api/sitemap.ts filters on
-- moderation_status = 'approved', so one false positive on an edit would
-- quietly delist a published tour that is still perfectly fine.
--
-- That is precisely the harm this whole design exists to avoid. A failed review
-- must leave the live version untouched in every respect, including its status.
-- So the draft gets its own fields.
alter table public.tours
  add column if not exists draft_review_status     text,
  add column if not exists draft_review_reason     text,
  add column if not exists draft_review_categories text[],
  add column if not exists draft_reviewed_at       timestamptz;

comment on column public.tours.draft_review_status is
  'Outcome of the most recent review of the DRAFT: rejected, pending_review, or '
  'null once a draft has been approved and promoted. Never describes the live '
  'version - that is moderation_status.';

-- Same lock as the moderation columns: a creator must not be able to clear
-- their own rejection.
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
