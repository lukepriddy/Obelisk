-- Let a creator mark an experience as playable from a chair.
--
-- Simulation already exists: in preview the player's dot is draggable and
-- dragging it through a zone triggers it exactly as walking would. But
-- simulation is tied to preview, and preview requires being the signed-in
-- owner, so there has been no way to show anybody the real thing without
-- sending them to a physical place first.
--
-- Opt in per experience rather than on for anything public. The premise of the
-- product is that you have to actually go there, and quietly making every
-- published experience walkable from a browser would undo that for every
-- creator at once. Off unless the creator says otherwise.
alter table public.tours
  add column if not exists allow_simulation boolean not null default false;

comment on column public.tours.allow_simulation is
  'When true, ?demo=1 plays this experience with a draggable position instead of GPS. Off by default: simulating a walk defeats the point unless the creator intends it as a demo.';
