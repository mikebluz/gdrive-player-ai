# Bloom Part Matrix — Design Spec

Status: **phases 1-4 implemented 2026-08-19** on `bloom-part-matrix`; additive
throughout (absent = today's behaviour, byte-identical — golden 82/82, arch
45/45 with all 37 pre-existing configs unmoved, harness green).
⚠️ SUPERSEDED — `prog.chain` IS retired now — normalize does `delete prog.chain` whenever `arrGrid` exists (a chain under a grid can never be heard). `plays` is still live and now COMPOSES with the grid: a part is visited `cols × plays` times. Original text: Phase 5 — retiring `chain` / `plays` — is deliberately NOT done: the grid marks
them superseded in the UI and nothing is removed until it has earned it.
**Living doc — revise as we develop.**

Implemented: `_ambGridSlots` (the super-cycle expansion), the gated branch in
`_ambProgStepAt`, `_ambProgInstanceAt` (the monotonic ordinal the span search
needs — see §4, which turned out to describe a PRE-EXISTING bug), the display
hook in `_ambArchChainSlots`, and the ▦ Passes editor with its ⇶ Parts meta tab.

Redefines a **part** as a *set* of chords plus a per-iteration schedule over that
set, instead of one fixed sequence. Two grids, one nested inside the other.

---

## 1. The two grids

Iterations run **horizontally in both** — one pass is always one column.

```
PART MATRIX — Verse                      META-MATRIX (schedules parts)
        v1    v2    v3    v4                     i1    i2    i3
  C    [1,3] [1]   [1]   [1]              Verse [1]   [1,3] [1]
  F    [2]   [ ]   [2]   [ ]              Chorus[2]   [2]   [3]
  G    [4]   [2]   [ ]   [3]              Bridge[ ]   [ ]   [2]
  ─────────────────────────────           ────────────────────────
  seq  C·F·C·G  C·G  C·F  C·G             seq   V·C   V·C·V  V·B·C
```

A cell holds the **positions** that row occupies in that column; the **sequence
caption** under each column spells the result so nothing has to be sorted by eye.

## 2. Settled decisions

1. **OFF = skipped, the pass is genuinely shorter.** Not "silent but time
   elapses". This is what makes a part a set rather than a sequence with holes.
2. **A chord may recur within one pass** (`C·F·C·G`). Cells therefore cannot be
   booleans.
3. **Order ships in v1**, together with the subset axis.
4. **Cadence stays per-chord.** A chord's `bars` is its length wherever it
   appears; skipping it removes exactly that much time. Both `C`s in `C·F·C·G`
   are C's length. No new cadence state.
5. **A part may recur within one arrangement iteration** — meta cells carry
   positions too, exactly as `prog.chain` allows today.
6. **Past the last column, wrap to column 1.** The grid is a repeating cycle, the
   same rule `unitGate` slots and euclid pages already follow.
7. **A part's column index is its CUMULATIVE VISIT COUNT**, driven by the
   meta-matrix — not the arrangement iteration. In `i2` above the Verse appears
   twice, so that single arrangement iteration consumes Verse columns `v2` and
   `v3`. This is what makes "iteration of part" well-defined without a second
   clock.

## 3. Storage — store the sequence, derive the matrix

The grid VIEW is positions-in-cells; the STORAGE is the sequence itself, because
a column *is* an ordered list. Repeats then need no special case, the caption is
free, and the cell contents are a pure derivation (`row r`'s positions in column
`c` = the indices where `seq[c][k] === r`, 1-based).

```js
// per part — chord indices are WITHIN the part
parts[i].grid = { cols: 8, seq: { "0": [0,1,0,2], "1": [0,2] } }

// per progression — part indices into the parts that occupy time
prog.arrGrid  = { cols: 8, seq: { "0": [0,1], "1": [0,1,0] } }
```

Both **absent by default**, and pruned back to absent when trivial (every column
the written order, exactly once each) — the established doctrine for `unitGate`,
`iterGate`, `chordMask` and cadence's own `bars`. A column absent from `seq`
means the written order. Kept OUT of `_ambDefaultLayer`-style defaults; coerced
in `_ambNormalizeProgMeta`. `_ambRepairParts` builds a fresh object per part, so
`grid` must be carried explicitly there or it is dropped on every normalize.

## 4. The clock — and the one real structural risk

`_ambProgStepAt` currently returns a step where `step % len` is the chord and
`floor(step / len)` is the variation cycle. Six sites depend on that contract
(`alts`, ↻ Order, take-reroll, transitions, `iterGate`, the arch gate). Both the
section-bound branch and the repeats branch already fake it by returning
`(loops * chords.length) + absChordIdx`, so a fourth gated early branch is
precedented.

**It does not work here, and this is the thing to solve first.** With repeats a
pass is `C(0) F(1) C(0) G(2)`, so `iter*len + idx` yields steps `0,1,0,2` —
**not monotonic**. `_ambChordSpanAt` bisects on `_ambProgStepAt` (14 iterations)
to find chord edges, and bisection requires monotonicity; the chord choke, the
prog-synced onset walk (`_ambProgNextSlot`), the layer bar readout and the
progress bar all hang off that.

Proposed shape:

- `_ambProgStepAt` returns a **monotonic instance ordinal** (how many chord
  instances have elapsed) whenever a grid is active. Monotonic by construction,
  so the bisection is untouched.
- a new `_ambProgSlotAt(E, at)` → `{ writtenIdx, partIdx, partVisit, iteration }`
  is what the resolvers ask. The six `% len` / `/ len` sites read from it when a
  grid is present and keep their arithmetic when it is absent.
- **RESOLVED, and better than proposed:** `_ambProgStepAt` keeps its `step`
  exactly as it was, and the monotonic ordinal rides ALONGSIDE it as
  `_ambProgInstHint` / `_ambProgInstanceAt`. So the six `% len` / `floor(/ len)`
  sites never had to change, and the span search bisects on the instance. This
  also fixed a bug that predates the feature: a chain revisiting a part already
  made `step` repeat within one pass, so `_ambChordSpanAt` joined two disjoint
  stretches — a 1-bar chord measured 5.5 bars.
- **still open:** two occurrences of the same chord in one pass resolve to the
  same `alts` pick and the same order-perm slot. Right (it is the same chord) or
  wrong (they are different musical moments)? Undecided.

## 5. What breaks: "how long is a pass?"

Skip semantics make iteration length variable, so every place that asks a part
its length gets a per-iteration answer instead of one number:

- `_ambProgChainBars` / `_ambArchChainSlots` — the played chain's length
- `_ambSectionChangesBars` — backs `sections[i].unit.ref = 'changes'`
- the ⏱ Scheduler chord lane and its pass windowing (`_ambProgPartRuns`)
- the one-pass readout (`_ambProgChainLenSync`)
- the cadence chip + the cadence total readout
- Write/Evolve phrase snapping, which snaps to whole progression cycles

None are hard individually; there are just a lot of them, and each currently
assumes a single answer exists.

## 6. What it subsumes (retire candidates, not v1)

- **`prog.chain`** — literally one row of the meta-matrix. Same expansion point.
- **`parts[i].plays`** — a repeat is a part appearing more than once in a column.
- possibly **`alts` / ↻ Order** at the part level, once per-iteration chord
  choice exists.

Nothing is retired in v1. Flag them as superseded in the UI only once the grid
has proven itself.

## 7. Naming

Three grids will exist in one panel: ⌗ Chord matrix (layers × chords), ☷ Section
matrix (layers × sections), and this. A third thing called "matrix" with a third
axis pair repeats the `_ambProgDefaultUnit` mistake — give these distinct nouns
(the per-part one schedules *passes*; the meta one schedules *parts*).

Note the ⌗ Chord matrix runs chords **across**; the part matrix runs them
**down**. Locally correct in both (the unbounded axis goes vertical, and a part
can have many chords while iterations are capped) but worth watching as a
reported confusion.

## 8. Gates

`test/arch-parity.js` is the gate — it walks the chord clock, the section, the
sounding chord and the key over 32 bars for 21 configs, and a grid changes
exactly that. New configs required: grid with subset only · with repeats · with
reordering · meta grid with a recurring part · grid + sections · grid + per-part
key · grid absent (must stay byte-identical). Golden and the invariant harness
are untouched by construction — neither has a progression with parts.

## 9. Phasing

1. **Clock first, no UI.** `_ambProgSlotAt` + the monotonic ordinal + the
   expansion, driven by hand-written `grid` objects in a test config. Arch-parity
   green with the grid absent, new configs pinned with it present.
2. **Read-only rendering.** Scheduler lane, one-pass readout, cadence chip and
   the section-length surfaces made per-iteration. Still no editor.
3. **The part matrix UI** — cells, captions, column count, drag-to-reorder.
4. **The meta-matrix UI**, and only then the `chain` / `plays` retirement call.
