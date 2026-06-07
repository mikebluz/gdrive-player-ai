    // ---- Wrap cycle ----
    // Toggled by clicking the "Wraps" bank label. When on, each grid
    // press uses the currently-armed bank wrap; once that press's sound
    // event ends (pointerup), the next wrap in the bank is armed — wrapping
    // back to the first after the last. Lets the user "play through" a row
    // of saved wraps one tap at a time.
    let wrapCycleMode = false;
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

    // Wraps are tone-agnostic: they store only pitch + structure and adopt
    // the grid's current (master-lane) tone at play time. Strip any per-note
    // sound/params so a saved wrap can't pin a stale timbre — every wrap
    // then sounds with whatever tone the grid currently uses. keyContext and
    // all pitch/structure fields are preserved.
    function _stripWrapTone(step) {
      if (!step) return step;
      if (step.isSub && Array.isArray(step.subSteps)) {
        step.subSteps.forEach(_stripWrapTone);
      } else if (Array.isArray(step.chord)) {
        step.chord.forEach(v => { if (v) { delete v.sound; delete v.params; } });
      } else {
        delete step.sound;
        delete step.params;
      }
      return step;
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
      persistSavedWraps();
      renderWrapBank();
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
    function armCycleWrap(idx) {
      const entry = savedWraps[idx];
      if (!entry) return;
      chordMode = false;
      pendingChord = [];
      if (typeof clearWrapPendingHighlights === 'function') {
        try { clearWrapPendingHighlights(); } catch (e) {}
      }
      wrapTemplate = cloneStep(entry.step);
      activeWrapBankId = entry.id;
      if (typeof refreshWrapVisuals === 'function') refreshWrapVisuals();
      renderWrapBank();
    }

    // Advance to the next wrap in the bank (wrapping to the first). Called
    // from the cell pointerup once a cycling press's sound event is over.
    function advanceWrapCycle() {
      if (!wrapCycleMode || savedWraps.length === 0) return;
      wrapCycleIndex = (wrapCycleIndex + 1) % savedWraps.length;
      armCycleWrap(wrapCycleIndex);
    }

    // Reflect the cycle state on the clickable "Wraps" label.
    function updateWrapCycleLabel() {
      const label = document.getElementById('wrap-bank-label');
      if (label) {
        label.classList.toggle('cycling', wrapCycleMode);
        label.setAttribute('aria-pressed', wrapCycleMode ? 'true' : 'false');
      }
    }

    function setWrapCycleMode(on) {
      // Nothing to cycle through with an empty bank — stay off.
      if (on && savedWraps.length === 0) on = false;
      wrapCycleMode = !!on;
      _wrapCyclePendingAdvance = false;
      if (wrapCycleMode) {
        // Begin from the already-armed wrap if there is one, else the first.
        let start = savedWraps.findIndex(w => w.id === activeWrapBankId);
        if (start < 0) start = 0;
        wrapCycleIndex = start;
        armCycleWrap(wrapCycleIndex);
      }
      updateWrapCycleLabel();
    }

    function toggleWrapCycleMode() { setWrapCycleMode(!wrapCycleMode); }

    // Wire the clickable "Wraps" label (created in the markup above).
    (function bindWrapCycleLabel() {
      const label = document.getElementById('wrap-bank-label');
      if (!label) return;
      label.addEventListener('click', toggleWrapCycleMode);
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleWrapCycleMode();
        }
      });
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

    function renderWrapBank() {
      const bank = document.getElementById('wrap-bank');
      const chips = document.getElementById('wrap-bank-chips');
      if (!bank || !chips) return;
      if (savedWraps.length === 0) {
        bank.hidden = true;
        chips.innerHTML = '';
        // No wraps left to cycle through — drop out of cycle mode so the
        // label doesn't stay lit over an empty bank.
        if (wrapCycleMode) {
          wrapCycleMode = false;
          _wrapCyclePendingAdvance = false;
          if (typeof updateWrapCycleLabel === 'function') updateWrapCycleLabel();
        }
        return;
      }
      bank.hidden = false;
      chips.innerHTML = '';
      savedWraps.forEach((entry) => {
        const chip = document.createElement('div');
        chip.className = 'wrap-bank-chip' + (entry.id === activeWrapBankId ? ' active' : '');
        const label = wrapBankChipLabel(entry.step);
        chip.title = `Recall wrap ${entry.name}: ${label}`;
        const recall = document.createElement('button');
        recall.type = 'button';
        recall.className = 'wrap-bank-chip-recall';
        recall.innerHTML =
          `<span class="wrap-bank-chip-name">${entry.name}</span>` +
          `<span class="wrap-bank-chip-label">${label}</span>`;
        recall.addEventListener('click', () => recallWrapFromBank(entry.id));
        chip.appendChild(recall);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'wrap-bank-chip-x';
        close.setAttribute('aria-label', `Delete wrap ${entry.name}`);
        close.title = `Delete wrap ${entry.name}`;
        close.textContent = '×';
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          removeWrapFromBank(entry.id);
        });
        chip.appendChild(close);
        chips.appendChild(chip);
      });
    }

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

