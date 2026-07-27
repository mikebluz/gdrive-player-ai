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
- **Harmony take-reroll** (generative): `cfg.prog.reroll` (0-100) = the chance each
  chord is swapped for a SAME-FUNCTION substitute when 🎲 New take rolls — relative
  minor/major, mediant, up-a-fourth, or a 7th/9th colour. Derived from the take seed,
  so a take is reproducible; resolved at read time, so the authored progression is
  never altered (set the amount to 0 to hear it as written). Substitutions must stay
  inside the key, or — on a keyless area — inside the progression's own note pool.
  The 🧂 readout names what the take did. Consumes no shared-RNG draw.
- **Chaos ramps** (generative): `wave: 'random'` on any per-layer ramp — smooth
  hash-seeded value noise (one new target per period, cosine-eased), drifts
  forever without repeating, deterministic per ramp id (Bar-Lock replays the
  same drift), consumes no engine RNG.
- **FX module** (per-layer): one registry (`_AMB_FX_DEFS`), layers carry an
  `fxChain` — cards render only ADDED effects + an "＋ Add FX" picker; legacy
  chains derive from engagement. Engine untouched.
- **Delay stereo Spread + Dry Kill + layer Wet Only** (Tier A + emit): the core
  delay gained a `dly_spread` (0–100 → Haas offset on the wet R output tap, on top
  of Ping-Pong; neutral@0) and a post-send `main` output gain (`strip_mainout`) that
  the layer **Wet only** toggle drives to 0 — muting the dry/in-line output while the
  parallel reverb send rings. Per-FX **Dry kill** (Delay/Chorus/Phaser/Dist/Auto-Pan)
  forces that FX fully wet (`_wet01`); with ≥1 in-line FX, Wet only forces them all
  wet=1 so the chain carries no dry — **except Distortion, which Wet only leaves at
  its own Mix** (a waveshaper adds no tail, and its curve is a level normalizer, so
  forcing it wet made a quiet layer jump to full loudness — see the gotcha in
  CLAUDE.md). A dist-only layer therefore takes the `strip_mainout` mute path.
  **Pitch echo** gained a **Spread** (pans echoes
  alternately L/R). All default off/0 → CORE_REV 11, golden 75/75 WITHOUT re-baseline.
  Node fallback honors Dry Kill / Wet-only-via-wet=1 and now has its own `main`
  output gain (`e.mainOut`, lazily built) so it mutes the dry like the core does;
  delay Spread is core-only.
- **Unit Schedule** (per-layer, scheduler-level): tapping a unit block in a layer's
  ⏱ Scheduler lane opens **Edit Unit Schedule** — the unit is cut into 2–64 equal
  slices (the popover names the musical value: "16 slices of a 2-bar unit = 1/8
  notes") and each slice toggles on/off. Gates are stored PER UNIT and repeat
  (`slots[i % period]`, period seeded from what the lane draws); **Apply to →
  all / every 2nd / 1:3 / 1:4** propagates the pattern, growing the period to an
  exact multiple. Two modes: **skip** drops note ONSETS in the off slices (sustains
  ring out — a playback filter applied after the capture, so it stays editable live
  on a frozen Write loop) and **chop** silences the layer's output across them
  (cutting sustains). Chop rides core param 5 / a node gain via one scheduler, both
  post-levelGain so the reverb send rings through the hole. Distinct from the
  **Trance Gate**, which is bar-synced and always an audio chop; this one is
  unit-synced and per-unit. `layer.unitGate`, absent by default → harness untouched.

- **Distortion tone stack** (Tier A): `strip_dist` gained **Focus** (0–100, 0 =
  off) — a pre-shaper high-pass sweeping 30 Hz → 600 Hz, so the low end stays out
  of the drive and chords keep their definition instead of turning to mud — and
  **Tone** (0–100, 50 = flat) — a post-shaper tilt, below 50 a lowpass down to
  400 Hz (dark), above 50 a highpass up to 2 kHz (bright). Both are Butterworth
  (Q −3 dB) and, crucially, act on the **wet path only**: at a partial Mix the dry
  lows sit untouched under a filtered dirty top (measured — Focus 100 cuts 100 Hz
  by 31.7 dB at Mix 100 but only 4.7 dB at Mix 40, and 0 dB at Mix 0). Coefficients
  are computed in `strip_dist`, not per block — unlike the vcf, nothing modulates
  them. `dist.tone` / `dist.focus`; UI sliders between Drive and Mix. The two new
  ABI args are **i32, deliberately**: a missing wasm argument coerces to 0 for an
  integer but NaN for a float, so any caller still on the 5-arg signature keeps
  rendering the neutral path. CORE_REV 12; golden 75/75 unchanged + 5 NEW sections
  pinning the filtered paths. Core-only — the node fallback can't do wet-only
  filtering without a parallel dry/wet split (Tone.Distortion mixes dry
  internally), and Bloom's exports capture the live core output.
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
