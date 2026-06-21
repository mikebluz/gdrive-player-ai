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
    // How many times the current cycle wrap has fired this dwell. Each wrap
    // carries a `repeats` (default 1); the cycle stays on it for that many
    // presses before stepping to the next. Reset on bank/cycle change.
    let _wrapCycleRepeat = 0;
    // Set on a grid press while cycling so the matching pointerup knows to
    // advance to the next wrap. Keeps the advance keyed to a real press
    // (not a stray pointerup) and ensures one advance per gesture.
    let _wrapCyclePendingAdvance = false;
    // ---- Prog-wrap walk state ----
    // When a Prog bank ('prog:<id>') is the active wrap bank, a grid press
    // doesn't transpose one armed chord — it WALKS the progression: chord
    // numerals are relative to a key, so the pressed note defines the key root
    // and each chord plays at that root + its degree offset (the chord's
    // semitone distance from the progression's first/I chord). The cursor
    // advances one chord per press (wrapping). Example, I-IV-V: press C → C
    // (I), press C → F (IV), press F → C (V of F).
    let _progWrapCursor = 0;
    let _progWrapPendingAdvance = false;
    function _progWrapActive() {
      return typeof wrapBank === 'string' && wrapBank.indexOf('prog:') === 0;
    }
    // The full published-progression library (Key-mode pad publishes one here;
    // Create Prog ▸ Standard publishes more). Walk banks resolve against this,
    // not the live-Key-only _wrapProgList(), so any published prog is playable.
    function _wrapAllProgs() {
      return (typeof masterAmbient !== 'undefined' && masterAmbient && Array.isArray(masterAmbient.publishedProgs))
        ? masterAmbient.publishedProgs : [];
    }
    function _progWrapChords() {
      if (!_progWrapActive()) return [];
      const pid = parseInt(wrapBank.slice(5), 10);
      const prog = _wrapAllProgs().find(p => (p.id | 0) === pid);
      return (prog && Array.isArray(prog.chords)) ? prog.chords : [];
    }
    function _progWrapAdvance() {
      const n = _progWrapChords().length;
      if (n > 0) _progWrapCursor = (_progWrapCursor + 1) % n;
      _progWrapHighlight();
    }
    // Light up the chord chip the walk cursor now points at (so the chip strip
    // tracks the progression as you press, like the User-bank cycle does).
    function _progWrapHighlight() {
      if (!_progWrapActive()) return;
      const n = _progWrapChords().length;
      if (!n) return;
      const pid = parseInt(wrapBank.slice(5), 10);
      wrapGenActiveKey = 'prog:' + pid + ':' + (_progWrapCursor % n);
      activeWrapBankId = null;
      if (typeof renderWrapBank === 'function') renderWrapBank();
    }
    // Build the play options for a Prog-wrap grid press on cellIdx: the current
    // cursor chord, re-rooted so the pressed note acts as the progression's key
    // root. Returns { wrapStep, targetFreq } for startSustainedWrapOnCell (which
    // chromatically transposes wrapStep's root onto targetFreq, preserving the
    // chord quality), or null when there's nothing to play.
    function _progWrapPressOpts(cellIdx) {
      const chords = _progWrapChords();
      if (!chords.length) return null;
      const note = (typeof notes !== 'undefined' && Array.isArray(notes)) ? notes[cellIdx] : null;
      if (!note || !(note.freq > 0)) return null;
      const cur = chords[_progWrapCursor % chords.length];
      if (!cur || !Array.isArray(cur.intervals) || !cur.intervals.length) return null;
      const refRoot = (((chords[0].root | 0) % 12) + 12) % 12;   // progression's I = reference
      const curRoot = (((cur.root | 0) % 12) + 12) % 12;
      const offset  = (((curRoot - refRoot) % 12) + 12) % 12;    // degree offset in semitones
      const step = (typeof _wrapChordStepFromProgChord === 'function') ? _wrapChordStepFromProgChord(cur) : null;
      if (!step || !Array.isArray(step.chord) || !step.chord[0] || !(step.chord[0].freq > 0)) return null;
      const targetFreq = note.freq * Math.pow(2, offset / 12);   // pressed note (key root) + degree
      return { wrapStep: step, targetFreq };
    }

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
    function persistWrapProgs() {
      try { localStorage.setItem('wraps-progs', JSON.stringify(wrapProgs)); }
      catch (e) {}
    }
    function _wrapUserProgList() {
      return Array.isArray(wrapProgs) ? wrapProgs : [];
    }
    // Delete a user Prog (a saved User-wrap subsequence) from the library.
    function _wrapDeleteUserProg(id) {
      if (!Array.isArray(wrapProgs)) return;
      const i = wrapProgs.findIndex(p => (p.id | 0) === (id | 0));
      if (i < 0) return;
      wrapProgs.splice(i, 1);
      try { persistWrapProgs(); } catch (e) {}
      if (typeof wrapBank === 'string' && wrapBank === 'userprog:' + (id | 0)) setWrapBank('user');
      if (typeof renderWrapBank === 'function') renderWrapBank();
    }
    // Delete a published Key/Standard progression (a walk-able 'prog:' bank).
    function _wrapDeleteKeyProg(id) {
      try { if (typeof _progOnBankEntryDeleted === 'function') _progOnBankEntryDeleted(id); } catch (e) {}
      if (typeof _progDeleteBankEntry === 'function') { _progDeleteBankEntry(id); return; }
      // Fallback if the Key-mode helper isn't present.
      const all = _wrapAllProgs();
      const i = all.findIndex(p => (p.id | 0) === (id | 0));
      if (i >= 0) all.splice(i, 1);
      if (typeof wrapBank === 'string' && wrapBank === 'prog:' + (id | 0)) setWrapBank('user');
      if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
      if (typeof renderWrapBank === 'function') renderWrapBank();
    }
    // Every selectable "wrap sequence" for the Generate dialog's Wraps mode:
    // the User bank, each Key progression, and each user Prog bank. Each entry
    // is { key, label, items:[{name, step}] } — items are ordered wrap STEPS to
    // distribute across a generated sequence.
    function _wrapSequenceOptions() {
      const out = [];
      if (Array.isArray(savedWraps) && savedWraps.length) {
        out.push({ key: 'user', label: 'User (' + savedWraps.length + ')',
          items: savedWraps.map(w => ({ name: w.name, step: w.step })) });
      }
      // (Key progressions are no longer mirrored into the wrap sequences — use
      // Create Prog with a Standard progression or User wraps instead.)
      _wrapUserProgList().forEach(p => {
        if (!p || !Array.isArray(p.items) || !p.items.length) return;
        const items = p.items.map(it => ({ name: it.name, step: it.step })).filter(it => it.step);
        if (items.length) out.push({ key: 'userprog:' + (p.id | 0), label: 'Prog · ' + (p.name || ('Prog ' + (p.id | 0))), items });
      });
      return out;
    }
    // Autosuggest an adjective-noun name (e.g. "Velvet Comet") for a new Prog.
    const _WRAP_ADJ = ['Velvet', 'Crimson', 'Lunar', 'Golden', 'Hidden', 'Electric', 'Quiet', 'Wild',
      'Frosted', 'Amber', 'Drifting', 'Neon', 'Silken', 'Distant', 'Cosmic', 'Hollow',
      'Brave', 'Dusty', 'Misty', 'Royal', 'Restless', 'Mellow', 'Faded', 'Glassy'];
    const _WRAP_NOUN = ['Comet', 'River', 'Ember', 'Garden', 'Echo', 'Harbor', 'Meadow', 'Falcon',
      'Lantern', 'Canyon', 'Tide', 'Forest', 'Sparrow', 'Glacier', 'Orchid', 'Voyage',
      'Drift', 'Signal', 'Meridian', 'Willow', 'Aurora', 'Cascade', 'Pulse', 'Horizon'];
    function _randAdjNoun() {
      const a = _WRAP_ADJ[Math.floor(Math.random() * _WRAP_ADJ.length)];
      const n = _WRAP_NOUN[Math.floor(Math.random() * _WRAP_NOUN.length)];
      return a + ' ' + n;
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
    // Published progressions (the "Prog bank") — the shared library the master
    // Bloom + Shape Prog pickers read from. Each entry is { id, name, chords:[
    // {root, intervals}] }.
    function _wrapProgList() {
      const all = (typeof masterAmbient !== 'undefined' && masterAmbient && Array.isArray(masterAmbient.publishedProgs))
        ? masterAmbient.publishedProgs : [];
      // The Key wrap list mirrors the LIVE Key-mode pad: show only the
      // progression currently on the pad (tracked by Key mode), so the list is
      // empty whenever Key mode is empty. (Bloom/Shape still read the full
      // publishedProgs library directly.)
      let liveId = null;
      try { if (typeof _progCurrentBankId === 'function') liveId = _progCurrentBankId(); } catch (e) {}
      if (liveId == null) return [];
      return all.filter(p => (p.id | 0) === (liveId | 0));
    }
    // (Prog deletion from the Wraps menu was removed — the ✕ was easy to
    // mis-tap when selecting. Manage the Prog bank from Prog mode instead.)
    // Build a chord wrap step from one progression chord { root, intervals }.
    // Mirrors _wrapChordStepFromBlock but voices the stored interval set
    // directly (progression chords are equal-tempered pitch-class sets).
    function _wrapChordStepFromProgChord(chord) {
      if (!chord || !Array.isArray(chord.intervals) || !chord.intervals.length) return null;
      const baseFreq = (typeof notes !== 'undefined' && Array.isArray(notes) && notes[0]) ? notes[0].freq : 261.63;
      const rIdx = (typeof rootIdx === 'number') ? rootIdx : 0;
      const chordRootPC = (((chord.root | 0) % 12) + 12) % 12;
      const rootOffset = (((chordRootPC - rIdx) % 12) + 12) % 12;
      const rootFreq = baseFreq * Math.pow(2, rootOffset / 12);
      const voices = chord.intervals.map(semi => {
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
    // Human chord name for a progression chord (root + best-effort quality
    // matched against CHORDS by mod-12 interval set; falls back to the root).
    function _wrapProgChordName(chord) {
      const rootName = (typeof CHROMATIC !== 'undefined') ? (CHROMATIC[(chord.root | 0) % 12] || '') : '';
      const iv = Array.from(new Set((chord.intervals || []).map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b).join(',');
      let qual = '';
      if (typeof CHORDS !== 'undefined' && iv) {
        for (const q of Object.keys(CHORDS)) {
          const def = CHORDS[q]; if (!def || !Array.isArray(def.semis)) continue;
          const s = Array.from(new Set(def.semis.map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b).join(',');
          if (s === iv) { qual = def.label || q; break; }
        }
      }
      return (rootName + (qual ? ' ' + qual : '')).trim() || rootName || '?';
    }
    // Quality-ONLY name for a progression chord (key/root stripped) — the
    // structural quality matched against CHORDS, title-cased: maj→Maj,
    // min→Min, maj9→Maj9. So Cmaj/Gmaj/Amin/Emaj9 reads as Maj/Maj/Min/Maj9.
    function _wrapProgChordQuality(chord) {
      const iv = Array.from(new Set((chord.intervals || []).map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b).join(',');
      if (typeof CHORDS !== 'undefined' && iv) {
        for (const q of Object.keys(CHORDS)) {
          const def = CHORDS[q]; if (!def || !Array.isArray(def.semis)) continue;
          const s = Array.from(new Set(def.semis.map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b).join(',');
          if (s === iv) return q.charAt(0).toUpperCase() + q.slice(1);
        }
      }
      return '?';
    }
    // The structural (key-stripped) name for a whole progression: its chord
    // qualities joined, e.g. "Maj/Maj/Min/Maj9".
    function _wrapProgStructLabel(prog) {
      const chords = (prog && Array.isArray(prog.chords)) ? prog.chords : [];
      if (!chords.length) return prog && prog.name ? prog.name : 'Prog';
      return chords.map(_wrapProgChordQuality).join('/');
    }
    function _wrapBankList() {
      // Progression bank: wrapBank === 'prog:<id>'. Each chord in the published
      // progression becomes a read-only chip (armed via recallGeneratedWrap,
      // cycled like the Chords palette). Falls through to Chords if the prog is
      // gone (deleted while selected).
      if (typeof wrapBank === 'string' && wrapBank.indexOf('prog:') === 0) {
        const pid = parseInt(wrapBank.slice(5), 10);
        const prog = _wrapAllProgs().find(p => (p.id | 0) === pid);
        if (prog && Array.isArray(prog.chords) && prog.chords.length) {
          const chips = [];
          prog.chords.forEach((c, i) => {
            const step = _wrapChordStepFromProgChord(c);
            if (!step) return;
            // Key-stripped: chips show only the structural quality (Maj/Min/…),
            // not the rooted chord name.
            const nm = _wrapProgChordQuality(c);
            chips.push({ key: 'prog:' + pid + ':' + i, name: nm, label: (i + 1) + '. ' + nm, step });
          });
          if (chips.length) return { kind: 'prog', readOnly: true, chips };
        }
      }
      // User Prog bank: wrapBank === 'userprog:<id>'. A named subsequence of
      // User wraps saved as its own read-only, cyclable bank.
      if (typeof wrapBank === 'string' && wrapBank.indexOf('userprog:') === 0) {
        const uid = parseInt(wrapBank.slice(9), 10);
        const up = _wrapUserProgList().find(p => (p.id | 0) === uid);
        if (up && Array.isArray(up.items) && up.items.length) {
          const chips = [];
          up.items.forEach((it, i) => {
            if (!it || !it.step) return;
            chips.push({ key: 'userprog:' + uid + ':' + i, name: it.name || ('#' + (i + 1)),
              label: (i + 1) + '. ' + wrapBankChipLabel(it.step), step: it.step });
          });
          if (chips.length) return { kind: 'userprog', readOnly: true, chips };
        }
      }
      if (wrapBank === 'user') {
        return {
          kind: 'user', readOnly: false,
          chips: savedWraps.map(w => ({
            key: w.id, userId: w.id, name: w.name,
            label: wrapBankChipLabel(w.step), step: w.step,
            repeats: (w.repeats > 0) ? (w.repeats | 0) : 1,
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
      if (typeof wrapBank === 'string' && wrapBank.indexOf('userprog:') === 0) {
        const uid = parseInt(wrapBank.slice(9), 10);
        const up = _wrapUserProgList().find(p => (p.id | 0) === uid);
        if (up) return up.name || ('Prog ' + uid);
      }
      if (typeof wrapBank === 'string' && wrapBank.indexOf('prog:') === 0) {
        const pid = parseInt(wrapBank.slice(5), 10);
        const prog = _wrapProgList().find(p => (p.id | 0) === pid);
        if (prog) return _wrapProgStructLabel(prog);
      }
      return 'User';
    }

    // Switch the visible bank. Generated banks are read-only palettes; the
    // active cycle (if any) re-anchors to the new bank's first chip.
    function setWrapBank(bankId) {
      if (wrapBank === bankId) return;
      wrapBank = bankId;
      wrapCycleIndex = 0;
      _wrapCycleRepeat = 0;
      _progWrapCursor = 0;           // restart any Prog-wrap walk at the first chord
      _progWrapPendingAdvance = false;
      // Prog bank → highlight the first chord chip (the walk's starting point).
      if (typeof wrapBank === 'string' && wrapBank.indexOf('prog:') === 0) {
        wrapGenActiveKey = wrapBank + ':0'; activeWrapBankId = null;
      }
      if (wrapCycleMode) {
        const chips = _wrapCycleChips();
        if (chips.length === 0) { wrapCycleMode = false; _wrapCyclePendingAdvance = false; }
        else armCycleWrap(0);
      }
      renderWrapBank();
      updateWrapCycleLabel();
    }

    // Select a sequential read-only bank (a Key progression or a user Prog)
    // from the Wraps menu: switch to it, arm its first chip, and turn on Cycle
    // so consecutive grid presses walk through it. Shared by both sections.
    function _wrapSelectSequentialBank(id, name) {
      setWrapBank(id);
      try {
        if (typeof setWrapCycleMode === 'function') setWrapCycleMode(true);
        else {
          const chips = _wrapBankList().chips;
          if (chips[0] && typeof recallGeneratedWrap === 'function') recallGeneratedWrap(chips[0]);
        }
      } catch (err) {}
      closeWrapsMenu();
      if (typeof showToast === 'function') showToast('Loaded “' + name + '” — cycling its wraps');
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
      // Prog bank: clicking a chord chip sets the walk's start point so the
      // next grid press begins from that chord.
      { const m = /^prog:\d+:(\d+)$/.exec(chip.key || ''); if (m) _progWrapCursor = parseInt(m[1], 10) || 0; }
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
      wrapBank = 'user';
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
      // Per-wrap repeats: dwell on the current wrap for `repeats` presses before
      // stepping to the next one.
      const cur = chips[((wrapCycleIndex % len) + len) % len];
      const reps = (cur && cur.repeats > 0) ? (cur.repeats | 0) : 1;
      _wrapCycleRepeat += 1;
      if (_wrapCycleRepeat < reps) return;   // stay on this wrap for another press
      _wrapCycleRepeat = 0;
      wrapCycleIndex = ((wrapCycleIndex + wrapCycleDir) % len + len) % len;
      armCycleWrap(wrapCycleIndex);
    }

    // Reflect the cycle state on the "Wraps" menu label: lit while cycling,
    // with a directional arrow, plus a ▾ caret marking it as a menu.
    function updateWrapCycleLabel() {
      const label = document.getElementById('wrap-bank-label');
      if (!label) return;
      label.classList.toggle('cycling', wrapCycleMode);
      // Direction-specific classes so Cycle-Right and Cycle-Left highlight in
      // different colors.
      label.classList.toggle('cycle-right', wrapCycleMode && wrapCycleDir > 0);
      label.classList.toggle('cycle-left',  wrapCycleMode && wrapCycleDir < 0);
      label.setAttribute('aria-expanded', _wrapsMenuEl ? 'true' : 'false');
      const arrow = wrapCycleMode ? (wrapCycleDir > 0 ? ' →' : ' ←') : '';
      // Just "Wraps ▾" — the active bank name is no longer shown inline (open
      // the menu to see / switch banks), keeping the pinned-left label compact.
      label.innerHTML =
        '<span class="wrap-bank-label-title">Wraps' + arrow + ' ▾</span>';
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

    // "Create Prog…" — build a named, recallable Prog bank from EITHER a
    // Standard progression (filtered by the Grid Scale) OR an ordered
    // subsequence of the User wrap bank. Name autosuggests an adjective-noun.
    function openCreateProgDialog() {
      // Standard progressions for the current GRID scale (aeolian→minor, etc.).
      const gScale = (typeof currentScale === 'string') ? currentScale : 'major';
      const gRoot = (typeof rootIdx === 'number') ? rootIdx : 0;
      const standards = (typeof _progStandardsForScale === 'function') ? _progStandardsForScale(gScale, gRoot) : [];
      if (!savedWraps.length && !standards.length) {
        if (typeof showToast === 'function') showToast('Save some wraps, or pick a scale with standard progressions');
        return;
      }
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay create-prog-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal create-prog-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const scaleLabel = (typeof prettyScaleName === 'function') ? prettyScaleName(gScale) : gScale;
      const stdOptions = '<option value="">— None (pick wraps below) —</option>' +
        standards.map((s, i) => `<option value="${i}">${(s.name || ('Prog ' + (i + 1))).replace(/[<>&"]/g, '')}</option>`).join('');
      const rows = savedWraps.map((w, i) =>
        `<label class="create-prog-row">` +
          `<input type="checkbox" class="create-prog-cb" data-idx="${i}" />` +
          `<span class="create-prog-name">${w.name}</span>` +
          `<span class="create-prog-label">${wrapBankChipLabel(w.step)}</span>` +
        `</label>`).join('');
      modal.innerHTML =
        `<div class="sm-title">Create Prog</div>` +
        `<div class="create-prog-namerow">` +
          `<input type="text" id="create-prog-name-input" class="create-prog-input" placeholder="Prog name" />` +
          `<button type="button" id="create-prog-shuffle" class="create-prog-dice" title="Suggest another name">🎲</button>` +
        `</div>` +
        `<div class="create-prog-hint">Standard progression (${scaleLabel}):</div>` +
        `<select id="create-prog-std" class="create-prog-input create-prog-std">${stdOptions}</select>` +
        `<div class="create-prog-hint" id="create-prog-wraps-hint">…or pick wraps to include (in bank order):</div>` +
        `<div class="create-prog-list" id="create-prog-list">${rows || '<div class="create-prog-empty-wraps">No User wraps yet</div>'}</div>` +
        `<div class="sm-footer">` +
          `<button type="button" class="sm-preview" id="create-prog-cancel">Cancel</button>` +
          `<button type="button" class="sm-apply" id="create-prog-save">Save Prog</button>` +
        `</div>`;

      const nameInput = modal.querySelector('#create-prog-name-input');
      nameInput.value = _randAdjNoun();
      const stdSel = modal.querySelector('#create-prog-std');
      const listEl = modal.querySelector('#create-prog-list');
      const wrapsHint = modal.querySelector('#create-prog-wraps-hint');
      // Selecting a Standard dims the User-wrap picker (Standard wins); name
      // prefills to the Standard's name.
      const refreshSource = () => {
        const usingStd = !!stdSel.value;
        listEl.classList.toggle('create-prog-disabled', usingStd);
        wrapsHint.classList.toggle('create-prog-disabled', usingStd);
        listEl.querySelectorAll('.create-prog-cb').forEach(cb => { cb.disabled = usingStd; });
      };
      stdSel.addEventListener('change', () => {
        if (stdSel.value) {
          const s = standards[parseInt(stdSel.value, 10)];
          if (s) nameInput.value = s.name;
        }
        refreshSource();
      });
      refreshSource();
      modal.querySelector('#create-prog-shuffle').addEventListener('click', () => { nameInput.value = _randAdjNoun(); nameInput.focus(); });
      modal.querySelector('#create-prog-cancel').addEventListener('click', () => overlay.remove());
      modal.querySelector('#create-prog-save').addEventListener('click', () => {
        let items;
        if (stdSel.value) {
          // Standard progression → publish a WALK-able Prog (a 'prog:' bank):
          // its chords keep their per-degree roots, so a grid press sets the key
          // root and the progression walks (I-IV-vi-V → C,F,Am,G in C). (A flat
          // userprog of chords would instead re-root every chord on the pressed
          // note, losing the degrees.)
          const s = standards[parseInt(stdSel.value, 10)];
          const chords = (s && Array.isArray(s.chords)) ? s.chords.filter(c => c && Array.isArray(c.intervals) && c.intervals.length) : [];
          if (!chords.length) { if (typeof showToast === 'function') showToast('That progression produced no chords'); return; }
          const nm = (nameInput.value || '').trim() || (s && s.name) || _randAdjNoun();
          masterAmbient = masterAmbient || (typeof _defaultAmbientConfig === 'function' ? _defaultAmbientConfig() : { publishedProgs: [] });
          if (!Array.isArray(masterAmbient.publishedProgs)) masterAmbient.publishedProgs = [];
          const pid = masterAmbient.publishedProgs.reduce((m, p) => Math.max(m, p.id | 0), 0) + 1;
          masterAmbient.publishedProgs.push({ id: pid, name: nm, chords: chords.map(c => ({ root: ((c.root | 0) % 12 + 12) % 12, intervals: c.intervals.slice() })) });
          if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
          overlay.remove();
          setWrapBank('prog:' + pid);
          if (typeof showToast === 'function') showToast('Created Prog “' + nm + '” (' + chords.length + ' chords) — press the grid to walk it');
          return;
        }
        {
          const picked = Array.from(modal.querySelectorAll('.create-prog-cb:checked'))
            .map(cb => savedWraps[parseInt(cb.dataset.idx, 10)])
            .filter(Boolean);
          if (!picked.length) { if (typeof showToast === 'function') showToast('Pick a Standard progression or at least one wrap'); return; }
          // Snapshot the chosen wraps (deep copy) so the Prog is stable even if
          // the User bank is later edited / cleared.
          items = picked.map(w => ({ name: w.name, step: cloneStep(w.step) }));
        }
        const name = (nameInput.value || '').trim() || _randAdjNoun();
        const id = (Array.isArray(wrapProgs) ? wrapProgs : (wrapProgs = []))
          .reduce((m, p) => Math.max(m, p.id | 0), 0) + 1;
        wrapProgs.push({ id, name, items });
        persistWrapProgs();
        overlay.remove();
        // Load the new Prog immediately (arm + cycle).
        _wrapSelectSequentialBank('userprog:' + id, name);
        if (typeof showToast === 'function') showToast('Created Prog “' + name + '” (' + items.length + ' wraps)');
      });
      setTimeout(() => { try { nameInput.focus(); nameInput.select(); } catch (e) {} }, 0);
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
      // (The generated "Chords" palette bank was removed — User + Prog only.)
      addBankBtn('user', 'User' + (savedWraps.length ? ` (${savedWraps.length})` : ''));
      menu.appendChild(picker);

      // (The "Key" mirror section was removed — standard progressions are now
      // offered inside the Create Prog dialog instead.)

      // ---- Prog: user-defined banks — named, ordered subsequences of the User
      // wrap bank. "＋ Create Prog…" picks a subset of User wraps and saves it
      // as its own recallable, cyclable bank.
      const userProgs = _wrapUserProgList();
      // The live Key-mode progression(s): selecting one is a "Prog wrap" — a
      // grid press sets the KEY ROOT and the chords play as numerals re-rooted
      // there, walking the progression one chord per press (see _progWrapActive
      // / _progWrapPressOpts). This is what makes a key-relative progression
      // playable from the grid.
      const keyProgs = _wrapAllProgs();
      const upHead = document.createElement('div');
      upHead.className = 'wrap-bank-menu-head';
      upHead.textContent = 'Prog';
      menu.appendChild(upHead);
      if (keyProgs.length || userProgs.length) {
        const upWrap = document.createElement('div');
        upWrap.className = 'wrap-bank-picker wrap-bank-prog';
        // One row per Prog: a recall button + a ✕ that deletes the Prog from
        // the library. (✕ lives in the menu, not on the chip strip, so it's a
        // deliberate action — not the old easy-to-mis-tap chip ✕.)
        const mkProgRow = (id, nm, title, onPick, onDelete) => {
          const row = document.createElement('div');
          row.className = 'wrap-bank-prog-row';
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'wrap-bank-pick' + (wrapBank === id ? ' active' : '');
          b.textContent = nm; b.title = title;
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('click', (e) => { e.stopPropagation(); onPick(); });
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'wrap-bank-prog-del';
          x.textContent = '✕';
          x.title = 'Delete this Prog';
          x.setAttribute('aria-label', 'Delete Prog ' + nm);
          x.addEventListener('pointerdown', (e) => e.stopPropagation());
          x.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); row.remove(); });
          row.appendChild(b); row.appendChild(x);
          return row;
        };
        keyProgs.forEach(p => {
          const id = 'prog:' + (p.id | 0);
          const nm = p.name || ('Prog ' + (p.id | 0));
          upWrap.appendChild(mkProgRow(id, nm,
            (Array.isArray(p.chords) ? p.chords.length : 0) + ' chords · grid press sets the key root',
            () => { setWrapBank(id); closeWrapsMenu(); },
            () => { _wrapDeleteKeyProg(p.id | 0); }));
        });
        userProgs.forEach(p => {
          const id = 'userprog:' + (p.id | 0);
          const nm = p.name || ('Prog ' + (p.id | 0));
          upWrap.appendChild(mkProgRow(id, nm,
            (Array.isArray(p.items) ? p.items.length : 0) + ' wraps',
            () => { _wrapSelectSequentialBank(id, nm); },
            () => { _wrapDeleteUserProg(p.id | 0); }));
        });
        menu.appendChild(upWrap);
      }
      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.className = 'wrap-bank-create-prog';
      createBtn.textContent = '＋ Create Prog…';
      // Enabled when there are User wraps OR standard progressions for the
      // current grid scale (the dialog offers both sources).
      {
        const gScale = (typeof currentScale === 'string') ? currentScale : 'major';
        const gRoot = (typeof rootIdx === 'number') ? rootIdx : 0;
        const stdN = (typeof _progStandardsForScale === 'function') ? _progStandardsForScale(gScale, gRoot).length : 0;
        if (!savedWraps.length && !stdN) { createBtn.disabled = true; createBtn.title = 'Save some wraps, or pick a scale with standard progressions'; }
      }
      createBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      createBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWrapsMenu(); openCreateProgDialog(); });
      menu.appendChild(createBtn);

      const sepHr = document.createElement('hr');
      menu.appendChild(sepHr);

      const cycleBtn = document.createElement('button');
      cycleBtn.type = 'button';
      cycleBtn.className = 'wrap-cycle-btn';
      const paintCycle = () => {
        cycleBtn.textContent = !wrapCycleMode
          ? 'Cycle: Off'
          : (wrapCycleDir > 0 ? 'Cycle: Right →' : 'Cycle: Left ←');
        cycleBtn.classList.toggle('active', wrapCycleMode);
        // Distinct highlight per direction (matches the Wraps label).
        cycleBtn.classList.toggle('cycle-right', wrapCycleMode && wrapCycleDir > 0);
        cycleBtn.classList.toggle('cycle-left',  wrapCycleMode && wrapCycleDir < 0);
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

      const setBtn = document.createElement('button');
      setBtn.type = 'button';
      setBtn.textContent = 'Set (all → set)';
      if (savedWraps.length === 0) setBtn.disabled = true;
      setBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      setBtn.addEventListener('click', (e) => { e.stopPropagation(); convertAllWrapsTo('set'); closeWrapsMenu(); });
      menu.appendChild(setBtn);

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
      // In Key mode the chord pad is the wrap bank — open the Key wraps menu
      // (Cycle / Run / Stack / Reorder / Shuffle) instead of the Grid one.
      const openMenu = () => {
        if (document.body.classList.contains('prog-mode') && typeof _progWrapsMenu === 'function') {
          const r = label.getBoundingClientRect();
          _progWrapsMenu(r.left, r.bottom + 4);
        } else {
          openWrapsMenu(label);
        }
      };
      label.addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(); }
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
      const chipsEl = document.getElementById('wrap-bank-chips');
      if (!bank || !chipsEl) return;
      const data = _wrapBankList();
      // The row is always visible: Standard / progression banks always have
      // entries, and even an empty User bank needs its label (the bank
      // picker) reachable to switch back to a populated bank.
      bank.hidden = false;
      chipsEl.innerHTML = '';

      if (data.chips.length === 0) {
        // Only the (empty) User bank reaches here.
        const empty = document.createElement('span');
        empty.className = 'wrap-bank-empty';
        empty.textContent = (data.kind === 'user')
          ? 'No saved wraps yet'
          : 'No chords for this bank';
        chipsEl.appendChild(empty);
        if (wrapCycleMode) { wrapCycleMode = false; _wrapCyclePendingAdvance = false; }
        updateWrapCycleLabel();
        return;
      }

      // The currently-armed wrap (so the strip reflects recall AND cycle).
      const activeKey = activeWrapBankId
        ? (data.chips.find(c => c.userId === activeWrapBankId) || {}).key
        : wrapGenActiveKey;

      data.chips.forEach((entry) => {
        const chip = document.createElement('div');
        chip.className = 'wrap-bank-chip' + (entry.key === activeKey ? ' active' : '');
        chip.setAttribute('role', 'option');
        chip.setAttribute('aria-selected', entry.key === activeKey ? 'true' : 'false');
        chip.title = 'Recall ' + _wrapOptionText(entry);

        const recall = document.createElement('button');
        recall.type = 'button';
        recall.className = 'wrap-bank-chip-recall';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'wrap-bank-chip-name';
        nameSpan.textContent = entry.name || '';
        recall.appendChild(nameSpan);
        const labelTxt = (entry.label && entry.label !== '·' && entry.label !== entry.name) ? entry.label : '';
        if (labelTxt) {
          const labelSpan = document.createElement('span');
          labelSpan.className = 'wrap-bank-chip-label';
          labelSpan.textContent = labelTxt;
          recall.appendChild(labelSpan);
        }
        recall.addEventListener('click', () => {
          // Keep the cycle cursor in sync with a hand-pick so the next cycle
          // step continues from here.
          if (wrapCycleMode) {
            const idx = _wrapCycleChips().findIndex(c => c.key === entry.key);
            if (idx >= 0) wrapCycleIndex = idx;
          }
          if (entry.userId) recallWrapFromBank(entry.userId);
          else recallGeneratedWrap(entry);
        });
        chip.appendChild(recall);

        // Inline delete — only on the editable User bank.
        if (!data.readOnly && entry.userId) {
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'wrap-bank-chip-x';
          x.setAttribute('aria-label', 'Delete wrap ' + entry.name);
          x.title = 'Delete wrap ' + entry.name;
          x.textContent = '×';
          x.addEventListener('click', (e) => { e.stopPropagation(); removeWrapFromBank(entry.userId); });
          chip.appendChild(x);
        }

        // Right-click / long-press → publish a User wrap to the master Bloom.
        if (entry.userId) {
          chip.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (typeof showCtxMenu !== 'function') return;
            showCtxMenu(e.clientX, e.clientY, [
              { label: '🌸 Publish to Bloom', fn: () => {
                  const ok = (typeof _ambPublishWrap === 'function') && _ambPublishWrap(entry.name, entry.step);
                  if (typeof showToast === 'function') showToast(ok ? ('Published “' + entry.name + '” to Bloom Notes') : 'Could not publish this wrap');
                } },
            ]);
          });
        }

        chipsEl.appendChild(chip);
      });
      updateWrapCycleLabel();
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

