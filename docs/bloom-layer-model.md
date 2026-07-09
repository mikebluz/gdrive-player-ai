# Bloom Layer Model — Design Spec

Status: **design settled (2026-07), not yet implemented.** Branch: `bloops-layers`.
**Living doc — revise as we develop.** Implementation will surface details this
skips; update this spec when it does (it's the source of truth, not a frozen plan).
Build order + staging: `bloom-layer-plan.md`.

This supersedes `bloom-composable-layers.md` (the abandoned rewrite: six co-equal
axis pickers, Voice × Seed × Generator × Timing × Variation × Mix). That approach
was judged low-value — its axes weren't orthogonal (a large illegal-combo matrix),
a layer had no identity, and every card became a wall of half-relevant controls.
Keep the old doc only for its **migration patterns** (the C-track / primary→extras
staged-migration playbook), which still apply.

---

## 0. Principles

- **Hierarchy, not a flat kit.** You pick *one* thing — the **instrument** (a preset).
  **Timing** and **Variance** are *universal, subordinate* treatments that apply to
  every layer, collapsed by default. You don't assemble a layer from co-equal
  dropdowns.
- **Progression lives only at KEY.** Harmony is context, not material. Layers respond
  to the frame they inherit; they never own a progression.
- **Deterministic vs stochastic is the SEED/VARIANCE line.** How a fixed base is
  *defined* (authored, euclidean, saved) is SEED. What *perturbs* it (probability,
  evolve, humanize) is VARIANCE.
- **Don't break existing functionality.** Additive/lossless migration; legacy layers
  derive to a matched preset and stay byte-identical; the invariant harness
  (`23-bloom-harness.js`) is the gate; `schemaVersion` makes derivations run once.
- **Presets, not scratch assembly.** Today's 11 types become named presets (points in
  the axis space) — the doors into the model. Custom layers are just off-preset points.

## 1. The model

```
Layer = INSTRUMENT  ·  KEY  ·  SEED  ·  TIMING  ·  VARIANCE  ·  FX/MIX
        (the sound)   (frame)  (material) (realization) (stochastic)  (shared)
        └─ preset picks this ─┘  └───── universal, adaptive, collapsed ─────┘
```

## 2. The axes

### INSTRUMENT — the sound
- **Voice**: `synth` (pitched) · `kit` (drum map; unpitched) · `sample` (buffer; pitch = varispeed).
- A **tone**, or a **set of tones** (a kit; or per-degree/per-lane/per-note tones that
  the material assigns per event — the wrap-ensemble case).

### KEY — the harmonic frame
- One of: **chromatic** · **key** (root + scale) · **progression** (a moving key — a
  series of chords/harmonic regions).
- **Cascades** workspace → area → layer; **overridable** at any level (override
  cascades down automatically). A layer defaults to its area's frame, which defaults
  to the workspace's.
- **Progression lives ONLY here.** The area-global `cfg.prog` already is this; a layer
  that wants its own changes sets a *layer-level KEY override* (this is what the Arp's
  "built series" becomes — a per-layer KEY progression, not a note-source).
- Root is dynamic under a progression (the current chord's root).

### SEED — the material
Two kinds:

- **Free** — generate continuously within KEY. No fixed phrase; VARIANCE governs the
  generation (walk step-size, chord-tone magnet, density). = today's Bed/Motif/Drone-style.
- **Phrase** — a fixed, repeatable base. Deterministically defined by one of:
  authored (drum grid / note grid) · **euclidean** (`pulses/rotation` over the grid) ·
  a **saved Seed sequence** · locked-random (= today's Riff). VARIANCE then perturbs it.

**Rhythm and pitch are independently Free-or-fixed.** This is why bass/arp "just follow
the changes": their *rhythm* is a fixed Phrase (euclid) while their *pitch* is **Free**
(regenerated from the current chord each onset). The Harmony question below only bites
when the **pitch itself is fixed** (an authored melody).

**The on/off pattern's *generator* is its own spectrum** (this is SEED; the grid it fills
is TIMING — §8). Which slots fire can be produced by: **euclidean** (`E(k,n,rot)`),
**authored** (hand-drawn), **locked-random**, or **stochastic-fill** (each slot on with
probability `fill`). The last is today's **Texture** — a step-grid Phrase whose on/off is
generated *stochastically* and whose degrees are random, then evolved by VARIANCE
(`mutate`). So Texture is **not a distinct generator**: it's the *step-grid layer* (same
TIMING as euclid Beat/Bass/Arp) with a stochastic-fill rhythm seed + random-degree pitch +
mutate variance — the stochastic end of the same "which slots fire" axis whose deterministic
end is euclidean. See §5.1.

**Harmony toggle (fixed-pitch phrases only).** Phrase pitches are stored as **degrees**
(never absolute MIDI, except the Fixed case), so they can re-map to the frame:
- **Fixed** — absolute pitches; ignore KEY (re-harmonization / pedal / ostinato).
- **Diatonic** — scale degrees; stays in key, transposes on key change, sits on the
  scale over a progression. **Default** (context-aware: a scale-authored phrase defaults
  Diatonic; a chromatically-placed one defaults Fixed; migrated Seq layers default Fixed
  → lossless).
- **Chord-locked** — chord degrees; re-anchors to each chord (comps the changes).
  - *Missing tone* (a degree the chord lacks, e.g. 7th over a triad): **borrow from the
    scale** (use the key's degree, adding the tension tone).
  - *Re-voicing* (how voices move onto the next chord): **user-selectable** — Smooth
    (voice-lead to nearest, default) / Reset (close position) / Preserve register.

**Voicing** = the arrangement of chord degrees (which degrees, inversion, spread,
register). It's a **SEED-chordal property**, identical whether the chord is *generated*
(Free-chordal: the old Chords/Monk/Stack, drone-voicing) or *authored* (a phrase's chord
event). Bed's Monk-voicing and a hand-drawn chord are the same kind of object.

### TIMING — realization ("how the material becomes note events")
- **Grid / clock**: tempo-synced to the area BPM by default (which defaults to the
  workspace BPM); arbitrary subdivisions; Free (Hz/interval) ↔ Sync (bar / beat /
  another layer's unit). Drift.
- **Simultaneity & order**: whether a chord plays as a **stack** (poly-simultaneous),
  is **spread** (sequential = arp), or **folds** to one note (mono). This is what makes
  the *same* material a pad, an arp, or a bassline depending on the layer — realization,
  not new logic.
- **Per-event edits**: velocity · length · pan · ratchet (the drum-lanes per-step
  inspector's *deterministic* knobs live here).
- **Scheduling**: When gates, trance gate.

### VARIANCE — stochastic modification of the seed
- Element-level: **probability** (the per-step prob; drop/add hits) · ratchet-as-random.
- Pattern-level: **evolve/mutate** · **re-roll** · static.
- Performance: **humanize** (velocity/timing jitter).
- Deterministic generation is NOT here (that's SEED). "Non-deterministic modification"
  is the whole of VARIANCE.

### FX / MIX — unchanged from today
`level`, `pan/space`, `mod` (VCA/VCO/VCF + shapes), `fx` (reverb/delay/dist/chorus/
phaser/autopan), `tg` (trance gate), `areaFadeMs`, `portamento`, `fine`, `when`.

## 3. Progressions vs parts (authoring)

A "chord progression" is a **narrow, specific** kind of material (a clear series of
harmonic regions) — you can't reliably detect it from "a sequence has chords." So they
are authored in **different surfaces**, and the surface *is* the destination:

- **Progression** → its own authoring surface (a chord/region timeline; `cfg.prog` is
  the existing data model) → lands in **KEY**. Purpose-built (chord picker / roman
  numerals / one-per-bar), not the note grid.
- **Sequence / Phrase (a part)** → the **Seed page** → lands in **SEED**. The Seed bank
  is *entirely parts.*

No runtime "is this harmony?" fork. A part-sequence *may* contain chords — they're
**voicings** (handled per §4), never mistaken for harmony because it's typed as a part.

Escape hatch: **"promote part → progression"** on a layer, for the rare "I built this in
the Seed page but it's really the changes" case. And "hear the changes" = author a
Progression (KEY) + add a pad layer following it (Free / Chord-locked) — optionally a
one-click "add a pad playing this progression."

## 4. Chords in sequences sent to layers

A chord step is **realization-agnostic material**: a set of simultaneous events (a
voicing), each a degree (§2 Harmony), each optionally carrying its own tone. The
sequence never decides the treatment.

**How it's realized = the receiving layer's TIMING (simultaneity/order) × INSTRUMENT
(polyphony)** — set by the layer's preset, and *changeable after the fact* (the same
sequence re-realizes):

| Realization | A chord step becomes |
|---|---|
| Poly + simultaneous (Pad) | the voicing as a stack |
| Poly + sequential (Arp) | the chord arpeggiated |
| Mono (Bass) | folded to one note |
| Kit | each note → its drum |

Decisions:
- **Mono-fold**: **user-selectable** — root (default) / lowest / top.
- **Send default**: a chord-bearing sequence lands as **poly-simultaneous** (chords play
  as authored); switch to arp/mono after.
- **Arp chord spread**: for now, **within the step's slot** (a fast strum in place).
  *Flagged to revisit* (vs rolling across following steps).
- **Per-note tones** ride along as the INSTRUMENT set-of-tones (poly plays each note's
  tone; arp plays each arpeggiated note's; a fold uses the surviving note's).

So there is **no special "chord handling" code per layer type** — a chord is a voicing,
and every layer already realizes simultaneity (TIMING) and polyphony (INSTRUMENT).

## 5. Presets — the 11 types as points in the space

| Preset | INSTRUMENT | KEY | SEED | TIMING | VARIANCE |
|---|---|---|---|---|---|
| Pad (Bed) | synth | inherit | Free (chordal) | free, chord-stack, strum | voicing drift |
| Pad·held (Drone) | synth | inherit | Free (chordal) | held / cycle | — |
| Melody·walk (Motif) | synth | inherit | Free | free interval | walk rule + roam |
| Shimmer (Texture) | synth | inherit | **step-grid · stochastic-fill · random-degree** | **step-grid scan** | evolve (mutate) |
| Melody·reroll (Riff) | synth | inherit | Phrase (locked-random) | bar | re-roll / static |
| Pedal | synth | inherit | Phrase (root) | bar | — |
| Bass | synth (bass) | inherit | Phrase-rhythm · Free-pitch(root) | bar/grid | rhythmVar |
| Arp | synth | inherit | Phrase/series-rhythm · Free-pitch | interval/grid, sequential | mutes/evolve |
| Drums (Beat) | kit | n/a | Free (random) *or* Phrase (euclid/authored) | grid + per-step | prob/rhythmVar |
| Player·seq (Seq) | synth/kit | Harmony toggle | Phrase (authored/saved) | own units, sync | — |
| Player·sample (Sample) | sample | varispeed | Phrase (chop) | chop grid/sync | — |

Melody's walk/evolve/re-roll are `SEED-Free/Phrase × VARIANCE-mode`, not three
generators. Pad/Drone differ only by TIMING (free vs held). Bass = a euclid layer with a
bass voice + Free-pitch. Every "generator" is emergent from `SEED × TIMING × VARIANCE`.

## 5.1 Zoom: the step-grid layer (Texture ≈ stochastic euclid)

Beat (euclid/authored), Bass, Arp-euclid, **and Texture** are one structure: a **step
grid** of on/off slots that fires a note on each "on" step. They differ only on SEED
(how the pattern + pitches are chosen) and VARIANCE (whether it evolves) — *same* TIMING.
The unified layer's controls, by axis:

- **INSTRUMENT** — Voice: one tone · a **kit** (drum lanes) · sample.
- **KEY** — inherit (chromatic / key / progression); pitch derives from this.
- **SEED** — two independent halves:
  - *Rhythm* (which slots fire): **Euclidean** (Pulses/Steps/Rotate) · **Authored** (draw
    cells) · **Stochastic** (`Fill` = probability/step) · locked-random.
  - *Pitch* (what an on-step plays): **Chord/degree** (from KEY per onset — bass/arp follow
    changes) · **Authored** (degrees drawn per cell) · **Random-degree** (stochastic scale
    pick) · **Drum** (the lane's kit voice).
- **TIMING** — **Unit = one step** (bar-fraction/ms — the sync grid) · **Phrase = Steps ×
  Bars/pages** · per-step **velocity/length/pan/ratchet** (deterministic) · **step-relative
  note length** (the "grain length in steps" the Texture-Hold discussion surfaced — one
  shared control here, *not* a Texture one-off) · When/trance gates · drift.
- **VARIANCE** — per-step **probability** · **mutate/evolve** (flip slots / re-roll degrees
  over time = Texture's `mutateRate`) · re-roll · humanize.
- **FX / MIX** — unchanged.

Then the presets are just coordinates in it:

| Preset | Rhythm seed | Pitch seed | Variance |
|---|---|---|---|
| **Texture** | Stochastic (`Fill`) | Random-degree | mutate |
| **Beat** (euclid) | Euclidean | Drum (or single pitch) | prob / rhythmVar |
| **Beat** (drum-lanes) | Authored, per lane | Drum per lane | per-step prob |
| **Bass** | Euclidean | Chord-root (Free) | rhythmVar |
| **Arp** (euclid) | Euclidean | Chord-degree, spread | mutes / evolve |

Consequence for **Hold**: what looked like a Texture-specific "Hold = grain length in
steps" is just this layer's **step-relative note length**, shared with euclid (which already
carries per-step `len`). So it's *not* a Texture patch — it lands when the step-grid layer
is built. Until then, Texture keeps its ms Length; **Hold stays a Bed/Motif feature** (the
genuine one-event-per-Unit layers, where Hold ≡ length ≡ re-fire).

## 6. Coverage (verified on paper)

All 11 types map (§5). Cross-cutting features land: **Unit-Sync/Lock-to, trance-gate,
When, drift, per-step deterministic edits → TIMING**; **stochastic accent/len-var/rests,
prob → VARIANCE**; **mod → FX/Mix**; **Bar-Lock** capturability *derives* ("SEED is a
fixed Phrase on a bar-grid"); **Areas / Ramps** sit *above* the layer (cross-layer, not
axes). **Wrap** = note-set (KEY) + per-note tones (INSTRUMENT); **Sample** = buffer
(INSTRUMENT) + chop (SEED) — compound pickers that must stay separable underneath. No
unmappable feature → migration can be additive.

## 7. Migration (additive, lossless — see old doc §12 for the staged playbook)

- Add `voice`/`generator`-style derivation (mostly already done in the old Phase 2).
- **Progression**: fold the per-layer "Progression" note-source + area `cfg.prog` into
  KEY (area frame; layer override). Save/load-gated, `schemaVersion` bump.
- **Phrases**: store pitches as **degrees** (derive from a sequence's saved scale/root);
  existing Seq layers default **Fixed** so playback is byte-identical.
- **Presets**: the Add-menu offers the 11 as presets; legacy layers show as their matched
  preset (or "Custom (from X)").
- Every load path funnels through `_normalizeAmbientCfg` (the one migration chokepoint).

## 8. Naming discipline (guards the design)

- **Rhythm splits SEED/TIMING**: the *pattern* (which slots fire — `pulses/rotation`,
  drawn cells) = SEED; the *ruler* (steps/bars/sync) = TIMING. Holding this apart is what
  prevents regressing to a "generator" blob (the old non-orthogonality).
- **TIMING is the realization axis**, not just "when" — it owns simultaneity/order and
  per-event edits. Don't let it become a junk drawer; don't let those leak into SEED.

## 9. Deferred / to revisit (quality, not structure)

- Arp chord-spread scope (within-slot strum now; vs rolling across steps).
- Voice-leading quality beyond the three offered modes.
- Chord-size fallbacks beyond "borrow from scale."
- These are ear-tuned knobs; they don't block the structure.

## 10. Not yet decided

Implementation is a **separate** plan: order of migrations, which preset cards get built
first, the Progression authoring surface, degree-storage format. To be written before
code, staged and harness-gated, with per-stage load/save sign-off (per the old doc's
C-track discipline).
