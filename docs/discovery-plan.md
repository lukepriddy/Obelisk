# Discovery

How people find experiences, in the order worth building it. Nothing here is
built yet.

## The constraint everything follows from

Discovery for ordinary content is a ranking problem — the audience is unbounded,
so the job is surfacing the right thing among many. Location content inverts
that. The audience for any experience is the people physically near it, so the
job is **coincidence**, not ranking.

Which makes density the whole game, and **density is local**. Five hundred
experiences spread across a country is still zero experiences for almost
everyone opening a map. Twenty in one town is a real product for that town. Go
deep in one area before going wide.

The corollary: a browse-the-world map earns its place only when a meaningful
share of visitors find something within roughly twenty minutes of themselves.
Below that it doesn't read as "here's what's available," it reads as "this is
empty" — and that is spent on a first impression you only get once.

So the first two steps below are **creator-owned distribution**: making the
sharing that already happens work harder. Only step 3 starts making the platform
itself a destination.

---

## 0. Trail metadata (prerequisite for everything else)

Before any surface can help someone choose, an experience has to say what
committing to it costs. Twenty minutes and ninety minutes are different plans.
This is the hiking-app model — distance, time, route shape — and it belongs
everywhere an experience is described.

**Computed, free, objective:**

- **Distance** — walking path through the zones, from coordinates already stored.
- **Route shape** — loop or point-to-point, from whether the last zone is near
  the first. Materially affects planning: does someone end up back at the car?
- **Audio length** — sum of zone audio durations.

**Creator-entered:** a typical completion time, because dwell time, chat length
and pace are unknowable from data. Offer a computed anchor rather than an empty
box — "your zones span 1.2 miles and 14 minutes of audio; most people take
35–50 minutes" — so the number is informed and the field is nearly free to fill.

**Decision: one integer, `duration_minutes` on `tours`, displayed
approximately** — "about 40 min", switching to hours past 90. A low/high range
would be more honest, but it doubles the input friction on a field whose entire
value depends on creators actually filling it, and precision is false here
regardless.

**It has to appear before commitment**, which means: welcome screen, share card,
creator page, place pages. A duration visible only after starting is useless for
the planning problem it exists to solve.

---

## 1. Link legibility

**The unit of discovery is the shared link, and ours is currently invisible.**
`index.html` has a `<title>` and no other metadata, and `vercel.json` rewrites
everything to that one static file, so there is no per-tour metadata even in
principle. Every link ever texted, posted, or newslettered has arrived as a bare
grey rectangle.

**Approach.** A Vercel function at `api/render.ts` fetches the tour, injects meta
tags into `dist/index.html`, returns it. `vercel.json` routes `/player/:tourId`
there; everything else keeps the current rewrite. Same HTML to crawlers and
humans — no user-agent branching, which can't then drift into serving two
different things. The SPA hydrates over it normally.

**Read with the anon key, never service role.** RLS already scopes anonymous
reads to `is_public = true`, so an unpublished tour produces no preview by
construction. The permission model becomes the privacy model, with no second set
of rules to drift.

Tags: `og:title`, `og:description` from `welcome_subtitle ?? description`,
`og:image` from `welcome_image_url`, `twitter:card=summary_large_image`,
canonical URL, real `<title>`. Fold in trail metadata — "1.2 mi · about 40 min ·
loop" earns its place in the description.

**Risks.**

- This changes how *every* player page is served. A throw or timeout breaks the
  player for everyone. It must fall through to the untouched static HTML on any
  error, and that fallback needs deliberate testing, not assumption.
- Tours without `welcome_image_url` get no image, which is most of the value.
  **Decision: solve this in the editor, not the pipeline.** Ship one static
  branded fallback, and relabel the field so it plainly says this is the image
  people see when the experience is shared. Most creators fill it once they know
  what it is for, which turns an image-generation project into a copy change.
  Build generated map-crop cards only if the field stays empty in practice.
- Cold starts add first-paint latency where there is none today. Cacheable with
  `s-maxage`, but real.

**Sibling, independent:** the **far-away arrival state**. Nothing in `Player.tsx`
currently handles someone opening from 300 miles away. They should get what it
is, where it is, how far, and a way to keep it — not a map of somewhere they
aren't. Pure client work, no dependency on the function, and cheaper than it.

---

## 2. Creator pages

`/c/:handle` — a creator, their public experiences on a map, cards with
description and trail metadata. Reuses `api/render.ts` for its own share card.

Its key property is that **it scales down gracefully**: five experiences from one
person reads as intentional, where five on a world map reads as broken. Useful
from the first creator, which is rare.

**Blocked on a public identity model that does not exist.** `profiles` today
holds only billing and quota fields. Needs `handle`, `display_name`, `bio`,
`avatar_url`, `is_public_profile`.

**RLS is the sharp edge here.** `profiles` contains Stripe customer and
subscription IDs. A table-wide anonymous read policy would expose billing data.
This needs a column-scoped policy or a separate public view — not
`USING (true)`.

### Decisions

**Handles — first-come, reserved list, changeable, strict charset.**
Lowercase `a-z`, digits, hyphen; 3–30 characters; no leading, trailing or
doubled hyphen; stored and compared lowercase. Changing one tombstones the old
handle permanently rather than releasing it, and 301s to the new one — the row
is being kept regardless, so the redirect is nearly free and it stops anyone
claiming a departed creator's inbound links.

**Reserve the namespace before launch.** Every existing route plus the
impersonation targets: `admin`, `api`, `app`, `support`, `help`, `settings`,
`about`, `obelisk`. This is the only decision here that cannot be repaired
later — once `/c/support` belongs to someone, it belongs to them.

**Exposed fields — `display_name`, `bio`, `handle`. No avatar.**
`display_name` is required and typed by the creator, **never defaulted from
anything account-derived**; defaulting it from an email address is how you
publish someone's real name when they wanted a pseudonym. `bio` optional, 280
characters. Email never leaves the server, enforced by the RLS policy rather
than by the UI declining to render it.

Avatars are deliberately out: another unmoderated image upload, another call on
the storage quota, and close to no contribution to the actual job of helping
someone decide whether to walk somewhere. A monogram generated from the handle
covers it. Add them when a creator asks.

**Profile text moderation is deferred, and owed.** `moderate-tour` reads tours,
not profiles. With invited creators a 280-character cap plus the reports queue
is proportionate; this becomes mandatory before public signups. Recorded here
because profiles are easy to forget when thinking about moderation.

**Opt-in — default off, prompted at first successful publish.**
Off is the right consent default: being invited should not silently publish a
page carrying your name. The prompt is what stops "default off" becoming
"nobody ever enables it" — it asks at the point of maximum motivation, just
after something went live. Claim the handle inline in the same prompt.

**Which tours appear — fix the data rather than the query.**
Have the moderation trigger stamp admin-owned tours `approved` with
`moderation_reason = 'owner is platform admin'`, and backfill the existing ones.
The publish exemption is unchanged; the status column simply stops
misdescribing what happened.

Every consumer then reads `is_public AND moderation_status = 'approved'`, with
no knowledge of the exemption. One migration now, against a footgun that
otherwise has to be re-remembered in every surface built from here on — and
whose failure mode is Luke's own creator page rendering empty while everyone
else's works.

**Ordering — distance from the viewer where geolocation allows, newest-first
otherwise.** The visitor's question is what is near them. Manual ordering serves
the creator's narrative instead and can be added if one asks for it.

---

## 3. Place pages

`/places/:slug` — "Audio experiences in Kingston, NY." This is how location
content actually gets found: people search a destination, they do not browse a
world map.

Needs a `locality` on tours to group by, either creator-entered or
reverse-geocoded from `lat/lng` at save time — a geocoding dependency that does
not exist yet.

**Precondition, and the reason to wait:** these work by being *the good answer*
to a destination query. A page listing one experience is not that, and thin
pages can do lasting harm by establishing the site as low-value for exactly the
queries you want. Roughly five experiences in an area is the honest floor, and
that is a content problem rather than an engineering one.

Counterweight: indexing and ranking take months, so this wants building *early
relative to when it is needed* — just not before there is something to index.

---

## Sequencing

**Two items are cheap now and expensive later. Do them first, out of order.**

- **Reserve the handle namespace.** Not a feature — a `reserved_handles` table
  or constant, populated before anyone can claim anything. Once `/c/support`
  belongs to a stranger it belongs to them, and no amount of later work undoes
  that.
- **Stamp admin tours `approved`.** A migration plus a trigger change. Its cost
  grows with every surface that has to remember the exemption, and its failure
  mode is silent — Luke's own page renders empty while everyone else's works.

Neither depends on anything else here, and neither is visible when shipped.

Then: trail metadata (0) is a prerequisite for the rest, since every later
surface displays it and retrofitting it into three places costs more than
building it once.

The far-away state is the cheapest independent win, worth doing while the
rendering change in (1) gets tested properly. `api/render.ts` is a hard
dependency of both (2) and (3), so it precedes either regardless of priority.

(2) is useful from the first creator. (3) waits on density.

## Not in scope, deliberately

A world map of everyone's experiences. It fails on density today, and it is also
the step that turns Obelisk into a destination for other people's content —
which is precisely the exposure `launch-readiness.md` names as gating public
signups. Steps 0–2 are creator-owned distribution and carry no such change.
