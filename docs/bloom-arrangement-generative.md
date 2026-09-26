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

## 4. Not built — the form axis, in order of value

### 4a. `prog.arrOrder` — ↻ Order one level up

↻ Order shuffles the **chords** in a cycle. The exactly-analogous thing at the
**part** level does not exist, and `_ambProgOrderPerm` is the whole template —
Fisher-Yates on a dedicated seeded RNG, plus a `when` grid, already written.

Insertion point is one function, `_ambArrGridSeq(cfg, iter, nParts, ranges)`, plus
`_ambPovOrder` for the strip. **A permutation preserves the round's total**, so this
is the case option 2 above was built for. Store: `{ mode, when }`, absent = written.

### 4b. `parts[i].chance` — the part-level probability the masks already have

Sections have 100/60/30/0 cells; parts have nothing, so "the bridge plays one round
in three" is not sayable. The semantics are already settled — part-matrix decision
#1 is *"OFF = skipped, the pass is genuinely shorter"*, so a skipped part is an
existing supported state. This only decides it by a seeded hash on
`(round, pi, seed)` rather than by a written empty cell.

A skip changes the round length, so this needs option 1 (a declared horizon), not
option 2. Grep confirms no arrangement-level `.chance` exists today.

### 4c. `plays` as a range — `{min, max}`

The most "live band" item on the list (a vamp that runs a different number of times
each go) and the most expensive: it makes the super-cycle length vary per round, and
`_ambProgChainBars`, the Scheduler lane, phrase fits and Write snapping all assume
one answer. Own slice, own gate, last.

### 4d. Per-part Arc depth

`parts[i].arc = { amount }`, ↔ Rubato's grammar at the part rung: the chorus always
full, the verse breathing. Touches no clock at all and reuses everything §2 built —
so it is the cheapest item here, and the natural next one.

---

## 5. The "easier" half

⚙ Deep already solved this shape: three macros (Flourishes · Looseness · Thinning)
over nine dice, with per-die access behind ▸ Advanced. The arrangement wants the
same — one **✺ Novelty** group with three:

- **Harmony drift** → `vary` + salt colours + tension
- **Form** → `arrOrder` + part chance + plays range
- **Orchestration** → arc depth + a spread over the mask percentages

Two filing rules from the existing conventions. Everything on this axis is per-pass,
so by the play-it-twice test it is all **✺ Live**, never ⚙ Deep. And `_AMB_STOCH` has
**no arrangement entries at all** — it is keyed by layer field — so an arrangement
control cannot be marked there without teaching `tools/stochastic-matrix.mjs` about
a second scope. Until that happens, the arrangement dice are invisible to
`docs/bloom-stochastic-controls.md`, which is worth fixing before the list grows.
