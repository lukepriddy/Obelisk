# Platform audit, 11 August 2026

Run overnight after draft/live publishing shipped. Read-only at the time:
nothing was fixed during the audit itself, because a migration or an edge
function deploy goes live the instant it is applied and there was nobody awake
to catch a mistake.

**All seven findings were closed on 12 August 2026.** The findings are left
below as written, with the fix and its verification recorded under each. A
record of what was wrong is worth more than a clean page, and the reasoning
about ORDER is the part worth keeping: two of these could have taken the whole
site down if applied before the client that depended on them.

Everything below was measured against the live project, not inferred. Where a
claim is a judgement call rather than a measurement, it says so.

**Summary as written on the day: the platform is in good shape.** Row level
security genuinely holds, no secrets ship to the browser, every edge function
verifies its JWT, and every data invariant checked came back clean. Two real
findings, both information disclosure rather than a way in.

That held up. Nothing found here was a way into the system; everything was
something readable that should not have been. The largest, and the one worth
remembering, was of my own making: draft/live publishing changed what the
player reads and I did not change what the API serves, so for a day the feature
looked right in the app while the drafts it existed to protect stayed one
request away.

---

## Findings, worst first

### 1. The public API serves unpublished drafts — HIGH — **CLOSED**

Draft/live publishing changed what the *player* reads. It did not change what
the *API* exposes. `tours_select` still grants anonymous callers the whole row
of any public tour, and that row holds the draft.

Measured as `anon`:

- the draft `title` and `description` of a live tour, which is precisely the
  content the public is not supposed to be seeing yet
- `draft_review_status` and `draft_review_reason`, so a rejection and the
  reviewer's stated reason are readable by anyone
- **14 zone `lock_passphrase` values**
- **18 zone `character_prompt` values** — the AI personas, which are both the
  creator's work and the instructions a player could use to steer the character

The passphrase and persona exposure is pre-existing and was already noted in
the publishing handoff. The draft exposure is new, and it partly defeats the
point of the feature: content that failed review is one HTTP request away.

Nobody is being harmed today — the only creators are Luke's own accounts and
one test account. This matters before a stranger publishes.

**Fix, in this order, because the order matters:**

1. Change the public read path to select explicit columns rather than `*`.
   `getTourById` currently does `select('*')`, so tightening the grant first
   would break the live player instantly.
2. Once deployed, revoke `SELECT` on `public.tours` from `anon` and re-grant
   only the columns a public reader needs: `id`, `is_public`, `is_listed`,
   `published_snapshot`, `owner_id` if anything still needs it. Column-level
   grants work through PostgREST.
3. Consider dropping anonymous `SELECT` on `zones` entirely. The player reads
   zones from the snapshot now, and `api/render.ts` no longer queries the table
   at all. If nothing anonymous needs it, that single change removes the
   passphrase and persona exposure outright.

Step 3 is the cheapest large win available anywhere in this audit.

**Closed 12 Aug, in four steps rather than three.** Anonymous `SELECT` on
`zones` was dropped first — anon went from 57 zones and 14 passphrases to zero,
owners unaffected. Then the client was changed to name its columns, deployed,
and the anon column grant narrowed behind it.

That left a case the original write-up underrated: a SIGNED-IN creator could
still read another creator's draft, verified by having one account read the
other's unpublished title. Column grants cannot fix that — RLS chooses rows,
grants choose columns, and neither expresses "these columns, but only for rows
you do not own", while the editor genuinely needs every column of its own
tours. The fix was `public_tours`, a view over published rows carrying only
`id`, `is_public`, `is_listed` and `published_snapshot`, with the player,
`api/render.ts` and `api/sitemap.ts` switched to it and `tours_select` reduced
to owner-only.

Verified after: anonymous is refused on the table and sees all 12 rows of the
view; another creator reading the owner's tour gets nothing where it previously
returned the title; owners still read their own drafts; the live player, share
previews, sitemap and robots all still work.

### 2. Anyone can query facts about any account — MEDIUM — **CLOSED**

Four `SECURITY DEFINER` functions take a user id as an argument and are
executable by `anon` over `/rest/v1/rpc/`. Measured, unauthenticated, against a
real account:

```
is_platform_admin(uid)  -> true
storage_used_by(uid)    -> 111433505
tour_cap_for(uid)       -> 25
```

`owner_id` is readable on every public tour, so the user ids needed to do this
are not secret. The chain is: read a public tour, take its owner, learn whether
that person is a platform admin and how much storage they use.

Low impact today. It is still an account enumeration primitive, and "which of
these accounts is an admin" is exactly the question an attacker asks first.

**Closed 12 Aug.** The first attempt revoked from `anon` and achieved nothing:
functions are created with `EXECUTE` granted to `PUBLIC` and every role
inherits that, so the probe still got answers anonymously. That is the argument
for testing a fix rather than reading the grant back. Removed from `PUBLIC` and
handed back only where something calls it — `is_platform_admin` and
`tour_cap_for` stay executable by `authenticated` because a policy and two
triggers call them as the signed-in creator; the two storage helpers went
entirely, since they are only reached from inside a `SECURITY DEFINER` wrapper.
Verified that anonymous is refused on all three, a signed-in user can no longer
read another account's storage, and admins, tour saves, zone saves and
`my_storage_quota` all still work.

**Careful with the fix.** None of the four is called from the client or from
any edge function — they are internal SQL helpers — so revoking `EXECUTE` looks
free. It is not: the `moderation_runs_admin_select` policy calls
`is_platform_admin` as the invoking role, so revoking from `authenticated`
would lock admins out of the moderation log. Either revoke from `anon` only
after checking every policy, or change the functions to ignore their argument
and use `auth.uid()`. The self-scoped `my_storage_quota()` and `my_tos_status()`
already exist and are the right pattern.

### 3. `search_path` is not pinned on ten functions — MEDIUM-LOW — **CLOSED**

Including `enforce_moderation_gate`, which is the security boundary for the
entire publishing system, and `is_privileged_caller`, which is what that gate
trusts.

Both currently call their dependencies fully qualified, so there is no known
exploit path. But an unpinned `search_path` means the protection depends on
every future edit staying disciplined about qualification, which is the kind of
guarantee that decays. One `SET search_path TO 'public'` per function.

Affected: `enforce_moderation_gate`, `is_privileged_caller`, `sync_is_listed`,
`enforce_tour_quota`, `current_tos_version`, `current_moderation_policy_version`,
`build_tour_snapshot`, `tour_snapshot_hash`, `tour_content_hash`,
`default_moderation_daily_limit`.

**Closed 12 Aug.** All ten pinned with `ALTER FUNCTION ... SET search_path`,
which leaves the bodies where the migrations that defined them can be read.
Altering the publishing gate is not free, so the gate probe was re-run
afterwards: forging a snapshot while flipping `is_public` is still refused,
self-approval is still refused, ordinary edits still work, and the snapshot
builder, hash and quota all still function.

### 4. Two trigger functions are exposed as RPCs — LOW — **CLOSED**

`tours_refresh_hashes()` and `zones_refresh_tour_hashes()`, both added
yesterday, kept the default `EXECUTE` grant. PostgREST will not usefully invoke
a function returning `trigger`, so this is hygiene rather than a hole, but they
should be revoked like every other helper in that work was.

**Closed 12 Aug.** Revoked from `PUBLIC`, `anon` and `authenticated`. Triggers
are unaffected — Postgres checks `EXECUTE` when a trigger is created, not each
time it fires — and that was confirmed by saving a tour and a zone as a creator
afterwards, which fires both.

### 5. The uploads ledger undercounts storage — LOW, pre-existing — **CLOSED**

106 ledger rows against 133 storage objects. The 27 missing are all
`elevenlabs-tts` output, which the edge function writes straight to storage
without recording. Since `getStorageQuota` sums the ledger, generated audio is
free as far as the quota is concerned.

Already known in a different form — the ledger header notes a client could skip
it — but the actual leak in production is not a malicious client, it is our own
edge function. Fixing means either recording uploads in that function or moving
the accounting to a trigger on `storage.objects`.

**Closed 12 Aug.** `elevenlabs-tts` now writes an `uploads` row after a
successful upload, best effort so a bookkeeping failure cannot lose a creator
the audio they just paid to generate. The files it had already written were
backfilled, matched on exact storage path so the backfill is repeatable.
Reconciled after: 108 ledger rows against 108 storage objects belonging to a
live tour, nothing unrecorded, and no ledger row pointing at a file that does
not exist.

### 6. Performance notes — INFO

Three unindexed foreign keys (`api_usage_events.tour_id`,
`takedown_requests.tour_id`, `uploads.tour_id`) and three unused indexes
(`tours_tags_idx`, `takedown_requests_open_idx`, `moderation_runs_creator_idx`).
At 14 tours and 237 sessions none of this is measurable. Worth revisiting at a
few thousand rows; not worth touching now.

### 7. Not applicable

Supabase flags leaked-password protection as disabled. Obelisk is passwordless
— email codes only — so there is no password to check. Ignore it rather than
enabling it and wondering later why it never fires.

---

## What was checked and came back clean

**Row level security actually holds.** Rather than reading policies, every
table in `public` was counted as `anon`:

| table | anon rows / total |
|---|---|
| tours | 12 / 14 (exactly the public ones) |
| zones | 57 / 77 (exactly those of public tours) |
| api_keys | permission denied |
| client_events | permission denied |
| everything else (17 tables) | 0 rows |

The Supabase linter raises 35 warnings about tables being "visible in the
GraphQL schema" to `anon` and `authenticated`. Those are about schema
discoverability, not data: the counts above are what those roles can actually
read. Do not spend time on them.

**No secrets in the browser bundle.** The only credential in `dist` is the
`anon` JWT, which is designed to be public. No service-role key, no Gemini key.

**Every edge function verifies its JWT.** All seven, checked against the
deployed configuration rather than the source.

**Storage listing is correctly scoped.** The policy added yesterday was tested
with real claims: a creator sees their own tour's files, zero files from
another account, and anonymous sees nothing.

**Data integrity is clean.** Every invariant returned zero violations:

- no public tour without a snapshot
- no listed-but-private tour
- no public tour that is not approved
- no snapshot without its hash, no tour without a draft hash
- no orphaned zones, no dangling `requires_zone_id`
- no ledger rows for deleted tours

The one apparent anomaly — 29 storage objects with no matching tour — is the
platform's own `voice-samples` and `ambient-presets` folders. Expected.

**The new publishing machinery is healthy.** No locks held, no tour stuck
between draft and live, six runs logged (five pass, one fail), total spend to
date **$0.0015**.

---

## Still true from the old soft-spots list

- **3D models are never reviewed.** `moderate-tour` reads text and images. A
  GLB passes through unexamined, and unlike an image there is no cheap way to
  look at one — it must be rendered first. This is the largest remaining hole
  in review coverage now that narration scripts are covered.
- **The moderation fail-safe has never been exercised in production.** It is
  correct by construction and covered by the code path, but no real Gemini
  outage has happened to prove it.
- **Managed-tier key fallback.** `keyForTour()` and `keyForCaller()` hand out
  the platform Gemini key to any creator without their own, not only paying
  ones. Harmless while everyone is invited; must become conditional before
  billing exists.

---

## What was done, in the order it was done

All on 12 August 2026, worst first, each verified against production before
moving on.

1. Dropped anonymous `SELECT` on `zones`. Biggest reduction in exposure for the
   least work, and nothing anonymous needed it any more.
2. Pinned `search_path` on the ten functions.
3. Named the public path's columns, deployed, then narrowed the anon grant on
   `tours`.
4. Revoked the account helpers and the two trigger functions from `PUBLIC`.
5. Recorded TTS uploads in the ledger and backfilled what was missing.
6. Added the `public_tours` view, deployed the readers onto it, then reduced
   `tours_select` to owner-only.

**Two of these could have taken the site down if applied in the wrong order.**
Steps 3 and 6 both narrow what the database will serve, and the deployed client
has to stop asking for the wider thing FIRST. Narrowing before deploying would
have failed every player request at once. Both were therefore split across a
deploy: change the client, ship it, confirm `version.json`, then apply the
database half.

## What is still open

Nothing from this audit. The three items under "still true from the old
soft-spots list" below remain open, and 3D models are the largest hole left in
review coverage now that narration scripts are read.

Worth re-running this audit after the next significant change to who can read
what. The method that found everything here was counting rows as `anon` rather
than reading policies, and probing a fix rather than reading the grant back —
the second one caught a revoke that silently did nothing.
