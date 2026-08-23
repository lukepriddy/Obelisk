-- The policy now judges closing-card text and support links, which it did not
-- before. Approvals are cached against (content_hash, policy_version), so
-- without this bump anything already approved would keep its pass under a
-- policy it was never actually assessed by, and the first review of a link
-- would only happen on the next unrelated edit.
create or replace function public.current_moderation_policy_version()
returns text language sql immutable set search_path to 'public' as $function$
  select '2026-08-23-support-links'::text;
$function$;
