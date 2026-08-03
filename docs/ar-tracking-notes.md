# AR tracking: what holds an object still, and what doesn't

Field findings from a night of testing on 2026-07-31, kept so the same ground
isn't re-covered. Every number here came from screenshots with `?ar-debug=1`,
not from reasoning.

## The two regimes

Angular error is what a player actually sees, and which source dominates it
flips with distance.

| | Dominant error | Why |
|---|---|---|
| **Close** (~15m) | position | 1m of position error is 3.8° of apparent movement |
| **Far** (~200m) | rotation | 1m of position error is 0.26°; 1° of yaw is 3.5m |

A distant object is effectively at infinity: its screen position is set by
where the camera thinks it is *pointed*, not where it thinks it *is*. This is
the single most useful idea for reasoning about a drift report — ask the
distance first, because it decides which failure mode you're looking at.

Practical consequence for creators: **angular error scales linearly with
range.** The same tracking drift that is imperceptible at 15m throws a 200m
object across the sky. Close placements are not merely easier, they are a
different problem.

## Tracking status is the other variable

`trackingStatus` reads `LIMITED` whenever the camera is full of sky, because
SLAM has no features at usable parallax. Daylight does not help — a bright
featureless sky is exactly as featureless as a dark one. This was tested
directly and is worth remembering, because "it's dark" is the intuitive
explanation and it is wrong for sky-pointed placements.

It *does* matter once the ground is in frame. There, light level changes
whether the camera can resolve the texture it needs.

Keeping ground in the lower half of the shot is the single most effective thing
a creator can do for stability, which is why the placement pad now says so.

## Parallax before placement

**A single camera recovers depth only from translation.** Rotation gives it
nothing. Until the phone has physically moved, the engine's depth map is a
guess, and anything anchored into it is anchored into that guess.

The original code placed the object the instant the scene built — against the
weakest map of the session. Everything after was the engine correcting that
decision, which is what produced sudden jumps and visible *rescaling* at close
range. Rescaling is the diagnostic: only a change in distance resizes an
object, so a resize means the origin shifted in depth.

This was found from a user observation, not from instrumentation: stability
correlated with how much the phone had been waved around before the object
appeared. Worth remembering as a class of clue — "it works better when I do X
first" usually names the missing precondition.

Placement now waits for the camera's **bounding-box extent** to pass 0.4m.
Extent, not summed path length: early tracking is noisy, and summing
frame-to-frame movement lets jitter accumulate until a phone lying on a table
passes the gate. Simulated against the real thresholds — 13s of ±2cm jitter
reaches 0.04m and never passes; a 60cm side-step passes at 2.2s; walking 1.5m
forward passes at 1.1s; rotating in place reaches 0.02m and correctly earns
nothing. A 10s timeout places regardless so nobody is trapped.

The position is then derived from the camera's pose at that moment
(`localTargetFrom`), not from the origin as it stood at second zero.

**Why there is no scanning minigame.** One was designed — three fuzzy points
resolving as parallax accumulates, near ones first, which is physically honest.
It was not built because the simulation showed anyone who moves at all is
placed within 1–2 seconds, and that is not long enough to need filling. If the
gate is ever raised, or real use shows people standing still, it becomes worth
building. Do not add it without that evidence.

## Close range is the hardest case

The same tracking error is worth far more on screen up close:

| Player distance | A 0.3m origin shift shows as |
|---|---|
| 3 m | ~10% size change, ~6° sideways |
| 20 m | ~1.5% size change, ~0.9° sideways |

Roughly seven times more visible at 3m. Walking right up to an object is
inherently the hardest thing markerless tracking can be asked to do.

Counterintuitively, **daylight near the ground can be worse than open sky.**
Grass and pavement are self-similar: plenty of features, all alike, so
relocalisation can match the wrong ones and land the origin in the wrong place.
That yields discrete jumps rather than gradual drift. The good case is varied
structure at mixed depths, not merely "more light" or "more features".

## GPS convergence — kept, off by default, per zone

Recomputes the object's position from live GPS and eases toward it (20s time
constant, dropping to 0.4s briefly after a detected relocalisation).

Measured at ~16m, same spot, one variable changed:

| | Object spread across frames | Scale |
|---|---|---|
| `conv on` | ~235 px | visibly varying |
| `conv off` | ~45 px | consistent |

Scale consistency is the sharper signal: it is a direct readout of *distance*,
so a steady scale means nothing is pushing the object nearer or further. GPS is
accurate to 2–4m; up close that is correcting centimetre-accurate visual
tracking with metre-accurate GPS, and it loses.

**Never cleanly measured at distance.** Convergence is gated on `NORMAL`
tracking, so "convergence running" and "tracking good" are perfectly correlated
by construction and no comparison taken so far can separate them. The one far
run where it was active was also the one where tracking was healthy. Filling
that cell needs a far test with `?ar-converge=0`.

It survives as a per-zone toggle rather than a global default because that is
the honest state of the evidence: clearly harmful up close, unknown far away.

## Compass yaw correction — tried, failed, removed

**The idea.** Far-field drift is rotational, and the GPS convergence cannot
touch rotation. The compass is the one absolute yaw reference that doesn't
accumulate error, so: don't let it drive orientation (that is what made the
pre-SLAM version swim), only let it bleed off accumulated yaw drift with a 20s
time constant — the same trick already used for GPS. Rotate the object about
the world vertical only, so the upright lock can't be affected. Gate on
`webkitCompassAccuracy ≤ 25°`, cap the correction at 45°.

The implementation was correct as far as it went. The sign convention was
verified numerically in both directions before shipping.

**It failed in the field.** Tested at ~200m against open sky, the case it was
built for:

- `yaw −45.0°` — the cap. It computed *at least* 45° of "drift".
- One minute later, `yaw −7.9°`. A ~37° swing in the correction itself.
- `±10°` compass accuracy throughout, so the gate passed and it stayed engaged.
- Observed effect: the object jumped to a different part of the sky after a
  look-away. The correction was moving it.

Real SLAM yaw drift over a minute is a few degrees, not forty-five.

**Why, and why it isn't a tuning problem.** `webkitCompassHeading` is only
meaningful for a roughly level device. The whole scenario requires pointing the
phone steeply *up* at a sky object, which is precisely where that heading stops
corresponding to the camera's horizontal look direction. The code guarded
against near-vertical geometry on the SLAM side and never on the compass side —
but that guard would only have made it refuse to run, not work. The reference
signal is unreliable in exactly the regime the feature targets.

**If anyone revisits this**, the only version worth building derives true north
from the full device-orientation quaternion rather than `webkitCompassHeading`,
and then still has to survive magnetometer noise outdoors. That is real work for
a case — distant objects against open sky — that is the hardest placement in the
product and may never be worth shipping.

Removed in full rather than left dormant behind a flag. Dead code that only
runs under a query parameter is code nobody re-reads; the flyover direction bug
survived for months on exactly that basis.

## Flyover

Travels a configured distance along a compass bearing, looping.

- Direction is converted into the engine's local frame with the **session start
  heading**, not the object's facing. Getting this wrong makes the path depend
  on which way the player faced when opening the camera, and is invisible in
  casual testing — an object crossing the sky looks plausible going any
  direction. Check it against a compass, not by eye.
- The path is one-directional, so the loop point is hidden by fading out over
  the last 12% and back in over the first, rather than teleporting.
- Flyover deliberately gets **no positional correction at all** — neither GPS
  convergence nor anything else. Drift is invisible on an object that is already
  moving. Nothing in the builder explains this difference to a creator yet.
