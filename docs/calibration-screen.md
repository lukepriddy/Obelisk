# The calibration screen

What happens between tapping Begin and seeing the map.

## Why it exists

Four jobs, one moment:

1. **Let the GPS fix converge before the map is revealed.** Today the map
   appears immediately and the dot lurches around for several seconds while
   accuracy improves. That reads as broken software; it's physics.
2. **Cover the audio warm-up**, which already happens inside the Begin gesture.
3. **Verify the player can actually hear anything**, which no API can answer —
   on iOS neither the silent switch nor system volume is visible to the page.
4. **Say the safety piece at the moment of commitment** rather than as
   scrollable background text on the welcome screen, which also gives the
   welcome screen its space back.

## What is already true (do not rebuild)

Established by reading the code, not assumed:

- **GPS starts on mount**, not on Begin — tiered acquisition (coarse fix, then
  high-accuracy, then a continuous watch) runs from page load. So anyone who
  reads the description already has a settled fix, and calibration will be
  near-instant for them. Only someone who taps straight through waits.
- **`startAudio()` already primes every zone inside the Begin gesture**, kicks
  the audio engine without awaiting it, and starts a background prefetch that
  reports `{done, total}` via `prefetchStatus`.
- **`gpsFixRef.current.accuracy`** is live and already drives the existing zone
  gate.

## The load-bearing constraint

**The audio start path must not be restructured.** iOS only grants audio
permission inside a user gesture, and `startAudio()` currently runs inside the
Begin tap for exactly that reason. Anything that defers it — a promise chain, a
state transition, an await — silently loses the grant, and the failure looks
like "works perfectly on desktop, no audio on a real phone."

So calibration is **a layer over the top, not a step in front**. `audioStarted`
still flips inside the tap; the calibration overlay simply covers the map until
it lifts. The gesture chain is untouched.

The tone plays from the same gesture for the same reason.

## Sequence

1. **Begin tapped.** `startAudio()` runs, unchanged. The tone plays. Calibration
   state opens.
2. **Overlay covers the map.** Rings animate, driven by live accuracy.
3. **Ready when** the floor has elapsed **and** accuracy is good enough.
4. **On first run only**, the reveal waits for an explicit "I heard it" tap —
   which doubles as the audio test and a deliberate start. Remembered per
   device; every run after auto-proceeds.
5. **Too far from the start** → the overlay stays and offers directions rather
   than revealing a map where nothing will ever trigger.

## Thresholds, and why

| | Value | Reason |
|---|---|---|
| Floor | 4 s | The tone is audible for ~3.5 s. Revealing mid-tone is jarring, and a floor shorter than the sound makes the sound feel like an accident. |
| Good accuracy | ≤ 25 m | Tight enough that the dot won't visibly jump on reveal. The zone-trigger gate is 100 m, which is far too loose to look settled. |
| Ceiling | 15 s | Under tree cover a fix may never reach 25 m. Stranding someone at the trailhead of the thing they drove to is worse than a slightly loose dot. Past the ceiling, reveal anyway. |
| Distance gate | `furthestMeters` + 400 m, min 1600 m | Relative to the tour's own footprint, so it scales from a single-zone installation to a long walk. A fixed mile is meaningless against a two-mile route. |

**Prefetch does not block.** Downloading every zone's audio can take minutes on
cellular; it's shown as information, never as a gate. Priming — the part that
matters for playback working at all — already happened in the gesture.

## The animation

Concentric rings contracting toward a point.

This is deliberately **not** a loading bar with a costume. The radius is driven
by live GPS accuracy, so it is a picture of the actual thing being waited on: it
moves when reality moves, and stalls when reality stalls. People can feel the
difference between that and a spinner, even if they never work out why.

Ripples travel outward while searching — the same gesture as the bowl's
resonance, tying sound and image together — and the accuracy ring draws inward
as the fix tightens. On ready, ripples stop and the ring settles onto the dot.

Accent colour and background come from the creator's theme, like everything
else in the player.

Radius maps **logarithmically** from accuracy, because accuracy spans roughly
1000 m to 5 m and a linear map would sit pinned at the outer edge for almost the
whole wait, then snap.

## Failure behaviour

- **No fix at all** → ceiling applies; reveal with the existing GPS error and
  retry affordances intact. Calibration must never become a second place a
  player can get stuck.
- **Location denied** → do not hold them at calibration. The welcome screen
  already handles this case.
- **Too far** → soft gate, with directions and an explicit way through. Someone
  1.1 miles out may be walking toward the start right now; bouncing them
  punishes exactly the person doing the right thing.
- **Tone fails to play** → nothing depends on it. It is a test, not a gate.
