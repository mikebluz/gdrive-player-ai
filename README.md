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
                                    │       (DRY) ─► masterBus └──────────────┘  │
                                    └─► lane send gains ──────────►   ▲          │
                                        (levels = lane.sends[ ])      └──────────┘
                                                                          │
                                                                          ▼
   masterBus (Gain 1) ─► masterCompressor ─► [master FX chain:           (returns sum
        distortion → filter → phaser → vibrato → chorus → tremolo →       back in here)
        delay → pingpong → reverb → autopan] ─► masterVolume
                                                     │
                                                     ▼
                                          masterLimiter (−1 dB) ─► 🔊 speakers
```

**Notes:**

- **Two entry buses, one master chain.** `globalSendTap` (no `laneIdx`: grid taps, live
  Game, live Prog) and the per-lane bus from `getLaneBus(laneIdx)` (anything sequenced:
  recorded steps, Prog playback) both feed `masterBus`, which is the only path to the
  speakers (via `masterCompressor` → master FX chain → `masterVolume` → `masterLimiter`).
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
