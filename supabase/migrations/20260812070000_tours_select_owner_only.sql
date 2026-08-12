-- Audit finding 1, closed. The tours table is readable only by its owner.
--
-- Everything public goes through public_tours, which carries the approved
-- snapshot and the two visibility flags and nothing else. Drafts, review
-- verdicts, hashes, coordinates and ownership stop being readable by anyone
-- but the creator who wrote them, signed in or not.
--
-- Safe only because the deployed client already reads the view: the player,
-- api/render.ts and api/sitemap.ts were switched in the release before this.
-- Applied in the other order, every public experience would have gone dark.
drop policy if exists tours_select on public.tours;
create policy tours_select on public.tours
  for select using ((select auth.uid()) = owner_id);

-- The column grant from the previous step is now redundant: with the policy
-- owner-only, anon matches no rows at all. Dropped so there is one rule to
-- reason about rather than two that have to agree.
revoke select on public.tours from anon;
