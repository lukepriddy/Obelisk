-- A closing card: the bookend to the welcome screen.
--
-- The player had no end. An experience simply stopped once the last zone was
-- done, which left a written ending (a farewell, a haiku) with nothing after
-- it, and left nowhere to put a donation that is not a toll booth in front of
-- the content.
--
-- The finale is marked explicitly rather than inferred. Zones have no order
-- column and come back sorted by created_at, so "the last zone" is whichever
-- was made most recently: add one in the middle later and it would silently
-- become the ending.
alter table public.tours
  add column if not exists ending_zone_id  uuid references public.zones(id) on delete set null,
  add column if not exists closing_message text,
  add column if not exists donation_note   text,
  -- [{ label, url, qr_url }]. A list rather than fixed paypal/venmo columns so
  -- a creator can show both, or neither, or add another later without a
  -- migration. Mirrors how progression_resources is stored.
  add column if not exists donation_links  jsonb not null default '[]'::jsonb;

comment on column public.tours.ending_zone_id is
  'Completing this zone triggers the closing card. Null means the experience has no explicit end.';
comment on column public.tours.donation_links is
  'Array of { label, url, qr_url }. Hosts are validated client-side against an allowlist; qr_url is an uploaded image, not a generated code.';

-- build_tour_snapshot subtracts a blocklist from to_jsonb(tours), so these four
-- reach published snapshots without touching it. Recorded here because the
-- opposite assumption would be a silent, invisible bug: the creator sees the
-- closing card in preview and players never do.
