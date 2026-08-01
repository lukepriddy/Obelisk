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

## Before changing player surface CSS

1. Test in mobile Safari with the browser chrome visible.
2. Open and dismiss the keyboard in character chat and a passphrase lock.
3. Test tour info, Progress, Player menu, and the AR camera view.
4. Confirm no map is visible at either edge and sheet corners remain `40px`.
5. Test the locked zone separately: its amber border must follow its rounded
   top edge without side borders or slivers.

If a new player overlay is added, start with the approved wrapper and bottom
sheet structure above. Do not invent a new edge treatment.
