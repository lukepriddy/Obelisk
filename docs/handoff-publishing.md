# Handoff: draft/live publishing

Written at the end of a long session so the next one starts from the design
rather than from a chat log. Read this, then the reading list in "Start here",
before proposing anything.

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

**Everything is committed, pushed and deployed.** Working tree clean at the time
of writing.

- `obelisk.place` is live with a valid certificate, pointed at this Vercel
  project via a Cloudflare CNAME (proxy off).
- **`PUBLIC_SITE_ORIGIN` is deliberately NOT set.** While unset, `robots.txt`
  refuses every host and the sitemap is empty, so nothing anywhere is
  indexable. That is the intended state until there is real content worth
  finding. Setting it is the switch that turns indexing on.
- All 11 live tours are **Unlisted** — reachable by link, absent from listings.
  One is Private. None are Public.
- No real creators yet: 3 accounts, 2 of them platform admins.

**Recently shipped** (context for why things look the way they do): storage
cascade deletion on tour delete; a 13+ age floor; light-mode sheet fixes; the
welcome screen; an AR placement map replacing a radial pad; SEO plumbing
(robots, sitemap, structured data, canonical from `PUBLIC_SITE_ORIGIN`); a
public `/report` takedown path with a 15-day response commitment; and
unlisted experiences.

---

## The task: draft/live publishing (task #67)

### Why

Today a tour is moderated once, at publish. Editing an approved tour re-checks
nothing, which is the obvious way through the gate once strangers can publish.

The naive fix — re-check on edit and unpublish on failure — is worse than the
problem. It means a false positive takes down a live experience mid-campaign,
killing every link the creator has shared, silently, possibly while they sleep.

**Draft/live dissolves this.** Saving never moderates. The previously approved
version stays live until a new one passes. Moderation stops being something
that can punish a creator and becomes a gate they walk through. It also makes
the cost problem mostly disappear without any diffing, because ordinary saving
never calls the model at all.

### Architecture

- `published_snapshot` JSONB on `tours`. **Not** a revisions table — the
  simplest thing that guarantees an immutable approved version.
- The snapshot must contain everything the public player needs, **including
  zones**.
- Public reads the snapshot: player load, `api/render.ts` share previews,
  `api/sitemap.ts`. The editor preview deliberately keeps reading the draft.
- Build the immutable candidate snapshot **before** calling Gemini. On pass,
  promote that exact snapshot. Never re-read the mutable draft afterwards, or
  edits made during review leak into approved content.

### Security — verify this first

If creators can write the snapshot columns directly, the whole architecture is
decorative. **Check this before building anything else.**

There is already a pattern for it: `enforce_moderation_gate` is a trigger that
rejects client writes to the moderation columns and refuses `is_public = true`
unless the status is approved. That is why the existing gate holds even against
a direct PostgREST call from devtools. Extend that trigger to cover
`published_snapshot` and `published_hash` rather than inventing a new mechanism.

Keep the existing properties: server re-reads canonical content rather than
trusting the client, ownership checked server-side, fail closed on error,
timeout and malformed output, creator terms required before first publish.

### Cost and abuse

- **Stay on Gemini 2.5 Flash.** Do not migrate to Flash-Lite. The saving is
  fractions of a cent at this volume, validating it properly needs ~25 smoke
  cases plus ~50 production shadow runs that would take months to accumulate,
  and safety classification is the one place where being cheap has an
  asymmetric downside.
- Content hash with `policy_version` in the cache key, so identical content
  never calls Gemini twice and a policy change invalidates old approvals.
- **A cached approval is not the same statement as a matching hash.** Going
  Private retains the snapshot — the draft keeps the content in the row either
  way, so clearing it removes one copy while another sits beside it and forfeits
  the cache for nothing. But a tour that was rejected or force-unpublished by an
  admin must not be able to flip back to Public and ride the cache back to live
  without review. Make "not invalidated by a takedown" an explicit condition of
  the cache lookup, alongside the hash and the policy version, rather than
  something the hash is assumed to imply.
- 60-second cooldown; one active job per experience; newest pending revision
  wins.
- **A hidden, configurable, atomic per-account daily ceiling on actual Gemini
  executions** (~10 as a generous default, manually overridable). The cooldown
  bounds rate but not spend — it still permits 1,440 paid calls a day, and a
  creator changing one character each time defeats hash deduplication.
- No visible per-day update limit at launch.
- Log per execution: tour id, creator id, content hash, policy version, model,
  verdict, reason, token usage from Gemini's own usage metadata, estimated
  cost, timestamp, and whether it was promoted.

### Known conflict, do not lose this

Images referenced by `published_snapshot` must survive the creator replacing
them in the draft. `delete-tour` removes everything under the tour's storage
prefix, which is correct on tour deletion — but any future "clean up unused
uploads" task must treat snapshot-referenced files as live, or a creator's
published experience quietly loses its images.

**`lock_passphrase` is already publicly readable and the snapshot does not
change that.** `zones_select` grants anonymous reads on every zone of a public
tour, and both player and editor load zones with `select('*')`, so a passphrase
is in the browser before the player types it. Pre-existing, worth knowing, and
specifically not introduced by the snapshot — which has to carry the column
because the player needs it. Fixing it properly means narrowing what the player
reads, and that is its own task.

**Nothing approved may reach a public surface without a snapshot.** Between the
migration and the reader switch a tour can be approved and snapshotless: the
backfill covers the 11 that exist now, but a publish landing inside that window
would not be covered. The sitemap fails silently here and only surfaces as 404s
in Search Console months later. Filter every public surface on snapshot
presence, not just `is_public`, and check that invariant directly after the
switch rather than reasoning that it holds.

### Verify

1. Draft edits never change the public experience.
2. A passed revision becomes the exact public revision reviewed.
3. Editing during moderation cannot leak into the approved snapshot.
4. Failed or borderline leaves the previous live version intact.
5. An API outage leaves the previous live version intact.
6. Identical requests produce one Gemini call.
7. Two simultaneous promotes cannot double-call or race.
8. Clients cannot write the snapshot columns directly.
9. Published images survive draft image replacement.
10. The daily ceiling is enforced atomically and counts only real executions.

### Start here — read before editing

Read-only first, then propose the smallest safe plan:

- `tours` / `zones` schema and RLS policies
- the `enforce_moderation_gate` trigger
- `pages/Editor.tsx` — `saveTour` and the publish transition
- `services/db.ts` — `requestPublish`
- `pages/Player.tsx` — the tour/zone load path
- `api/render.ts` and `api/sitemap.ts`
- `supabase/functions/moderate-tour/index.ts`

---

## Also pending

**#68 — terms hash.** Acceptances record which version was accepted but not what
it said. Store a hash of the terms text alongside the version so a record proves
the content. Small, and impossible to add retroactively.

**#69 — refresh `docs/launch-readiness.md`.** At least five claims in it are now
false: that players accept nothing (player terms shipped), that no real publish
has gone through moderation (Cluett-Schantz did, from a non-admin account), that
AR placement uses a radial pad (it is a map now), that there is a report path in
the player menu (there was none anywhere until `/report` shipped), and the
sections on discovery predate the SEO plumbing. A readiness doc that overstates
risk is its own problem when it is being used to decide what to do next.

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
