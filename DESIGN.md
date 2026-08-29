---
version: 1
name: learning-tracker-instrument
description: >
  A dark instrument for a single engineer's workbench. Near-black warm neutrals, hairlines
  instead of cards, one ochre accent that means "now" and nothing else. Sans carries prose,
  mono carries data - codes, hours, counters, timers, SQL. Density is high but never packed;
  the surface recedes so the work reads. Brand lives in precision: themed scrollbars, tabular
  numerals, an authored icon set at one weight, a focus ring that belongs to the palette.
mode: operate
---

## Ground

The room is dark and there is a terminal on one side and an editor on the other. The tool
sits between them and must not shout. Light mode is not built: the scene decides, and this
scene is dark. *(If the use scene changes, that is a real decision, not a toggle.)*

## Color

Warm near-black, never blue-black, never pure `#000`. One accent.

```
--ground      #0b0b0c   the page
--surface     #121214   panels, rail, drawer
--surface-2   #17171a   inputs, insets, hover
--line        #232327   hairline: the primary structural device
--line-2      #34343a   emphasis hairline, focus-adjacent

--fg          #eae8e4   primary text
--fg-2        #a5a29c   secondary, meta
--fg-3        #6f6d68   labels, disabled

--accent      #e2a13c   NOW: current work, selection, primary action, progress fill
--accent-ink  #1b1305   text on an accent fill
--accent-line #5a4520   accent hairline
--accent-wash rgba(226,161,60,.10)

--alert       #d8714c   destructive hover, the 90-minute breach. Nothing else.
```

Rules:

1. **Ochre means now.** Current concept, selected track, running timer, primary button,
   progress fill, focus ring. If something is not "now" or "act here", it is not ochre.
2. **Status is shape, not a rainbow.** `not started` is a hairline ring, `building` is a
   filled dot, `walled` is a ring with a bar through it, `closed` is a check and dimmed
   text. Only `building` and `walled` carry accent; closed is neutral.
3. `--alert` is destructive-and-warning only. It never decorates.
4. No gradients, no glows, no glass. Depth comes from one elevation step plus hairlines.

## Type

One sans for prose and controls, one mono for data. Mono is here for codes, hours,
counters, timers and SQL - measurement, not costume.

```
--sans  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
--mono  ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace
```

Fixed rem scale, ratio ~1.15. No fluid clamps: the user views at one DPI.

```
11px  mono labels, tracking +.04em, uppercase only in the rail's section heads
12px  meta, sub-lines
13px  body and controls  (base)
15px  concept names, panel titles
18px  the current-concept line
30px  the timer numerals, tabular
```

Prose measure caps at 68ch. Data may run wider. All numerals tabular
(`font-variant-numeric: tabular-nums`) so counters do not jitter.

## Form

- **Hairlines over cards.** A panel is a hairline box on `--surface`. Nested cards are
  banned; a concept opens *inside* its row, it does not spawn a card in a card.
- **Radius is a rule, not a feeling:** `4px` controls and inputs, `8px` panels, full round
  only for status dots and the drawer's badge.
- **Elevation exists twice:** the drawer and the toast. Both carry offset and blur, tinted
  to the ground, never a zero-offset halo.
- **Spacing scale** 4 / 8 / 12 / 16 / 24 / 32. More space above a heading than below it.

## Icons

Authored inline SVG, 16px grid, 1.5px stroke, round caps, `currentColor`. One family, one
weight. No emoji, no unicode glyphs standing in for icons.

## Motion

150-200ms, `cubic-bezier(.2,.7,.3,1)`. Motion reports state: a row opening, the drawer
arriving, the timer ring draining, a toast landing. Nothing loops, nothing enters on load.
Everything collapses under `prefers-reduced-motion`.

## Browser surfaces

Themed, because they are part of the design: selection, caret, scrollbars, focus ring
(2px `--accent` at 2px offset), underline offset, tabular numerals, and `color-scheme: dark`
so form controls inherit the world.

## Copy

The product's own voice, taken from `spec.md`: plain, imperative, slightly blunt. Controls
name their action. No em-dashes anywhere in visible copy - a hyphen or a second sentence.
No eyebrows above headings. Empty states teach the rule they are enforcing.
