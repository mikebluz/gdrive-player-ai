# Generative arrangement — what shipped, and the form axis that has not

Written 2026-09-25, from the question "how can we add stochastic/generative aspects
to Arrangement to make creating real 'live' feeling playback with lots of novelty
even easier". Verified against `js/bloops/17-ambient.js`.

---

## 1. The finding

Bloom already had **six** arrangement-level dice, and they all vary the same thing.

| lever | store | grain | varies |
|---|---|---|---|
| 🎲 Take | `prog.reroll` | per take | which chord |
| 🌊 Vary | `prog.vary` | per cycle | which chord |
| 🌡 Tension | `prog.tension` | ramp across a cycle | which chord (extensions) |
| ↻ Order | `prog.order {mode, when}` | per cycle | which chord, in what order |
| 🧂 Salt | area → part → pass | per cycle | which chord (colour), how it segments |
| ↔ Rubato | area → part → **pass** | per cycle | *when* a chord falls |

Plus the masks (`chordMask` / `sectionMask`), whose 60%/30% cells already re-roll
per pass — `_ambChordHash01(step + 1, lid)` keys on the monotonic step.

**Every one of them varies the CONTENT of a fixed FORM.** Which parts play, in what
order, for how many passes — `prog.arrGrid` plus `plays` — is entirely written and
repeats identically forever. Nothing varied **how much plays**, and nothing varied
the **shape of the piece**. That is why long playback reads as looped however many
layer dice are rolling: the same building, redecorated.

Two axes were therefore missing, not one:

- **density** — how much is playing, over time. Shipped as 🌒 Arc.
- **form** — what comes next, and for how long. Not shipped; §4.

---

## 2. What shipped — 🌒 Arc

The **orchestration twin of 🌡 Tension**. Tension ramps harmony across a cycle; Arc
ramps how much is playing across a span of bars, so the arrangement builds and
thins instead of sitting flat.

```js
prog.arc = { amount: 1-100, bars: 2-128 (default 32), shape: 'build'|'wave'|'drift' }
```

- **A third arrangement gate**, folded into `_ambSectionGateOK` — which *is* the
  arrangement gate and is already called adjacent to every chord-gate site. Folded
  rather than swept, because that is 13 call sites and 13 chances to miss one.
  It sits **above** that function's `if (!L.sectionMask) return true`, so a layer
  with no mask is still subject to it — most projects have no masks, and gating the
  flagship control behind one would have made it do nothing out of the box.
- **Clocked on BARS from the progression anchor**, not on the chord clock.
  `_ambProgStepAt` has four branches and under a Passes grid one "cycle" is a
  super-cycle, so a chord-clock phase would breathe at a rate depending on which
  branch a project happened to be on — and it costs a step resolution per note.
  Bars are the one unit every branch agrees about, it reads "builds over 32 bars",
  and it works on an area with **no changes at all**.
- **One arc is 8 slices** (`_AMB_ARC_SLICES`). The slice is what the decision is
  quantized to: a layer holds its in-or-out state for a whole slice (4 bars at the
  default), which is the difference between parts entering and leaving and every
  layer flickering chord to chord.
- **A pure function of (bars, layer, settings).** No shared RNG draw — the decision
  is `_ambChordHash01`, the same hash the two masks use — so engaging it cannot
  shift a downstream draw and the same take replays identically. `hard` skips it,
  exactly as it skips the mask hashes.
- **`drift` is a re-shuffled permutation of build's 8 levels, not iid noise.** Each
  density is visited exactly once per arc, so it is unpredictable *and* can never be
  stuck thin — which noise per slice cannot promise.
- **The floor is `1 − amount/100 × 0.9`**: at depth 100 the thinnest slice is ~10%
  density, never silence. A curve that can empty the arrangement reads as a bug, and
  "everything stopped" gives no clue which control did it.

Reachability was **four** edits, not the two the file's own comment claims — see
`docs/traps-ui.md`. Gate: `node test/probe-arc.js`, 39 checks, poison-verified on
two axes (severing the gate fails 2; dropping the `_ambProgGrpSync` key makes the
group **stray**, not missing, and fails 1).

Also shipped alongside: **↔ Rubato at the pass rung**, which
`docs/bloom-salt-organisation.md` §9 recorded as impossible and §9c had quietly
made possible. See that section (now rewritten) for the three wirings it needed.

---

## 3. The constraint anything on the form axis must respect

`_ambGridSlots` builds the super-cycle by simulating until its state key repeats:

```js
const key = (it % arrCols) + '|' + visits.map((v, k) => v % partCols[k]).join(',');
if (out.length && seen.has(key)) break;      // the super-cycle has closed
```

and `_ambGridPlan` memoises the result on a purely **structural** signature, with
`gloops` derived from `plan.cycle`. **A random part order, or a dice-rolled skip,
never repeats that key** — the walk runs to `_AMB_GRID_MAX_ITERS`, and every bar
count downstream is wrong.

Two ways out, both already precedented in this file:

1. **Declare a horizon.** The stochastic choice is a pure function of
   `(cfg.seed, round)` and the closure key gains `it % H`, with `H` chosen so the
   expansion stays under `_AMB_GRID_MAX_SLOTS`. The super-cycle then becomes `H`
   rounds long — which is an **existing, supported state** (`arrCols` already goes
   to 64), so every multi-round reader is reused rather than invented.
2. **The `_ambGridCumAt` shape.** Keep the structural expansion shared on
   `plan.sig` and add a second small memo keyed on the loop. This works only for a
   **length-preserving** change: a permutation of a round's part list has the same
   multiset of parts and therefore the same total, exactly as rubato preserves a
   pass's subtotal. A *skip* changes the length and cannot use it.

And do not copy `playsRandom` (17-ambient.js:1269), the area queue's ⚄ chip:
`1 + Math.floor(Math.random() * plays)`, **unseeded**. Harmless there because
nothing memoises the queue — fatal in the clock, and it already quietly breaks the
Take ID's own promise that the same id replays the same performance.

---

## 4. The form axis — shipped, except one

**4c is the only item left on this document.** It was blocked on a double count in
`plays`; that is fixed, so it is now a short slice — §4c has what it needs. (4d shipped too; it was never on the form axis — it is the density
axis at one more rung.)

### ~~4a. `prog.arrOrder`~~ — SHIPPED 2026-09-25 as **↻ Parts**

`prog.arrOrder = { mode: 'shuffle'|'reverse', when }` — ↻ Order's exact store shape,
When grid and dedicated seeded RNG, one rung up. The two rows now say what they
reorder: **↻ Chords** inside a set of changes, **↻ Parts** inside a round.

**It took the HORIZON route (option 1), not the per-loop memo.** A permutation does
preserve the round's total, but the plan holds SLOTS and the order changes which
slots those are — so the expansion itself has to run long enough to contain the
variation. `_ambArrOrderRounds` declares the period (4 for a shuffle, the When
grid's own for a reverse, reduced if the super-cycle would not fit) and
`_ambGridSlots`' state key carries `it % H`. Without that the walk stops the first
time the passes line up again, while the order is still changing, and every later
round replays the first one's.

**It engages the grid clock** (`_ambGridOn`), because `_ambArrGridSeq` is only
called from the grid expansion — otherwise the setting would store, draw and play
the written order. It stays inert with one part: reordering one thing is not a
question, and the row says so.

**It moves PARTS, not VISITS.** The list it permutes holds a visit per pass, so a
part with two passes appears twice consecutively; permuting that directly would deal
its second pass to the far side of another part, undoing the documented
back-to-back rule. Consecutive equal entries are grouped into runs and the runs are
permuted. Measured, 3 parts where A has two passes:
`2100 · 1200 · 0021 · 2001` — every round a whole permutation, A's passes always
adjacent, 32 bars = 4 × the written 8.

Gate: 6 new **arch-parity** configs (`arr-order-rev/shuf/when/grid/plays/meta`) — the
standing gate for the chord clock, not only its own probe — plus
`node test/probe-arrorder.js` (31 checks). Re-baselined deliberately: the 62 existing
configs were **unmoved**, only the 6 added. Poison-verified on four axes (the
closure-key horizon, the grid engagement, the plan signature, and run-grouping).

### ~~4b. `parts[i].chance`~~ — SHIPPED 2026-09-26 as **🎲 Chance**

`parts[i].chance` (0–100, absent/100 = always). The semantics were already settled
by part-matrix decision #1 — *"OFF = skipped, the round is genuinely shorter"* — so
a skipped part is an existing supported state, and this only decides it by a seeded
hash instead of by a written empty cell. Same deterministic `_ambChordHash01` the
chord and section masks use, so it consumes no shared RNG draw.

**This is the one that changes a round's LENGTH,** and it is what the horizon was
really for: the SUPER-CYCLE is the unit that must hold still, and `plan.cycle` is
its total however the rounds inside it vary. Measured, B at 50% over three parts:
visits `012 · 012 · 012 · 02`, cycle 22 = 4×6 − 2.

Three things it needed beyond the store:

- **ONE shared horizon.** `_ambArrRoundHorizon` is the LCM of every per-round die's
  period. Two numbers would let the state key close the super-cycle while the other
  die was still varying — so ↻ Parts folds on the shared horizon too, not its own.
- **Chance is applied BEFORE the order.** Reordering first and then dropping would
  make the surviving order depend on who was dropped, so the two dice would not be
  independent.
- **A round is never empty.** Zero parts is zero bars, and a zero-length round makes
  `plan.cycle` meaningless. When every part rolls badly the round plays *as
  written* — a silent gap of no length is not a musical answer to "everyone sat this
  one out".

A skipped part takes its repeats with it (measured: `12 · 000012 · 000012 · 12`).

Gate: 4 new **arch-parity** configs (`arr-chance`, `-never`, `-order`, `-plays`),
re-baselined deliberately with the 68 existing **unmoved**, plus
`node test/probe-partchance.js` (27 checks), poison-verified on three axes — the
empty-round fallback, the shared horizon, and the plan signature.

### 4c. `plays` as a range — `{min, max}` — **UNBLOCKED 2026-09-26, not yet built**

The one item left, and it is blocked on a bug rather than on effort.

The machinery is now in place: 🎲 Chance already makes a round's length vary and
everything downstream coped, so "the same dice, applied to the repeat count" would
be a small slice rather than the large one this section first predicted.

~~**It is blocked because `plays` is COUNTED TWICE.**~~ **That is fixed** (2026-09-26).
`_ambArrGridSeq`'s default walk did `plays × _ambPartPassCols(cfg, pi)`, and that
helper falls back to `_ambPartNaturalPasses` — which *is* `plays` — so `plays: 3`
yielded **nine** visits whenever the grid clock was on and the part carried no grid of
its own. The walk now reads the part's OWN grid width (1 when absent).
`_ambPartPassCols` is untouched: it is correct for the ▦ Passes grid and the layer
matrix, which draw `plays` columns for a grid-less part by design.

Re-baselined with `--update --force` on exactly three configs — `grid-plays-3`,
`arr-order-plays`, `arr-chance-plays` — which are precisely the ones with `plays > 1`
on a grid-less part, and nothing else moved. Asserted rather than only pinned, in
`probe-partchance` §5b: a part is visited `cols × plays` times.

**So the range is now a short slice**, and the pieces are all in place — 🎲 Chance
already proved a varying round length rides the horizon safely. What it needs:
`plays: {min, max}` coerced beside the plain number for save-compat, a roll per
(round, part, seed) on the shared horizon, and the ▦ Passes / layer-matrix column
count deciding whether it follows `max` or the roll (it must follow `max`, or the
matrix would resize as you listen).

One thing to settle first, recorded in `docs/traps-bloom.md`: the pass COLUMN index
still has two readings — `_ambGridSlots` stamps `col` from its grid-only width while
the UI uses the natural fallback — so a grid-less part's columns and its played
visits do not line up. Benign today; a `plays` range makes it load-bearing.
### ~~4d. Per-part Arc depth~~ — SHIPPED 2026-09-25

`parts[i].arc = { amount }`, ↔ Rubato's grammar at the part rung: absent = inherit,
an explicit `{amount: 0}` = **flat here** however deep the area's arc is. "The
chorus is always full, the verse breathes."

**DEPTH ONLY, and that is a design decision rather than a first slice.** `shape`
and `bars` describe the piece and the phase runs on the global bar clock, so a part
that redefined them would jump to a different point of a different shape halfway
through — the curve would be discontinuous at its own boundary. Depth is the one
axis a part can scale without breaking the phase, and it is the musical one.

Three things it needed beyond the store:

- **`_ambArcAmountAt`** resolves part → area, and is skipped entirely unless some
  part actually overrides — so the ordinary area-only arc still costs no chord-clock
  work and still runs on an area with no changes. It asks `_ambPartPassAt`, which
  answers exactly "which part is sounding", rather than the heavier
  `_ambPartChordAt`.
- **The gate engages on EITHER rung.** Testing only the area's depth would leave a
  part that breathes against a flat area stored, drawn and silent.
- **The area's curve is no longer pruned at depth 0 while a part overrides.** Only
  the area stores `shape`/`bars`, so the old prune rule threw away a chosen wave/64
  the moment someone said "flat everywhere except the verse".

An OPEN part can carry one, unlike `passRubato`: rubato moves chord lengths and an
open part has none, while the arc thins the layers playing over it — which is what
an open part is for.

Gate: `node test/probe-arc-part.js`, 22 checks, poison-verified on four axes
(resolver 4 · engagement 1 · part carry 8 · the prune rule 1).

---

## 5. ~~The "easier" half~~ — SHIPPED 2026-09-26 as **✺ Novelty**

The original ask was two things: *add stochastic/generative aspects* **and** *make it
even easier*. §§2–4 did the first. Ten dice across six doors is more capable and not
yet easier, which is what this closes.

**FOUR macros, not the three this section first guessed at.** Three was inherited
from ⚙ Deep's macros rather than derived. Grouped by the question each die answers
they fall into four — Harmony (which chord) · Time (when it falls) · Form (what comes
next) · Texture (how much plays) — and the fourth is Time, which schema v10 split out
of 🧂 Salt **on purpose**. Folding it back into Harmony here would put one vocabulary
over two mechanisms in the macro layer, which is the naming rule's exact failure.
(Time drives one die today; the Rubato store was deliberately built with room beside
`amount` for anticipation, skipped changes and a harmonic swing, so the axis is thin,
not absent.)

**A ONE-SHOT, NOT A DIAL — the load-bearing decision.** A macro writing the same keys
the individual controls write has a lossy reverse direction: one number cannot be read
back out of ten, so a live dial starts lying the moment a die is hand-edited. Storing
the macro too would fix that and put new state in every save file for a control
touched once. So it is ⚄ Generate's shape — controls, a **preview**, and Apply — and
**it stores nothing**.

Three tiers, each optional: the **dial** is the whole control by default; **▸ Shape
it** reveals the four as BALANCE (they lean where the change goes, and can never add
any — at amount 0 no balance conjures novelty); **▸ Advanced** is the existing
per-axis doors, unchanged.

- The **preview IS the plan**: `_ambNovPlan` rows carry both the displayed from→to and
  the `write` Apply runs, so they cannot drift.
- **Undo** snapshots the previous values, per-part 🎲 Chance included. Ten keys at once
  is not something to write without a way back.
- 🎲 Chance keeps a **floor** (60% at full) so no part ever mostly vanishes, and the
  ↻ Parts row goes **inert with one part**, naming the way forward rather than
  offering a write that cannot act.

Gate: `node test/probe-novelty.js`, 34 checks, poison-verified on three axes — the
write drifting from its preview, balance adding instead of leaning, and undo
forgetting the per-part Chance. Golden 82/82, arch-parity 72/72, mod-parity 9/9 all
unmoved: it writes only keys that already existed.

Mockup and the rejected shapes (one dial only · named presets · four independent
dials): https://claude.ai/artifact/P6sotcovHbcuQ5omYxPJCH

## 5b. Still open from the original plan

⚙ Deep already solved this shape: three macros (Flourishes · Looseness · Thinning)
over nine dice, with per-die access behind ▸ Advanced. The arrangement wants the
same — one **✺ Novelty** group with three:

- **Harmony drift** → `vary` + salt colours + tension
- **Form** → ↻ Parts + 🎲 Chance (both shipped; plays range is §4c)
- **Orchestration** → 🌒 Arc depth, area and part (shipped) + a spread over the mask percentages

One filing rule still stands. Everything on this axis is per-pass, so by the
play-it-twice test it is all **✺ Live**, never ⚙ Deep. And `_AMB_STOCH` has
**no arrangement entries at all** — it is keyed by layer field — so an arrangement
control cannot be marked there without teaching `tools/stochastic-matrix.mjs` about
a second scope. Until that happens, the arrangement dice are invisible to
`docs/bloom-stochastic-controls.md`, which is worth fixing before the list grows.
