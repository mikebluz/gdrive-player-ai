# Audio engine traps — voices, performance, the WASM core

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before any audio-path, voice, routing, or DSP change.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

### Audio engine, voices, performance

- **NEVER swap the live Tone context with `Tone.setContext()`** — in Tone 14.9.17 it updates
  `Tone.getContext()` but not `Tone.context`, and this codebase uses both idioms. Diagnose a split by
  comparing `Tone.context.rawContext.currentTime` against `Tone.getDestination().output.context`.
- **Never reintroduce synth-body pooling** (removed 2026-07) without passing an oscillator-leak test —
  pooled retriggers leak running native oscillators, which is GC-protected and renders forever. Every
  note builds a FRESH synth; the deferred build queue absorbs the cost.
- **Scheduled-ahead voices BUILD via a deferred time-sliced queue inside `playNote`** — any new
  cancel/stop path must purge it, emit-tag globals are captured per entry, and the queue must be OFF
  during an offline render (it runs on a wall clock that does not advance).
- **Never connect a modulator signal into a biquad filter param, and never run continuous ramps on
  one** — it forces per-sample coefficient recompute (measured 0.82× realtime). Schedule stepped /
  5 ms-glide curves instead. Unmodulated filters stay biquads; modulated ones are ZDF SVFs.
- **Never schedule per-note automation on a long-lived AudioParam** — the timeline accumulates and
  glitches until the node is disposed. Use a connected LFO/Signal or per-voice nodes.
- **The voice budget is a DSP COST budget and adapts to the measured audio clock** (`[bloom-health]`).
  A swinging clock with `cost` at 1-2 is CPU starvation of the render thread, not a Bloom bug.
- **Per-layer DSP must be lazy** — Distortion/Delay/EQ3 are spliced in only when engaged; always-on
  nodes at flat settings glitch a 5-layer project.
- **Levels are not matched across voices** (`duo` 1.92, `mono` 2.16, `bass` 2.21, `am`/`pad` ~−16 dB
  against ~0.97 for the basic waves). `layer.voiceTrim` (dB) is the control, applied in `_ambApplyAdsr`
  so both engines honour it. Bloom `level` is a continuous GAIN node (`e.levelGain`), not a per-note volume.
- **Samplers are REGISTERED, not loaded** — `sampleSamplers` entries carry `sampler` as a lazy getter
  (boot went 837 requests/37.8 MB → 1/0.1 MB). Never touch `.sampler` in a sweep or diagnostic; read
  the property DESCRIPTOR. The cold-sample "sine stand-in" must not reach a generated or long note.
- **A drumKit note must never take the shared-sampler fallback** — it is untracked, routed straight to
  `globalSendTap`, and therefore UNSTOPPABLE (the "errant drum hits after stop"). Once the kit is
  loaded it falls back to the nearest DEFINED zone instead.
- **The cold press warms up first** (`_ambPlayPress` → `_ambWarmUp`): await `running`, build and AWAIT
  every referenced sampler, `_ambSyncMods`, then one silent note per distinct voice. Cold-only, capped.
- **Area transitions** depart each layer to a `#dep` key (cancel pending, gate-fade, then stop and
  dispose), and voices are RE-TAGGED synchronously at depart time so ownership is structural rather
  than a float comparison. Bar-native layers hard-cut; only Free layers fade.
- **The bounce is a REAL-TIME capture**, not an offline replica — the offline path was a second
  implementation of the whole mix and kept diverging silently. `window._bloomBounceOffline` still
  exists and drives the ⚖ compare tool. If you touch it: the master chain, buses, strips, samples,
  trims, limiter and clipper must ALL be reproduced, and a one-layer test cannot see a `1/sqrt(N)` trim.
- **Bus = where a layer ENTERS the master chain** (`full`/`postwarmth`/`postvinyl`/`direct`), plus its
  own FX sends into the shared returns. The chain is serial and shared, so per-effect switches are not
  physically possible. `routeBloomBus` disconnects, so it must RE-ATTACH the sends.
- **Extending a `strip_*` wasm export: make new args `i32`, never `f32`** — a missing argument becomes
  `0` for an int and `NaN` for a float, so design the new param so 0 is neutral.

## The WASM audio engine (bloops-dsp)

Bloom voices, layer strips/FX, and sample playback render in a Rust→WASM core (`dsp/`, built by `dsp/build.sh` → `js/bloops/core/bloops-dsp.wasm`) inside ONE AudioWorklet (`js/bloops/core/voice-processor.js`, bridged by `js/bloops/03b-core-voices.js`). **Default ON** — `window.bloopsCore(false)` / `window.bloopsCoreStrips(false)` are the kill switches (persisted localStorage `'0'`); the Tone node engine remains the automatic fallback (cold start, ineligible notes, slot exhaustion, pads/held notes, offline export). Rules:

- **Any DSP change must keep `node test/golden-render.js` green** (82 bit-exact sections); an
  intentional audio change re-baselines with `--update` IN THE SAME COMMIT. `dsp/build.sh` runs the
  gate after every build. Check the blast radius: only the sections you meant to move should drift.
- **Calibrate against RECORDED node output, never derive from Tone internals** (proven wrong
  repeatedly). Known engine truths: native lowpass/highpass biquad Q is in dB; `Tone.LFO/Signal.connect`
  ZEROES the destination param; cycle-member DelayNodes keep true delay with the quantum penalty on the
  feedback edge; `Tone.Panner` is channelCount 1 (a mono downmix — which is why the core strip has its
  own width-preserving pan law, and why per-note pan gives a layer no audible spread on the node path).
- **The worklet must always stay pulled** (keep-pull sink on output 16) and `init()` must reset ALL
  core globals, or golden loses determinism. That send bus is GLOBAL — one summed send feeding ONE
  reverb, re-claimed by whichever engine builds strips.
- **DSP hygiene:** every RECURSIVE write (biquad state, delay/chorus feedback) goes through `flush()` —
  strips process silence 24/7 and WASM has no FTZ, so unflushed feedback decays into subnormals.
  High-Q filters route through `df2t_sat`/`g_sat`. The DC blocker runs only on the ASYMMETRIC dist
  flavours (fuzz/fold/crush); classic and overdrive are odd-symmetric and golden-pinned. Saturation is
  ADAA on classic/overdrive only — 2× oversampling was built, measured (+3.5 dB mean, one case WORSE,
  ~2.5× the CPU) and REJECTED. `dist_adaa_dirty` must be set by any new writer of a dist curve param.
  Do NOT add `+simd128` (measured regression).
