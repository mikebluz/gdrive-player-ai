# Native shell, iOS, Electron

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before touching the Capacitor shell, iOS audio/session behaviour, or the Electron build.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

### Native shell, iOS, Electron

- **THE LOCK SCREEN'S BUTTONS ARE CHOSEN BY WHICH ACTIONS YOU REGISTER.** iOS draws ⏮ / ⏭ only
  when `previoustrack` / `nexttrack` handlers exist, and falls back to ±10s seek when they do not —
  so registering `seekbackward` / `seekforward` GETS THE SEEK PAIR BACK. Their absence is a contract,
  not an omission. With no `mediaSession.metadata` at all iOS titles the card from `document.title`,
  which is how the Player read "Player — Mike Luz" over a blank square.
- **Now Playing artwork will not reliably load from a `blob:` URL, and fails SILENTLY** — a blank
  square, indistinguishable from having set none. Re-encode to a `data:` URL (downscaled, e.g. a 512
  square via canvas); the page's own `<img>` is happy with the blob and should keep it.
- **`setPositionState` THROWS on a non-finite duration or a position past it**, and the natural caller
  is `timeupdate`, so an unguarded call takes the progress bar down with it. Check both; report about
  once a second rather than per `timeupdate` (~4/s) — the phone interpolates from `playbackRate`.
- **ONE Now Playing card, so one owner: `window.__mediaSessionOwner`.** `bloops.html` loads the Drive
  Player AND Bloom's native audio, and both drive the card — without a claim the last writer wins
  whether or not it is the one making the sound. Each claims when it becomes audible (the Player in
  `onPlay`, Bloom when the native mix arms) and writes nothing while the other holds it; a new owner
  also CLEARS the actions it cannot honour, or Bloom's card keeps a ⏭ that skips a Drive track.
- **The Capacitor shell reroutes ALL audio through a MediaStream** (`00-native-audio.js`, inert on the
  web). Nothing may connect to `rawContext.destination` — use `window._bloopsSpeakerSink(ctx)`, which
  returns the stream node for the LIVE context and `ctx.destination` for an offline one. A direct
  connect re-classifies the context and it gets `interrupted` at every screen lock.
- **THE BROADCAST PATH NEEDS THE SAME DC BLOCKER THE MONITOR HAS.** An iOS session INTERRUPTION
  freezes the graph mid-sample and the resume restarts it there — the step's DC content is a thump.
  The monitor carried a 28 Hz high-pass for this from the day it was built; the broadcast, which is
  the audible path almost all of the time, did not, so every interruption popped. The mask's re-ramp
  at resume is gated `!nativeArmed` and the BRIDGE context is interrupted too, with nothing ramping
  that side in either mode — a filter in the path covers all of it with no second state machine.
- **A DELIBERATE SUSPEND HAS TWO OWNERS AND THEY COULD NOT SEE EACH OTHER.** `03-audio-bus-fx`'s
  keep-alive watchdog polls every 500 ms and resumes any suspended context, and it only knew
  `window.__bloopsAudioPaused` (Bloom's ⏸) — the shell's `userPaused` / `silencePaused` are
  module-local, so a lock-screen pause was undone half a second later (the piece lost its place, and
  the suspend/resume pair is itself a discontinuity). `window.__bloopsNativeHold` is the shared word.
  **Any new deliberate suspend must raise a flag the watchdog reads, or the watchdog will fight it.**
- **HARVEST THE FLIGHT LOG BEFORE THEORISING — `xcrun devicectl device copy from --device <UDID>
  --domain-type appDataContainer --domain-identifier com.mikeluz.bloops --source
  Documents/bloops-flight.json --destination ./bloops-flight.json`** `--destination .` FAILS
  ("Cannot open destination file …: Is a directory") — name the file. A first attempt may also die
  with "connection to the remote device is no longer valid"; just retry, it succeeds. It needs
  nothing from the user but a paired phone,
  and it answers in one command what several rounds of reasoning could not: four
  `ctx state → interrupted` → `rescue resume OK` pairs in 12 minutes, one 1.34 s after a stop press
  (the session-renegotiation tick, to the tenth of a second). It also REFUTES: the `SLEW` telemetry
  showed `media+` tracking wall 1:1 at `rate=1`, killing the resync theory it was built to test.
- **`run.sh` REPORTS EXIT 0 ON A FAILED BUILD** — it pipes `xcodebuild` through `grep -E 'error:|BUILD
  SUCCEEDED|BUILD FAILED'`, and the grep's success is what the shell sees, so
  `xcodebuild: error: Timed out waiting for all destinations…` (the phone not connecting — common, and
  it needs the phone UNLOCKED) scrolls past as a clean run. **Confirm an install by the `App installed`
  line, never by the exit code.** The same flakiness hits `devicectl`: a copy or a build often needs
  two or three attempts before the device answers.
- **`pagehide` tears the media pipeline down** (mute → pause → strip src → `load()`), because a
  navigated-away page's renderer keeps draining a dead feed. It never fires on a plain background —
  that IS the keep-alive design.
- **THE SIGN-IN GATE IS WEB-ONLY, AND "am I the shell?" HAS ONE ANSWER.** `window.BLOOPS_NATIVE` is
  published by `00-native-drive.js` (hoisted into the `<head>` of bloops.html for this — the inline
  boot script at the top of `<body>` reads it); `bloops.html` ORs it with `BLOOPS_LOCAL` into
  `BLOOPS_NO_GATE`, and `js/app.js` reads the same flag. Re-deriving it inline anywhere is a second
  vocabulary for one axis. Force it for a desktop test with `localStorage.bloopsNativeShell='1'`,
  which deliberately does NOT switch on the Drive shim (`bloopsNativeDrive` still owns that), so the
  web OAuth path survives the test. A "deployed" page is simulated with Chrome's
  `--host-resolver-rules=MAP <host> 127.0.0.1`, because `BLOOPS_LOCAL` keys off the hostname.
- **A `position: fixed` element's `offsetParent` IS NULL even when it covers the screen** — the
  documented `0×0`/`offsetParent` reachability recipe reports the full-screen sign-in gate as hidden.
  Use `el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})` plus a non-zero rect, which
  still reports false for a `display:none` ancestor.
- **A shim is per-page opt-in** — `00-native-drive.js` must be loaded BEFORE `google-drive-api.js` on
  every page that uses Drive. Grep for every page loading the library, not the page the bug was on.
- **A stylesheet that reserves space for a FIXED element is only correct on pages that HAVE it** —
  `bloops.css` gives body `padding-top: calc(40px + env(safe-area-inset-top))` for `.float-header`,
  which player.html does not have. `env()` is always 0 in a desktop browser, so shell-only geometry
  bugs are INVISIBLE here — drive the insets as CSS variables so a gate can stand in for a phone.
- **All testing is Chrome.** The one exception: desktop Safari as a WebKit proxy for an iPhone-only bug.
- **Electron:** the packaged shell serves from `app.getAppPath()` (never a hand-built `Resources/app`
  path — with asar that directory does not exist and a 404 body looks like a successful load).
  `@electron/packager` is pinned to 18.3.6 (19+ need Node ≥ 22.12). macOS does NOT throttle a
  backgrounded window — measured; the anti-throttle flags are insurance, not the mechanism.

### The MSE broadcast (`00-mse-audio.js`) — a producer/consumer pair with TWO clocks

- **THE TREMOLO WAS THE MSE STAGE — PROVED BY REMOVING IT, NOT BY INFERENCE (2026-09-28).** Seven builds
  chased it inside the broadcast path while every measurement of that path came back clean (rate
  0.986-1.000, reserve 0.80-1.08, no `ended`/`THIN`), and `test/probe-tremolo.js` showed the desktop
  ENGINE clean on the user's own harvested project (worst 7.8% at 4 Hz = note rhythm). Defaulting
  `bloopsMsePath` OFF and shipping a build settled it in one listen. **A localStorage switch is not a
  test you can ask a phone user to run** — it needs Safari Web Inspector over USB, and three requests
  for that "30-second A/B" simply never happened. Ship the comparison AS A BUILD.
- **A PER-CALLBACK PRODUCTION ESTIMATE IN THE RENDER THREAD IS NOISE, AND A STALE ONE RUNS THE BUFFER
  AWAY.** Writes land in 4800-frame chunks while the render callback is ~512 frames, so the
  instantaneous rate is either 0 or ~9 and never the truth; a sanity guard then rejected both, the
  estimate FROZE, and because the read rate is clamped down to it the reader could never speed up —
  the buffer grew to 1352 ms with `rate` pinned at 0.9526 and nothing able to drain it (flight
  2026-09-28). Measure production over a ~1 s WINDOW of accumulated frames, and **only ever clamp the
  rate DOWNWARD while the buffer is below target** — above it, draining must always win, or one bad
  estimate is unrecoverable. Reset the window on `flush()`: a transport edge invalidates it.
- **THE TRANSPORT MUST FLUSH THE NATIVE RING ON BOTH EDGES, OR PRESSES ARE LATE BY THE BUFFER DEPTH.**
  The stop gate mutes the GRAPH in 12 ms, which cuts tails at the source — but the ring still holds the
  buffered pre-mute audio and plays it out, so stop ran on for the whole depth (measured 409 ms) with
  everything upstream looking instant. Play has the mirror fault: while stopped the tap keeps writing
  SILENCE, so new music queues up BEHIND a bufferful of it. `flush()` ramps the frames about to play
  (a bare clear is a click, mid-waveform) and drops the rest, so press-to-sound is just the prime.
  **Three numbers, three jobs, and conflating any two is a regression:** `bufferMs` is burst headroom
  (free), the high-water mark is DEPTH = press-to-sound latency, and `primeMs` is the refill before
  playback resumes. Raising capacity while leaving depth unbounded is what produced a 3 s lag.
- **DEPTH CANNOT BE ONE NUMBER: it is press-to-sound AND stall tolerance at once.** Riding out a
  production stall of N seconds means already holding N seconds, so a single value has to be both
  instant and deep, which is impossible. It follows VISIBILITY instead — small while visible (nobody
  can press a button they cannot see) and large while hidden — via `setLatency()` on
  `visibilitychange`. **A `CAPPluginMethod` entry is required for every new plugin method**: without it
  the Swift compiles, the JS call rejects at runtime, and it reads as a logic bug, not a registration one.
- **THE NATIVE RING MUST BE BIGGER THAN THE MAIN-THREAD SCHEDULING GAP, AND CAPACITY IS NOT LATENCY.**
  The tap posts 100 ms chunks to the MAIN THREAD, which iOS throttles to ~2 s once hidden, so they
  queue and land ~20 at a time — ~2 s of audio in one burst. `ringCap` was 400 ms and overflow
  OVERWRITES (`else { head = (head + 1) % ringCap }`), so most of each burst was discarded and the
  render callback ran dry until the next one: periodic silence, on a period set by the throttle.
  `primeTarget` (0.35 s) is what sets latency; `bufferMs` only buys room to absorb a burst, so raising
  it costs nothing until the ring actually fills. **`plug.stats()` already resolved `buffered` and an
  `underrun` counter to JS and the poll threw the result away** — it reached only NSLog, which the
  harvested flight log does not carry, so the one number that separates "the ring starved" from every
  other lock-glitch theory was invisible for the whole investigation. It is logged now.
- **THE SERVO'S ARITHMETIC LIVES IN `00-mse-servo.js` AND IS PINNED BY `node test/mse-servo.js`.** Keep
  decisions there, not inline in `00-mse-audio.js`, or the gate stops testing what the app runs. It
  replays REAL production traces harvested from flight logs (plus synthetic shapes) and asserts three
  things, because the first two are not enough on their own: no starvation (a dropout), bounded rate
  slew PER SECOND (a jump — the loud tremolo), and bounded WANDER on steady production (a noisy control
  signal — the slow tremolo, 0.061 peak-to-peak vs 0.010 clean, which slips past the slew assertion
  entirely). Poison-verified against 5 mutations. **A harvested trace is NOT stationary** — production
  varies, the tick rate changes with visibility, the reserve drifts to target — so the wander assertion
  applies only to synthetic steady cases; auto-classifying a device trace as steady produced a false
  failure. And **`bufEnd` is too coarse to build a fixture from**: sampling it every 5 s aliases to
  ±7.4%, which reads exactly like real production wobble and made the gate's first run report nine
  failures that were all fixture noise. Builds after 2026-09-28 log `head=` (the encoder head, 46 ms)
  for this reason — prefer it when regenerating.
- **A STEP CHANGE IN `playbackRate` IS ITSELF AN ARTIFACT — SLEW-LIMIT IT, PER SECOND.** With
  `preservesPitch` on, a time-stretcher jerked between 1.00 and 0.90 is heard as a **SQUARE-WAVE
  TREMOLO**, not as a tempo change. Reported exactly that way on 2026-09-28, and the log named it:
  rate 0.902 / 0.920 / 0.919 at reserves of 1.13 / 1.42 / 1.57 — lurching while the reserve was
  perfectly HEALTHY, so it was noise, not control. "Clears up a bit once backgrounded" is the tell that
  it is the SERVO: the loop throttles to ~2 s when hidden and so lurches less often. Two rules:
  (a) never take the derivative on a segment-quantised signal — `bufEnd` steps 0.372 s, which over a
  2 s window fakes a slope of ±0.186/s (at gain 0.6 that is ∓0.11 of rate); use `ts`-based `headroom`
  at tap resolution instead; (b) cap the rate's rate-of-change PER SECOND, never per tick — this loop
  runs at 250 ms visible and ~2 s hidden, so a per-tick cap is 8x slower exactly where deficits are
  worst (simulated: per-tick starved the sustained-0.80 and transition-stall cases). Keep one escape
  hatch: below ~0.25 s of reserve, jump straight to target — a rate step beats a hole.
- **INSTALLING OVER A RUNNING APP DOES NOT RESTART IT — `devicectl process launch` FOREGROUNDS THE
  EXISTING PROCESS,** so the newly installed binary never boots and you test the OLD code. The tell is a
  flight log that keeps GROWING while its `BUILD` stamp stays on the previous build (cost a full
  build/poll cycle on 2026-09-28). `run.sh` now passes `--terminate-existing`; if you launch by hand,
  pass it too. **Verify the build stamp in the log, never just "it installed".**
- **THE SERVO MUST BE PD ON `ts`, NOT P ON `bufEnd`.** Two measured failures, both fixed by the same
  change: (1) `bufEnd` moves only in whole 0.372 s segments, so beating the quantisation forced an 8 s
  window, and an 8 s window needs ~12 s to notice a dip — measure the ENCODER'S HEAD (`ts`, one tap
  chunk = 46 ms) over 2 s instead; (2) a level-only trim reacts too late, because at a reserve of 0.79
  the trim was still capped small (0.79 was not yet "dire") and by the time it was, the reserve was
  gone — flight 2026-09-28 11:14 hit `ended` exactly so, with production at 0.863. **The SLOPE is the
  early warning: a falling reserve earns a cut now, whatever its absolute level.**
- **`ManagedMediaSource` IS DEMAND-DRIVEN — `sourceopen` NEVER FIRES ON A PAUSED ELEMENT.** That is the
  point of the Managed variant (the UA skips buffering it will not use), so waiting for `sourceopen`
  after assigning `el.src` is a RACE against whatever else happens to start the element, and a cold
  boot loses it. Flight 2026-09-28 10:52: MMS created at 0.52 s while paused, element reached `playing`
  only at 5.62 s, the 4 s wait expired at `readyState=closed`, and **the whole broadcast silently
  degraded to the AVAudioEngine fallback** — no MSESTAT line anywhere, which is the tell. The run that
  worked reached `playing` at 4.19 and opened 0.12 s later: the open FOLLOWS demand. `el.play()` before
  the wait (and re-nudged during it) creates the demand; with no source buffer yet it just stalls,
  harmlessly. **Then pause before handing over, or the first segment plays against a ~0 reserve.**
- **EVERY VISIBILITY TRANSITION STALLS THE AUDIOCONTEXT, AND NO CONSUMER CAN INVENT THE MISSING AUDIO.**
  Measured per BEAT pair (flight 2026-09-28 10:52): visible→hidden 0.893, then 0.579 and 0.725 on the
  second lock, followed by a **1.395 OVERSHOOT** as the clock catches up; hidden→visible 0.857 and
  0.907. The worst edge lost ~1.4 s of rendered audio over 3.5 s. This is upstream of the output path,
  so it hits BOTH: the MSE reserve (0.6-1.2 s) and the native ring (`bufferMs` default **400 ms**,
  never overridden from JS) are each far too shallow for it. Only the MSE path can defend itself, via
  the rate servo — AVAudioEngine pulls at a fixed hardware rate, so rate matching there needs Swift.
  **"Glitching when backgrounding/foregrounding" is this, not the steady-state deficit.**
- **THE BROADCAST IS A PRODUCER/CONSUMER PAIR AND THE TWO CLOCKS DO NOT MATCH.** The element consumes
  at `playbackRate × wall`, exactly; the encoder produces at whatever rate the graph actually renders,
  and while the app is HIDDEN that measured **0.873 and 0.907** (flight 2026-09-28) against a reserve
  of only 0.64–1.14 s — it starved to `ended` twice, then thrashed pause→playing 4× in 9 s. **No
  cushion DEPTH fixes a rate deficit, because a rate deficit never stops.** The consumer must TRACK
  production (`playbackRate`, feed-forward on the measured rate + a small reserve trim). Pure feedback
  on the reserve provably cannot: it needs the reserve to be wrong before it acts, so any bounded
  correction only delays the starve (a ±6% clamp against 12.7% still hit zero in simulation). The
  floor must sit BELOW the worst production rate, never at it, or there is no headroom to rebuild.
- **MEASURE PRODUCTION AS `bufEnd` GROWTH PER WALL SECOND — never from a context's `currentTime`.**
  The tap is on the BRIDGE context while the `BEAT` heartbeat logs the RAW one, and they are throttled
  independently (same flight: raw 0.9398 while production was 0.873). `bufEnd` is also seek-immune,
  which `elT` is not. Use a window ≥ 8 s: segments are 0.372 s, so a 2 s window is ±19% quantisation.
- **A HOLDOFF OVER IN-FLIGHT BROADCAST AUDIO IS MEASURED FROM `ts`, NEVER A FIXED DELAY.** The stop
  cover was 900 ms on the claim that in-flight pre-mask audio is ≤ ~0.5 s; it measured 1.25–1.56 s all
  session, so the last 0.4–0.7 s of pre-stop music played out ~0.9 s AFTER the press — the intermittent
  "blip at stop". `ts/1e6` is the production head: everything before it is pre-gate, everything after is
  true silence, so release when the PLAYHEAD passes it. Any fixed delay silently rots as the reserve
  changes depth. Generation-tag the backstop timer, or stop→play→stop inside it cuts the newer cover short.
- **MAIN-THREAD TIMERS THROTTLE 1 s → 2.00 s THE MOMENT THE APP IS HIDDEN** (measured, both hidden runs
  of the same flight). So a `% n`-tick cadence samples ~8× slower there — a `% 20` on the 250 ms loop
  sampled every 40 s and brief starves fell between samples entirely. **Log on a WALL-CLOCK cadence**,
  and never rely on a timer for starvation defence while hidden.
- **PAUSING IS NOT AVAILABLE AS A STARVE RECOVERY WHILE HIDDEN** (a paused renderer is what iOS
  reclassifies — trap 3(b)), which is why the `waiting` handler was gated to `visible`. But that left
  the hidden case with NO recovery at all while the 250 ms loop kept re-`play()`ing into an empty
  buffer — the thrash. Recover by dropping the CONSUMER rate and staying audible instead.
- **`preservesPitch` ON makes a rate warp a TEMPO trim, not a transpose.** Tracking a 0.87 production
  rate is not a distortion — the music is BEING GENERATED at 0.87, so 0.87 is the only rate that
  renders what exists; 1.0 would need material that was never made. A semitone that snaps back at
  unlock would be unmissable; a tempo drift while the phone is in a pocket is not.

### The native output ring (`BloopsSpliceRing.swift` in bloops-native) — the audible path since MSE went off

- **ANYTHING PACED BY `setTimeout` STALLS ON A HIDDEN PAGE — including Bloom's voice-build queue.**
  `_vqPump` built voices in 12 ms slices, 12 ms apart, on `setTimeout`; hidden iOS pages throttle
  timers to 1-2 s, so in the background the queue drained ~100x slower than Bloom filled it and
  roughly half the notes were never built — only the node-voice layers (core voices now BYPASS the queue — see traps-audio),
  heard as "slowed way down, only some notes, some layers". Measured on the ring's INPUT capture:
  12-16 attacks / 5 s visible, 7-10 hidden. **Building at emit instead was measured WORSE**: the
  hidden tick schedules 5.6 s ahead, so each tick built seconds of voices in one burst and the graph
  mutations stalled the render thread (production 0.89 at the hide, 807 ms of ring underrun). Hidden
  keeps the queue and changes only the PACING: build a voice once it is due within 3.5 s, in 6 ms
  slices chained by MessageChannel (a task, not a timer — not throttled). Measured after the first
  fix: 18-31 attacks / 5 s both visible and hidden. **Desktop Chrome cannot reproduce it** — an
  audible tab is exempt from throttling there, so a Mac probe passes the pre-fix code too.
- **THE DISPLAY LAG AND THE KEEP-ALIVE BELONG TO EVERY OUTPUT PATH, NOT ONLY MSE.** Play heads,
  visualisers and the elapsed clock all subtract `window._bloopsMseOutLag()` (via
  `_shapeAudibleNow`), and only the MSE path defined it — so on the native path they ran ahead of
  the sound by the ring's whole depth ("a full bar ahead" after a lock). It now returns the ring's
  measured depth. Likewise the keep-alive element must carry the 25 Hz tone, never a mix copy: the
  −40 dB copy was all that sounded while the ring primed ("starts very quiet, then jumps") and ran
  up to 2 s ahead of the real output. Keep the tone context's stream CONSUMED (a zero-gain path to
  the element) or WebKit suspends it at lock.
- **THE LOCK GLITCH WAS A GAIN DUCK UPSTREAM OF THE RING, NOT THE RING (found 2026-09-28, after a day
  of tuning the ring).** `raw.onstatechange → running` snaps `maskGain` to 0 and ramps it back over
  80 ms unless `nativeArmed` — and only the MSE branch set `nativeArmed`, so once MSE went
  default-off the native path ducked (click + dropout) at EVERY interruption: every lock, unlock and
  app switch. It was invisible to every ring counter (0 underruns, 0 poor splices) because it sits
  before the tap, and to out-vs-in capture comparison because the INPUT already had it. **When the
  ring's telemetry is clean and the user still hears it, score the ring's INPUT against the log's
  event times** — `RESUMES=… node tools/analyze-capture.mjs` now fails on a dip at a context resume
  (verified: 7 of 13 resumes flagged on the pre-fix capture). Any new arm path must set
  `nativeArmed`.

- **STEERING DEPTH BY RESAMPLING IS A PITCH BEND.** The first reader read the ring at 0.94-1.01x
  with linear interpolation to grow/shrink its reserve — a varispeed, so every correction was heard
  as the music going flat and gliding back (rate 0.95 ≈ a semitone, logged after locks AND after
  every Play press, because the ring starts shallow at the prime). The reader now never changes
  pitch: between corrections it is a bit-exact copy, and a correction is a SPLICE — repeat or skip a
  10-30 ms waveform-matched segment behind a 20 ms crossfade, deferred across a transient. Its
  arithmetic is gated OFFLINE on the Mac: `swiftc -O ios/App/App/BloopsSpliceRing.swift
  <copy of tools/splice-test.swift named main.swift>` (top-level code only compiles as `main.swift`).
  Poison-verified: hard-cut splices give ~580 clicks on the pad scenarios, the real ring 0.
- **TAP THE MIX ON THE TONE CONTEXT, NEVER AFTER THE MEDIASTREAM HOP.** The bridge context keeps
  running at 1.0 and fills whatever the tone context failed to render with DIGITAL SILENCE, so a
  tap on the bridge saw a full frame rate carrying holes — the ring measured no deficit and played
  every hole (captured: each injected stall arrived as 2-8 ms of zeros; splices then repeated
  some). On the tone context a shortfall arrives as FEWER FRAMES, which the ring stretches. The tap
  is built with `Tone.context.createAudioWorkletNode` (the native constructor rejects Tone's wrapped
  context), post-mask, behind the same 28 Hz DC blocker; the bridge + element remain the keep-alive.
  Any transport-like edge must flush the ring (the lock-screen Pause does now), or the reserve —
  up to 2 s while hidden — plays out after the press.
- **"DOES IT SOUND RIGHT" IS MEASURED, NOT ASKED.** own/ownstall soak builds record the frames
  handed to AVAudioEngine AND the frames the ring received (`captureStart` →
  `bloops-capture.wav` / `-in.wav`); `node tools/analyze-capture.mjs out.wav in.wav` counts GAPs
  (digital silence inside audio) and JUMPs (second-difference spikes) and fails when the output has
  defects the input did not. Validated: a 10 ms hole and 25/30 hard cuts are caught, clean passes.
  **A capture must never touch the render thread's budget**: two buffers assigned from one array
  shared storage, so the first write copied 17 MB copy-on-write inside the callback (2983 µs).
- **THE PHONE BUILD IS DEBUG (`-Onone`) — ANY DSP IN THE RENDER CALLBACK MUST BE TIMED THERE, NOT
  ON THE MAC.** The first splice-ring build sounded "terrible, glitching": one splice's correlation
  search took ~7.6 ms unoptimised against a 2.7 ms callback (0.06 ms at `-O`), so every splice
  dropped a buffer — and every ring counter read clean, because an overrun is invisible to the ring.
  The offline gate compiled `-O` and could not see it. Fixed by `SWIFT_OPTIMIZATION_LEVEL = -O` in
  the Debug config, and the callback now times itself (`cbw=`/`cbover=` in NATIVE lines; `verify.sh`
  FAILS on any callback over half its deadline after warm-up).
- **ABSORB FIRST, STRETCH LAST (real locks, 2026-09-28).** At a lock, delivery goes bursty for ~10 s
  (the depth trough falls 230-360 ms) and the engine renders 0.90-0.96x for ~6 s (~0.4 s never
  made). Meeting that by splicing at once — 20-44 splices in ~5 s, down to 0.88x — was heard as
  "slows down a bit and drops out", with 0 underruns in the log: the ring never ran dry, the
  splicer WAS the defect. The reserve (visible 850 ms ≈ the old reader's depth) eats it silently;
  tracking only engages when the SMOOTHED depth (~1.5 s) is under 0.45 s and production is short
  over seconds; hard stretching only under 0.1 s. Growth toward the hidden target waits 15 s after
  hiding, so it never stacks on the lock edge. The gate's "measured lock" scenarios carry a
  lock-window splice budget — splices, not underruns, are what was heard.
- **THE COMMON CASE IS "PRESS PLAY, LOCK THE PHONE" — THE RESERVE IS SMALLEST EXACTLY THEN.** Real
  log: locked 2.8 s after Play with only the 350 ms prime; the edge took it to 28 ms and every
  splice had to take whatever join it found. Reserve = press latency until it grows, so growth
  right after Play is 5% (near-perfect, attack-free, level-matched joins only) — and a proportional
  term (`err/30`) silently capped that "5%" at 1.8% on the first try. Splices must never REPLAY or
  SKIP an attack (limit the splice LENGTH so the attack stays outside — rejecting any splice near an
  attack starved the ring on a dense beat) and never join across a >3 dB level step.
- **SCORE WITH REAL MUSIC, AND KNOW THE METER'S NOISE.** Synthetic partials always find a perfect
  join, so the gate never saw a poor splice until run with `MUSIC=<phone capture of the ring's
  input>`. And an attack count swings ±5% on the SAME file with a few ms of shift (124-135), which
  twice read as "notes doubled" — the analyzer averages over 12 block alignments now.
- **`process.exit()` CAN HANG NODE HERE — use `process.exitCode`.** On this Mac's Node 26.8.1 an
  explicit exit after processing ~17 MB deadlocks in `WorkerThreadsTaskRunner::Shutdown` →
  `pthread_join` (sampled): the verdict prints, the process never ends. It read as a hung scorer
  twice and once held the phone on the autoplay build. `verify.sh` also restores the phone BEFORE
  any Mac-side step, and runs the scorer under `perl -e 'alarm 60; exec @ARGV'`.
- **SPLICE ONLY WHEN IT BUYS SOMETHING.** Visible target 650 ms sits inside the deadband above the
  350 ms prime, so steady visible playback does not splice at all; the low guard (0.2 s) sits well
  below the prime, or the 100 ms chunk troughs right after every Play/Stop trip it (59 splices in
  6 s on-device). Non-urgent growth/drain splices wait for a join with correlation ≥ 0.85.
- **LATE IS NOT LOST.** At the hide instant delivery goes bursty (measured: trough fell ~470 ms and
  came back). Any production estimate built on the depth TROUGH keeps that hole in its window after
  the frames land; a reader trusting it slowed to 0.70 for audio that had already arrived, overshot
  to 3 s and spliced a second back out. Take the larger of the trough figure and frames-RECEIVED over
  6 s, and have EMERGENCY guards read the depth NOW, never the windowed minimum.
- **A STOP FLUSH MUST PLAY ITS RAMP IMMEDIATELY AND DISCARD WHAT IS IN FLIGHT.** Marking the ring
  unprimed at the flush cut the waveform dead (a click at Stop), and the tap's partial 100 ms chunk
  plus the bridge queue arrived AFTER the flush and played ~350 ms later as a blip. `flush` now ramps
  out in real time and takes `discardMs` (200 on Stop — what follows a stop is silence anyway).
- **AN APP SWITCH DOES NOT REPRODUCE A LOCK.** `verify.sh` backgrounds via Settings: 6 min hidden
  held ctRate 1.00 with the user's own 5-layer project, while real locks measured 0.80-0.95 for
  seconds (progressive to 0.56 once, MSE era). The phone cannot be locked from the Mac, so the
  `ownstall` autoplay mode injects context stalls instead (`AUTOPLAY=ownstall ./verify.sh`), and the
  flight log carries `lock=` (protected-data notifications), `low=` (ring low-water), `spl=` and
  `prod=`. **The previous session's log is kept as `bloops-flight-prev.json`** — the glitchy session
  is almost always the one before the relaunch that overwrote it.
- **`capacitor://` ANSWERS `fetch` WITH `ok:false, status:0` AND A FULL BODY.** Anything that checks `res.ok`
  silently fails in the app and works on the web — Tone's `ToneAudioBuffer.load` did, so every manifest
  sample (Tone.Sampler) was silent on the phone. `00-native-audio.js` replaces that loader under the
  scheme (status ≥ 400 or an empty body = failure). A new loader: check the BYTES, never `ok`. Repro it
  in the simulator with a baked `bloopsauto.js` — mute by `Tone.getDestination().output.disconnect()`
  (volume −∞ also silenced the Bloom mix at the input), and pull an analyser through a 0-gain node to
  `raw.destination` or WebKit never renders it.
- **THE iOS SIMULATOR PLAYS THROUGH THE MAC'S SPEAKERS.** A soak build left running there autoplays
  the user's project on their laptop with no visible source (reported: "I hear blooms playing and
  can't find where"). Every simulator run ends with `simctl terminate` + `simctl shutdown`.
- **`verify.sh` MUST STOP ON A FAILED BUILD.** It fell through to `install`, which put the PREVIOUS
  binary beside freshly synced JS; the stamp check cannot catch that because the stamp is in the JS.
