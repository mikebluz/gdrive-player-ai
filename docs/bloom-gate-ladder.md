# The gate ladder — every "does this layer play here?" in Bloom

Written 2026-08-23, after the per-pass Plays work exposed an overlap between the
⏱ Schedule quick-edit and the ▦ Passes grid. This is the whole picture, so the
consolidation decision can be made against it rather than against one symptom.

Everything below was read out of `js/bloops/17-ambient.js` and verified in a
browser; where something is inferred rather than measured it says so.

---

## 1. The ladder

Nine stores can silence or shape a layer. Narrowest first by the axis they cut:

| # | Store | Coordinate | Value | Applied at | Edited in |
|---|---|---|---|---|---|
| 1 | `L.when` | iteration of the **layer's own** cycle | pattern string | pre-emit | When control · Pattern grid tab 2 |
| 2 | `chordMask.part` | position **inside** a chord | `{size, place}` | pre-emit | ▦ Passes → scope bar → Window |
| 3 | `chordMask.steps` | chord | 0–100 | pre-emit **+ replay** | ▦ Passes → layer → Plays column |
| 4 | `chordMask.passes` | chord **× pass** | 0–100 | pre-emit **+ replay** | ▦ Passes → layer → How often |
| 5 | `saltMask.steps` | chord | 0–100 | pre-emit | ▦ Passes → layer → Salt column |
| 6 | `sectionMask.steps` | section / open part | 0–100 | pre-emit **+ replay** | ⇶ Parts → Blocks rows |
| 7 | `unitGate` | unit slot `i % period`, and slices inside a unit | 0/1 per slice | **playback filter** | ⏱ Within · ⏱ Step · Scheduler lane tap |
| 8 | `iterGate` | iteration of the **whole arrangement** | 0/1 | **playback filter** | ⏱ Across |
| 9 | `partSeqs` | part · pass · chord | phrase name / `⚡gen` / absent | freeze install | ▦ Passes → Which phrase · Sequences popover |

Adjacent, not gates: layer mute/solo, `soloLane` (drum lanes), and the
Evolve-inertness marks (`_ambEvolveInertWhy`).

---

## 2. The structural fact that constrains everything: **two application points**

This is the thing to decide against. The nine stores are not one mechanism —
they act at two different places in the pipeline, and that changes what
Write/Evolve freezes.

**Pre-emit** (1–6, 9). The emitter asks *before generating the note*. Call sites:
`_ambChordGateOK` ×14, `_ambSectionGateOK` ×13, `_ambCondFires` ×18. A note the
gate refuses is never generated, so it is **never captured** — a Write/Evolve
freeze taken while the gate is closed does not contain it.

**Playback filter** (7–8). One hook inside `playNote`
(`_ambPlaybackGateShouldSkip`, exported as `window._ambUnitGateSkip`, consumed at
`04-instruments-samples.js:4326`), deliberately placed **after the capture tee**.
The note *is* generated and captured; only the sound is suppressed. That is why
these two are editable live on a frozen loop with no rewrite — and why they now
also apply during an offline bounce.

**Consequence for any merge:** moving a gate between these classes changes
freeze/capture behaviour. It is not a refactor, it is a sound change.

**A partial bridge already exists.** `_ambReplayFrozen` re-consults
`chordMask` and `sectionMask` with `hard = true` (17-ambient:26413–26414) —
which applies only the hard 0 (*never*), never re-rolling a probability, since
the roll was already baked into what was captured. So 3, 4 and 6 are live on a
frozen loop *for their 0/100 values* but not for their probabilities.

---

## 3. The surface map — where the duplication actually lives

The **stores** form a coherent ladder: each cuts an axis no other one cuts. The
**surfaces** do not.

```
⏱ Schedule (quick edit)          ▦ Passes
├─ ⊞ Within  → unitGate          ├─ Which phrase → partSeqs
├─ ⟳ Across  → iterGate          ├─ How often    → chordMask.passes   ← same
└─ ◔ Step    → unitGate          ├─ Plays column → chordMask.steps       coordinate
                                  ├─ Salt column  → saltMask
                                  └─ Window       → chordMask.part
⇶ Parts → Blocks → sectionMask
Pattern grid tab 2 → compiles into when
Scheduler lane tap → unitGate    ← third surface for one store
```

### 3a. The confirmed duplication

A ⏱ **⊞ Within** cell is *one change in the played chain* — `chainSlots[i]`
carries `part`, `rep` (the pass) and `idx` (the chord). That is exactly the
coordinate ▦ Passes → **How often** addresses.

**They can disagree, and I introduced that.** Measured: setting
`chordMask.passes = {1:{0:0}}` (chord 1 of pass 2 silenced) leaves the Within
grid rendering both cells **on**, because it reads `unitGate` only. A surface
that claims a layer plays when it has been silenced is the failure mode this
repo keeps paying for.

### 3b. The older mismatch underneath it

CLAUDE.md already records this as a shipped bug: *the Within grid draws one cell
per **change**, the gate stores one slot per **unit***. A cell whose own tooltip
read `F` silenced bar 1, which is still `C`. It was fixed by mapping change →
unit range in the modal, but the grid and its store still disagree about what a
cell *is*, and every future edit there has to remember the mapping.

### 3c. Three surfaces write `unitGate`

⊞ Within, ◔ Step, and the ⏱ Scheduler lane's unit-block tap. Only Step needs the
sub-unit resolution the store exists for.

---

## 4. What is **not** duplication

Worth stating plainly, because it bounds any merge:

- **`unitGate` reaches below a chord.** A layer whose unit is shorter than a
  change has several units per chord; the store addresses each, and ◔ Step
  addresses *slices inside* one unit (`div`, and the `chop` mode, which is a
  scheduled gain envelope rather than a skip). `chordMask` cannot express either.
- **They follow different clocks.** `chordMask` is chord-indexed and follows the
  *harmony*; `unitGate` is unit-indexed and follows the *layer's own* cycle.
  Under a cadence (variable chord lengths) these genuinely diverge.
- **`iterGate` and `when` cut real, distinct axes** — one iteration of the whole
  arrangement vs one iteration of the layer's own pattern.
- **`partSeqs` answers a different question** (*which notes*), not *whether*.

---

## 5. Precedent: one consolidation already happened, and it worked

`cycleGate` is **not a runtime gate**. `_ambNormalizeCycleGate`
(17-ambient:15243) folds it into `L.when` over the LCM of their periods and then
`delete L.cycleGate`. The Pattern grid's second tab is an *editing view* that
compiles into an existing store and leaves nothing behind.

That is the cheapest kind of consolidation available here: **keep the surface,
drop the store.** It costs nothing at runtime, needs no migration (the fold runs
on every `getCfg`), and there is exactly one place left that can be wrong.

---

## 6. Options, with their real costs

**A. ⊞ Within writes `chordMask` instead of `unitGate`.**
The grid says "change"; `chordMask` is the store indexed by change. Because
`_ambChordGateOK` is consulted per note and resolves the chord itself, it works
regardless of the layer's unit — so it is *better* for this grid, not merely
consolidated. Kills 3a and 3b together. `unitGate` keeps only what is unique to
it (◔ Step slices, chop mode, sub-chord units).
*Cost:* moves this edit from playback-filter to pre-emit, so a Write/Evolve
capture taken under a closed gate no longer contains the note — a real sound
change on existing projects. Needs a migration decision for projects already
holding `unitGate` at change granularity.

**B. Make them agree, change nothing else.**
A Within cell renders off if *either* gate silences it; edits still write
`unitGate`. Removes the lie I introduced. Leaves two stores answering one
question and leaves 3b standing.
*Cost:* near zero. Does not reduce concepts.

**C. Merge the surfaces.**
Delete one grid. Note they serve different reading tasks — ⏱ Within is *all
layers × the whole chain* ("which layers play in the Verse"), ▦ How often is *one
layer × one part* ("where does the bass drop out"). That is the same split that
justified keeping both the read-only strip and the grid in ▦ Passes.
*Cost:* loses a reading task. Not recommended alone.

**D. Retire `chordMask.passes` and let `unitGate` carry per-pass.**
The inverse of A. Rejected on inspection: `unitGate` is binary (no probability),
follows the layer's clock rather than the harmony, and is a playback filter — so
it cannot express what the Plays column already expresses per chord, and the two
halves of one control would then live in different stores.

---

## 7. Recommendation

**B now, A deliberately.**

B is a small, safe fix for a lie that exists today and is mine. It should not
wait on a design decision.

A is the actual consolidation and is worth doing, but it is a *sound* change
(pre-emit vs playback filter, §2) and deserves to be scheduled on its own with a
migration decision, not folded into a UI tidy-up.

C is not recommended alone — the two grids answer the same question for two
different reading tasks, and that has already been established as worth keeping.

---

## 8. Open question this surfaced

`when` (1) and `iterGate` (8) both gate *whole iterations*, at two different
scales, in two stores, edited in two places — and `cycleGate` was a third view of
(1) before it was compiled away. Nothing here is wrong, but if the ladder is
being tidied, that trio is the next place to look after the change-level one.
