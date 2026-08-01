# Mobile Player Edge-Seam Runbook

## Why this exists

iOS Safari can paint the visual viewport a pixel or two differently from the
layout viewport, especially after the keyboard appears or disappears. A normal
`fixed inset-0` player surface can then leave a thin strip of map visible on
the right edge. This has repeatedly affected the player sheets and chat.

Treat this as a rendering constraint, not a cosmetic spacing issue.

## The approved pattern

Full-screen player surfaces use `overlay-edge-bleed` from `index.html`.

```css
@media (max-width: 767px) {
  .overlay-edge-bleed {
    left: -16px !important;
    right: -16px !important;
  }
}
```

The overscan deliberately paints beyond both visible edges. Do not replace it
with normal `inset-0`, width calculations, gutters, or a margin around a sheet.

## Bottom sheets: required geometry

The tour-info, progression, settings, and locked-zone sheets must be rendered
inside an `overlay-edge-bleed` wrapper and use this shape:

```tsx
className="-mb-px w-full max-w-lg ... rounded-t-[40px] shadow-2xl"
```

Rules:

- Keep `-mb-px` so the sheet overlaps the browser's bottom paint boundary.
- Keep `rounded-t-[40px]`. This is the established player corner radius.
- Do **not** add `player-sheet-edge`, `clip-path`, or an outer
  `overflow-hidden` to the sheet. Those create a separate rounded compositing
  layer in iOS Safari and can expose the right-side seam.
- If a sheet needs clipped internal content (the settings submenu does), apply
  `overflow-hidden` only to an inner content container, never the outer sheet.

The locked-zone sheet is the reference implementation. It was confirmed as
visually stable before the same pattern was applied to the other sheets.

## Full-screen character chat

Chat is not a bottom sheet, so it uses a second paint shield:

```css
.chat-edge-shield {
  box-shadow: -16px 0 0 var(--chat-edge-bg), 16px 0 0 var(--chat-edge-bg);
}
```

`ChatInterface` supplies `--chat-edge-bg` from the active dark/light theme.
Keep both the `overlay-edge-bleed` and `chat-edge-shield` classes on the chat
root. The shadow is intentional: it prevents a map hairline from appearing
during Safari compositing and keyboard transitions.

## Never put `backdrop-filter` on a bled element

`backdrop-filter` samples the *backdrop root*, which is the viewport.
`overlay-edge-bleed` pushes a surface 16px past both screen edges, into a
region with no backdrop to sample. Both on one element is undefined, and iOS
Safari resolves it by leaving the overhang unpainted until the compositing
layer is warm.

The signature is distinctive and worth recognising: the seam appears **only on
the first open of a session** and never again, and the strip shows the map
*sharp and undimmed* rather than merely uncovered. A seam that survives
repeated opens is a geometry problem; a seam that heals itself is this.

Keep the bleed on the flat tint, and give the blur its own layer at a plain
`inset-0`:

```tsx
<div className="overlay-edge-bleed fixed inset-0 bg-black/60 flex items-end justify-center">
  <SheetBlur />          {/* fixed inset-0 backdrop-blur-sm pointer-events-none */}
  <div className="-mb-px w-full max-w-lg rounded-t-[40px] …">…</div>
</div>
```

`SheetBlur` in `pages/Player.tsx` is the shared implementation.
`pointer-events-none` matters — the wrapper carries tap-to-dismiss.

## Edge-anchored chrome: split the backdrop off

A surface whose children are pinned to the edges (the AR camera view: a title
chip and close button in a `px-4` top bar) cannot simply take
`overlay-edge-bleed` on its root. The bleed widens the element by 16px a side,
so `px-4` starts measuring from 16px off-screen and the chrome slides out past
the bezel.

Use two fixed siblings instead: a bled backdrop that carries the colour, and a
plain `inset-0` content layer above it.

```tsx
<div className="fixed inset-0 z-[5000] overlay-edge-bleed bg-black" aria-hidden="true" />
<div className="fixed inset-0 z-[5000] text-white overflow-hidden">…</div>
```

Both must be `position: fixed` — the class requires it, and an absolute child
would be clipped by the content layer's own `overflow-hidden` anyway.
`ARCameraOverlay.tsx` is the reference implementation.

## What broke this before

1. Applying `clip-path` through `player-sheet-edge` to oversized sheets.
2. Applying `overflow-hidden` to an outer rounded sheet.
3. Replacing edge overscan with visible page gutters or margins.
4. Treating the seam as a border-color issue instead of a viewport paint issue.
5. Shipping a new full-screen `fixed inset-0` surface without any edge
   treatment at all. The AR camera view went out this way and reintroduced the
   right-edge sliver; the checklist below only covers surfaces that already
   exist, so a genuinely new one has to be added to it deliberately.
6. Combining `backdrop-filter` with `overlay-edge-bleed` on one element (see
   above). Worth calling out separately because **auditing this file's rules
   does not catch it** — the geometry is correct and every rule passes. Reading
   the markup for a `backdrop-blur` class on a bled element is what catches it.

## Checking for a regression

Grep, don't just read. Both of these should return nothing:

```bash
grep -rn "overlay-edge-bleed" --include="*.tsx" pages/ components/ | grep backdrop-blur
grep -rn "player-sheet-edge\|clip-path" --include="*.tsx" pages/ components/
```

Then confirm the rules still exist at all, since a passing grep for forbidden
patterns says nothing about whether the required ones survived:

```bash
grep -A6 "\.overlay-edge-bleed {" index.html | grep -E "left|right"
```

## Before changing player surface CSS

1. Test in mobile Safari with the browser chrome visible.
2. Open and dismiss the keyboard in character chat and a passphrase lock.
3. Test tour info, Progress, Player menu, and the AR camera view.
4. Confirm no map is visible at either edge and sheet corners remain `40px`.
5. Test the locked zone separately: its amber border must follow its rounded
   top edge without side borders or slivers.

If a new player overlay is added, start with the approved wrapper and bottom
sheet structure above. Do not invent a new edge treatment.
