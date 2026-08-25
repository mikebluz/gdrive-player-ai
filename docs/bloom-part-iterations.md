# Per-iteration sequences in the Passes grid — design

Status: **BUILT** (schema v9 (⚠️ v10 today — rubato split out of salt)). Branch `bloom-part-iterations` (merged to `main` 2026-08-24). Section 1 shipped
earlier; section 2's per-layer grid, its four cascade rules and the migration off
the cycling list all landed together. Gates: golden 82/82, arch-parity 48/48 (the suite has since grown to **62** configs),
invariant harness ✓, mod-parity 9/9 — all byte-identical, by construction (the
feature adds no RNG draw and the clock is untouched; see "the grid stays out of
the clock" below).

Its OWN gate is **`npm run test:partseq`** (`test/partseq.js`, 64 assertions when this was written — **231** today).
None of the other four can see this feature: golden covers the Rust core, the
harness covers note generation, arch-parity covers the chord clock — which this
deliberately does not touch — so a break here moves none of them. Deliberately
ASSERTION-based rather than baseline-based: the cascade rules are decisions with
right answers, and a baseline would happily record the wrong one.

The Passes grid (`_ambRenderPassMatrix`) is rows × passes: chord rows, a column
per iteration of the part, and a `plays` caption spelling each column's sequence.
This adds SEQUENCE rows to it, so a layer can play a different banked phrase on
each pass, and fixes an ordering bug that the extra tapping would expose.

---

## 0. What to call the parts of the compose strip

One vocabulary, so a bug report and the code mean the same thing. Class names in
brackets — those are for grepping, not for talking.

```
COMPOSE STRIP                                    [.ambient-seedgrid-chords]
├─ HEADLINE      part ▾ · sequence ▾ · pass ▾ · 4 chords · 4 bars
│                                                [.ambient-sgruler-lbl]
├─ CHORD BLOCK ── one CHORD of the pass ────────  [.sgbar-block]
│  ├─ CHORD HEADER  its name, length, ⧉ copy      [.sgruler-row]
│  │   ├─ CHORD CELL   "Am7  ½ bar"; tap to scope [.ambient-sgbar]
│  │   └─ ⧉ COPY       take another chord's steps [.sgbar-copy]
│  └─ STEP ROW      that chord's steps            [.lane-chips.sglane-row]
│      ├─ BAR NUMBER   1, or "½" on a short row   [i.sgbar-n]
│      └─ STEP        one chip: note, chord, rest [.seq-step.sgstep]
└─ … one CHORD BLOCK per chord of the pass
```

**STEP ROW** is the row of chips in the picture. **CHORD HEADER** is the strip
directly above it. A **CHORD BLOCK** is a chord's header plus its rows.

Two distinctions that are easy to lose and matter:

- A chord block is a **CHORD**, so with a cadence its rows say how long it is:
  **row length is the chord's length, and a step is the same width everywhere**
  (a row covering `f` of a bar is `f` of the strip wide and holds `f × 32`
  cells, so the cell size is 1/32 of a bar either way). A chord longer than a
  bar wraps into whole-bar rows — never horizontal scroll, per UI rule 1 — and
  a chord shorter than one gets a short row holding only ITS steps, so editing
  it cannot reach the chord beside it.
- A chord the phrase does not reach is **EMPTY, never a copy**. The phrase is
  padded with rests to cover the pass when a session opens (and when the part or
  pass changes), so every chord has real, editable steps of its own. Copying one
  chord's steps onto another is an explicit act — **⧉** on the chord header.
- A step row is a **MIRROR**. The real lane is parked off-screen
  (`.lane-row.sg-mirrored`) and still owns every handler; the strip clones its
  chips and forwards gestures onto them. So "the steps" are one set of objects
  shown in one or more places — which is exactly why a **REPEAT ROW** (a bar
  the phrase does not reach, drawn dimmed with `↻`) shows the same chips, and
  why its clones must not wear their selection.

Elsewhere in this doc and in the app: a **PART** is a named set of changes, a
**PASS** is one time through it, and a **PHRASE** (or *sequence*, when banked)
is the material a layer plays.

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
L.partSeqs = { "<partIdx>": { all: "…", "<pass>:*": "…", "<pass>:<chord>": "…" } }
```

Built as a MATRIX on the LAYER CARD — chords down, passes across.
**Not in the compose dock as well.** The bank and the part map used to live
there and were moved onto the card so they would be reachable without an open
session; the dock copies were never removed, so opening ✎ Grid drew Sequences
twice and the whole matrix twice, one above the other (reported as "matrix
showing twice"). `_ambGridSeqBank` and `_ambGridPartMap` are deleted and the
card is the single home. See "The axes" below for why the cell is a chord and not a pass;
the shape above is what that section arrives at. Measured at 390px: 30px rows,
zero overflow, no page scroll.

One mechanism, not several: the same name may sit in as many cells and as many
parts as you like, and the pass COUNT comes from the part's own `grid.cols` so
the layer and the arrangement cannot disagree about how many passes there are.

Colours (section 3) still apply, on the layer's chips rather than in the grid.

### When the Passes grid changes under it

The per-layer grid takes its column count from the part's `grid.cols`, so editing
the Passes grid can invalidate a mapping. Four cases, decided:

**Pass count grows** — new columns start empty ("own phrase"). Nothing to do.

**Pass count shrinks** — the cells past the new count are KEPT, stored but not
shown, and come back if the count is raised again. A ± stepper is easy to hit by
accident and there is no undo here; silent data loss from a stepper is the worse
failure mode, and stale keys cost only bytes. This means normalize must NOT clamp
`partSeqs` columns to `cols`, which is the opposite of what it does for
`grid.seq`/`grid.bars` — deliberate, and the reason is this paragraph.
(Explicitly NOT a versions/permutations feature: one mapping per part, the extra
columns are just remembered.)

**A pass becomes empty** (every chord toggled off) — the mapping stays and the
cell is marked inert with the reason, "this pass plays no chords". Not cleared:
the pass still runs, and the user may be mid-edit.

**A part is deleted or reordered** — `partSeqs` is keyed by part INDEX, so this
silently repoints mappings at the wrong part unless it is re-indexed.
`_ambProgDeletePart` already does exactly this for four other stores
(`prog.chain`, `arrGrid.seq`, `sections[i].part`, every layer's `chordMask`);
`partSeqs` has to join that list. Not optional.

All four verified end to end against the pass-header strip: 4 columns at
`cols:4`, 2 shown and **4 still stored** at `cols:2`, all 4 back when it is
raised; grown columns empty; an emptied pass renders inert with its mapping
intact; deleting the Verse moves the Chorus's cells from part key `1` to `0`, so
it keeps playing *its own* material rather than inheriting the Verse's.

### ONE set of changes is not a reason to hide it

The grid draws for **any** progression with chords — one part, or none. A
progression still has PASSES either way, and mapping a phrase to a pass is the
entire point; requiring two parts is the old part→sequence rule, which needed
them to say anything at all.

It shipped with that gate inherited, which made the whole feature invisible in
the ordinary project — `_ambRepairParts` collapses a single part covering the
whole cycle, so "no parts" is the COMMON case, and what rendered instead was the
old excuse: *"This progression has one part. Split it (⇶ Arch → ＋ Part)."*
Reported, correctly, as "there is no matrix or mechanism for mapping sequences to
parts". The same assumption was in three more places — the compose dock, the Grid
lane's part ribbon, and `_ambPartPassAt`, which answered −1 for an unparted
progression and so disabled the resolver outright.

`_ambPartSeqRows(cfg)` is now the single answer to "which sets of changes does
this offer": the parts when there are any, otherwise one, labelled **The
changes**. NOT `prog.name` — an unnamed progression is auto-named from its roman
numerals (`Imaj7 — vi7 — …`), which ellipses to nothing and names nothing;
reported as *"what is 'Changes'?"*. Only a progression with no chords has
nothing to draw.

The **Grid-lane part ribbon** samples through `_ambPartPassAt` now — the same
resolver the matrix keys on — and reports `Verse · 2`, the part AND the pass.
With one set of changes a bare part name repeats forever and says nothing; the
pass is what tells you which column of the matrix is live over this stretch of
the phrase you are composing.

### The axes: a CHORD, in a part, on a pass

The cell is **one chord on one pass**. Rows are the part's chords, columns are
each time through them — deliberately the same rows and columns as the ▦ Passes
grid, and drawn with its markup, because the two are read against each other.

That grid cannot hold this itself: it is the CHORD SCHEDULE, the shared harmonic
clock, and per layer it would put the bass on chord 2 while the pads are on
chord 3 (§2). Sequence choice IS per layer. Same picture, different scope.

It took three wrong shapes to get here, all mine: layer-rows inside the Passes
grid (reverted), then one row per part with passes across, then the same with a
part default. Each was reported as not being the thing. The ask was consistent
throughout — *"map A SEQUENCE to A CHORD IN A PART"*, and *"across part
iterations"* — i.e. both axes, which is the Passes grid's own shape.

**Four levels, narrowest first:**

```
'<pass>:<chord>'  →  '<pass>:*'  →  'all'  →  the layer's own phrase *(⚠️ now silence — see the superseded note below)*
```

Stored flat under the part, so every key is independently addressable and
pruning an empty part is one length check. The wider levels are not a separate
control — they are the matrix's own HEADERS, which is how the chord matrix
already works (its row label and column header are handles): the **corner** is
the part default, a **column header** is that whole pass. A cell showing `—`
while a header quietly supplies something else would be the picture
contradicting the audio, so a blank cell displays what it inherits (`↳ motif1`).

Why the wider levels exist at all: with only chord×pass, giving a part its own
material means filling `chords × passes` cells and refilling them whenever
either count changes. The tell was in the migration — the legacy one-per-part
shape WAS a part default, and the first version converted it by writing N
identical cells. **A primitive that has to be flattened into repetition is a
level you failed to model.** A bare string now migrates to `all`; a cycling list
migrates to `'<pass>:*'` per entry, which is exactly what it meant.

**`'all' | 0` is `0`**, so any numeric coercion on this path files the part
default as a pass. Keys are strings end to end — built by `_ambPartSeqCellKey`,
read verbatim, never coerced — and the gate pins it (`levels/`all` is not a
pass`).

Resolution runs on the CHORD clock (`_ambPartChordAt`), so a mapping moves with
the changes rather than only at a pass boundary. The chord index is WITHIN the
part, the same index the Passes grid's rows use, so the two line up by
construction rather than by matching offsets.

### Setting a cell: a picker, not tap-to-rotate

Cells were rotate-on-tap (— → each banked phrase → back to —). That is fine for a
bank of two and unusable at fifteen: setting a cell to the last entry is fifteen
taps, with no way to SEE the options before committing to them. One tap now opens
a list; one more chooses.

ALWAYS the picker — not rotate-plus-long-press. That would be two gestures for
one job, and the long press is the undiscoverable one.

The menu names the SCOPE it is editing, because "—" means something different at
each level and the cells alone cannot say which one you tapped:

```
Cmaj7 — pass 2                Verse — the whole of pass 2      Verse — every chord, every pass
────────────────────          ───────────────────────────      ──────────────────────────────
✓ — follow the part           ✓ — let each chord decide        — this layer's own phrase
    default, "motif1"           motif3                         motif3
  motif3                        motif1                       ✓ motif1
  motif1
```

`showCtxMenu`'s 4th argument is OPTIONS, not a title — its only header is the
multi-step one — so the scope rides as an inert first item above an `hr`.

### A deactivated chord shortens the pass — and the loop has to know

Turning a chord off in the ▦ Passes grid makes that pass genuinely SHORTER (the
skip semantics, §2.1 of the matrix spec). So the WRITTEN chord list stops being
the thing the harmony repeats on: 4 written bars against a 7-bar played cycle
realign only every 28.

Everything that snaps to "a whole progression cycle" was still using the written
number — Write/Evolve phrase length, the ✎ Grid harvest window, a hummed or
performed take's loop — so each of them looped identical material over harmony
that had moved. Reported as *"jankiness at the part boundary where a chord is
deactivated in the part matrix"*, which is exactly where the two lengths diverge.

`_ambProgCycleBars` now returns the played super-cycle **when a grid is on**.
GATED, because without one the written list IS the cycle, and with parts/repeats
the played length is a whole MULTIPLE of it so a loop still lines up — which is
why making this part-aware was declined before. Skips are the case that genuinely
breaks the assumption.

**The chord clock was never wrong.** Measured before changing anything: the
spans tile the timeline exactly (1 bar each, zero gaps), `_ambProgInstanceAt` is
monotonic, and the walk is `0 1 2 3 | 0 2 3` as drawn. The bug was entirely in
what LENGTH the loops snapped to. Both are pinned now.

### Composing for a part

The compose bar carries a **composing for** chooser, and the chord ribbon under
the strip draws THAT part's chords — derived from its played order
(`_ambPartGridSeq`), not sampled from the live clock. Sampling meant the ribbon
showed whatever happened to be sounding while you typed, so a phrase written for
the Chorus was read against the Verse; stopped, it showed an arbitrary moment.

It shares `_ambPsqPart` with the Plays matrix's part tab — the same question
asked in two places, so choosing in one moves the other.

### Sequences vs Plays — two rows that both install a phrase

They sit one above the other and mean different things, which was not stated
anywhere and read as nonsense:

- **Sequences** is the bank. Tapping a chip ADOPTS that phrase as the layer's
  **own** — persisted to `lockState`, and therefore what the layer plays wherever
  the Plays row is blank.
- **Plays** is the schedule. A cell replaces the own phrase **for that pass
  only**, at runtime.

So Sequences decides the floor and Plays decides the exceptions. Both row and
chip tooltips now say that, and the adoption toast names the consequence — *"…is
now this layer's own phrase — it plays on every pass the Plays row leaves
blank"* — because on a layer with a mapping, "X is now this layer's phrase" is
true and still surprising: the schedule takes the next pass straight back.

**The bug underneath the confusion, introduced by the runtime-only guard above:**
the Sequences chip calls `_ambPersistLock`, and `_ambSyncLockState` refuses to
write while the live freeze carries `_partSeqName`. So adopting a phrase with any
mapping installed silently recorded NOTHING — measured, `lockState` stayed empty
while the toast said it had worked, and the adopted phrase could never come back
on a blank pass. Adoption now releases the mapping first, in both chip handlers.

The gate reproduced the handler's steps rather than clicking the chip, which is
exactly the gap that let this through; the fix is verified by a real pointer
click as well (`_partSeqName` cleared, `lockState` written, toast correct).

### Which pass is this? — and how it ties to the arrangement

The cell index is the part's **cumulative visit count**, which is exactly the
number `_ambGridSlots` calls `visit` and the Passes grid draws as a column. The
column COUNT is the part's own `_ambPartPassCols` (its `grid.cols`; ⚠️ the default is NOT 8 — `_ambPartPassCols` falls back to `_ambPartNaturalPasses`: chain visit count → `plays` → **1**. `_AMB_GRID_COLS` was deleted, its tombstone explaining that 8 "as a COUNT was simply wrong"), so the layer and the arrangement cannot
disagree about how many passes there are, or about which one is playing.

`_ambPartPassAt` walks the played chain once to give every run its visit index
within a cycle plus each part's visits-per-cycle, then takes the cycle from
`_ambProgInstanceAt`. It must be the INSTANCE ordinal, not the step: a chain that
revisits a part makes `step` repeat inside one pass, which is the pre-existing
non-monotonicity `_ambProgInstanceAt` was added to answer.

This also fixes a latent bug in the list version, which indexed on
`floor(step / chords.length)` — the whole-progression cycle. Under a chain like
`[Verse, Chorus, Verse]` both Verse visits landed on the same index and played
the same phrase. Measured now: `Verse#0 Chorus#0 Verse#1 | Verse#2 Chorus#1
Verse#3`.

### The grid stays out of the clock  ⚠️ NO LONGER TRUE — a width-only grid now ENGAGES it

Raising a part's pass count writes a **width-only** grid (`{cols: n, seq: {}}`).
`_ambGridOn` still requires `seq`/`fit`/`bars`, so this changes nothing about
which chords play or when — verified `gridOn === false` after the migration, and
arch-parity is unmoved across all 48 configs (62 today). That is what makes the migration
below safe to apply automatically.

### Migrating off the cycling list (v9)

The shape conversion alone would have silently dropped the alternation: a part
with no Passes grid declares one pass, so every iteration past 0 would be
stored-but-not-shown and never played — the shrink rule applied to a project
nobody shrank. So the migration RAISES the part's pass count to fit and fills the
cells cyclically across it. **LCM across the layers on that part**, so two layers
alternating 2 and 3 phrases both come out exact rather than one being rounded —
measured, a 2-phrase bed and a 3-phrase motif on one Verse produce `cols: 6` with
`riffA riffB riffA riffB riffA riffB` and `x y z x y z`.

A **bare string** (the original one-per-part shape) meant "plays under this part",
i.e. on every pass — so it expands to fill every cell, not just pass 1. Missing
that was the one real bug this work introduced and it was caught by the migration
test, not by reading the code.

### A blank cell plays the layer's OWN phrase  
> ⚠️ **SUPERSEDED — a blank cell is now SILENCE for a phrase-driven layer**, not the own phrase: `_ambPartSeqSync` installs an empty frozen loop via `_ambPartSeqSilence` because "an unmapped pass is a deliberate rest". The own phrase is left alone only when the layer stops being phrase-driven at all (`_ambPhraseDriven`). `_ambPartSeqRestoreOwn` still exists but is DEAD CODE — nothing calls it.

Absent is neutral, and neutral is the layer's own material — so a blank cell (or
a part with no cells at all, which prunes to the same thing) hands the layer back
what it had. That closes the rotate cycle the design asked for: **— → each banked
phrase → back to —**.

The mechanism is one guard, not a snapshot. **A mapped phrase is RUNTIME ONLY: it
is never written to `lockState`.** `_ambSyncLockState` returns early when the live
freeze carries `_partSeqName`, so the layer's own phrase stays sitting in
`lockState` untouched and `_ambPartSeqRestoreOwn` simply reinstates it — nothing
extra to persist, nothing to keep in sync, and a reload comes back to the layer's
own material with the mapping re-installing on the next tick.

A layer with no phrase of its own was GENERATING; there the blank cell drops the
freeze and lets the emitter run again. A `kind: 'unit'` lock lives in `E.unit`,
which the install never touched, so the same branch covers it.

Snapshotting was the obvious design and is the wrong one: an underscore field is
serialised by `persistWorkspace`, and an engine WeakMap dies on reload — leaving
"own phrase" quietly meaning "the last mapping that happened to load".

**The ordering bug this shipped with, caught by the gate and not by reading the
code:** `_ambStepsToLock` PERSISTS the lock as part of installing it, so setting
`_partSeqName` afterwards left the guard looking at an unmarked freeze and the
mapped phrase went straight over `lockState` anyway. The flag is set *before* the
install now.

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

## 4. Hangs — intros and outros as pseudo-parts  (shipped 2026-08-24)

A **hang** is extra time tacked onto a part play: a `head` leads INTO the part (an intro),
a `tail` follows it. It is not a gate over the layers' normal material — it is a
**pseudo-part that generates its own notes**, per selected layer.

**Storage.** `parts[i].head` / `parts[i].tail` =
`{ bars, layers[], once?, gen?, rolls?, phrases? }` — `bars` 0.125–1, `layers` is who plays
(EMPTY is meaningful: a rest), `once:1` makes it fire only at the edges of a consecutive
run of that part rather than every play, `gen = {grid, dens, spread}` shapes generation,
`rolls[key]` pins the seed, and `phrases[key]` is an EDITED phrase that outranks generation.
Normalized in `_ambNormalizeHang`; empty arrays are kept.

**The clock — four paths, all of which must weave hangs.** `_ambProgStepAt` reaches the
arrangement four ways: the arch chain (`_ambArchChainSlots`), the legacy parts expansion,
the section-bound early return, and the grid plan (`_ambGridPlan`). `_ambChainWithHangs`
does the weave for the first and fourth; the other two weave inline. A hang slot SHARES its
neighbour chord's instance ordinal, so the chord-choke holds through it — which is also why
`_ambPassSpanAt` must TRIM hang windows off both edges of a pass span before anything fits
or anchors a phrase against it.

**`once` coalesces on part identity only** (`rkey = [pi, part]` over consecutive slots).
The two paths spell repetition differently — the chain counts plays in `rep`, the grid mints
a new `visit` per play — so any finer key works on one and is inert on the other.

**Generation.** `_ambHangNotes` IS the phrase: view, audition and emit all read it, so they
cannot drift. Default is grid-quantized — onsets on the `gen.grid` lattice (1/16 or 1/8),
steps chosen by a gesture weight with the anchor step forced (a head's last, a tail's first),
walked pitch, drums by metric role. `grid:0` ("Free") keeps the older continuous algorithm.
A gen-control change discards stored phrases, same contract as 🎲.

**Timing — the contract that took three attempts.** Hang time does not count for the layers:
the lattice (`E._barGridAnchor`) shifts by the hang AT THE WINDOW'S START (never at lookahead
time), each layer's own clocks are shifted rather than re-anchored (re-anchoring RESTARTS a
layer; a hang PAUSES one), and every layer whose next onset was due at or after the hang
re-enters exactly at `w.t1` — the part's downbeat. Frozen and composed loops are excluded
from `_ambHangShiftLayers` entirely: `_ambComposedPassSync` already anchors them to the
hang-trimmed pass start, and cancelling their voices would collide with the replay's
per-(time,pitch) dedupe set and leave a permanent hole. Cancels use `w.t1` as the floor, never
`now`, or the burst — scheduled during the lookahead — is deleted along with the stale notes.

**Editing.** `_ambHangModal` shows one strip per selected layer: tap to add, drag to move,
tap a chip for an inspector (pitch, velocity, length, delete), 🎲 to re-roll. Dense phrases
side-scroll in their own container.

**Gates.** `hang-tail · hang-head · hang-both · hang-section · hang-grid · hang-once ·
hang-once-grid` in `test/arch-parity.js`. Hang playback is runtime-switchable with
`bloomHangs(false)`, and `bloomSilenceWatch(sec)` + `bloomDump()`'s hangs block are the
in-situ instruments. Any claim that a hang SOUNDS must be measured at the master tap, not at
the playback gate — the gate logs notes at schedule time and cannot see a later cancellation.

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
