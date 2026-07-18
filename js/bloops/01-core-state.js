    // ---- Weak-device audio fallback: REMOVED (was: persisted latencyHint
    // swap via Tone.setContext). Two reasons it must never come back in this
    // form: (1) nothing writes 'bloopsAudioLatency' anymore (the watchdog
    // escalation was removed), so the key only survived as a fossil on
    // machines flagged by old builds; (2) in Tone 14.9.17, setContext()
    // updates Tone.getContext() but NOT the Tone.context property — the app
    // uses both idioms, so the swap SPLIT the app across two live
    // AudioContexts with clocks ~0.5 s apart: fast grid taps released before
    // their (wrong-clock) start = freed silent, everything else exited a
    // ~186 ms output pipeline. Purge the fossil so no machine stays wedged.
    try { localStorage.removeItem('bloopsAudioLatency'); } catch (e) {}

    // ---- Toast notifications -------------------------------------------------
    // Lightweight transient message, bottom-center. The whole Bloops codebase
    // has ~100 `if (typeof showToast === 'function') showToast(...)` call sites,
    // but showToast was NEVER defined — so every one was a silent no-op (Grab
    // confirmations, prog messages, the ensemble "pick a scale" hint, …). This
    // is that missing definition; a top-level function declaration in the first
    // Bloops script is visible to all the later ones (shared global scope).
    let _toastEl = null, _toastTimer = null;
    function showToast(msg, opts) {
      try {
        if (!_toastEl) {
          _toastEl = document.createElement('div');
          _toastEl.className = 'bloops-toast';
          document.body.appendChild(_toastEl);
        }
        _toastEl.textContent = String(msg == null ? '' : msg);
        _toastEl.classList.toggle('bloops-toast-warn', !!(opts && opts.warn));
        // reflow → restart the fade-in even on a rapid second toast
        void _toastEl.offsetWidth;
        _toastEl.classList.add('show');
        if (_toastTimer) clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { if (_toastEl) _toastEl.classList.remove('show'); }, (opts && opts.ms) || 2600);
      } catch (e) {}
    }

    const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    let rootIdx = 0;       // 0 = C — pitch class of the grid's lowest cell
    let baseOctave = 4;    // octave number of the root note
    // Decoupled scale tonic — independent of rootIdx so the user can
    // shift the grid window by 1 scale degree (only rootIdx moves)
    // without changing which note the scale is rooted on. Null means
    // "follows rootIdx" — the default. Set by every path that
    // explicitly picks a key (root dropdown, scale dropdown, Key
    // picker), cleared back to null when chromatic.
    let _scaleTonic = null;
    function _effectiveScaleTonic() {
      if (_scaleTonic != null) return _scaleTonic;
      // Lazy-anchor when a non-chromatic scale was restored from saved
      // state (or set by code that didn't go through _setCurrentKey).
      // Without this, a subsequent degree-shift would let the effective
      // tonic drift with rootIdx — and _captureKeyContext would then
      // stamp post-shift steps with a different root from pre-shift
      // steps in the same key, splitting them out of the visual
      // key-group container.
      if (currentScale && currentScale !== 'chromatic') {
        _scaleTonic = rootIdx;
        return _scaleTonic;
      }
      return rootIdx;
    }
    let octaveCount = 1;   // 1..3
    let masterFreqA = 440; // Hz — master tuning reference (A4)

    function computeNotesForOctaves(octCount) {
      const out = [];
      const total = 12 * Math.max(1, octCount);
      // Microtonal tuning: when currentScale names a 12-note alternate
      // tuning (see MICRO_TUNINGS in 15-grid-build.js), each chromatic
      // degree is bent off equal temperament by a fixed cents deviation,
      // looked up by the degree's distance above the scale tonic. Guarded
      // by typeof because this runs once at module load (line `let notes =
      // computeNotes()`) before 15-grid-build.js has defined those globals;
      // it then resolves for real on every later rebuildGrid(). Null /
      // absent → pure 12-TET, byte-for-byte as before.
      let micro = null, microTonic = 0;
      try {
        if (typeof MICRO_TUNINGS !== 'undefined'
            && typeof currentScale === 'string'
            && MICRO_TUNINGS[currentScale]) {
          micro = MICRO_TUNINGS[currentScale];
          microTonic = (typeof _effectiveScaleTonic === 'function')
            ? _effectiveScaleTonic() : rootIdx;
        }
      } catch (e) {}
      for (let i = 0; i < total; i++) {
        const semi = rootIdx + i;
        const noteIdx = semi % 12;
        const octaveNum = baseOctave + Math.floor(semi / 12);
        const midi = 12 * (octaveNum + 1) + noteIdx;
        let freq = masterFreqA * Math.pow(2, (midi - 69) / 12);
        if (micro) {
          // Degree above the tonic (0..11), then nudge by the tuning's
          // cents offset relative to this degree's 12-TET position.
          const deg = (((noteIdx - microTonic) % 12) + 12) % 12;
          const dev = (micro[deg] || 0) - deg * 100; // cents off equal temperament
          if (dev) freq *= Math.pow(2, dev / 1200);
        }
        out.push({ freq, label: CHROMATIC[noteIdx] + octaveNum });
      }
      return out;
    }

    function computeNotes() {
      return computeNotesForOctaves(octaveCount);
    }

    let notes = computeNotes();

    let sequenceTimer = null;
    // Absolute audio-context time anchors for sequence playback. Each note
    // is scheduled at _playBaseTime + _playOffsetSec instead of "now",
    // which makes the cadence robust against setTimeout jitter — without
    // this, mobile Safari rushes the first few notes (early setTimeout
    // ticks) and then settles, sounding like the sequence speeds up at the
    // start.
    let _playBaseTime  = 0;
    let _playOffsetSec = 0;
    // ---- Groove (rhythmic feel) ----------------------------------------
    // Composed into each step's fire time alongside slip in scheduleStepAt,
    // so they stack and never alter the cadence (only when each attack
    // lands). swing delays off-grid positions; humanize jitters timing +
    // velocity for a less mechanical feel. All 0 = byte-for-byte the
    // original straight timing.
    let grooveSwing      = 0;    // 0..100 %  (0 = straight)
    let grooveSwingDiv   = 0.5;  // swing grid in quarter-note beats: 0.5 = 1/8, 0.25 = 1/16
    let grooveHumanizeMs = 0;    // ± timing jitter, milliseconds
    let grooveHumanizeVel = 0;   // ± velocity jitter, percent
    // Accent: a metric emphasis. Notes on an accent beat (or a step flagged
    // step.accent) play at full velocity; the rest are ducked by
    // grooveAccentAmt — which keeps the accent audible even when voices sit
    // at 100% (no headroom to boost into). 0 / 0 = off.
    let grooveAccentEvery = 0;   // accent every N quarter-note beats (0 = off, 1/2/4)
    let grooveAccentAmt   = 35;  // how much NON-accented notes duck, percent
    let sequence = []; // [{ freq, label, cellIndex }] — freq null = rest; chord: [{...}]
    // ---- Poly mode (multi-lane sequencer) -----------------------------
    // In Mono (default), the workspace is a single `sequence`. In Poly,
    // the workspace splits into N parallel lanes (one per grid row);
    // the active lane's `steps` is aliased to `sequence` so all
    // existing add/edit code keeps working. Mute/Solo are per-lane.
    // Mono mode has been removed — the workspace is always poly with
    // at least one lane. `polyMode` stays as a constant flag so the
    // dozens of `if (polyMode)` reads scattered through the codebase
    // still resolve true; `_stashedLanes` stays as a no-op to avoid
    // breaking save / load files written by older builds.
    const polyMode = true;
    let lanes = [];           // [{ name, steps: [], muted: false, solo: false, voice }]
    let activeLaneIdx = 0;
    let _stashedLanes = null; // legacy field — never written under always-poly
    // The voice editor (#lane-expander) is reparented above the active
    // lane row when this flag is true; parked in #lane-expander-stash
    // (display:none) when false. Default true so a fresh workspace
    // shows the grid + Scale / Tone / FX / Spell controls right away.
    let _laneExpanderOpen = true;
    // Move the #lane-expander DOM node either above the active lane
    // row (open) or back into the hidden stash (closed). Called from
    // renderSequence after the lane rows are built and from the
    // toggle / Esc handlers. Idempotent — safe to call repeatedly.
    function _placeLaneExpander() {
      const exp = document.getElementById('lane-expander');
      const stash = document.getElementById('lane-expander-stash');
      if (!exp || !stash) return;
      // Bloom Author-in-Grid: while a Bloom layer is being edited in the full
      // editor, the whole expander docks inside that layer's Seed subsection
      // (17-ambient.js sets window._bloomGridDock). Everything in the expander
      // is wired by fixed IDs, so relocation is transparent; renderSequence
      // keeps calling this, so the override must come first.
      // The dock target is resolved LIVE by layer key (panel rebuilds wipe and
      // recreate the card DOM, so a stored node would go stale).
      if (window._bloomGridKey != null) {
        const dk = document.querySelector('.ambient-seedgrid-slot[data-sgkey="' + String(window._bloomGridKey).replace(/"/g, '') + '"] .ambient-seedgrid-dockhost');
        if (dk) {
          if (exp.parentNode !== dk) dk.appendChild(exp);
          stash.hidden = true;
          return;
        }
      }
      const display = document.getElementById('sequence-display');
      // Pin the editor to the TOP of the lane list (above the FIRST lane row),
      // not above the active lane — so the Grid/Graph/etc component stays put
      // while you switch lanes; its content still reflects the active lane. The
      // lanes form a clean stacked list below it.
      const firstRow = display
        ? display.querySelector(':scope > .lane-row')
        : null;
      if (_laneExpanderOpen && display && firstRow) {
        if (exp.parentNode !== display || exp.nextSibling !== firstRow) {
          display.insertBefore(exp, firstRow);
        }
        stash.hidden = true;
      } else if (_laneExpanderOpen && display && !firstRow) {
        // No lane rows rendered (edge case) — keep the editor mounted on top.
        if (exp.parentNode !== display) display.appendChild(exp);
        stash.hidden = true;
      } else {
        if (exp.parentNode !== stash) stash.appendChild(exp);
        stash.hidden = true; // stash itself is always display:none via [hidden]
      }
    }
    // Park the #step-edit-row (Edit button + Mix / Groove tabs) directly
    // BELOW the active lane's step strip so the controls read as that
    // lane's step editor. Mirrors _placeLaneExpander (which sits ABOVE the
    // lane) — together they bracket the active lane row: grid above, the
    // Edit / Mix / Groove controls below. Parked back in the persistent
    // stash when there's no expanded active lane on screen so the node's
    // IDs / bindings survive renderSequence's display wipe. Idempotent.
    function _placeStepEditRow() {
      const row = document.getElementById('step-edit-row');
      const stash = document.getElementById('lane-expander-stash');
      if (!row || !stash) return;
      const display = document.getElementById('sequence-display');
      // Author-in-Grid: the active (scratch) lane's row lives in the dock's
      // strip host, not #sequence-display — bracket it there the same way.
      const docked = (window._bloomGridKey != null)
        ? document.querySelector('.ambient-seedgrid-striphost .lane-row.active')
        : null;
      const activeRow = docked || (display
        ? display.querySelector(':scope > .lane-row.active')
        : null);
      if (activeRow) {
        if (activeRow.nextSibling !== row) activeRow.after(row);
      } else {
        if (row.parentNode !== stash) stash.appendChild(row);
      }
    }
    // Close button + Esc collapse the voice editor. Bound here at
    // module scope so a single listener serves every render — the
    // expander DOM node persists across renderSequence calls so its
    // close button binding survives.
    document.getElementById('lane-expander-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _laneExpanderOpen = false;
      _placeLaneExpander();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!_laneExpanderOpen) return;
      _laneExpanderOpen = false;
      _placeLaneExpander();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    });
    let chordMode = false;
    // Shape chosen at the start of the current wrap session ('run' or
    // 'stack'). Set by the Wrap-press picker; consulted by the commit
    // path so the wrap turns into the user's chosen shape regardless of
    // the global note-mode banner. Null between wraps. The pre-prompt
    // behaviour (fall back to gridMode === 'arpeggio') still applies if
    // _wrapShape is null at commit time — defensive against state-restore
    // paths that bring back chordMode=true without populating this var.
    let _wrapShape = null;
    // Grid playback mode — drives what a cell click does.
    //   'sequencer' (default): existing behavior (add note / start sustain).
    //   'arpeggio':  play the saved sequence transposed so its first note
    //                lines up with the clicked cell. Sequence isn't edited.
    //   'chord':     collapse the saved sequence into a chord, transpose to
    //                the clicked cell's root, play simultaneously.
    let gridMode = 'sequencer';
    // Mode-lock toggle: when true, switching grid modes re-shapes the
    // workspace — flat notes ↔ subsequence ↔ chord — so the user can
    // round-trip Spell → Run → Stack → Spell without losing structure.
    let lockMode = (() => {
      try { return localStorage.getItem('lock-mode') === '1'; }
      catch (e) { return false; }
    })();
    // Keep toggle (the "Keep" button to the left of the BPM row): when
    // on, pressing a cell in the grid creates a step in the current
    // sequence (per the active note mode). When off (default), the note
    // is auditioned only — sequence is not modified.
    let keepMode = false;
    // Perform mode — a real-time recorder. When on, each note/chord the user
    // plays is captured into the sequence with its timing; silences become
    // rests. performQuantize snaps timing to performResolution (a step-div:
    // 1=1/4, 0.5=1/8, 0.25=1/16, 0.125=1/32). The capture timeline cursor is
    // tracked in resolution-units (_performEmittedUnits) from the first note
    // (_performStartMs).
    let performMode = false;
    let performQuantize = true;
    let performResolution = 0.25;
    // When on, arming Perform starts a BPM click that stays on until Perform
    // is clicked again to finalize. With a count-in the click is phase-locked
    // to the count-in grid so it continues seamlessly into the take.
    let performClick = false;
    // "Translate mic input" — when on, arming Perform opens the microphone
    // and the take is HUMMED, not played: frames are pitch-tracked while
    // armed, and finalizing (PERF again) transcribes them (via the Bloom hum
    // machinery _ambAcfPitch/_ambHumSegment) into timed sequence steps on
    // the same quantize/resolution grid. Grid presses audition only while a
    // mic take is armed. Independent of any playback — works from silence.
    let performMic = false;
    let _performStartMs = null;
    let _performEmittedUnits = 0;
    // While a count-in click is playing, Perform is armed but not yet
    // capturing — presses still audition but aren't recorded until the
    // downbeat after the count-in.
    let _performCountingIn = false;
    // Per-Keep-session step-div lock. While Keep is on, the step-div
    // picker pops up after each note added in Spell or Stack mode so
    // the user picks the size for that note. Toggling the "use for the
    // rest of this Keep session" checkbox sets these flags so further
    // notes adopt the chosen size without re-prompting; both reset when
    // Keep is toggled off.
    let _keepStepDivLocked = false;
    let _keepStepDivLockedValue = null;
    // Every step kept during the current Keep session, in add order.
    // Reset when Keep turns on; on Keep-off, showKeepStepDivMenu offers a
    // single "how long does each note play" menu over all of them.
    let _keepSessionSteps = [];
    // The per-note step-div popup is now OPTIONAL (default off). When off,
    // notes append silently and sizing is chosen once on Keep-off. When on,
    // the old per-note picker fires after each note. Persisted across loads.
    let _keepAskPerNote = false;
    try { _keepAskPerNote = (localStorage.getItem('bloops-keep-ask-pernote') === '1'); } catch (e) {}
    // Saved "form" from the most recent Wrap commit (chord step or
    // subsequence step). While set, cell clicks audition this form
    // transposed so the clicked note becomes its first note. With
    // Keep on, the transposed form is also appended to the sequence;
    // with Keep off, audition only.
    let wrapTemplate = null;

    // Source of truth for the Wrap button label + the purple step-
    // controls glow. Three states:
    //   - chordMode true            → "Close"  (actively building a wrap)
    //   - !chordMode && wrapTemplate → "Unwrap" (committed template exists)
    //   - else                      → "Wrap"
    function refreshWrapVisuals() {
      const btn = document.getElementById('chord-btn');
      const group = document.querySelector('.btn-group--step');
      if (btn) {
        btn.classList.toggle('active', !!chordMode);
        btn.textContent = chordMode
          ? 'Close'
          : (wrapTemplate ? 'Unwrap' : 'Wrap');
      }
      if (group) {
        group.classList.toggle('chord-active', !!chordMode || !!wrapTemplate);
      }
      // Edit pill only makes sense when there's something to edit: a
      // committed wrapTemplate (chord/sub) OR an in-progress chordMode
      // session with at least one note collected. Hidden otherwise so
      // the Wrap button gets the whole segment.
      const editBtn = document.getElementById('wrap-edit-btn');
      if (editBtn) {
        const hasWrapToEdit = !!wrapTemplate || (chordMode && pendingChord.length > 0);
        editBtn.hidden = !hasWrapToEdit;
      }
      // Chord readout follows the same lifecycle as the Wrap visuals,
      // so update it from the same source of truth.
      updateChordDisplay();
    }
    // Clears the wrap-pending outline from every cell. Called whenever
    // chordMode exits (commit, cancel, clear, undo, workspace restore)
    // so a stale highlight can't survive across wrap sessions.
    function clearWrapPendingHighlights() {
      cells.forEach(c => c && c.classList && c.classList.remove('wrap-pending'));
      // The transposed-display step is wrap-scoped — once highlights are
      // wiped we're outside any active wrap, so let the chord-display
      // readout fall back to wrapTemplate (or hide).
      _wrapTransposeDisplayStep = null;
      // The user-driven tonic shift is per-wrap. Reset alongside the
      // pending highlights so a fresh wrap starts at shift 0.
      _wrapTonicShift = 0;
    }

    // ---- Chord-name display ----
    // How many positions to rotate the wrap's tonic (root) for naming.
    // Press-and-hold the Keep button while a wrap is active to cycle.
    // Reset whenever the wrap exits (see clearWrapPendingHighlights).
    let _wrapTonicShift = 0;
    // Latest auditioned transposed wrapTemplate, or null. Set by
    // playWrapTemplateOnCell so the readout follows transpositions
    // even though wrapTemplate itself stays anchored to its original
    // pitches. Cleared whenever the wrap exits.
    let _wrapTransposeDisplayStep = null;
    // Step currently being highlighted by sequence playback. When set,
    // updateKeepLabel surfaces its chord/note name instead of the wrap
    // form, so the Keep button reads "C", "Em7", "F#dim/A" etc. as the
    // sequence advances. Cleared on stopSequence and on rest steps.
    let _playbackStep = null;
    // Poly mode runs multiple lanes concurrently, so a single
    // _playbackStep can't represent what's sounding. This map tracks
    // each lane's currently-playing step keyed by laneIdx; the Keep
    // label joins their names ("C D" if lane 0 plays C and lane 1
    // plays D). Cleared in stopSequence alongside _playbackStep.
    const _playbackStepsByLane = new Map();

    const _PITCH_NAMES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    function _pcName(pc) {
      const idx = ((Math.round(pc) % 12) + 12) % 12;
      return _PITCH_NAMES_SHARP[idx];
    }
    function _freqToMidi(f) {
      return Number.isFinite(f) && f > 0 ? 12 * Math.log2(f / 440) + 69 : null;
    }
    // Chord pattern table — intervals from root (sorted ascending), most
    // specific first so a 4-note Major 7 doesn't get downgraded to a 3-
    // note Major. Anything that isn't matched falls back to a bare pitch-
    // class list in chordNameFromFreqs().
    // Chord pattern → traditional shorthand suffix appended to the root
    // letter (e.g. "C" + "M7" → "CM7", "F#" + "m7b5" → "F#m7b5"). Empty
    // suffix means "just the root letter" (plain major triad). Sorted by
    // length descending then by perceived specificity within a length, so
    // when an input matches multiple roots, the chord with the lowest
    // patIdx (most specific) wins — Em7 beats C6 for {C,E,G,B-1}, etc.
    const _CHORD_PATTERNS = [
      // 6-note extensions (rare — usually some voice is omitted)
      { ivs: [0, 2, 4, 7, 9, 11], name: 'M13' },
      { ivs: [0, 2, 4, 7, 9, 10], name: '13' },
      { ivs: [0, 2, 3, 7, 9, 10], name: 'm13' },
      { ivs: [0, 2, 4, 5, 7, 11], name: 'M11' },
      { ivs: [0, 2, 4, 5, 7, 10], name: '11' },
      { ivs: [0, 2, 3, 5, 7, 10], name: 'm11' },
      { ivs: [0, 2, 4, 6, 7, 11], name: 'M7#11' },

      // 5-note 9ths and altered dominants
      { ivs: [0, 2, 4, 7, 11], name: 'M9' },
      { ivs: [0, 2, 4, 7, 10], name: '9' },
      { ivs: [0, 2, 3, 7, 10], name: 'm9' },
      { ivs: [0, 2, 3, 7, 11], name: 'mM9' },
      { ivs: [0, 2, 4, 7, 9],  name: '6/9' },
      { ivs: [0, 2, 3, 7, 9],  name: 'm6/9' },
      { ivs: [0, 2, 5, 7, 10], name: '9sus4' },
      { ivs: [0, 1, 4, 7, 10], name: '7b9' },
      { ivs: [0, 3, 4, 7, 10], name: '7#9' },
      { ivs: [0, 4, 6, 7, 10], name: '7#11' },
      { ivs: [0, 4, 6, 7, 11], name: 'M7#11' },

      // 4-note 7ths first — m7 / M7 / 7 are far more common than 6 chords,
      // so they win the cross-root tiebreak when both interpretations fit
      // (e.g. {C,E,G,A} → Am7 over C6).
      { ivs: [0, 4, 7, 11], name: 'M7' },
      { ivs: [0, 3, 7, 10], name: 'm7' },
      { ivs: [0, 4, 7, 10], name: '7' },
      { ivs: [0, 3, 6, 10], name: 'm7b5' },
      { ivs: [0, 3, 6, 9],  name: 'dim7' },
      { ivs: [0, 3, 7, 11], name: 'mM7' },
      { ivs: [0, 4, 8, 10], name: 'aug7' },
      { ivs: [0, 4, 8, 11], name: 'M7#5' },
      { ivs: [0, 4, 6, 11], name: 'M7b5' },
      { ivs: [0, 5, 7, 10], name: '7sus4' },
      { ivs: [0, 4, 6, 10], name: '7b5' },
      { ivs: [0, 4, 7, 9],  name: '6' },
      { ivs: [0, 3, 7, 9],  name: 'm6' },
      { ivs: [0, 2, 4, 7],  name: 'add9' },
      { ivs: [0, 2, 3, 7],  name: 'madd9' },

      // 3-note triads
      { ivs: [0, 4, 7], name: '' },     // plain major triad
      { ivs: [0, 3, 7], name: 'm' },
      { ivs: [0, 3, 6], name: 'dim' },
      { ivs: [0, 4, 8], name: 'aug' },
      { ivs: [0, 2, 7], name: 'sus2' },
      { ivs: [0, 5, 7], name: 'sus4' },

      // 2-note power chord
      { ivs: [0, 7], name: '5' },
    ];
    // Build a length → pattern[] index once so each cross-root probe only
    // walks patterns of the right size. With up to a dozen patterns at
    // each common length this matters far less than the readability win
    // of "match returns first specific hit".
    const _CHORD_PATTERNS_BY_LEN = (() => {
      const m = new Map();
      _CHORD_PATTERNS.forEach((pat, idx) => {
        const arr = m.get(pat.ivs.length) || [];
        arr.push({ pat, idx });
        m.set(pat.ivs.length, arr);
      });
      return m;
    })();
    // Loose quality detection for cases where the chord doesn't fit any
    // exact pattern (typically when the user has shifted the tonic to a
    // note that doesn't yield a standard root-rooted chord). Picks "m"
    // when a minor 3rd is present, "" (major) when a major 3rd is, and
    // a "no3" suffix when neither — falls back to "?". Doesn't try to
    // describe extensions; the user can read the bass from the slash.
    function _looseQualityFromIvs(ivs) {
      const set = new Set(ivs);
      if (set.has(3) && !set.has(4)) return 'm';
      if (set.has(4) && !set.has(3)) return '';
      if (set.has(3) && set.has(4)) return ''; // both → call it major-ish
      if (set.has(7))               return '5'; // P5 only (power chord)
      return null; // no detectable quality — caller falls back to PCs
    }
    function chordNameFromFreqs(freqs, forcedRootPc) {
      const valid = (freqs || []).filter(f => Number.isFinite(f) && f > 0);
      if (valid.length === 0) return '';
      const midis = valid.map(_freqToMidi).filter(m => m != null).map(Math.round);
      if (midis.length === 0) return '';
      if (midis.length === 1) return _pcName(midis[0]);
      const pcs = [...new Set(midis.map(m => ((m % 12) + 12) % 12))];
      if (pcs.length === 1) return _pcName(pcs[0]);
      const bassPc = ((Math.min(...midis) % 12) + 12) % 12;

      // Forced root path — used when the user has shifted the wrap
      // tonic via Keep's long-press menu. Try the exact pattern table
      // first; if nothing matches, fall back to a loose quality so the
      // chord still gets a readable name (e.g. "Em/C" for E-tonic on a
      // C-E-G voicing where {0,3,8} doesn't match a standard pattern).
      if (forcedRootPc != null && pcs.includes(forcedRootPc)) {
        const ivs = pcs
          .map(pc => ((pc - forcedRootPc) % 12 + 12) % 12)
          .sort((a, b) => a - b);
        const sameLen = _CHORD_PATTERNS_BY_LEN.get(pcs.length) || [];
        for (const { pat } of sameLen) {
          let match = true;
          for (let j = 0; j < ivs.length; j++) {
            if (pat.ivs[j] !== ivs[j]) { match = false; break; }
          }
          if (match) {
            const head = _pcName(forcedRootPc) + pat.name;
            return forcedRootPc === bassPc ? head : head + '/' + _pcName(bassPc);
          }
        }
        const loose = _looseQualityFromIvs(ivs);
        if (loose === null) {
          // No detectable quality (no 3rd, no P5) — surface the raw PCs
          // with the forced root first so the user can still see what
          // the wrap is.
          const ordered = [forcedRootPc, ...pcs.filter(p => p !== forcedRootPc)];
          return ordered.map(_pcName).join('·');
        }
        const head = _pcName(forcedRootPc) + loose;
        return forcedRootPc === bassPc ? head : head + '/' + _pcName(bassPc);
      }

      const sameLengthPats = _CHORD_PATTERNS_BY_LEN.get(pcs.length) || [];

      // Bass-rooted match wins outright when one exists — when the bass
      // note is itself a chord root the user almost always means that
      // chord (e.g. {C,E,G,A} bass=C → C6, not Am7/C). Only fall back
      // to non-bass roots when no bass-rooted pattern fits, in which
      // case we pick the most-specific match and append /bass.
      let bassMatch = null;
      let otherBest = null;
      for (const rootPc of pcs) {
        const ivs = pcs
          .map(pc => ((pc - rootPc) % 12 + 12) % 12)
          .sort((a, b) => a - b);
        for (const { pat, idx } of sameLengthPats) {
          let match = true;
          for (let j = 0; j < ivs.length; j++) {
            if (pat.ivs[j] !== ivs[j]) { match = false; break; }
          }
          if (!match) continue;
          const cand = { rootPc, patIdx: idx, suffix: pat.name };
          if (rootPc === bassPc) {
            if (!bassMatch || idx < bassMatch.patIdx) bassMatch = cand;
          } else {
            if (!otherBest || idx < otherBest.patIdx) otherBest = cand;
          }
          break; // each (root, length) probe matches at most one pattern
        }
      }
      const best = bassMatch || otherBest;
      if (best) {
        const head = _pcName(best.rootPc) + best.suffix;
        // Slash notation surfaces the inversion when the actual bass note
        // isn't the chord root (e.g. "C/E", "Dm7/A").
        return best.rootPc === bassPc ? head : head + '/' + _pcName(bassPc);
      }
      // No match — surface the raw pitch classes so the user still sees
      // what they're playing. Bass first so it reads ascending.
      const ordered = [bassPc, ...pcs.filter(p => p !== bassPc)];
      return ordered.map(_pcName).join('·');
    }
    // Distinct pitch classes of the wrap notes, in the order they were
    // built (pendingChord push order, or wrap voice order). Used by the
    // tonic-shift cycle so "next note" maps to the next distinct pitch.
    function wrapPcsInBuildOrder() {
      let freqs = null;
      if (chordMode && pendingChord.length > 0) {
        freqs = pendingChord.map(n => n.freq);
      } else if (_wrapTransposeDisplayStep) {
        freqs = collectStepFreqs(_wrapTransposeDisplayStep);
      } else if (wrapTemplate) {
        freqs = collectStepFreqs(wrapTemplate);
      }
      if (!freqs) return [];
      const seen = new Set();
      const out = [];
      for (const f of freqs) {
        const m = _freqToMidi(f);
        if (m == null) continue;
        const pc = ((Math.round(m) % 12) + 12) % 12;
        if (seen.has(pc)) continue;
        seen.add(pc);
        out.push(pc);
      }
      return out;
    }
    // Walk a step (chord / sub / single) and collect every leaf freq.
    function collectStepFreqs(step) {
      if (!step) return [];
      if (step.isSub && Array.isArray(step.subSteps)) {
        return step.subSteps.flatMap(collectStepFreqs);
      }
      if (Array.isArray(step.chord)) {
        return step.chord.map(n => n && n.freq).filter(f => Number.isFinite(f));
      }
      return Number.isFinite(step.freq) ? [step.freq] : [];
    }
    // Drive the Keep button's label off the wrap state. When any wrap
    // form is active (building, committed template, or last-auditioned
    // transposition) the button reads the shorthand chord name instead
    // of "KEEP" and gets a .show-chord modifier so its styling adapts
    // (no uppercase, tighter letter-spacing). When no wrap is active
    // the button flips back to "KEEP".
    //
    // Precedence:
    //   1. Active build (chordMode + pendingChord) → name from pending
    //   2. Last-auditioned transposed wrapTemplate → name from that
    //   3. Static wrapTemplate                     → name from template
    //   4. Otherwise show "KEEP"
    function updateKeepLabel() {
      const btn = document.getElementById('play-lock-btn');
      if (!btn) return;
      const span = btn.querySelector('span');
      if (!span) return;
      // Outside Grid mode (Game / Prog) Wrap is hidden and irrelevant —
      // keep the button reading "KEEP" so any chord/wrap-name carried
      // over from the last Grid session doesn't linger.
      if (gameMode || progMode) {
        span.textContent = 'KEEP';
        btn.classList.remove('show-chord');
        return;
      }
      // In Graph mode, surface the numeric frequency next to the note
      // name (e.g. "C4 · 261.6 Hz"). Graph mode is the XY pad world
      // where the user is dialing freely along a continuous axis, so
      // the exact value is informative — Grid mode steps are always
      // on-grid pitches and the Hz suffix would just be noise.
      const fmtFreq = (f) => {
        if (!isFinite(f) || f <= 0) return '';
        const v = f >= 1000 ? f.toFixed(0) : f.toFixed(1);
        return `${v} Hz`;
      };
      const decorate = (name, freqs) => {
        if (!fluidGridMode || !freqs || freqs.length !== 1) return name;
        const hz = fmtFreq(freqs[0]);
        return hz ? `${name} · ${hz}` : name;
      };
      // Live XY drag wins over everything else in Graph mode — when
      // the user is touching the pad, the Keep label should track the
      // current freq so they can read pitch ↔ Hz at a glance. Without
      // this branch, dragging the pad never moves the Keep button off
      // "KEEP" because none of the wrap/playback state below is set
      // mid-gesture.
      if (fluidGridMode && _liveXyParams && Number.isFinite(_liveXyParams.freq)) {
        const lf = [_liveXyParams.freq];
        const ln = chordNameFromFreqs(lf, null) || '';
        const hz = fmtFreq(_liveXyParams.freq);
        span.textContent = ln ? `${ln} · ${hz}` : hz;
        btn.classList.add('show-chord');
        return;
      }
      // Fluid-step playback for the active lane (mono fallback: -1).
      // Interpolate the current freq within the gesture so the readout
      // glides smoothly with the audible pitch instead of snapping to
      // the first sample's value and staying there.
      if (fluidGridMode && _fluidPlaybackByLane.size > 0) {
        const key = _fluidPlaybackByLane.has(activeLaneIdx) ? activeLaneIdx
                  : (_fluidPlaybackByLane.has(-1) ? -1 : null);
        if (key !== null) {
          const entry = _fluidPlaybackByLane.get(key);
          const ctx = Tone.context && Tone.context.rawContext;
          const now = ctx ? ctx.currentTime : Tone.now();
          const elapsed = Math.max(0, now - entry.audioStartedAt);
          const f = _fluidFreqAt(entry.step, elapsed);
          if (Number.isFinite(f) && f > 0) {
            const ln = chordNameFromFreqs([f], null) || '';
            const hz = fmtFreq(f);
            span.textContent = ln ? `${ln} · ${hz}` : hz;
            btn.classList.add('show-chord');
            return;
          }
        }
      }
      // During playback, surface only the active lane's currently-
      // playing step. Earlier this joined the names from every
      // lane ("C Dm Em" etc.), but that turned the Keep label into
      // a moving wall of text. Reading just the lane the user has
      // selected matches the rest of the UI's per-lane focus.
      if (_playbackStepsByLane.size > 0) {
        const activeStep = _playbackStepsByLane.get(activeLaneIdx);
        if (activeStep) {
          const lfreqs = collectStepFreqs(activeStep);
          if (lfreqs && lfreqs.length > 0) {
            const lname = chordNameFromFreqs(lfreqs, null);
            if (lname) {
              span.textContent = decorate(lname, lfreqs);
              btn.classList.add('show-chord');
              return;
            }
          }
        }
      }
      let freqs = null;
      // Playback wins over wrap state — when the sequence is running,
      // the user wants to read the chord that's currently sounding.
      if (_playbackStep) {
        freqs = collectStepFreqs(_playbackStep);
      } else if (chordMode && pendingChord.length > 0) {
        freqs = pendingChord.map(n => n.freq);
      } else if (_wrapTransposeDisplayStep) {
        freqs = collectStepFreqs(_wrapTransposeDisplayStep);
      } else if (wrapTemplate) {
        freqs = collectStepFreqs(wrapTemplate);
      }
      // If the user has shifted the tonic, force the root to the
      // shifted note's pitch class. Skip the shift when there are
      // fewer than 2 distinct pitches (nothing to rotate). Tonic
      // shift is wrap-scoped — don't apply it to playback steps.
      let forcedRootPc = null;
      if (!_playbackStep && _wrapTonicShift > 0) {
        const orderedPcs = wrapPcsInBuildOrder();
        if (orderedPcs.length >= 2) {
          const idx = ((_wrapTonicShift % orderedPcs.length) + orderedPcs.length) % orderedPcs.length;
          forcedRootPc = orderedPcs[idx];
        }
      }
      const name = (freqs && freqs.length > 0)
        ? chordNameFromFreqs(freqs, forcedRootPc)
        : '';
      // Accidental signal — surface the pitch classes that fall OUTSIDE the
      // current scale (a wrap/prog stepping out of key), so a chromatic chord
      // tone or borrowed chord is visible, not silent. _freqIsAccidental lives
      // in 08-grid-modes (shared global scope at call time); guard load order.
      const accNames = [];
      if (name && freqs && freqs.length && typeof _freqIsAccidental === 'function') {
        const seen = new Set();
        for (const f of freqs) {
          if (!_freqIsAccidental(f)) continue;
          const m = _freqToMidi(f);
          if (m == null) continue;
          const pc = ((Math.round(m) % 12) + 12) % 12;
          if (seen.has(pc)) continue;
          seen.add(pc);
          accNames.push((typeof _pcName === 'function') ? _pcName(pc) : String(pc));
        }
      }
      if (name) {
        span.textContent = '';
        span.appendChild(document.createTextNode(decorate(name, freqs)));
        if (accNames.length) {
          const acc = document.createElement('span');
          acc.className = 'wrap-accidental';
          acc.title = 'Outside the current scale';
          acc.textContent = ' ' + accNames.join(' ');
          span.appendChild(acc);
        }
        btn.classList.add('show-chord');
      } else {
        span.textContent = 'KEEP';
        btn.classList.remove('show-chord');
      }
    }
    // Back-compat alias — older call sites still reference the old name.
    const updateChordDisplay = updateKeepLabel;

    let loopMode = false;
    let noteLength = 1;
    let stepSubdivision = 0.5; // multiplier vs quarter note (1 = 1/4, 0.5 = 1/8, 0.25 = 1/16, 2 = 1/2, 4 = 1/1)
    let pendingChord = [];
    const cells = [];

    // Saved sequences — persisted to localStorage. SAFE-PARSE: a corrupt value
    // (e.g. a write truncated by a quota-exceeded error on WebKit / mobile Safari)
    // must NOT throw here — this is module-scope in a foundational file, so an
    // unguarded JSON.parse throw aborts the whole script and black-screens the app
    // ("header + black" on mobile only, because desktop's larger quota never
    // corrupts). Falls back to an empty bank; the next save overwrites the bad key.
    let savedSequences = (() => {
      try { const v = JSON.parse(localStorage.getItem('sounds-saved') || '[]'); return Array.isArray(v) ? v : []; }
      catch (e) { try { console.warn('Corrupt "sounds-saved" in localStorage — resetting.', e); } catch (_) {} return []; }
    })();
    let activeSeqIndex = null;

    // Saved wraps — independent bank of recently-committed Wrap steps so
    // the user can swap between recent chord / subsequence shapes without
    // re-building them. Persisted under its own localStorage key; each
    // entry holds a deep-cloned step (so editing the live wrapTemplate
    // never mutates the bank) plus an auto-name (A, B, C, …).
    let savedWraps = (() => {
      try { return JSON.parse(localStorage.getItem('wraps-saved') || '[]'); }
      catch { return []; }
    })();
    // User-defined "Prog" banks: named, ordered subsequences of User-bank
    // wraps saved as their own recallable bank. Each: { id, name, items:[{name,
    // step}] }. Persisted to localStorage (like savedWraps); surfaced in the
    // Wraps menu's "Prog" section and selected as wrapBank 'userprog:<id>'.
    let wrapProgs = (() => {
      try { return JSON.parse(localStorage.getItem('wraps-progs') || '[]'); }
      catch { return []; }
    })();
    // ID of the bank entry currently mirrored by wrapTemplate, so the
    // matching chip stays highlighted. Cleared whenever wrapTemplate
    // changes to something not minted by this bank.
    let activeWrapBankId = null;

    // Which wrap bank the chip row currently shows:
    //   'standard'  — generated chord-type palette (the default), every
    //                 CHORDS quality rooted at the live key root. Read-only.
    //   'user'      — the user-built savedWraps. Editable (save/delete/
    //                 reorder/clear all act here).
    //   'prog:<i>'  — one generated bank per standard progression for the
    //                 live key/scale (its chords become the chips). Read-only.
    // Generated banks are recall-only; building a wrap always lands in (and
    // switches the view to) 'user'.
    let wrapBank = 'user';   // 'user' or 'prog:<id>' (the Chords palette was removed)
    // Render-key of the active chip while a generated bank is showing —
    // generated chips have no savedWraps id, so this mirrors
    // activeWrapBankId's "keep the armed chip lit" role for them.
    let wrapGenActiveKey = null;

