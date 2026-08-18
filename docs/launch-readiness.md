# Launch readiness

Where Obelisk stands between "a tool I use" and "a platform other people use,"
and what's deliberately not done yet.

Last refreshed 2026-08-17. Security posture is audited separately in
`docs/platform-audit-2026-08-11.md`; all seven findings from that audit were
closed on 2026-08-12.

Changed since the 2026-08-11 refresh: script import shipped (see below), the
key-resolution and rate-limit design was worked out and written down as
section 5, and the ordering at the bottom is new. This document is used to
decide what to do next, so anything stale in it costs real time.

## Already in place

Publishing runs an automatic content review (`moderate-tour`) before anything
goes public, enforced by a database trigger rather than the UI — a creator
calling PostgREST directly gets the same refusal. Accounts have storage,
experience-count, and AI rate limits. Creators accept terms before their first
publish, recorded per version in `tos_acceptances`. Players see a real-world
safety notice and can reach `/privacy` without an account. Signups are gated
behind `access_allowlist`, with a request form that asks what people want to
build, reviewed at `/admin/moderation`.

Admins (both of Luke's accounts, seeded in `platform_admins`) are exempt from
the moderation gate but **not** from the terms.

There is a public takedown path at `/report`, reachable without an account,
with a stated 15-day response commitment. That commitment is a real obligation
with a clock on it, and the only place reports surface is `/admin/moderation` —
worth remembering before inviting anyone.

**AR is shipped.** Camera view uses Niantic Spatial's engine for visual
tracking, credited on the intro card and at `/licenses`. Both behaviours —
static and flyover — have been tested in the field and work. Placement is
authored on a map, in feet like the rest of the UI; it replaced an earlier
radial pad. GPS position
correction is a per-zone setting, off unless enabled, because it measurably
hurts nearby objects. `docs/ar-tracking-notes.md` has the measurements, the
distance/error model behind that default, and one approach that was tried and
removed.

The licence position is unchanged and worth re-reading before any commercial
step: the free tier bars use where value "derives substantially" from the
engine. No reply was ever received to the outreach email.

**Script import is shipped.** A finished script is pasted in and comes back as
zones, with the creator's words carried across untouched: the document is
numbered by line, the model returns line ranges, and the server does the
slicing, so the model never handles the text and cannot paraphrase a cipher or
transpose a glyph. Instructions written into the script (`[[locked: PIER]]`,
`[[character]]`, `[[persona: ...]]` and the rest) are obeyed and stripped
before the words are used, so they are never read aloud. Collectibles found in
a script become the experience's progression resources. First production run,
2026-08-17, turned a 14-beat Cluett-Schantz script into 17 zones: 2 character,
1 discoverable, 2 locked, 8 hidden, all carrying their voiceover script, with
progression enabled and one resource defined.

---

## 1. ~~Finish the auth switch~~ — done

Signups are disabled at the project level (**Auth → Sign In / Providers**),
which is Supabase's own supported control, and the custom
`enforce_signup_allowlist` trigger on `auth.users` has been dropped. No code of
ours sits in the authentication path any more.

Verified after the change: a stranger is refused by Supabase itself
(`signup_disabled`, HTTP 422), an existing owner can still request a login
code, and the admin invite API still creates accounts — which is what makes
approving someone work despite public signup being off.

**How people get in now:** approve them in `/admin/moderation`, which flips
their `access_allowlist` row and sends an invite email via
`inviteUserByEmail()`. The allowlist table, the request form, and the admin
queue are all unchanged; only the enforcement mechanism moved.

Worth knowing if signups ever need reopening: turning that toggle back on is
all it takes — there is no longer a second, hidden gate to remember.

---

## 2. Entity and legal review

**Status:** deferred on cost. This is what gates *public* signups.

Right now there's no legal entity, so liability for anything a creator does
lands on Luke personally. That's an acceptable risk while the only users are
his own accounts and possibly one invited friend. It is not acceptable once
strangers publish tours that send other strangers to physical locations.

The full risk assessment is in the conversation history; the short version:

- **LLC (New York).** $200 filing + ~$350–800 publication + $50 certificate.
  Ulster County is mid-range — the "use an Albany registered agent" trick saves
  only ~$150–350 here, not worth the out-of-county public record. Call the
  Ulster County Clerk on (845) 340-3288 for current designated-paper rates
  before filing. Biennial statement afterwards is $9 every two years.
- **Lawyer review** of `constants/terms.ts` and `constants/privacy.ts`. Both
  are plain-language drafts covering the right ground; neither has been
  reviewed. Players now do accept terms — the Begin screen carries a 13+ age
  floor and an at-your-own-risk assent, recorded per session — so the gap is no
  longer "players accept nothing" but "nothing a lawyer has read". Priorities:
  governing law + venue + arbitration, a real indemnity, and a liability cap.
- **DMCA agent registration** — ~$6 with the Copyright Office. Without it
  there's no §512 safe harbor for creator-uploaded material. Cheapest item on
  this list by far.

Precedent worth showing counsel: the Pokémon GO personal-injury and
landowner-nuisance litigation. Same core mechanic, weaker controls here.

---

## 3. Invite one real creator

**Status:** not started. Cheapest, highest-information step available.

Approve one email in `/admin/moderation`, hand them the link, and watch them
build a tour end to end without help.

This is deliberately ahead of billing in priority, because it answers the
question billing depends on: **how much friction is the BYOK API key step?**
The Managed tier's entire value proposition is "you don't have to go get a
Gemini key." If that step turns out to be a mild annoyance, Managed is a minor
upsell. If most people bounce there, Managed isn't an upsell at all — it's the
default tier, which changes both the price and the design.

**Do a dry run from `cloudenglish.net@gmail.com` first.** It is an ordinary
creator, not in `platform_admins`, so publishing from it is the only way to
exercise the moderation gate, the quotas, the terms prompt and the BYOK key
step the way a stranger meets them. Admin exemption means none of that is
reachable from Luke's own accounts.

That path is no longer untested: on 2026-08-11 it was run end to end from that
account against production — first publish approved, an edit held back until
submitted, a genuinely harmful edit rejected with the live version left
playing, and the corrected version approved. Six logged runs, five pass one
fail, $0.0015 total.

Repeat the same dry run after any change to the moderation path. It stays the
cheapest regression test available.

---

## 4. Stripe / Managed tier

**Status:** deliberately deferred. Groundwork laid, nothing built.

`profiles` already has `plan_tier`, `stripe_customer_id`,
`stripe_subscription_id`, and `stripe_subscription_status`, and every AI
function resolves keys through one path — so adding billing later is contained
work, not a refactor.

Not built because there is nobody to bill, the price isn't known yet (see item
3), and switching on subscriptions creates real obligations from day one —
failed payments, refunds, cancellations, sales tax — with no revenue against
them.

When it happens, the shape is: `stripe-checkout`, `stripe-portal`, and a
signature-verified `stripe-webhook` edge function with an idempotency table,
plus a shared key resolver where the platform key is only handed out when
`plan_tier = 'managed'` **and** the subscription is `active` or `trialing`.

**The key-resolution and cap design that goes with it is section 5.** Do not
build billing without reading it; the two share the same code path and doing
them separately means touching key resolution twice.

---

## 5. Whose key, and who sets the caps

**Status:** designed, not built. Written down because it was worked out once
and would otherwise be re-derived from scratch.

Nothing here is urgent at three accounts. All of it becomes real the day
somebody outside is pointed at the platform's API key.

### The bug in the current model

`keyForTour()` and `keyForCaller()` decide which Gemini key to use by asking a
single question: has this creator saved a key of their own? If not, they get
the platform key.

That collapses two completely different people into one branch:

- someone on a BYOK plan who has not added their key yet, who should be told
  to add one
- someone on a paid Managed plan, who is entitled to the platform key

Both silently get the platform key today. As of 2026-08-17, 2 of 3 accounts
have no key of their own and are billing to it. Harmless at this size, and
the free tier silently getting the paid benefit the moment Managed exists.

### The fix: the plan decides, not the presence of a key

`profiles` already carries `plan_tier` and `stripe_subscription_status`, so
there is something to branch on:

- **BYOK plan:** use the creator's key. If it is missing, refuse and say so.
  Never fall back.
- **Managed plan, subscription `active` or `trialing`:** use the platform key.

One resolver, used by every AI function, so this is a single place to change.

### Caps follow from that, as one mechanism with two policies

Two fields on an experience: **messages per player per day** and **messages
per experience per day**.

| Plan | Who sets them | What they protect |
|---|---|---|
| BYOK | The creator | Their own bill |
| Managed | The platform, by tier | The platform's bill |

On BYOK the creator sets them freely. It is their money, and the platform's
only stake is a very high sanity ceiling to catch a runaway loop, which
protects them too. On Managed the tier sets the ceiling and the creator may
set anything lower.

The settings UI is therefore worth building **once**, not per plan. It does
not need pricing to exist. The only pricing-dependent number is the Managed
ceiling.

### What is and is not blocked on pricing

Blocked, because they are tier definitions: the Managed ceiling numbers.

Not blocked, and buildable at any point:

- the per-player cap, which is an abuse rail rather than a product limit. It
  can sit well above any honest playthrough (a playthrough is roughly 10 to 30
  messages) without knowing a single price.
- the plan branch in key resolution, which is a correctness fix and not a
  pricing decision.

## Known soft spots

- **Moderation fail-safe is untested live.** A Gemini outage resolves to
  `pending_review` by design, but breaking the key to prove it would have taken
  down character chat on live tours. A waterfall of Gemini keys would make this
  largely moot.
- ~~**AI rate limits are keyed on the tour, not the player.**~~ Per-player cap
  added 2026-08-17. `gemini-chat` now checks two budgets: the tour ceiling as
  before, and a much lower one keyed on tour plus `obelisk_player_id`, the uuid
  the client already keeps in localStorage for progression. 120 chat messages
  and 80 voice calls per player per day, against a playthrough of roughly 10 to
  30. Checked second, so a player over their own limit does not also burn a slot
  from the tour's budget on the way to being refused.
  A speed bump, not a wall: clearing browser storage earns a new id. Keying on
  IP was considered and rejected, because it groups mobile players behind
  carrier NAT and would throttle strangers for each other's traffic. Original
  problem, kept for context: `gemini-chat`
  allows 30 calls a minute and 500 a day, counted per `tourId` in
  `api_usage_events`. These are the platform's own limits, in
  `supabase/functions/gemini-chat/index.ts`, not Google's; Google's quotas sit
  above them and are never reached first, which is deliberate.
  Two consequences, both inside a single experience rather than across the
  platform: one abusive player can drain a tour's whole day and lock out every
  legitimate player of it, and a genuinely popular tour hits the ceiling on
  honest use at roughly 20 to 50 playthroughs a day. The number is arbitrary;
  the keying is the actual flaw. Fixed by the per-player cap in section 5.

- **Script import has one production run behind it.** The mechanics came out
  right (see "Already in place"), but that is a single document by the person
  who designed the format. Nothing is known yet about how it reads a script
  written by somebody else, or one whose sectioning is less regular.

- **Storage ledger can be bypassed.** `uploads` is written by the client after
  a successful upload, so a determined caller hitting Supabase Storage directly
  would undercount their usage. Closing it needs a trigger on `storage.objects`
  or proxying uploads through an edge function.
- ~~**No re-moderation after edits.**~~ Fixed 2026-08-11 by draft/live
  publishing. Saving never moderates, the approved snapshot stays live until a
  new one passes, and a failed check leaves the live version untouched. See
  `docs/handoff-publishing.md`.
- **3D models are not reviewed, by decision** — the same position as audio,
  settled 2026-08-12. Reviewing a GLB means rendering it from some angle first,
  which is real cost for a rare risk, and notice-and-takedown already covers
  it. `moderate-tour` reads text and images; audio files and 3D models are
  covered by `/report` and fast unpublish instead. State it that way rather
  than implying uploads are reviewed.
  A GLB uploaded as an AR object passes through unexamined, and unlike an image
  there is no cheap way to look at one — it has to be rendered from some angle
  first. This became a live gap when AR shipped rather than a theoretical one.
  Same mitigation as the above (terms, reports, fast-unpublish), but worth
  naming separately, because "we review uploads" is not currently true of the
  most novel thing a creator can upload.
- **No discovery surface.** There is still no page listing other people's
  tours, deliberately. But the SEO plumbing around it exists now: generated
  sitemap, structured data, canonical URLs, and per-tour share previews, all
  inert while `PUBLIC_SITE_ORIGIN` is unset. Unlisted is the third visibility
  state and every live tour currently uses it, so nothing is discoverable today
  even by a crawler following a shared link.

- ~~**The public API is looser than the player.**~~ Closed 2026-08-12. Public
  reads now go through the `public_tours` view, which carries the approved
  snapshot and the two visibility flags and nothing else; `tours` itself is
  readable only by its owner. Drafts, review verdicts, passphrases and
  character personas are no longer reachable by anyone but the creator, signed
  in or not. Every finding in `docs/platform-audit-2026-08-11.md` is closed.

---

## Housekeeping

Small, none of them blocking, all of them cheap.

- **Retention purge is written but never scheduled.** `purge_old_data()` exists
  and dry-runs by default. Nobody has decided the cutoff or put it on a
  schedule.
- **Roughly 101 MB of pre-resize images.** New uploads are downscaled in the
  browser now; the existing full-size ones were never reclaimed.
- ~~**Em dashes in older UI strings.**~~ Swept 2026-08-17, 32 replacements
  across 12 files. Deliberately left: a lone "—" used as a no-value glyph in a
  stat row or input placeholder, which is a symbol rather than punctuation;
  `console.error` and GPS-debug strings, which are developer output and never
  shown; and the model-facing instruction in `ChatInterface`.
- **Code splitting.** The build warns about chunks over 500 kB. Declined on
  2026-08-15 as not worth the risk for the current audience.

---

## What to do next, in order

1. **Invite one real creator.** Section 3. Still not started, still the
   cheapest high-information step available, and almost everything below is
   blocked on what it tells you. It answers whether the BYOK key step is a mild
   annoyance or a wall, which decides whether Managed is an upsell or the
   default tier, which sets the prices, which sets the caps in section 5.
2. **Make key resolution branch on plan.** Section 5. A correctness fix, not a
   pricing decision, and the free tier silently gets the paid benefit until it
   is done.
3. **Entity, terms review, DMCA agent.** Section 2. Gates public signups. The
   DMCA registration is about $6 and is the cheapest risk reduction on this
   whole document.
4. ~~**Per-player cap.**~~ Done 2026-08-17. See the soft spots list.
5. **Stripe and the Managed tier.** Section 4, once 1 has told you the price.

Also deferred, with reasoning, in case it looks like an oversight: closing the
**storage ledger bypass** needs three sequenced deploys (a unique index on
bucket plus path, then a fail-open trigger on `storage.objects` with conflict
handling, then removing the client-side insert), because the client already
writes that ledger and a trigger alone would double every creator's measured
storage overnight. Real work against a threat that requires somebody to
deliberately bypass the app to under-report their own usage. Right time to do
it is alongside the key-resolution work in section 5, when strangers arrive.
