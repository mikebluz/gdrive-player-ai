# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

> **Full history:** this file was condensed from a 1.2 MB running log on 2026-09-14.
> The complete, unabridged entries live in **`docs/claude-md-archive.md`** — grep it when a
> condensed line here is not enough (it keeps every measurement, repro and probe recipe).

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

## Record learnings here (avoid repeat debug churn)

When a bug takes more than a couple of attempts — especially anything non-obvious about this codebase
(CSS overriding JS, event/lifecycle ordering, audio scheduling, save/load quirks, the Bloom engine,
view-mode rules) — **add a short entry below in the same change**: the symptom and the cause/fix, one
or two lines. Check this list before deep-debugging a UI/audio/state issue.

**Keep it short, and put it under the right subheading.** This file is loaded into context every
session, so it is a REFERENCE, not a log. An entry earns its place by being a rule someone will break
again — a trap, an invariant, a diagnostic recipe. It does NOT earn its place by recording what was
built and why (the code comments carry that, and they are thorough here), the debugging narrative,
gate counts, or poison bookkeeping. If a lesson already has a line, SHARPEN THAT LINE instead of
adding a second one. This file reached 1.2 MB — roughly 300K tokens every session — by ignoring all
of that.

---

## Gotchas / hard-won learnings

### Measurement & testing discipline

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

- **A panel's rebuild SIGNATURE may contain only the set of CONTROLS, never the values or which rungs
  are OWNED.** A commit runs `applyGate` → the panel's sync, so anything that changes on an edit
  rebuilds the block and the ± button under the finger is detached — two taps of + move the number by
  ONE. Write values, marks and faces IN PLACE; and a handler must then NOT force `host._sig = ''`.
  (Re-committed on the Groundwork panel, 2026-09-14; the gate caught it via `buttonSurvives: false`.)
- **Resolve every `getCfg`-derived value FIRST, take the record LAST.** Normalize DELETES an empty
  overlay, so a handler that creates `{}` and then calls something that normalizes is writing to an
  orphan — the press silently does nothing, with no error anywhere. The tell is a debug line printing
  `undefined` for a field you just assigned.

### CSS, layout and DOM traps

- **`.ambient-select` is `width: 100%` and declared LATE.** Dropped into an auto-sized inline-flex or
  flex row it demands the whole line and crushes its siblings — it has swallowed at least five
  controls. Fix with a COMPOUND selector (`select.ambient-select.<its-class>`), an explicit width and
  `flex: 0 0 auto`. Verify by measuring the SIBLINGS, not the control you added.
- **A class rule that sets `display` beats `[hidden]`.** `el.hidden = true` then hides nothing. Any
  element toggled by `hidden` needs a companion `[hidden] { display: none }`.
- **`opacity` on a parent composites the whole subtree** and cannot be undone by a child. Dim the
  CHILDREN when a live control must stay readable.
- **Specificity/cascade:** a single-class override loses to a two-class or later rule. Assert by
  reading `getComputedStyle`, not by looking. `!important` beats a non-important INLINE declaration
  (that is how `--eucols` gets overridden).
- **`applyGate` owns INLINE `display` on gated rows**, and `.v2-rowoff` is `!important`. Block layout
  for such a row must come from a CLASS, never an inline style; folds must be classes too.
- **`.ambient-ctrl` is a 3-column grid.** A third child auto-places into the trailing `auto` column
  BESIDE the control; a control spanning `2 / -1` pushes a sibling hint into the ~60px label column.
  State the bands (`grid-column: 1 / -1` on the hint is usually enough — spanning every column cannot
  fit, so placement alone pushes it to its own row). **The sheet pane is a SINGLE column** — the same
  row is two different grids in the body and the pane; check both.
- **A compact-control rule scoped to one container does not reach a second one.** Grep the component's
  class in the stylesheet before assuming a new surface inherits anything.
- **`position: sticky` is silently dead app-wide** — `html`/`body` carry `overflow-x: hidden`, so body
  is a non-scrolling scroll container. Use `position: fixed` + reserved flow space.
- **Body-attached overlays are force-hidden by the view-mode CSS** (`body.view-mix > *:not(...)`).
  Show them with INLINE `display … !important`, and add a `:not()` for any new body-appended overlay.
- **`position: fixed` overlays drift** because `backdrop-filter` on an ancestor makes it a containing
  block. Measure-and-correct: set 0,0, read the rect, subtract it.
- **A menu must paint ABOVE whatever opened it, and the ceiling moves.** Current band: `.sm-overlay`
  10300 · v2 popovers (`v2-genwrap`/`gwwrap`/`barwrap`/`steppop`) 10310 · `.sd-overlay` 10400 ·
  `.key-picker-overlay` 10500 · note-editor & `#sample-bank-mgr` 10600 · `#drum-kit-editor` 10700 ·
  `.ctx-menu` 10900 · toasts 100000. `.v2-secpop-wrap` sits BELOW the dialog band at 10250 on purpose
  — a sheet over one card must not outrank dialogs. **Assert stacking by HIT-TEST, never by the number.**
- **Scroll anchoring is a heuristic, not a lever.** Growing content (e.g. opening the note editor)
  makes Chrome scroll to keep the new content still, pushing the drawing off screen — with an EMPTY
  scroll log, which is the tell. `overflow-anchor: none` measured differently across two runs of the
  same scope; pin deterministically instead (record the anchor element's viewport top, measure after,
  give back the delta — the absorbing-scroll idiom the note drag uses).
- **A card rebuild (`innerHTML`) loses scroll position and detaches docked children.** `V2.render`
  saves/restores `scrollTop`; `_ambRenderExtras` parks `#lane-expander` in a stash and re-docks after.
  Resolve the nearest scroller with `scrollerOf(el)` (the panel scrolls inside `#mix-view`, so the
  document alone moves nothing) and resolve it BEFORE the rewrite, while the content is still tall.
- **A grid column sized `auto` by a LIVE readout resizes every sibling each time the text changes** —
  any readout that updates per press needs a fixed column.
- **Key-grouped chips must render in a SUBGRID container** — a flex `.key-group-container` ignores
  `grid-column: span N` and shrinks them to text width.
- **`.ambient-hint` inside a `.sm-modal`/`.step-div-modal` must be given `white-space: normal`** or it
  runs straight out of the fixed-width dialog.
- **iOS zooms in on a focused text field under 16px and never zooms back** — every text-entry field is
  floored at 16px under `@media (pointer: coarse)`. `<select>` shows a picker and does not zoom.
- **`touch-action: none` blocks two-finger pinch too** — use `pinch-zoom` for surfaces that only need
  single-finger drags. Capacitor's `ios.zoomEnabled` defaults to FALSE and is invisible from the web.

### Controls, wiring and reachability

- **Know which of three wiring mechanisms a control uses before adding a handler:** DOCUMENT-delegated
  (steppers — `__ambStepperWired`; add nothing), HOST-SWEPT at build time (`.ambient-collapse`,
  `.ambient-grp-head`, `.ambient-euclid-grid` — either let the sweep have it or exclude yourself, never
  both; a doubled handler makes taps cancel and the control reads as DEAD), or unwired (yours).
  A new card rendered INSIDE the panel host inherits the panel's sweeps — `.v2-layer` is skipped in
  two of them for exactly this reason.
- **Controls keyed by layer and delegated on the panel host cost nothing to reuse** (`data-phkey`,
  `data-kokey`, `_ambCardKey`) — the markup IS the wiring. Id-bound controls need per-card wiring.
  Check before writing a second implementation: `grep -c '_ambCardKey('` answers it.
- **Reusing a v1 CLASS means inheriting v1's sweeps** — `_ambRefreshEuclidGrids` rewrites every
  `.ambient-euclid-grid` in the host. And reusing a class name is NOT reusing the component: call the
  builder (`_ambSl`, `_ambStep`) or you get the classes without the structure they require.
- **A duplicate class makes `querySelector` answer for the wrong surface.** When adding a second
  instance of anything, rename its hooks in the SAME change.
- **A control that re-renders its own panel on `input` cannot be dragged** — the re-render replaces the
  element the pointer grabbed. Mirror readouts on `input`; do the rebuild on `change`.
  Isolating test: dispatch ONE input and ask `document.contains(el)`.
- **A `<select>` whose value matches no option silently shows the FIRST one** — it does not render
  empty. Always include the current value among the options, and re-check after any remote list.
  A select that doubles as a live readout must not stomp an explicit user choice.
- **Live-readout chips must not be focusable `<button>`s** — a repaint between mousedown and mouseup
  drops the click. Use `role="button"` + `pointerdown`.
- **`showCtxMenu(x, y, actions)`** — opening it from inside a `pointerdown` (or from another menu's
  item `fn`) must be deferred a tick, or its own dismiss listener eats it. It measures its box twice
  (append + next frame) because menus reflow. A list of 200+ belongs in a filterable modal, not a menu.
- **`_ambSl`'s `hint` goes into a `title`, which a phone NEVER shows.** Say the unit in the READOUT.
  `100`, `0` and `1` are the values most likely to be meaningless — they express a RELATIONSHIP.
- **Sliders need `.ambient-sl`** or they get no touch handling at all (delegated `pointerdown`: grab
  anywhere, move by DELTA never jump, vertical distance = fine adjust, tap = numeric entry). Arm on
  CUMULATIVE travel, never a per-move delta.
- **A tap-to-cycle number is a bug**; so is a control that is absent in some states. **Render it and
  DISABLE it**, with the reason in the title — a conditionally-rendered control cannot be found,
  learned, or asked about. A press that cannot act should REFUSE AND EXPLAIN rather than do nothing.
- **A control is a mode, a status, or an action — never two.** On an on/off toggle put the FEATURE'S
  NAME on the face and the state in the fill; a label that exists only while the mode is active cannot
  be found by someone looking for the mode. **Carve-out: a DISCLOSURE toggle is attached to the thing
  it hides**, so the context is present either way — there the face names the ACTION (`Show`/`Hide`)
  and the title names what is shown.
- **Divergent behaviour ⇒ divergent label; same state ⇒ same word.** Renames are LABEL-ONLY — data
  keys stay for save-compat. Before renaming, write the sentence out and make every surface use its
  words; when one axis has two vocabularies (state says X, button says Y) it reads as two mechanisms.
- **Prose is the first suspect.** A STATIC explanatory block never changes and never responds, so past
  the first read it is noise forever — the controls state the model better than a sentence about it.
  Before shortening, list every surface that states each fact: the cut is usually deciding which ONE
  surface owns it, not compression. Read the WHOLE open view — the head, the line and the drawing have
  repeatedly said the same number three times.

### Bloom: config, normalize, schema

- **`_normalizeAmbientCfg` runs on EVERY `getCfg()`** and REPLACES objects (notes are re-mapped and
  re-sorted; `prog.parts` is rebuilt fresh). Consequences:
  - **A value read before a `getCfg` is an ORPHAN** and writing to it is silently discarded. The bite
    is ARGUMENT EVALUATION ORDER: `cfg.prog.parts[L().partFor].name = …` takes the array first.
    Resolve indices into locals; re-resolve records on every pick.
  - **An index is only valid until the next `getCfg`** — re-find a note by WHAT IT IS (nearest t + midi).
  - **Anything a repair function rebuilds must be carried explicitly.** `_ambRepairParts` builds a new
    object per part — `key`, `salt`, `passSalt`, `grid`, `rubato`, `part` have each been dropped by
    forgetting this.
- **The numeric backfill clobbers non-number defaults.** `Number.isFinite(true) === false`, so a
  BOOLEAN or OBJECT in a layer's defaults is reset on every normalize. Keep additive booleans/objects
  OUT of `_ambDefaultLayer` and coerce them only when present.
- **Absent-by-default is what keeps the gates green.** A field absent from `_ambDefaultLayer` is
  byte-identical by construction (the harness builds from it directly). Prune a value equal to the
  default — but an explicit all-zero object can be MEANINGFUL ("no salt on this pass"), and pruning it
  destroys the statement. Ask what the object means with only that one field set.
- **A per-layer normalizer is reached from FOUR places — primaries, extras, seq, samp — and it is
  always the PRIMARIES that get missed.** Same for sweeps over `cfg.layers`: ten of v1's layer sweeps
  did not know it existed. Grep the sweep signature and diff; do not audit from memory.
- **A new layer store must join EVERY sweep**: Clear area, the mixer list, the scheduler list,
  normalize, the bounce, `_ambWantSet`, `_ambKeyOfLayer`, `_ambWarmSampleIds`, transpose, solo.
- **A normalizer's coercion decides what a field accepts** — `_ambNormalizeFx` does `pe.on = pe.on === true`,
  so writing `1` flattens to false and the control looks dead. Check the coercion before wiring.
- **`_ambMixerLayers` must skip `seq`/`samp` in its extras loop** (the dedicated list helpers already
  enumerate them) or every Seq/Sample layer appears twice.
- **`_ambRenderMixer` TAIL-renders the Scheduler and Groove** — an early `return` inside it silently
  freezes those two views.
- **`_AMB_LAYER_SCHEMA` sl/tm rows are `[kind, key, LABEL, min, max, hint|step]`** — min/max are
  `c[3]`/`c[4]`. Reading `c[2]`/`c[3]` made the per-layer dice zero every slider.
- **A schema token needs BOTH halves**: the renderer branch and the wiring branch. Primaries render
  from the schema but WIRE from a hardcoded `bind()`/`set()` list, so a new token works on an added
  layer and is inert on the default one.
- **Ramp targets auto-derive from sl/tm schema tokens; everything else needs a manual entry**, and the
  shared Stereo/FX/Spatialize lists must be appended AFTER the derive or schema-only types get none.
- **Adding a mod LFO shape needs three places in sync** (`_ambShapeSel`, `_AMB_MOD_SHAPES`,
  `_ambMakeSrc`) or it silently degrades to sine.

### Bloom: the arrangement clock

- **`_ambProgStepAt` is the one clock, and it reaches the parts walk FOUR ways** — arch chain, legacy
  expansion, section-bound, and the memoised passes-grid plan. A feature added to one is ABSENT from
  the others; a freshly-built test project always takes the arch path, so test all four.
- **Its `step` is NOT monotonic** (a revisited part replays the same values), so `step % len` is the
  chord and `floor(step / len)` the variation cycle — but anything measuring a chord's EXTENT must
  bisect `_ambProgInstanceAt` instead.
- **There is ONE clock: `_progAnchor` is pinned to `_barGridAnchor` at play start.** The old split was
  the first-tick lead (115-350 ms, different every press) and produced three separate bugs. Anything
  new anchors on `_barGridAnchor`; `_ambChordGridOff` is an ANCHOR DIFFERENCE, not a time-domain shift
  — anything asking "what is sounding at t" passes `t`.
- **`_ambChordSpanAt` BISECTS, so its edges carry float noise** (measured 1.00005 bars for an exact
  one-bar chord). Snap to the 1/48-bar grid (`_ambSnapBars`) — every real boundary (quarters, eighths,
  triplets, 16ths) lands on it exactly and only the noise is removed. This family has shipped at least
  four bugs: flashing redraws, off-by-one chord selection, a mapped phrase re-installing every chord,
  and a per-part window resolving to the previous part.
- **A resolver that answers at N levels must hand back WHICH level answered** — collapsing to the
  narrowest is not an inheritance chain (a pass-row mapping fitted per CHORD cut the phrase to a
  quarter of its notes).
- **`psi.subUnit` is the SCHEDULER'S uniform grid and must stay uniform** — making it vary skipped a
  chord outright. "How long is THIS chord" is a different question: `_ambChordSpanAt` /
  `_ambLayerBarPeriodSec`. Never answer the second with the first.
- **A merged hang+chord span is for the CHOKE, never for a progress bar** — trim it for display
  (`_ambSpanTrimHang`).
- **Chord DISPLAY must resolve through `_ambProgChordAt` (identity) and `_ambProgSoundAt` (the label)**
  — reading `prog.chords[step % len]` shows the AUTHORED chord, and the key transpose/section/part key
  is applied LATER in `_ambSrcRootPc`. A static drawing of every part uses `_ambAreaKeyRootPc` /
  `_ambAreaKeyScaleName`; only something resolving ONE moment uses the time-aware pair.
- **Hand-offs switch on the HORIZON, not on `now`** — the tick schedules ~1.3 s ahead, so the Write
  engage, the area advance and a phrase swap all act a lookahead early. `now`-based engage against
  horizon-based thaw was a hole nobody scheduled.
- **The tick captures `cfg` ONCE at the top; the orch advance swaps the play area mid-tick — so the
  tick must `return` after firing it**, or it re-generates the outgoing area with a stale cfg.
- **ENGINE time vs AUDIBLE time at an area boundary:** the advance fires ~0.6 s early and flips
  `_playIdx`/`_barGridAnchor` immediately. Readouts must use `_ambAudibleOrch` / `_ambAsAudibleArea`;
  the engine side follows `_playIdx`. Anything musical or displayed uses the AUDIBLE clock
  (`_shapeAudibleNow`), never `Tone.now()` (which is `currentTime + lookAhead`).
- **Arch-parity configs are ORDER-DEPENDENT — append new ones at the END**, and `--only=<id>` is
  unsound for a config with predecessors. A suspicious drift: stash the ENGINE and re-run; if it still
  drifts, the TEST moved.
- **Gate the COMBINATION, not just the new axis.** Grid × plays, grid × hangs, grid × rubato were each
  green on both axes while their interaction was broken.

### Bloom: emit, capture, freeze / Write

- **`window._ambEmitKey` is stamped by the CAPTURE-SINK TEE inside `playNote`**, not by emitters — a
  `playNote` stub that replaces the function must call `window._ambCaptureSink(...)` itself. Read the
  key AFTER calling through, never before, or every note is attributed to the previous one.
  The key is STICKY — null it before asserting on it.
- **Any new note-spawning path must (1) set `_ambEmitKey` around its `playNote` calls, (2) carry a
  marker param excluded from the capture (`_pecho`, `_hangGen`) so it is not BAKED into a Write
  freeze, and (3) be walked through every gate inside `playNote`** (playback gate, chord choke, stale
  `_ambEmitCutoff`) asking whether it should apply.
- **An UNKEYED core post kills the worklet, and a dead worklet is TOTAL SILENCE** — not NaN, it simply
  stops producing, and every core-rendered layer goes quiet for the session.
- **Every emitter must stamp `_ambKeyTime = at` per note** — `_ambVelJitter01` and the key/part/section
  resolvers read it, and both fail silently without it.
- **`_ambApplyAdsr` is the one params builder** all 13 emits go through (humanize, velVar, envelope,
  fine, portamento, voiceTrim). Reach for it before reimplementing any of them. It wants everything
  FLAT on `inst`; a shim must be cached per layer and non-enumerable.
- **A shim that omits a field the helper reads delivers HALF the feature, silently** — and a `try/catch`
  turns the scope slip that follows into "it just stopped working".
- **The freeze gate SHORT-CIRCUITS the emitter**, so a frozen layer ignores generative edits until the
  Write cycle rewrites, and any transport-wide flag (`windingDown`) must be honoured there too.
  `_ambReanchorLayer` + `_ambRewriteSoon` bring the rewrite forward; a drone re-strikes immediately.
- **A layer that loops NATIVELY must not run Write** (`_ambEuclidDeterministic` — despite its name,
  the general gate): the redundant capture/replay handoff drops or doubles the seam notes. Covers
  deterministic euclid, series arps, run/pedal, prog-driven drones, `followSalt` beds, improvise.
- **The replay owns the loop-boundary note** and needs a ~0.22 s grace; its per-(time,pitch) dedupe
  means a note `cancelBloomFutureVoices` retracts is NEVER re-issued — so cancelling and forgetting
  are two halves of one operation (prune `_emitRecent` from the cut).
- **Live edits while playing are a PAIR**: cancel the layer's future voices AND drop `_v2Phase` /
  re-anchor. Doing one is half the idiom, and the missing half is usually the audible one.
- **Sample/pad voices register as ACTIVE immediately even when scheduled ahead** — future-scheduled
  ones live in the active sets, so a cancel that only scans pending leaks them.
- **FX-spawned notes must not enter `E.cap`** or they bake into freezes and replay forever.
- **The rolling capture's retention IS the maximum loop length** — it follows the longest armed phrase
  (`_ambCapWant`), floor 33 s, ceiling 180 s. Six guards route through `_ambCapLimitSec`.
- **Anything that must survive a press cannot live in `E.seqState`** — `_ambResetClocks` empties it
  (with `clocks`/`iters`/`arpState`/`runPhase`) on EVERY play. Use a WeakMap keyed on the ENGINE;
  never a field on the layer (`persistWorkspace` serialises underscore fields — the `_soloLane` trap).
- **`_ambStopGenerator` must stop anything outside the graph** — the OS voice, kit samplers, the vinyl
  bed. A GENERATOR (as opposed to a processor) follows the transport, not just its own switch.
- **Chord choke** releases a note by the next chord boundary by default (`L.ring` opts out); it is
  skipped for material that plays ONE NOTE AT A TIME, judged from the NOTES on a written part
  (`_ambPartOneAtATime`) rather than from a pitch kind. The drawing runs notes through the choke
  itself so picture and ear agree.

### Bloom: the v2 layer model (`cfg.layers`, `js/bloops/18-layer-v2.js`)

Read `docs/bloom-layer-v2.md` before touching layers. A layer is an INSTRUMENT and a PART; a part is
LIVE (rules resolved at play time) or RECORDED (notes read back). `notesFor(L, ctx) → [{at,freq,durMs}]`
is the interface. v2 decides only "what notes, when" — everything downstream of `playNote` is v1's.

- **The file is TWO IIFEs sharing only `window._v2`.** A bare name from the wrong half throws straight
  into a surrounding `catch` and the feature measures as a silent no-op. This has bitten ~6 times
  (`formOf`, `layersOf`, `barSec`, `num`, `takeAsNotes`, `previewing`). Publish through `V2.` and check
  which half you are in before reaching for a helper.
- **Vocabulary (label-only; data keys unchanged):** a part is **GENERATED** or **WRITTEN**, and the
  take bar is the transition (`✎ Write it down` / `⚙ Generate instead`). Both make **STATIC CONTENT**;
  **LIVE** is a property of the SETTINGS (`liveness()`) — `part.vary`, Humanize, Vel var, a mask at a
  probability, and the harmony dice (salt, `prog.vary`, alternates) gated on the layer actually
  following. Measured: everything else named vary/var/scatter/chance seeds off a FIXED take and shapes
  the material once. `part.kind: 'live'|'recorded'` internally means "by rule" / "by hand".
- **✨ Auto is a SECOND By-rule door (2026-09-14, user: "the Generated menu feels totally overloaded,
  let's sidestep it for now"):** two presses, no knobs — ▦ Chords and ♪ Melody — applied to the part
  `partForOf(L)` names (the panel SAYS which; a stopped clock resolves to part 0).
  - **▦ Chords IS ⛰ Groundwork** (`makeGround`), not a new material: same state, same word, so it
    fills a cadence of any length for free and its knobs stay where they were. Adding a parallel `mat`
    would have been one state wearing two names.
  - **♪ Melody is a new material** (`mat: 'melody'`, `makeMelody`) — a walked single voice on a grid
    the bars divide. It is the SAME SHAPE as 🎲 Roll and differs only in that a Roll re-rolls, so
    **nothing in `rhythm`/`pitch` can tell them apart**: `shapeOf`'s phrase for it keys on the STAMP,
    and keying it on the shape renamed every Roll ever made (the gate caught it).
  - **A new `mat` must join every label map or it renders BLANK** — `MAT_LABEL`, `matProv`'s `M`,
    `genSync`'s `M`, `matSync`'s `SHAPES`, plus `matShapeOk`/`matRepair`. There is no chip for it in
    the Generated shapes row on purpose, and `genLit` already handled a material with no chip.
  - **The door never LIGHTS.** ⚙ Generated owns "what is this part"; two lit doors for one state is
    the mode-or-status rule broken. Inside the panel the pair does light — there it is unambiguous.
- **⛰ Groundwork is filed BY PART (2026-09-14):** `part.ground = {parts:{<pi>:GSET}, chords:{<absIdx>:GSET}}`,
  `GSET = {voices?, slip?, hold?, mel?}`, resolved NARROWEST FIRST — the change, its part, the layer —
  by `groundSetAt`. Absent = inherit at every rung. The old flat `per` map of per-change note counts IS
  a chord-scoped `voices` and is MIGRATED into `chords[i].voices` (idempotent, so no version gate)
  rather than kept as a third parallel map. Panel: one block per part, each with a GLOBAL row and its
  own changes — a flat strip of chord cells said nothing about where one part ended.
  - **The prune needs the ARRANGEMENT and cannot live in `normLayer`** (it is `(L, i)` — no cfg): a rung
    restating what it inherits is dropped, but which part a change belongs to is a fact about the
    progression. The first cut pruned against the LAYER's own number and threw away a change set to 3
    inside a part set to 1. `groundPrune(cfg, part)` runs from `normalizeAll`, over the bench, the ice
    AND every filed per-part record.
  - **A change can carry a LINE over the chord (`mel{on,rate,kind,oct,len,vel}`) — a SECOND emission
    pass, not a re-voicing.** The chord sustains; the line moves across the same span with its own
    rhythm and pitch rule. It reuses `pitchesAt` on a SHIM PART (the `partWithRules` idiom) so it
    resolves against the sounding chord, key, register and proximity like everything else and there is
    no second pitch engine to drift; `oct` is a REGISTER offset for the same reason, and `vel` rides
    the note (`playNote` already scales by it). `groundSpans` is the ONE walk of the changes and
    `groundOnsets` is built on it.
  - **A change's line button is THREE-STATE** (↳ follows · ♪ plays · — refuses), because absent and off
    are different answers — and the cycle runs the other way when the part already gives a line, so the
    first tap always changes what you hear.
  - **The chord NAME takes its own line in a cell.** Beside a 104px ± stepper and the line button it had
    nothing left and collapsed to ZERO WIDTH — the cell read as an unlabelled number. The rects could
    not see it (every cell measured a healthy 157px); a SCREENSHOT could.
- **`part.form`** is ⌗ Roll or ▦ Steps, ORTHOGONAL to written/generated; the two stores are parallel so
  switching destroys nothing. `notesFor` asks the FORM which branch emits, and the drawing must read
  the same source as the emitter or the picture and the ear disagree.
- **Per-part content:** `L.part` is always the record being EDITED, `L.partFor` names which arrangement
  part it is for, `L.parts` files the others, `L.partAll` is the iced Everywhere record. The EMITTER
  swaps in the sounding part's record by TIME (`partRecordAt` / `V2.recordAt`) — any surface meaning
  "the thing I am editing" must say so explicitly (`withEdit`), because a stopped clock resolves to
  part 0. A per-part record IS its part's length, reconciled on every normalize.
- **`cycleWindowAt`** answers "which window is one cycle at this moment" — the uniform lattice for an
  ordinary layer, the PART PASS for a per-part one. One definition, three consumers (tick, drawing,
  playhead); two walks of one grid is how they disagree. It carries `pi`, so nothing re-derives the
  part from a snapped `cs`.
- **Take pinning:** `part.take` pins the seed for the AUDITION and the PICTURE; playback plays that
  take too (per-cycle dice are `part.vary`). `part.takeb` pins per REGION, `part.ruleb` gives a region
  its own RULES — and a per-region RULE must be honoured by playback while a per-region TAKE is an
  audition pin. A **region** is a half-open range of 1/48-bar slots keyed `"a:b"`; a bare integer key
  is read as the bar it used to mean, so no migration was needed.
- **A note belongs to the region its ONSET is in, and a length is never clipped at a region edge** —
  owning by overlap destroys a pad ringing through.
- **Hand edits PIN (`n.hx`)**: under chordlock/diatonic the stored pitch is remapped, so the drag, the
  pencil, the note editor, the stepper and the hotkeys all pin and rebase to the DRAWN pitch. The
  editor shows the SOUNDING pitch; the gutter mark resolves from the DRAWN note, never from stored-midi
  arithmetic. Every door routes through ONE writer (`neApply` / `multiApply`), never a second copy.
- **The drawing's geometry is published, not re-derived** — `cv._barsGeo`, `_pitchGeo`, `_plotGeo`,
  `_chordGeo`, `_drawnPi`, `_cs`. A check that re-derives what the code publishes asserts nothing.
  A bar on screen is `PLOT / vbars`, not `PLOT / barsF`.
- **The pitch window is STICKY per layer and shifts rather than grows** while the material fits; it is
  frozen for a gesture. Growth-under-the-finger was retired: ONE geometry, always.
- **Transient view state is a Map/Set keyed by layer id** — `VIEWM` (mode), `VNAV`, `MSEL`, `VIZOFF`
  (the drawing's fold), `POPS`/`OVLS` (sheets), `BSEL`, `NE`, `NEENV`, `TAKE_PIN`, `EDIT_PIN`. Never a
  field on the layer.
- **`V2.render` is `_sig`-cached on `id:name:kind:on`** — a field outside that signature repaints
  nothing, so handlers do `h._sig = ''` first. It restores the body sheet and any section popover
  SEPARATELY, and reopening is what keeps a commit from slamming the sheet shut.
- **Layout:** the card body IS the drawing; six/eight sections open as popovers over it
  (`Make`/`Time`/`Bank` are the Content group seen three ways). `popOpen` MOVES rows (and lifts the
  drawing and the compose dock onto the body sheet); `popClose`/`secClose` move them back. A section
  popover is MODAL, so a door inside it that acts on the card must CLOSE it first.
- **v2 treatments are v1's FIELDS at the top level** (`level`, `revSend`, `space`, `cutoff`, `delay.*`,
  `spat.*`, `unitGate`, `chordMask`…), coerced by v1's own normalizers and resolved by
  `_ambLayerByKey('v2:<id>')` — which is why Ramps, the mixer, the scheduler and the FX chain all work
  with almost no v2 code.

### Bloom stores — what exists, and the one thing to know about each

All are ADDITIVE and ABSENT BY DEFAULT unless noted, which is what keeps golden/arch/harness green.

**Arrangement / harmony (`cfg.prog`, `cfg.sections`, `cfg.arch`)**

| store | what it is | the catch |
|---|---|---|
| `prog.chords[].bars` | **CADENCE** — per-chord length, fractional | a chord is not a bar; deleted when equal to `barsPerChord`. Everything sized from a uniform lattice had to learn this (bed strum/choke span, the onset walk, progress bars) |
| `prog.rubato{amount}`, `parts[i].rubato` | timing borrowed and paid back (schema v10) | split OUT of salt because it is a different AXIS; the cycle TOTAL is the invariant. Under a passes grid the edges need a second per-loop memo |
| `prog.salt{colors,scatter}`, `parts[i].salt`, `parts[i].passSalt` | per-instance recolouring, pass → part → area | an explicit all-zero object means "no salt here" and must NOT be pruned. Colours are key-filtered in WRITTEN space. Segment fractions snap to a 1/8-bar grid graded by the span they are applied to |
| `chord.alts` + `altMode` | per-slot alternates | resolved at READ time from (idx, cycle, seed) by a DEDICATED rng, never the shared stream — the >1 resolver calls per onset must agree |
| `prog.reroll` | function-preserving substitutions from the take seed | read-time, never written back; in-key filtered against the progression's own pitch pool |
| `prog.chain` | ORDER OF PLAY — a part can be revisited | repetition is written out, so `plays` is ignored while chained. Normalize DELETES it when `arrGrid` exists |
| `prog.arrGrid`, `parts[i].grid` | the passes grid: storage IS the sequence | `_AMB_GRID_COLS` is a CREATION width, not a default — one pass is the neutral count. A width-only grid still engages the clock. Holds must be re-inserted (`_ambGridWithHolds`) or a grid silently deletes every hold block |
| `parts[i].plays` | visits per iteration | COMPOSES with a grid: the grid says what each visit plays, `plays` says how many visits |
| `parts[i].key`, `sections[i].key` | real modulation | the part's chords are STORED transposed; `_ambProgKeyOffset` must take the AREA key or the modulation applies twice |
| `parts[i].head` / `.tail` (hangs) | extra time on a part PLAY, harmony HOLDS | one insertion point (`_ambChainWithHangs`); a hang SHARES its neighbour's instance ordinal (or the choke cuts it); hang time does NOT count for the layers, so the bar grid shifts and everyone re-enters on the downbeat. `window.bloomHangs()` is the kill switch |
| `{transition:true, bars}` slot | a WALK between two chords | has NO root — four places assumed every slot has one |
| `prog.versions[]` | whole-progression snapshots incl. salt | ❄ Capture Pass resolves a salted cycle into literal chords |
| `sections[i].unit{num,den,ref}` | section length as a RATIO (`area`/`bar`/`changes`) | `bars` survives as the resolved mirror, rewritten every normalize, so ~10 readers never changed |
| `sections[i].part` | binds a section to one set of changes | an early return at the TOP of `_ambProgStepAt`, before everything else |

**Per-layer gates — "does this layer play here"** (see `docs/bloom-gate-ladder.md`; nine stores)

| store | scope | applied |
|---|---|---|
| `when` | which cycles | PRE-EMIT (`_ambCondFires`) — never captured |
| `chordMask.steps` / `.passes` / `.part` | per change · per (pass,chord) · a sub-chord WINDOW | pre-emit; a cell is a free 0-100 PROBABILITY drawn once per instance. `passes` is keyed on the ABSOLUTE chord index |
| `sectionMask.steps` | per section/block | pre-emit; indexes only OPEN parts |
| `partSeqs` | slot → banked phrase (or a SLICE `{n,s,l,f}`, or a `\0gen` sentinel) | runtime install; resolves narrowest-first and must say WHICH level answered |
| `unitGate{div,period,slots}` | slices of each unit | PLAYBACK filter inside `playNote` — live-editable on a frozen loop. `div` clamps to ≥2 and a slot value is a MASK ARRAY; use `_ambUnitGateSet` |
| `iterGate{len,steps,ref}` | whole-arrangement iterations | playback filter; `'plot'` cannot advance below 2 areas, `'round'` can |
| `cycleGate` | iterations of the layer's own pattern | FOLDED into `when` at normalize and deleted — an editing VIEW, not a runtime gate |
| `lenSync{part,passes}` | loop length bound to N passes of a part | a RECONCILER on every normalize (never a new clock); writes `write.bars` AND, for phrase-driven types, the phrase `bars` + `unit`. Exact under a fractional cadence; the bound stepper is replaced by a badge |

**Per-layer content & sound**

`part.ground{parts,chords}` (Groundwork's two-rung overlay + the melody line — see the v2 section) ·
`euclidPattern` / `euclidPages` / `euclidKit` (drum lanes) · `stepFx` (per-step note/tone/vel/len/ratchet/prob/pan; the drum grid keeps its own in `pg.fx`) · `laneRamps` (deterministic per-lane pan/pitch LFO) · `euclidDrums` / `euclidSamples` (a lane can name another kit zone or any library sample) · `soloLane` (PERSISTED and loudly marked — two "clever" transient designs failed) · `improv` (alternates written and improvised iterations; forces Write off) · `chordPick` (per-chord note choice; replaced an editor that wrote the AREA's harmony) · `keyOv` (per-layer key/chords/yoke) · `spat` (per-note placement, applied in the capture-sink tee) · `tg` (trance gate — a bar-synced pattern on `e.tgGate` driven by a disposable `Tone.Signal`) · `glitch` (core-only, four read strategies; every head-jumping mode needs an edge fade) · `barsMode` (`stretch`/`fill`/`preserve` when a part's length changes) · `voiceFrom` / `chunkBy` / `lineFx` / `speak` / `snapBars` / `word` / `speech` (spoken layers).

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

### Spoken layers (Learn, Sir Eel) & the voice server

- **One engine, different text sources** — adding another source is a branch, not a layer. Three things
  must stay in step: `_ambSpokenType`/`Key`/`Prefix` (keys are `<type>:<id>`), `_ambSpokenSrcKey` (what
  invalidates a queued reading), and the tick's type dispatch.
- **A spoken line is a WRITTEN TAKE**: rendered once, then played strictly in order. Nothing loads
  during playback; the render-ahead cap applies only WHILE PLAYING. Un-rendered lines play as NOTES so
  a layer always makes sound; `Words as` is absolute and never silently degrades to a worse voice.
- **The voice comes from the SERVER by default** (`layer.voiceFrom`: auto|device|server) — the server
  repo is `github.com/mikebluz/bloops-tts-server` (private), deployed on GoDaddy Node hosting, NOT via
  `deploy.sh`. Verify a server deploy with two curls; no phone in the loop.
- **GoDaddy's front proxy strips `access-control-allow-origin` from every response**, so the voice
  rides a JSONP transport when fetch fails. A failed probe must COOL DOWN, and an async capability that
  arrives after a failure must UNDO that failure's state.
- **iOS does not attempt in-tab inference at all** — the model runs in an empty tab but not inside this
  app's memory budget (PROBE CONTEXT ≠ APP CONTEXT). WebKit (`_AMB_WK`) synthesises in ≤3-word chunks,
  caps render-ahead, and the crash latch is STRIKE-based and always recoverable (`bloopsVoiceRetry`).
- **Every await on the worker and every fetch needs a DEADLINE** — `postMessage` has no timeout, and a
  bare `await fetch()` is how the layer hung on mobile. A silent wait is indistinguishable from a hang:
  report download %, count the seconds, and name the failure (`NotAllowedError`/`NotFound`/`NotReadable`
  are three different problems).
- **Synthesis yields to audio** — the pump paces between lines while the transport runs and backs off
  hard when the audio clock is behind.

### Native shell, iOS, Electron

- **The Capacitor shell reroutes ALL audio through a MediaStream** (`00-native-audio.js`, inert on the
  web). Nothing may connect to `rawContext.destination` — use `window._bloopsSpeakerSink(ctx)`, which
  returns the stream node for the LIVE context and `ctx.destination` for an offline one. A direct
  connect re-classifies the context and it gets `interrupted` at every screen lock.
- **`pagehide` tears the media pipeline down** (mute → pause → strip src → `load()`), because a
  navigated-away page's renderer keeps draining a dead feed. It never fires on a plain background —
  that IS the keep-alive design.
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

### Deploy & tooling

- **A new top-level page must be added to `deploy.sh`'s staging `cp` list** or it deploys as a 404
  forever (bitten twice). Verify against **https://mercywizard.com** — the bare FTP IP serves a GoDaddy
  placeholder and 404s live files.
- **Keep the `?v=DEPLOYVER` stamped-file list SMALL** — every stamped file is rewritten and force-put on
  EVERY deploy. JS that needs a cache-busted URL reads `window.__BLOOPS_ASSET_V` instead. A `new Worker(url)`
  is a cached asset and needs the stamp (and its file in the list) or phones keep the old worker.
- **App JS needs a `?v=` bump to reach phones**, and the mirror compares by SIZE — a stamp-only change
  is the same byte length, hence the explicit force-put block.
- **`max-retries exceeded` from every lftp command with the port test passing is an IP BLOCK.** Read the
  FTP BANNER (`printf 'QUIT\r\n' | nc -w 8 HOST 21 | wc -c` → 0 bytes = reset) and curl http:// to prove
  the host is fine. It is IP-level; tether to another network or wait.
- **Never put a backtick or `$( )` inside `deploy.sh`'s lftp heredoc — not even in a comment.** It is
  unquoted by necessity, so the shell runs command substitution over the whole body. `bash -n` does not
  catch it; render through a fake `lftp() { cat; }` and check stderr is empty.
- **`npm run samples`** imports a folder into the shipped library; ids derive from the source-relative
  path and must stay STABLE (a project stores `sample:<id>`). Re-runs diff by size AND mtime+bytes — a
  file edited in place keeps its byte count. In-place mode (a folder already inside `samples/`) copies
  nothing. `kind` is `tuned` / `loop` / `kit`: the axis is "does it carry its own tempo", so a LOOP is
  rate-matched to the project and never transposed by the note.
- **`UI_WAIT_SCALE=0.6 npm run test:ui`** runs the UI gate in ~2:20 by scaling settle waits ≤350 ms
  (longer waits are AUDIO-clock settles and never scale). Dev at 0.6; FINAL verification at 1.
- **`bloopsCoreStrips` / `bloopsCore` READ when called with no argument** — they used to be pure setters,
  and a "is the core on?" check silently disabled strips for the whole session.

---

## Layer-schema evolution rules (Bloom)

Bloom is moving toward a **composable-layers** model (a layer = Voice × Note-source × Generator × Timing × Variation × Mix/FX; today's ~11 types become presets). **`docs/bloom-layer-model.md` is the AUTHORITATIVE spec** (6-axis spine: INSTRUMENT · KEY · SEED · TIMING · VARIANCE · FX/MIX) and its **§11 is the BACKLOG** — open items with their analysis, what was ruled out and how, so they can be picked up without re-deriving. `docs/bloom-composable-layers.md` is the older design + phased refactor plan; the two overlap and the layer-model doc wins on conflicts. Until those phases land, the invariants below govern any change to a Bloom layer's saved shape:

1. **`_normalizeAmbientCfg` is the ONE migration chokepoint.** Every load path (Drive, localStorage, `_cloneLane`, undo snapshots, Send-to-Bloom, Shape-It, area switch, play) funnels through it. Put migrations there, nowhere else.
2. **Each area cfg carries `schemaVersion`** (`_AMB_SCHEMA_VERSION` in `17-ambient.js`; legacy/pre-versioned = 0). A migration reads `_fromVer` at the top of normalize and gates on `_fromVer < N`; the stamp before `return cfg` records the current version so the migration runs **once** and re-normalizing is a no-op. Bump the constant + add a `//   vN — …` comment line ONLY when a layer's meaning/shape changes and needs a one-time migration.
3. **Additive-only; never repurpose a field.** Add new fields with defaults; don't change what an existing field means. An old build reading a new project must degrade safely (unknown fields normalized away).
4. **Backwards compatibility is an invariant, not a migration project.** A legacy layer with only `type` must keep producing byte-identical output. When Phase 2 adds `generator`/`voice`, they are *derived* from `type` on load and dispatch falls back to `type` — same core, same params.
5. **The invariant harness (`23-bloom-harness.js`) is the gate.** It hashes `[at,freq,durMs,voice,pan,level]` per note over seeded RNG/fixed ticks. Any schema change must keep it green; an intentional output change is a deliberate, reviewed baseline bump — never silent drift. Adding/removing an `_ambRand()` call on a covered path shifts every downstream draw, so keep RNG draws identical on default paths.

## Deployment policy

**NEVER run `./deploy.sh` unless the user explicitly asks for it in that message** (e.g. "deploy", "push it live", "ship it"). Committing and pushing to git is fine when the user asks; deploying to the live GoDaddy site is a separate, explicit step. Do not deploy as an automatic follow-up to a code change, a commit, or a push. When work is ready, say so and let the user request the deploy.

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

## Commands

```bash
npm start        # Start Express server at http://localhost:3001
npm run samples  # Import a folder of audio into the shipped sample library (tools/import-samples.mjs)
./deploy.sh      # Deploy to GoDaddy cPanel via plain FTP via `lftp` (port 21, `set ftp:ssl-allow no` — NOT SFTP, despite deploy.sh's own comment saying so) — ONLY on explicit user request (see Deployment policy)
node test/bloom-mod-parity.js   # B2 mod-source parity gate (needs npm start running; --update re-baselines deliberately)
node test/arch-parity.js        # arrangement-clock gate: sections/parts/repeats/keys/salt (needs npm start; --update re-baselines)
npm run test:partseq            # per-iteration layer sequences (L.partSeqs): migration, pass indexing, the four cascade rules, own-phrase restore (needs npm start)
npm run test:ui                 # UI LIFECYCLE gate — drives every control on the v2 layer card under TOUCH, in the app's real order (init → card → panel rebuild → interact). Poison-verified: removing the v2 skip from the panel's wiring sweeps fails 4 named checks.
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
