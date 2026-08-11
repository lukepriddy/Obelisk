# Platform audit, 11 August 2026

Run overnight after draft/live publishing shipped. Read-only: nothing here was
fixed, because a migration or an edge function deploy goes live the instant it
is applied and there was nobody awake to catch a mistake.

Everything below was measured against the live project, not inferred. Where a
claim is a judgement call rather than a measurement, it says so.

**Summary: the platform is in good shape.** Row level security genuinely holds,
no secrets ship to the browser, every edge function verifies its JWT, and every
data invariant checked came back clean. There are two real findings, both
information disclosure rather than a way in, and both fixable in an hour.

---

## Findings, worst first

### 1. The public API serves unpublished drafts — HIGH

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

### 2. Anyone can query facts about any account — MEDIUM

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

**Careful with the fix.** None of the four is called from the client or from
any edge function — they are internal SQL helpers — so revoking `EXECUTE` looks
free. It is not: the `moderation_runs_admin_select` policy calls
`is_platform_admin` as the invoking role, so revoking from `authenticated`
would lock admins out of the moderation log. Either revoke from `anon` only
after checking every policy, or change the functions to ignore their argument
and use `auth.uid()`. The self-scoped `my_storage_quota()` and `my_tos_status()`
already exist and are the right pattern.

### 3. `search_path` is not pinned on ten functions — MEDIUM-LOW

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

### 4. Two trigger functions are exposed as RPCs — LOW

`tours_refresh_hashes()` and `zones_refresh_tour_hashes()`, both added
yesterday, kept the default `EXECUTE` grant. PostgREST will not usefully invoke
a function returning `trigger`, so this is hygiene rather than a hole, but they
should be revoked like every other helper in that work was.

### 5. The uploads ledger undercounts storage — LOW, pre-existing

106 ledger rows against 133 storage objects. The 27 missing are all
`elevenlabs-tts` output, which the edge function writes straight to storage
without recording. Since `getStorageQuota` sums the ledger, generated audio is
free as far as the quota is concerned.

Already known in a different form — the ledger header notes a client could skip
it — but the actual leak in production is not a malicious client, it is our own
edge function. Fixing means either recording uploads in that function or moving
the accounting to a trigger on `storage.objects`.

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

## Recommended order

1. Finding 1, step 3 — drop anonymous `SELECT` on `zones`. Biggest reduction in
   exposure for the least work, and nothing anonymous should still need it.
2. Finding 1, steps 1 and 2 — explicit columns, then tighten the grant.
3. Finding 3 — pin `search_path`, starting with `enforce_moderation_gate`.
4. Finding 2 — self-scope the account helpers, checking policies first.
5. Finding 4 — revoke the two trigger functions.
6. Finding 5 — record TTS uploads in the ledger.

One through five are an evening. Six is its own small task.
