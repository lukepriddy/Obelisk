# Handoff: publishing

Written at the end of a long session so the next one starts from the design
rather than from a chat log.

Draft/live publishing was the open task when this document was first written.
It shipped on 2026-08-11 and the section below now describes what exists rather
than what to build. The open work is in "Also pending" and in
`docs/platform-audit-2026-08-11.md`.

---

## The product, in three lines

Obelisk is a location-based narrative platform. Creators place audio, AI
characters and AR objects at real coordinates; players walk there and the phone
plays the right thing in the right place. Vite + React 19 + TypeScript SPA,
Supabase (Postgres/RLS/auth/storage/edge functions), MapLibre, Gemini +
ElevenLabs BYOK, deployed on Vercel.

- Repo: `/Users/lukepriddy/Obelisk/Obelisk-main`
- Supabase project ref: `pzlgiurtjrmkpbjlaabz`
- Live: `obelisk.place` (and `obelisk-main.vercel.app`, permanently noindexed)

---

## How to work in this repo

**Deploys are manual and are Luke's to run.** There is no Git auto-deploy.
Pushing to GitHub changes nothing user-facing. Claude is blocked from running
the deploy by the permission classifier.

```
cd /Users/lukepriddy/Obelisk/Obelisk-main && vercel --prod --yes
```

Before trusting any field test, check what is actually live rather than
assuming a commit shipped:

```
curl -s "https://obelisk.place/version.json?t=$(date +%s)"
```

**Supabase migrations and edge functions go live the instant they are applied.**
They do not wait for a Vercel deploy. This bit hard in the last session: a CHECK
constraint was applied before the code that satisfied it was deployed, which
broke every "set to Private" in production — including the admin emergency
takedown lever — until a trigger was added. Apply schema changes that the
deployed code can already satisfy, or make the database maintain the invariant
itself.

**Deploy edge functions with the CLI, not by pasting file contents into an MCP
tool.** It is far cheaper and it is already authenticated:

```
supabase functions deploy <name> --project-ref pzlgiurtjrmkpbjlaabz
```

**Edge function CORS lives in `supabase/functions/_shared/cors.ts`.** It used to
be copy-pasted into each function, and when `obelisk.place` was bought only the
function written after that point got the new origin. Everything else — publish,
delete, admin moderation, AI chat, voice, generation — failed its preflight on
the real domain while still working on `*.vercel.app`, which is where it was
tested. Import `corsFor` rather than adding an eighth copy of the list.

**`api/` is not typechecked by the Vite build.** `npm run build` will happily
pass with broken TypeScript in `api/render.ts`. Always run `npx tsc --noEmit`.
Two pre-existing errors are expected noise: one in `ChatInterface.tsx`, and
`Deno`/`jsr:` errors under `supabase/functions`.

**Working preferences.** American spelling. Feet and miles in creator- and
player-facing UI; metres internal only. No em dashes in user-facing copy. Plain
language over jargon when explaining — Luke pushed back on this explicitly and
was right to. Do not modify his tour or zone content without asking. Never
search iCloud or broad home-directory paths.

**Verify rather than assert.** Nearly every real bug in the last session was
found by measuring — a browser measurement, a numeric simulation, a probe
insert, a rolled-back transaction. Several confident-sounding claims turned out
to be wrong, including some in the project's own docs.

---

## Current state

**Everything is committed and deployed. Nothing is pushed.** As of
2026-08-11 the local `main` is 12 commits ahead of `origin/main`, which still
sits at `d1a4d39`. GitHub does not have any of the draft/live work. Vercel has
it because `vercel --prod` uploads local files and stamps local commit metadata,
which makes the dashboard look like a Git deploy when it is not.

- `obelisk.place` is live with a valid certificate, pointed at this Vercel
  project via a Cloudflare CNAME (proxy off).
- **`PUBLIC_SITE_ORIGIN` is deliberately NOT set.** While unset, `robots.txt`
  refuses every host and the sitemap is empty, so nothing anywhere is
  indexable. That is the intended state until there is real content worth
  finding. Setting it is the switch that turns indexing on.
- 12 live tours, all **Unlisted** — reachable by link, absent from listings.
  Two are Private. None are Public.
- No real creators yet: 3 accounts, 2 of them platform admins. The third,
  `cloudenglish.net@gmail.com`, is the ordinary-creator account, and it is the
  only way to exercise the moderation gate as a stranger meets it.

**Recently shipped** (context for why things look the way they do): storage
cascade deletion on tour delete; a 13+ age floor; light-mode sheet fixes; the
welcome screen; an AR placement map replacing a radial pad; SEO plumbing
(robots, sitemap, structured data, canonical from `PUBLIC_SITE_ORIGIN`); a
public `/report` takedown path with a 15-day response commitment; unlisted
experiences; and on 2026-08-11 draft/live publishing, a within-tour media
picker, a "Changes not published" badge, and the app's first favicon.

**Also fixed 2026-08-11, and worth knowing because it was invisible:** every
edge function except `submit-takedown` was refusing requests from
`obelisk.place`. The CORS origin list had been copy-pasted into each function
and only the one written after the domain was bought knew about it, so
publishing, deleting, admin moderation, character chat, voice and generation
were all broken on the real domain while working perfectly on `*.vercel.app`,
which is where they were tested. The list now lives in
`supabase/functions/_shared/cors.ts`. Do not add an eighth copy.

---

## Draft/live publishing (task #67) — SHIPPED 2026-08-11

Built, deployed, and exercised end to end from a non-admin account. This
section describes what exists; it is no longer a plan.

### What it does

Saving never moderates. A creator edits a live tour as much as they like and
players keep getting the last approved version until a new one passes review.
A failed check touches nothing that is live.

That was the point. Re-checking on edit and unpublishing on failure — the
obvious design — means a false positive takes down a running experience
mid-campaign, killing every link the creator has shared, silently, possibly
while they sleep. Draft/live dissolves that: moderation stops being something
that can punish a creator and becomes a gate they walk through. It also makes
the cost problem mostly disappear, because ordinary saving never calls the
model at all.

### How it is put together

**`published_snapshot` JSONB on `tours`** holds the approved version, including
zones. Not a revisions table: the simplest thing that guarantees an immutable
approved version.

**`build_tour_snapshot(tour_id)` is the single definition of what a snapshot
contains.** Both the backfill and the publish path call it, so there is one
answer to "what did we approve". It works by *excluding* a list of internal
columns, which means a new column lands in the snapshot automatically. That is
the right default — a missing player field is the worse bug — but it has bitten
once already: the list was not updated when the draft-review and hash columns
were added, which put a stale `rejected` verdict inside a live snapshot and
made the hash columns recurse into their own input. **Add bookkeeping columns
to that blocklist when you add them.**

**Fingerprints.** `tour_snapshot_hash(snapshot, policy_version)` decides whether
a paid review can be skipped. `tour_content_hash(snapshot)` is content only and
drives the "Changes not published" badge — deliberately without the policy
version, or bumping the policy would make every tour claim unpublished changes
overnight. Both hash the `jsonb`, so Postgres normalises key order and
whitespace and two callers cannot disagree by accident.

**Readers.** The player and `api/render.ts` read the snapshot;
`api/sitemap.ts` additionally filters on `published_snapshot is not null`. The
editor preview deliberately still reads the draft — a creator previewing wants
to see their edits. `getPublishedTour()` falls back to the draft when there is
no snapshot, which is reachable only by an owner viewing their own unpublished
tour, because RLS means a stranger cannot read a non-public tour at all.

**Live visibility fields come from the row, not the snapshot.** Unlisting or
going private takes effect immediately rather than waiting for a re-review.

### The gate

`enforce_moderation_gate` refuses client writes to the moderation columns, the
snapshot columns, the hash columns and the draft-review columns, and refuses
`is_public = true` unless the status is approved. It holds because
`is_privileged_caller()` tests `current_user`, PostgREST runs creators as
`authenticated`, and only the service role takes the early return.

Verified as `authenticated` with a real owner's claims, in a rolled-back
transaction: writing the snapshot is refused, writing the hash is refused,
forging a snapshot while flipping `is_public` in one statement is refused, an
ordinary title edit still succeeds.

### Cost control, as built

- Still **Gemini 2.5 Flash**. Real measured cost is **$0.00037 per review**
  (~1,070 input tokens, ~19 output). The earlier "about a cent" estimate was
  roughly 25x too high. At the daily ceiling that is about half a cent.
- **Order of checks matters and is deliberate**: cooldown and lock first, then
  the fingerprint cache, then the daily ceiling immediately before the model
  call. A cache hit or a cooldown must never burn a paid slot.
- **60-second cooldown, one review at a time per tour**, both enforced by
  `begin_moderation_attempt` in a single upsert so two simultaneous publishes
  cannot both win. A stale lock expires after 120 seconds.
- **15 real executions per account per day**, hidden, overridable per account
  in `moderation_daily_limits`. `consume_moderation_quota` is one
  `INSERT ... ON CONFLICT DO UPDATE`, so the ceiling is a row lock rather than
  a read-then-write. Refunded only when the model never returned anything
  billable — never for a fail or borderline verdict.
- Every real call is logged in `moderation_runs` with tokens from Gemini's own
  usage metadata, estimated cost, and whether it was promoted. Readable by
  platform admins, which is what an admin dashboard should use.

### A matching fingerprint is not permission

The cache asks two questions: is the content identical, *and* has that approval
since been revoked. A `fail` verdict calls `revoke_tour_approvals`, so
violate → taken down → republish unchanged cannot ride an old verdict back to
live. Admin publishes are logged as `exempt`, not `pass`, so unreviewed admin
content never becomes a cached approval someone else could reach by copying it.

### What the review reads

`textForReview` in `moderate-tour`. Tour title, description, welcome subtitle,
HUD resource names; per zone: title, description, entry message, character
persona, greeting, bio, lock hint, narration script, voice direction. Plus the
first 6 images.

**This list is hand-maintained and does not update itself.** Every
creator-authored string added to `tours` or `zones` from now on must be added
there or it silently escapes review. Narration scripts escaped for months
exactly this way.

### Verified in production

From `cloudenglish.net@gmail.com`, a non-admin account, against the live site:

1. First publish went through the real gate, passed, went live.
2. Editing the title and saving did **not** change what the player served.
3. Publish changes promoted it, and the player then served the new version.
4. A zone entry message telling players to stab people was **rejected**, with a
   usable reason, and the live version kept playing untouched.
5. Removing the offending line and resubmitting was approved.

Item 4 is the one that matters. It is the case the old design got wrong.

### Known gaps, carried forward

- **The public API still serves drafts.** `tours_select` grants anonymous
  callers the whole row of a public tour, which includes the draft the player
  is deliberately not being shown, plus `lock_passphrase` and
  `character_prompt`. See `docs/platform-audit-2026-08-11.md`, finding 1. This
  is the most important loose end in the feature.
- **Images referenced by a snapshot must survive the creator replacing them in
  the draft.** `delete-tour` removes everything under the tour's storage
  prefix, which is correct on deletion — but any future "clean up unused
  uploads" task must treat snapshot-referenced files as live, or a published
  experience quietly loses its images.
- **"Newest pending revision wins" was not built.** It matters for a background
  queue; review here is synchronous, so a second attempt mid-review is simply
  told the tour is busy. Revisit if review ever moves to a queue.

## Also pending

**#68 — terms hash.** Acceptances record which version was accepted but not what
it said. Store a hash of the terms text alongside the version so a record proves
the content. Small, and impossible to add retroactively.

**#69 — refresh `docs/launch-readiness.md`.** Done 2026-08-11.

**From the audit (`docs/platform-audit-2026-08-11.md`), highest first:**

1. The public API still serves drafts, passphrases and character personas to
   anonymous callers on any public tour. Dropping anonymous `SELECT` on `zones`
   is the cheapest large win — nothing anonymous reads that table any more.
2. Four account helpers (`is_platform_admin`, `storage_used_by`,
   `storage_limit_for`, `tour_cap_for`) accept an arbitrary user id and are
   callable by anyone. Check policies before revoking: one RLS policy calls
   `is_platform_admin` as the invoking role.
3. `search_path` is unpinned on ten functions including `enforce_moderation_gate`.
4. The uploads ledger undercounts, because `elevenlabs-tts` writes to storage
   without recording. 27 of 133 files are unaccounted for in the quota.

**Not blocked on engineering:** LLC, counsel review, DMCA agent registration
(~$6, cheapest item on the list), and inviting one real creator — which is the
highest-information step available and the thing that decides the billing
design, because it answers how much friction the BYOK API key step really is.

---

## Design decisions already settled — do not relitigate

- **Place pages** live at `obelisk.place/us/ny/marlboro`. Hierarchical because
  place names collide across countries, and indexed URLs are expensive to
  change. Pages exist at town, county and region level; a level only exists if
  it holds more experiences than the level below, otherwise it is a duplicate of
  the smaller one. Gate on content quality rather than an arbitrary count.
  Vernacular regions like "Hudson Valley" are not in geocoder data and are
  hand-made, only where density earns one.
- **Radius search** is a separate surface from place pages and must never
  generate indexable URLs — infinite coordinate space over the same content is
  the fastest way to be classified low-value. It must accept a typed place, not
  only current location, because people plan trips.
- **Geocoding**: OpenCage, $25 one-time for 10k requests. Chosen because it
  permits storing results permanently — Google and Mapbox restrict that, and the
  locality has to be stored. Not yet purchased; only needed to test.
- **Audio is never moderated.** Possible but costly, and covered by
  notice-and-takedown. Say so plainly rather than implying uploads are reviewed.
  Note the distinction added on 2026-08-11: the audio FILE is not reviewed, but
  the narration SCRIPT now is. A script is plain text in the same row as
  everything else the review already reads, and skipping it meant a creator
  could write anything, turn it into speech, and have it checked at no point —
  a gap between two reasonable decisions rather than a decision anyone made.
  15 zones already had scripts when this was found. `voice_instructions` and
  progression resource names were added at the same time, for the same reason.

  **Which fields the review reads is a list in `textForReview`, and it does not
  update itself.** Every creator-authored string added to `tours` or `zones`
  from now on has to be added there, or it silently escapes review. Worth a
  glance whenever a text field is added.
