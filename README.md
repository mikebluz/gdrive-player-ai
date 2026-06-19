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
                                           └─► global send gains ───┐
                                               (levels = globalFx[ ])│
                                                                     ▼
 Sequenced step      ┐                                        ┌──────────────┐
 RECORDED step       │  laneIdx ─► lane bus:                  │  FX RETURN    │
 Prog playback       ┘     Volume(lane.vol) ─► Panner         │  buses        │──┐
                                    │                         │ reverb/delay/ │  │
                                    ├───────────────────────► │ chorus / …    │  │ (wet)
                                    │    (DRY+FX) ─► laneSumBus └───────────┘  │
                                    └─► lane send gains ──────────►   ▲         │
                                        (levels = lane.sends[ ])      └─────────┘
                                                                          │
                                                                          ▼
   laneSumBus (Gain = 1/√N, N = sounding lanes) ─► masterBus    ← every sequenced
     so N uncorrelated lanes sum to ≈ one lane's level            lane sums here
     (anti-runaway headroom; live taps bypass via globalSendTap)  before masterBus
   masterBus (Gain 0.6) ─► masterCompressor ─► [master FX chain:         (returns sum
     (−4.4 dB headroom      (gentle glue:       distortion → filter →     back in here)
      trim so overlapping    −3 dB / 2:1 /      phaser → vibrato → chorus
      voices don't slam      180 ms)            → tremolo → delay →
      the clip ceiling)                         pingpong → reverb →
                                                autopan] ─► masterVolume
                                                     │
                                                     ▼
                        masterLimiter (−1 dB) ─► masterClipper ─► 🔊 speakers
                                                 (soft-knee true-peak
                                                  ceiling: identity below
                                                  0.9, hard 0.97 ceiling)
```

**Notes:**

- **Two entry buses, one master chain.** `globalSendTap` (no `laneIdx`: grid taps, live
  Game, live Prog) and the per-lane bus from `getLaneBus(laneIdx)` (anything sequenced:
  recorded steps, Prog playback) both feed `masterBus`, which is the only path to the
  speakers (via `masterCompressor` → master FX chain → `masterVolume` → `masterLimiter`
  → `masterClipper`).
- **Peak safety vs. glue are split on purpose.** The true-peak ceiling is the final
  `masterClipper` — a soft-knee waveshaper that is *identity* below 0.9 and rolls smoothly
  to a hard 0.97 ceiling. Because it is instantaneous waveshaping (no time-varying gain) it
  cannot pump. That lets `masterCompressor` stay a *gentle* glue (−3 dB / 2:1 / 180 ms
  release). The earlier aggressive compressor (−6 dB / 4:1 / 30 ms) re-ducked on every
  sequenced step's onset, so lane/Game/Prog playback came out quieter and audibly "gated"
  vs. dry grid taps — measured gain reduction on a dense stream fell from ~−2.8 dB (4.6 dB
  of pumping) to ~−0.5 dB (<1 dB) with the split.
- **`masterBus` carries a −4.4 dB headroom trim (Gain 0.6).** All entry buses and FX
  returns sum here, so a single voice already peaks near full scale — with no room for
  overlap. Once several voices stack (chords, and especially now that sequenced steps
  sustain for their whole step + a release tail that overlaps following steps) the sum
  used to slam the clip ceiling and waveshape into audible distortion (~18% THD on a 4×
  overlap). The trim gives that headroom: a single note sits ~0.58, moderate polyphony
  stays under the clip knee, only genuinely dense peaks reach the ceiling (THD back to
  ~0%). It's static (not a compressor) so it adds no pumping. Loudness lost to the trim is
  the deliberate cost of clean dense polyphony without a look-ahead limiter; the
  user-facing Master Volume scales on top.
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
