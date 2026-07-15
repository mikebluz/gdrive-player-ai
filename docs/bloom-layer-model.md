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
  series of chords/harmonic regions) · **yoke** (another layer's LIVE notes — see below).

*Yoke landed (2026-07-15):* `keyOv {mode:'yoke', src:'<layerKey>'}` — the layer's
frame is whatever the SOURCE layer is sounding at each onset. `_ambYokeChordAt`
reads the source's capture buffer (root = lowest sounding note's pc, intervals =
sounding pcs); resolved per onset via `_ambKeyTime` through the shared resolvers, so
every generator (walk, degrees, chordlocked phrases, arps) harmonizes for free —
zero emitter changes. Silent source → the inherited key scale. SEMANTICS: the frame
is the source's notes AS SCHEDULED AT PICK TIME — near a chord change a follower may
harmonize the chord still sounding rather than the one about to land ("play what you
hear"); pinned by `yoke-bass` (~⅔ of onsets strictly in-chord, the rest boundary
carries). UI: Key group mode "Yoke" + a source-layer picker (self excluded,
repopulated per open). KNOBS (all default-absent → strict, in-place, full weight —
`yoke-bass` byte-identical): **Offset** (±12 st — the chord root planes, shape
intact: a parallel shadow voice) · **Strict/Borrow** (Borrow = chord ∪ the key
scale: passing/tension tones between chord tones) · **Weight** (0–100: per-onset
yoke-vs-inherited-key choice, deterministic by onset TIME — a hash, never an RNG
draw, so both resolvers agree per note and the engine stream is untouched).
CHORD-LOCK BRIDGE: a chord-locked phrase on a yoked layer now resolves its chord
from the source's sounding notes (same `{root,intervals}` shape → the borrow +
Smooth/Preserve/Reset re-voicing machinery works unchanged) — composed parts comp
a live generative source.
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

*Phrase gestures landed (2026-07-15, first slice of the phrase-interest plan —
build order Ornaments → Slide → gesture cells → agogic emphasis → motivic
sequence):* **Ornament** (Motif/Riff) — tempo-synced pre-beat figures (grace /
mordent / turn / pralltriller; a flick = a 32nd, in-key neighbors from the
layer's own source, riff figures cycle-locked to the loop) · **Slide**
(Motif/Riff) — per-note glide targeting LEAPS ≥ 3 scale steps (the portamento
machinery, tempo-scaled 60–240 ms). Both gated at 0. Ornament flicks are not
recorded into unit locks (mains only) — a lock replays the skeleton.

*Second slice — **Phrasing** (Motif):* gesture CELLS replace the uniform burst
with structured figures — run-up→arrival, dotted, short–LONG pair, late pickup,
single long arrival — relative onsets/durations over the unit, the ARRIVAL note
leaned on (+15% vel, agogic emphasis folded in), and with prob .35 the previous
gesture REPEATS (the classical sequence device; rhythm-identity v1 — pitch still
walks fresh). Proof: default motif = every note exactly 1000 ms (ONE distinct
duration); Phrasing 100 = 8 distinct durations 120–576 ms. Gesture rhythms ARE
recorded into units → locks keep the phrasing.

*Third slice — the plan is COMPLETE:* **Riff Phrasing** — gesture lengths derive
from the SEED pattern's own shape (a hit before a rest is an ARRIVAL, ~92% of
its slot; a hit inside a run is quick, ~40%), blended by the slider; fully
deterministic (ZERO RNG draws — 0 blends to the legacy length exactly), so the
riff's phrasing is as fixed as the riff. **Motivic sequence v2** — a reused
motif gesture also replays its melodic INTERVALS, transposed from wherever the
walk now sits (same rhythm, same contour, new pitch level — the classical
device in full; proof: transposed unit pairs with identical semitone contours
10 st apart). **Ornament lock-capture** — motif flicks are pushed into the unit
recorder, so ✓ Kept phrases replay decorated (riff flicks were already caught
by freeze capture). All gated at 0; harness 26/26 throughout.

*Loop defaults + Live variance (2026-07-15):* **Loop now defaults to WRITE**
(2 bars × 4 plays) on every layer — backfilled in normalize ONLY when `write`
is absent, so an explicit Off persists and old deliberate settings survive; the
harness zeroes it in mk() (pins = generation semantics). New layers carry it
from `_ambDefaultLayer`. And the Loop row gained **⚡ Live** (`L.loopVar =
'live'`, absent = written): a written/held loop normally replays EXACTLY as
captured (variance baked at write time); Live makes every pass RE-PERFORM the
phrase — Humanize, Vel var and Ornament re-roll from the layer's CURRENT
sliders per iteration in `_ambReplayFrozen` (the same unseeded Math.random
doctrine — zero engine-RNG draws). Structural variance (mutate/rests/rhythm)
stays as written: the loop remains the loop; the touch varies. Proof: written
replay = 1 volume/0 flicks over 4 iterations; live = 8 distinct volumes, all
onsets humanized, fresh in-key flicks (degree derived from the replayed Hz via
the `_ambScaleTranspose` nearest-degree walk against the layer's current
source, so flicks follow key changes).

*Landed (2026-07-15):* the axis gained its universal + per-type controls —
**Humanize** (±20 ms onset jitter) and **Vel var** (±40% level noise) on every type
(both UNSEEDED Math.random: performance noise, zero engine-RNG draws);
**Rate var** (Arp — momentum slot-subdivision accelerando; the Timing rate is the
structural floor); **Ghosts** (Beat/Bass — ~28%-level pickup hits half a slot early);
**Gravity** (Motif — the once-hardcoded 0.45 chord-tone magnet as a slider; default
50 ≡ 0.45 exactly); **Contour** (Motif — walk-direction bias, fall↔rise);
**Syncopate** (Texture — stochastic fill tilted to offbeat slots); **Stutter**
(Motif — repeat-instead-of-walk). Two RNG-safety patterns, use them for any new
control: (a) fully GATED draws (zero draws at 0 — Ghosts/Stutter/Rate var), or
(b) always-drawn EXACT-DEFAULT arithmetic (the draw fires at every setting so the
stream never shifts — Gravity/Contour/Syncopate).

### FX / MIX — unchanged from today
`level`, `pan/space`, `mod` (VCA/VCO/VCF + shapes), `fx` (reverb/delay/dist/chorus/
phaser/autopan), `tg` (trance gate), `areaFadeMs`, `portamento`, `fine`, `when`.

*Card UI landed (2026-07-14):* every layer card now reads in axis order —
**Instrument · Key · Seed · Timing · Variance · FX / Mix** (renamed from
Voice/Variation/Mix). The **Key** group surfaces the pre-existing `layer.keyOv`:
Inherit (the Area's frame) / Key (own root+scale, grouped scale catalog) /
Progression (✎ opens the layer prog editor, whose apply writes keyOv). Hidden for
kit/sample-voice extras (no harmonic frame). The Bed/Drone Progression sub-block
(inside Seed) is gated by `_ambSyncProgVis` on the area prog, via the `sub`-token
wrapper (`data-sub`).

*Chord matrix landed (2026-07-15):* per-layer **chord sequencer** against the
active progression — `L.chordMask = { steps: [prob 0-100 per chord], part:
{ size 1-100%, place start|center|end|random } }`, gated per note-onset by
`_ambChordGateOK` at every emitter (pitched sites piggyback the existing
per-onset chord resolution; drums gate on the global prog; the series arp
silences without stalling its cursor). Probability draws once per chord
INSTANCE and the random partial window re-rolls per instance — both via
deterministic (step, layer)-keyed hashes: zero shared-RNG draws, absent mask →
byte-identical (pins `chordmask-steps` 7a4c9c6a · `chordmask-part` fdef4148).
UI: Configure → a layers × chords grid (tap cells 100→60→30→0%; per-row Part
size/placement selects), shown only with an Area progression on.

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

*§5 deep half landed (2026-07-15):* `_ambEmitDescriptor` — the single dispatch
seam — now keys on the **GENERATOR** (`_ambGeneratorOf`) instead of the type
name; `type` survives only as the euclid family's store residue (bassPhase vs
runPhase). Derived generators reproduce the old switch exactly (harness 26/26);
an explicit `L.generator` override now re-realizes a layer at the emit seam —
custom layers are live at the engine level. (The ⇄ Re-realize header action and
the Add-menu Sound presets are the UI halves.)

*§5.1 Hold landed (2026-07-15):* the step-grid family (Texture, euclid
Beat/Bass/Arp) gains **Hold** — step-relative note length (N × the live grid
slot; 0 = the ms Length control), the shared control the Texture-Hold discussion
called for. Applied at every step-grid length site incl. ghosts; gated at 0 →
byte-identical.

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
  - *Landed (2026-07-14, v4):* `notes.type='prog'` folds into `keyOv {mode:'prog'}`
    at normalize (idempotent + ungated — an old build writing a notes-prog self-heals
    on next load; an existing keyOv is never clobbered). The Notes-menu prog picks
    write keyOv directly; picking a non-prog source clears a prog override (the old
    replacement UX). The keyOv prog return now carries colour sets (the one
    decoration the notes path had), keeping the fold lossless. `prog-bass` proves
    identity: its config migrates through the fold and hashes unchanged.
  - *Asymmetry FIXED (same change):* `_ambProgStepAt` takes the resolved SOURCE and
    walks per-chord `bars` from ITS chords (11 emit sites threaded), so variable-
    length chords work on layer progressions too — `keyov-varbars` pins layer ≡
    global (identical hashes). The ARP series fold (per-entry passes/dir — richer
    than a prog) is DEFERRED to its own design pass; series entries still resolve
    per-entry via `steps[].notes`.
  - *Arp-series design DECISION (2026-07-14, user-settled):* a series is **pure SEED
    bound to ONE key** — the layer's effective KEY (workspace → area → layer cascade),
    the same frame for every entry. Entries stop being arbitrary per-entry
    note-sources and become degree-based material (chords = degree voicings) within
    that frame; per-entry `passes`/`dir` stay as SEED/sweep params. **Key changes
    across a series are managed via AREAS** (each area carries its own KEY; the area
    sequence is the modulation timeline) — never inside the series. Payoff: change
    the area key and the whole arp follows; kills the per-entry scale/key sprawl.
    Migration STAGING PLAN (drafted 2026-07-15, build in a fresh session from a
    clean tree):
    1. **Pin first** ✓ (`arp-series-legacy`, 33952b9c): per-entry scales + mixed
       dirs/passes.
    2. **v5 derive** ✓: explicit-scale + plain-chord entries fold to
       `{type:'degs', degs:[{d,a}…]}` against the layer's effective key at load
       (idempotent/ungated; `_AMB_SCHEMA_VERSION` 5). `passes`/`dir` untouched.
       Prog graduation LANDED (v5b): entry resolution now routes THROUGH the
       layer — `_ambArpEntrySrc(L, entry)` resolves an INHERIT entry via
       `_ambNotesOf(L)` (keyOv → area → workspace), completing the cascade
       workspace→area→layer→entry — so a prog entry graduates to `layer.keyOv`
       at load (first wins; entry → inherit) and plays byte-identically
       (`prog-arp` pins it). The arp's progression is now visible in the Key
       card group. Wraps + customized chords (eff-intervals/muted) remain
       compat reads BY DESIGN (wrap = note-set + INSTRUMENT tones, not a key
       concern). Side effect, deliberate: a layer's keyOv/colors/rootPc/modeRot
       now decorate its inherit entries (they should — the layer's frame).
    3. **Emit switch** ✓ (no emitter change needed): a `degs` source flows through
       `_ambScaleIntervals`/`_ambSrcRootPc` (two new dispatch cases) — realized in
       the CURRENT key, anchored on the key root. Same-key realization is exact
       (`arp-series-legacy` byte-identical); two-key proof: C→D re-pitches all 52
       notes exactly +2 st. New explicit-scale picks self-heal (derived on the
       next normalize), so the editor rework is cosmetic, not correctness.
    4. **Editor simplification**: the series row's Notes button becomes a degree-set
       picker within the current key (no scale/prog submenus); the keyOv Key group
       (already shipped) is where the frame changes.
    5. **Areas = modulation**: verify with a two-area config (same series, different
       area keys) — the series must re-pitch across the boundary with no series edit.
  - *Companion decision (same session): AREA KEY LOCK.* Since areas are the
    modulation timeline, an area needs a 🔒 = snapshot-detach in place: freeze the
    area's key at its CURRENT effective value (copy the followed workspace key into
    keyRoot/keyScale, keyFollow=false) so changing the workspace key for a NEW area
    can't silently re-key established ones. Unlock = re-follow. Plus a GUARD: changing the
    workspace key while OTHER areas still follow unlocked warns and offers to lock
    them at their current key first ("Lock other areas / Change all / Cancel").
    Pure sugar over the existing detach path (harness-neutral); not yet built.
- **Phrases**: store pitches as **degrees** (derive from a sequence's saved scale/root);
  existing Seq layers default **Fixed** so playback is byte-identical.
  - *Landed for Seq units (2026-07-14):* each seed event carries `degs: [{d,o,a}]`
    (degree index · octave · accidental) parallel to `freqs`, derived presence-gated
    in `_ambSeqDeriveDegs` (normalize backfill + fresh capture) — NO schemaVersion
    bump needed (additive field, the keyOn/prog backfill pattern). Diatonic playback
    realizes stored degrees in the current key scale (byte-identical when the scales
    match — harness-proven; degree-true when they differ: a 3rd stays a 3rd).
    Reconstruction `capRoot + 12·o + capIv[d] + a` is exact, so a mis-guessed capture
    scale only shifts `a`, never the pitch. Editors that rewrite `ev.freqs` must
    `delete ev.degs`.
  - *Chord-locked landed too (2026-07-14, deliberate `seq-chordlock` re-baseline
    c90d8daf→5d9f97e6):* stored degrees COMP THE CHANGES — each degree re-anchors to
    the current chord root (even degrees = stacked-third chord tones from the chord
    itself; odd/missing = the key's degree walked from the chord root, per §2's
    borrow rule; `chordBorrow=false` snaps tensions into the chord). Register =
    nearest placement to the transposed capture (smooth); preserve re-roots by the
    lowest note's degree; reset reuses the chord-tone stacker. Verified: the captured
    C–E motif plays F–A over IV, all output diatonic. Notes without degs (nudged/
    legacy) and no-prog fall back to the Hz snap. CAVEAT the re-baseline exposed: the
    borrow walk reads the KEY scale, so a harness config pinning it must DETACH its
    key (keyFollow=false) — the original pin followed the live workspace scale.
  - *Locked/authored phrases too (2026-07-14):* every lock store (`layer.lockState`,
    `E.unit[key]`, `E.freeze[key]`) now snapshots `keyCtx {root, scale}` — the area's
    effective key at capture — and any layer's locked/authored phrase carries the
    same Harmony toggle (a select in the roll bar; picking a mode on an unpromoted
    seed preview promotes it first). Replay remaps per onset via
    `_ambLockHarmonizeFreq` → the shared seq machinery, resolving chordlock against
    the layer's own effective source (keyOv / global prog). Degrees are derived ON
    THE FLY from freq+keyCtx — deliberately NOT stored on lock notes, because the
    roll editors mutate `n.freq` in place (stored degrees would go stale at every
    edit site). Pre-feature locks have no keyCtx → permanently Fixed (lossless).
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
