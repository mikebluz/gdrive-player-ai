# Bloom FX Roadmap — API audit + feasibility catalog

What's possible for new effects given the engines we've built, and in what order
to build them. Companion to the layer-model docs. (First slice — **reverb
characters** — shipped with this doc.)

## 1. The constraint audit — three tiers of "where DSP can live"

**Tier A — per-layer strip FX (WASM core).** Under `bloopsCoreStrips` (default
ON) each layer's FX chain runs inside the Rust worklet via `strip_*` port
commands (`strip_dist/chorus/phaser/delay/autopan`), with a Tone-node fallback
kept in `_ambApplyLayerFx`. **A new per-layer FX type = Rust DSP + a golden
re-baseline + the node fallback written twice.** Expensive; also perf-sensitive
(the adaptive-oversampling / lazy-insertion learnings exist because per-layer
DSP glitched dense stacks). Add here only when an effect truly must be
per-layer.

**Tier B — engine/master node FX (Tone.js + raw WebAudio).** The shared reverb
(`_ambEnsureReverb` → `Tone.Convolver` + `_makeReverbIR`), the master chain
(Warmth/Width/Dynamics + the global FX rack in 03), and anything ONE-per-engine
is node-side even under core strips (the strip send bus routes into it). **One
instance per engine = no dense-stack perf risk, no golden impact.** This is the
sweet spot for variety.

**Tier C — Harvest offline (OfflineAudioContext).** The capture processing
suite (reverse/pitch/reverb/delay) renders offline — zero realtime constraint,
so anything is possible here: spectral tricks, granular, convolution abuse.
Best for heavy or experimental effects.

Available primitives already in the codebase: synthesized-IR convolution
(`_makeReverbIR` — now character-parameterized), waveshaping (dist),
comb/allpass (Freeverb), the 40 Hz **ramp clock** (any cfg param becomes an
LFO target), the **per-cycle seeded RNG** (`_ambSeededRand` in the step-grid —
deterministic stochastics), the trance-gate scheduler (bar-synced stepped
gain), grain playback (sample slicing), and offline render→WAV→bank.

## 2. Shipped

- **Reverb characters** (Tier B): `_makeReverbIR(decay, tone, type)` — `lush`
  (the original) · `room` · `hall` · `cavern` · `plate` · `spring` · `gated` ·
  `air`. All synthesized (no assets), all respond to Size/Damp, selected
  per-AREA via `cfg.reverb.type` (Configure → Global FX → Reverb → Character).
  Cavern/room bake **stochastic early reflections** — every IR build is a
  slightly different space.
- **Vinyl simulator** (Tier B, master stage in 03): synthesized 4 s looping
  crackle/hiss/rumble bed (Poisson pops — every bed unique), wow (0.45 Hz) +
  flutter (6.4 Hz) pitch wobble via a modulated delay, and Age-scaled wear
  darkening. `globalFx.vinyl*`; UI in Bloom Global FX (On/Amount/Age).
  Neutral-off: delayTime 0 = no latency.
- **Tape echo** (Tier B, master stage): a feedback delay with degradation IN
  the loop — each repeat re-saturated (tanh), darkened (4.2 kHz LP), and
  wobbled — which the stock FeedbackDelay can't do. Off starves the loop so
  the tail rings out. `globalFx.tape*`; UI On/Mix/Time/Feedback/Wobble.
- **Chaos ramps** (generative): `wave: 'random'` on any per-layer ramp — smooth
  hash-seeded value noise (one new target per period, cosine-eased), drifts
  forever without repeating, deterministic per ramp id (Bar-Lock replays the
  same drift), consumes no engine RNG.
- **FX module** (per-layer): one registry (`_AMB_FX_DEFS`), layers carry an
  `fxChain` — cards render only ADDED effects + an "＋ Add FX" picker; legacy
  chains derive from engagement. Engine untouched.
- **Distortion flavors** (Tier A — the first core-DSP addition): `strip_dist`
  gains a `dist_mode` — Classic (the original curve, default, golden-covered
  byte-identical) · Overdrive (warm tanh) · Fuzz (asymmetric clip + crossover
  sputter) · Wavefold (triangle fold) · Crush (bit-depth quantize). Per-layer
  Type select in the Distortion FX block; `dist.flavor` (absent = classic).
  Node-fallback engine keeps the classic curve. CORE_REV 9; golden 75/75
  WITHOUT re-baseline (the default path is untouched).

## 3. Feasibility catalog (ranked cheap → expensive)

| Effect | Tier | How | Notes |
|---|---|---|---|
| **Reverb characters** | B | IR synthesis variants | ✅ shipped |
| **Drifting reverb** (generative) | B | re-roll the IR every N bars (the debounced `_revIRKey` regen machinery already exists) | risk: audible click on live Convolver buffer swap — needs a 2-convolver crossfade |
| **Distortion flavors** (overdrive/fuzz/fold/crush) | A | ✅ shipped — `dist_mode` in the core `strip_dist`, additive/golden-safe | |
| **Vinyl simulator** | B (master) | noise bed + crackle impulses (Poisson-timed) + wow/flutter (slow Vibrato) + LP + rumble | all stock Tone nodes; crackle density/age as the knob; naturally stochastic |
| **Harmonic phaser** | B (master) | allpass stages tuned to HARMONIC ratios of the area KEY root (retune on key change) | distinctive: an FX that reads the harmonic frame — very "Bloom" |
| **Grain delay** | C first, then B | offline: chop the tail into grains, re-scatter with jitter/pitch; realtime: AudioBufferSourceNode grain cloud fed by a tap recorder | realtime version is a mini-engine; prove musically in Harvest first |
| **Tape/BBD delay** (wobble, saturation in the loop) | B (master) | FeedbackDelay + Vibrato + soft shaper inside the loop | cheap, big character |
| **Shimmer reverb** (true pitch-shifted feedback) | B | PitchShift → Convolver → feedback loop | Tone.PitchShift is CPU-heavy; one instance per engine is fine, gate it on engagement |
| **Spectral freeze / blur** | C | offline FFT (or long-window granular smear) in Harvest | pairs beautifully with the Arrange editor |
| **Per-layer new FX** (bitcrush, ring-mod, comb) | A | Rust `strip_*` + node fallback + golden re-baseline | do as ONE batch when a per-layer slot is truly needed |

## 4. Stochastic / generative inventions (the distinctive angle)

These exploit machinery that already exists rather than importing standard FX:

1. **Evolving space** — reverb character whose IR re-rolls per area-cycle
   (seeded like the step-grid, so Bar-Lock replays the same room). The "room
   itself" becomes a generative layer. Needs the 2-convolver crossfade.
2. **Seeded sputter** — a trance-gate variant whose step pattern re-rolls
   per cycle from `_ambSeededRand` (deterministic per cycle, evolving across
   cycles) — the gate becomes a rhythm generator.
3. **Probability sends** — per-onset chance that a note's reverb/delay send is
   boosted (echo *some* notes). Emit-time (params already carry sends), no new
   DSP at all; pure Variance-axis.
4. **Chaos ramps** — a `wave: 'random'` (smooth-noise) option for the per-layer
   ramp system; the ramp clock already exists, this is one new wave shape.
5. **Key-tracked FX** — the harmonic phaser above; also a comb "drone-body"
   tuned to the root (resonates the key).

## 5. Recommended order

1. ✅ Reverb characters (shipped).
2. **Vinyl sim + tape delay + distortion flavors** on the master/global rack —
   pure Tier B, stock nodes, immediate variety.
3. **Chaos ramps + probability sends** — tiny, pure-generative, no DSP.
4. **Harmonic phaser** (key-tracked) — medium, one per engine.
5. **Grain delay in Harvest** (offline proof) → realtime port only if it earns it.
6. **Evolving space** once the crossfade-swap primitive exists.
7. Per-layer core FX batch (Tier A) last, as one deliberate golden re-baseline.
