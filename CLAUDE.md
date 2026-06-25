# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## UI guidance

Apply these rules to every UI change:

1. **No horizontal scrolling** — with ONE intentional exception (below). If a row's contents don't fit, either (a) shrink elements in that row to fit (`min-width: 0`, `flex-shrink: 1`, narrower padding/font on small viewports via media queries), or (b) wrap to a new row and resize the new row's contents to fit. Never solve overflow with `overflow-x: auto/scroll`.
   - **Exception — lane step strips (`.lane-chips`).** Each lane's step strip is a single-row, proportional-width **timeline** that intentionally scrolls horizontally (`overflow-x: auto`) and fills logically to the right; during playback each lane auto-scrolls to keep its currently-playing step centered. This is deliberate (chosen over wrapping) so there are no row-boundary / continuation-split artifacts. Do NOT "fix" it back into a wrapping layout.

2. **Audio playback must be smooth and immediate.** Every user-triggered sound (cell press, wrap audition, sequence/loop playback, REST tap, sample preview, recording playback, etc.) should fire with no perceptible lag, no distortion, and no fluctuation. When changing audio code, prefer firing the sound *before* DOM work, keep Tone's `lookAhead` minimal (currently 25 ms in `bloops.html`), and don't add unconditional time cushions to interactive triggers — guards for cold-start (suspended `AudioContext`) are fine but should not penalize the warm path. If a change risks audio glitches (under-runs, stagger between voices, dropouts), test it in the browser before declaring done.

3. **Keep the audio signal-flow diagram current.** `README.md` (section *"Bloops — audio signal flow"*) holds an ASCII diagram of how notes route from each source through the two entry buses (`globalSendTap` vs. the per-lane bus) to the shared master chain and speakers. Whenever you change audio routing — `playNote()` destination resolution, `globalSendTap`, `getLaneBus()`, the FX send/return wiring, or the master chain order — **update that diagram in the same change** so it never drifts from the code. Prefer one global routing rule over per-mode volume/FX hacks; if modes sound inconsistent, fix it at the bus/master level (and re-draw the diagram) rather than scaling individual call sites.

## Record learnings here (avoid repeat debug churn)

When a bug or behavior takes more than a couple of attempts to figure out — especially anything non-obvious about this codebase (CSS that overrides JS, event/lifecycle ordering, audio scheduling/lookahead, save/load quirks, the Bloom engine, view-mode rules) — **add a short note to the "Gotchas / hard-won learnings" list below in the same change**, so the next task doesn't rediscover it. Keep each entry one or two lines: the symptom and the fix/cause. Check this list before deep-debugging a UI/audio/state issue.

### Gotchas / hard-won learnings
- **Body-attached overlays get force-hidden by view-mode CSS.** Rules like `body.<mode> > *:not(#mix-view):not(.ctx-menu) { display:none !important }` (and the `tracks-fullscreen` family) hide any element appended to `<body>` that isn't exempt. A selector `!important` beats a normal `.open{display:block}` rule, so toggling a class won't show it. Fix: set `display` via **inline `!important`** (`el.style.setProperty('display','block','important')`); clear on close. Diagnose with a toast of `getComputedStyle(el).display` + `document.body.className`.
- **`position:fixed` overlays drift** because the app uses `backdrop-filter` on some ancestors, which makes one a *containing block* — so `getBoundingClientRect`-derived `top/left` are offset (and shift with scroll). Fix: **measure-and-correct** — set the overlay to `0,0`, read its rect (= the containing-block offset), then subtract it from the desired viewport coords.
- **Live-readout chips must not be `<button>` / focusable.** The notes readout repaints on a timer, so a `click` (which needs mousedown+mouseup on the *same* element) gets dropped when the element is recreated between press and release; and focusing a control inside an `aria-hidden` line is blocked. Fix: render chips as non-focusable `<span role="button">` and act on **`pointerdown`**, not click.
- **Bloom edits land one iteration late** unless you account for the ~1.4 s lookahead: the next iteration's voices are already scheduled with old values. To apply on the next iteration, cancel the layer's scheduled-ahead voices and re-anchor/re-emit. Use `cancelBloomFutureVoices(key, fromAt)` (voices are tagged with `_ak`/`_akAt`) to drop *only* the next iteration so the current one finishes intact.
- **Silent/dry Bloom render** already exists: set `window._ambSilentCapture = true` (with a capture sink) and `playNote` captures without sounding — reuse it instead of adding a dry-run path.
- **Always-on per-layer DSP glitches modest Bloom stacks.** Continuous DSP built for every layer even when inactive (it ran at flat/0 settings) drains the audio render thread and glitches/cuts out with only a handful of layers. This is why Distortion/Delay are spliced in LAZILY by `_ambApplyLayerFx` only when `mix > 0`, and why the per-layer **EQ3 is lazy too** (`_ambApplyEq` inserts an EQ3 between vcf→vca only when a band ≠ 0; the meter FFT analyser stays on the VCA so meters still work). Rule: don't add per-layer nodes that run unconditionally — gate them on the feature being engaged, or a 5-layer project chokes. Even *engaged* heavy DSP needs scaling: per-layer **Distortion oversampling** is adaptive (`_ambDistOversample`/`_ambNormalizeDistOversample`) — 1 dist layer = 4x, 2-3 = 2x, 4+ = none — because 5× 4x-oversampled waveshapers (the "FX on all layers" case) overran the render thread and cut audio out (recovered only by Stop→Play, which tears the FX down).
- **Bloom layer PAN is on a per-layer `Panner` node, not (only) per-voice.** Bloom applies pan at note-onset, so a pan *ramp* via the layer's `space` would only re-pan per note (coarse/inaudible for sustained or sparse layers). Fix: the mod chain has a `pan` Panner (`vca → gate → pan → [FX] → bus`). In **Pan** mode `_ambLayerPan`/`_ambLayerPans` return 0 (per-voice centred) and the Panner holds the position — set from `space` by `_ambApplyLayerPan`, and driven CONTINUOUSLY by the pan ramp (`_ambRampResolve` special-cases `space` → pushes to `e.pan.pan`). In **Spread** mode the Panner stays centred and per-voice pans fan the width. So a "pan ramp" only sweeps the image in **Pan** mode; in Spread mode it animates width.
- **Bloom's first iteration is dropped on a cold-start play** (symptom: "no notes for several iterations, especially Bed"). Pressing Play resumes the AudioContext *asynchronously*; if `_ambTick` SCHEDULES while the context is still `suspended`, its voices anchor to a frozen clock and the first onset is dropped on resume — worst on Bed (long iteration = seconds of silence). Fix: in `_ambStartGenerator` start the interval + flip `cfg.playing`/the Play button IMMEDIATELY (do NOT defer the whole start — that left the button on ▶ and added a ~1 s delay), and instead gate only the SCHEDULING: `_ambTick` returns early while `Tone.getContext().rawContext.state !== 'running'`. The interval keeps ticking, so the first running tick (≤150 ms after resume) anchors cleanly; `_ambStartGenerator` also kicks one extra tick from `Tone.start().then(...)` so cold starts don't wait a full interval. **CRITICAL: this scheduling guard must apply at COLD START ONLY** (gate it behind `E._everRan`, set true on the first 'running' tick). If it keeps blocking whenever the context isn't 'running', a mid-playback context dip (tab backgrounded / power blip) starves the schedule and turns a momentary glitch into a full cut-out — the keep-alive watchdog + 1.4 s lookahead already cover steady-state, so never block once it has run.

## Deployment policy

**NEVER run `./deploy.sh` unless the user explicitly asks for it in that message** (e.g. "deploy", "push it live", "ship it"). Committing and pushing to git is fine when the user asks; deploying to the live GoDaddy site is a separate, explicit step. Do not deploy as an automatic follow-up to a code change, a commit, or a push. When work is ready, say so and let the user request the deploy.

## Commands

```bash
npm start        # Start Express server at http://localhost:3001
./deploy.sh      # Deploy to GoDaddy cPanel via SFTP (requires lftp) — ONLY on explicit user request (see Deployment policy)
```

There is no build step, no linter, and no test suite. All JavaScript runs directly in the browser.

## Architecture

This is a browser-based music player that streams audio files from Google Drive. It is a single-page app served by a minimal Express static server (`server.js`).

### Module structure

Four vanilla JS modules are loaded in order via `<script>` tags in `index.html`:

1. **`js/google-drive-api.js`** — `GoogleDriveAPI` class. Initializes `gapi` and Google Identity Services (GIS) OAuth client, handles sign-in/sign-out, searches Drive folders, paginates through audio files, and fetches artist metadata.
2. **`js/music-player.js`** — `MusicPlayer` class. Wraps the HTML5 `<audio>` element, manages blob URL lifecycle (creates on play, revokes on next load), and handles keyboard shortcuts (Space, Arrow keys).
3. **`js/playlist-manager.js`** — `PlaylistManager` class. Owns the track array, renders the playlist DOM, handles drag-and-drop and touch reordering, and implements shuffle (Fisher-Yates, preserves original order for restore).
4. **`js/app.js`** — Wires everything together, manages auth UI state, loads playlist options from a Drive file at `bloops/playlists`, and shows loading/toast feedback.

### Event-driven communication

Modules communicate via custom DOM events (no external event bus):

| Event | Source | Consumer |
|---|---|---|
| `authStatusChanged` | `GoogleDriveAPI` | `app.js` (updates UI) |
| `trackLoaded` | `MusicPlayer` | `app.js` |
| `trackEnded` | `MusicPlayer` | `PlaylistManager` (advance track) |
| `requestNextTrack` | `MusicPlayer` | `PlaylistManager` |
| `requestPreviousTrack` | `MusicPlayer` | `PlaylistManager` |

### Key data flows

**Auth:** User clicks connect → GIS OAuth popup → access token stored in `GoogleDriveAPI` instance → `authStatusChanged` fires → UI updates.

**Loading music:** Folder name selected/searched → `driveAPI.searchFolders()` → `driveAPI.getMusicFilesFromFolders()` (paginated) → optionally `driveAPI.fetchArtistName()` from a special "Artist name" file in the folder → `playlist.setTracks()` renders list → first track auto-loads.

**Playback:** `PlaylistManager.playTrack(index)` → `MusicPlayer.loadTrack()` → fetch audio blob from Drive with `Authorization: Bearer <token>` header → blob converted to object URL → set as `<audio>` src → play.

### Google Drive folder convention

The app expects:
- A `bloops/` folder at the root of My Drive with subfolders `bloops/effects`, `bloops/projects`, `bloops/exports`. The Bloops sign-in init creates these on first run with one consolidated confirmation prompt.
- A text file at `bloops/playlists` listing folder paths (one per line) that the Player turns into playlists. Paths use `/` for parent/child nesting (e.g. `bloops/exports`). The init step seeds this file with `bloops/exports`.
- Audio folders optionally containing a file named **"Artist name"** whose first line is used as the artist, and an image named **"Artwork"** used as album art.
- Supported audio formats: `mp3, wav, flac, aac, ogg, m4a, opus`.

### Google API credentials

`CLIENT_ID` and `API_KEY` are hardcoded in `js/google-drive-api.js`. To use a different Google Cloud project, replace those constants and update the authorized JavaScript origins in the OAuth client configuration. The app uses the `drive.readonly` scope.

### Deployment

`deploy.sh` stages the project, installs production dependencies, and uploads via SFTP using `lftp`. See `pre_deploy.txt` for GoDaddy cPanel prerequisites (Node.js app setup, SFTP credentials).
