    // ---- Wrap cycle ----
    // Toggled by clicking the "Wraps" bank label. When on, each grid
    // press uses the currently-armed bank wrap; once that press's sound
    // event ends (pointerup), the next wrap in the bank is armed — wrapping
    // back to the first after the last. Lets the user "play through" a row
    // of saved wraps one tap at a time.
    let wrapCycleMode = false;
    // Direction the cycle steps through the bank: +1 = right (forward),
    // -1 = left (backward). The Wraps menu's Cycle item walks off → right →
    // left → off.
    let wrapCycleDir = 1;
    // Index into savedWraps of the wrap currently armed for cycling.
    let wrapCycleIndex = 0;
    // Set on a grid press while cycling so the matching pointerup knows to
    // advance to the next wrap. Keeps the advance keyed to a real press
    // (not a stray pointerup) and ensures one advance per gesture.
    let _wrapCyclePendingAdvance = false;

    function seqName(index) {
      let name = '';
      let n = index;
      while (true) {
        name = String.fromCharCode(65 + (n % 26)) + name;
        if (n < 26) break;
        n = Math.floor(n / 26) - 1;
      }
      return name;
    }

    function persistSaved() {
      localStorage.setItem('sounds-saved', JSON.stringify(savedSequences));
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    function refreshClearBankBtn() {
      const btn = document.getElementById('clear-bank-btn');
      if (btn) btn.disabled = savedSequences.length === 0;
    }

    function renderSavedSequences() {
      const grid = document.getElementById('saved-grid');
      refreshClearBankBtn();
      // Keep the Seq-mode clip grid in sync when the bank changes.
      try { if (typeof _seqRefreshIfActive === 'function') _seqRefreshIfActive(); } catch (e) {}
      if (savedSequences.length === 0) {
        grid.innerHTML = '<span class="saved-empty">No saved sequences yet.</span>';
        return;
      }
      grid.innerHTML = '';
      savedSequences.forEach((saved, i) => {
        const isAudio = saved.type === 'audio';
        const block = document.createElement('div');
        block.className = 'saved-block'
          + (i === activeSeqIndex ? ' active-seq' : '')
          + (isAudio ? ' audio-item' : '');
        block.dataset.seqIndex = i;
        const countLabel = isAudio
          ? `audio · ${(saved.durationSec || 0).toFixed(1)}s`
          : `${(saved.steps || []).length} steps${saved.bpm ? ` · ${saved.bpm}` : ''}`;
        block.innerHTML = `
          <span class="saved-block-name">${saved.name}</span>
          <span class="saved-block-count">${countLabel}</span>
        `;
        block.addEventListener('click', () => {
          if (isAudio) {
            previewSavedAudio(saved);
            return;
          }
          // Per-saved-sequence FX: restore the captured globalFx if
          // present. applyGlobalFx() runs at the end of the load block
          // to push these into the master + per-lane FX nodes (lanes
          // that have already been wired) and the live-press send
          // gains. Older bank entries without globalFx leave the live
          // values untouched.
          if (saved.globalFx && typeof saved.globalFx === 'object') {
            Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => {
              if (k in saved.globalFx) globalFx[k] = saved.globalFx[k];
            });
          }
          if (saved.rootIdx != null)     rootIdx     = saved.rootIdx;
          if (saved.baseOctave != null)  baseOctave  = saved.baseOctave;
          if (saved.octaveCount != null) octaveCount = saved.octaveCount;
          if (saved.masterFreqA != null) masterFreqA = saved.masterFreqA;
          if (saved.scale)               currentScale = normalizeScaleName(saved.scale);
          if (saved.subdivision != null) stepSubdivision = saved.subdivision;
          if (saved.restColor)           { restColor = saved.restColor; applyRestColor(); }
          if (Array.isArray(saved.palette) && saved.palette.length === 12) {
            palette = [...saved.palette];
            chipPalette = [...palette];
          }
          // Grid layout — bank entries saved before this field land
          // here as undefined; fall back to the sensible defaults
          // instead of clamping a multi-lane sequence into 1 row.
          // For multi-lane saves we additionally snap rows to at
          // least the lane count so every lane is visible.
          if (Number.isFinite(saved.gridColumns)) {
            gridColumns = Math.max(1, Math.min(8, saved.gridColumns | 0));
          }
          if (Number.isFinite(saved.gridRows)) {
            gridRows = Math.max(1, Math.min(8, saved.gridRows | 0));
          } else if (Array.isArray(saved.lanes) && saved.lanes.length > 1) {
            gridRows = Math.max(gridRows, Math.min(8, saved.lanes.length));
          }
          const colsEl = document.getElementById('grid-cols-input');
          if (colsEl) colsEl.value = String(gridColumns);
          const rowsEl = document.getElementById('grid-rows-input');
          if (rowsEl) rowsEl.value = String(gridRows);

          const rootSel   = document.getElementById('root-select');
          const octRange  = document.getElementById('octave-range-select');
          const freqSl    = document.getElementById('master-freq-slider');
          const freqIn    = document.getElementById('master-freq-input');
          const scaleSel  = document.getElementById('scale-select');
          if (rootSel)   rootSel.value   = String(rootIdx);
          if (octRange)  octRange.value  = `${baseOctave}x${octaveCount}`;
          if (freqSl)    freqSl.value    = masterFreqA;
          if (freqIn)    freqIn.value    = masterFreqA;
          if (scaleSel)  scaleSel.value  = currentScale;
          const subSel = document.getElementById('subdivision-select');
          if (subSel)    subSel.value    = String(stepSubdivision);
          refreshHoldEnabled();

          rebuildGrid();

          if (Array.isArray(saved.cellSounds) && saved.cellSounds.length === cellSounds.length
              && Array.isArray(saved.cellParams) && saved.cellParams.length === cellParams.length) {
            cellSounds = [...saved.cellSounds];
            cellParams = saved.cellParams.map(p => ({ ...p }));
            cells.forEach((cell, idx) => {
              const sel = cell.querySelector('.cell-sound-select');
              if (sel) sel.value = cellSounds[idx];
            });
            refreshAllCellFreqLabels();
            updateScaleBanner();
          }

          if (saved.loopMode != null) {
            loopMode = !!saved.loopMode;
            document.getElementById('loop-btn').classList.toggle('active', loopMode);
          }

          // Deep-clone every step so the loaded sequence doesn't share
          // references with the bank entry (or with any other lane that
          // loaded the same saved sequence). Without this, editing a
          // step in one lane would silently mutate the matching step
          // in every other lane that ever loaded the same bank entry.
          //
          // Poly-aware load: when the saved entry carries a `lanes`
          // array (Poly-mode save), restore every lane plus active
          // index, then alias `sequence` to the active lane. Older
          // Mono-only entries (no `lanes` field) keep falling through
          // to the steps-only restore below so their behavior is
          // unchanged.
          if (Array.isArray(saved.lanes) && saved.lanes.length > 0) {
            if (typeof disposeAllLaneAudio === 'function') disposeAllLaneAudio(lanes);
            lanes = saved.lanes.map((l, li) => ({
              name: (typeof l?.name === 'string' && l.name) ? l.name : _laneName(li),
              steps: Array.isArray(l?.steps) ? l.steps.map(cloneStep) : [],
              muted: !!l?.muted,
              solo:  !!l?.solo,
              driftMs:        Number.isFinite(l?.driftMs)        ? l.driftMs        : 0,
              driftLocked:    !!l?.driftLocked,
              driftOffsetSec: Number.isFinite(l?.driftOffsetSec) ? l.driftOffsetSec : 0,
              pan:    Number.isFinite(l?.pan)    ? l.pan    : 0,
              volume: Number.isFinite(l?.volume) ? l.volume : 100,
              slip:   Number.isFinite(l?.slip)   ? l.slip   : 0,
              collapsed: !!l?.collapsed,
              fluidGridMode: !!l?.fluidGridMode,
              ambientMode: !!l?.ambientMode,
              ambient: (l?.ambient && typeof l.ambient === 'object') ? JSON.parse(JSON.stringify({ ...l.ambient, playing: false })) : null,
              textMode: !!l?.textMode,
              seqMode: !!l?.seqMode,
              text: (l?.text && typeof l.text === 'object') ? JSON.parse(JSON.stringify(l.text)) : null,
              // Restore per-lane FX wet levels. _migrateLaneSends handles
              // the three save-generations (new `sends`, mid-refactor
              // `fx`, none → default-seeded from globalFx). getLaneBus
              // will lazily build the FX nodes on first audio routing.
              sends: (typeof _migrateLaneSends === 'function')
                ? _migrateLaneSends(l)
                : (l?.sends ? { ...l.sends } : null),
            }));
            activeLaneIdx = Number.isFinite(saved.activeLaneIdx)
              ? Math.max(0, Math.min(saved.activeLaneIdx, lanes.length - 1))
              : 0;
            _aliasSequenceToActiveLane();
            if (typeof refreshPolyModeBtn === 'function') refreshPolyModeBtn();
            if (typeof _syncFluidGridToActiveLane === 'function') {
              try { _syncFluidGridToActiveLane(); } catch (e) {}
            }
          } else {
            sequence = saved.steps.map(cloneStep);
            // Mono-saved entry loaded into a Poly workspace: drop the
            // sequence into the active lane (the alias in renderSequence
            // would do this anyway, but doing it here keeps lanes[]
            // consistent before the render pass walks lane state).
            if (polyMode && lanes[activeLaneIdx]) {
              lanes[activeLaneIdx].steps = sequence;
            }
          }
          insertionPoint = null;
          if (saved.bpm) {
            tempoInput.value = saved.bpm;
            tempoSlider.value = saved.bpm;
          }
          activeSeqIndex = i;
          renderSequence();
          renderSavedSequences();
          // Push the just-restored globalFx into the audio graph. Runs
          // AFTER lanes are reconstructed so the lanes loop inside
          // applyGlobalFx can find them; lanes with already-built FX
          // nodes get their wet/shape pushed, lazy lanes inherit the
          // new state on first getLaneBus call. Persisted so the FX
          // shape sticks across reloads.
          if (saved.globalFx && typeof applyGlobalFx === 'function') {
            try { applyGlobalFx(); } catch (e) {}
            try { if (typeof persistGlobalFx === 'function') persistGlobalFx(); } catch (e) {}
          }
          document.getElementById('save-btn').disabled = false;
          // Capture the just-loaded state so a refresh doesn't revert
          // to the pre-load workspace. The bank already persisted
          // independently; this writes the workspace snapshot too.
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
        bindDrag(block, i);
        bindLongPress(block, i);
        grid.appendChild(block);
      });
      // Refresh the inline action bar after every bank render — its
      // contents key off activeSeqIndex + the current saved sequence,
      // both of which can change during the operations that trigger
      // a re-render (rename, duplicate, delete, load).
      if (typeof refreshSavedActionsBar === 'function') {
        try { refreshSavedActionsBar(); } catch (e) {}
      }
    }

    // ---- Wrap bank ----
    // Stores every committed Wrap (chord / stack / run) as a recallable
    // chip beside the Wrap button. Clicking a chip re-arms wrapTemplate
    // with a clone of the saved step so the user can swap shapes without
    // re-building them. Independent from savedSequences — different
    // shape, different cadence of creation, different lifecycle.
    function persistSavedWraps() {
      try { localStorage.setItem('wraps-saved', JSON.stringify(savedWraps)); }
      catch (e) {}
    }

    // Next unused single-letter name in A, B, C, … AA, AB, …
    // Mirrors seqName but skips any name already in the bank so deletes
    // don't make the visible labels regress.
    function wrapBankNextName() {
      const used = new Set(savedWraps.map(w => w.name));
      let n = 0;
      while (true) {
        let s = '', m = n;
        while (true) {
          s = String.fromCharCode(65 + (m % 26)) + s;
          if (m < 26) break;
          m = Math.floor(m / 26) - 1;
        }
        if (!used.has(s)) return s;
        n++;
      }
    }

    // Compact one-glance preview for a chip. Stack chords get dot-joined
    // note names; subsequence "run" gets the same ▤ glyph used elsewhere;
    // a unison wrap just gets its single label.
    function wrapBankChipLabel(step) {
      if (!step) return '·';
      if (step.isSub) return '▤';
      if (Array.isArray(step.chord)) {
        return step.chord.map(n => (n && n.label) || '·').join('·');
      }
      return step.label || '·';
    }

    // Wraps are tone-agnostic by default: they store only pitch + structure
    // and adopt the grid's current (master-lane) tone at play time. Strip any
    // per-note sound/params so a saved wrap can't pin a stale timbre — every
    // wrap then sounds with whatever tone the grid currently uses. EXCEPTION:
    // a leaf flagged `toneOverride` keeps its own sound/params (set via the
    // wrap step-editor), so master-tone changes leave it alone. keyContext
    // and all pitch/structure fields are always preserved.
    function _stripWrapTone(step) {
      if (!step) return step;
      // Wrap-level override tone lives on the top step. Keep it only while
      // its override is on; otherwise drop it so a disabled wrap tone can't
      // linger in storage.
      if (!step.wrapToneOverride) delete step.wrapToneParams;
      if (step.isSub && Array.isArray(step.subSteps)) {
        step.subSteps.forEach(_stripWrapTone);
      } else if (Array.isArray(step.chord)) {
        step.chord.forEach(v => { if (v && !v.toneOverride) { delete v.sound; delete v.params; } });
      } else if (!step.toneOverride) {
        delete step.sound;
        delete step.params;
      }
      return step;
    }

    // ---- Wrap banks (Standard / User) -----------------------------------
    // The chip row is a *view* over one of two banks. Standard is generated
    // on the fly from the live key/scale (the CHORDS catalog) and is recall-
    // only; User is the editable savedWraps. Standard chips carry a tone-
    // agnostic chord step so a recall arms wrapTemplate exactly like a saved
    // wrap (and a later grid press transposes it the same way).

    // Musical display order for the Standard chord-type palette (mirrors the
    // buildChordCatalog TYPES order, which Object.keys can't preserve).
    const _WRAP_STD_ORDER = [
      'maj', 'min', 'dim', 'aug', 'sus2', 'sus4',
      'maj7', '7', 'min7', 'dim7', 'm7b5', 'minMaj7',
      '6', 'm6', '6/9', 'add9', 'madd9',
      '9', 'maj9', 'min9', '7sus4', '7b9', '7#9', '7b5', '7#11',
      '11', 'min11', 'maj11', '13', 'maj13', 'min13',
    ];

    // Build a tone-agnostic chord wrap step from a pitch-class root + chord
    // quality, voiced in the grid's lowest-cell octave register. Mirrors
    // _progPlayBlock's voice math (so generated wraps sit in the same octave
    // as everything else) but omits sound/params — wraps adopt the grid tone.
    function _wrapChordStepFromBlock(chordRootPC, chordQuality) {
      const chordType = (typeof CHORDS !== 'undefined') && CHORDS[chordQuality];
      if (!chordType || !Array.isArray(chordType.semis) || !chordType.semis.length) return null;
      const baseFreq = (typeof notes !== 'undefined' && Array.isArray(notes) && notes[0]) ? notes[0].freq : 261.63;
      const rIdx = (typeof rootIdx === 'number') ? rootIdx : 0;
      const rootOffset = (((chordRootPC - rIdx) % 12) + 12) % 12;
      const rootFreq = baseFreq * Math.pow(2, rootOffset / 12);
      const voices = chordType.semis.map(semi => {
        const freq = rootFreq * Math.pow(2, semi / 12);
        const noteIdx = (((rIdx + rootOffset + semi) % 12) + 12) % 12;
        const label = (typeof CHROMATIC !== 'undefined') ? (CHROMATIC[noteIdx] || '') : '';
        return { freq, label, cellIndex: 0 };
      });
      if (!voices.length) return null;
      return {
        chord: voices,
        label: voices.map(v => v.label).join('·'),
        duration: 1,
        subdivision: (typeof stepSubdivision === 'number') ? stepSubdivision : 1,
      };
    }

    // The chip descriptors for the active bank. User chips carry `userId`
    // (a savedWraps id → editable); Standard chips carry only a render
    // `key`. `readOnly` gates the delete-× / publish affordances.
    function _wrapBankList() {
      if (wrapBank === 'user') {
        return {
          kind: 'user', readOnly: false,
          chips: savedWraps.map(w => ({
            key: w.id, userId: w.id, name: w.name,
            label: wrapBankChipLabel(w.step), step: w.step,
          })),
        };
      }
      // 'standard' (and any unknown value) → the full chord-type palette,
      // each quality rooted at the live key root. Iterate an explicit
      // musical order rather than Object.keys(CHORDS): integer-like quality
      // keys ('6','7','9','11','13') would otherwise hoist to the front of
      // the key list and scramble the palette. Any quality not in the list
      // is appended so a future CHORDS addition still shows up.
      const rIdx = (typeof rootIdx === 'number') ? rootIdx : 0;
      const rootName = (typeof CHROMATIC !== 'undefined') ? (CHROMATIC[rIdx] || '') : '';
      const chips = [];
      if (typeof CHORDS !== 'undefined') {
        const seen = new Set();
        const order = _WRAP_STD_ORDER.filter(q => CHORDS[q]);
        Object.keys(CHORDS).forEach(q => { if (order.indexOf(q) < 0) order.push(q); });
        order.forEach(q => {
          if (seen.has(q)) return;
          seen.add(q);
          const step = _wrapChordStepFromBlock(rIdx, q);
          if (!step) return;
          chips.push({ key: 'standard:' + q, name: q, label: (rootName + ' ' + (CHORDS[q].label || q)).trim(), step });
        });
      }
      return { kind: 'standard', readOnly: true, chips };
    }

    // Short bank name for the "Wraps" label.
    function _wrapBankLabel() {
      return (wrapBank === 'user') ? 'User' : 'Chords';
    }

    // Switch the visible bank. Generated banks are read-only palettes; the
    // active cycle (if any) re-anchors to the new bank's first chip.
    function setWrapBank(bankId) {
      if (wrapBank === bankId) return;
      wrapBank = bankId;
      wrapCycleIndex = 0;
      if (wrapCycleMode) {
        const chips = _wrapCycleChips();
        if (chips.length === 0) { wrapCycleMode = false; _wrapCyclePendingAdvance = false; }
        else armCycleWrap(0);
      }
      renderWrapBank();
      updateWrapCycleLabel();
    }

    // Recall a generated (read-only) chip: arm it as the live wrapTemplate
    // without touching savedWraps. Mirrors recallWrapFromBank's build-
    // teardown so a half-built wrap doesn't bleed into the armed shape.
    function recallGeneratedWrap(chip) {
      if (!chip || !chip.step) return;
      if (typeof snapshotForUndo === 'function') { try { snapshotForUndo('Recall wrap'); } catch (e) {} }
      chordMode = false;
      pendingChord = [];
      if (typeof clearWrapPendingHighlights === 'function') { try { clearWrapPendingHighlights(); } catch (e) {} }
      wrapTemplate = cloneStep(chip.step);
      activeWrapBankId = null;
      wrapGenActiveKey = chip.key;
      if (typeof refreshWrapVisuals === 'function') refreshWrapVisuals();
      renderWrapBank();
      if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
    }

    // Reset the live wrap arming to defaults — used when starting a fresh
    // context (e.g. a newly added lane). Clears the armed wrap and any half-
    // built chord, drops back to the default Chords bank view, and turns
    // cycling off. Leaves the saved User bank (savedWraps) intact.
    function resetWrapArming() {
      wrapTemplate = null;
      activeWrapBankId = null;
      wrapGenActiveKey = null;
      wrapBank = 'standard';
      pendingChord = [];
      chordMode = false;
      wrapCycleMode = false;
      _wrapCyclePendingAdvance = false;
      if (typeof clearWrapPendingHighlights === 'function') { try { clearWrapPendingHighlights(); } catch (e) {} }
      if (typeof refreshWrapVisuals === 'function') { try { refreshWrapVisuals(); } catch (e) {} }
      renderWrapBank();
      updateWrapCycleLabel();
    }

    function pushWrapToBank(step) {
      if (!step) return;
      const cloned = _stripWrapTone(cloneStep(step));
      // Stamp the current grid key onto the bank entry so the rebase
      // path later knows what key this wrap was built in. Doesn't
      // overwrite a step that already carries a keyContext (recalled
      // and re-saved wraps keep their original birthplace).
      if (cloned && !cloned.keyContext && typeof _captureKeyContext === 'function') {
        const kc = _captureKeyContext();
        if (kc) cloned.keyContext = kc;
      }
      const entry = {
        id: 'w-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: wrapBankNextName(),
        step: cloned,
        // Immutable origin — the wrap as it was first committed.
        // _renderWrapForKey always computes `step` FROM origin, never
        // from the previous `step`. So a wrap created in C major,
        // rebased through D# major, F minor, and back to chromatic
        // restores to the exact original notes — no compounding drift,
        // no information loss. keyContext stamps the key the wrap was
        // born in (or null for chromatic origin), which is what tells
        // the rebase path how to interpret the original notes.
        origin: {
          step: cloneStep(cloned),
          keyContext: (cloned && cloned.keyContext)
            ? { root: cloned.keyContext.root, scale: cloned.keyContext.scale }
            : null,
        },
      };
      savedWraps.push(entry);
      activeWrapBankId = entry.id;
      wrapGenActiveKey = null;
      // Building a wrap always lands in the User bank — and switches the
      // view there if a generated bank (Standard / a progression) was up,
      // so the new chip is immediately visible and armed.
      wrapBank = 'user';
      persistSavedWraps();
      renderWrapBank();
      updateWrapCycleLabel();
    }

    function recallWrapFromBank(id) {
      const entry = savedWraps.find(w => w.id === id);
      if (!entry) return;
      if (typeof snapshotForUndo === 'function') {
        try { snapshotForUndo('Recall wrap'); } catch (e) {}
      }
      // Exit any in-progress build so the recalled shape stays put —
      // otherwise the eventual Close click would overwrite wrapTemplate
      // with whatever the user was building when they tapped the chip.
      chordMode = false;
      pendingChord = [];
      if (typeof clearWrapPendingHighlights === 'function') {
        try { clearWrapPendingHighlights(); } catch (e) {}
      }
      wrapTemplate = cloneStep(entry.step);
      activeWrapBankId = entry.id;
      wrapGenActiveKey = null;
      // Keep the cycle cursor in sync when the user hand-picks a chip mid-
      // cycle, so the very next press continues from the chip they tapped.
      if (wrapCycleMode) {
        const idx = savedWraps.findIndex(w => w.id === id);
        if (idx >= 0) wrapCycleIndex = idx;
      }
      if (typeof refreshWrapVisuals === 'function') refreshWrapVisuals();
      renderWrapBank();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Persist the live wrapTemplate back into its bank entry. Wrap edits
    // (invert, Stack↔Run, the wrap step-editor) mutate wrapTemplate in
    // place; without this they'd vanish on the next recall because
    // savedWraps still held the pre-edit shape. After an explicit edit the
    // new shape IS the wrap, so both `step` and the rebase `origin` are
    // updated (and re-stamped with the current key). Tone is stripped —
    // wraps don't carry timbre. No-op when no bank entry is active.
    function syncActiveWrapToBank() {
      if (!activeWrapBankId || !wrapTemplate) return;
      const entry = savedWraps.find(w => w.id === activeWrapBankId);
      if (!entry) return;
      const cloned = _stripWrapTone(cloneStep(wrapTemplate));
      if (cloned && !cloned.keyContext && typeof _captureKeyContext === 'function') {
        const kc = _captureKeyContext();
        if (kc) cloned.keyContext = kc;
      }
      entry.step = cloned;
      entry.origin = {
        step: cloneStep(cloned),
        keyContext: (cloned && cloned.keyContext)
          ? { root: cloned.keyContext.root, scale: cloned.keyContext.scale }
          : null,
      };
      persistSavedWraps();
      renderWrapBank();
    }

    // Lightweight recall used by the cycle path — arms a bank wrap as the
    // live wrapTemplate without the undo snapshot / workspace persist that
    // recallWrapFromBank does (those would spam undo history and add work
    // on every tap). Mirrors recallWrapFromBank's build-teardown so a
    // half-built wrap doesn't bleed into the armed shape.
    // The chip list cycling walks — the *active* bank, so cycling steps
    // through whatever the user is viewing (Standard chords, a progression,
    // or their saved wraps).
    function _wrapCycleChips() { return _wrapBankList().chips; }

    function armCycleWrap(idx) {
      const chips = _wrapCycleChips();
      const chip = chips[idx];
      if (!chip) return;
      chordMode = false;
      pendingChord = [];
      if (typeof clearWrapPendingHighlights === 'function') {
        try { clearWrapPendingHighlights(); } catch (e) {}
      }
      wrapTemplate = cloneStep(chip.step);
      if (chip.userId) { activeWrapBankId = chip.userId; wrapGenActiveKey = null; }
      else { activeWrapBankId = null; wrapGenActiveKey = chip.key; }
      if (typeof refreshWrapVisuals === 'function') refreshWrapVisuals();
      renderWrapBank();
    }

    // Advance one step through the active bank in the active direction
    // (wrapping around either end). Called from the cell pointerup once a
    // cycling press's sound event is over.
    function advanceWrapCycle() {
      if (!wrapCycleMode) return;
      const chips = _wrapCycleChips();
      const len = chips.length;
      if (len === 0) return;
      wrapCycleIndex = ((wrapCycleIndex + wrapCycleDir) % len + len) % len;
      armCycleWrap(wrapCycleIndex);
    }

    // Reflect the cycle state on the "Wraps" menu label: lit while cycling,
    // with a directional arrow, plus a ▾ caret marking it as a menu.
    function updateWrapCycleLabel() {
      const label = document.getElementById('wrap-bank-label');
      if (!label) return;
      label.classList.toggle('cycling', wrapCycleMode);
      label.setAttribute('aria-expanded', _wrapsMenuEl ? 'true' : 'false');
      const arrow = wrapCycleMode ? (wrapCycleDir > 0 ? ' →' : ' ←') : '';
      // Stack the active bank name UNDER the "Wraps" title (two lines) so a
      // long progression name reads cleanly without widening the pinned-left
      // label and squeezing the side-scrolling chip strip.
      label.innerHTML =
        '<span class="wrap-bank-label-title">Wraps</span>' +
        '<span class="wrap-bank-label-bank">' + _wrapBankLabel() + arrow + ' ▾</span>';
    }

    function setWrapCycleMode(on) {
      // Nothing to cycle through with an empty bank — stay off.
      const chips = _wrapCycleChips();
      if (on && chips.length === 0) on = false;
      wrapCycleMode = !!on;
      _wrapCyclePendingAdvance = false;
      if (wrapCycleMode) {
        // Begin from the already-armed chip if there is one, else the first.
        let start = chips.findIndex(c => (c.userId && c.userId === activeWrapBankId)
          || (!c.userId && c.key === wrapGenActiveKey));
        if (start < 0) start = 0;
        wrapCycleIndex = start;
        armCycleWrap(wrapCycleIndex);
      }
      updateWrapCycleLabel();
    }

    // Cycle item state machine: off → right → left → off. Flipping the
    // direction keeps the cycle armed (no re-seed of the cursor); only the
    // off↔on transitions go through setWrapCycleMode.
    function advanceWrapCycleState() {
      if (_wrapCycleChips().length === 0) { setWrapCycleMode(false); return; }
      if (!wrapCycleMode) {
        wrapCycleDir = 1;
        setWrapCycleMode(true);          // off → right
      } else if (wrapCycleDir > 0) {
        wrapCycleDir = -1;               // right → left
        updateWrapCycleLabel();
      } else {
        setWrapCycleMode(false);         // left → off
      }
    }

    // Fisher-Yates shuffle of the bank. Names travel with their entries, so
    // the chip order visibly changes. Keeps the cycle cursor on the armed
    // wrap so a running cycle continues from where it was.
    function shuffleWrapBank() {
      if (savedWraps.length < 2) return;
      for (let i = savedWraps.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = savedWraps[i]; savedWraps[i] = savedWraps[j]; savedWraps[j] = tmp;
      }
      if (wrapCycleMode) {
        const idx = savedWraps.findIndex(w => w.id === activeWrapBankId);
        wrapCycleIndex = idx >= 0 ? idx : 0;
      }
      persistSavedWraps();
      renderWrapBank();
    }

    // Precise manual reorder of the bank. Opens a modal list where each
    // wrap can be dragged (desktop) or nudged with ▲/▼ (works everywhere,
    // incl. touch). Changes apply live so the chip row behind reflects each
    // move; Done just closes. Keeps the cycle cursor on the armed wrap.
    function openWrapReorder() {
      if (savedWraps.length < 2) return;
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay wrap-reorder-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal wrap-reorder-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      let dragId = null;
      const applied = () => {
        if (wrapCycleMode) {
          const idx = savedWraps.findIndex(w => w.id === activeWrapBankId);
          wrapCycleIndex = idx >= 0 ? idx : 0;
        }
        persistSavedWraps();
        renderWrapBank();
        render();
      };
      const move = (id, dir) => {
        const i = savedWraps.findIndex(w => w.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= savedWraps.length) return;
        const t = savedWraps[i]; savedWraps[i] = savedWraps[j]; savedWraps[j] = t;
        applied();
      };
      // Move `id` to just before `beforeId` (or to the end when null).
      const reinsert = (id, beforeId) => {
        if (id === beforeId) return;
        const from = savedWraps.findIndex(w => w.id === id);
        if (from < 0) return;
        const [item] = savedWraps.splice(from, 1);
        let to = (beforeId == null) ? savedWraps.length : savedWraps.findIndex(w => w.id === beforeId);
        if (to < 0) to = savedWraps.length;
        savedWraps.splice(to, 0, item);
        applied();
      };

      const render = () => {
        modal.innerHTML = `
          <div class="sm-title">Reorder wraps</div>
          <div class="wrap-reorder-hint">Drag a row, or use ▲ ▼ to move.</div>
          <div class="wrap-reorder-list" id="wrap-reorder-list"></div>
          <div class="sm-footer"><button type="button" class="sm-apply" id="wrap-reorder-done">Done</button></div>
        `;
        const list = modal.querySelector('#wrap-reorder-list');
        savedWraps.forEach((entry, i) => {
          const row = document.createElement('div');
          row.className = 'wrap-reorder-row';
          row.draggable = true;
          row.dataset.id = entry.id;
          row.innerHTML =
            `<span class="wrap-reorder-grip" aria-hidden="true">≡</span>` +
            `<span class="wrap-reorder-name">${entry.name}</span>` +
            `<span class="wrap-reorder-label">${wrapBankChipLabel(entry.step)}</span>` +
            `<span class="wrap-reorder-btns">` +
              `<button type="button" class="wrap-reorder-up"${i === 0 ? ' disabled' : ''} aria-label="Move up">▲</button>` +
              `<button type="button" class="wrap-reorder-dn"${i === savedWraps.length - 1 ? ' disabled' : ''} aria-label="Move down">▼</button>` +
            `</span>`;
          row.querySelector('.wrap-reorder-up').addEventListener('click', () => move(entry.id, -1));
          row.querySelector('.wrap-reorder-dn').addEventListener('click', () => move(entry.id, +1));
          row.addEventListener('dragstart', (e) => {
            dragId = entry.id; row.classList.add('dragging');
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', entry.id); } catch (_) {}
          });
          row.addEventListener('dragend', () => { dragId = null; });
          row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
          row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drop-target');
            if (dragId && dragId !== entry.id) reinsert(dragId, entry.id);
          });
          list.appendChild(row);
        });
        modal.querySelector('#wrap-reorder-done').addEventListener('click', () => overlay.remove());
      };
      render();
    }

    // Wipe the whole wrap bank after a confirm, tearing down any armed wrap
    // and cycle state so nothing dangles.
    function clearWrapBank() {
      if (savedWraps.length === 0) return;
      const n = savedWraps.length;
      if (!confirm(`Clear all ${n} saved wrap${n === 1 ? '' : 's'} from the bank? This can't be undone.`)) return;
      savedWraps.length = 0;
      activeWrapBankId = null;
      wrapTemplate = null;
      pendingChord = [];
      chordMode = false;
      wrapCycleMode = false;
      _wrapCyclePendingAdvance = false;
      if (typeof clearWrapPendingHighlights === 'function') { try { clearWrapPendingHighlights(); } catch (e) {} }
      if (typeof refreshWrapVisuals === 'function') { try { refreshWrapVisuals(); } catch (e) {} }
      if (typeof renderSequence === 'function') { try { renderSequence(); } catch (e) {} }
      persistSavedWraps();
      renderWrapBank();           // hides the bank + clears cycle label
      updateWrapCycleLabel();
      if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
    }

    // Convert one wrap step to Run (subsequence) or Stack (chord). Single-
    // note wraps are left untouched (neither form changes them). Carries the
    // wrap-level tone override + keyContext across so a bulk conversion
    // doesn't drop them. Mirrors toggleWrapRunStack's per-wrap logic.
    // The note list of a wrap step, whatever its shape — chord voices, sub
    // steps, a single note, or a SET's variance pool. Used to convert between
    // Stack / Run / Set uniformly.
    function _wrapNotesOf(step) {
      if (!step) return [];
      if (step.variance && Array.isArray(step.variance.notes)) return step.variance.notes;
      if (Array.isArray(step.chord)) return step.chord;
      if (step.isSub && Array.isArray(step.subSteps)) return step.subSteps;
      if (step.freq != null) return [step];
      return [];
    }
    function _wrapVoice(n) {
      return {
        freq: n.freq, label: n.label,
        cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
        sound: n.sound, params: n.params ? { ...n.params } : undefined,
      };
    }
    function _wrapStepToShape(step, shape) {
      if (!step) return step;
      const baseSub = (typeof stepSubdivision !== 'undefined') ? stepSubdivision : 1;
      const carryTop = (out) => {
        if (step.wrapToneOverride) out.wrapToneOverride = step.wrapToneOverride;
        if (step.wrapToneParams) out.wrapToneParams = { ...step.wrapToneParams };
        if (step.keyContext) out.keyContext = step.keyContext;
        return out;
      };
      const notes = _wrapNotesOf(step).filter(n => n && n.freq != null).map(_wrapVoice);
      if (!notes.length) return step;
      const sub = (step.subdivision != null) ? step.subdivision : baseSub;
      if (shape === 'set') {
        // SET: the notes become a per-step variance pool the step cycles
        // through across loop passes. Preserve any existing cycle settings.
        const ex = (step.variance && typeof step.variance === 'object') ? step.variance : {};
        return carryTop(Object.assign({}, notes[0], {
          duration: step.duration || 1, subdivision: sub,
          variance: {
            mode: ex.mode || 'linear',
            itersPerVariant: (Number.isFinite(ex.itersPerVariant) && ex.itersPerVariant > 0) ? ex.itersPerVariant : 1,
            randomEachIter: !!ex.randomEachIter,
            notes,
          },
        }));
      }
      if (shape === 'run') {
        if (step.isSub && !step.variance) return step;     // already a Run
        const subSteps = notes.map(n => ({ ...n, duration: 1, subdivision: sub }));
        return carryTop({ isSub: true, subSteps, label: '▤', duration: step.duration || 1, subdivision: 1 });
      }
      // stack
      if (Array.isArray(step.chord) && !step.variance) return step;       // already a Stack
      return carryTop({
        chord: notes,
        label: notes.map(n => n.label).join('·'),
        duration: step.duration || 1,
        subdivision: sub,
      });
    }

    // Bulk-convert every wrap in the bank to Run or Stack. Also rewrites each
    // entry's rebase origin so key changes keep the converted shape, and
    // re-syncs the live armed wrap.
    function convertAllWrapsTo(shape) {
      if (savedWraps.length === 0) return;
      savedWraps.forEach(entry => {
        entry.step = _wrapStepToShape(entry.step, shape);
        if (entry.origin && entry.origin.step) {
          entry.origin.step = _wrapStepToShape(entry.origin.step, shape);
        }
      });
      if (activeWrapBankId) {
        const e = savedWraps.find(w => w.id === activeWrapBankId);
        if (e) {
          wrapTemplate = cloneStep(e.step);
          if (typeof refreshWrapVisuals === 'function') refreshWrapVisuals();
        }
      }
      persistSavedWraps();
      renderWrapBank();
      if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
    }

    // ---- Wraps menu (expands from the "Wraps" label) ----
    // Cycle / Shuffle / Clear. Cycle updates in place (so its off→right→left
    // →off taps don't close the menu); Shuffle and Clear act and close.
    let _wrapsMenuEl = null;
    let _wrapsMenuOutside = null;
    function closeWrapsMenu() {
      if (_wrapsMenuOutside) {
        document.removeEventListener('pointerdown', _wrapsMenuOutside, true);
        document.removeEventListener('keydown', _wrapsMenuOutside, true);
        _wrapsMenuOutside = null;
      }
      if (_wrapsMenuEl) { _wrapsMenuEl.remove(); _wrapsMenuEl = null; }
      updateWrapCycleLabel();
    }
    function openWrapsMenu(anchorEl) {
      if (_wrapsMenuEl) { closeWrapsMenu(); return; }
      const menu = document.createElement('div');
      menu.className = 'ctx-menu wrap-bank-menu';

      // ---- Bank picker: Standard (generated chord-type palette) or User
      // (saved wraps). Selecting a bank swaps the dropdown's view; the
      // destructive items below always act on the User bank.
      const pickHead = document.createElement('div');
      pickHead.className = 'wrap-bank-menu-head';
      pickHead.textContent = 'Bank';
      menu.appendChild(pickHead);

      const picker = document.createElement('div');
      picker.className = 'wrap-bank-picker';
      const addBankBtn = (id, text) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wrap-bank-pick' + (wrapBank === id ? ' active' : '');
        b.textContent = text;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); setWrapBank(id); closeWrapsMenu(); });
        picker.appendChild(b);
        return b;
      };
      addBankBtn('standard', 'Chords');
      addBankBtn('user', 'User' + (savedWraps.length ? ` (${savedWraps.length})` : ''));
      menu.appendChild(picker);

      const sepHr = document.createElement('hr');
      menu.appendChild(sepHr);

      const cycleBtn = document.createElement('button');
      cycleBtn.type = 'button';
      const paintCycle = () => {
        cycleBtn.textContent = !wrapCycleMode
          ? 'Cycle: Off'
          : (wrapCycleDir > 0 ? 'Cycle: Right →' : 'Cycle: Left ←');
        cycleBtn.classList.toggle('active', wrapCycleMode);
      };
      paintCycle();
      cycleBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      cycleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        advanceWrapCycleState();   // off → right → left → off
        paintCycle();              // update in place; menu stays open
      });
      menu.appendChild(cycleBtn);

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.textContent = 'Run (all → sub)';
      if (savedWraps.length === 0) runBtn.disabled = true;
      runBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      runBtn.addEventListener('click', (e) => { e.stopPropagation(); convertAllWrapsTo('run'); closeWrapsMenu(); });
      menu.appendChild(runBtn);

      const stackBtn = document.createElement('button');
      stackBtn.type = 'button';
      stackBtn.textContent = 'Stack (all → chord)';
      if (savedWraps.length === 0) stackBtn.disabled = true;
      stackBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      stackBtn.addEventListener('click', (e) => { e.stopPropagation(); convertAllWrapsTo('stack'); closeWrapsMenu(); });
      menu.appendChild(stackBtn);

      const reorderBtn = document.createElement('button');
      reorderBtn.type = 'button';
      reorderBtn.textContent = 'Reorder…';
      if (savedWraps.length < 2) reorderBtn.disabled = true;
      reorderBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      reorderBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWrapsMenu(); openWrapReorder(); });
      menu.appendChild(reorderBtn);

      const shuffleBtn = document.createElement('button');
      shuffleBtn.type = 'button';
      shuffleBtn.textContent = 'Shuffle';
      if (savedWraps.length < 2) shuffleBtn.disabled = true;
      shuffleBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      shuffleBtn.addEventListener('click', (e) => { e.stopPropagation(); shuffleWrapBank(); closeWrapsMenu(); });
      menu.appendChild(shuffleBtn);

      // Publish the armed User wrap to the master Bloom's Notes menu — the
      // dropdown has no per-row right-click, so this lives here (enabled only
      // when a saved wrap is currently selected).
      const pubBtn = document.createElement('button');
      pubBtn.type = 'button';
      pubBtn.textContent = '🌸 Publish to Bloom';
      const _pubEntry = activeWrapBankId ? savedWraps.find(w => w.id === activeWrapBankId) : null;
      if (!_pubEntry) pubBtn.disabled = true;
      pubBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      pubBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeWrapsMenu();
        if (!_pubEntry) return;
        const ok = (typeof _ambPublishWrap === 'function') && _ambPublishWrap(_pubEntry.name, _pubEntry.step);
        if (typeof showToast === 'function') showToast(ok ? ('Published “' + _pubEntry.name + '” to Bloom Notes') : 'Could not publish this wrap');
      });
      menu.appendChild(pubBtn);

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear';
      clearBtn.classList.add('danger');
      if (savedWraps.length === 0) clearBtn.disabled = true;
      clearBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      clearBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWrapsMenu(); clearWrapBank(); });
      menu.appendChild(clearBtn);

      document.body.appendChild(menu);
      _wrapsMenuEl = menu;
      // Position under the label, clamped to the viewport.
      const r = anchorEl.getBoundingClientRect();
      const mw = menu.offsetWidth || 150;
      const mh = menu.offsetHeight || 120;
      const vw = window.innerWidth, vh = window.innerHeight;
      menu.style.left = Math.max(8, Math.min(r.left, vw - mw - 8)) + 'px';
      menu.style.top  = Math.min(r.bottom + 4, vh - mh - 8) + 'px';

      // Dismiss on outside pointerdown or Escape (capture phase so it beats
      // other handlers).
      _wrapsMenuOutside = (e) => {
        if (e.type === 'keydown') { if (e.key === 'Escape') closeWrapsMenu(); return; }
        if (!e.target.closest('.wrap-bank-menu') && e.target !== anchorEl) closeWrapsMenu();
      };
      document.addEventListener('pointerdown', _wrapsMenuOutside, true);
      document.addEventListener('keydown', _wrapsMenuOutside, true);
      updateWrapCycleLabel();
    }

    // Wire the "Wraps" label as the menu trigger (markup created above).
    (function bindWrapsMenuLabel() {
      const label = document.getElementById('wrap-bank-label');
      if (!label) return;
      label.addEventListener('click', (e) => { e.stopPropagation(); openWrapsMenu(label); });
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWrapsMenu(label); }
      });
      updateWrapCycleLabel();   // sets the initial "Wraps ▾" caret
    })();

    function removeWrapFromBank(id) {
      const i = savedWraps.findIndex(w => w.id === id);
      if (i < 0) return;
      const wasActive = (activeWrapBankId === id);
      savedWraps.splice(i, 1);
      // Keep the cycle cursor inside the (now shorter) bank.
      if (wrapCycleIndex >= savedWraps.length) wrapCycleIndex = 0;
      if (wasActive) {
        // The chip the user just deleted was the live wrap shape.
        // Tear down the in-flight wrap state too — clearing the
        // bank id alone would leave wrapTemplate / pendingChord
        // pointing at a wrap that no longer has a saved home,
        // which is the kind of "ghost" state that surprises later.
        activeWrapBankId = null;
        wrapTemplate = null;
        pendingChord = [];
        chordMode = false;
        if (typeof clearWrapPendingHighlights === 'function') {
          try { clearWrapPendingHighlights(); } catch (e) {}
        }
        if (typeof refreshWrapVisuals === 'function') {
          try { refreshWrapVisuals(); } catch (e) {}
        }
        if (typeof renderSequence === 'function') {
          try { renderSequence(); } catch (e) {}
        }
        if (typeof persistWorkspace === 'function') {
          try { persistWorkspace(); } catch (e) {}
        }
      }
      // Deleting the armed wrap mid-cycle would leave cycle mode on with
      // nothing armed — re-arm whatever now sits at the cursor so the next
      // press still plays a wrap.
      if (wrapCycleMode && wasActive && savedWraps.length > 0) {
        armCycleWrap(wrapCycleIndex);
      }
      persistSavedWraps();
      renderWrapBank();
    }

    // Human-readable option text for a wrap in the dropdown. User wraps keep
    // their bank letter (A, B…) as a prefix; generated chips read by their
    // chord label alone.
    function _wrapOptionText(chip) {
      if (chip.userId) {
        return (chip.label && chip.label !== '·') ? (chip.name + ' · ' + chip.label) : chip.name;
      }
      return chip.label || chip.name;
    }

    // Show the inline delete-× only on the editable User bank with a wrap
    // currently armed (there's nothing to delete on the generated banks, and
    // nothing selected to act on otherwise).
    function _refreshWrapDelBtn(kind) {
      const del = document.getElementById('wrap-bank-del');
      if (!del) return;
      del.hidden = !(kind === 'user' && activeWrapBankId);
    }

    function renderWrapBank() {
      const bank = document.getElementById('wrap-bank');
      const sel = document.getElementById('wrap-bank-select');
      if (!bank || !sel) return;
      const data = _wrapBankList();
      // The row is always visible: Standard / progression banks always have
      // entries, and even an empty User bank needs its label (the bank
      // picker) reachable to switch back to a populated bank.
      bank.hidden = false;
      sel.innerHTML = '';

      if (data.chips.length === 0) {
        // Only the (empty) User bank reaches here.
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = (data.kind === 'user')
          ? 'No saved wraps yet'
          : 'No chords for this bank';
        sel.appendChild(opt);
        sel.disabled = true;
        _refreshWrapDelBtn(data.kind);
        if (wrapCycleMode) { wrapCycleMode = false; _wrapCyclePendingAdvance = false; }
        updateWrapCycleLabel();
        return;
      }

      sel.disabled = false;
      // The currently-armed wrap (so the dropdown reflects recall AND cycle).
      const activeKey = activeWrapBankId
        ? (data.chips.find(c => c.userId === activeWrapBankId) || {}).key
        : wrapGenActiveKey;
      let matched = false;
      data.chips.forEach((entry) => {
        const opt = document.createElement('option');
        opt.value = entry.key;
        opt.textContent = _wrapOptionText(entry);
        if (entry.key === activeKey) { opt.selected = true; matched = true; }
        sel.appendChild(opt);
      });
      // Nothing armed in this bank yet — show a neutral placeholder rather
      // than implying the first wrap is selected.
      if (!matched) {
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = 'Pick a wrap…';
        ph.selected = true;
        sel.insertBefore(ph, sel.firstChild);
      }
      _refreshWrapDelBtn(data.kind);
      updateWrapCycleLabel();
    }

    // Recall whichever wrap the dropdown lands on. User wraps route through
    // recallWrapFromBank (highlights + persist); generated chips through
    // recallGeneratedWrap. Wired once — options rebuild under it each render.
    (function bindWrapBankSelect() {
      const sel = document.getElementById('wrap-bank-select');
      if (!sel) return;
      sel.addEventListener('change', () => {
        const key = sel.value;
        if (!key) return;
        const chip = _wrapBankList().chips.find(c => c.key === key);
        if (!chip) return;
        // Keep the cycle cursor in sync with a hand-pick, mirroring the old
        // chip-click behavior so the next cycle step continues from here.
        if (wrapCycleMode) {
          const idx = _wrapCycleChips().findIndex(c => c.key === key);
          if (idx >= 0) wrapCycleIndex = idx;
        }
        if (chip.userId) recallWrapFromBank(chip.userId);
        else recallGeneratedWrap(chip);
      });
      const del = document.getElementById('wrap-bank-del');
      if (del) {
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeWrapBankId) removeWrapFromBank(activeWrapBankId);
        });
      }
    })();

    // ---- Clear bank ----
    // Wipes every saved sequence after a confirm prompt. Also replaces
    // any track items that referenced a wiped sequence (by name) with
    // silent placeholders so multi-track playback doesn't crash on a
    // missing reference.
    document.getElementById('clear-bank-btn')?.addEventListener('click', () => {
      if (savedSequences.length === 0) return;
      const n = savedSequences.length;
      const ok = confirm(`Delete all ${n} saved sequence${n === 1 ? '' : 's'} from the bank? This can't be undone.`);
      if (!ok) return;
      try { stopSequence(); } catch (e) {}
      const names = new Set(savedSequences.map(s => s && s.name).filter(Boolean));
      savedSequences = [];
      const hadActive = activeSeqIndex !== null;
      activeSeqIndex = null;
      if (hadActive) {
        sequence = [];
        renderSequence();
        document.getElementById('save-btn').disabled = true;
      }
      if (names.size > 0 && typeof replaceMatchingTrackItemsWithSilent === 'function') {
        replaceMatchingTrackItemsWithSilent(names);
      }
      persistSaved();
      renderSavedSequences();
    });

    document.addEventListener('pointerdown', () => Tone.start(), { once: true });

    // Trim Tone's scheduling lookAhead from the 100 ms default to 25 ms.
    // Every Tone.now() returns currentTime + lookAhead, so an interactive
    // triggerAttack with no explicit time gets buffered that far ahead —
    // 100 ms is audible as lag on every tap, especially on mobile where
    // the OS audio path adds ~50–100 ms of inherent latency on top.
    // 25 ms still gives the audio thread a render quantum or two of
    // headroom but cuts ~75 ms off every interactive trigger. The
    // sequencer's own lookahead scheduler maintains its 100 ms
    // playback window separately, so this doesn't affect playback
    // smoothness. visualLookAheadMs() reads the current value, so the
    // chip/cell flash timing stays in sync with the new audio offset.
    try {
      if (typeof Tone !== 'undefined' && Tone.context) Tone.context.lookAhead = 0.025;
    } catch (e) {}

    const tempoSlider = document.getElementById('tempo-slider');
    const tempoInput  = document.getElementById('tempo-input');

    // BPM slider color: lerp between two polar-opposite hues (cyan ↔ red,
    // 180° apart on the colour wheel) so the slider feels cool when slow
    // and hot when fast.
    function updateBpmAccent() {
      // Anchor the colour gradient to the conventional musical range
      // (60..320) so widening the picker bounds doesn't shift where the
      // hot-red end lives. Values outside this range clamp to the edge
      // colour rather than rescale the whole spectrum.
      const accentMin = 60;
      const accentMax = 320;
      const v = parseInt(tempoSlider.value, 10) || accentMin;
      const t = Math.max(0, Math.min(1, (v - accentMin) / (accentMax - accentMin)));
      const hue = 188 * (1 - t); // 188° (cyan) at min → 0° (red) at max
      const color = `hsl(${hue.toFixed(0)}, 80%, 55%)`;
      tempoSlider.style.accentColor = color;
      tempoSlider.style.setProperty('--bpm-thumb', color);
      tempoInput.style.borderColor = color;
    }

    tempoSlider.addEventListener('input', () => {
      tempoInput.value = tempoSlider.value;
      updateBpmAccent();
      refreshBpmDigits();
      if (typeof _restartMetronomeIfActive === 'function') _restartMetronomeIfActive();
      persistWorkspace();
    });

    tempoInput.addEventListener('input', () => {
      const v = Math.min(999, Math.max(0, parseInt(tempoInput.value) || 0));
      tempoSlider.value = v;
      updateBpmAccent();
      refreshBpmDigits();
      if (typeof _restartMetronomeIfActive === 'function') _restartMetronomeIfActive();
      persistWorkspace();
    });

