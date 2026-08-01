# Launch readiness

Where Obelisk stands between "a tool I use" and "a platform other people use,"
and what's deliberately not done yet.

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

**AR is shipped.** Camera view uses Niantic Spatial's engine for visual
tracking, credited on the intro card and at `/licenses`. Both behaviours —
static and flyover — have been tested in the field and work. Placement is
authored on a top-down pad, in feet like the rest of the UI. GPS position
correction is a per-zone setting, off unless enabled, because it measurably
hurts nearby objects. `docs/ar-tracking-notes.md` has the measurements, the
distance/error model behind that default, and one approach that was tried and
removed.

The licence position is unchanged and worth re-reading before any commercial
step: the free tier bars use where value "derives substantially" from the
engine. No reply was ever received to the outreach email.

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
  reviewed. Priorities: a player-facing assumption-of-risk agreement (players
  currently accept nothing, yet they're the ones who can be injured),
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
step the way a stranger meets them. This matters more than it sounds: admin
exemption means *no real publish has ever gone through `moderate-tour` in
production*. Every test of that path has been synthetic. A regression there is
currently invisible from Luke's own accounts, and the first person to find it
should not be the first invited creator.

Repeat the same dry run after any change to the moderation path.

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

**Related gap to close at the same time:** `keyForTour()` and `keyForCaller()`
currently fall back to the platform Gemini key for *any* creator without their
own key, not just paying ones. Harmless while the only users are invited, but
it must become conditional before Managed exists — otherwise the free tier
silently gets the paid benefit.

---

## Known soft spots

- **Moderation fail-safe is untested live.** A Gemini outage resolves to
  `pending_review` by design, but breaking the key to prove it would have taken
  down character chat on live tours. A waterfall of Gemini keys would make this
  largely moot.
- **Storage ledger can be bypassed.** `uploads` is written by the client after
  a successful upload, so a determined caller hitting Supabase Storage directly
  would undercount their usage. Closing it needs a trigger on `storage.objects`
  or proxying uploads through an edge function.
- **No re-moderation after edits.** A tour is reviewed at publish. Editing an
  already-approved tour doesn't re-check it — covered by reports and
  fast-unpublish rather than detection.
- **3D models are not reviewed at all.** `moderate-tour` reads text and images.
  A GLB uploaded as an AR object passes through unexamined, and unlike an image
  there is no cheap way to look at one — it has to be rendered from some angle
  first. This became a live gap when AR shipped rather than a theoretical one.
  Same mitigation as the above (terms, reports, fast-unpublish), but worth
  naming separately, because "we review uploads" is not currently true of the
  most novel thing a creator can upload.
- **No discovery.** `is_public` only filters a creator's own dashboard; there
  is no page listing other people's tours. Deferred on purpose.
