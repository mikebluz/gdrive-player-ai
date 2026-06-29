# Google Drive Music Player

A web-based music player that sources music files from Google Drive. Search for folders by name and automatically load all music files into a customizable playlist.

## Features

- 🔍 Search Google Drive folders by name
- 🎵 Automatic music file detection and loading
- ▶️ Full playback controls (play, pause, stop, skip)
- 📝 Drag-and-drop playlist reordering
- 🔀 Shuffle functionality
- ⌨️ Keyboard shortcuts
- 📱 Responsive design

## Setup Instructions

### 1. Google API Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API
4. Create credentials (OAuth 2.0 Client ID)
5. Add your domain to authorized origins

### 2. Configuration

Replace the placeholders in `js/google-drive-api.js`:

```javascript
this.CLIENT_ID = 'your-google-client-id-here';
this.API_KEY = 'your-google-api-key-here';
```

## Bloops — audio signal flow

Bloops (`bloops.html`) routes every note through one of two entry buses depending on
whether `playNote()` is called with a `laneIdx`, then converges on a single master chain.

> **Keep this diagram current.** Any change to audio routing — `playNote()` destination
> resolution, `globalSendTap`, `getLaneBus()`, the FX send/return wiring, or the master
> chain order — must be reflected here in the same change. (See `CLAUDE.md`.)

```
 NOTE SOURCES                         playNote() picks the bus by whether a laneIdx is passed
 ════════════                         ───────────────────────────────────────────────────────

 Grid cell tap        ┐
 Live GAME hits       │  no laneIdx ─► globalSendTap (Gain = 1)
 Live PROG press      ┘                    │
                                           ├──────────────────────────► masterBus   (DRY signal)
                                           └─► global send gains ───────┐
                                               (levels = globalFx[ ])   │
                                                                        │
 Sequenced step      ┐                                                  │
 RECORDED step       │  laneIdx ─► lane bus:                            │
 Prog playback       ┘     Volume(lane.vol) ─► Panner                   │
 Per-lane BLOOM ─► layer        │                                       │
   mod chain ────────────────┐  ├─► laneSumBus ─► masterBus   (DRY)     │
   (vcf →[EQ3]→ vca → GATE    │  │                                      │
    → PAN, per-layer          │  │                                      │
    delay/dist,               └──┤                                      │
    Bloom Freeverb) ─────────────┤                                     ▼
                                  └─► lane send gains ───►  ┌────────────────────────┐
                                      (levels = lane.sends[ ])│  SHARED FX (parallel) │
                                                            │  one instance each,     │
                                                            │  wet = 1; mix set by    │
                                                            │  the send gains above:  │
                                                            │  reverb (convolution    │
                                                            │   default · Freeverb    │
                                                            │   optional) · delay ·   │
                                                            │  distortion (4× OS) ·   │
                                                            │  chorus ·               │
                                                            │  vibrato · tremolo ·    │
                                                            │  phaser · autoFilter ·  │
                                                            │  pingPong · autoPan     │
                                                            └───────────┬────────────┘
                                                              returns ──┘ ─► masterBus

   laneSumBus (Gain = 1/√N, N = sounding lanes) ─► masterBus    ← every sequenced
     so N uncorrelated lanes sum to ≈ one lane's level            lane sums here
     (anti-runaway headroom; live taps bypass via globalSendTap)  before masterBus

   Mix BLOOM (master generative engine) ─► its layer mod chains (+ Bloom Freeverb)
     ─► bloomMasterGain (−6 dB trim) ─► masterBus  — bypasses the grid FX sends
     above; the trim evens its dense, many-voice mix against lane playback
     (which gets the laneSumBus headroom trim).

   MASTER CHAIN (series — contains NO FX; the 10 effects are parallel returns):
   masterBus (Gain 0.6) ─► [DC block / sub HPF ~28 Hz] ─► [Master Warmth stage] ─► masterCompressor ─► masterVolume
     (−6 dB headroom          low-shelf +@160 →     (gentle glue:
      trim so overlapping     presence −@3k →        −3 dB / 2:1 /
      voices don't slam       high-shelf −@7k →      180 ms)
      the clip ceiling)       soft-sat (4x OS) →
                              high-cut LPF
                              (tilt EQ + saturation,
                               rounds shrill highs;
                               globalFx.warmth/Drive/
                               Cut/On; neutral when off)
                                                     │
                                                     ▼
                  lookahead limiter (AudioWorklet, ceiling 0.84, 3 ms lookahead)
                        │   ducks BEFORE each peak (incl. the same-pitch
                        │   step-to-step overlap a feedforward limiter misses)
                        ▼
                        masterClipper ─► 🔊 speakers
                        (final safety only — identity below 0.85; the limiter
                         already holds the signal under it. The old Tone
                         masterLimiter(−3) stays as fallback if the worklet
                         can't load.)
```

**Notes:**

- **Two entry buses, one master chain.** `globalSendTap` (no `laneIdx`: grid taps, live
  Game, live Prog) and the per-lane bus from `getLaneBus(laneIdx)` (anything sequenced:
  recorded steps, Prog playback) both feed `masterBus`, which is the only path to the
  speakers: a short series chain `masterBus → Master Warmth stage → masterCompressor →
  masterVolume → masterLimiter → masterClipper → masterFade → destination`. The 10 effects
  are **not** in this series chain — each is a parallel send/return (see next note).
- **`masterFade` is the final output gain** (1 = full). `masterFadeIn(sec)` ramps it up from
  silence on play, `masterFadeOut(sec)` ramps it to 0 from the capture Finalize press
  (driven by the mixer's Master Fade In/Out controls, `cfg.fadeInMs`/`cfg.fadeOutMs`).
  Capture taps this node (`_ambMasterTapNode`), so a fade-out is part of the recording.
- **The 10 effects are parallel send/return, not an in-series chain.** There is exactly one
  shared instance of each effect (one reverb, one delay, …). Two sets of send gains feed
  them: per-lane (`lane.sends[name]`, from each lane bus — and from Mix-key sliders in the
  FX panel's *Per-lane* section) and global (`globalFx[name]`, from `globalSendTap` for live
  presses). Each send accumulates into `fxSendBus[name]`, which drives the effect at `wet=1`
  (the send level *is* the mix), and the effect returns to `masterBus`. The FX panel's
  *Global* section holds the shared *voicing* (size/time/rate/depth/etc.) plus the Warmth
  stage. `globalFx.fxOrder` no longer affects audio (the order list is cosmetic now that FX
  are parallel, not serial). Mix Bloom (`_masterEng`) routes straight to `masterBus`, so it
  bypasses all of these sends; per-lane Bloom (`_laneEng`) rides the active lane's bus and
  inherits that lane's sends.
- **Each Bloom layer chain ends in a dedicated DRY output GATE.** The per-layer mod chain is
  `voices → vcf → [EQ3] → vca → levelGain → tgGate → gate → pan → [dist] → [chorus] → [phaser] → [delay] → [autopan] → bus`, with the layer's reverb
  send tapped off the **levelGain (pre-gate)**. `levelGain` is the layer's **Level** as a
  continuous gain (`_ambLevelGain`: 0→silent, 70→unity, 100→×2) — Level lives here, not per-note,
  so a ramp or fader sweeps the whole layer (held tails included) in real time. `tgGate` is the
  **Trance Gate**: a bar-synced step pattern (driven by a dedicated Signal in `_ambScheduleTg`,
  disposed on stop) that chops the layer; unity passthrough when off, and pre-gate so the reverb
  wash (tapped off levelGain) fills the chopped gaps. The `[EQ3]` is the per-layer 3-band EQ, spliced in
  **lazily** only while a band ≠ 0 dB (an EQ3 is several always-on biquads; building one per
  layer at flat 0 dB drained dense stacks), and disposed when the layer returns to flat; an FFT
  `Analyser` taps the **vca** (so the band meters in Mix → EQ work whether or not the EQ is
  engaged). The `pan` is a per-layer `Panner`: in Spread mode it stays centred (per-voice pans
  fan the width); in Pan mode it holds the position so a **pan ramp** sweeps it smoothly. The
  `[dist]` (oversampling scales down as more layers run distortion), `[chorus]`, `[phaser]`,
  `[delay]` (a `FeedbackDelay`, or a `PingPongDelay` when the layer's **Ping-Pong** toggle is on)
  and `[autopan]` are likewise inserted only at `mix > 0`. The `gate` is a plain `Gain(1)` that never has an LFO connected
  (unlike `vca`, whose gain carries the VCA tremolo when its mod depth > 0). That lets Queue
  mode ramp the gate to 0 at an exact iteration boundary to silence the dry voices the
  look-ahead scheduler already committed past it — a clean, click-free STOP that a
  feed-forward "stop scheduling" flip can't achieve.
- **Queue STOP and reverb tails (`cfg.tails`).** Because the reverb send is pre-gate, the dry
  and wet can be cut independently on a queued STOP. With **tails off** (default) the send is
  ramped to 0 with the gate, so dry and wet both stop on the boundary (tight cut). With
  **tails on** only the dry gate closes; the reverb send keeps feeding past the boundary
  (until the layer flips off and its chain tears down), so the shared Freeverb develops and
  rings out a fuller tail. The toggle lives next to Queue in the Bloom Configure menu.
- **Reverb engine is selectable (`globalFx.reverbType`).** Default **convolution**
  (`masterConvolver`, a `Tone.Convolver`) fed a runtime-generated stereo impulse response —
  exponentially-decaying, tone-filtered noise (independent L/R for width), built by
  `_makeReverbIR(decay, tone)` from Reverb Size (→ 0.3–8 s decay) and Tone (→ IR damping). It
  sounds far lusher than the classic **Freeverb** (`masterReverb`), which is kept as an option
  via the "Convolution / Freeverb" toggle in the FX panel's Reverb header. `setMasterReverbType()`
  repoints `_masterFxNodes.reverb` and rebuilds the parallel send; IR regeneration off the
  Size/Tone sliders is debounced (rebuilding an `AudioBuffer`). Bloom's per-engine reverbs
  follow the same global type (`_ambEnsureReverb` / `_ambOnReverbTypeChanged`).
- **DC blocker + sub high-pass at the front of the master chain.** A 2-pole high-pass
  (`masterDCBlock`, ~28 Hz, Q 0.707) sits `masterBus → masterDCBlock → Warmth → …`. It strips
  the DC offset that asymmetric/waveshaped voices leave (wasted headroom, thumps) and sub-30 Hz
  rumble (mud, stolen loudness) for a tighter, cleaner bottom without touching the audible range.
- **All `Tone.Distortion` nodes run `oversample: '4x'`.** The FX-send, per-voice, per-lane,
  track-render, and Bloom-layer distortions are oversampled like the master warmth/clipper, so
  driving them adds harmonics without the harsh aliased "digital fizz".
- **Master Warmth stage rounds the overall tone.** Sitting between the DC block and
  `masterCompressor` (an isolated spot upstream of the FX returns' sum point and the limiter
  rewiring), it applies a single `globalFx.warmth` macro as a tilt EQ — low-shelf lift
  (~+2.5 dB @160 Hz body), presence dip (~−3 dB @3 kHz harshness), high-shelf cut
  (~−4 dB @7 kHz air) — plus an oversampled (4×) tanh soft-saturation (`warmthDrive`,
  even-harmonic glue) and a high-cut LPF (`warmthCut`, shaves digital fizz). On by default
  at a tasteful amount (warmth 30, drive 12, cut 16 kHz) so sounds come up rounded instead
  of shrill; `warmthOn:false` makes it transparent (gains 0, identity curve, cut wide).
  All four are persisted in `globalFx` and applied via `applyMasterWarmth()`.
- **Peak safety vs. glue are split on purpose.** The true-peak ceiling is the final
  `masterClipper` — a soft-knee waveshaper that is *identity* below 0.9 and rolls smoothly
  to a hard 0.97 ceiling. Because it is instantaneous waveshaping (no time-varying gain) it
  cannot pump. That lets `masterCompressor` stay a *gentle* glue (−3 dB / 2:1 / 180 ms
  release). The earlier aggressive compressor (−6 dB / 4:1 / 30 ms) re-ducked on every
  sequenced step's onset, so lane/Game/Prog playback came out quieter and audibly "gated"
  vs. dry grid taps — measured gain reduction on a dense stream fell from ~−2.8 dB (4.6 dB
  of pumping) to ~−0.5 dB (<1 dB) with the split.
- **`masterBus` carries a −6 dB headroom trim (Gain 0.5).** All entry buses and FX returns
  sum here, so a single voice already peaks near full scale — with no room for overlap.
  Once voices stack (chords, and especially that sequenced steps sustain for their whole
  step + a release tail that overlaps following steps) the sum slams the clip ceiling and
  waveshapes into audible distortion. The earlier 0.6 (−4.4 dB) trim wasn't enough: a
  single voice at ~0.58 means even a **2× coherent overlap** — one step's release tail plus
  the next step's attack at the *same pitch* — reaches ~1.0 pre-clip (measured), which the
  no-lookahead limiter can't catch and the clipper soft-saturates, audible as distortion
  "between steps" on a pure sine. 0.5 puts that 2× overlap at ~0.855 ≈ the clip knee
  (clipper ≈ identity → clean). It's static (not a compressor) so it adds no pumping;
  the ~1.6 dB of extra loudness lost is the cost of clean overlaps without a look-ahead
  limiter (which would catch the overlap transient and let this trim go back up — a
  planned follow-up). The user-facing Master Volume scales on top.
- **`laneSumBus` scales headroom with the lane count (anti-runaway summing).** Every
  sequenced lane's output sums into `laneSumBus` before `masterBus`; its gain is set to
  `1/√N` for `N` *sounding* lanes (solo wins, else non-muted — see `_soundingLaneCount`),
  recomputed on play / mute / solo (`updateLaneSumCompensation`). N uncorrelated lanes then
  sum to roughly one lane's level instead of `√N`×, so stacking lanes no longer overruns the
  static `masterBus` trim and slams the clipper into distortion. It's set once per change
  (ramped 40 ms), not a per-sample compressor, so it doesn't pump. Live grid taps go through
  `globalSendTap` (not `laneSumBus`), so single live presses stay full-level.
- **Dry level is identical on both buses.** `globalSendTap` is `Gain = 1`; the lane bus is
  `Volume(lane.volume)`, which is **0 dB at the default volume 100**. The raw note is the
  same loudness regardless of path.
- **The only per-path difference is the FX *sends*.** The tap path's wet sends use
  `globalFx[…]`; the lane path's use `lane.sends[…]`. If those differ (e.g. global reverb
  on, lane dry), the same note sounds fuller/louder on the tap path than on the lane path —
  which is why live Game/Prog can sound louder than the same notes recorded and played back
  through a lane.

Definitions live in `js/bloops/03-audio-bus-fx.js` (`globalSendTap`, `masterBus`, master
chain, FX sends), `js/bloops/06-variance-lanes.js` (`getLaneBus`), and
`js/bloops/04-instruments-samples.js` (`playNote` destination resolution).
