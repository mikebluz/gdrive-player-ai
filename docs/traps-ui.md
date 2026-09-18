# UI traps — CSS, layout, DOM, controls, wiring, reachability

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before any change to CSS, layout, a control, or a handler.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

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
- **A popover's ✕ belongs in the CORNER, pinned, not in the flow.** As a flex item it sits wherever
  DOM order leaves it: the section head's summary follows it and takes the rest of the row, so at
  DESKTOP width the close measured 324px from the right edge — the middle of the header. Absolute
  `top/right` + `padding-right` on the head. **Scope the rule to the HEAD** — `.v2-genclose` and
  `.v2-autox` are each on TWO buttons (the corner ✕ and the footer's ✓ Done), and an unscoped rule
  tore Done out of the footer and stacked it on the corner. Caught by HIT-TEST, never by the rect.
  Invisible at 390px, where the summary wraps away — the documented single-viewport blind spot.
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
- **AN INDEX OVER THE CARD ONLY SEES WHAT SOMETHING STAMPED (2026-09-15).** 🔍 Find a control
  sweeps `[data-v2g]`, and `stampGroups` stamped only `.ambient-grp[data-v2grp] > .ambient-grp-body`
  children — so the ⚙ Generated panel, a CARD CHILD, had all ~40 of its rows outside the index from
  the day it was built. It went unnoticed because a DUPLICATE tier elsewhere carried the same
  vocabulary; deleting the duplicates made the whole generated-method vocabulary answer **"Nothing
  matches"** for controls sitting two presses away. **A search that denies a control exists is worse
  than one that cannot reach it** — it is a confident wrong answer, the same class as a readout with
  no second writer. When you add a surface that is not a group body, stamp it in the same change, and
  when you DELETE a duplicate, search the index for the vocabulary it was carrying.
  A ⚙ row's "tab" is the DOOR that opens it, and the hit NAVIGATES by pressing that door
  (`.v2-genbtn.click()`), never by setting the open-class itself — one opener, so the finder can never
  reach a surface by a route the card does not offer.
- **An index over LABELS cannot find a word no control shows.** After the consolidation "rotate",
  "pulses" and "onsets" return nothing because the ⚙ panel's words are Push and How many. That is
  correct for a label index and still a discoverability gap; a synonym table is the fix, not a second
  label. Note also that the panel calls BOTH `rhythm.pulses` and `rhythm.n` "How many", so the index
  legitimately shows two rows with one name — and **a check that asks by LABEL cannot tell those two
  apart; ask by FIELD.**
- **A card fold is a CLASS (`v2-so-<id>`) and a card rebuild dropped it** — ▸ Fine-tune holds Steps, whose
  commit rebuilds the card, so the fold shut under the finger. `V2.render` now carries `v2-so-*` across.
  Anything that lands on a row INSIDE a fold (🔍 Find) must press the fold's own button, or it marks a 0×0 row.
- **A duplicate class makes `querySelector` answer for the wrong surface.** The drawing is one of these:
  `.v2-vizcv` exists in BOTH the card body and the section sheet, and the first in DOM order can be
  the stale hidden copy nothing has redrawn — a probe reading it got the PREVIOUS draw and "the
  picture did not change" passed while it had. Pick the one with a real rect and an `offsetParent`
  (the reachability rule, applied to READING rather than to tapping). When adding a second
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
- **A "keep this?" question belongs on the press that DESTROYS the thing, not beside it.** 💾 Save this
  take stood next to 🎲 New take for months and was rarely pressed — nobody knows a take was worth
  keeping until it is about to go. It is now the first answer inside the gate 🎲 and the Bank's own
  load open (`keepGate`): Save · Discard · Close, where Close is the cancel. Two rules came with it:
  the gate is **SILENT when there is nothing to lose** (an empty part, a live one whose cycle comes out
  empty) or it trains people to dismiss dialogs; and **backing out of the name prompt cancels the whole
  press**, since rolling anyway destroys the very take they were trying to keep.
- **A popover action runs a tick AFTER its own dismiss, so the layer it was opened for is an orphan.**
  `_ambActionsPopover` defers `fn`, and counting a live take runs `getCfg` before that — pass a
  RE-RESOLVER (`querySelector('.v2-layer[data-v2id=…]')` → `layerOf`), never the captured `ctx.L`.
- **👁 VIEW / ✎ EDIT IS ONE GLOBAL AXIS, and the Parts strip is its face.** It was a picker on every
  layer card, so two cards could disagree about what the app was doing. `V2.viewMode()` /
  `V2.setViewMode()` own it; the per-layer picker keeps only the GESTURE axis (edit/draw/multi) and is
  rendered-and-disabled in View. **Anything that moves the axis must tell the strip**
  (`window._ambCurPartRefresh`) — ✎ Draw sets it from a card, and without the call the strip went on
  claiming View while every drawing had switched: a readout with no second writer.
- **A ROUNDING TIE IS NOT A REGRESSION.** A probe signature of `Math.round(t * 1000)` reported two
  byte-identical pictures as different because a note at t=0.9375 scales to 937.5 — exactly half-way,
  so a float ULP flips it. Quantize a probe's positions to a MUSICAL tick (960 is a whole multiple of
  every grid here), never to the millisecond. Read a one-unit diff on a single position as the metric
  before reading it as the code.
- **A `<select>` FIRES `input` BEFORE `change`, and a repaint in between eats the new value.** The FX
  stage picker set `POP.tab` on `change` — but the card's input sweep repaints the sheet first, which
  runs the picker's own follow-the-active-tab sync and puts the value BACK to the stage you were
  leaving. The handler fired, the context resolved, and `fp.value` read as the OLD stage: a press that
  did nothing. Take the FIRST event for anything that navigates.
- **`classList.remove('collapsed')` IS NOT EXPANDING A CARD.** The head's handler is what calls
  `popOpen`, so stripping the class gives an expanded-looking card with NO sheet and every section
  door missing — a probe doing it reported "no FX door" against working code. Drive the head.
- **A SUMMARY THAT PRINTS STORAGE KEYS INVENTS A SECOND VOCABULARY.** The FX head read `dist` for a
  layer with Drive engaged — a word appearing nowhere else on the card, so it cannot be looked up
  ("what does this dist readout mean"). Data keys stay forever for save-compat; every SURFACE says the
  control's own name (`FX_LABEL`, which must mirror the tab names — the tab is where a reader goes
  looking after seeing the summary).
- **A TAB PANE IS HIDDEN, NEVER REMOVED — so `querySelectorAll(sel).length` is true in every state.**
  A check written that way passes whatever the control does; three checks in one session measured
  PRESENCE where they meant VISIBILITY. Filter on `getComputedStyle(n).display !== 'none' &&
  n.offsetParent` — the same test the reachability rule uses.
- **A BUTTON THAT SITS OUTSIDE A PICKER READS AS A SWITCH, so it must switch OFF.** Chain was a tab
  rendered beside the FX dropdown; tabs do not un-select, and it was reported as "not toggling off".
  A second press goes back to what it was covering. Plain tabs INSIDE a list keep tab behaviour —
  there is nothing to go back to there.
- **A tap-to-cycle number is a bug**; so is a control that is absent in some states. **Render it and
  DISABLE it**, with the reason in the title — a conditionally-rendered control cannot be found,
  learned, or asked about. A press that cannot act should REFUSE AND EXPLAIN rather than do nothing.
- **A control is a mode, a status, or an action — never two.** On an on/off toggle put the FEATURE'S
  NAME on the face and the state in the fill; a label that exists only while the mode is active cannot
  be found by someone looking for the mode. **A ONE-WORD FACE IS READ AS THE CURRENT STATE, whatever
  glyph precedes it** — a two-stop switch showing only its DESTINATION ("⇄ ▦ Steps" while in Roll) was
  reported within the hour as "it says I'm in Steps when I'm clearly in Roll", and neither the ⇄ nor
  the unmistakable picture right beneath it beat the word. Carry BOTH names in the one button and put
  the state in the FILL. A check that the other mode's name APPEARS cannot see this — it passes the
  broken and the fixed face alike; assert which half is LIT, in both directions. **Carve-out: a DISCLOSURE toggle is attached to the thing
  it hides**, so the context is present either way — there the face names the ACTION (`Show`/`Hide`)
  and the title names what is shown.
- **A READOUT THAT NAMES ONE AXIS IS READ AS NAMING ALL OF THEM.** ℹ Why? listed the rhythm rule but
  never the FORM, so its `euclid` value — labelled "Pattern" — was taken as an answer about ⌗ Roll ⇄
  ▦ Steps ("Why still says it's a Pattern when it's a Roll"). Two axes on screen, one named. Name BOTH,
  in the other surface's exact words (`FORM_LABEL`), and check the glosses for a phrase that describes
  a DIFFERENT control — euclid's read "a grid you edit", which is the definition of ▦ Steps.
- **Divergent behaviour ⇒ divergent label; same state ⇒ same word.** Renames are LABEL-ONLY — data
  keys stay for save-compat. Before renaming, write the sentence out and make every surface use its
  words; when one axis has two vocabularies (state says X, button says Y) it reads as two mechanisms.
- **Prose is the first suspect.** A STATIC explanatory block never changes and never responds, so past
  the first read it is noise forever — the controls state the model better than a sentence about it.
  Before shortening, list every surface that states each fact: the cut is usually deciding which ONE
  surface owns it, not compression. Read the WHOLE open view — the head, the line and the drawing have
  repeatedly said the same number three times.
