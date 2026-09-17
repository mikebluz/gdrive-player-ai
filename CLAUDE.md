# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

> **This file is the CORE only.** The subsystem traps were moved into `docs/traps-*.md` on 2026-09-15
> so they load on demand rather than on every call (the file was 82 KB — ~20K tokens per call).
> **Read the matching traps file BEFORE touching a subsystem** (index below). The complete, unabridged
> history lives in `docs/claude-md-archive.md` — grep it when a line is not enough.

## Read before touching

| when the change touches… | read |
|---|---|
| CSS, layout, a control, a handler, reachability | `docs/traps-ui.md` |
| a probe, a gate check, a poison, puppeteer | `docs/traps-testing.md` |
| `17-ambient.js`, `18-layer-v2.js`, a layer store, saved shape, the arrangement clock, Write/capture | `docs/traps-bloom.md` (+ `docs/bloom-layer-v2.md`, `docs/bloom-layer-model.md` §11 backlog, `docs/bloom-gate-ladder.md`) |
| audio routing, voices, performance, the WASM core (`dsp/`) | `docs/traps-audio.md` |
| speech, TTS, the voice server | `docs/traps-spoken.md` |
| Capacitor / iOS / Electron | `docs/traps-native.md` |
| `deploy.sh`, a new page, `?v=` stamps, samples import | `docs/traps-deploy.md` |

## Always (the rules that apply to every change)

- **NEVER `git checkout <file>` / `stash` / `reset --hard`** — this repo routinely carries days of
  uncommitted work. Undo by restoring a `cp` backup taken first.
- **`grep` treats `17-ambient.js` as BINARY** — always `grep -a`, or an empty result reads as "that
  function does not exist".
- **Renames are LABEL-ONLY — data keys stay for save-compat.** Write the sentence out and make every
  surface use its words; one axis with two vocabularies reads as two mechanisms.
- **`_normalizeAmbientCfg` is the ONE migration chokepoint** and runs on EVERY `getCfg()`, replacing
  objects — a value read before a `getCfg` is an orphan. New fields are ADDITIVE and ABSENT BY DEFAULT.
- **The gates are the contract:** `node test/golden-render.js` (DSP, bit-exact), the invariant harness,
  `arch-parity`, `mod-parity`, `test:partseq`, `test:ui`. An intentional output change re-baselines
  deliberately IN THE SAME COMMIT; never silent drift. Never edit source while a gate runs; run
  mod-parity ALONE.
- **Verify at the right scale.** A label or hint change: one targeted check
  (`npm run test:ui -- --only=<regex>`, ~15 s). Wiring, a normalizer, or a shared identifier: the full
  gate once, at the end, in the background. `test:ui` is SINGLE-VIEWPORT (390px, `isMobile`).
- **`js/bloops/18-layer-v2.js` is TWO IIFEs sharing only `window._v2`** — a bare name from the wrong
  half throws into a surrounding `catch` and measures as a silent no-op. Publish through `V2.`.
- **NEVER `Tone.setContext()`; nothing connects to `rawContext.destination`** — use
  `window._bloopsSpeakerSink(ctx)`. Every programmatic tone needs gain ramps at both edges.
- **A computed readout with no second writer is frozen** — when adding any computed face, grep for
  the repaint; if there is none, it is a confident wrong answer.

## UI guidance

Apply these to every UI change.

1. **No horizontal scrolling, ever.** If a row does not fit, shrink it (`min-width: 0`, narrower
   padding/font at small widths) or wrap it. Never `overflow-x: auto`.
   The lane step strip (`.lane-chips`) is a **bar grid**: `repeat(32, 1fr)` per bar, a step spans
   `round(stepLengthFactor × 32)` cells, and a step crossing a bar line splits into continuation
   segments (`.cont-start` / `.cont-mid` / `.cont-end`, marked `.cont-segment`) via `_barGridPlan`.
   Continuation segments are visual only — no handlers, excluded by `:not(.cont-segment)`.
   Triplets round to the nearest cell and are MARKED (³ badge + amber accent) rather than made exact.
2. **All text wraps and stays inside its container.** `.ambient-hint` wraps BY DEFAULT
   (`white-space: normal; overflow-wrap: anywhere; min-width: 0`); the few one-line readouts opt out.
   **Audit by walking every leaf text node and comparing `scrollWidth` to `clientWidth`, and the
   element's right edge to its parent's — never `documentElement.scrollWidth`**, because `html`/`body`
   carry `overflow-x: hidden`, so overflowing text is silently CLIPPED and reads as zero overflow.
3. **No transient audio artifacts, ever** — playing, stopped, at stop/play edges, at lock/unlock, at
   app switches. Closed sources, each a checklist item for any audio-path change:
   (a) an always-open speaker path makes suspend/resume housekeeping audible — gate monitor paths on
   INTENT, never idle; (b) pausing/muting the LAST audible renderer makes iOS renegotiate the session
   ~1.2 s later and it ticks — "stopped" must look identical to "playing" at the session level;
   (c) a media element that hits `ended` is a finished renderer — never seek the broadcast element
   within a segment batch (~0.34 s) of the live edge; (d) an unenveloped oscillator start/stop is a
   broadband click even when inaudible — every programmatic tone needs gain ramps at both edges;
   (e) fast gain steps click — gain-like changes ramp (≥10 ms), and engaging a stage mid-note fades
   in from 0. Flight-verify a clean stop→idle→lock sequence before install.
4. **Audio must be smooth and immediate.** Fire sound BEFORE DOM work; keep Tone `lookAhead` minimal
   (25 ms, set in `js/bloops/02-wraps.js`); no unconditional time cushions on interactive triggers.
5. **Keep `README.md`'s audio signal-flow diagram current** in the same change as any routing change
   (`playNote()` destination, `globalSendTap`, `getLaneBus()`, FX send/return, master chain order).
   Prefer one global routing rule over per-mode volume/FX hacks.
6. **New UI must match its neighbours** — reuse `.ambient-ctrl`, `.ambient-seg`, `.ambient-select`,
   `.ambient-step-btn`, `.ambient-hint`, `.btn` etc. rather than inventing chrome. If something
   genuinely new is needed, build it from the same tokens as its siblings. A bolted-on control is a bug.
7. **A feature is not done until its UI is REACHABLE.** Name the door; add it in the SAME change;
   prove it by MEASURING `getBoundingClientRect()` + `offsetParent` in the view the user actually has
   open (a `querySelector` hit proves nothing — a `0×0` rect is the tell); then drive it with a real
   pointer event and read the config back. Audit the whole FAMILY, not just your addition. A control
   added inside something hidden/collapsed/behind a tab/condition **will be reported as missing, not
   as hidden** — this file recorded that failure at least six times before the rule was written.
   **A move is a delete plus an add**, and removing a surface means re-checking every callback it
   carried, not just its stores (a store has a reader that complains; a callback has nothing).

## Record learnings (avoid repeat debug churn)

When a bug takes more than a couple of attempts — especially anything non-obvious about this codebase
(CSS overriding JS, event/lifecycle ordering, audio scheduling, save/load quirks, the Bloom engine,
view-mode rules) — **add a short entry in the matching `docs/traps-*.md` in the same change**: the
symptom and the cause/fix, one or two lines. Check that file before deep-debugging.

**Keep it short, and put it under the right subheading.** An entry earns its place by being a rule
someone will break again — a trap, an invariant, a diagnostic recipe. It does NOT earn its place by
recording what was built and why (the code comments carry that), the debugging narrative, gate counts,
or poison bookkeeping. If a lesson already has a line, SHARPEN THAT LINE instead of adding a second.
**This file stays CORE**: only a rule that applies to every change goes in "Always" above.

## Deployment policy

**NEVER run `./deploy.sh` unless the user explicitly asks for it in that message** (e.g. "deploy", "push it live", "ship it"). Committing and pushing to git is fine when the user asks; deploying to the live GoDaddy site is a separate, explicit step. Do not deploy as an automatic follow-up to a code change, a commit, or a push. When work is ready, say so and let the user request the deploy.

## Commands

```bash
npm start        # Start Express server at http://localhost:3001
npm run samples  # Import a folder of audio into the shipped sample library (tools/import-samples.mjs)
./deploy.sh      # Deploy to GoDaddy cPanel via plain FTP via `lftp` (port 21, `set ftp:ssl-allow no` — NOT SFTP, despite deploy.sh's own comment saying so) — ONLY on explicit user request (see Deployment policy)
node test/bloom-mod-parity.js   # B2 mod-source parity gate (needs npm start running; --update re-baselines deliberately)
node test/arch-parity.js        # arrangement-clock gate: sections/parts/repeats/keys/salt (needs npm start; --update re-baselines)
npm run test:partseq            # per-iteration layer sequences (L.partSeqs): migration, pass indexing, the four cascade rules, own-phrase restore (needs npm start)
npm run test:ui                 # UI LIFECYCLE gate — drives every control on the v2 layer card under TOUCH, in the app's real order (init → card → panel rebuild → interact). Poison-verified: removing the v2 skip from the panel's wiring sweeps fails 4 named checks.
npm run test:ui -- --only=<regex>   # run TO the last check whose name matches, earlier checks quiet (they cannot be skipped — the probes share page state); ~15 s for an early check vs ~2:30 for the file. No match = exit 2.
```

**Mod-parity gate:** it RE-MEASURES a drifted config once before failing. The harness samples a LIVE audio graph for 3.2 s per config, so a GC pause or a busy host can smear one past tolerance with nothing changed — the long-standing "1/9 configs drifted, passes on re-run" flake. A genuine regression drifts on every attempt, so one retry separates them; tolerances are UNTOUCHED and a config that drifts twice still fails (verified: poisoning a baseline value gives `⟳ re-measuring …` then `drifted (twice — not jitter)` and exit 1). Retries are logged per config and summarised, so a config quietly becoming marginal stays visible instead of being silently rescued every run — if you see the same id rescued repeatedly, treat that as a real signal, not noise. **RUN IT ALONE.** The retry re-measures IMMEDIATELY, so it can't rescue a config when the contention is still there — launching parity in the same shell invocation as `golden-render.js` (or beside a puppeteer run) produced a `drifted (twice — not jitter)` failure that passed four times in a row on its own, with only display strings and CSS changed. "Drifted twice" means "not a momentary GC pause", NOT "not environmental". Any change to Bloom's node-path mod sources (`_ambMakeSrc`, `_ambSyncTarget`, `_ambScheduleStochastic`/`_ambScheduleCustomSrc`/`_ambScheduleSeqSrc` in 17-ambient.js) must keep `node test/bloom-mod-parity.js` green — it fingerprints each shape×target's output range, period, and phase-folded waveform against `test/bloom-mod-parity-baseline.json` (tolerance-based, node path, core strips off). This is the safety net for the planned B2 unification onto the Design engine's mod rig.

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

`CLIENT_ID` and `API_KEY` are NOT hardcoded (verified 2026-08-24): `GoogleDriveAPI`'s constructor takes `{clientId, apiKey}` and they are injected from **`js/config.js`** — gitignored, copied from `js/config.example.js`, loaded by `player.html` / `bloops.html` / `tracks.html` and passed at `js/app.js` as `new GoogleDriveAPI(window.APP_CONFIG)`. To use a different Google Cloud project, edit `js/config.js` and update the authorized JavaScript origins in the OAuth client configuration. The app uses the `drive.readonly` scope.

### Deployment

`deploy.sh` stages the project, installs production dependencies, and uploads via plain FTP using `lftp` (port 21, TLS explicitly disabled — the script's "SFTP" comment is wrong). See `pre_deploy.txt` for GoDaddy cPanel prerequisites (Node.js app setup, FTP credentials).
