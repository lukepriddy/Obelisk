-- Audit findings 2, 4 and 5 from docs/platform-audit-2026-08-11.md.

-- ── Internal helpers were callable over the API ─────────────────────────────
-- Functions are created with EXECUTE granted to PUBLIC and every role inherits
-- that, so revoking from `anon` alone changes nothing. The grant has to come
-- off PUBLIC and go back only to the roles that need it.
--
-- Who actually needs what, worked out from the callers:
--   is_platform_admin  - the moderation_runs_admin_select POLICY and the
--                        enforce_moderation_gate trigger both call it as the
--                        signed-in creator, so `authenticated` must keep it or
--                        admins lose the moderation log and publishing breaks.
--   tour_cap_for       - enforce_tour_quota, same situation.
--   storage_used_by    - only reached from inside my_storage_quota(), which is
--   storage_limit_for    SECURITY DEFINER and runs them as its owner. No
--                        caller needs EXECUTE at all.
revoke execute on function public.is_platform_admin(uuid) from public, anon, authenticated;
grant  execute on function public.is_platform_admin(uuid) to authenticated, service_role;

revoke execute on function public.tour_cap_for(uuid) from public, anon, authenticated;
grant  execute on function public.tour_cap_for(uuid) to authenticated, service_role;

revoke execute on function public.storage_used_by(uuid)   from public, anon, authenticated;
grant  execute on function public.storage_used_by(uuid)   to service_role;
revoke execute on function public.storage_limit_for(uuid) from public, anon, authenticated;
grant  execute on function public.storage_limit_for(uuid) to service_role;

-- Trigger functions kept their default grant. PostgREST cannot usefully invoke
-- a function returning `trigger`, so this is hygiene. Triggers are unaffected:
-- Postgres checks EXECUTE when a trigger is created, not when it fires.
revoke execute on function public.tours_refresh_hashes()      from public, anon, authenticated;
revoke execute on function public.zones_refresh_tour_hashes() from public, anon, authenticated;

-- ── Reconcile the uploads ledger with storage ───────────────────────────────
-- getStorageQuota() sums `uploads`, but elevenlabs-tts wrote generated audio
-- straight to storage without recording it, so 27 files were costing storage
-- while counting as free. The function now records its own uploads; this
-- reconciles what it already wrote. Matched on exact path, so re-running is a
-- no-op, and only files whose prefix maps to a live tour are counted.
insert into public.uploads (user_id, tour_id, bucket, path, size_bytes, mime_type, created_at)
select t.owner_id, t.id, o.bucket_id, o.name,
       coalesce((o.metadata->>'size')::bigint, 0),
       coalesce(o.metadata->>'mimetype', 'application/octet-stream'),
       o.created_at
from storage.objects o
join public.tours t on t.id::text = o.path_tokens[1]
where o.bucket_id in ('audio', 'images', 'models')
  and not exists (
    select 1 from public.uploads u
    where u.bucket = o.bucket_id and u.path = o.name
  );
