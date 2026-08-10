-- Draft/live publishing, part 1 of N: the columns, and the lock on them.
--
-- Deliberately inert against the code that is deployed right now. Nothing in
-- the app or in any edge function reads or writes these columns yet, so this
-- can be applied ahead of a Vercel deploy without changing any behaviour. That
-- ordering is the lesson from the CHECK constraint that broke every "set to
-- Private" in production because it was applied before the code that satisfied
-- it shipped: apply schema the deployed code can already satisfy.
--
-- What is NOT here, on purpose: any requirement that a public tour HAS a
-- snapshot. The deployed moderate-tour does not write one, so a constraint to
-- that effect would break publishing the instant it was applied. It belongs
-- with the edge function change, after the backfill.

alter table public.tours
  add column if not exists published_snapshot jsonb,
  add column if not exists published_hash     text;

comment on column public.tours.published_snapshot is
  'The approved, immutable version served to the public. Everything the player '
  'needs including zones. Written only by the review service, never by a client. '
  'Null means nothing has been approved yet.';

comment on column public.tours.published_hash is
  'Content hash of published_snapshot, including the moderation policy version. '
  'Lets identical content skip a paid model call. A matching hash is necessary '
  'but NOT sufficient to reuse an approval - see the takedown invalidation rule.';

-- The gate. Without this the architecture is decorative: tours_update RLS is
-- `auth.uid() = owner_id` with no column restriction, so a creator could PATCH
-- published_snapshot straight from devtools and publish whatever they liked.
--
-- Same shape as the existing moderation-column rule rather than a new
-- mechanism, and it holds for the same reason: is_privileged_caller() tests
-- current_user, PostgREST runs creator requests as `authenticated`, and only
-- the service role can take the early return.
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
    -- A new tour has never been approved, whatever the insert claimed.
    new.published_snapshot  := null;
    new.published_hash      := null;
    return new;
  end if;

  if new.moderation_status     is distinct from old.moderation_status
  or new.moderation_reason     is distinct from old.moderation_reason
  or new.moderation_categories is distinct from old.moderation_categories
  or new.moderated_at          is distinct from old.moderated_at then
    raise exception 'Moderation fields can only be set by the review service.'
      using errcode = 'check_violation';
  end if;

  -- Separate message from the one above: this is the error a creator would hit
  -- while trying to forge an approved version, and it should not read like the
  -- generic moderation error when it turns up in a log.
  if new.published_snapshot is distinct from old.published_snapshot
  or new.published_hash     is distinct from old.published_hash then
    raise exception 'The published version can only be set by the review service.'
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
