# Bloom Layer Model — Implementation Plan

Companion to `bloom-layer-model.md` (the spec). Branch: `bloops-layers`.

## Progress + audit findings (2026-07)

**Track A — DONE.**
- A1 slice 1 (`5612158`): dropped the Voice/Gen axis-swap pickers from the layer
  cards → static readout tags. This was the actual felt clutter.
- A2 (`2c43c98`): reframed the Add-layer menu as curated preset families (Pads &
  drones / Melody / Rhythm / Sampler); retired the "✦ Custom — compose your own"
  entry (its job was assembling a layer via the now-removed axis pickers).
- A1 "mode-aware cards" — **already implemented, no work needed.** Audit found the
  visibility discipline the plan imagined already exists and is thorough:
  `_ambUnitSyncViz` hides Interval when synced / Rate when free for every timed
  layer; `_ambBeatGenVis` handles Beat euclid/random/drum-lanes; `_ambArpEuclidVis`
  handles Arp series↔euclid. Modeless layers (bed/motif/texture/run/pedal/drone)
  have no inapplicable controls to hide. Inventing new hide-rules would risk the
  "don't break" contract for no real gain, so this is deliberately NOT done.

**Track B — B1 DONE (`b47490b`).** Unified the area Key + Progression into one KEY
axis (mode selector Chromatic | Key | Progression + adaptive sub-controls) with the
`_ambResolveKey(scope)` read model. Additive — no new persisted fields, no migration,
harness byte-identical. Underlying keyOn/prog.on stay independent (a progression can
still be diatonic to a key). One deferred UX nicety: while in Progression mode the
diatonic key isn't directly editable (shown in the hint as "· in C Dorian"); switch
to Key mode to edit it (which deactivates the prog; chords retained). Revisit if it
bites.

**B2 DONE (`29e70f7`) — ⏳ AWAITING SAVE/LOAD SIGN-OFF.** Per-layer KEY override chip
(Inherit / Key / Progression) on every pitched, source-editable layer; new optional
`layer.keyOv` field (additive, kept out of defaults, coerced in `_ambNormalizeKeyOv`),
resolved in `_ambNotesOf` after the area-prog check (precedence preserved). "⇶
Progression" retired from the Notes menu. Harness byte-identical; legacy per-layer prog
note-sources still play (not migrated). **GATE: first per-layer-persistence stage —
needs a real-project load→play→save→reload→reload-stable check before B3.** **Next:
B3** — dedicated progression authoring surface (an `_ambOpenProgEditor` already exists
for area prog; B3 makes a purpose-built chord/region timeline writing to KEY at area OR
layer scope, + Send-to-Bloom part-vs-progression routing + promote-part).

Audit context — the cascading KEY frame was largely in place at the DATA level
already before B1:
- Area KEY: `cfg.keyRoot`/`cfg.keyScale`/`cfg.keyOn`/`cfg.keyFollow`
  (`_ambKeyRootPc`/`_ambKeyScaleName`) — with a workspace-follow that reads the
  grid's `rootIdx`/`currentScale`. That IS workspace→area cascade.
- Area progression `cfg.prog` already overrides EVERY layer's note-source via
  `_ambGlobalProg()`+`_ambNotesOf` — "area KEY = progression" already behaves this
  way. So B1's data work is mostly done; what remains is CONCEPTUAL/UI: unify the
  separate Key + Prog controls into one KEY axis (chromatic|key|progression) and add
  a `_ambResolveKey(scope)` accessor. The load-bearing NEW capability is in B2–B5
  (first-class layer KEY override, progression authoring surface, degree-based
  phrases, chords-in-sequences).

Net: the plan was written before a full code audit; reality is further along. Tracks
below are the ORIGINAL plan, kept for reference — see the progress notes above for
what's actually left.

## Ground rules (non-negotiable — the "don't break anything" contract)

1. **Additive-only.** Add fields/paths; never repurpose or remove a field until a
   cleanup stage proven on real projects. Legacy layers keep producing byte-identical
   output.
2. **One migration chokepoint.** All load paths funnel through `_normalizeAmbientCfg`
   (Drive, localStorage, `_cloneLane`, undo, Send-to-Bloom, Shape-It). Migrations gate
   on `_fromVer < N` and stamp `schemaVersion` so they run once and are idempotent.
3. **Harness is the gate.** `23-bloom-harness.js` stays green on every stage — EXCEPT
   the one deliberate baseline bump (C1), which re-baselines in the same commit.
4. **Save/load sign-off per risky stage.** Anything touching persistence (Track B/C) is
   NOT harness- or ear-verifiable end-to-end → each ships with a real-project
   load → play → save → reload → reload-stable check before the next stage.
5. **Every stage is its own commit and independently shippable.** No half-migrated
   states across commits.

## Already in place (from the prior Phase-2 work — reuse, don't redo)

Derivation helpers (`_ambGeneratorOf/_ambVoiceOf/_ambSourceKindOf`), the emit-dispatch
descriptor (`_ambEmitDescriptor`), the euclid decomposition (`_ambEmitEuclidCore` +
voice render), seqs/samples folded into `cfg.extras`, and the card-group relabel
(Voice/Seed/Generator/Timing/Variation/Mix). The new model builds ON these.

---

## Track A — Presentation (UI-only, zero migration, ship first)

*Delivers most of the felt improvement — decluttered, purpose-built cards — at near-zero
risk. Harness green by construction (no emit change). No save/load touched.*

- **A1. Purpose-built, mode-aware cards.** Each layer card shows only its instrument's
  relevant controls; Timing and Variance render adaptively (a Drums card's grid IS its
  timing — no Interval/Rate; a Melody card shows Interval/Free↔Sync). Extend the
  drum-lanes `kitVis` hide-discipline into a general rule via `_ambBeatGenVis`-style
  visibility. **Drop the axis-picker clutter.** Fixes the original Variation/Timing
  complaint. *Risk: LOW. Gate: harness green (render-only).*
- **A2. Presets in the Add menu.** Offer the 11 as named presets (each sets type +
  defaults exactly as today); legacy layers label as their matched preset (else "Custom
  from X"). *Risk: LOW. Additive; harness green (presets == today).*

## Track B — The harmonic model (save/load-gated, staged)

*The load-bearing change: KEY becomes a first-class cascading axis and progression moves
into it. Each sub-stage additive + sign-off.*

- **B1. KEY axis + area progression → area KEY.** Introduce the cascading KEY frame
  (workspace → area → layer). Fold the area-global `cfg.prog` into "area KEY =
  progression" — KEEP `cfg.prog` (additive), derive KEY from it, resolve the current
  chord from KEY. Chord-per-onset resolution stays byte-identical (same
  `_ambProgStepAt` math, read from KEY). *Risk: MED. Gate: harness green (identical
  resolution) + save/load sign-off.*
- **B2. Per-layer Progression note-source → layer KEY override.** A layer that used the
  "Progression" note-source becomes a layer-level KEY override (a progression). Retire
  the per-layer prog note-source from the UI (the field folds to KEY-override; still
  read for legacy). *Risk: MED. Gate: harness green + sign-off.*
- **B3. Progression authoring surface.** A dedicated chord/region timeline editor that
  writes to KEY (area or layer) — purpose-built (chord picker / roman numerals /
  one-per-bar), separate from the Seed page. Wire **Send-to-Bloom part-vs-progression**
  routing + the **"promote part → progression"** action + optional "add a pad playing
  this progression." *Risk: MED (new UI on B1/B2). Additive.*
- **B4. Degree-based phrase pitch + Harmony toggle.** Store phrase pitches as degrees
  (derive from a sequence's saved scale/root); add the per-pitched-phrase toggle
  **Fixed / Diatonic / Chord-locked** with borrow-from-scale + user-selectable
  re-voicing. **Existing Seq layers default Fixed** → byte-identical playback; Diatonic
  (context-aware default for NEW) + Chord-locked are opt-in. *Risk: MED. Gate: harness
  green for Fixed-default configs; add battery coverage for the new toggle paths.*
- **B5. Chords-in-sequences realization.** A chord = a voicing (a set of simultaneous
  events); the layer realizes it via TIMING (simultaneity/order) × INSTRUMENT
  (polyphony): poly-stack / arp-spread / mono-fold. **Send default = poly-simultaneous**
  (plays as authored → no change for existing chord-seqs); **mono-fold = user-selectable**
  (root/lowest/top); arp spread = within-slot strum. *Risk: MED. Additive.*

## Track C — Generative unification + cleanups (higher risk, LAST)

- **C1. SEED fold — unify walk/riff/mutate into Melody + variation mode.** The one
  DELIBERATE baseline bump: one pattern generator whose `mode` does walk / re-roll /
  evolve over a shared phrase representation, retiring the three separate emitters. Not
  byte-neutral → re-baseline the harness IN THE SAME COMMIT, reviewed. *Risk: HIGH. Gate:
  intentional baseline bump + ear check.*
- **C2. Legacy cleanup (one-way).** After the model is proven on real projects: retire
  the primary bed/motif/texture/beat hardcoded templates (→ extras, per old doc §13),
  drop `cfg.prog`/per-layer prog fields (now in KEY), remove dead dispatch/wiring.
  `schemaVersion` bump; one-way from here. *Risk: HIGH. Gate: heavy real-project
  regression + sign-off.*

## Recommended sequence

**A1 → A2** first — immediate, safe, high-value; independent of everything else and
ship-able on their own. Then **B1 → B2 → B3 → B4 → B5** for the harmonic capability
(each save/load-gated). Then **C1** (the reviewed baseline bump), then **C2** (one-way
cleanups) only once real projects have exercised the whole thing.

Tracks A and B are largely independent — A can land while B is still being designed, so
the panel gets cleaner immediately without waiting on the harmonic migration.

## Open (plan-level, decide when we reach them)

- Degree-storage format (scale-degree vs chord-degree encoding; how a phrase records
  which frame it was authored against).
- Whether B4's Diatonic re-map runs at load (bake degrees) or per-onset (live) — perf vs
  flexibility.
- Preset card templates: build fresh (schema-driven) vs adapt the current per-type cards.
- Exact UI for the Progression surface (B3).
