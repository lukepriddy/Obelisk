# Player terms — brief for counsel

What `constants/playerTerms.ts` covers, what it deliberately does not, and the
comparison worth making. Written to make a paid hour cheap, not to substitute
for one.

## The problem in one paragraph

Obelisk publishes location-based audio experiences created by independent
creators. A creator chooses real-world coordinates; a player walks to them while
looking at a phone. Creators accept terms at publish, recorded per version in
`tos_acceptances`. **Players are the ones who can be injured, and until now
accepted nothing.** They have no account and are anonymous. Locations are not
inspected, visited or verified by us.

## What is already in place

- Player terms shown as a clickwrap notice immediately above the Begin button,
  linking to `/player-terms`.
- The accepted version recorded server-side against each play in
  `player_sessions.terms_version`, alongside the timestamp.
- A separate real-world safety notice shown after Begin, before walking.
- A report path from the player menu, and the ability to unpublish quickly.
- Creator terms placing responsibility for location choice on the creator.

## What is NOT drafted, and needs you

These were left out deliberately. Guessing at them would be worse than their
absence.

1. **Arbitration and class-action waiver.** The highest-value item. Public
   commentary on the Pokémon GO litigation suggests Niantic's terms —
   disclaiming liability for property damage, personal injury and death, plus
   arbitration with a class-action waiver accepted at download — are central to
   how that defence has held. We have no equivalent. Note this is a genuine
   business decision, not boilerplate: it also costs us the ability to litigate,
   and enforceability varies by jurisdiction and with minors.
2. **Governing law and venue.**
3. **Limitation of liability**, the cap, and its carve-outs.
4. **Assumption of risk** in whatever form actually carries weight, rather than
   the plain-language version currently in section one.
5. **Whether a conspicuous notice is sufficient, or a checkbox is required.**
   A checkbox is stronger evidence and costs a tap on every play, for anonymous
   users who may open several experiences. We would rather be told than guess.
6. **Minors.** The draft asks under-18s to play with a guardian. Whether that
   is meaningful, and whether the terms bind a minor at all, is open.

## The comparison worth making

Niantic is the closest analogue at scale: same core mechanic, far more
resources, and a decade of exposure. Their terms are worth reading as a
benchmark for *what ground to cover* — they are not copied here, both because
they are a copyrighted work and because they are written for a different entity,
jurisdiction and business model.

The precedent that actually cost them money was **not** personal injury. It was
a 2016 class action by property owners over PokéStops placed on or near private
land, settled February 2019 for roughly $4M — mostly legal fees, with about
$1,000 to each named plaintiff. The lasting cost was operational: removal of
PokéStops within 40m of single-family homes on request, and a duty to resolve
removal requests within 15 days for 95% of cases annually.

**That is the shape of our largest exposure too, and arguably worse.** Niantic
placed stops algorithmically at scale; our creators choose exact coordinates
deliberately, which gives an aggrieved landowner a more pointed complaint. A
fast, documented removal path is worth building before it is imposed.

We found no evidence of Niantic paying out on personal injury claims. That is
the absence of a search result rather than proof, and such settlements are often
confidential.

## Context that may matter

- No legal entity yet; an LLC is planned. Everything currently lands on an
  individual.
- No insurance yet.
- No DMCA agent registration yet — creators upload audio, images and 3D models.
- Invite-only. No public signups, a handful of creators, all known.
- Players need no account and give no personal details beyond location, which is
  used on-device for triggering.
