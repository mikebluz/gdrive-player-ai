# Bloom Composable Layers — Design & Refactor Plan

Status: **in progress.** Phase 0 done; Phase 2a (derivation helpers) done; Phase 2c partially applied. See the implementation log.

## Implementation log

- **P0 — DONE (2026-07).** Empirical audit (rendered primary vs extras cards per type, diffed control stems) showed the schema-gap had already closed for Chords mode / Repeat / Times / Choke (absorbed by earlier schema work); the ONE remaining primary-only control was Bed's per-chord-voice tones (cvt-0..5). Extras Beds now get the same Chord-voices group (`_ambBedCvtHtml` injected in `_ambInstCardHtml`, wired per-instance in `_ambWireInst` writing `inst.chordVoiceTones`, which the voicing already read per-layer). Audit now reports zero primary-only controls for all four types. Harness green.

- **C3 — DONE (2026-07, schemaVersion 3, ONE-WAY).** The legacy `cfg.seqs`/`cfg.samples` arrays are retired: the migration gate widened to `_fromVer < 3` (idempotent per-entry copy heals any v0-v2 state), then normalize DELETES both arrays before stamping v3. `cfg.extras` is the single home for every layer; `_ambSeqList/_ambSampleList` keep their guarded legacy fallback only for unnormalized transient cfgs (the Shapes area builder). An older build opening a v3 project sees no Seq/Sample layers — the accepted C3 cost. Verified: full migration battery (v1→v3, idempotent, arrays gone, 0 duplicate emissions, cards/mixer/edit/create/delete), persist→reload→reload stable, invariant harness GREEN. User signed off C2 on real projects before this ran.

- **C2 — DONE (2026-07, schemaVersion 2).** `cfg.seqs`/`cfg.samples` entries are COPIED into `cfg.extras` as seed-typed layers (`type:'seq'/'samp'`, same ids → every `seq:<id>`/`samp:<id>` keying site unchanged); the legacy arrays are KEPT frozen for older builds. All enumeration/lookup goes through the new canonical helpers `_ambSeqList/_ambSampleList/_ambSeqById/_ambSampleById` (~30 sites swapped: tick dispatch, wantSet, mixer, renderers, wire getters, ramps, pickers, bar-lock, capture, solo, keyMaster, labels). The extras tick loop + card renderer SKIP the hosted types (the canonical loops own them — no double-dispatch; verified 0 duplicate emissions). Creation sites (Send-to-Bloom, add/clone sample & seq) now create extras-hosted entries; delete removes BOTH homes. Verified: v1→v2 migration + idempotent re-normalize, edits hit the live extras copy (frozen legacy untouched), cards/mixer unchanged, persist→reload→reload stable, invariant harness GREEN (byte-identical dispatch). **C3 (retiring the legacy arrays + duplicate builders) is GATED on real-project sign-off per §12.**

- **Card subsections regrouped by engine component (2026-07).** Every layer card's collapsible groups now mirror the §1 model: **Voice · Seed · Generator · Timing · Variation · Mix** (was Voice/Pitch/Unit/Rhythm/Variation/Mix). Schema-driven cards (`_AMB_LAYER_SCHEMA` + `_ambVoiceCtrls`) and the hand-built Seq/Sample cards both converted; the kit-voice group skip keys off `'Seed'` now. Render-only — control tokens/ids/wiring unchanged, harness green. Old persisted `groupsOpen` names go stale (groups just start collapsed once).

- **Shape layer type — REMOVED.** Dropped on load (+one-time toast) via the `extras` filter; the whole shape-layer subsystem deleted (~400 lines). Master **Shapes** section + **Shape It** kept.
- **Phase 0 — done.** `_AMB_SCHEMA_VERSION = 1` stamped on every area cfg in `_normalizeAmbientCfg` (the single migration chokepoint); `_fromVer` read at the top for version-gated migrations. "Layer-schema evolution rules" added to `CLAUDE.md`.
- **Phase 2a — done.** Read-only derivation helpers `_ambGeneratorOf(L, type)`, `_ambVoiceOf(L, type)`, `_ambSourceKindOf(L, type, cfg)` in `17-ambient.js`. Generator is computed **live** from `type` + sub-mode (`beat.gen`, `arp.euclid`) — NOT persisted — so a runtime sub-mode toggle stays correct. `type` is passed explicitly because primary layers (bed/motif/texture/beat) carry no `.type` field (it's in the cfg key). An explicit `L.generator`/`L.voice` wins (reserved for Phase-3 custom layers).
- **Phase 2c — partial.** `_ambIsCapturable` now keys off `_ambGeneratorOf` (capturable ⇔ generator ∈ {euclid, riff, pedal} or Unit-Sync). Byte-identical for all types **except** the euclid Arp fix below.
  - **Euclid Arp Bar-Lock fix (approved, intentional — NOT byte-neutral).** The old check tested `L.gen === 'euclid'` for arp, but arp's flag is `L.euclid`, so euclid arps were silently excluded from Bar Lock — contradicting the function's own comment, this doc, and the scheduler (which treats euclid arp as bar-native). Now a euclid Arp captures like a euclid Beat. **Not covered by the note-generation harness** (Bar Lock isn't hashed) → verify by ear that a euclid-Arp area still loops cleanly under Bar Lock.
- **Phase 2c — emit-dispatch router (extras) — done, harness-gated.** Added `_ambEmitDescriptor(L, type)` — resolves a layer to `{mode:'window'|'step', store, init, gm, ms, emit}`. The extras loop's 7 near-identical windowed if-blocks + the stepped fallthrough collapse to ONE uniform gate/freeze/capture path keyed by the descriptor. Byte-identical by construction (same emitter, anchor store, anchor init, gm/ms cushions, order per type); **harness covers it** — `withExtra(type)` runs arp/bass/run/pedal/drone through `c.extras`, plus the three prog configs. Key finding: generator `euclid` fans out to THREE emitters (bass/beat/arp), so the emitter is a `(generator × voice)` choice — the descriptor table is exactly the seam Phase 3 will resolve from `{generator, voice}`. NOTE the PRIMARY layers (`cfg.bed/motif/texture/beat`, lines ~6259) were deliberately left on their direct `stepLayer`/`windowLayer` calls: primary beat uses `ms=0.04` but extras beat uses `ms=0.03`, so they must NOT share the descriptor's cushion.
- **Phase 2c — timing funcs INTENTIONALLY left type-keyed (anti-kludge finding).** `_ambNaturalUnitSec` and `_ambLayerSubCount` are per-type PARAMETER lookups, not duplicated logic: bass/run/pedal have different bar clamps + defaults (min 8/16/16, default 1/2/1) despite generators euclid/riff/pedal, so a `_ambGeneratorOf` switch would collapse nothing — each branch still needs its own clamp/default/field. Converting would be churn + risk (these are Unit-Sync/Bar-Lock only, NOT in the harness battery) for zero structural gain. They'll be extended in Phase 3 when real custom layers exist to test against (a custom layer's natural unit derives from its generator + its own bars/hold fields).

**⇒ Phase 2c complete.** The two sites where the abstraction genuinely helped (capturability, emit dispatch) are converted + harness-green; the rest was correctly shaped already.

---

Original plan below.

## 0. Principles (anti‑kludge)

- **Layers are compositions, not hardcoded types.** A layer = a few orthogonal modules. The current 12 "types" become **presets** (named points in that space); a saved project layer is just a point → a **custom** layer.
- **Keep the generator cores byte‑for‑byte.** We expose the composition space the engine already occupies (note‑source, prog, ADSR, euclid, capture, unit‑sync, `when`, RNG are already shared); we do **not** rewrite the musical algorithms.
- **Backwards compatibility is an invariant we keep, not a migration project.** Legacy `type` derives the composition at load; output stays identical. Additive‑only fields; never repurpose a field's meaning.
- **The invariant harness (`23-bloom-harness.js`) is the gate.** Every step must keep it green (byte‑identical default‑path output); any intentional change is a deliberate, reviewed baseline bump — never silent drift.
- **`schemaVersion`** stamps snapshots so derivations run once and are idempotent/deletable.

## 1. The model

```
Layer = Voice  ×  Note‑source  ×  Generator  ×  Timing  ×  Variation  ×  Mix/FX
        (sound)   (pitch material)  (algorithm)  (when it fires) (gen‑specific)  (shared)
```

## 2. Module catalog

**Voice** (`voice`): `synth` (any instrument; pitched) · `kit` (drum map; unpitched) · `sample` (buffer: Drive/disk/**record‑live**; pitch = varispeed).

> **Shape layer removed.** The Bloom `shape` layer type is dropped — the master **Shapes** section (Grow → Shapes) already covers radial‑wheel shapes, and removing the Bloom variant eliminates the only non‑composable generator plus the fragile `#shape-pad` reparent‑into‑a‑Bloom‑card path.

**Note‑source** (`notes`, synth only): Scale (+ relative mode, colour sets) · Chord (form/root/inversion/custom) · Wrap · Progression (global‑inherit or per‑layer) · Degree (single scale tone) · Drone‑voicing.

**Generator** (`generator`, the preserved cores): `euclid` (pulses/steps/rotate/**voices**→poly) · `random` · `pad` (stack+strum) · `held` (re‑strike every *hold*) · `walk` (random‑walk + chord‑tone magnet) · `mutate` (self‑mutating pattern) · `riff` (fixed random loop) · `series` (ordered arp sweep) · `pedal` (single‑degree phrase) · `sequence` (replay Seed units) · `sampleChop` · `shape`.

**Timing** (`unit` + interval/length/bars/drift): family **Free** / **Bar‑locked** (N bars, → fractional) / **Cycle** (held); **Unit‑Sync** bridges to `bar`/`beat`/another layer's unit or sub‑unit via ratio.

**Variation**: generator‑scoped (dynamic panel — already is per‑type).

**Mix/FX** (already fully shared): `level`, `pan/space`, `mod` (VCA/VCO/VCF + shapes), `fx` (reverb/delay/dist/chorus/phaser/autopan), `tg`, `areaFadeMs`, `portamento`, `fine`, `when`.

## 3. Compatibility matrix (the anti‑kludge core)

| Rule | Constraint |
|---|---|
| **Voice → Source** | synth ⇒ note‑source required; kit ⇒ no source (drum weights), pitch controls hidden; sample ⇒ no source, pitch = varispeed. |
| **Generator → Voice** | `pad`/`held`/`walk`/`riff`/`pedal`/`series` ⇒ pitched only; `euclid`/`random` ⇒ pitched **or** drums; `sampleChop` ⇒ sample; `sequence` carries its own units. |
| **Generator → Polyphony** | `pad`/`held`/`euclid(voices>1)` ⇒ poly; `walk`/`riff`/`pedal`/`series`/`random` ⇒ mono. |
| **Generator → Timing default** | `euclid`/`riff`/`pedal` ⇒ bar‑locked; `pad`/`walk`/`mutate`/`random` ⇒ free; `held` ⇒ cycle; `series` ⇒ free. Unit‑Sync allowed; can't make a bar phrase "continuous free." |
| **Progression** | any pitched generator can take `source=prog` (bar‑aligned per‑onset); drums can't. |

A voice/source picker greys out illegal choices; a generator swap re‑defaults timing family + variation panel.

## 4. Presets = today's 12 types as compositions (coverage proof)

| Preset | voice | source | generator | timing |
|---|---|---|---|---|
| Bed | synth | scale/chord | pad | free |
| Motif | synth | scale/chord | walk | free |
| Texture | synth | scale/chord | mutate | free |
| Beat | kit | — | random *or* euclid | free/bar |
| Arp | synth | series *or* euclid pool | series *or* euclid(poly) | free/bar |
| Bass | synth (bass) | scale | euclid (mono) | bar |
| Riff | synth | scale | riff | bar |
| Pedal | synth | scale + degree | pedal | bar |
| Drone | synth | chord/voicing | held | cycle |
| Seq | synth | Seed units | sequence | free/sync |
| Sample | sample | — | sampleChop | free/sync |

(Shape removed — see §2.) Every remaining type is a point in the space → the model **provably preserves all functionality** and unlocks new combos (euclidean melody, series arp on a drum voice, walk over a progression…).

## 5. Timing interoperability, Areas, and Bar Lock — **all kept**

Cross‑layer timing structure is a separate stratum from a layer's composition; the composition change does **not** touch it.

- **Interop = Unit‑Sync (reference + ratio)** in the Timing block: a layer syncs to `bar`/`beat`/another layer's **unit** or **sub‑unit** (arp entries, drone holds, euclid/riff/pedal bars, seq units), with a cycle‑guard against reference loops. This becomes uniform across *all* generators (today some are gated by type) — so "walk melody locked to the bass's bars" is a first‑class option.
- **Bar Lock — kept.** Capture the bar‑rational, deterministic layers over their LCM loop and repeat verbatim while free layers improvise. Only change: **capturability derives from `{generator, timing}`** instead of the type name (see §7 remap). Coarse mapping now (harness‑safe); optional refinement later ("deterministic over its phrase" — depends on generator + variation).
- **Areas — kept entirely.** Per‑area layer sets, Single/Sequence orchestration, Plays×Bars, per‑area fade, gapless depart/reconcile transitions, `_playIdx` decoupling. Areas hold layers of any composition; the scheduler never looks inside a layer.

## 6. Backwards compatibility

- Add first‑class `generator` / `voice` fields (source already lives in `notes`/`kit`/`sampleId`). On normalize‑load, a legacy layer with only `type` **derives** them from the §7 map. Dispatch reads the abstraction (falls back to type) → **same core, byte‑identical → harness green.**
- A loaded legacy layer shows as its **matched preset** if config == preset defaults, else **"Custom (from X)."** Reinterpretation, not lossy migration; `schemaVersion` makes the derivation run once.
- Old build reading a new project: unknown fields are normalized away (safe). Hard rule: **never repurpose an existing field.**

## 7. Phase‑2 refactor plan (the load‑bearing internal change)

Goal: introduce the composition abstraction; **presets == today exactly**; zero user‑visible change; harness green. No UI unlock yet.

**2a. Add fields + derivation.** Add `generator`, `voice` to the layer schema/defaults. In `_normalizeAmbientCfg` (+ `_ambDefaultLayer`), derive them from `type` when absent. Add helpers `_ambGeneratorOf(layer)`, `_ambVoiceOf(layer)`, `_ambSourceKindOf(layer)` (read fields; for `beat`/`arp`, resolve the sub‑mode: `beat.gen`, `arp.arpeuclid`).

**2b. The derivation map** (type → composition):

| type | generator | voice | source | timing | capturable | sub‑unit |
|---|---|---|---|---|---|---|
| bed | pad | synth | scale/chord | free | no | 1 |
| motif | walk | synth | scale/chord | free | no | 1 |
| texture | mutate | synth | scale/chord | free | no | 1 |
| beat·random | random | kit | — | free | no | 1 |
| beat·euclid | euclid | kit | — | bar | yes | bars |
| arp·euclid | euclid | synth | euclid pool | bar | yes | bars |
| arp·series | series | synth | series | free | no | entries |
| bass | euclid | synth | scale | bar | yes | bars |
| run | riff | synth | scale | bar | yes | bars |
| pedal | pedal | synth | scale+degree | bar | yes | bars |
| drone | held | synth | chord/voicing | cycle | no | holds |
| seq | sequence | synth | units | free/sync | varies | units |
| sample | sampleChop | sample | — | free/sync | no | 1 |

**2c. Refactor the `switch(type)` sites to read the abstraction** (behavior identical):
- Emit dispatch (the `_ambEmit*` router) → `switch(_ambGeneratorOf)`.
- `_ambIsCapturable` → `timing bar‑locked/synced && generator ∈ {euclid, riff, pedal, series‑euclid}` (matches today's set exactly).
- `_ambLayerSubCount` → by generator (entries/holds/bars/units/1).
- `_ambNaturalUnitSec` → by generator/timing (bars×barSec+pad · hold×unitSec · totalNotes×interval · 16×stepSec · natural interval · unit/manual).
- Per‑generator default timing family + the schema/UI param groups.

**2d. Presets.** Add‑menu offers the 12 presets (each sets `type` + defaults as today) — UI unchanged for the user. No "Custom" entry yet (Phase 3).

**2e. Persistence.** `generator`/`voice` are derivable, so saving them is optional; include them + `schemaVersion` for forward‑clarity. Confirm all load paths funnel through `_normalizeAmbientCfg` (Drive load, localStorage restore, `_cloneLane`, undo snapshots, Send‑to‑Bloom, Shape‑It).

**2f. Harness.** Run `23-bloom-harness.js` before/after; configs still reference `type` (kept), dispatch resolves to the same core with identical params → **baseline hashes unchanged**. That's the proof the refactor is lossless.

**Files:** primarily `17-ambient.js` (schema/defaults/dispatch/switch‑sites/add‑menu), `11`+`14` (optional field persistence + schemaVersion), `23` (verify). No new audio nodes; no scheduler changes.

## 8. Rollout

- **Phase 0** — schemaVersion + "layer‑schema evolution rules" in CLAUDE.md.
- **Phase 2** — this refactor (presets == today), harness‑gated.
- **Phase 3** — unlock axes in the UI (voice‑swap + source‑swap first, then generator‑swap) + "Custom" add option, gated by §3 matrix.
- **Phase 4** — additive vision features (fractional euclid bars; melody loop‑length for walk/mutate; chord arp‑toggle; bar‑start offset), each harness‑neutral by default.
- **Phase 5** — Shape/Seq(keyMaster) decisions; optional capturability refinement.

## 9. Open decisions (recommended defaults assumed)

1. **Shape** — **REMOVED** (master Shapes section covers it). Existing Bloom shape layers handled on load per the chosen back‑compat rule (drop+toast recommended).
2. **Kit "source"** — drum‑piece weights live on the Kit voice, not as a note‑source. *(assumed yes)*
3. **Unlock order** — voice+source first, generator later. *(assumed yes)*
4. **Labeling** — matched‑preset name when config == defaults, else "Custom (from X)." *(assumed yes)*
5. **`sequence`/keyMaster** — preserve keyMaster + unit/return variation as generator‑specific options. *(assumed yes)*

## 10. Model v2 — the **Seed** axis + variation modes (adopted 2026‑07)

A refinement that de‑kludges Seq/Sample and folds Mutate. The model becomes:

```
Layer = Voice × Seed × Generator × Timing × Variation × Mix/FX
                 └─ Random → (Note-source: scale/chord/wrap/prog/degree)
```

- **Seed** = the raw MATERIAL a generator works from:
  - **Random** — procedurally generated; parameterized by a **Note‑source** (the pitch pool). = today's generative layers.
  - **Sequence** — an authored phrase from the Seed page. = today's Seq layer.
  - **Sample** — an audio buffer. = today's Sample layer.
  - **Capture** — a grabbed live phrase. *(future)*
- **Note‑source stops being a top‑level axis** — it's a *parameter of `Seed=Random`* (meaningless for Sequence/Sample). This is why it felt awkward on those types.
- **Seq and Sample stop being special "types"** — they're layers with `Seed=Sequence` / `Seed=Sample`. Major de‑kludge.
- **Compatibility:** `Seed=Sample` ⇒ `Voice=sample` (bound — decision 6) + chop‑family generator; `Seed=Sequence` ⇒ synth/kit + replay generator; `Seed=Random` ⇒ any generator + a note‑source.
- **Readout:** the middle chip is **Seed** (Random shows its note‑source name; Sequence shows "Seq"; Sample shows "Sample"): `Synth · Scale · Euclid`, `Synth · Seq · Replay`, `Sample · — · Chop`.

**Variation modes — Mutate folds here.** A pattern generator's Variation carries a **mode**: `static / re‑roll / evolve` (+ per‑note jitter). **Riff = re‑roll, Mutate = evolve** — same "play a fixed pattern loop" idea, different variation strategy. So Mutate is **not** a standalone generator; it's the *evolve* mode. `evolve` should also become available on Euclid/Series patterns (Phase 4).

**Rollout of v2:**
- **10a (done in Phase 3 UI):** picker folds Riff+Mutate into one **Pattern** generator + a **variation‑mode chip** {Re‑roll → `run`, Evolve → `texture`}. The two EMITTERS stay distinct for now (harness‑green — no audio change); this is the *model/UI* fold.
- **10b (Phase 4):** truly unify the `run`/`texture` emitters into one pattern generator whose `mode` param does re‑roll vs evolve over one shared phrase representation (a reviewed baseline bump). Then `texture` type is retired to a preset.
- **10c (Phase 4):** Seq/Sample → Seed types (biggest change; own phase).

6. **Sample Voice binding** — `Seed=Sample` forces `Voice=sample` for now; a fully independent Voice×Seed (sample slices re‑pitching a synth, a Sequence driving a sample) is a **follow‑up**. *(decided)*

## 11. Execution status + remaining plan (2026‑07)

**Done (branch `bloops-next`):** Phase 0/2 complete; Phase 3 axis pickers (Voice·Source·Generator + Riff Re‑roll/Evolve); **Phase 4 euclid DECOMPOSITION** — `_ambEmitEuclidCore` (shared onset engine) + `_ambEmitEuclid` (voice‑selected render), true Voice swap (no template switch, rhythm preserved), Kit Drum picker on all beat/kit layers, kit‑card hides pitch controls. All harness‑green.

**Remaining — three tracks, roughly increasing risk:**

- **A. Spread the decomposition** to the other generators (walk/pad/held/series/riff) the same way (onset/note core + voice render). Mostly synth‑only (drums need a rhythmic generator), so lower marginal value than euclid; each is a harness‑gated slice.
- **B. Sample voice on a rhythmic layer (contained Sample unlock).** Add a `voice:'sample'` render branch to `_ambEmitEuclid` (+ the random beat): each onset triggers a chosen `sample:<id>` (one‑shot, like a drum but a custom buffer), with a sample picker in the card. Does NOT merge the `cfg.samples` subsystem — just lets an existing euclid/beat layer *use* a sample as its voice. Harness‑safe (euclid/beat defaults carry no sample voice). This gives the disabled "Sample" option real meaning for the common case.
- **C. Seq/Sample → Seed types (§10c, the full de‑kludge).** Fold `cfg.seqs` + `cfg.samples` into the general layer model as `seed:'sequence'|'sample'`. BIG: touches `_normalizeAmbientCfg` migration, save/load (existing projects have `cfg.seqs`/`cfg.samples`), the three separate card renderers, and the `samp:`/`seq:` keying. NOT ear/harness‑verifiable end‑to‑end → needs staged execution with real project load/save tests, additive‑only migration, and a rollback‑safe schemaVersion bump. Do LAST, deliberately.

Recommended order: **B** (contained, high‑value, unlocks Sample for the common case) → **A** (breadth) → **C** (the deep merge, planned as its own project with load/save regression testing).

**Status update:** B done (Sample voice on euclid + random beat), A done for the rhythmic generators (random beat kit/sample), Seed framing + `_ambSeedOf` + Seq/Sample readouts done. Only **C** remains.

## 12. Track C migration plan (Seq/Sample → Seed layers)

**The risk:** this rewrites how `cfg.seqs` / `cfg.samples` are stored, so it touches **save/load of existing projects** — NOT harness‑ or ear‑verifiable. Surface: `_normalizeSeqLayer`/`_normalizeSampleLayer` + defaults; two dispatch loops in `_ambTick` (seqs ~L6365, samples); the two card builders; ~34 `seq:`/`samp:` keying sites; and per‑area persistence (the area cfg is JSON‑spread into the `masterBloomAreas` snapshot, so any field on the cfg persists automatically — no save‑code change needed).

**Invariant:** additive‑only; keep `cfg.seqs`/`cfg.samples` intact until the final cleanup, so an older build still loads a new project and a bad step is revertible by not advancing `schemaVersion`. `_normalizeAmbientCfg` is the ONLY migration site.

**Per‑stage user verification (harness can't cover this):** load a project containing Seq + Sample layers → they render + play identically; **save → reload → stable**; undo/redo intact; Drive load intact.

- **C0 — Seed field (safe, additive).** Stamp `seed` on every layer in normalize (generative → `'random'`; seq/sample keep their identity). schemaVersion bump. No dispatch/UI behavior change. *Ship + load/save test alone.*
- **C1 — seed‑aware GENERAL layer (additive capability).** Let an `extras` layer carry `seed:'sequence'|'sample'` (+ its `units`/`sampleId`) and dispatch via a seed‑aware emit that reuses the EXISTING seq/sample emitters. New layers can be a sequence/sample source; legacy `cfg.seqs`/`cfg.samples` still live in their arrays + render via their existing path. **Two paths coexist** — no data moved yet.
- **C2 — migrate legacy arrays → extras (THE risky step).** In `_normalizeAmbientCfg`, gated on `_fromVer < N`, COPY each `cfg.seqs`/`cfg.samples` entry into `cfg.extras` as a seed‑typed layer, **keeping the old arrays too** (additive). New build reads the migrated extras; old build still reads the arrays. Migrated layers keep `seq:`/`samp:` keys to avoid touching the 34 keying sites. *Heavy load/save regression here.*
- **C3 — retire the duplicates (cleanup, last).** Only after C2 is proven across many real projects: remove the separate dispatch loops + card builders + the legacy arrays. schemaVersion bump; one‑way from here.

Execute strictly in order; each stage is its own commit + your load/save sign‑off before the next.

## 13. Primary→extras unification plan

The 4 built‑ins (bed/motif/texture/beat) render from a **hardcoded template** (~12240+) with 50‑73 fixed‑id controls each, wired individually (`set(...)` + change handlers), and dispatched by 5 explicit `stepLayer`/`windowLayer` lines. Extras render from `_AMB_LAYER_SCHEMA` + generic `ctrlHtml`/wiring. The split forces every layer change twice (readout, drum picker, etc.). Persistence: the built‑ins live on the area cfg as `cfg.bed/motif/texture/beat`, JSON‑spread into the `masterBloomAreas` snapshot — so migrating them touches **save/load**.

**Key finding:** the extras schemas DON'T cover everything the templates do (e.g. bed's Chords mode / Repeat / Times / per‑chord‑voice tones / Choke are template‑only). So the gap must close first.

- **P0 — close the schema gap (SAFE, additive, no save/load).** Audit each primary template vs its extras schema; add the missing controls (+ generic `ctrlHtml`/wire handlers, incl. the complex per‑chord‑voice tones) so an EXTRAS bed/motif/texture/beat is as capable as a primary one. Valuable on its own (full‑featured added layers). Verify: add each as an extra, confirm every control present + working. Harness‑neutral.
- **P1 — migrate primary→extras on load (additive, save/load‑gated).** In `_normalizeAmbientCfg`, gated on schemaVersion, COPY `cfg.bed/motif/texture/beat` into `cfg.extras` (stable ids), KEEPING the cfg fields (additive). Render from extras; template hidden. Heavy load/save regression (existing projects, undo, Drive).
- **P2 — retire the template + dispatch + wiring (cleanup, last).** After P1 proven: delete the hardcoded template, the 5 dispatch lines, the ~264 `set()`/wire sites, `_ambAddLayer`/`_ambRemoveLayer` (present‑flag), and the `cfg.bed…` fields. schemaVersion bump; one‑way.

Start with **P0** (safe, self‑contained, improves added layers regardless of whether P1/P2 ever land).
