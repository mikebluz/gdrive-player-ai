# Bloom traps — config & normalize, the arrangement clock, emit/capture/Write, the v2 layer model, stores, schema evolution

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before touching `17-ambient.js`, `18-layer-v2.js`, a layer store, or anything a project saves.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

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
- **RETIRING A CONTROL THAT MADE SOUND: delete the STORED field in normalize, in the same change.**
  Removing only the UI leaves a project that had the field set still behaving that way with nothing
  on the card able to switch it off — unrecoverable. `Max events` went this way (2026-09-18):
  `if ('maxEvents' in s) delete s.maxEvents;` plus the engine ignoring it, both halves. It IS audible
  for affected projects, and that is the honest outcome — there is no silent way to retire a feature
  that made sound. Restate every gate check that DROVE the field onto a surviving one rather than
  deleting it (the check was pinning the fold/gate, not the field).
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

- **A CONTROL THAT INDEXES THE SOURCE SET MUST BE CAPPED TO IT.** Every branch reading
  `part.pitch.degree` does `clamp(degree - 1, 0, N - 1)`, so a 1-12 stepper over a triad had three
  live values and nine that silently repeated the third. The ceiling is `V2.toneCount` (published from
  `toneSetAt`, never re-derived — that resolver applies the area progression lock, the per-layer key
  override and the part/section key offsets). It is a UI cap only: `max(count, stored)`, because the
  set can be a triad now and a 7th two bars later and a stored 4 must survive. Repainted from
  `applyGateCard` — the count moves with the CHORDS and nothing rebuilds the row when they change.
- **A CONTROL BELONGS WHERE ITS QUESTION LIVES; every other surface STATES THE CONSEQUENCE.**
  Time asks "how long is a cycle" — `cycModeOf` is its ladder: ▭ Everywhere (own bar count) ·
  ⟲ Locked (N passes of a part, `lenSync`) · Free (own ms clock). Generate asks "what content does
  this layer have" — ▭ Everywhere vs ◫ Per part (`partSelect`). Per part LOOKS like a cycle setting
  because it fixes the length, but it forks the CONTENT and only has a length consequence, so Time
  shows a badge pointing at Generate rather than owning it. Putting it on the cycle ladder first
  (2026-09-18) made a content fork look like a length pick.
  PER PART OUTRANKS THE CLOCK in `cycModeOf`, because the engine does: `cycleWindowAt` takes the pass
  span whatever `part.clock` says. `partSelect` ices the Everywhere record into `partAll` and fits a
  copy to each part; LEAVING DISCARDS those copies — the one destructive branch on this card, so it
  confirms, and a refusal must leave the control exactly where it was.
  The sheet head's ▭/◫ pill is a SECOND door on the same handler (`.v2-pop-pp, .v2-ppmode`) — kept
  because it is the only surface naming which part's copy you are editing, and it shows on every
  group. A second element answering `.v2-pop-pp` would have made every existing `querySelector` for
  it ambiguous, hence the separate class with one shared handler. Both force a full re-render, so
  they cannot drift; a probe check pins it.
- **A PER-PART RECORD'S CYCLE *IS* THE PASS SPAN** (`cycleWindowAt`: `partFor` finite + `parts`/`partAll`
  + `prog.on`). It takes the part's span from `_ambPassSpanAt`, snapped to the 1/48-bar grid, and the
  cycle index becomes the PASS number. So NEITHER `part.bars` NOR `speed` reaches it — the rate-scaled
  length is computed and then not used. Both rows state the binding with an `.ambient-loop-badge`
  instead of offering a control that does nothing (Speed's was added 2026-09-18 after measuring 16
  onsets at both 1× and 2× over a 16 s horizon, against 16 → 32 for an ordinary layer). An ORDINARY
  layer ignores part boundaries entirely: a uniform lattice off the shared anchor, with chords
  changing underneath it per NOTE (`_ambChordGateOK`) — a 3-bar layer over a 4-bar part drifts, by design.

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

- **▦ Schedule (`18-schedule.js`) is a VIEW over existing stores** — it replaced ▦ Passes, Coarse, v1 When and
  v2 Plays; it owns no data. `_ambPartSeqCellGet` answers the phrase NAME only — compare slices with
  `_ambPartSeqCellSpec` + `_ambPsqStore`, or "tap again to clear" never matches a sliced cell. An edit to one
  round must widen `prog.arrGrid` to the rounds on screen first (`editRound`), or every round shares column 0.

- **⚙ Deep ▸ Fine-tune is four TABS of flat rows** (`ftrows(tab, …)` → `v2-ft v2-ft-<tab>`; the card holds
  `v2-ftt-<tab>`, kept across rebuilds with the `v2-so-*` folds). Off-tab rows hide by CSS `!important`;
  inline display stays `gateRow`'s. Tab counts, the "don't apply" list, Tuned chips and the recipe warning
  are all filled in `genSync` AFTER gating — a new Deep row needs only `ftrows` + a `data-v2when`.
- **Deep or ✺ Live: trace the seed, not the label.** Anything drawn from `seedBase` is per TAKE (Deep)
  unless `part.vary` is on; per-pass means seeded on play time, chord occurrence, or the shared stream.

- **STOCHASTIC PLACEMENT NEEDS MUSICAL FLOORS, not millisecond constants.** Twist packed a fixed 120 ms
  burst at any tempo and Phrasing scaled its cells off the AVERAGE span: measured 20 pulses → 67 notes
  with 20–80 ms notes 52 ms apart. Both now subdivide the onset's OWN slot, floored at a 16th triplet of
  the bar (`MIN_GAP`/`MIN_MS`, ≥60 ms); a ghost's floor is a 32nd because it is a grace note. A burst
  under ⚇ Mix also forces single notes — chord picks inside it multiplied the note count.
- **A SHIM THAT SKIPS A BRANCH SKIPS ITS RULES.** Twist's burst and Phrasing's cell shim straight to
  `walk`, so they bypassed the `mixed` branch: they kept the coin flip (11 chords where the structure
  wanted 4), scattered the chord pool, and sat an OCTAVE below the line (19-semitone "leaps"). Every such
  shim must carry `_mixLine` AND be called with the line's register (`lineReg`).
- **THE DICE GET A PER-BAR BUDGET.** Added notes are marked `xtra` (burst q>0, cell q>0, ghosts) and kept
  in time order up to a third of the bar's own onsets, then dropped — so Twist/Phrasing/Ghosts colour a
  bar and can never redraw it. ⚙ Deep's 🎲 Take shows three macros (`DICE`, `L.dice`) that WRITE those
  fields; the nine dice are the same data behind ▸ Advanced, and a hand-edited die makes its macro read
  "custom".
- **⚇ Mix: structure picks WHERE a chord may land, `pitch.mix` picks HOW MANY.** Forcing every structural
  position ignored the slider (10 onsets → 8 chords). The slider's ends stay absolute (0 = no chords,
  100 = all). A stepping line (`pitch.walkMode: 'step'`) must walk the KEY SCALE, not the layer's tone
  set: under a progression that set is a chord POOL, so one "step" is a 3rd — measured 8-semitone mean
  leaps, 1.4 after. `lineUp` puts it an octave above the chords; `_mixArriveAt` makes the note before a
  change take the nearest incoming chord tone. ABSENT MEANS ALL THREE (2026-09-17): shipping them
  opt-in meant the part the user was listening to kept the coin flip, and the fix read as no fix at all.
  The old behaviour is the named choice `mixAt:'any'` / `walkMode:'scatter'` / `lineUp:0`.

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
  itself so picture and ear agree. **An anticipated chord (v2 Groundwork `rhythm.antic`) starts inside
  the OLD change** — it carries `params._chokeLead` so the boundary is measured from the change it
  belongs to; set it AFTER `_ambApplyAdsr` (which can hand back a new params object), and pass it to the
  drawing's choke call too. **Compare change edges only after snapping to the 1/48-bar grid** — a strike
  mark on the bar line and a bisected boundary 1e-5 past it were both kept, doubling the chord.

### Bloom: the v2 layer model (`cfg.layers`, `js/bloops/18-layer-v2.js`)

- **`vary` IS EVOLVE AT `ev` 1, `am` 100 — one axis wearing two controls.** The emitter says so (it
  lets `vary` outrank `chg` for exactly this reason), and every consequence of the split has now been
  a bug: the Evolve rows vanished on a frozen part (`vary` computed two ways), the outline preview
  only knew `vary`'s clock, and `liveness` counted only `vary` so an EVOLVING layer's badge read
  FIXED while 24 outlines sat behind it. **Before adding a fourth surface to this axis, collapse it:**
  one control — never / every N passes / every cycle — with `part.vary` kept as a stored key for
  save-compat. `part.kind` (live vs frozen) is a genuinely different axis and stays.
  **COLLAPSED 2026-09-19 ("Evolve feels buried in the Deep menu" → "can't they just one button
  then"):** `.v2-evotog` on the take bar — ONE toggle, `⟳ Evolve: off — this take repeats` /
  `⟳ Evolve: every N passes` (fill AND tail carry the state; a one-word face reads as the current
  state) — with an `Every N` stepper (`st`, card id, `chg.ev`) beneath it while on. Repeat is OFF and
  Re-roll is EVERY 1: `liveness()` folds `vary` in as `evolve.ev` 1, so the badge, the summary and the
  button all say EVOLVES for it and VARIES is left to the per-pass dice. `setClock(L, n)` is the one
  writer (clears `part.vary`; editing Every on the face clears it too, since `vary` would outrank the
  number) and `clockSwSync` (from `vizChrome`) the second writer. ⚙ Deep ▸ 🎲 Take keeps Each cycle /
  Evolve / How much / Against as the FINE view — the handler mirrors into them and into the staged
  copy. On a FROZEN take the button is dimmed (`.v2-clockfrozen`), never `disabled` — the press
  releases (`V2.release`, silent, keeps the notes) and turns Evolve on. A new surface on this axis
  goes on this button, not beside it.
  **A SECTION CHIP IS ONE GROUP UNLESS IT SPANS (2026-09-19).** `SECS` is six now \u2014 Instrument \u00b7
  Generate \u00b7 \u266f Tweaks, then Mix \u00b7 FX \u00b7 Bank \u2014 and Tweaks is the first section to span TWO group
  bodies (`SEC_SPAN = { Tweaks: { Shape: '*', Content: ['Cycle','Bars','Every','Speed'] } }`). The pane
  takes each body in turn, each STAMPED with its group (`dataset.v2gbody`) so `secClose` puts it back
  without a lookup, `popTabbables` walks them all, and `syncSheet` filters rows by their `data-v2g`
  stamp \u2014 so a new Shape tab appears in Tweaks automatically while a new Content tab cannot leak in.
  \u273a Playing was a section over the SHAPE group carved out by one tab (`SEC_EXCL`, now empty), so
  merging Shape re-absorbed it. `secForTab` asks the spans FIRST: neither Shape nor Time is a section.
  **FILTERING A ROW OUT OF A SHEET IS TWO THINGS:** dropping it from the tab grouping AND hiding it.
  `syncSheet`'s visibility pass walks `tabs`, so a row filtered out before the grouping is in no tab,
  never gets `v2-rowoff`, and stays on screen \u2014 \u2699 Deep's Method and the Bank showed under Tweaks'
  Cycle tab within the hour. The span filter adds the class as it drops a row; the section that owns
  the row toggles it off when the row lands in its own active tab.
  **\u266b ConFUGUED IS A PITCH KIND, NOT A ONE-OFF (2026-09-19, built to order).** `pitch.kind:
  'confug'` \u2014 N notes (2\u20135) at every onset, stacked by N\u22121 STATED semitone intervals (1\u201324), the
  order permuted per onset (up \u00b7 down \u00b7 alternate \u00b7 rotate \u00b7 random, seeded), each note bent toward the
  sounding chord by `cstrict` under one of three `cmode` ladders (ladder: ignore \u2192 root follows \u2192 nearest
  KEY tone \u2192 nearest CHORD tone; chord: root + a share bent, key never asked; prob: root always follows,
  a share bent). The interval list is sized to `voices`\u22121 in the NORMALIZER \u2014 one place \u2014 and the rows
  address it by position, so a Notes-at-once change must re-render the panel. The material (`MAT_SIMPLE.confug`)
  is a PULSE rhythm, so "how many onsets" is `rhythm.n`.
  **HARMONY VOICES HAVE MEMORY (2026-09-19).** `applyHarm(part, E, cfg, at, reg, out, L, mem, idx)`
  keeps each voice's last pitch and the line's onset history on the cycle's generation memory
  (`mem.harmV`, `mem.harmHist`, `mem.harmLead`), so `motion` (contrary · oblique · free) and `lag` (a
  canon: the line's pitch `lag` onsets later) are deterministic per take and the audio, the picture and
  the outlines agree. Absent motion/lag = the old parallel voicing, byte-identical. A caller that passes
  no `mem` gets parallel only (no memory, no canon) — pass it. The per-voice rows address their entry
  BY POSITION (`part.pitch.harm.<j>.motion`) — the list is stored in draw order, so keep it so.
  `series` is a NAMED pattern (`HARM_SERIES`: wave · rise · fall · alt · wide — degree offsets around
  the chosen interval, one per onset) rather than a typed list, so a project cannot store a sequence
  the engine does not know; `every` (2–4) makes the voice sound on every k-th onset only.
  **SALT STAYS ON THE CHANGES; A LAYER DECIDES HOW IT FOLLOWS (2026-09-19).** Per-layer *salting* was
  asked for and refused: the colouring is central (`_ambProgSoundAt`, seeded from the project) so every
  following layer hears ONE coloured chord — per-layer seeds would cost that harmony, the chord band's
  honesty and the arch-parity contract. The follow side is per layer: `followSalt` (on/off), `saltUpTo`
  (`sevenths` · `ninths` · absent = everything — a colour beyond it HOLDS the written chord for that
  segment, judged by what the colour ADDS; sus/open-fifth replace a tone and count as everything) and
  `saltShare`, the face of the existing `saltMask` (one value for every chord). The harmony learns WHICH
  layer is asking through `_ambSaltLayerNow()`: v1's `_ambEmitLayerKey`, or the v2 layer's own pin on
  `window._ambSaltLayer` set for the length of its `notesFor` — before that a v2 layer had no name there
  and its mask was inert. Any new per-layer harmony rule resolves the layer THROUGH that helper.
  **TRANSFORMS ARE A STAGE OVER THE RULES' OUTPUT (2026-09-19).** On a GENERATED part ✨ Transform
  appends to `part.xf` (additive, absent = none, validated in the normalizer beside `part.tf`), and
  `notesFor` = `tightClip(xfStage(notesForRaw))` — ONE seam every caller passes through (emitter,
  drawing, outlines, ⚙ Deep, capture), so none can disagree. The ops are the same `TRANSFORMS`
  table the one-shot list edit uses, over the stored shape (t · dur · midi), so the emitter's
  {at, freq, durMs} are folded in and back out around them with the original note kept.
  `shuffle` takes an `rnd`: seeded from the TAKE's own seed (`ctx._seedBase`, stashed by
  notesForRaw — never a second computation), so a take shuffles the same way every pass. A RECORDED
  part skips the stage (its list was edited in place; a capture already carries the result). A new
  op goes in `TRANSFORMS` with a 4th `rnd` argument if it draws — never `Math.random` in a stage.
  **THE OUTLINES ARE NAMED WHERE EVOLVE IS SET (2026-09-19).** Seven coloured sets of hollow notes
  appeared the moment Evolve came on, and the only line saying what they were sat at the tail of the
  drawing's readout — "totally opaque to the user why there are 7 unshaded sets of notes". The face
  carries `⟳ Show ahead` (`L.ahead`, additive, absent = 7; ONE reader, `aheadOf`), the sampler takes
  `1 + ahead` passes and carries `ahead` in its cache signature, and the legend names the control. A
  mark on the picture that no control near its cause explains is the drum-solo rule again.
  **A "PASS" IS THE ARRANGEMENT PART'S, NOT THE LAYER'S CYCLE (2026-09-19).** `chgAt` ticks on
  `_ambPartPassAt(...).pass` — passes of the part sounding at that moment (chord-rounds of "the
  changes" when there are no parts), rounds under Against = round — and only falls back to the
  layer's own cycle with no progression. A 4-bar content in an 8-bar part evolves every `ev` PART
  passes = 2·ev cycles. The Every row's hint (`evoUnitTxt`, repainted from `clockSwSync`) states
  the unit and the ratio the same way the drawing's "repeats N×" readout does; never write "1 =
  every cycle" unqualified.
  **▶ PREVIEW HAS ITS OWN SWEEP LOOP (2026-09-19).** `vizFrame` rides the transport's rAF and Preview
  runs with the transport stopped, so `previewSweep` (started by the Preview handler, alive only while
  `previewing(L)`) paints `paintSweep` — the ONE painter, extracted from `vizFrame` — on the card's
  `.v2-vizph` and ⚙ Deep's `.v2-stageph`, from `PV_VIZ.at`. A canvas gets the sweep by PUBLISHING
  `_plotGeo` / `_barsGeo` / `_hits` / `_pitchGeo` / `_chordGeo`; `stageVizDraw` does, and draws the
  preview's cycle (`cs0 = PV_VIZ.at`) so the notes are the ones sounding. A previewed cycle is solid
  (`fromPv` skips the stability fade) for the same reason a playing one is.
  **THE FRAME IS 16 ms AHEAD OF THE DRAWING (2026-09-19).** `vizFrame` runs on `audibleNow() + 0.016`
  and `drawPartViz` decides "playing" on bare `audibleNow()`, so the frame's first redraw at play
  paints the STOPPED picture (pinned take, faded); a stopped drawing's `cs` is the chord anchor —
  the time playback started from — so `cv._cs` then equals the live `cs` and the per-cycle trigger
  stays quiet for a whole pass ("not solid until the second pass"). The frame now also redraws while
  `!cv._plotGeo.playing && audibleNow() >= startAt`. A redraw trigger keyed on `cs` alone cannot see
  a redraw that got the STATE wrong; key it on the drawing's own claim too.
  **WHILE PLAYING, THE DRAWN TAKE IS SOLID (2026-09-19).** The stability fade (note alpha = share of
  the next 8 passes it survives) is a reading of the FUTURE; applied while playing it painted notes
  of the take sounding NOW at 0.28 — an outline's weight — and was reported as "the current take is
  not solid". Measured first (throwaway script hooking `playNote` against `cv._hits`, per cycle):
  audio and drawing agreed on every note of every cycle, in ✎ Edit and 👁 View, with Evolve every 1
  and every 4, How much 100 and 60 — the fade was the whole difference. Before touching the take
  clock for a "the picture is wrong" report, measure the picture against the audio, not against the
  drawing's own clock. Note also `cv._hidden`: a note outside the HELD pitch window is not drawn at
  all, and a new take can land outside the window the pinned take set.
  **THE READOUT NAMES THE TAKE THAT IS DRAWN, NOT THE PIN (2026-09-19).** While playing, the
  drawing follows the clock's take (`base` = pin + Evolve epoch, or the cycle count under Re-roll —
  measured: the solid notes changed every epoch in BOTH ✎ Edit and 👁 View), but the readout printed
  `takeOf(L)`, which never moves — so "take 2" sat beside a picture that changed every cycle and the
  sounding takes were taken for the outlines. `drawnTake` is set from the sampler's own `base`; a
  number beside a moving picture must be the moving one.
  **THE SWEEP NAMES WHAT IT PASSES (2026-09-19):** the playhead overlay (`vizFrame`) stacks the
  sounding pitches' names high → low beside the sweep, the chord under it on top (from
  `cv._chordGeo.marks`, the band's own claim — never a second walk of the chord clock), and lights
  their keys in the gutter; published as `ph._readout`. It reads `cv._hits[].midi`, so a hit box
  without a pitch is a note the readout cannot name — keep `midi` on every hit.
  **EVOLVES IS ITS OWN STATE WORD (2026-09-19):** `liveness().state` is `fixed · varies · evolves`
  and `stateWord()` (UI half) is the ONLY map from it to a word — never derive the word from `.live`
  or `.tags`; three surfaces did, which is how a third state reaches some and not others. Its hue is
  `--evo` (lime, beside the take palette in bloops.css — violet was too close to the app's purple
  accent) on the badge, the summary chip and the three `.v2-evorow` knobs. The cadence ("every 4
  passes") rides the summary's state word (`lvWord = stateWord + evoCadence`, chip class by the
  FIRST word) — a chip painted on the canvas said it and was removed the same day ("this readout is
  obscuring the visualizer"): nothing is painted over the notes that is not a note. A new Evolve
  surface wears that class/var, never a restated colour.

- **`liveness` HAS NO CLOCK, so it cannot resolve `chg.parts`.** Resolving which part is sounding is
  `chgAt`'s job and needs a ctx. The badge therefore answers "does this EVER decide again", taking
  the largest `ev` any part override offers — deliberately, and noted here so it is not later
  "fixed" into a per-part answer this function cannot compute.
- **"PREVIEW IS EDITING MY NOTES" IS `PV_VIZ` NEVER BEING CLEARED (2026-09-20).** Reported as
  "some notes in the visualizer shorten … an extra chord just shows up and sticks around". The
  STORE IS INNOCENT and that is worth knowing first: `L.part.notes` is byte-identical across
  Preview, Play and Stop in every configuration — Everywhere, per-part, `barsMode:'fill'`, a free
  clock, a `lenSync` binding — and 30 × `getCfg` moves nothing (`test/probe-content-state.js`).
  **`PV_VIZ` is the drawing's memory of the cycle a preview played, and it is a WALL CLOCK**
  (`Tone.now() + 0.12`). `previewKill` clears `PV` — the AUDIO tracker — and left `PV_VIZ` standing,
  so `drawPartViz` anchored EVERY later repaint of that layer to a finished preview: through a full
  panel rebuild, for the rest of the session, moving again on every press (measured: `cs` 0 → 9.38 →
  16.19 → 24.96; pitches 57·69·68·69 → 60·64·64·72, never coming back). **Two clocks, two clears** —
  `PV` is what SOUNDS, `PV_VIZ` is what was DRAWN, and the drawing now honours it only while
  `V2.previewing(L)` says there is still sound. `stageVizDraw` had always asked that; the card's
  drawing was the half that did not, and that asymmetry IS the bug — grep both when either changes.
- **THE CHOKE MUST BE ASKED IN THE CLOCK THE NOTES WERE MADE IN.** `drawPartViz` resolved
  `_ambNoteChoke` OUTSIDE `withPvClocks`, so a preview-time onset (`cs + n.at`) was compared against
  the RESTORED global anchors — the drawn length then tracked the wall clock, not the music.
  Measured on a held chord: 124px stopped, 71px the instant Preview was pressed, 27px on another
  press, same note. The comment above that branch licenses it with "`cs` is a resolved CHORD ANCHOR,
  not a wall clock", which is exactly what it is NOT during a preview — **a precondition stated in a
  comment is not a precondition enforced**. The notes and the chord band were already wrapped; the
  choke is a third reader of the same clock and must be wrapped with them.
- **A NOTE THAT BEGINS ON A CHANGE BELONGS TO THAT CHANGE — ASK THROUGH `chgTime()` (2026-09-20).**
  The harmony resolver answers by differencing an ABSOLUTE onset (`cycleStart + offset`) against an
  absolute anchor, so an onset sitting EXACTLY on a change is a subtraction of two large, nearly
  equal doubles — and it is not always exact: `(0.4392 + 4) - 0.4392 === 3.9999999999999996`, below
  the boundary, so the PREVIOUS chord wins. **516 of 4000 plausible cycle starts lose it.** At
  `cycleStart` 0 (the stopped drawing) it is exact, which is why a frozen 3-bar take over D·F#m·G
  drew its fifth onset as F#m on some Preview presses and G on others — reported as "first note of
  third change changes back and forth, looks like 1 half step". **It is NOT a `(2/3)*6` rounding
  error** (that product is exactly 4.0); the loss is in the big-number subtraction, so it cannot
  show until a wall clock is involved — which is why it looked like a preview bug. `CHG_EPS` is
  0.1 ms, and `toneSetAt` · `groundIdxAt` · the span/step sites · `chgOf` all ask through it: ONE
  definition, because the five of them disagreeing at a boundary is the same bug five ways. This
  file had already recorded this class twice ("`cs` … one ULP below its own boundary") — when a
  picture changes by a step or two at a bar line, suspect the boundary before the rules.
- **⏻ FIXED IS A MODE, NOT A VERDICT (2026-09-20).** It used to be COMPUTED — inspect ~15 settings,
  and if none of them draws, call it FIXED — and both failure modes were reported. It is the **ZERO
  CASE**, so a freshly generated layer read FIXED with nothing set ("I never chose it to be FIXED" —
  nobody did); and it could be **FALSE** (a "FIXED" part re-pitching every note every pass because
  its cycle did not divide the changes). A verdict assembled from fifteen inputs is unreasonable to
  reason about AND can be wrong; a mode cannot be wrong, because the engine enforces it. `L.fixed` is
  now the whole answer, absent = fluid, and **VARIES is the floor** — a permission ("this may
  change"), not an observation ("we proved it does"), which is what makes it always true.
  **A MODE THAT ONLY RELABELS IS THE OLD LIE WITH A SWITCH ON IT.** Enforcement is `fixedOf` (the
  take clock, inside `chgAt` — the ONE computation — and the `vary` term of `cycIdx`) and `perfOf`
  (every per-pass draw, in ONE reader so a new die cannot join this axis without being outranked).
  **OUTRANK, NEVER ERASE:** nothing is deleted, so turning it off hands the layer back exactly —
  the same rule the retire-a-control trap states from the other side.
  **IT DOES NOT PIN THE CHANGES, deliberately.** A generated part resolves its pitches against the
  sounding chord, and that is the song rather than variance — so a FIXED layer still follows the
  progression. Measured over D·F♯m·G: pitch classes 0,4,7 / 4,7,11 / 0,5,9 with Fixed ON.
  `stateWord` reads `state` and nothing else now; its old `.live` fallback is exactly how "no
  reasons found" got printed as FIXED.
- **A DIALOG OVER NOTHING TRAINS PEOPLE TO DISMISS DIALOGS.** `keepGate` promised in its own comment
  to be "silent when there is nothing to lose", then tested `takeShownNotes().length` — which for a
  LIVE part is `takeNotesNow()`, the notes the rules are producing *right now*. Nothing is stored,
  nothing is at risk, and re-rolling is the pressed button's whole job. Measured: all five Material
  doors leave the part LIVE and every one of them armed the gate. `takeIsWork` is the real test, and
  it is deliberately **conservative — it only ever answers "no" for a part with NO STORED NOTES**:
  failing open costs a tap, failing closed costs somebody's work, and a plain note DRAG leaves no
  marker to tell an edited take from a rolled one (`made` gives provenance, `p.tf` a transform, and
  neither catches a drag). Do not "improve" this into a cleverer predicate without a marker to
  stand on.
- **⇗ RAMPS REACHED v2 ALL ALONG — THE CARD JUST NEVER EMITTED THE BLOCK (2026-09-20).** Asked as
  "v2 layers should have ramps", and the engine half was already complete: `_AMB_RAMP_PARAMS.v2`
  lists 34 params (61 offered, with the shared Stereo/Spatialize/FX append), `_ambRampTargetGroups`
  enumerates `cfg.layers`, and a saw on `part.rhythm.pulses` sweeps (measured 1·5·9·12·1·5·9·12).
  What was missing was `_ambLayerRampsHtml('v2:'+id)` on the card — every v1 card renders one, so
  the only way in was Area ▸ Ramps. `V2.render` appends it (into `.ambient-layer-body`, the
  lane-expander idiom — `cardHtml`'s tail is nested group divs and any insertion point there is a
  guess) and then calls `_ambRenderRamps`, which is the ONE writer for every layer model's rows.
  **`#bloom-v2-layers` IS INSIDE THE PANEL HOST.** So `_ambRenderRamps`' existing
  `host.querySelectorAll` already finds a v2 block as a descendant, and the ＋ button's delegated
  listener already catches its press. Both were "fixed" before being checked and both were wrong:
  restricting the sweep to `E.hostId` explicitly changed NOTHING (the poison passed 8/8), and wiring
  a second listener on the v2 host made one press add **two** ramps — the double-wiring trap, in the
  add direction. **Before broadening a sweep for v2, check whether the v2 host is already inside
  the one being swept.**
- **THE STAGED DRAWING NEEDS THE PREVIEW'S CLOCKS TOO (2026-09-20).** `drawPartViz` was fixed to
  draw in the clock its notes were made in; `stageVizDraw` \u2014 \u2699 Deep's own picture \u2014 took
  `cs0 = pv.at` and NOT `pv.pa/ps/bg`, so it resolved preview-time onsets against the RESTORED
  global progression origin. Measured with a draft open: a 3-voice chord part drew 21 and played 21
  with 14 of them DIFFERENT, and Groundwork drew 27 against 18 heard. Reported as generation not
  being deterministic. **Two drawings, one rule: whoever takes `PV_VIZ.at` must take its anchors.**
- **WHAT A GENERATED LAYER GUARANTEES, MEASURED (`test/probe-gensync.js`).** Determinism is solid:
  13/13 materials give the identical `notesFor` answer on three calls with the take pinned. Sync is
  exact for every material and for Accent, Slide, Wobble, Strum, Swing and Tight \u2014 they act BEFORE
  or INSIDE the seam. **Two break it by design and are pinned as known:** Humanize writes
  `params._humanSec`, applied downstream of the `at` the emitter schedules (\u00b17 ms at 40, unseeded,
  so it can never be drawn), and Ornament ADDS grace notes in the emit loop the picture knows
  nothing about. A harness reading only the `at` argument reports Humanize as "in sync" \u2014 capture
  `params._humanSec`, or the blind spot is yours rather than the engine's.
- **A GATE THAT RE-DERIVES THE PICTURE PROVES NOTHING \u2014 AND TWO SELECTOR TRAPS AROUND IT.** The
  staged half of `probe-gensync` first reproduced `stageVizDraw`'s own logic and compared THAT to
  the audio, so poisoning the fix left it green. Read the canvas's published `_hits`. Then:
  `.v2-stagecv` matches TWICE (\u2728 Quick's canvas and \u2699 Deep's) and an unscoped query finds Quick's,
  which is shut and zero-width \u2014 scope to `.v2-genwrap`. And the card must be expanded BY ITS
  HANDLER, because `stageVizDraw` returns early on a zero-width canvas (`if (!(wCss > 0)) return`),
  so a `classList.remove('collapsed')` poke means it never draws at all.
- **\u21d7 RAMPS IS A TAB OF MIX, IN THE CARD'S MARKUP.** It went through three homes in one day and
  the two dead ends are the lesson. (1) APPENDED under `.ambient-layer-body`: v1 chrome under a card
  built from big section buttons \u2014 the bolted-on control this file's own rule forbids, and
  unfindable ("where"). (2) ITS OWN GROUP + SECTION: findable, but a seventh chip for one control.
  It is now a row in the Mix group carrying `data-v2tab="Ramps"`, beside Mod \u2014 the other surface
  that moves a value over time. Being in `cardHtml` also removes the two-path problem below outright:
  there is nothing to append on either path.
  **A TAB IS BUILT FROM A ROW.** `syncSheet` groups `.ambient-ctrl` rows by `data-v2tab`, so a bare
  block gets NO TAB \u2014 measured, the Mix sheet came up Level \u00b7 EQ \u00b7 Space \u00b7 Mod with the ramps
  nowhere. It must carry `.ambient-ctrl`. But that class is a GRID, and inside one the ramp's target
  picker is handed an 18px column (the squeeze the \u23f1 Odds lane escapes with `grid-column: 1 / -1`)
  \u2014 so `.v2-rampctl` turns that row back into a block. Row-hood for the tab, block for the layout.
  Stamp the ROW, never the block: `tb()` adds the attribute to EVERY `<div `, and this block is
  nested markup `_ambRenderRamps` writes into.
- **`V2.render` HAS TWO PATHS, AND THE EARLY RETURN IS THE COMMON ONE.** The structure-signature
  guard (`h._sig === sig`) fires for every value edit on an unchanged set of cards — i.e. nearly
  every render — re-applies the gate and RETURNS. Anything that decorates a card must run on BOTH
  paths or it reaches only layers added after page load, which is the shape that makes a feature
  look shipped: the Ramps block landed on a fresh layer and never on an existing one, reported as
  "where" against a card that ends at \u25b6 Preview. `ensureRampsBlock` is idempotent and called
  from both. A probe that BUILDS a fresh layer only ever drives the rebuild path — drive the early
  return too (render twice with no structural change).
- **A GATE MUST FAIL LEGIBLY, NOT CRASH.** Poisoning this one first produced a `null.click()` stack
  trace instead of named failures, because every check after the first drives the block. It bails
  cleanly now when the block is absent. A crash still exits non-zero, so it is *caught* — but it
  tells the next person nothing about which contract broke.
- **`liveBadge` EATS THE SEPARATOR IT LIFTS, AND ONLY AT THE START.** It lifts `FROZEN` into a chip,
  strips the following ` · `, then looks for the state word at the START of what is left — so any
  text placed BETWEEN them silently stops VARIES/EVOLVES/FIXED being lifted at all. The freeze
  reason therefore goes AFTER the state word (`FROZEN · VARIES: timing · a take you froze`), never
  between. Two consequences for probes: the readable `textContent` has NO ` · ` after a lifted word
  (`FROZEN a take you froze`, and `FROZENVARIES` when both lift), so assert on that shape; and the
  badge's colour must be read while it is still in the document — `probe-roll-legend`'s hue check
  clicks `.v2-genbtn` (which rebuilds the card) after capturing the node and then reads
  `getComputedStyle` on a DETACHED span, which returns `''`. That failure is the stale reference,
  not the hue: `--evo` and `.v2-sum-evo` are both fine and the class is applied.
- **A STATE THAT OUTLIVES ITS TOAST HAS TO BE READABLE OFF THE CARD.** A part freezes when you tap a
  note, draw one, drag one, or re-roll a single bar — `captureShown`, which the readout itself
  invites ("tap a note to edit · a bar or chord to re-roll") without saying it writes the part down.
  The toast said so and faded; the FROZEN that remained did not. `part.froze` records WHICH gesture,
  coerced against one table (`FROZE`, engine half, published as `V2.frozeWhy` — the UI half prints
  it, and a second copy there would be two tables plus the two-IIFE throw) and **dropped the moment
  the part goes live again**: a reason for a state you are not in is a lie waiting for the next freeze.
- **⏱ TIMING IS A STAGE IN `notesFor`, NOT A KNOB IN THE EMIT (2026-09-20).** `part.timing` —
  `swingDiv` · `lean` · `odds` · `ratchet` — is applied at the ONE exit every caller passes through,
  beside `tightClip` and `xfStage`, so the drawing, the outlines, ⚙ Deep's preview, capture and
  playback cannot disagree about when a note fires. **Swing used to be added in the emit loop**, so
  the picture never had it: measured, swing 100 delayed every odd slot 125 ms while `notesFor`
  returned 0·250·500·750 unchanged. Moving it was a DELETE from the emit, not a copy — applying it
  in both places doubles it. Anything new that MOVES an onset goes in this stage.
  **SWING IS A WARP, NOT A PARITY TEST.** "Round to a slot index and delay the odd ones" only holds
  while every onset is exactly on the grid, and off-grid onsets are normal here (`rateVar`,
  Groundwork, a hand-drawn part). Measured on a 16-onset part swung in 8ths, `Math.round` put two
  onsets on the same time — a note silently eaten. It is piecewise-linear through each pair with the
  midpoint moved late by exactly `swSec`: monotonic, so onsets can never cross, and a note ON the
  grid moves by exactly what it always did, so existing layers do not budge.
  **THE AMOUNT STAYS `L.swing`** — the field the Area Groove macro folds into (`_ambSwingSec`);
  `timing.swingDiv` only picks which grid the pairs are counted in. A second amount would be the
  third time this card grew two controls for one value.
  `odds` is additive over `rhythm.chance`, deliberately: Rests/chance is one number for the whole
  grid, Odds is a statement about ONE step. 100 is stored as ABSENT, so an untouched lane costs
  nothing. NOTE: `docs/bloom-stochastic-controls.md` is generated from v1's `_AMB_STOCH` and does
  NOT know about these — they are part-level v2 fields.
- **`.ambient-ctrl` IS A GRID, NOT A FLEX ROW.** `flex: 1 1 auto` on a control inside one does
  nothing — measured, the Odds lane was handed 9px of the control column and its cells came out
  0 wide. A full-width control there takes `grid-column: 1 / -1`. And `.ambient-step-btn` is a
  FIXED 34px flex item, so eight of them overflow a phone row: as grid cells they need
  `width: auto; min-width: 0` (a grid item's default `min-width: auto` is what stops it shrinking).
  Measure `scrollWidth` vs `clientWidth` on the lane, not just its right edge against its parent's —
  the first check passed while the content was still overflowing.
- **REPAINTING A LANE WITH `innerHTML` KILLS THE CELL UNDER THE FINGER.** The Odds lane rebuilt its
  own markup after each tap, which detaches the button that was just pressed — the next tap lands on
  a node with no ancestors and the delegated handler never fires. Measured as six taps producing one
  step. Update the cells IN PLACE (textContent + classList) and repaint FROM THE STORE, never from
  the value you just wrote (normalize may have pruned it).
- **THE BOUNDARY IS ASKED IN TWO FILES, AND BOTH HAVE TO AGREE.** Fixing `chgTime()` in
  18-layer-v2.js fixed the PITCHES and left the LENGTHS flipping — `_ambChordEndAt` (17-ambient.js,
  the choke's resolver) was asking `_ambProgStepAt(E, atSec)` bare. For an onset exactly on a change
  it then bisects for the end of the WRONG chord, which IS that onset, so `end > atSec` fails and
  **the choke does not fire at all**: measured, 2-bar notes came out 1988 ms at one cycle start and
  4000 ms at the next, on the same take. `_AMB_CHG_EPS` is the same 0.1 ms for the same reason.
  v2 decides WHICH CHORD a note is in and v1 decides WHERE THAT CHORD ENDS — one boundary, two
  files, and a half-fix reads as a different bug ("it's still doing the truncation"). The residual
  spread is ~1 ms, which is the bisection's own ~0.5 ms resolution, not a misassignment; gate it
  with a tolerance, not on equality. **v1's per-onset emitters (`_ambProgStepAt(E, at)` at ~12613,
  12762, 13059, 13529, 14569) still ask bare** — untouched deliberately, since golden-render and
  arch-parity are green as they stand; treat them as the next place this shows.
- **A GATE DRIVEN BY REAL PRESSES CAN BE A LOTTERY.** The first version of `probe-chordedge.js`
  drove ▶ Preview eight times and asserted the pitches agreed — and it PASSED with the fix reverted,
  because a press lands on a bad cycle start only about one time in eight. A poison that passes is
  worse than no gate. It sweeps a FIXED ladder of 240 cycle starts through `notesFor` with the
  anchors pinned instead: same invariant, deterministic, and the poison then names the exact
  cycle start that breaks it. Poison-verify a timing-dependent check, or it is decoration.
- **A "FIXED" PART STILL RE-PITCHES IF ITS CYCLE DOES NOT DIVIDE THE CHANGES (2026-09-20).**
  Separate from the two above and still true: a 2-bar cycle under a 3-bar part sits over different
  chords every pass, so a GENERATED part's pitch rules re-resolve and every note changes for ever
  (measured through `notesFor`, so it SOUNDS). `liveness()` counts three ways the changes can move
  (salt · `prog.vary` · alternates) and NOT this one, so the badge reads **FIXED with no tags**
  beside the one thing moving; the readout names the cause one line away ("repeats 1.5× over the
  3-bar part — ⇄ Sync to fit it") without connecting it to the state word. Setting `part.bars` to a
  divisor collapses it to one note set — that is the proof of cause.
- **DIFFING A PICTURE? DO NOT REDRAW WITH `_ambRebuildMaster()`.** It builds a FRESH canvas and
  drops exactly the module state a preview/playback bug lives in — it hid `PV_VIZ` from three
  probes in a row and sent the first diagnosis after the wrong quarry. Drive the real button (the
  handler repaints the card itself) and read the SAME canvas's published geometry. Likewise pin the
  clocks (`E._progAnchor/_playStartAt/_barGridAnchor = 0`, the `partseq` idiom) before diffing
  `notesFor` pass to pass; an unpinned anchor re-orders the chords under the walk and inverts the
  answer.

- **THERE IS NO "\u2699 Generate" DOOR. The way back from a frozen take is `\u22ef \u25b8 \u26a1 Release`.** The
  freeze toast named \u2699 Generate for months and it has never existed — and the Transform refusal named
  "❄ Freeze this take", a button gone since 2026-09-17 (fixed 2026-09-19; `capFace` still builds that
  face for a `.v2-capture` nothing renders) — `MAT_LABEL` has no such
  entry and no button carries it; the only unfreeze is the \u22ef menu's "\u26a1 Release \u2014 back to live"
  (a Material door also makes a part live, but REPLACES the content). Reported as "unless i'm missing
  something" by a user doing exactly what the card told them. **A hint that names a door is a claim —
  grep for the label before writing it**, and note this one propagated: the readout copied the name
  from the toast, so the wrong door was then said twice.

- **VARY AND EVOLVE ARE TWO CLOCKS REACHING THE SAME TAKES.** `cycIdx` is `take + epoch` with the
  epoch stepping by ONE per change, so the takes that are coming are `base + 1, +2, …` under either —
  `vary` reaches the next one after 1 cycle, Evolve after `ev` passes. The drawing's pass sampler is
  therefore shared; only two things differ: whether to ask at all, and `base` WHILE PLAYING (`vary`
  counts cycles, Evolve counts epochs; stopped, both are the layer's own pin).
- **`chgEpoch` FEEDS ONLY `cycIdx` — pinning the take is enough to preview a future epoch.** The
  obvious worry is that `am`'s keep-or-change blending would need the epoch pinned too; it does not.
  `seedKeep`/`seedHold` reference the TAKE, deliberately ("a stateless engine can only keep something
  it can NAME"), and `slotNew`/`stageSeed` key off `seedBase`, which comes from `cycIdx`. So
  `withTake(n)` reproduces a future Evolve pass exactly. Verified by grep before building an epoch
  pin that would have been dead weight.
- **`ctx.cycleStart0` IS SET BY NOBODY** — read once, with `|| 0`, so Evolve's fallback tick is
  `round(cs / cyc)`. That is why a caller holding only `E` and `cfg` (the drawing) gets exactly what
  the emitter gets from `chgAt`.
- **A CACHED DRAWING NEEDS EVERY INPUT IN ITS SIGNATURE.** `cv._stab.sig` carried `base`, which moves
  when an Evolve epoch turns — but `ev`/`am`/`clock` are NOT derivable from it, and changing any of
  them changes which takes are coming. A signature short of an input is the frozen-readout trap with
  a cache in front of it.

- **`part.vary` IS INERT ON A RECORDED PART — qualify it EVERYWHERE, not just in `liveOf`.** A written
  part plays its stored list, so the generation path never runs and `vary` cannot act; `liveOf` has
  carried `vary && kind !== 'recorded'` since the "why does it say VARIES after it's been written
  down" report. `gateNowOf` computed the same axis UNQUALIFIED, so freezing a varying part (which is
  what tapping a note does) left the gate reading `vary:on` for ever and took all three Evolve rows
  away permanently — "Evolve has stopped working". **Two computations of one axis is the bug; grep for
  `part.vary` before adding a third.**
- **A row that fails only on `vary` is OUTRANKED, not irrelevant — grey it, don't hide it.** Same
  split `kind` already gets, same reason ("where did the rhythm params go", twice). The switch doing
  the outranking (Each cycle) is the row directly above Evolve, so a dimmed row points at its own
  cause while a vanished one teaches nothing. `evo:on` still HIDES: How much / Against genuinely mean
  nothing until Evolve is non-zero. Only Evolve's three rows carry `vary:off`, so that is the whole
  blast radius.

- **TAPPING A NOTE FREEZES A LIVE PART — and that is why the outlines vanish.** `captureShown` turns
  the part `recorded` so there is something to edit, which makes it FIXED, which means no other takes
  and so no outlines. Reported as a disappearance ("all the phantom notes disappeared after i clicked
  an active note, now they won't come back"). The toast named ⚙ Generate as the way back AND THEN
  FADED: a state that outlives a toast has to be readable off the card. `made === 'take'` is the
  frozen-from-live case ('compose' is drawn or emptied), and `vary` survives the freeze inert, so the
  readout can say whether outlines are what is waiting on the other side.
- **ONE FIELD, ONE DOOR.** Per part was asked by the head pill (`.v2-pop-pp`, beside ⇄ Sync) AND by a
  Generate row (`.v2-ppmode`) — the row removed 2026-09-19 as redundant, the third time this card has
  grown a second control for one field (the rhythm knobs, the Written source, this). **The tell was in
  the comment that introduced it:** it had to borrow the pill's handler "so the two doors cannot grow
  apart", which is a control wearing two coats, not two controls. Removing a door means re-pointing
  every hint that NAMED it (three said "set in Generate ▸ Per part") and every probe that drove it —
  `test/probe-perpart-time.js` now drives the pill and asserts the row has not grown back.

- **"GHOSTS" MEANS TWO THINGS — never say the word in the UI.** ⚙ Deep's `L.ghosts` is "% quiet extra
  hits": real notes, they SOUND, and they draw SOLID. The drawing's internal `ghosts` are the hollow
  outlines behind the take — every (onset, pitch) one of the next `PASSES = 8` passes plays that the
  drawn take does not, alpha `0.12 + 0.4 × (count/8)`, stroke only. The solid notes carry the other
  half of the same fact: alpha `0.28 + 0.72 × stability`, the share of those 8 passes that play them.
  A FIXED part samples one take eight times, so it has none by construction. The readout calls them
  **outlines** for exactly this reason (asked verbatim: "what are all these shadow notes").
- **HUE IS WHICH TAKE, ALPHA IS HOW MANY — two facts, two channels.** In one colour the outlines were
  a mush ("still looks a mess, can we add some color coding to distinguish takes"). Each now wears the
  hue of the SOONEST pass that plays it (`sm` is walked in order, so the first pass to claim an
  (onset, pitch) is the minimum — no `min()` needed). The seven hues are `--take-1..7` on `:root` in
  `bloops.css`: the house section palette MINUS the lavender, which the drawn take itself wears —
  seven left for seven other passes, so the fit is exact and no outline is confusable with the take in
  front. `takeHue()` reads them off `:root` once per draw and memoises on the canvas; a
  `getComputedStyle` per outline would be a layout read inside the draw loop.
- **A LEGEND IS A READOUT: say it only when the thing it names is ON SCREEN.** Two gates, not one —
  `ghosts.length` (a FIXED part has no outlines, and naming them there is a confident wrong answer)
  AND `tapTxt`, because ▸ Hide takes the picture away and KEEPS the readout. `test/probe-roll-legend.js`
  holds the biconditional, both directions poison-verified; saying it unconditionally prints
  `FIXED · … · outlines: notes other takes play`, which is the lie in one line.
- **The drawing publishes what it drew** — `cv._stability`, `cv._ghostN`, `cv._ghostTakes`,
  `cv._pitchGeo`. A gate that re-derives the picture instead of reading these is testing its own
  arithmetic, not the drawing. **Publish from INSIDE the draw, off the value the canvas was handed**:
  `cv._ghostTakes` was first built as `ghosts.map(takeHue)` — the INTENT — and poisoning the stroke
  then left it still reporting the right colours while the picture had gone monochrome. Reading
  `g.strokeStyle` back as each outline is stroked turned that poison from 1 failing check into 3.
  To reach a part that HAS outlines: a new layer starts as an EMPTY `recorded` part (excluded from the
  pass sampling), so drive a Material door (`.v2-autopick`) → `✓ Done` → `.v2-varytoggle`. The readout
  is `.v2-vizlab`, the canvas `.v2-vizcv`.

- **A FIELD HIDDEN BY A GATE IS STILL READ BY THE ENGINE.** `part.bars` is gated `clock:bars`, so the
  row vanishes on a Free clock — but it stayed STORED and every bar-derived DENSITY quantity kept
  dividing by it (gap floor, note-length floor, the added-note snap grid, the ghost floor, and the
  per-bar budget of the density ceiling). A free layer therefore sounded different depending on what
  Bars happened to be when you last left the grid. Fixed 2026-09-18 by resolving `barsOf` ONCE at the
  top of `notesForRaw` (`clock === 'free' ? 1 : bars`) and deriving all of them from it — a floor and
  a budget that disagree about what a bar is would be the same bug one layer down. **Gating a row is
  not retiring a field**: grep the engine for every read before assuming a hidden control is inert.
  STILL BAR-DERIVED IN FREE MODE, deliberately (structure, not density): the change-grouping key
  (`'b' + floor(on * bars)`), ⚇ Mix's strong-beat test, Groundwork's antic lead, and `barsF`/`slotOf`
  (the 1/48-bar coordinate stored edits are pinned to — moving it would move existing edits).

- **A COMPUTED FACE ON A CARD REPAINTS FROM `applyGateCard`'s tail** — that is the chokepoint every
  commit already runs through (`commit` → `applyGate` → it → `popSync`). A row builder alone is ONE
  writer, and a value built from tempo / Bars / Rate / Steps freezes at whatever was true when the
  row was built, because none of those rebuild it. Hold's hint resolves `cycle / Steps × Hold` into a
  time this way (2026-09-18); `querySelectorAll`, never `querySelector` — a field can have two
  controls on one card and the copy you are not touching is the one that goes stale.
- **A STAGED PANEL GATES FROM ITS CLONE, so a change made to the real layer below does not reach it**
  — and reads as a gate leak (a row gated `rhythm:euclid` still showing after switching to `ground`).
  `✓ Done` is the way out; `.v2-genbtn` may not close it once a rebuild has restored `GENPOP`. Check
  `.v2-genopen` before believing a gate result. Same root as the staged-commit trap below.
- **A `.v2-f` commit inside ⚙ Deep / ✺ Quick writes to the STAGED CLONE, not the layer** — so a probe
  that drives one and reads `getCfg().layers[0]` measures "the control commits nothing" on working
  code. Read `V2.stagedOf(id) || layer` (what `test/ui-lifecycle.js`'s `__Lv2` does). Cost an hour.

Read `docs/bloom-layer-v2.md` before touching layers. A layer is an INSTRUMENT and a PART; a part is
LIVE (rules resolved at play time) or RECORDED (notes read back). `notesFor(L, ctx) → [{at,freq,durMs}]`
is the interface. v2 decides only "what notes, when" — everything downstream of `playNote` is v1's.

- **The file is TWO IIFEs sharing only `window._v2`.** A bare name from the wrong half throws straight
  into a surrounding `catch` and the feature measures as a silent no-op. This has bitten ~6 times
  (`formOf`, `layersOf`, `barSec`, `num`, `takeAsNotes`, `previewing`). Publish through `V2.` and check
  which half you are in before reaching for a helper.
- **Vocabulary (label-only; data keys unchanged). ONE WORD, ONE JOB — re-cut 2026-09-16** (user:
  "there's two different meanings of it operative in v2: written meaning by-hand, and written meaning
  recorded (static)"). Measured before renaming: **21** user-visible uses of WRITTEN meant the STATE,
  **1** meant by-hand. The state won the count and lost the word anyway, because the user's reading is
  the one that has to survive contact:

  | axis | poles | means |
  |---|---|---|
  | what makes the notes | **GENERATED** · **STATIC** | resolved by rule at play time · stored and read back |
  | does it change per cycle | **EVOLVES every N: what** · **VARIES: what** · **FIXED** (badge, `liveBadge`) | `liveness().state` — a property of the SETTINGS. EVOLVES is the CONTENT clock (`chg.ev`, and `vary` = every cycle), in its own hue (`--evo`, lime); VARIES is the per-pass dice (timing, loudness, chance, the chords); FIXED is the zero case, not a second kind |
  | who chose the notes | **✎ Written** (by hand) | the only surviving use of the word |

  **STATIC had to be TAKEN OFF the liveness readout to be given to the state** — renaming one pole
  without moving the other just relocates the collision, and both were on screen at once. The two axes
  are orthogonal: a GENERATED part with the dice off is FIXED and is NOT static.
  **FIXED IS A SPECIAL CASE OF VARYING (2026-09-16):** a part is a function pass → take; Fixed is the
  constant one. The badge names WHAT varies (`tags`: notes · chance · chords · timing · loudness), and the
  drawing samples 8 passes' takes at the same moment (`cv._stab`, published as `cv._stability`) — note
  opacity = share of passes it plays in, faint ghosts for notes only other passes play. No Fixed branch:
  a fixed part samples one take eight times and draws solid. Chance masks and harmony dice are TIME-based
  (not in the take) and are not sampled yet; Humanize/Vel var are unseeded and cannot be.
  **✺ LIVE is a SECTION over Shape's `Every pass` tab** (`SEC_GRP.Live = 'Shape'`, `SEC_TABS.Live`) and
  Shape gives that tab up (`SEC_EXCL`), so the dice / Humanize / Vel var have ONE door. A new control that
  makes passes differ goes in that tab, never in another section. `secForTab` resolves any group's tab.
  **Never derive LIVE/FIXED from `part.kind`** — the section summaries did (`kind === 'live'` → "live"),
  so a repeating generated part said live and a humanized static one said nothing; every surface
  reads `liveness()` (its `tags` are the one-word reasons).
  `LIVE` is a property of the SETTINGS (`part.vary`, Humanize, Vel var, a mask at a probability, and
  the harmony dice — salt, `prog.vary`, alternates — gated on the layer actually following);
  everything else named vary/var/scatter/chance seeds off a FIXED take and shapes the material once.
  `part.kind: 'live'|'recorded'` is the DATA key and still reads "by rule" / "by hand" — unchanged,
  for save-compat, and no longer the words on screen.
  **The action keeps the old verb on purpose:** `✎ Write it down` (and its "Wrote this take down"
  toast) is TRANSCRIBING what you just heard, and the state it produces now says STATIC. If that verb
  ever reads as "by hand" again, rename the ACTION — do not take the noun back.
- **◈ THE SEAMLESS-UNIT BADGE (`.ambient-orch-unit`) IS A LIVE READOUT AND HAD NO SYNC (2026-09-14,
  user: "that 30 number doesn't update").** It was computed inline inside `_ambAreaStripHtml` and
  written nowhere else, so it was painted once when the panel was built and never again — evening out
  a progression moved the real unit while the badge went on showing the old number. **A readout that
  never re-reads is worse than no readout: it is a confident wrong answer.** One definition
  (`_ambUnitBadge`) + one repaint (`_ambSyncUnitBadge`, riding `_ambSyncControls`, which 64 call sites
  already reach for after a change). **When adding any computed face, grep for a second writer — if
  there is none, it is frozen.**
  - **The unit is the LCM of the area's capturable layers AND the PROGRESSION's own cycle**
    (`_ambAreaLoopBars`), and the progression contributes even with nothing Unit-Synced — a common
    source of a surprising number. It sums the **FLAT** chord list: parts, the chain and `plays` do
    not divide it, so "evening out the parts" changes nothing unless the chord TOTAL changes.
- **↺ Reset on the per-region panel clears TWO stores (2026-09-14):** `ruleb` AND `takeb`. Clearing
  only the rules left 🎲 Roll again's pinned throw behind, so a change that had been rolled never came
  back to "what it would be with nothing set" — the only thing a reset can mean. `V2.resetBars` /
  `V2.barHasOwn`; the button is DISABLED with the reason in its title when there is nothing to drop,
  which replaced a toast that only arrived after the press. **🎲 Roll again closes the panel** — it
  sits over the drawing the press just changed — closed AFTER the redraw, so the new roll is what is
  revealed. The bar stays SELECTED, so the door still leads back in.
- **PER-REGION OPERATIONS ARE NOT RULES (2026-09-14):** `ruleb[key].ops` — `arp`/`arpDir` (⟳
  Arpeggiate) and `scale` (⬡ Scale) — run in the COMPOSITE, on the region's own notes, after the roll
  that made them. A rule says how a stretch is MADE; an operation says what to do with what came out,
  and a generator cannot express one because it does not know its own region. `partWithRules`
  deliberately does not carry `ops` into the shim: there is nothing in the emitter to read them.
  - **Select PER KEY, not per group.** A group is one roll shared by every region agreeing on
    (take, rules); an operation is stated against ONE region's span, so the filter moved inside.
  - **`BAR_NEUTRAL` — what "not set" means for a group with no part-level rung.** `rhythm`/`pitch`/
    `shape` inherit from the part, so `undefined` is a real answer there; `ops` has nowhere to inherit
    from, and without a neutral table `setBarRule` stored `arp: 0` as a choice — the row read "off"
    while wearing SET HERE. Enforced twice: in `setBarRule` and in normalize.
  - **Arpeggiate preserves the note-event size AS A RATIO of its slot**, the same language Scale is
    stated in — a held chord arpeggiates legato, a stabbed one staccato. Scale multiplies onsets AND
    durations about the region's start; past 100 it runs on into what follows, which is what
    expanding means.
  - **A divider row (`{sec}`) has no `g`/`f`** — `barRowsHtml`, `barShownSig` and `barVal` all return
    before reaching for them.
- **A STRETCH CAN BE RECOLOURED AND RE-VOICED (2026-09-14):** three `part.ruleb` fields on `pitch` —
  `qual` (triad), `ext` (what is stacked on it) and `inv` (inversion) — so the per-region panel can say
  "this bar is the minor of it, with a ♮7, second inversion". All absent-by-default; with none set
  `v2Recolour` is never reached and the harness hashes what it always did.
  - **QUALITY and EXTENSION are two axes on purpose.** "Major plus a 7th" names both C7 and Cmaj7, so
    the SEVENTH is what you pick (`7` = ♭7, `maj7` = ♮7) and the triad is picked under it. `dim7` is a
    QUALITY, not `dim` + an extension — its ♭♭7 is a fourth stacked third.
  - **An extension alone keeps the change's OWN triad**, read off its intervals by `v2TriadOf` — assume
    major and an F♯m quietly becomes F♯7.
  - **`voices` is a FLOOR, raised on a shim part.** A 7th is the fourth tone, so at the default 3 the
    control was measurably dead (identical notes with and without it). Raised, never lowered — and the
    row SAYS so ("4 tones — Notes at once is raised to reach them"), or the panel reads 3 while 4 sound.
  - **Inversion runs on past the octave rather than wrapping** — with 3 voices, inv 3 is root position
    an octave up. That is one axis, not an inversion control plus an octave control. Applied to the
    NOTES after `applyHarm`, never to the interval set, and the row translates the number
    (`invWord`) because 0 and 1 are exactly the values this file calls meaningless.
  - **`setBarRule` treats `''` as ABSENT.** The "— the change's own" option otherwise stored `ext: ""`:
    marked SET HERE, reading as unset, contradicting the panel's own sentence about dropping a value
    set back to the part's.
  - **Option VALUES come from `BAR_RULE_F`, labels from the UI half.** Two hand-kept copies of one
    vocabulary is how a select offers a value `setBarRule` rejects — which renders it BLANK.
  - **`sel: FOO` in the `BARROWS` literal READS the binding**, so a `const` declared below it is a TDZ
    page error. Declare the option lists ABOVE `BARROWS`, or keep the reference lazy.
  - **`BAR_RULE_F` IS A WHITELIST WITH RANGES, AND BOTH HALVES BITE SILENTLY (2026-09-20).** A field
    it does not list is dropped from the overlay by normalize; a range NARROWER than the part's own
    clips the value on the way in. Neither errors, and both read as "the setting did nothing" —
    measured twice in one pass: `n` at `[1, 32]` against the part's `[1, 64]` made a fast Character
    come out at half speed, and `lenRatio` at `[5, 100]` could not hold one that rings past its
    onset. **When a region must carry some setting, list it AND copy the part's range.**
- **`gapAt` MEASURES WHERE ONSETS SOUND, NOT WHERE THE GRID PUTS THEM (2026-09-21, user: "why are
  chords different lengths" → "still differing lengths on reroll").** A note's length is `lenRatio`
  of `gapAt(k)`, and that read the GRID — which Arrive moves onsets off without moving. So an
  anticipated part whose onsets were EVENLY spaced still had lengths alternating 250 · 550, and the
  loop traded an 8th between neighbours (`dm0 += anticK`, and the one ahead giving it up) to paper
  over exactly that. `gapAt` returns the real sounding gap now and **both adjustments are gone** —
  keeping either would count it twice. ⛰ Comp comes out 400 × 6, which is 40% of the 1000ms each
  note actually has. With Arrive OFF the comp grid is genuinely uneven (750 · 1250) so 300 · 500
  is correct there; even lengths would be the bug.
  - **`gapAt` is called at BUILD time** (`const durMs = durAt(0)`), long before the onset loop, so
    anything it reads must be declared above it — the anticipation block moved up for this, and a
    `const` read early is a TDZ error the surrounding `catch` swallows into a silent no-draw.
- **AN ANTICIPATION WRAPS TO THE END OF THE CYCLE (2026-09-20, user: "changes to Character seem to
  introduce onset timing irregularities, like they hit too early after the very first one").** Arrive
  (`rhythm.antic`) pulls each change an 8th early, and the cycle's own top used to be filtered out of
  `anticAt` — nothing precedes it to arrive early from. True within one cycle, false across a LOOP:
  ⛰ Comp came out `0 · 750 · 1750 · 2750 · 3750 · 4750`, one 750 gap and an even 1000 pulse for
  ever, so bar 1 played the comp figure and no other bar did. The first change's anticipation is
  wrapped to `cyc − anticLead` now. Three things had to move together, and missing any one is a
  silent fault: the wrap itself, the LAST onset giving up its 8th (the `isAntic(i+1)` rule reaching
  round the loop), and a **sort** — a wrapped onset is generated first and sounds last, and nothing
  downstream re-sorts that path. An anticipated note is MEANT to overhang the downbeat it
  anticipates (`dm0 += anticK`), so across the seam it ends past the cycle; that is correct, and the
  invariant is only that it must not cover the next pass's first hit.
- **🎲 NEW TAKE SAYS WHEN THE TAKE IT ROLLED IS IDENTICAL (2026-09-21, user: "why does clicking
  New take only work once (re-rolls once) then no-ops from then on").** The take advances on every
  press — measured at 0→1→2→3→4→5 on a fresh part, a walk-line part, a series-line part and one
  with every bar take-pinned, so "works once" was not reproducible. What is real is that the NOTES
  cannot move on a material with no dice, and the press was silent about it. It compares the seam
  before and after now and toasts when they match, naming the ♪ Line as the way out on Groundwork.
  **A button that reports nothing reads as broken** — the same lesson as the Show-ahead line above,
  and it is worth reaching for before hunting a state bug.
- **⌫ CLEAR MAKES A PART RECORDED, SO ✦ GENERATE MUST OPEN FOR A RECORDED ONE (2026-09-21, user:
  "i cleared the part and now Generate menu is empty").** The section handler opened ⚙ Deep only
  when `part.kind !== 'recorded'` — and Clear is precisely what makes a part recorded, so a cleared
  part fell through to a sheet holding two recorded-only rows and no material picker. Clear's own
  tooltip promises "the generated settings are kept, so ⚙ Deep brings them back", and it could not.
  **A door gated on a state that another control PRODUCES is a trap door**: check what each button
  leaves behind before gating on the state it leaves. Transpose and Pitch quantize now live in the
  panel too, so there is one door and it always leads somewhere.
  - Zone 3 (Fine-tune) is `kind:live`, so a recorded part correctly shows TWO bars, not three —
    those are generation knobs and a stored note list ignores them.
- **✦ GENERATE'S THREE ZONES ARE FOLDED WHEN IT OPENS (2026-09-21, user: "the Generate menu is
  feeling totally unwieldy, the 3 subsections should be collapsed by default").** 848px → 433px. A
  class on the CARD per zone (`v2-gz-1|2|3`), the same shape as the fine-tune tabs and the ▸
  subsections, so nothing re-renders under the finger and `gateRow`'s own hiding still wins on top.
  The state rides the rebuild alongside `v2-so-*` and `v2-ftt-*`.
  - **THE DRAWING IS IN NO ZONE.** It sits between zone 1's bar and `.v2-genrows`, so it stays on
    screen with everything folded — which is the point, since it is the thing you are looking at.
  - **Every bar says what it holds while shut**, zone 1 naming the material: a collapsed bar reading
    only "MATERIAL" makes you open it to learn the one thing it was chosen for.
  - **A PROBE MUST NOW OPEN THE ZONE IT REACHES INTO.** A control in a shut zone measures 0×0, which
    reads as missing — and the tell is a detail line like `select 0px`. Arrive is a FINE-TUNE row,
    not a Main-knobs one; opening the wrong zone leaves the same 0px and looks like the fix failed.
- **OPENING A PANEL IS A FUNCTION, NOT A BUTTON (2026-09-21, user: "now remove the hidden Quick and
  Deep buttons and rewire the handlers").** Both generated panels opened from INSIDE a click branch
  keyed on a button, so the only way to open one was to have that node in the DOM and synthesise a
  press on it — which is why retiring the buttons first had to leave two hidden nodes standing, and
  why a dozen probes and the gate were clicking a control no person can see. `V2.openGen` /
  `V2.openQuick` are that behaviour lifted out; ✦ Generate's section button, the panel head's
  ✨ Quick and every probe call them. **When a surface can only be opened by pressing a node, the
  node cannot be removed — extract the opener first.**
  - Removing the node also orphans whatever SYNCED it: `matSync` lit `.v2-genbtn` as the door in
    force and `genSync` wrote `.v2-genface` inside it. Both went with it.
- **✦ GENERATE OPENS ⚙ DEEP; THE PANEL IS NOT MOVED INTO THE SHEET (2026-09-21, user: "make Deep
  the default view, and just add Quick/Key/Notes as header buttons… we drop the Method and Deep
  buttons").** The section used to open a sheet whose only live content was a Method tab holding a
  button that opened the panel — a door to a door. **Relocating Deep's rows into the sheet's pane
  was the obvious implementation and is the wrong one:** every control in there edits the STAGED
  copy and that binding is `closest('.v2-genwrap')`, so moving them switches them to editing the
  layer LIVE with nothing on screen saying so, and ✓ Done / ✕ Cancel become decoration over edits
  already made. The section button clicks `.v2-genbtn` instead; Key and Notes are popovers built
  INSIDE `.v2-genwrap`, which keeps both that binding and v1's delegated wiring intact. A RECORDED
  part still gets the sheet — Transpose and Pitch quantize are all it has.
  - **A `display:` rule on a class BEATS the `[hidden]` attribute.** The shut popover therefore sat
    over the panel with its scrim swallowing every press, and the head buttons that raise it could
    not be reached — measured as "the popover never opens" when the taps were landing on its own
    scrim. Any element toggled by `hidden` that also carries a `display` rule needs
    `[hidden] { display: none }` beside it.
- **A NEWLY LIT ♪ LINE ARRIVES ON `walk`, NOT `series` (2026-09-21, user: "it's still just
  recreating the part I just cleared with lines").** `series` is a DETERMINISTIC sweep of the chord,
  so a Groundwork part with a line still replayed identically for ever — the same complaint arriving
  a third time in different words. The kind is seeded at the PART rung and only `kind`, never `on`:
  a change that lights its own line states `on: 1` at its own rung and inherits this through
  `groundSet`'s layer → part → change merge, and the settings row edits this very field, so the
  default stays adjustable. **Saved content is untouched** — the seed fires only when a line is
  being lit and no rung states a kind already.
  - **⌫ Clear KEEPS the generated settings** (its own tooltip says so), so clear + regenerate is
    identical BY DESIGN on a material with no dice. That is the other half of this report.
- **A LINE LIT ON A CHANGE HAD NO CONTROLS (2026-09-21, user: "where are the controls for the melody
  line that is added per part?" — asked alongside "i cleared the content and then re-generated, and
  it just created the same part").** Groundwork's per-change ♪ is three-state and can switch a line
  on by itself, but the settings row (Moves · Notes · Octave · Length · Level) rendered only off the
  PART's line. So a line lit change by change had no Moves anywhere — it stayed on the default
  `series`, a deterministic sweep, which is exactly why the part regenerated identically. **The one
  knob that gives ⛰ Play the changes dice was the one with no door.** The row shows when the part OR
  any of its changes has a line, and writes the PART's `mel`, which a change stating only `on: 1`
  inherits through `groundSet`'s layer → part → change merge.
  - **The panel's `_sig` decides whether it rebuilds**, so a new reason for a control to appear must
    go INTO that signature — and nothing else may, since values are written in place (a value in
    there re-renders under the finger, the documented ± trap).
  - **The Changes panel lives in ⚙ Deep ▸ Fine-tune ▸ Repeats.** A probe that does not open the
    panel and select that tab measures every control in it at 0×0; and ⚙ Deep clones the layer when
    it opens, so state a test wants the draft to have must be set BEFORE it opens.
- **PLAY THE CHANGES SHIPS WITH EVERY DIE AT ZERO (2026-09-20/21, user: "Evolve is not rerollling
  this content" → "i thought hitting new take just spun up a new take indefinitely").** It is not
  that the material CANNOT roll — measured, distinct takes out of 6 on ⛰ Comp: bare **1**, Roam 6,
  ♪ Line set to Walk 6, Twist 6, Slip 6, Rests 5, Ghosts 4 — while Inversion, Len vary and Rhythm
  vary give **1** apiece and are therefore never named as a way out. Every message about this comes
  from ONE function (`noDiceSays`) so the drawing's readout and 🎲 New take's toast cannot drift.
  **When measuring which knobs roll a part, clear each one by hand between readings** — a preset
  does not reset what it does not state, so the first live die makes every later knob look live too
  (it did: the first run of that sweep reported 11 of 12 knobs as dice).
- **(the original entry) PLAY THE CHANGES HAS NO DICE OF ITS OWN (2026-09-20, user: "Evolve is not rerollling this
  content … also Show ahead doesn't seem to be working anymore").** Both reports and "Evolve only
  works when I turn Salt on" are ONE fact: a Groundwork part is deterministic — its chord tones come
  from the changes, its strike pattern is fixed — so every take is byte-identical (measured, takes
  0-3). ⟳ Evolve advances the take and nothing moves; ⟳ Show ahead draws the notes that DIFFER
  between takes, so it draws nothing; and Salt, which recolours per pass, was the only thing varying
  the part at all. **Its one rolled ingredient is a ♪ Line set to `walk`** — and the ♪ Line button
  defaults to `series`, a deterministic sweep, so the obvious path leaves it still frozen.
  The readout now says so outright when outlines are asked for and none exist. **An empty answer and
  a broken control look identical on screen; say which it is.**
- **`part.pitch.chordMode` STOPS A PART FOLLOWING THE CHANGES** (measured 2026-09-20, not yet
  fixed): with a voicing mode set and no `feel`, a Groundwork part plays the same four pitches over
  D, F♯m and G, where the same part with no chordMode follows each chord. `feel: 'stochastic'` does
  follow them. This is also why `sustain · Voicing` measures dead — one onset cannot show it.
- **A KNOB THAT MOVES NOTHING IS MEASURABLE — `test/probe-deepdead.js` (2026-09-20, user: "if the
  param creates no change for whatever reason, it should be disabled for that Material").** It sweeps
  every row ⚙ Deep SHOWS, per material, and asks the seam whether the notes moved: 32 of 132 are
  dead today, listed in the probe's `KNOWN` set as a burn-down. Three ways this measurement lied
  before it was right, all worth knowing before trusting a sweep like it:
  - **Sample SEVERAL passes.** Evolve advances the take every N passes, so a one-cycle sample called
    it dead on all five shapes.
  - **Do NOT pin the take.** `withTake(pinOf(S))` is what the drawing does to hold its picture still,
    and a pinned take is exactly what overrides Evolve's epoch — measured through the pin it reads
    dead while playback hears it change every pass.
  - **Sweep more than the extremes.** Evolve reads 0 as off and 64 as "every 64 passes", so both
    ends look identical over any sample short enough to run; it takes a small value to see it.
  - And the deadness is not one bug: the chord VOICING cluster needs a voicing in force, Salt's two
    rows need Salt re-voice on, Evolve needs a material with dice, and **`sustain · Voicing` looks
    like an ENGINE fault** — `_ambPickVoicing` returns a voicing for that layer when called directly
    and the notes still come out as the plain thirds stack. Greying that one would hide a bug.
- **THE STAGED DRAWING MUST SET THE CLOCKS IN BOTH BRANCHES (2026-09-21, user: "when I first open
  it, it shows one way, then when i press Preview, it changes to this").** Asking for the draft at
  `cycleStart: 0` is not enough: the GLOBAL progression anchors sit wherever the transport last left
  them, so the draft is resolved against a progression starting somewhere in its middle. ▶ Preview
  supplies its own clocks, so the picture jumps the moment it runs — and **the one you see first is
  the wrong one**. The previewing branch was fixed a day earlier and the idle branch was not; it now
  anchors to the cycle's own origin, which is what ▶ Preview plays and ✓ Done writes.
  **A test for this MUST set a non-zero anchor** — at 0 the two branches agree by accident, which is
  exactly how the earlier pass missed it. And judge the picture by distinct CHORD STACKS, not
  distinct pitches: a part on the wrong origin repeats one chord per bar while its line still
  wanders, so a pitch count finds plenty and proves nothing (measured — that check passed under
  poison until it counted stacks).
- **⚙ DEEP'S STAGED PICTURE IS A PIANO ROLL (2026-09-20, user: "this visualizer also needs grid
  lines and a piano roll on the left and note readouts").** It drew a bar grid and purple bars with
  no pitch reference, so a semitone and an octave looked alike. It is the card's roll at a smaller
  size now — same gutter, same black-key rows, a line per semitone with the C's stronger, note names
  where a row is ≥8px — because two pictures of one part that disagree about what a row means is
  worse than one picture.
  - **`PC_BLACK` was LOCAL to `drawPartViz`.** A second drawing needing it must hoist it to module
    scope, not copy it; a bare name from outside would have thrown into a surrounding catch and
    drawn nothing, with no error anywhere.
  - **`_pitchGeo` was published as `null` here**, and `paintSweep` reads it for the lit note and the
    vertical readout — so the staged preview silently had neither. A canvas that publishes the
    geometry gets both for free.
  - **The height lived in TWO places** (a hard-coded `hCss = 96` and a CSS `height: 96px`). The
    drawing reads `clientHeight` now; at 96 a 12-semitone window gives a 6.8px row, under what a
    label needs, so the readouts could never have drawn whatever the code said.
- **A SECTION HEADING MUST NAME ITS RULE, NOT PRAISE ITS CONTENTS (2026-09-20, user: "what does
  'The Knobs that Matter' mean, doesn't say anything descriptive of why they are grouped").** ⚙ Deep's
  step 2 was called that for months; it said nothing about membership and implied step 3 held knobs
  that do not. The rule was the SHAPE — every row there is gated to the material in force — so the
  bar states it: "Main knobs — the ones Play the changes uses", re-named per material and never
  blank. **When a group's caption cannot be written as a sentence about what is IN it, the grouping
  is the thing to check first.**
  - **`genSync` runs TWICE — from the gate pass with the LAYER, and from `stagePass` with the
    DRAFT** — and both write the same nodes, so while ⚙ Deep is open with a draft whose shape
    differs, these captions describe whichever call ran last. Pre-existing; measure a panel caption
    by opening the panel FRESH on each shape, not by editing with it open.
- **A HARMONY VOICE'S FOUR CONTROLS ARE CAPTIONED INDIVIDUALLY (2026-09-20, user: "these harmony
  controls need better informational labels and tooltips").** They were four unlabelled boxes with a
  positional key underneath (`motion · series · every · canon`), so reading the row meant counting
  along it. The caption goes ABOVE each control in its own flex cell (`.v2-harmcell`, reusing
  `.v2-mini-lab`'s type but NOT `.v2-mini`, whose stepper sizing would leave each stepper short of
  its cell) — that costs the grid no width, which is the only reason the row can be labelled at all:
  `.ambient-ctrl`'s 84px label column is spent on the interval name, and widening it is what crushed
  these four into a column once before.
  - **The sentence under the row was a FROZEN READOUT.** The four controls are plain `.v2-f` fields
    and that path does NOT rebuild the card (deliberately — a rebuild destroys the control under the
    finger), so the summary kept whatever was true at build time: set Motion to Contrary and it still
    read "oblique". Repainted in `genSync` now, from ONE definition (`harmSaysOf` / `harmSumOf`) used
    at build time too — and swept with `querySelectorAll`, because ⚙ Deep builds harmony TWICE.
  - **A GATE SPLICED IN WITH `.replace('data-v2when="…"', …)` REACHES ONE ROW.** A string pattern
    replaces the FIRST match only, and `harmRowHtml` returns the chips row before the voice rows —
    so ⚙ Deep's two harmony copies, built "with complementary gates — exactly one shows", in fact
    showed BOTH voice rows on every shape for as long as they existed. Reported as "why are the
    harmony params in two places". There is ONE copy now (Fine-tune ▸ Notes, with the rest of the
    "which notes" family) and no splice. **Count the rows that are ON SCREEN, per shape** — a check
    that counts call sites, or trusts a gate string, would have passed throughout.
- **PITCH · HARMONY · VOICING ARE ⚙ DEEP'S, AND ONLY DEEP'S (2026-09-20, user: "it seems like these
  3 param groups (Pitch/Harmony/Voicing) belong in Deep").** They already did — every field those ✦
  Generate tabs carried had a row in ⚙ Deep — so the sheet's tabs were a SECOND door and were
  deleted. **Before deleting a duplicate surface, measure per SHAPE which side offers what:** the
  gates had drifted apart, and the sheet uniquely offered Proximity on every live shape although
  only the `chance` branch of `pitchesBase` consumes it (measured: 0 vs 100 play identically on
  Groundwork, Arpeggio, Sustain and Mixed). A duplicate with a wider gate is not a richer door, it
  is a dead control. `test/probe-deepdup.js` is that measurement, kept as the guard that no field
  regains two homes.
  - **A deleted row takes its repaints with it.** `paint()` skips `.v2-genwrap` by design, so once
    the sheet copy went, `paint('part.pitch.kind', …)` had no readout left and `matHint` was dead —
    a writer with no reader, the inverse of the frozen-readout trap. Its sentence already had a
    better home in Deep's `.v2-recipesays`. The `max` repaint beside it has NO genwrap skip and
    still keeps Deep's Note ceiling honest — check each repaint separately.
- **A CHARACTER OVER A STRETCH (2026-09-20, user: "assigning subsets of bars (including fractional)
  to different characters, so having a content move through characters within a content").** No new
  path: a Character is resolved into a `part.ruleb` overlay and `composite` already plays one, so
  playback, the drawing, ⚙ Deep and capture need no change. Two things that are not obvious:
  - **Resolve it by BUILDING it, never by copying `pr.set`.** A Character is its stated fields plus
    whatever its SHAPE builds (Arp's speed, Sustain's single pulse) — `pr.set` alone is a fraction of
    it. `charOverlay` clones the layer into a scratch DRAFT, runs the real `applyPreset` on the
    clone, and diffs the three groups; the region Character is then the whole-part one by
    construction. Borrow-and-restore the `DRAFTS` slot — ⚙ Deep may already own it.
  - **`composite` rolls the overlay over the WHOLE cycle and keeps what lands inside the region.** So
    a Character counted per CYCLE rather than per bar has one onset, at the top, and every stretch
    but the first came out SILENT (measured: ▬ Sustain over the last half-bar of a 4-bar part → no
    notes). `charOverlay` raises a pulse count to `ceil(1/frac)` so the spacing fits inside the
    stretch. This is also why the overlay is built PER REGION, not once for a multi-region selection.
- **✎ WRITTEN IS A STATE, NOT A DOOR (2026-09-14, user: "i don't think 'by hand/written' and 'by
  rule/generated' are true alternatives").** They never were: one is the state a part is IN, the other
  an ACTION that fills it. **A new layer now starts EMPTY and WRITTEN** and makes no sound until you
  draw or generate. The Material row is one unlabelled group — `⚙ Generate · ✨ Auto · ⌫ Clear` — and
  the three options that hid behind ✎ Written each found a better home: **▦ Compose** in the row above
  the drawing (beside ⌗ Roll / ▦ Steps, and in BOTH forms' heads), **✎ Draw** in that row's mode
  picker, **⌫ Clear** beside the generators it undoes.
  - **THE NEW DEFAULT IS SET IN `addLayer`, NEVER IN `normLayer`.** `normLayer` still defaults an
    ABSENT `part.kind` to `'live'` and must: every saved project relies on it, and flipping the
    normalize default would SILENCE every layer that never stored one. Creation and shape are
    different questions. Verified: a legacy layer with no `kind` still resolves live and still sounds.
  - **`openComposeGrid` is the one session, two doors** — ▦ Compose and the take bar's grid option.
  - A fixture that wants a GENERATED part must now say so (`part.kind = 'live'`); relying on the
    default is what broke the sample check.
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
  - **✨ Quick and ⚙ Deep are STAGED (2026-09-16) — the layer proper never changes until ✓ Done.**
  Opening clones the layer (`V2.draftOpen` → `DRAFTS`); `layerOf` resolves ANY control inside
  `.v2-genwrap`/`.v2-autowrap` to the staged copy, so every handler is unchanged and simply writes it.
  The copy rides `normalizeAll` (`normStaged`). `V2.render` builds those two panels from the copy
  (transplanted from `cardHtml(S)`); `applyGate` gates the card from the layer (`GATE_SKIP_PANELS`) and
  the panels from the copy (`stagePass`); `genSync`/`autoSync`/`matSync` skip a staged card's panels.
  Anything that would touch the card or the transport with a staged layer must check `V2.isStaged`:
  `drawPartViz` redirects to the panel's own drawing (`stageVizDraw`), the knob mirror stays inside the
  panel, `commit`/`v2TakeHeard` leave playback alone. ✓ Done copies the copy INTO the layer in place;
  ✕ Cancel just drops it. A lookup by id into `cfg.layers` (e.g. `applyPresetFn`) must not bypass a
  staged `L`. Gate checks read `window.__Lv2(E)` (staged while open) or `__Lreal(E)` (the layer).
  Each footer's Cancel has its OWN class (`v2-gencancel`/`v2-autocancel`) — a shared one found the
  hidden panel's button first.
- **PRESET vs CHARACTER (label-only, 2026-09-16).** The five shape doors in ⚙ Deep (Sustain a chord ·
  Arpeggiate · Roll a line · Mix chords + notes · Play the changes) ARE the PRESETS — one per intention.
  A named value set inside one of them (Pad, Harp, Riff, Comp…) is its **Character**; the data keeps the
  first word I wrongly gave it (`part.preset`, `PRESETS`, `V2.applyPreset`, `.v2-presetpick`). Say
  Character on screen. The doors on the Method row read **✨ Quick** (was Auto) then **⚙ Deep** (was
  Generate); classes and `mat` keys unchanged. A section with ONE visible tab hides its strip.
- **A shape OWNS `L.ring` and `part.barsMode` — set on BOTH paths (fresh build and `matSwitch` restore).**
  Neither is in `MAT_KEYS`, so a value one shape sets LEAKS into the next: ▬ Sustain's Ring out made later
  chord shapes ring over their changes, and an arpeggio's `fill` made a Sustain re-strike when the bars grew.
  Sustain = ring, stretch · Groundwork = no ring, stretch · Arp / Mix / Roll / Melody = no ring, `fill`.
  Without the ring a one-onset chord is CUT at the part's second change and the rest is silence.
- **`toneSetAt(...).pool === true` means the set IS the chord's tones** (`stackOn` steps by 1 through it);
  `false` means a SCALE, where chord tones are every other degree. Reading it the other way round made
  Triad-only a silent no-op on every progression.
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
  - **♪ LINES ARE FIRST-CLASS AT BOTH RUNGS (2026-09-21):** `mel = {on?, rate?, kind?, oct?, len?,
    vel?, span?}` — `on` is stored BOTH ways (a change may refuse a line its part gives it, so `on: 0`
    is a statement and must never be pruned as falsy), every other field is absent-is-inherit. `span`
    has no constant of its own: absent, a line roams as far as the PART's `pitch.span`, so the shim
    the emitter builds must leave it alone rather than defaulting it. Door: ⚙ Deep ▸ Fine-tune ▸
    ♪ Lines (`v2-ft-accomp`) — it was the last row of "Repeats" until a whole second voice filed
    under "how a part repeats itself" was reported as hidden.
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
- **v2 GENERATION IS A PURE FUNCTION OF `cycIdx`** — every draw goes through `vRnd(seedBase ^ salt,
  lane)` and `seedBase` is `(L.id * 9176) ^ (cycIdx * 2246822519)`, nothing else. `cycIdx` appears in
  SIX places in the file and three of them are that seed. So a take is exactly reproducible, which is
  why `takeAsNotes` can bake by pinning the take and why ℹ Why? can EXPLAIN a take by reading the
  resolved settings instead of storing provenance per note. Adding an unseeded draw to the note-making
  path breaks all three at once — performance jitter (Humanize, Vel var) is unseeded ON PURPOSE and
  lives downstream in v1's `_ambApplyAdsr`, never here.
- **IF A SURFACE NAMES A RULE AS THE REASON, THAT RULE MUST BE REACHABLE.** The card greyed Rhythm /
  Pattern / Feel on a written take and said "plays these notes, not its rules", while ℹ Why? named
  those same rules as why the notes are where they are — and both cannot be true (user: "if they are
  defining the static content generation, the user should be able to access them"). They ARE: 🎲 New
  take re-rolls a written part IN PLACE, so its rules are DEFERRED, not dead, and the rule this file
  states is that a press which can act must act. `applyGate`'s `kind` resolves to BOTH `['live',
  'recorded']` for `made === 'take'` (the matcher already accepts a set), and `tabNa` MUST MIRROR IT —
  fixing only the rows leaves every parameter editable behind a door that will not open. Greying now
  means what it always claimed: no generated provenance. Same shape as the ▦ Steps carve-out one line
  above, which was this identical contradiction found earlier.
- **A "why" surface must name the CONTROL, report what actually came out, and LIST ONLY THE
  PARAMETERS THAT ACTUALLY RAN.** Restating the settings is a recipe, not an explanation: the counts
  measured off the notes are what let a reader see that Rests really did drop two of five pulses, and
  the control name is the only thing that makes the panel actionable. Scope it by the BRANCH THAT MADE
  THE MATERIAL (`onsetsOf`'s own test): cells for `steps`/`drawn`, so `pulses` and `rotate` are dead;
  `n` alone for `pulse`. **Listing a dead parameter is worse than listing none** — it reads as the
  reason. **But SCOPE BY BRANCH, NEVER BY WHETHER THE TAKE IS FROZEN.** `part.made === 'take'` says the
  APP generated the notes and stays true after ✎ Write it down, so `kind === 'recorded'` is NOT
  "nothing to explain" — reading it that way answered "the notes, as written" and threw away the whole
  feature ("these notes were GENERATED, it should show why… even if they are static"). Writing a take
  down changes whether the rules still MOVE the notes, not which rules explain them: keep every row
  and state the frozen-ness once. Poison-gated (`saysCount`, `namesKnobs`, `noStepsRows`,
  `wdKeepsRules`).
- **▦ STEPS *IS* ▦ PATTERN — one mode, and for a while two names.** Measured: `Roll + drawn` and
  `Steps + drawn` emit byte-identical notes, `onsetsOf` takes ONE branch for both
  (`kind === 'drawn' || form === 'steps'`), `rhythm.kind` is ignored entirely in Steps, and there are
  ZERO `form:steps` gates — the only `form:roll` gates exist to stop the same grid rendering twice.
  The form is now labelled ▦ Pattern (key still `steps`), which freed the word from the euclid rule —
  that is **Euclid** again, the word the app already uses in its own hints. Three names for two axes
  is what produced three separate "this says the wrong thing" reports in one day.
  **SETTLED 2026-09-15** (user: "it's confusing having both Rhythm → Euclid as well as Pattern in the
  same layer, they even contain different content"). They DID differ, mechanically: the tab's grid
  showed `euclidCells(pulses, steps, rotate)` — a COMPUTED preview over `r.steps` — while the body
  shows the STORED `r.cells` over bars×grid slots. **Two lengths, two sources, one label.** So:
  - **The preview is DELETED.** A generated rhythm is already drawn full-size in the picture below;
    a second small copy that disagrees with it is worse than none. The row survives ONLY for
    `rhythm:drawn`, where it is the sole ⌗ Roll editor of a grid the emitter plays, and it is labelled
    **Drawn steps** — ▦ Pattern is the FORM, and one word for two mechanisms is how a control is misread.
  - **`.v2-lanerow` STAYS, and the model question is answered the other way:** a kit is NOT
    Pattern-only. Lanes drive emission whatever the form (`p.rhythm.lanes` is read in the note-making
    path, ungated), so deleting the ⌗ Roll lane editor would leave a kit playing lanes with no editor
    anywhere. That was the second revert and it was RIGHT. Only the cell grid was ever the duplicate.
  - **Rhythm rolled into Method** — the rhythm kinds are modes of POPULATING a part, the same question
    ⚙ Generate · ✨ Auto · ⌫ Clear answer, so they are one tab. `TAB_TINT` lost its `Rhythm` entry with
    the tab, which also means `tabNa` can never grey Method — a tab holding the doors that undo a
    state must not refuse to open because of that state. The rows still grey via their own `kind:live`.
  - **A knob is reachable only where it DETERMINES the output.** Read `onsetsOf`'s branches, not the
    control list: pulse uses `r.n` ALONE and ignores `r.steps`, so Steps was dead on every Pulse layer
    and is now gated `rhythm:euclid,drawn,chance`. `vary` perturbs in the drawn and euclid branches only.
  - (1) TOUCH SIZE, the FIRST revert, stays fixed at the source: `stepBlocksHtml` chunks 8-per-row under
    540px — in JS, because halving `--eucols` in a media query wraps the cells and their note labels
    INDEPENDENTLY (the documented pairing bug) — and the body's cells carry a 34px min-height.
  - **TWO TIERS OF THE SAME KNOBS (2026-09-15, user: "now we have two tiers of controls for the
    Generated method"). Rolling a TAB away is not the same as rolling its ROWS somewhere else.** The
    first cut moved the rhythm rows into the Method tab, where all nine were DUPLICATES of ⚙ Generated
    panel controls writing the identical field — and four said a different word for it (`n` "How many"
    vs "Onsets", `pulses` "How many" vs "Pulses", `rotate` "Push" vs "Rotate", `voices` "Rows" vs
    "Voices"). **Before moving a row, grep the FIELD PATH, not the label** — `grep -ao "(L, 'part\.[a-z.]*'"`
    over the file lists every writer of every field in one pass and would have shown this in seconds.
    Method holds the DOORS; what is behind a door is that door's business. `.v2-microrow` is gone.
  - **The body's grid is the STRONGER one and always was:** it renders the per-step note row for EVERY
    pitch rule in ▦ Pattern (`pitched = pitch.kind === 'drawn' || form === 'steps'`) and marks steps
    carrying their own `stepFx`. The tab's copy showed notes for one pitch rule in nine. When two
    surfaces do one job, measure which is weaker before deciding which to keep.
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
- **DRAWING MUST NOT CONSUME `_ambRand`. `notesFor` IS the visualizer's query, so any shared-stream
  draw inside it makes REPAINTING change what is drawn.** Strum's order called v1's
  `_ambStrumOrder` — 118 writes to `_E.rng` per `notesFor` call — so the same take drew a different
  order each frame, playback pulled at its own point in that stream and disagreed with the picture,
  and a v2 layer shifted every OTHER layer's draws just by being looked at. Every v2 variance draw
  goes through `vRnd` keyed on (layer, cycle, onset); strum was the last path reaching across.
  **When adding anything to the generation path, check it with `_E.rng` before and after a draw** —
  a v1 helper that looks pure may pull from the stream two frames down.
- **▶ Preview's changes anchor at the CYCLE START (`t0 - off`), never at the press (`t0`).** The
  first note lands on the press, so the cycle begins `off` earlier — anchoring the changes at `t0`
  put chord 1 that far INTO the part while the stopped drawing aligns them with the part's own first
  pass, so **the picture jumped the first time you pressed Preview** and neither state matched the
  audio. Invisible when the first onset is on beat 1 (`off` is 0 and the two coincide), which is why
  a fixture for this must ROTATE its pattern so the first onset is late.
- **A PICTURE MUST BE DRAWN IN THE CLOCK ITS NOTES WERE MADE IN.** `previewLayer` pins
  `_progAnchor` / `_playStartAt` / `_barGridAnchor` to the press and restores them in its `finally`
  — synchronously, before a note has sounded — so every later draw resolved the SAME onsets against
  a different progression origin and showed the changes ROTATED (chord tones a third off, an octave
  once the span folds them), differently on every press because `t0` is `Tone.now()`. `PV_VIZ` now
  carries those three clocks and `drawPartViz` puts them back for the length of one draw
  (`withPvClocks`), around the notes AND the chord band — both, or the band names one alignment over
  notes resolved in another. **A single press proves nothing here:** it agrees whenever the press
  lands a whole number of chord spans from the fallback origin, so test it with a stale anchor parked
  a HALF-chord away.
- **TIGHT IS TWO THINGS, AND v2 ONLY HAD ONE.** v1 clamps the release (`_ambTightChoke`) AND sizes the
  note to the gap before the next onset (`_ambTightGap`, five call sites there). v2 applied only the
  release clamp, so notes kept their full length and went on overlapping while the control's own hint
  promised "cut each note short of the next". The clip lives at the ONE exit of the note generator
  (`notesFor` wraps `notesForRaw`), so the DRAWING shows it too — in the emit it would fix the ear and
  leave the picture lying, which is how the report was arrived at. It only ever SHORTENS, and the
  "next onset" is the next STRICTLY LATER one or a chord clips itself to nothing.
- **ONSET ≠ NOTE, and a readout that says only one of them reads as a contradiction.** An onset is a
  moment the layer strikes; a note is one sounding pitch, and one onset can spend several (`onsets ×
  notes-per-onset`, which is what `shapeOf` states). Count onsets from the per-note `oi` TAG, never
  from distinct times — Strum and Slip spread one onset's notes across the slot, so times report a
  strummed chord as three onsets. **`drawPartViz` rebuilds the note objects from a NAMED field list**,
  so any new per-note field is silently dropped there unless added — which is exactly where `oi` went
  missing first.
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

- **A stage that draws its own seed is a stage Evolve cannot govern.** `chg` (Evolve) reaches the
  material through `stageSeed(stage, slotKey)` — *which* stages change (`what`) and *how much* of each
  (`am`). Groundwork's ♪ Line read `seedBase` flat, so it was the one part of a layer that re-rolled
  whole at every setting: at How much 40% the chords kept 60% and the line kept none, and a change
  narrowed to rhythm still re-pitched it (measured: 15% held either way, i.e. the dial did nothing).
  Any new emitted voice must draw through `stageSeed`, and its SLOT KEY must be the note's POSITION in
  the cycle, never its index — an index shifts under a rate change and re-decides notes the change
  meant to keep. `stageSeed` returns `seedBase` unchanged with no `chg`, so the conversion is
  byte-identical for content that never evolves.
- **An inheritance panel must show the inherited number and store nothing.** The Groundwork overlay is
  absent-is-inherit at three rungs, so a row that WROTE the values it displays would pin a change to
  its part's settings the first time anyone opened the panel — silently cutting it off. The idiom:
  build with the RESOLVED value, let `mini` write only on a real edit, and re-`put()` the resolved
  value every sync pass. Skipping the re-put gives the other half of the bug — the part's line moves
  what plays while the change's row goes on showing the old number (a computed face with no second
  writer, frozen).
- **⚙ Deep is always STAGED, so `matSync` returns early and the card's own sync never runs on it.**
  The staged panel is synced by `stagePass → genSync(<.v2-genwrap>, S)`, and `genSync`'s own
  early-return tests `classList.contains('v2-layer')` — which the genwrap is not. A handler inside the
  panel must therefore end with `applyGate(ctx.card, L)`, not a bare `commit`, or nothing repaints.

- **A RULE ARRIVES WITH THE PREVIOUS RULE'S KNOBS, and that reads as a dead control.** Every
  rhythm/pitch kind reads companion fields (`pulse`→`n`, `euclid`→`steps`/`pulses`,
  `chance`→`chance`, `walk`/`series`→`span`, `chord`→`voices`, `mixed`→`mix`) that the MATERIAL
  tuned for the kind it replaced — so ⚠ Advanced: recipe measured as nine pitch options producing
  four outcomes, because `n: 1` gives one onset a cycle and one onset makes every pitch rule
  identical. `recipeSeed` lifts ONLY a field that would leave the new kind inert, and only on an
  explicit recipe edit. Any new kind needs a `RECIPE_NEEDS` entry or it inherits the same trap.
- **A seeded chance rhythm can legitimately roll a whole cycle silent** — ~1 in 60 at 40% over 8
  steps — and a take never re-rolls itself, so that one draw is the part for ever and is
  indistinguishable from a control that does nothing. Do not add a floor to the generator (a sparse
  chance pattern is SUPPOSED to be able to rest); SAY it, and name the way out (🎲 New take).

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

## Layer-schema evolution rules (Bloom)

Bloom is moving toward a **composable-layers** model (a layer = Voice × Note-source × Generator × Timing × Variation × Mix/FX; today's ~11 types become presets). **`docs/bloom-layer-model.md` is the AUTHORITATIVE spec** (6-axis spine: INSTRUMENT · KEY · SEED · TIMING · VARIANCE · FX/MIX) and its **§11 is the BACKLOG** — open items with their analysis, what was ruled out and how, so they can be picked up without re-deriving. `docs/bloom-composable-layers.md` is the older design + phased refactor plan; the two overlap and the layer-model doc wins on conflicts. Until those phases land, the invariants below govern any change to a Bloom layer's saved shape:

1. **`_normalizeAmbientCfg` is the ONE migration chokepoint.** Every load path (Drive, localStorage, `_cloneLane`, undo snapshots, Send-to-Bloom, Shape-It, area switch, play) funnels through it. Put migrations there, nowhere else.
2. **Each area cfg carries `schemaVersion`** (`_AMB_SCHEMA_VERSION` in `17-ambient.js`; legacy/pre-versioned = 0). A migration reads `_fromVer` at the top of normalize and gates on `_fromVer < N`; the stamp before `return cfg` records the current version so the migration runs **once** and re-normalizing is a no-op. Bump the constant + add a `//   vN — …` comment line ONLY when a layer's meaning/shape changes and needs a one-time migration.
3. **Additive-only; never repurpose a field.** Add new fields with defaults; don't change what an existing field means. An old build reading a new project must degrade safely (unknown fields normalized away).
4. **Backwards compatibility is an invariant, not a migration project.** A legacy layer with only `type` must keep producing byte-identical output. When Phase 2 adds `generator`/`voice`, they are *derived* from `type` on load and dispatch falls back to `type` — same core, same params.
5. **The invariant harness (`23-bloom-harness.js`) is the gate.** It hashes `[at,freq,durMs,voice,pan,level]` per note over seeded RNG/fixed ticks. Any schema change must keep it green; an intentional output change is a deliberate, reviewed baseline bump — never silent drift. Adding/removing an `_ambRand()` call on a covered path shifts every downstream draw, so keep RNG draws identical on default paths.
