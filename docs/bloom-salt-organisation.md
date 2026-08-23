# Salt — what exists, what's missing, and how to organise it

Written 2026-08-23. Salt is nearly all built; the problem is that it is scattered
across five surfaces and two different questions are tangled together. Verified
against `js/bloops/17-ambient.js`.

---

## 1. Everything that exists today

| Store | Scope | Axes | Edited in |
|---|---|---|---|
| `cfg.prog.salt` | area | `len` · `colors` · `scatter` | 🧂 Salt subsection |
| `parts[i].salt` | one part | `len` · `colors` · `scatter` | part bar → Salt (inherit / own) |
| ~~`layer.salt`~~ | — | **RETIRED 2026-08-20** — see §2a | (no control) |
| `saltMask.steps[ci]` | layer × chord | 0–100 | ▦ Passes → layer → Salt column |
| `layer.saltNudge[slot]` | layer × chord | re-roll count | cell modal → 🎲 |
| `layer.saltFree[slot]` | layer × chord | snapped / free timing | cell modal → ◈ / 〰 |
| `bed.followSalt` | one layer | bool | layer card |

Resolution today (`_ambPartSaltAt`): **part → area**, with an explicit all-zero
part object meaning *off here* rather than *inherit*. Whether a given layer takes
that salt is a separate decision (`_ambSaltFollowOK`).

**The gap you named is real: there is no per-PASS salt.** Per-part and per-layer
both exist.

---

## 2. The organising insight

Salt is currently one word for **two different questions**, which is why it feels
scattered:

- **How much salt exists here?** — `prog.salt` → `parts[i].salt` → *(missing: pass)*.
  This is a property of the **arrangement**. It has a clean narrowest-first
  cascade and one axis missing from it.
- **How much of it does this layer take?** — `layer.salt`, `saltMask.steps`,
  `saltFree`, `saltNudge`, `followSalt`. This is a property of the **layer**.

Every current confusion is a place where those two are edited side by side
without being named as different questions. Splitting them is most of the work.

---

## 2a. CORRECTION — the two-questions split is already the shipped model

`layer.salt` (a per-layer `{colors, scatter}` object) was **retired 2026-08-20**,
and the reason matters for everything below: **the colour pick hashes on
`(step, segIdx, seed)` and NOT on the layer**, so two layers carrying different
salt numbers picked *different colours for the same instant* rather than one
following the salt more than the other. It looked like an intensity control and
was not one.

So the model already is: **salt is defined once by the Changes, and which layers
follow it — chord by chord — is `saltMask.steps`.** The §2 insight is not a
proposal; it is a description of what the codebase already decided. That removes
step 2 of the plan entirely and sharpens step 1: the only thing genuinely missing
is the **pass** level of the *arrangement* axis.

**A consequence to respect when adding it:** per-pass salt must be an
ARRANGEMENT-level number (`parts[i].passSalt[pass]`), never a per-layer one, for
exactly the reason `layer.salt` was retired.

## 3. The one structural limit, and how far it reaches

**`len` cannot be per-layer.** Length salt is applied inside `_ambProgStepAt` —
the function that decides which chord is sounding — so a per-layer version would
put the bass on chord 2 while the pads are on chord 3. That is why `layer.salt`
carries only `colors` and `scatter`, and why `_ambNormalizeLayerSalt` *drops* a
stray `len` rather than storing an ignored field.

**Per-PASS `len` does not hit that limit** — a pass is a slot run on the shared
clock, so every layer agrees about it. `_ambProgSaltLensParted` already re-slices
each part's lengths against its own subtotal; per-pass would be the same move one
level down. It is feasible, but it changes how long a pass *is*, which the
Scheduler lane, the bar counts and every phrase fit read — so it should be a
separate decision from per-pass `colors`, which is free.

**Recommendation: add per-pass `colors` and `scatter` first, leave `len` at the
part level** until there is a reason to want a pass that stretches.

---

## 4. Proposal — no new surface

▦ Passes already has the right shape, and the per-pass Plays work just proved the
pattern: one grid, a mode toggle, the scope deciding what a cell means.

**Add `Salt` as a third cell mode**, beside `Which phrase` and `How often`:

```
Cells show:  [ Which phrase ]  [ How often ]  [ Salt ]

ALL LAYERS scope + Salt   → cell = the salt amount for that (part, pass)
                            NEW store: parts[i].passSalt[pass]
                            blank inherits the part's own salt

LAYER scope + Salt        → the Salt column that already exists,
                            per (layer, chord) — unchanged
```

That gives the full ladder in one place, read narrowest-first exactly like the
gates: **layer × chord → pass → part → area.**

Storage follows the grammar already established twice this week: absent = inherit;
an explicit all-zero object = *off here* (the meaningful-zero rule `parts[i].salt`
already relies on); prune anything equal to the level above so absence has one
representation.

**Naming: already settled, see §2a.** The layer axis is "which layers follow the
salt", and the code already says so (`_ambSaltFollowOK`). No rename is needed —
what is needed is for the *arrangement* axis to gain its missing level.

---

## 5. What to consolidate while doing it

- `saltNudge` and `saltFree` are both per (layer, chord) and both live only in the
  cell modal, reached by long-press. They belong with the Salt column they modify
  — that column *is* their scope.
- The 🧂 Salt subsection and the part bar's Salt control are the same three
  sliders drawn twice. Once the grid carries the pass axis, the subsection can
  become the area default only, with the part and pass levels read where the
  parts and passes are.
- `_ambPartSaltAt` gains one level. It is the single resolver, so the display,
  the readout and the emitters all follow from that one change — the same
  one-insertion-point property `_ambArchChainSlots` has.

---

## 6. Suggested order

1. ~~**Per-pass `colors`/`scatter`**~~ — **DONE.** See §7.
2. ~~**Rename the layer axis** to `Follows salt`~~ — **DONE.** See §8.
3. ~~**Fold `saltNudge` / `saltFree`** into the Salt column's own cell modal~~ —
   **DONE, and it was worse than a fold: they were UNREACHABLE.** See §8.
4. ~~**Reduce the 🧂 subsection** to the area default~~ — **DONE.** See §8.
5. **Per-pass `len`** — only if wanted, and as its own change, because it moves
   pass lengths. NOTE: the store already carries `len` and `_ambPartSaltAt`
   returns it, but nothing re-slices per pass yet — `_ambProgSaltLensParted`
   works at the PART level. So a per-pass `len` is currently stored, shown and
   only partly acted on; that is step 5's job.

---

## 7. What shipped (2026-08-23)

**Store.** `parts[i].passSalt['<pass>']` = `{len, colors, scatter}`, and
`prog.passSalt` when the progression has no parts — which is the shape most
projects have, since `_ambRepairParts` collapses a lone part covering the whole
cycle. The two homes mirror `_ambGridStore` / `prog.grid` exactly, migration
included (`_ambPassSaltStore` / `_ambPassSaltSet`). Gating on a part list would
have repeated the documented `parts.length > 1` mistake a fourth time.

**Grammar.** Absent = inherit (the cell DRAWS what it inherits, dashed, never a
bare dash). An explicit all-zero object = *off on this pass*, and it is never
pruned — the meaningful-zero rule `parts[i].salt` already relies on. An emptied
store is deleted so "inherits everywhere" keeps one representation.

**Surface.** ▦ Passes, ALL LAYERS scope, `Cells show: [Which chords] [🧂 Salt]`
— one cell per pass, tap for a modal with `Inherit | Its own` and the three
axes. Switching to *Its own* seeds from what the pass was already inheriting,
so engaging it is inaudible.

**Deviation from §4.** The plan called for a third cell mode in the LAYER scope
too. It was not built, deliberately: `saltMask.steps` has no pass axis (it is
per (layer, chord)), so a layer-scope Salt grid would have been columns of
identical values — a picture asserting something the store cannot express. That
column already stands in "Which phrase", which is its correct home. The layer
scope therefore keeps two modes and the all-layers scope gains its first.

**Not reachable, and it says so:** one pass (nothing to vary) and an open part
(no chords to salt) both render a sentence naming the way forward instead of
dead cells.

**Gates.** `npm run test:partseq` §5e (8 checks, poison-verified). Everything is
absent by default, so golden 82/82, arch 51/51 and the invariant harness are
byte-identical by construction.

---

## 8. Steps 2–4 (2026-08-23)

### The layer axis is named, and so is the control it collided with

The ▦ Passes trailing column reads **`Follows salt`**, not `Salt` — "Salt" alone
read as *this layer's salt settings*, which is exactly what `layer.salt` WAS
before it was retired, and exactly the wrong model. Key (`saltMask`) unchanged.

That rename collided with the Bed/Keys select already labelled `Follow salt`, so
that one became **`Salt re-voice`**. They are different questions and one label
for both would be the naming rule's converse mistake:

| control | question | store |
|---|---|---|
| `Follows salt` (column, per layer × chord) | how much of the one shared colouring this layer TAKES | `saltMask.steps` |
| `Salt re-voice` (Bed/Keys select) | whether a sustained chord RE-VOICES when the colour moves mid-unit, or holds what it struck | `followSalt` |

A layer can follow the salt in full and still hold, which is why both exist.

### `saltNudge` / `saltFree` were not scattered — they were UNREACHABLE

`_ambMaskCellModal` renders the 🎲 re-roll and the ◈/〰 timing toggle **only when
the caller passes `onReroll` / `onSnapToggle`**, and after `f410bf3` (the ⌗
Matrix fold) *no caller did* — the fold deleted the only block that supplied
them. Two engine-read features went silent with nothing to notice: the
`_ambReconfigSharedQuiet` shape (code that exists, reads correctly, and nothing
invokes). Confirmed with `git log -S onReroll`.

They are reconnected on the **salt** cell only — they modify the salt that cell
governs, and that column IS their scope; the Plays cell asks a different
question and is deliberately left without them.

`_ambAnySaltColors(cfg)` replaces the old "does salt colour anything here" test,
which asked `L.salt` — retired 2026-08-20, so it was answering a question the
model no longer has. It now walks the whole ladder, **the pass rung included**.

### The 🧂 subsection says it is the area rung

Its `lengths` tooltip ended *"(colour and scatter can be overridden per layer)"*
— also `layer.salt`, also retired. A caption asserting a model the code no longer
has is worse than no caption. It now names the ladder and where each rung lives
(changes → the progression editor, pass → ▦ Passes → 🧂 Salt, layer → the
`Follows salt` column).

**Gates.** 14 more checks in `npm run test:partseq` (192), poison-verified —
severing the wiring fails 5 named checks. The section dispatches a real
`contextmenu` at the cell, which is the handler `_ambWireMaskCells` actually
arms, rather than calling the modal directly; and every `.click()` is guarded, so
a missing button reports as a red line instead of killing the run.

---

## 9. ↔ RUBATO — the type boundary inside Salt (2026-08-23)

**Salt was two different kinds of thing wearing one name.** Measured across every
per-cycle harmony axis, with and without a Passes grid:

```
axis               no grid          with grid
                   lengths ids      lengths ids
salt lengths       yes     -        -      -     <-- LOST
salt colours        -     yes       -     yes
salt scatter        -     yes       -     yes
🌊 vary             -     yes       -     yes
🌡 tension          -     yes       -     yes
🎲 take-reroll      -     yes       -     yes
↻ order             -     yes       -     yes
```

The pattern is exact and self-explaining: **`lengths` is the only axis that
changes HOW LONG a chord is; every other axis changes WHICH CHORD it is.** That
maps onto where each is applied — identity resolves at read time in
`_ambProgCurrentChord` (never sees the grid), length is decided in the walk
(`_ambProgStepAt`, which under a grid returns from `_ambGridPlan`'s cached `cum`
edges without reaching `_ambProgSaltLensParted`).

So the length axis is now **↔ Rubato**, label-only — `prog.salt.len`,
`parts[i].salt.len` and `passSalt[].len` are untouched, per the naming rule.
`Rubato` is the exact word: time is borrowed and paid back, and the cycle total
is always preserved (measured 8.00 bars at every setting). `Stretch`, `Swing` and
`Drift` were all already taken.

### Where it appears

| rung | Salt (colours · scatter) | ↔ Rubato |
|---|---|---|
| area | 🧂 Salt row | same row, own label; marked **n/a** while a grid is engaged |
| changes | Variation → Colours / Scatter | Variation → ↔ Rubato |
| pass | ▦ Passes → 🧂 Salt | **absent — see below** |

### Rubato is absent at the PASS rung on purpose

Not "not yet". Per-pass salt resolves only through `_ambProgPassHint`, which is
stashed by the GRID branch of `_ambProgStepAt` — and that same branch is the one
that skips length salt. **The only state in which a per-pass value can be read is
the state in which Rubato does nothing.** Offering the field would be a control
that can never act. The store still coerces `len` and the edit path carries it
forward, so nothing is lost if the plan learns about it later.

### §9b — Rubato is now its own STORE and its own SECTION (schema v10)

Renaming was not enough: it is a different **axis of editing**, and further
timing variations (anticipation, skipped changes, a swing on the harmonic
rhythm) need a home that does not distort Salt's meaning.

| | store | grammar |
|---|---|---|
| area | `prog.rubato = { amount }` | absent/0 = as written |
| changes | `parts[i].rubato = { amount }` | absent = inherit, explicit `{amount:0}` = none here |
| pass | — | cannot act at this rung (see above) |

An **object, not a number**, precisely so siblings can be added beside `amount`.
`prog.salt` is now `{colors, scatter}` only, and the canonical salt coercion is
where `len` is dropped — a `delete` anywhere earlier is silently undone by it.

Each rung has its **own Inherit / Its own** control now, which was impossible
while the two axes shared one stored object. UI: `↔ Rubato` is its own accordion
beside `🧂 Salt`, and its own group in the changes editor.

**Migration (v10)** lives in `_normalizeAmbientCfg` — the only scope with
`_fromVer` — and must run BEFORE `_ambNormalizeProgMeta`, which deletes
`salt.len`; reading it afterwards finds nothing. It carries the area, every part
(including a **meaningful zero**, which is how "no rubato in the chorus" was
expressed) and every version.

**The proof it preserved behaviour:** `arch-parity` drifted on exactly the two
configs that set `salt.len` — so the test's config BUILDER was taught to split
the axes the same way the migration does, and all 51 configs then matched the
**untouched** baseline. No re-baseline was needed, which is a stronger result
than re-recording one.

### §9c — Rubato works under a Passes grid (2026-08-23)

The plan's `cum` is the WRITTEN bar edges, memoised on `_ambGridSig` and
cycle-independent by design — that caching took the clock from 0.375ms to
0.0049ms, and it is exactly why Rubato was silent under a grid. So the edges got
a **second, small memo**: `_ambGridCumAt(cfg, plan, loop)`. The slot expansion
(the expensive half — up to `_AMB_GRID_MAX_SLOTS`, simulated until the state
repeats) stays shared; only the edges re-derive, once per super-cycle.

**Each part-visit — one pass — is re-sliced against its own subtotal**, exactly as
`_ambProgSaltLensParted` does for a part. That is what keeps the arrangement
still: every pass, and therefore the whole super-cycle, keeps its length, so the
Scheduler lane, the bar counts and every phrase fit read the same numbers. Only
where the chords fall *inside* a pass moves. Measured: pass lengths `[2,2,2,2]`
identical across written / loop 0 / loop 1, super-cycle 8 → 8, edges moving
inside, loops differing from each other.

The total is the load-bearing invariant — `gloops` is derived from `plan.cycle`,
so edges summing to anything else would walk the clock off its own grid.
`_ambProgSaltLens` enforces a 1/8-bar minimum segment, which on a pathologically
short pass could exceed the subtotal, so a drift over 1e-6 falls back to the
written edges rather than drifting.

`_ambRubatoInertWhy` and its UI marking are **deleted** — the marker was always
meant to be removed by the fix, not kept beside it.

**Gates:** two new arch configs, `grid-rubato` and `grid-rubato-part` (a part
switching it off against an area that has it, under a grid) — appended at the END,
since those configs are order-dependent. Every prior rubato config was grid-less
and every grid config rubato-less, so the two axes could each stay green while
their interaction was broken; the standing rule is to gate the COMBINATION.
Poison-verified: putting the clock back on `plan.cum` fails both and nothing else.
Clock cost measured unchanged (0.00227 → 0.00215 ms/call).

### Still open

- Nothing on the Rubato axis. Further TIMING variations now have a home beside
  `amount` in the same store (anticipation, skipped changes, a swing on the
  harmonic rhythm) — that was the reason for splitting rather than relabelling.
- **The stores are still coupled at the part rung**: `parts[i].salt` holds `len`,
  `colors` and `scatter` in one object, so Inherit/Its own governs both axes
  together. The button says so. Splitting them is a migration, not a label.
