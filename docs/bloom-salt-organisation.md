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

1. **Per-pass `colors`/`scatter`** — new level in `_ambPartSaltAt`, Salt mode in
   ▦ Passes. Additive; absent everywhere by default, so the gates stay
   byte-identical by construction.
2. **Rename the layer axis** to `Follows salt` (label only; keys unchanged, per
   the naming rule).
3. **Fold `saltNudge` / `saltFree`** into the Salt column's own cell modal.
4. **Reduce the 🧂 subsection** to the area default once the other levels are
   reachable where they belong.
5. **Per-pass `len`** — only if wanted, and as its own change, because it moves
   pass lengths.
