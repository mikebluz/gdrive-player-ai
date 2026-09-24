# Measurement & testing discipline

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before writing a probe, a gate check, or a poison.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

### Measurement & testing discipline

- **A synthetic tap that lands OFF the element reads as "nothing happened" and passes a
  negative check.** `page.mouse.click` at a point outside the viewport or past the canvas does
  nothing at all, which is indistinguishable from the handler correctly ignoring it — measured
  while checking that a tap in the open plot clears a ⬚ Multi gathering, with the tap 70px below
  the canvas. **Assert `document.elementFromPoint(x, y)` is the element you meant**, and derive the
  point from the element's own published geometry rather than a guessed offset.
- **A SERVER THAT FAILED TO BIND LEAVES YOU MEASURING SOMEBODY ELSE'S BUILD.** `node server.js` on a
  taken port exits with EADDRINUSE while an older listener keeps answering, so every probe run looks
  plausible and tests the wrong code — measured 2026-09-22 as a feature "not working" that was
  simply not being served (the build had it; the port did not). `curl -s <url>/js/… | grep -c
  <a-string-only-your-change-has>` before believing a single result, and read the nohup log rather
  than trusting that a background start succeeded.
- **`localhost:3001` SERVES WHICHEVER CHECKOUT STARTED IT — usually not your worktree.** `server.js`
  is a static server rooted at its own cwd, so a fix committed in a worktree reads as NOT APPLIED in
  the browser and in every probe: the user's screenshot and a probe run both reproduced a bug that
  had already been fixed on the branch, and the numbers matched the pre-fix code exactly (2026-09-22,
  ♦ Beat's tempo). Check it before debugging a fix that "did nothing" — `lsof -a -p <pid> -d cwd -Fn`
  names the directory being served. Start your own on another port (`PORT=3002 node server.js`) and
  point every probe at it with `BLOOPS_URL`; do not restart or kill the user's 3001.
- **A worktree has no `js/config.js`** — it is gitignored, so the server answers that request with the
  HTML 404 page and every probe run against the worktree logs `Unexpected token '<'`. Harmless to most
  checks, but any "no page errors" assertion fails on it and the noise masks a REAL page error. Copy
  the file in from the main checkout before believing a probe's error list.
- **A probe that starts driving as soon as the page loads is racing the app's own boot.** The Player
  restores a saved playlist a few seconds in, and that calls `loadTrack`, which pauses the audio
  element and strips its src — so a playback check read "paused" with the position never leaving 0,
  DETERMINISTICALLY on the origin that has a saved playlist and never on a fresh one. Hook the call
  that disturbs you, stamp the time, and wait for quiescence. Never by clearing the origin's storage:
  on the dev server that is the user's real saved state.
- **Run a new probe against BOTH the dev origin and a fresh one.** Same code, different stored state,
  different answer — and the one you developed against is the one that lies to you.
- **Changing the instrument while ⚙ Deep is open leaves the draft stale.** Deep holds a STAGED copy;
  switching the voice on the card underneath rebuilds it, and the next material press lands on the
  OLD part — measured as "picked Beat, got a frozen synth", which reads exactly like the door being
  broken. Shut Deep, switch, reopen — which is the order a person works in anyway.
- **Measuring a preset through live dice measures the dice.** A Character is a set of stated values;
  with `vary` left at 45 from an earlier check, Half-time read 3/3/3 instead of 2/1/8. Turn the dice
  off before asserting about anything deterministic.
- **Applying a Character re-renders the card, so a captured control is DETACHED by the next one.**
  A probe that grabs `.v2-presetpick` once and reuses it applies the first Character and silently
  no-ops on every later one — which reads as the Character having no effect (measured: `pulses`
  stayed 1 where the preset says 8). Re-query inside the loop. The re-render-under-the-finger trap,
  hitting the probe rather than the user.
- **Re-reading the same part at a different `cycleSec` is not a longer look at it.** A 2-bar part
  read over 24s is ONE cycle resolved against the chord at its start, so a bass that plainly moved
  across C·F·G in an 8s read reported a single pitch class — and the check called the material broken.
  Derive from the cycle you already have.
- **A worktree server that fails to bind leaves the PREVIOUS worktree's build answering.** Port 3011
  was still held by an earlier worktree's `node server.js`, so a whole probe run measured code from
  two features ago and every failure pointed at the wrong cause. `curl` the served file for a string
  only the new build has before believing a red run — and kill the old server when leaving a worktree.
- **Measure the CLAIM, not the outcome, when the outcome is clamped.** A check that a gesture is
  REFUSED cannot be written against the value it would have changed: with nothing to pan the clamp is
  `[0,0]`, so the window reads 0 whether the gesture was declined or taken and driven into a wall.
  Found by poisoning — the guard was removed and the check stayed green. Assert on the mark the code
  leaves when it acts (`_dragged`), not on the state it would have moved.
- **Scroll a canvas into view and RE-READ its box before driving a touch at it.** A taller card (a
  progression adds rows) moves it after the geometry was read, and the touch then lands outside the
  element: `pointerdown` count 0, then a `pointercancel` as the browser takes it as a page scroll —
  indistinguishable from the gesture handler not working.
- **A poison that PASSES is a finding, not a dud.** It means either the cause you wrote down is not
  the one you fixed, or something else already owns the rule. Shipping a check that passes its own
  poison is worse than shipping none — the next person reads green and believes it.
- **Prove the rig can HEAR, and that its clock ADVANCES, before trusting any zero.** `state:'running'`
  is evidence of neither: a bare oscillator + analyser has measured `peak 0.5` with `currentTime`
  frozen. A gate run whose POSITIVE CONTROL reads zero is a broken rig, not N regressions — re-run;
  do not "fix" the subjects.
- **Measure at the altitude of the symptom.** "Notes fire" → the schedule log; "it SOUNDS" → the
  master tap (`_ambMasterTapNode`); "THIS layer entered late" → scheduled-vs-cancelled bookkeeping;
  "why" → per-call attribution inside the emitter. Each answers a smaller question than the next.
  One fix shipped three regressions in a row because each was invisible to the instrument that had
  just validated the one before it.
- **Measure the noise floor before believing a delta.** Live playback re-generates material every
  run; three identical runs have spread ±25%. A live-vs-X claim needs live measured 2-3 times first,
  and the gate must judge against live's OWN spread, not a fixed threshold — a fixed threshold
  manufactures phantom findings. Repeating a biased measurement is not measuring the noise.
- **Per-window, not aggregate.** An average over a take cannot see a trend; report the WORST window.
  A whole-mix statistic cannot see one layer dropping in and out — meter per layer, time-resolved.
- **A count is not a sound.** Count DISTINCT frequencies per onset (chords collapsing into unison is
  invisible to a count), and verify what reached `playNote`, not what a wrapper recorded.
- **Sweep a MATRIX, not the case you just fixed.** One config fixed and reported done has repeatedly
  been wrong for the other five. Enumerate the axes in writing and test the CROSS.
- **Reproduce from the user's ACTUAL config**, not one "shaped like" theirs. `bloomDump()` in their
  console (and `npm run test:replay dump.json` here) has ended multi-round hunts in one paste. When a
  report survives two rounds of cannot-reproduce, the next artifact is an INSTRUMENT IN THEIR RUNTIME
  — `bloomDump`, `bloomContentWatch`, `bloomSilenceWatch`, `bloomSeamWatch`, `bloomStrayWatch`,
  `bloomPartWatch` all exist because of that rule.
- **Pinned check failing after a deliberate change?** Decide which fork: it pins the old CONTRACT
  (restate it, with the reason) or the old GEOMETRY (move the probe, assert the same thing). Restating
  is normal and should make the claim stronger, not weaker.
- **One page, one state.** A probe that seeds state must restore EVERYTHING it wrote — snapshot the
  whole layer/part, not the fields you remember touching. Module-scope state (view modes, Maps) is
  invisible to a config restore and must be put back through its own control.
- **A probe that crashes tells you less than one red line.** Guard every `.click()` on a button under
  test, and put fixture restores in a `finally`.
- **`npm run test:ui` is SINGLE-VIEWPORT (390px, `isMobile`), so a DESKTOP-ONLY layout rule is not
  covered** — anything behind `@media (max-width: 540px)` has its other half ungated, and a poison
  there passes. Verify those by measuring at 390/620/900 in a probe, and note in the check's comment
  which half it actually asserts. Measure each width in a FRESH session: a `setViewport` that flips
  `isMobile` mid-run tears the panel out of the DOM.
- **Puppeteer specifics:** `page.setCacheEnabled(false)` or you measure the previous build (`?v=` never
  changes locally). A gesture fix is not verified until driven with `page.touchscreen` — mouse and
  touch are different pipelines, and native pan / pointercancel / passive listeners exist only in the
  second. `elementFromPoint` needs the element scrolled into view. Re-query after every click (a
  re-render detaches nodes). `_masterEng`, `savedSequences`, `_bloomGridEdit` are top-level lexical
  bindings — reachable by BARE NAME, never on `window`.
- **`grep` treats `17-ambient.js` as BINARY** — always `grep -a`, or an empty result reads as "that
  function does not exist".
- **NEVER `git checkout <file>`/`stash`/`reset --hard` in this repo** — it routinely carries days of
  uncommitted work. Undo a poison by restoring a `cp` backup taken first.
- **Multi-step patch scripts: assert `count == 1` and WRITE AFTER EVERY SUCCESSFUL REPLACE.** A script
  that asserts late discards the replacements that already matched. Never bound an index splice by
  "the next occurrence of a repeating token" — that once deleted four whole sections of this file, and
  the file still parsed. `node --check` cannot see an undefined identifier; read the patched region back.

- **A probe must not touch the shared LAYER LIST.** Clearing `area.layers` and adding one orphaned
  every module Map keyed on a layer id (VIEWM, BSEL, the cards) and broke EIGHT downstream checks — a
  config restore cannot put module state back. Drive the narrowest store that proves the claim; the
  progression alone was enough for the unit badge.
- **Never edit the source while a gate is running.** A restore-then-poison chained into the same shell
  invocation as a still-running `test:ui` mutated the file mid-run: the report named an unrelated
  check, the tally was five short, and the poison's own check never printed. Poison, run, READ, then
  restore — one step per invocation.
- **Assert INTERVALS, not absolute MIDI.** Two checks in a row pinned real pitches and failed on a
  layer whose register sits an octave up — a check a register move can break is testing the fixture,
  not the feature. Chord quality is a fact about pitch classes; an arpeggio's direction is a fact about
  the shape of its steps.
- **`BSEL` (the bar selection) is module state keyed on the PART'S SIGNATURE, so a config restore
  cannot clear it** — and two probes with the same-shaped fixture share a signature, so the second
  one's ruler tap DESELECTED the first one's bar and its panel never opened (`opened: false`). A probe
  that selects must deselect, through the control that does it (a second tap in the same place) —
  **and that second tap must RE-READ the canvas rect**. `getBoundingClientRect` is VIEWPORT-relative,
  so a rect captured before the panel opened points at empty space once anything has scrolled or grown
  (one extra button in the take bar was enough): the deselect misses SILENTLY, BSEL stays dirty, and
  the failure surfaces two checks later with nothing wrong at the scene. Re-resolve the canvas too —
  a render in between detaches it.
- **A panel's rebuild SIGNATURE may contain only the set of CONTROLS, never the values or which rungs
  are OWNED.** A commit runs `applyGate` → the panel's sync, so anything that changes on an edit
  rebuilds the block and the ± button under the finger is detached — two taps of + move the number by
  ONE. Write values, marks and faces IN PLACE; and a handler must then NOT force `host._sig = ''`.
  (Re-committed on the Groundwork panel, 2026-09-14; the gate caught it via `buttonSurvives: false`.)
- **Resolve every `getCfg`-derived value FIRST, take the record LAST.** Normalize DELETES an empty
  overlay, so a handler that creates `{}` and then calls something that normalizes is writing to an
  orphan — the press silently does nothing, with no error anywhere. The tell is a debug line printing
  `undefined` for a field you just assigned.
  **A PROBE holds the same orphan.** `_normalizeAmbientCfg` REPLACES objects on every `getCfg()`, so
  a layer captured once at the top and used after an edit is stale — and a stale layer makes two
  obviously different things measure as identical. Re-read it (`const Lat = () => cfg.layers[0]`)
  at every use. Measured 2026-09-20: two Characters an octave apart reported as the same notes.
- **⚙ DEEP LIVES IN THE CARD BODY — EXPAND THE CARD BEFORE OPENING IT.** Pressing `.v2-genbtn` on a
  collapsed card sets `v2-genopen` and lays the whole panel out at 0×0, so every row inside measures
  as hidden and reads as "the control is missing". Then press the `.v2-fttab` you need: Deep opens on
  Rhythm and CSS shows one tab at a time.
- **A CONTROL INSIDE ⚙ DEEP WRITES THE STAGED COPY, NOT THE LAYER.** Reading the change back from
  `getCfg().layers[…]` shows the OLD value and reads as "the knob did not write" — read
  `V2.stagedOf(id)`, and assert the layer is untouched until ✓ Done (that is the panel's contract).
- **THE SHEET'S TAB STRIP IS NOT INSIDE `.v2-pop-wrap`.** Scoping the query to the wrap returns an
  empty NodeList, which reads exactly like "the tabs were deleted" — scope tab queries to the CARD.
  More generally: an empty NodeList is never evidence a control is gone until the scope is checked.
  Two other ways this same check lied, both worth knowing: **the sheet opens on the EXPAND
  TRANSITION** (an already-expanded card has no `.v2-pop-wrap`, and the header press is a toggle, so
  tap until the wrap exists); and **`popOpen` MOVES the group body's rows into the sheet**, so a card
  re-rendered with a sheet open has none left to offer — read a tab strip BEFORE any loop that
  re-renders, not after.
- **THE v2 CARD'S CONTROLS ARE DELEGATED ON `input`, NOT `change`.** A probe that dispatches only
  `change` on a `<select>` reaches nothing and reads as "the handler was never wired" — the writer is
  never called and the config never moves. A real pick fires `input` THEN `change`; dispatch both.
  Before concluding a control is dead, WRAP ITS WRITER and check whether it was called at all.
