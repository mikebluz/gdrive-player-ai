# Per-iteration sequences in the Passes grid — design

Status: **agreed, not built.** Branch `bloom-part-iterations`. Build in the order
below; 1 lands before 2 because 2 makes people tap in that grid far more.

The Passes grid (`_ambRenderPassMatrix`) is rows × passes: chord rows, a column
per iteration of the part, and a `plays` caption spelling each column's sequence.
This adds SEQUENCE rows to it, so a layer can play a different banked phrase on
each pass, and fixes an ordering bug that the extra tapping would expose.

---

## 1. Toggling a chord must not silently reorder it

`seq[col]` is an ORDERED list, so membership and position are the same stored
thing. Toggling a chord off removes it and everything after renumbers; toggling
it back on **appends at the end**:

```
Cmaj7¹ Am7² Dm7³ G7⁴
tap Cmaj7   →  Am7¹ Dm7² G7³
tap Cmaj7   →  Am7¹ Dm7² G7³ Cmaj7⁴     ← moved first to last, silently
```

**Fix:** re-enabling inserts at **row-order position**, not at the end. Row order
is the written chord order — the default sequence for every pass — so a chord
that was never hand-reordered returns exactly where it was, and a tap can never
change anyone else's relative order. A few lines in `_ambPassWrite`'s toggle path.

Explicit reordering stays a deliberate act in the `plays` caption editor
(`_ambPassSeqModal`, drag chips), which is the only thing that can produce an
order differing from row order.

**Known limit, accepted:** if a pass HAS been hand-reordered
(`G7·Cmaj7·Am7·Dm7`) and you toggle G7 off and on, it returns to row-order
position rather than where you dragged it. Fully preserving that needs the
removed position remembered per cell. Start without it; add only if hand-ordered
passes turn out to get clobbered in practice.

## 2. Sequence rows — REVERSED 2026-08-21: NOT in the Passes grid

Built as layer rows inside the Passes grid, then reverted the same day. The grid
holds the CHORD SCHEDULE, which is the shared harmonic clock and **cannot** be
per-layer — per layer it would put the bass on chord 2 while the pads are on
chord 3, the same constraint that keeps length salt an area axis. Sequence choice
IS per-layer. So the grid ended up showing two scopes with nothing marking the
seam, and every layer that gained a row made it worse.

**Per-iteration mapping belongs on the LAYER**, next to the Sequences row and the
existing Plays rows, as a small grid per part: iterations across, tap a cell to
rotate through the bank. Storage stays on the layer and becomes explicitly
per-iteration:

```js
L.partSeqs = { "<partIdx>": { "<iteration>": "<seqName>" } }
```

One shape, not two: the list form that cycled (`["riffA","riffB"]`) becomes
consecutive iterations filled in, so "alternate two riffs" and "riffC only on
pass 3" are the same mechanism. Many-to-many still holds — the same name may
appear in as many cells and as many parts as you like. The iteration COUNT comes
from the part's own `grid.cols` so the layer and the arrangement cannot disagree
about how many passes there are.

Colours (section 3) still apply, on the layer's chips rather than in the grid.

### The original in-grid design, for the record

## 2b. (superseded) Sequence rows

One row per layer that has banked sequences (layers without any add a dead row —
don't render them).

```
                 1              2              3
  Cmaj7       [ 1 ]          [ 3 ]          [   ]     tap = in/out
  Am7         [ 2 ]          [ 1 ]          [ 1 ]     order via `plays`
  ──────────────────────────────────────────────
  Motif       [ riffA ]      [ riffB ]      [  —  ]   tap = ROTATE
  Bass        [  —   ]       [ walk1 ]      [ walk1 ]
  ──────────────────────────────────────────────
  plays    Cmaj7·Am7·Dm7·G7  Am7·Dm7·Cmaj7  Am7·Dm7·G7
```

A sequence cell is SINGLE-VALUED — one layer, one pass, one sequence — so rotate
is safe where it would be wrong on a chord cell. The cycle is
**— (the layer's own phrase) → each banked sequence → back to —**, so repeated
taps walk the options and return to none. No modal, no drag.

**Storage lives in the ARRANGEMENT**, not on the layer:
`parts[i].grid.seqs = { "<layerKey>": { "<col>": "<seqName>" } }`. That way the
column count, part tabs, playhead and pass windowing all come free and there is
exactly ONE notion of "iteration" — the reason not to give the layer its own.

## 3. Colour-coded sequences

Each sequence gets its own colour, used on its chips everywhere it appears (the
Passes grid, the layer's Sequences row, the Plays chips).

**Derived from the NAME, never stored** — a stored colour or a bank index breaks
the moment the bank is reordered or an entry renamed, and two projects sharing a
sequence name should agree on its colour.

Constraints, the same ones the layer-type palette was measured against:

- the **green band (hue 95-165) is reserved** — green means "sounding";
- clear the state colours by a wide margin: `#48bb78` sounding, `#f6ad55`
  inert/warning, `#fc8181` delete;
- stay legible on the panel ground (`#0d0d18`) — L\* high enough for AA;
- don't collide with `#d94dff`, the stochastic marker.

So: hash the name → hue, excluding the reserved arcs, with fixed saturation and
lightness so every sequence colour is equally weighted and none reads as a state.
Verify the same way the type palette was: compute CIELab distances rather than
eyeballing swatches.

---

## Not in scope here

The **part-boundary bleed** is parked (see the memory of the same name): material
overlaps at a part change because the swap runs at tick time against the ~1.4 s
lookahead — 16 of 49 notes wrong at the seam. Per-iteration mapping makes every
iteration change a swap, so it will fire more often. Reported as very
intermittent by ear, hence parked, but it is the thing to fix after this.
