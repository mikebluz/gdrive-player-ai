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
- **FX ON THE DELAY'S REPEATS IS A LOOP INSERT, NOT A CHAIN POSITION.** `strip_dlyfx` processes the
  signal written INTO the delay line, so the dry note is untouched and every pass applies it again
  (the tail dissolves). Chain order cannot express that — a stage AFTER the delay damps every repeat
  equally, which is the measurement that tells the two apart (`test/probe-repeat-fx.js` compares the
  repeat-1 and repeat-3 ratios). Saturation in a feedback loop must be ODD-SYMMETRIC: the DC blocker
  runs only on the asymmetric dist flavours, and an asymmetric curve would integrate its own offset
  into the line until the tail thumps. Core-only; the row says so, as Glitch's does.
- **A DSP FEATURE IS MEASURED AGAINST THE WASM, NOT AN OFFLINE RENDER.** An offline render falls back
  to the NODE engine, so it never exercises the core path — a core-only stage would show no effect and
  read as broken. Instantiate the wasm directly (`in_ptr` / `process` / `out_ptr`, the same shape
  golden-render uses) and measure the buffer.
- **THE TRANCE GATE HAS TWO POSITIONS AND TWO DRIVERS (2026-09-19).** Before FX is the engine's own
  gate — on the core the `strip_tg` 64-step BITMASK (square by construction; Width is honoured by
  subdividing the pattern while `len × k ≤ 64`), on the node path the `tgGate` Signal. After FX is
  `tgPost`, a per-layer Gain between the layer's output and the bus on BOTH engines (core: between the
  strip's slot output and the bus — the one place "after FX" exists there), driven by `_ambTgDrive`
  with the full wave (Width, Shape). `_ambTgConf` is the ONE resolver (span bar/pass, period, anchor,
  pattern length); the two drivers read it. Span = pass anchors on the LAYER's cycle start
  (`E._v2Phase[key].startAt`) and its `cycleSec`, not the bar grid. Continuous shapes inside the core
  gate need a Rust change and a rebuild — no Rust toolchain on the dev machine (2026-09-19), which
  is why the shapes live on the post node and the Chop rows say so.
- **Extending a `strip_*` wasm export: make new args `i32`, never `f32`** — a missing argument becomes
  `0` for an int and `NaN` for a float, so design the new param so 0 is neutral.

- **THE SPLICE RING'S `rate` IS A TARGET, NOT A RESAMPLE.** `BloopsSpliceRing` never changes pitch
  or playback speed — `rate` only accrues `debt`, and the audio changes ONLY when a splice fires. So a
  `rate` step in the flight log is not a pitch bend, and slew-limiting it alone is inaudible (verified
  2026-09-30: slewed `rate` with debt+gap on the target is bit-identical in `tools/splice-test.swift`).
  Slewing the debt instead spreads the splices out but drains the ring deeper first — the "severe
  0.60" scenario went from 1 to 8 POOR splices and failed. What a listener hears is SPLICE DENSITY.
- **A STALE `rate` FROM AN EMPTY RING READS AS A JUMP.** `rate=0.6665` with `primed=false buf=0ms`
  is the controller pinned at its floor while nothing is produced (an iOS interruption,
  `ctx state → interrupted`), held until the next prime. A whole fix was built on reading
  "0.95 → 0.667 → 1.0" as a live slew. **Filter flight lines to `primed=true` AND `vis=visible`
  before reading anything into them, and count how many survive** — that harvest had 4 of ~140.
- **A FLIGHT LOG OF A BACKGROUNDED APP LOOKS ALARMING AND MEANS NOTHING.** 898 s of
  `vis=hidden state=interrupted media=paused`, with underruns climbing and `prod=0.908`, is all
  expected when nothing is producing. Say so when there are no playing samples; never pass or fail on it.

## The WASM audio engine (bloops-dsp)

Bloom voices, layer strips/FX, and sample playback render in a Rust→WASM core (`dsp/`, built by `dsp/build.sh` → `js/bloops/core/bloops-dsp.wasm`) inside ONE AudioWorklet (`js/bloops/core/voice-processor.js`, bridged by `js/bloops/03b-core-voices.js`). **Default ON** — `window.bloopsCore(false)` / `window.bloopsCoreStrips(false)` are the kill switches (persisted localStorage `'0'`); the Tone node engine remains the automatic fallback (cold start, ineligible notes, slot exhaustion, pads/held notes, offline export). Rules:

- **Any DSP change must keep `node test/golden-render.js` green** (83 bit-exact sections); an
  intentional audio change re-baselines with `--update` IN THE SAME COMMIT. `dsp/build.sh` runs the
  gate after every build. Check the blast radius: only the sections you meant to move should drift.
- **Calibrate against RECORDED node output, never derive from Tone internals** (proven wrong
  repeatedly). Known engine truths: native lowpass/highpass biquad Q is in dB; `Tone.LFO/Signal.connect`
  ZEROES the destination param; cycle-member DelayNodes keep true delay with the quantum penalty on the
  feedback edge; `Tone.Panner` is channelCount 1 (a mono downmix — which is why the core strip has its
  own width-preserving pan law, and why per-note pan gives a layer no audible spread on the node path).
- **PORTING A TONE VOICE: its filter moves in HERTZ, squared — and Q is dB.** Tone's
  `FrequencyEnvelope` is LINEAR in Hz (base + base·(2^oct−1)·env), and a `MonoSynth`'s
  `filterEnvelope` carries `exponent: 2`, so the cutoff follows env², not env. An exponential sweep
  measured ~6 dB off per harmonic and a linear one ~24 dB; env² landed at ≤0.5 dB. Envelope decay /
  release time constant = ln(dur+1)/ln(200). Per-section linear Q = 10^(Q/20) (Tone Q 6 → 2.0).
  Recipe: `test/calib-mono.js` renders Tone.Offline against the wasm in Node and reports the constant
  GAIN offset apart from the per-harmonic SHAPE error — fix the shape first, then set `GAIN[kind]`.
  A new kind gets a per-voice kill switch (`bloopsCoreMono`) and a UI A/B before it is trusted.
- **Core-eligible Bloom notes BYPASS the deferred build queue** (`playNote` → `_playNoteNow` before
  `_vqShouldDefer`): they cost ~nothing to start, and queueing them behind node builds is what let a
  hidden page (timers throttled) drop notes. Only node voices queue.
- **A CORE-STRIP PARAM IS A SHIM, NOT A Tone PARAM — it has NO `setTargetAtTime`.** `03b makeShimParam`
  answers `value` / `cancelScheduledValues` / `setValueAtTime` / `linearRampToValueAtTime` / `rampTo`,
  so a `setTargetAtTime` call on `e.levelGain.gain` (or any strip param) throws into the caller's catch
  and degrades to `.value = x` — a HARD STEP, i.e. a click, on the DEFAULT path, while the node path
  sounds fine. **`rampTo(v, dur)` is the one method both kinds answer**; reach for it for any gain-like
  move. Nor can you measure the curve by reading `gain.value`: a scheduled ramp reports its TARGET
  there, so two very different fades read identically — spy on the param's own method instead.
- **The worklet must always stay pulled** (keep-pull sink on output 16) and `init()` must reset ALL
  core globals, or golden loses determinism. That send bus is GLOBAL — one summed send feeding ONE
  reverb, re-claimed by whichever engine builds strips.
- **THE CORE REVERB-SEND BUS IS HANDED BACK BY BEING CLAIMED AGAIN, never by the holder letting go.**
  Output 16 is one global sum feeding ONE reverb, so anything that claims it takes it from whoever
  had it. `_ambEnsureReverb` returned at the door once `_E.reverb` existed, so the ONLY code that
  ever claimed the bus was a FIRST build — once it went, the wash never came back for the life of
  the session, with the send slider, the send param and the reverb node all still reading correctly.
  The cached path re-claims now. Symptom to recognise: "turning up the Reverb send makes no
  difference", with everything in the graph looking right.
- **MEASURE AN EFFECT IN dB AT THE MASTER OUTPUT, not by reading the graph.** "Makes no difference in
  sound" is a claim about sound, and every intermediate value can be correct while the wash is gone.
  Tap `Tone.getDestination().input` with an AnalyserNode and compare RMS with the send at 0 and 100
  (probe-reverb-send): a working send is +3..+5 dB, a dead one ±0.1. Two traps in that measurement —
  a core-strip layer's dry signal does NOT pass `_E.busNode()` (tapping there reads zero with the
  layer plainly sounding), and a NEW LAYER IS EMPTY, so pick a material or everything reads zero for
  a reason that has nothing to do with the effect.
- **Reverb Size 0 and character Gated are inaudible BY DESIGN** — measured +0.7 dB and +0.6 dB
  against lush's +4.0 at the same send. Both are legitimate settings that look exactly like a broken
  send, and Size/Damp/Type are PER AREA, so loading or switching an area can set them under you.
- **DSP hygiene:** every RECURSIVE write (biquad state, delay/chorus feedback) goes through `flush()` —
  strips process silence 24/7 and WASM has no FTZ, so unflushed feedback decays into subnormals.
  High-Q filters route through `df2t_sat`/`g_sat`. The DC blocker runs only on the ASYMMETRIC dist
  flavours (fuzz/fold/crush); classic and overdrive are odd-symmetric and golden-pinned. Saturation is
  ADAA on classic/overdrive only — 2× oversampling was built, measured (+3.5 dB mean, one case WORSE,
  ~2.5× the CPU) and REJECTED. `dist_adaa_dirty` must be set by any new writer of a dist curve param.
  Do NOT add `+simd128` (measured regression).

- **A v2 layer's ADSR always overrides its sound's envelope** (`_ambApplyAdsr` → caller-owned keys in
  `_sdMergeUserPatch`), and a new layer starts on pad defaults (400 ms attack / 1200 ms release). Any
  path that dresses a layer with a sound must copy the sound's attack/decay/sustain/release onto
  `L.instrument`, or short notes never finish fading in while long tails pile up — the level pumps.

- **Every display clock must subtract the shell's ring lag (`window._bloopsMseOutLag()`, 0 on the
  web).** The native app's sound reaches the speaker ~0.85 s (up to 2 s after a lock) after render.
  Seed's bar play head subtracted it but `scheduleVisual` (the step flashes) and `_transportTick`
  did not, so the steps lit a ring ahead of the sound. A new visual clock: add the lag, or it leads.

