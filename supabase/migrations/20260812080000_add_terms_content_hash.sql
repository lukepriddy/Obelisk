-- Task #68: make an acceptance prove what the creator actually agreed to.
--
-- tos_acceptances recorded a version string and nothing else. A version string
-- is not evidence: it can be reused after an edit, and nothing in the row ties
-- it to any particular text. If a creator ever disputes what they agreed to,
-- the honest answer was "we know which label was current, not what it said".
-- Impossible to fix retroactively, which is why it was worth doing before
-- there are creators to dispute anything.
create table if not exists public.tos_terms_versions (
  version       text primary key,
  content_hash  text not null,
  registered_at timestamptz not null default now()
);
alter table public.tos_terms_versions enable row level security;
-- No policies: service role only. Nothing client-side needs it, and the
-- trigger below runs as the table owner.

alter table public.tos_acceptances
  add column if not exists content_hash text;

comment on column public.tos_acceptances.content_hash is
  'sha256 of termsPlainText() for the accepted version, copied from tos_terms_versions at insert. Set by trigger, never by the client, so the record proves the text rather than repeating a label the client supplied.';

-- Filled server-side. The client inserts (user_id, version) exactly as before;
-- anything it sends for content_hash is discarded.
--
-- Fails closed on an unregistered version. Deliberate: an acceptance with no
-- provable text is the defect being fixed, so recording one silently would
-- defeat the point. The cost is that bumping TERMS_VERSION without registering
-- the hash blocks publishing with the error below — loud and actionable, and
-- far easier to notice than a quiet gap in the legal record. Run
-- scripts/terms-hash.mjs when the terms change.
create or replace function public.stamp_tos_content_hash()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  h text;
begin
  select content_hash into h
  from public.tos_terms_versions
  where version = new.version;

  if h is null then
    raise exception
      'Terms version % has no registered text. Run scripts/terms-hash.mjs and insert the result into tos_terms_versions.',
      new.version
      using errcode = 'check_violation';
  end if;

  new.content_hash := h;
  return new;
end;
$function$;

drop trigger if exists stamp_tos_content_hash on public.tos_acceptances;
create trigger stamp_tos_content_hash
  before insert on public.tos_acceptances
  for each row execute function public.stamp_tos_content_hash();

insert into public.tos_terms_versions (version, content_hash)
values ('2026-07-28', '3678e351c661d2f171e0fc646c24d79d55e8d834dc592a00e27efe280f864f0c')
on conflict (version) do nothing;

-- Backfill the two existing acceptances. Honest rather than assumed:
-- constants/terms.ts last changed 2026-07-28 19:51 and both acceptances are
-- dated 2026-08-04 and 2026-08-07, so the text those creators saw is byte for
-- byte the text hashed above. Had the file moved in between, these rows would
-- have been left null rather than stamped with a hash nobody could stand
-- behind.
update public.tos_acceptances a
set content_hash = v.content_hash
from public.tos_terms_versions v
where a.version = v.version and a.content_hash is null;
