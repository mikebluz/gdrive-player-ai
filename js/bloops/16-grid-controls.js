    // ---- Color presets ----
    function applyPianoPalette() {
      // Piano keys: pitch classes 1, 3, 6, 8, 10 are the black keys
      // (C#, D#, F#, G#, A#); the rest are white. Rest cell gets a
      // neutral grey so it doesn't fight the monochrome duotone.
      const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
      palette = Array.from({ length: 12 }, (_, i) =>
        BLACK_PCS.has(i) ? '#1a202c' : '#f7fafc'
      );
      restColor = 'hsl(0, 0%, 65%)';
      // Duotone grid would make chord/note chips read as just two
      // colours; give the chips a fresh random palette so the sequence
      // stays readable when the grid is monochrome.
      chipPalette = generateRandomPalette();
      applyRestColor();
      applyPalette();
      if (typeof renderSequence === 'function') renderSequence();
    }

    // ---- Colors dropdown ----
    // Pin a dropdown panel to the viewport beneath its trigger button.
    // The menubar's overflow-x makes any in-flow absolute child get clipped
    // vertically — using position: fixed bypasses that, but means we have
    // to (re)position the panel each open and on resize.
    function pinPanelToButton(btn, panel) {
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      panel.style.position = 'fixed';

      // Flip the panel above the trigger when there isn't enough room
      // below. Important for triggers that live near the bottom of the
      // viewport (e.g., the Project ▾ button on the new bottom bar):
      // a panel anchored below would either be clipped by the master-
      // scope strip or pushed off-screen entirely. Measure the panel
      // by clearing constraints first so the natural content height
      // drives the decision.
      panel.style.maxHeight = '';
      panel.style.top    = '0px';
      panel.style.bottom = 'auto';
      const naturalH = Math.min(
        panel.scrollHeight || panel.offsetHeight || 200,
        vh - 24
      );
      const spaceBelow = vh - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const flipUp = (spaceBelow < naturalH) && (spaceAbove > spaceBelow);

      if (flipUp) {
        // Anchor by the bottom of the viewport so the panel grows
        // upward from the trigger.
        panel.style.top    = 'auto';
        panel.style.bottom = (vh - rect.top + 4) + 'px';
        panel.style.maxHeight = Math.max(160, spaceAbove) + 'px';
      } else {
        panel.style.bottom = 'auto';
        panel.style.top    = (rect.bottom + 4) + 'px';
        panel.style.maxHeight = Math.max(160, spaceBelow) + 'px';
      }
      panel.style.overflowY = 'auto';
      // Smooth, momentum-based scrolling on iOS Safari — without this the
      // panel's internal scroll on mobile felt sticky / abrupt.
      panel.style.webkitOverflowScrolling = 'touch';

      // On mobile we let the panel span almost the full width — anchoring by
      // a single edge would push the opposite side off-screen, so set both
      // left and right and let the panel stretch with 8 px margins.
      if (vw <= 700) {
        panel.style.left = '8px';
        panel.style.right = '8px';
        return;
      }

      // Desktop: align with the trigger's left edge, but slide left if that
      // would push the panel's right edge past the viewport.
      const panelWidth = panel.offsetWidth || 320;
      const maxLeft = Math.max(8, vw - panelWidth - 8);
      const desiredLeft = Math.max(8, Math.min(rect.left, maxLeft));
      panel.style.left = desiredLeft + 'px';
      panel.style.right = 'auto';
    }

    (function initColorsMenu() {
      const btn = document.getElementById('colors-menu-btn');
      const panel = document.getElementById('colors-panel');
      if (!btn || !panel) return;
      const setOpen = (open) => {
        panel.classList.toggle('open', open);
        btn.classList.toggle('open', open);
        btn.textContent = open ? 'Colors ▴' : 'Colors ▾';
        if (open) pinPanelToButton(btn, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(btn, panel);
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panel.classList.contains('open');
        if (willOpen) document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: btn.id } }));
        setOpen(willOpen);
      });
      document.addEventListener('menubar-panel-open', (e) => {
        if (e.detail?.id !== btn.id && panel.classList.contains('open')) setOpen(false);
      });
      panel.querySelectorAll('.colors-opt').forEach(opt => {
        opt.addEventListener('click', () => {
          const mode = opt.dataset.mode;
          if (mode === 'shuffle') shuffleColors();
          else if (mode === 'piano') applyPianoPalette();
          setOpen(false);
        });
      });
      document.addEventListener('click', (e) => {
        if (!panel.classList.contains('open')) return;
        if (panel.contains(e.target) || e.target === btn) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });
    })();

    // ---- Voices menu (Save / Load / Surprise Me) ----
    function showVoicePickerDialog() {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Load voice</div>
        <div id="voice-picker-list" style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;margin-bottom:14px;">
          <div style="color:#4a4a6a;font-family:'Segoe UI',sans-serif;font-size:0.85rem;padding:12px 0;text-align:center;">Loading…</div>
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="voice-picker-cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      modal.querySelector('#voice-picker-cancel').addEventListener('click', () => overlay.remove());

      (async () => {
        const list = modal.querySelector('#voice-picker-list');
        try {
          await googleSignInForDrive();
          const folderId = await findOrCreateDriveFolder('bloops/projects');
          const all = await listProjectsInDrive(folderId);
          const voices = all.filter(f => /\.voice\..+\.json$/i.test(f.name));
          list.innerHTML = '';
          if (voices.length === 0) {
            list.innerHTML = `<div style="color:#4a4a6a;font-family:'Segoe UI',sans-serif;font-size:0.85rem;padding:12px 0;text-align:center;">No voices saved yet.</div>`;
            return;
          }
          voices.forEach(f => {
            const m = f.name.match(/^(.+)\.voice\.(.+)\.json$/i);
            const projectPart = m ? m[1] : '?';
            const voicePart   = m ? m[2] : f.name.replace(/\.json$/i, '');
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'picker-row';
            Object.assign(row.style, {
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px',
              width: '100%', textAlign: 'left', padding: '10px 12px', border: '1px solid #2d2d3f',
              borderRadius: '8px', background: 'transparent', color: '#e2e8f0',
              fontFamily: "'Segoe UI', sans-serif", cursor: 'pointer', transition: 'all 0.15s ease',
            });
            row.innerHTML = `
              <span style="font-size:0.85rem;font-weight:600;">${voicePart}</span>
              <span style="font-size:0.7rem;color:#4a4a6a;">${projectPart} · ${new Date(f.modifiedTime).toLocaleString()}</span>
            `;
            row.addEventListener('mouseenter', () => { row.style.borderColor = '#4299e1'; row.style.background = 'rgba(66,153,225,0.08)'; });
            row.addEventListener('mouseleave', () => { row.style.borderColor = '#2d2d3f'; row.style.background = 'transparent'; });
            row.addEventListener('click', async () => {
              row.disabled = true;
              row.querySelector('span').textContent = 'Loading…';
              try {
                const snap = await fetchProjectJson(f.id);
                applyVoiceSnapshot(snap);
                overlay.remove();
              } catch (err) {
                console.error(err);
                alert(`Load voice failed: ${err.message || err}`);
                row.disabled = false;
                row.querySelector('span').textContent = voicePart;
              }
            });
            list.appendChild(row);
          });
        } catch (e) {
          console.error(e);
          list.innerHTML = `<div style="color:#fc8181;font-family:'Segoe UI',sans-serif;font-size:0.85rem;padding:12px 0;text-align:center;">Couldn't load voices.</div>`;
        }
      })();
    }

    // Surprise Me — randomize root, scale, and per-cell tones for a quick
    // creative shuffle. Octaves and A4 are left alone so the grid stays at
    // a comfortable pitch range.
    function surpriseMeVoice() {
      snapshotForUndo('Surprise Me');
      rootIdx = Math.floor(Math.random() * 12);
      const allScales = Object.keys(SCALES || {}).filter(k => k && k !== 'chromatic');
      if (allScales.length > 0) {
        currentScale = allScales[Math.floor(Math.random() * allScales.length)];
      }
      const rootSel = document.getElementById('root-select');
      const scaleSel = document.getElementById('scale-select');
      if (rootSel)  rootSel.value  = String(rootIdx);
      if (scaleSel) scaleSel.value = currentScale;
      rebuildGrid();
      // Random tones — every available sound is fair game, including
      // samples. Each cell rolls independently, so the grid can end up
      // a mix of synth + sample tones.
      const tonePool = getAllSoundOptions().map(o => o.value);
      if (tonePool.length > 0 && cellSounds.length > 0) {
        for (let i = 0; i < cellSounds.length; i++) {
          const type = tonePool[Math.floor(Math.random() * tonePool.length)];
          cellSounds[i] = type;
          cellParams[i] = { ...cellParams[i], type };
        }
      }
      applyScale();
      refreshAllCellFreqLabels();
      updateScaleBanner();
    }

    // Surprise lives inside the Sounds dropdown now (below Tone… / FX…).
    // Clicking it fires the randomizer and collapses the Sounds panel —
    // same close-after-pick pattern as other items in the menu.
    document.getElementById('sounds-surprise')?.addEventListener('click', (e) => {
      e.stopPropagation();
      surpriseMeVoice();
      const soundsPanel = document.getElementById('grid-settings-panel');
      const banner = document.getElementById('scale-banner-half');
      if (soundsPanel) soundsPanel.classList.remove('open');
      if (banner) banner.classList.remove('open');
    });

    // ---- Saved grid states (root, scale, octaves, palette, cell sounds) ----
    let savedGridStates = JSON.parse(localStorage.getItem('sounds-grid-states') || '[]');
    function persistGridStates() {
      localStorage.setItem('sounds-grid-states', JSON.stringify(savedGridStates));
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function currentGridStateSnapshot(name) {
      return {
        name,
        rootIdx,
        baseOctave,
        octaveCount,
        masterFreqA,
        scale: currentScale,
        palette: [...palette],
        cellSounds: [...cellSounds],
        cellParams: cellParams.map(p => ({ ...p })),
        restColor,
      };
    }
    function applyGridState(state) {
      if (!state) return;
      if (state.rootIdx != null)     rootIdx     = state.rootIdx;
      if (state.baseOctave != null)  baseOctave  = state.baseOctave;
      if (state.octaveCount != null) octaveCount = state.octaveCount;
      if (state.masterFreqA != null) masterFreqA = state.masterFreqA;
      if (state.scale)               currentScale = normalizeScaleName(state.scale);
      if (Array.isArray(state.palette) && state.palette.length === 12) {
        palette = [...state.palette];
        chipPalette = [...palette];
      }
      if (state.restColor)           { restColor = state.restColor; applyRestColor(); }

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

      rebuildGrid();
      // After rebuild, cellSounds/cellParams are reset — restore from the
      // snapshot when the dimensions match (octaveCount → notes.length).
      if (Array.isArray(state.cellSounds) && state.cellSounds.length === cellSounds.length
          && Array.isArray(state.cellParams) && state.cellParams.length === cellParams.length) {
        cellSounds = [...state.cellSounds];
        cellParams = state.cellParams.map(p => ({ ...p }));
        refreshAllCellFreqLabels();
        updateScaleBanner();
      }
    }
    function refreshGridStateDropdown(selectedName = '') {
      const sel = document.getElementById('grid-state-select');
      const delBtn = document.getElementById('grid-state-delete-btn');
      if (!sel) return;
      sel.innerHTML = '<option value="">— Load a saved state —</option>';
      savedGridStates.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        sel.appendChild(opt);
      });
      sel.value = selectedName;
      if (delBtn) delBtn.disabled = !sel.value;
    }
    refreshGridStateDropdown();

    document.getElementById('grid-state-select').addEventListener('change', (e) => {
      const name = e.target.value;
      const delBtn = document.getElementById('grid-state-delete-btn');
      if (!name) { if (delBtn) delBtn.disabled = true; return; }
      const state = savedGridStates.find(s => s.name === name);
      if (state) applyGridState(state);
      if (delBtn) delBtn.disabled = false;
    });

    document.getElementById('grid-state-save-btn').addEventListener('click', () => {
      const name = (prompt('Name this grid state:') || '').trim();
      if (!name) return;
      const idx = savedGridStates.findIndex(s => s.name === name);
      const snap = currentGridStateSnapshot(name);
      if (idx >= 0) {
        if (!confirm(`A grid state named "${name}" already exists. Overwrite?`)) return;
        savedGridStates[idx] = snap;
      } else {
        savedGridStates.push(snap);
      }
      persistGridStates();
      refreshGridStateDropdown(name);
    });

    document.getElementById('grid-state-delete-btn').addEventListener('click', () => {
      const sel = document.getElementById('grid-state-select');
      if (!sel.value) return;
      const name = sel.value;
      if (!confirm(`Delete grid state "${name}"?`)) return;
      savedGridStates = savedGridStates.filter(s => s.name !== name);
      persistGridStates();
      refreshGridStateDropdown('');
    });

    document.getElementById('grid-reset-btn').addEventListener('click', () => {
      resetGridToDefault();
      // Shuffle palette right after — visual confirmation that the reset
      // happened, since defaults alone often look identical to the prior
      // state on screens that haven't been heavily customized.
      shuffleColors();
    });

    // Reset only the grid bits (not tracks / recording / preview state).
    function resetGridToDefault() {
      rootIdx = 0;
      baseOctave = 4;
      octaveCount = 1;
      masterFreqA = 440;
      currentScale = 'chromatic';
      palette = [...DEFAULT_PALETTE];
      chipPalette = [...palette];
      restColor = DEFAULT_REST_COLOR;
      applyRestColor();

      const rootSel   = document.getElementById('root-select');
      const octRange  = document.getElementById('octave-range-select');
      const freqSl    = document.getElementById('master-freq-slider');
      const freqIn    = document.getElementById('master-freq-input');
      const scaleSel  = document.getElementById('scale-select');
      if (rootSel)   rootSel.value   = '0';
      if (octRange)  octRange.value  = '4x1';
      if (freqSl)    freqSl.value    = '440';
      if (freqIn)    freqIn.value    = '440';
      if (scaleSel)  scaleSel.value  = 'chromatic';

      rebuildGrid({ resetTones: true });
    }

    // Populate a <select> with the full scale catalog grouped into <optgroup>s.
    // Shared by the main Scale picker and Bloom's per-layer Scale dropdowns so
    // both read the same way. Order matters: the "Standard" group (the scales
    // people reach for first — major, minor and their pentatonic/blues cousins)
    // sits at the top, then the church modes, then keyword buckets, then
    // everything else alphabetized. Explicit names are filtered against the
    // catalog so a name Tonal drops in a future version just silently disappears
    // rather than rendering a dead option. `firstOption` ({value,label}), if
    // given, is prepended as a plain <option> (e.g. Bloom's "Workspace scale").
    function populateGroupedScaleSelect(scaleSelect, firstOption) {
      if (!scaleSelect) return;
      if (firstOption) {
        const op = document.createElement('option');
        op.value = firstOption.value; op.textContent = firstOption.label;
        scaleSelect.appendChild(op);
      }
      const has  = (n) => SCALES[n] != null;
      const used = new Set();
      const addOpt = (parent, name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = prettyScaleName(name);
        parent.appendChild(opt);
        used.add(name);
      };
      const addGroup = (label, names) => {
        const present = names.filter(n => has(n) && !used.has(n));
        if (!present.length) return;
        const og = document.createElement('optgroup');
        og.label = label;
        present.forEach(n => addOpt(og, n));
        scaleSelect.appendChild(og);
      };
      // Ordered "headline" groups.
      addGroup('Standard', [
        'chromatic', 'major', 'minor', 'harmonic minor', 'melodic minor',
        'major pentatonic', 'minor pentatonic',
        'blues', 'major blues', 'minor blues',
      ]);
      addGroup('Modes', [
        'ionian', 'dorian', 'phrygian', 'lydian',
        'mixolydian', 'aeolian', 'locrian',
      ]);
      // 12-note alternate tunings (just intonation, Pythagorean, etc.) —
      // these retune the grid cells rather than just highlighting them.
      addGroup('Microtonal',
        (typeof MICRO_TUNINGS !== 'undefined') ? Object.keys(MICRO_TUNINGS) : []);
      // Keyword buckets over whatever's left, each alphabetized.
      const rest = () => Object.keys(SCALES).filter(n => !used.has(n));
      const bucket = (re) => rest().filter(n => re.test(n)).sort();
      addGroup('Pentatonic & Blues', bucket(/pentatonic|blues/));
      addGroup('Bebop', bucket(/bebop/));
      addGroup('Symmetric', bucket(/whole tone|augmented|diminished|messiaen/));
      // Everything still unplaced, alphabetized.
      addGroup('More Scales', rest().sort());
    }

    // ---- Grid controls ----
    (function initGridControls() {
      const rootSelect = document.getElementById('root-select');
      CHROMATIC.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = name;
        rootSelect.appendChild(opt);
      });
      rootSelect.value = String(rootIdx);
      rootSelect.addEventListener('change', () => {
        const _oldRoot = rootIdx;
        rootIdx = parseInt(rootSelect.value) || 0;
        // Explicit root pick re-anchors the scale's tonic too — the
        // user is saying "this is the new key root". Scale-degree
        // shifts diverge _scaleTonic from rootIdx separately later.
        _scaleTonic = (currentScale && currentScale !== 'chromatic') ? rootIdx : null;
        rebuildGrid();
        try { if (typeof _renderXyOverlay === 'function') _renderXyOverlay(); } catch (e) {}
        try { if (typeof refreshKeyButton === 'function') refreshKeyButton(); } catch (e) {}
        // Re-render saved wraps whenever the effective key changes —
        // both directions, including transitions to / from chromatic
        // (chromatic restores each wrap to its origin under the
        // immutable-origin model).
        if (_oldRoot !== rootIdx && typeof _rebaseSavedWraps === 'function') {
          try {
            const _oldKc = (currentScale && currentScale !== 'chromatic')
              ? { root: _oldRoot, scale: currentScale } : null;
            const _newKc = (currentScale && currentScale !== 'chromatic')
              ? { root: rootIdx, scale: currentScale } : null;
            _rebaseSavedWraps(_oldKc, _newKc);
          } catch (e) {}
        }
      });

      // Single dropdown that captures both base octave and octave count as
      // "BxC" — 7x7 = 49 options. Replaces the old pair of number inputs.
      const octaveRangeSelect = document.getElementById('octave-range-select');
      for (let b = 1; b <= 7; b++) {
        for (let c = 1; c <= 7; c++) {
          const opt = document.createElement('option');
          opt.value = `${b}x${c}`;
          opt.textContent = `${b}×${c}`;
          octaveRangeSelect.appendChild(opt);
        }
      }
      octaveRangeSelect.value = `${baseOctave}x${octaveCount}`;
      octaveRangeSelect.addEventListener('change', () => {
        const [b, c] = octaveRangeSelect.value.split('x').map(n => parseInt(n, 10) || 0);
        if (b >= 1 && b <= 7) baseOctave = b;
        if (c >= 1 && c <= 7) octaveCount = c;
        rebuildGrid();
      });
      // Helper used by the rest of the codebase to push state-driven
      // baseOctave / octaveCount values back into the dropdown UI.
      window.syncOctaveRangeSelect = () => {
        const sel = document.getElementById('octave-range-select');
        if (sel) sel.value = `${baseOctave}x${octaveCount}`;
      };

      const scaleSelect = document.getElementById('scale-select');
      populateGroupedScaleSelect(scaleSelect);
      scaleSelect.value = currentScale;
      scaleSelect.addEventListener('change', () => {
        const _oldScale = currentScale;
        currentScale = scaleSelect.value;
        if (currentScale && currentScale !== 'chromatic') {
          try { _writeLastKeyScale(currentScale); } catch (e) {}
        }
        // Re-anchor the scale's tonic on the current grid root. Picking
        // a new scale starts fresh — any prior degree-shift divergence
        // is cleared. Chromatic clears the tonic entirely.
        _scaleTonic = (currentScale && currentScale !== 'chromatic') ? rootIdx : null;
        applyScale();
        // Microtonal tunings re-pitch the actual grid cells (not just the
        // in-scale highlighting applyScale does), so when ENTERING or
        // LEAVING one, recompute notes and repaint. Plain 12-TET ↔ 12-TET
        // scale swaps skip this — nothing about the pitches changed.
        try {
          const _micro = (typeof MICRO_TUNINGS !== 'undefined') ? MICRO_TUNINGS : null;
          if (_micro && (_micro[_oldScale] || _micro[currentScale])) {
            if (typeof rebuildGrid === 'function') rebuildGrid();
            if (typeof renderSequence === 'function') renderSequence();
          }
        } catch (e) {}
        // Re-render XY pad guide lines so they follow the workspace
        // scale when Grid Off is active. Cheap no-op in Grid On mode.
        try { if (typeof _renderXyOverlay === 'function') _renderXyOverlay(); } catch (e) {}
        try { if (typeof refreshKeyButton === 'function') refreshKeyButton(); } catch (e) {}
        // Re-render saved wraps. Always called (including transitions
        // TO chromatic) so the immutable-origin model can restore
        // each wrap to its original committed form whenever the
        // effective key removes its constraints.
        if (_oldScale !== currentScale && typeof _rebaseSavedWraps === 'function') {
          try {
            const _oldKc = (_oldScale && _oldScale !== 'chromatic')
              ? { root: rootIdx, scale: _oldScale } : null;
            const _newKc = (currentScale && currentScale !== 'chromatic')
              ? { root: rootIdx, scale: currentScale } : null;
            _rebaseSavedWraps(_oldKc, _newKc);
          } catch (e) {}
        }
      });

      const freqSlider = document.getElementById('master-freq-slider');
      const freqInput  = document.getElementById('master-freq-input');
      function applyMasterFreq(newA) {
        newA = Math.max(400, Math.min(480, Math.round(newA) || 440));
        if (newA === masterFreqA) return;
        const ratio = newA / masterFreqA;
        masterFreqA = newA;
        freqSlider.value = newA;
        freqInput.value = newA;
        sequence.forEach(step => {
          if (step.chord) step.chord.forEach(n => { n.freq *= ratio; });
          else if (step.freq != null) step.freq *= ratio;
        });
        pendingChord.forEach(n => { n.freq *= ratio; });
        rebuildGrid();
        renderSequence();
      }
      freqSlider.addEventListener('input', () => { freqInput.value = freqSlider.value; });
      freqSlider.addEventListener('change', () => applyMasterFreq(parseInt(freqSlider.value)));
      freqInput.addEventListener('change', () => applyMasterFreq(parseInt(freqInput.value)));

      // Game-mode Key select — mirrors the hidden root-select. Re-uses
      // the canonical change handler so scale-tonic reset, rebuildGrid,
      // _renderXyOverlay, refreshKeyButton, _rebaseSavedWraps, etc. all
      // run the same way they do for the ± buttons or the legacy
      // dropdown.
      const gameKeySel = document.getElementById('game-key-select');
      if (gameKeySel && typeof CHROMATIC !== 'undefined') {
        CHROMATIC.forEach((name, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = name;
          gameKeySel.appendChild(opt);
        });
        gameKeySel.value = String(rootIdx);
        gameKeySel.addEventListener('change', () => {
          const v = parseInt(gameKeySel.value, 10);
          if (!Number.isFinite(v)) return;
          const rootSel = document.getElementById('root-select');
          if (rootSel) {
            rootSel.value = String(v);
            rootSel.dispatchEvent(new Event('change'));
          }
        });
      }

      // Chords chip-builder — Root + Quality dropdowns side by side.
      // Hits dropdown is gated on having ≥2 chords (no mutation needed
      // with 0 or 1).
      // Pick a root from the active scale (chromatic = all 12 pitches),
      // then pick a quality to append a {rootPC, quality} chip. The
      // active chord lights up via .progression-chip.active, repainted
      // whenever _gameRefresh fires (also where progression mutation
      // happens).
      const progRoot  = document.getElementById('progression-root');
      const progAdd   = document.getElementById('progression-add');
      const progChips = document.getElementById('progression-chips');
      const progClear = document.getElementById('progression-clear');

      function _scalePCs() {
        const intervals = (SCALES && SCALES[currentScale]) || (SCALES && SCALES['chromatic']) || [];
        const tonic = (typeof _effectiveScaleTonic === 'function')
          ? _effectiveScaleTonic()
          : (typeof rootIdx === 'number' ? rootIdx : 0);
        return intervals.map(s => (((tonic + s) % 12) + 12) % 12);
      }
      function _populateProgressionRoot() {
        if (!progRoot) return;
        const prev = parseInt(progRoot.value, 10);
        progRoot.innerHTML = '';
        const pcs = _scalePCs();
        // Walk through pcs in ascending order from the tonic so the
        // dropdown reads root → 2nd → 3rd → ...
        for (const pc of pcs) {
          const opt = document.createElement('option');
          opt.value = String(pc);
          opt.textContent = CHROMATIC[pc] || '';
          progRoot.appendChild(opt);
        }
        // Restore previous pick if still in scale, else default to grid root,
        // else first available.
        if (Number.isFinite(prev) && pcs.includes(prev)) progRoot.value = String(prev);
        else if (pcs.includes(rootIdx)) progRoot.value = String(rootIdx);
        else if (pcs.length > 0) progRoot.value = String(pcs[0]);
      }
      function _renderProgressionChips() {
        if (!progChips) return;
        progChips.innerHTML = '';
        try { if (typeof window._updateHitsEnabled === 'function') window._updateHitsEnabled(); } catch (_) {}
        const len = currentProgression.length;
        const activeIdx = len > 0 ? (((_gameProgressionIdx % len) + len) % len) : -1;
        currentProgression.forEach((rawChip, i) => {
          const chip = document.createElement('span');
          chip.className = 'progression-chip' + (i === activeIdx ? ' active' : '');
          chip.textContent = _chipLabel(rawChip);
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'progression-chip-remove';
          x.textContent = '×';
          x.title = 'Remove';
          x.addEventListener('click', () => {
            currentProgression.splice(i, 1);
            _gameProgressionIdx = 0;
            _gameProgressionHits = 0;
            _renderProgressionChips();
            try { if (typeof _gameRefresh === 'function' && _gameInited) _gameRefresh(); } catch (e) {}
          });
          chip.appendChild(x);
          progChips.appendChild(chip);
        });
      }
      if (progAdd && typeof CHORDS !== 'undefined') {
        for (const key of Object.keys(CHORDS)) {
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = CHORDS[key].label;
          progAdd.appendChild(opt);
        }
        progAdd.addEventListener('change', () => {
          const key = progAdd.value;
          if (key && CHORDS[key]) {
            const rootPC = parseInt(progRoot && progRoot.value, 10);
            const safe = Number.isFinite(rootPC) ? rootPC : (rootIdx || 0);
            currentProgression.push({ rootPC: safe, quality: key });
            _gameProgressionIdx = 0;
            _gameProgressionHits = 0;
            _renderProgressionChips();
            try { if (typeof _gameRefresh === 'function' && _gameInited) _gameRefresh(); } catch (e) {}
          }
          progAdd.value = '';
        });
      }
      if (progClear) {
        progClear.addEventListener('click', () => {
          if (currentProgression.length === 0) return;
          currentProgression = [];
          _gameProgressionIdx = 0;
          _gameProgressionHits = 0;
          _renderProgressionChips();
          try { if (typeof _gameRefresh === 'function' && _gameInited) _gameRefresh(); } catch (e) {}
        });
      }
      _populateProgressionRoot();
      // Expose globally so _gameRefresh can re-paint the active highlight
      // and the root dropdown whenever scale / root state changes.
      const hitsSel = document.getElementById('hits-per-chord');
      function _updateHitsEnabled() {
        if (hitsSel) hitsSel.disabled = currentProgression.length < 2;
      }
      if (hitsSel) {
        const initial = parseInt(hitsSel.value, 10);
        if (Number.isFinite(initial) && initial >= 1) _gameUserHitsPerChord = initial;
        hitsSel.addEventListener('change', () => {
          const v = parseInt(hitsSel.value, 10);
          if (Number.isFinite(v) && v >= 1) _gameUserHitsPerChord = v;
        });
      }
      window._renderProgressionChips = _renderProgressionChips;
      window._populateProgressionRoot = _populateProgressionRoot;
      window._updateHitsEnabled = _updateHitsEnabled;
      _renderProgressionChips();
      _updateHitsEnabled();
    })();

    // ---- Grid settings dropdown toggle ----
    // Sounds panel = Scale settings + nested entry points to Tone and FX.
    // The Sounds banner doubles as the trigger; the Tone… / FX… rows
    // inside the panel close Sounds and re-anchor the corresponding
    // sub-panel to the Sounds button.
    (function initSoundsSubmenus() {
      const soundsPanel = document.getElementById('grid-settings-panel');
      const banner = document.getElementById('scale-banner-half');
      const toneSubBtn = document.getElementById('sounds-open-tone');
      const fxSubBtn = document.getElementById('sounds-open-fx');
      const tonePanel = document.getElementById('tone-panel');
      const fxPanel = document.getElementById('fx-panel');
      if (!banner) return;
      const openSubPanel = (subPanel, triggerId) => {
        // Close Sounds and any other sibling menubar panels — same event
        // the existing tone/fx menus listen for.
        if (soundsPanel) {
          soundsPanel.classList.remove('open');
          banner.classList.remove('open');
        }
        document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: triggerId } }));
        if (!subPanel) return;
        // For Tone, the panel needs its option list re-populated each
        // time it opens (mirrors initToneMenu's setOpen). populateTonePanel
        // is hoisted in module scope so we can call it directly.
        if (triggerId === 'tone-banner-half' && typeof populateTonePanel === 'function') {
          try { populateTonePanel(); } catch (e) {}
        }
        subPanel.classList.add('open');
        pinPanelToButton(banner, subPanel);
      };
      if (toneSubBtn) toneSubBtn.addEventListener('click', (e) => {
        // Stop propagation so the document-level "click outside ⇒ close"
        // handlers on the tone-panel don't immediately re-close it after
        // we open it.
        e.stopPropagation();
        openSubPanel(tonePanel, 'tone-banner-half');
      });
      if (fxSubBtn) fxSubBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSubPanel(fxPanel, 'fx-banner');
      });
    })();

    // The left half of the scale banner doubles as the trigger — it already
    // shows the live root + scale, so making it clickable gives the user one
    // obvious place to open the panel that adjusts those.
    (function initGridSettingsToggle() {
      const banner = document.getElementById('scale-banner-half');
      const panel = document.getElementById('grid-settings-panel');
      if (!banner || !panel) return;
      const TRIGGER_ID = 'scale-banner-half';
      const setOpen = (open) => {
        panel.classList.toggle('open', open);
        banner.classList.toggle('open', open);
        if (open) pinPanelToButton(banner, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(banner, panel);
      });
      banner.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panel.classList.contains('open');
        if (willOpen) document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: TRIGGER_ID } }));
        setOpen(willOpen);
      });
      document.addEventListener('menubar-panel-open', (e) => {
        if (e.detail?.id !== TRIGGER_ID && panel.classList.contains('open')) setOpen(false);
      });
      document.addEventListener('click', (e) => {
        if (!panel.classList.contains('open')) return;
        if (panel.contains(e.target) || banner.contains(e.target)) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });
    })();

    // ---- Rest bar ----
    // The right-side Rest button adds a rest step. Both rest-bar
    // elements share the class so the playback active-loop highlight
    // could highlight any future copies as well.
    const restBars = document.querySelectorAll('.rest-bar');
    restBars.forEach(rb => {
      rb.addEventListener('click', () => {
        restBars.forEach(b => b.classList.add('flash'));
        setTimeout(() => restBars.forEach(b => b.classList.remove('flash')), 80);
        // Fixed-mode sequential write — REST counts as a valid "note"
        // press in the spec ("the next grid press (including rest) sets
        // that step to be that note"). Writes a rest into the current
        // slot and advances the selection.
        if (_fixedSeqActive && stepMode && keepMode) {
          const restStep = { freq: null, label: '—', cellIndex: null, duration: 1, subdivision: stepSubdivision };
          _fixedSeqWrite(restStep);
          return;
        }
        // duration:1 matches makeRestStep + every cell-add path. Earlier
        // this read `noteLength` (the legacy Hold multiplier), so any
        // session that inherited a saved noteLength > 1 would render
        // rests wider than notes — chips downstream got pushed onto the
        // wrong sub-cells in the grid layout.
        const restStep = { freq: null, label: '—', cellIndex: null, duration: 1, subdivision: stepSubdivision };
        addToSequence(restStep);
        // Same Keep-flow step-div picker as note presses — gated by
        // maybePromptStepDiv to Spell/Stack + Keep on (Run is skipped
        // and Keep-off REST presses fall through with no prompt).
        maybePromptStepDiv(restStep);
      });
    });

    // ---- Lock button (left of BPM) ----
    // Click toggles keepMode. While a wrap is active, press-and-hold
    // opens a small menu with "Shift tonic" — cycles through the wrap's
    // notes so each can be treated as the chord root, updating the
    // shorthand chord name shown on the button.
    (function bindPlayLockButton() {
      const btn = document.getElementById('play-lock-btn');
      if (!btn) return;
      const refresh = () => btn.classList.toggle('active', keepMode);
      refresh();
      const isWrapActive = () =>
        chordMode || !!wrapTemplate || !!_wrapTransposeDisplayStep;
      let lpt = null;
      let longPressFired = false;
      btn.addEventListener('pointerdown', (e) => {
        longPressFired = false;
        if (!isWrapActive()) return;
        const x = e.clientX, y = e.clientY;
        lpt = setTimeout(() => {
          lpt = null;
          longPressFired = true;
          navigator.vibrate?.(40);
          const orderedPcs = wrapPcsInBuildOrder();
          if (orderedPcs.length < 2) return;
          showCtxMenu(x, y, [
            { label: 'Shift tonic', fn: () => {
                _wrapTonicShift = (_wrapTonicShift + 1) % orderedPcs.length;
                updateKeepLabel();
            }},
          ]);
        }, 500);
      });
      const cancelLpt = () => { clearTimeout(lpt); lpt = null; };
      btn.addEventListener('pointerup',     cancelLpt);
      btn.addEventListener('pointercancel', cancelLpt);
      btn.addEventListener('pointermove',   cancelLpt);
      btn.addEventListener('contextmenu',   (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        // Long-press already opened the tonic menu — the click that
        // follows pointerup shouldn't ALSO toggle keepMode.
        if (longPressFired) {
          longPressFired = false;
          return;
        }
        keepMode = !keepMode;
        // Resetting on every Keep flip means a fresh on-cycle always
        // re-prompts for step-div on the first note (per the user's
        // session-lock semantics).
        _keepStepDivLocked = false;
        _keepStepDivLockedValue = null;
        if (keepMode) {
          // Fresh session — start collecting kept notes.
          _keepSessionSteps = [];
        } else {
          // Keep-off: offer one step-div menu over everything just kept —
          // but only when per-note prompting is off (otherwise the user has
          // already sized each note as they went).
          const kept = _keepSessionSteps.slice();
          _keepSessionSteps = [];
          if (!_keepAskPerNote && kept.length && typeof showKeepStepDivMenu === 'function') {
            showKeepStepDivMenu(kept);
          }
        }
        // Fixed-mode sequential edit: Keep-on while stepMode is on
        // selects the first step in the active lane and starts the
        // advance flow; Keep-off cancels it (clears selection).
        if (stepMode && keepMode) _fixedSeqStart();
        else if (!keepMode) _fixedSeqCancel();
        refresh();
      });
    })();

    // ---- Perform button — real-time record-what-you-play mode ----
    // Pressing PERF (while idle) opens a config popover: choose a start mode
    // (Listen = wait for first note, or Count-in = N bars of click then
    // record) plus quantize + resolution. Pressing PERF while armed disarms.
    (function bindPerformButton() {
      const btn = document.getElementById('perform-btn');
      const pop = document.getElementById('perform-popover');
      const qz = document.getElementById('perform-quantize');
      const res = document.getElementById('perform-resolution');
      const listenBtn = document.getElementById('perform-listen-btn');
      const countinBtn = document.getElementById('perform-countin-btn');
      const barsEl = document.getElementById('perform-countin-bars');
      if (!btn) return;
      const refresh = () => btn.classList.toggle('active', performMode);
      const closePop = () => { if (pop) pop.hidden = true; };
      const openPop = () => { if (pop) pop.hidden = false; };
      refresh();

      // N bars of metronome click, then fire onStart on the downbeat after.
      const runCountIn = (bars, onStart) => {
        const bpm = parseInt(tempoInput?.value, 10) || 120;
        const beatSec = 60 / bpm;
        const beats = Math.max(1, bars | 0) * 4;
        const synth = (typeof _getMetronomeSynth === 'function') ? _getMetronomeSynth() : null;
        const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
        const t0 = now + 0.12;
        if (synth) {
          for (let i = 0; i < beats; i++) {
            try { synth.triggerAttackRelease(i % 4 === 0 ? 'C6' : 'C5', '32n', t0 + i * beatSec); } catch (e) {}
          }
        }
        const delayMs = ((t0 - now) + beats * beatSec) * 1000;
        setTimeout(() => { try { onStart(); } catch (e) {} }, Math.max(0, delayMs));
      };

      const arm = (countInBars) => {
        performMode = true;
        _performEmittedUnits = 0;
        closePop();
        refresh();
        try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
        if (countInBars > 0) {
          _performCountingIn = true;
          _performStartMs = null;
          if (typeof showToast === 'function') showToast('Perform: counting in…');
          runCountIn(countInBars, () => {
            if (!performMode) return; // disarmed during count-in
            _performCountingIn = false;
            _performStartMs = performance.now(); // recording anchor = end of count-in
            // Start the lanes the instant recording starts, so the take
            // overdubs in time with playback.
            try { if (typeof playSequence === 'function') playSequence(); } catch (e) {}
            if (typeof showToast === 'function') showToast('Perform: recording…');
          });
        } else {
          _performCountingIn = false;
          _performStartMs = null; // first played note anchors the timeline
          if (typeof showToast === 'function') showToast('Perform: listening — play to record.');
        }
      };
      const disarm = () => {
        performMode = false; _performCountingIn = false;
        closePop(); refresh();
      };

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (performMode) { disarm(); return; }
        // Entering Perform: stop any running playback (safe no-op if idle).
        // Playback restarts when recording actually begins (first note /
        // post-count-in) so the take overdubs in sync.
        try { if (typeof stopSequence === 'function') stopSequence(); } catch (e) {}
        if (pop && pop.hidden) openPop(); else closePop();
      });
      if (listenBtn) listenBtn.addEventListener('click', () => arm(0));
      if (countinBtn) countinBtn.addEventListener('click', () => arm(Math.max(1, parseInt(barsEl?.value, 10) || 1)));
      if (qz) qz.addEventListener('change', () => { performQuantize = !!qz.checked; });
      if (res) res.addEventListener('change', () => { performResolution = parseFloat(res.value) || 0.25; });
      // Close the popover on outside click / Escape.
      document.addEventListener('click', (e) => {
        if (!pop || pop.hidden) return;
        if (pop.contains(e.target) || e.target === btn) return;
        closePop();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
    })();

    // ---- All-lane edit mode ----
    // Walks every step in the active lane and writes the given value
    // onto the matching leaf params field. Used both at toggle-on
    // (to broadcast the slider's current value lane-wide) and from
    // each slider's input handler while All mode is active. Sub /
    // chord steps fan out via _forEachStepLeaf so nested voices
    // pick up the same value the leaf-level params do.
    function _applyValueToAllLaneSteps(field, value) {
      if (!Array.isArray(lanes) || !lanes[activeLaneIdx]) return;
      const laneSteps = lanes[activeLaneIdx].steps || [];
      laneSteps.forEach(top => {
        if (!top) return;
        _forEachStepLeaf(top, leaf => {
          if (!leaf || leaf.isSub) return;
          if (!leaf.params) leaf.params = {};
          leaf.params[field] = value;
          if (Array.isArray(leaf.chord)) {
            leaf.chord.forEach(voice => {
              if (!voice) return;
              if (!voice.params) voice.params = {};
              voice.params[field] = value;
            });
          }
        });
      });
    }
    // Snapshot for undo when the user *starts* a drag in All mode
    // (slider 'change' fires on release; we want the pre-drag state
    // on the stack). Tracks a per-slider flag so we don't push a new
    // snapshot for every input event during one drag.
    const _allDragSnapshot = { pan: false, volume: false, slip: false };
    function _startAllLaneEdit(field) {
      if (!_allLaneMode) return;
      if (_allDragSnapshot[field]) return;
      _allDragSnapshot[field] = true;
      try { snapshotForUndo('Lane ' + field + ' (All)'); } catch (e) {}
    }
    function _endAllLaneEdit(field) {
      _allDragSnapshot[field] = false;
    }

    // ---- "All" button — toggle lane-wide slider broadcast ----
    document.getElementById('step-all-btn')?.addEventListener('click', () => {
      const turningOn = !_allLaneMode;
      // Snapshot the pre-broadcast state only when ENABLING — that's
      // when step values change. Disabling just flips a UI flag with
      // no audio-data mutation, so undoing past it would be a no-op
      // on the step array and confuse the redo stack.
      if (turningOn) {
        try { snapshotForUndo('Enable All-lane edit'); } catch (e) {}
      }
      _allLaneMode = turningOn;
      if (turningOn) {
        // Apply the sliders' current values to every step in the
        // active lane immediately so the broadcast takes effect on
        // toggle-on (matches "applies current values of those faders
        // to all steps in that lane").
        const panSliderEl  = document.getElementById('step-pan-slider');
        const volSliderEl  = document.getElementById('step-vol-slider');
        const slipSliderEl = document.getElementById('step-slip-slider');
        if (panSliderEl) {
          const v = Math.max(-100, Math.min(100, parseInt(panSliderEl.value, 10) || 0));
          _applyValueToAllLaneSteps('pan', v);
        }
        if (volSliderEl) {
          const v = Math.max(0, Math.min(100, parseInt(volSliderEl.value, 10) || 0));
          _applyValueToAllLaneSteps('volume', v);
        }
        if (slipSliderEl) {
          const v = Math.max(-50, Math.min(50, parseInt(slipSliderEl.value, 10) || 0));
          _applyValueToAllLaneSteps('slip', v);
        }
        renderSequence();
      }
      // Refresh the editor so the All button paints active + the
      // edit row picks up the all-mode color theme.
      try { syncStepEditorFromSelection(); } catch (e) {}
      if (typeof persistWorkspace === 'function') persistWorkspace();
    });

    // ---- Step Edit button ----
    // Opens the step ctx menu for the primary selected step. Uses the
    // same action list as the (now-removed) press-and-hold menu, just
    // anchored to the button's position.
    document.getElementById('step-edit-btn')?.addEventListener('click', (e) => {
      // Match the Edit row's eligibility — chord and sub-sequence
      // chips qualify too, and _buildStepCtxActions already builds
      // sub-aware menu entries (Edit subsequence…, Reverse, etc.).
      const eligible = selectedStepRefs.filter(_stepHasPlayableContent);
      // Prefer a playable chip; fall back to any selected chip (e.g. a rest)
      // so its menu — including Remove step — is still reachable.
      const step = eligible[eligible.length - 1] || selectedStepRefs[selectedStepRefs.length - 1];
      if (!step) return;
      const stepIdx = sequence.indexOf(step);
      if (stepIdx < 0) return;
      const actions = _buildStepCtxActions(stepIdx);
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      // Anchor the menu at the button's right edge so it opens
      // alongside the sliders rather than overlapping the button.
      showCtxMenu(rect.right + 6, rect.top, actions);
    });

    // ---- Selected-step pan slider ----
    // Live-updates the pan of every selected step as the user drags;
    // the row's visibility is driven by syncStepEditorFromSelection.
    (function bindStepPanSlider() {
      const slider = document.getElementById('step-pan-slider');
      const valEl  = document.getElementById('step-pan-val');
      if (!slider) return;
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10) || 0;
        if (_allLaneMode) {
          _startAllLaneEdit('pan');
          _applyValueToAllLaneSteps('pan', Math.max(-100, Math.min(100, v)));
          // Don't re-render mid-drag — renderSequence rebuilds the
          // active lane row, which forces _placeLaneExpander to
          // reparent #lane-expander above the new row. On iOS Safari
          // moving the slider's ancestor mid-touch cancels the drag,
          // so the thumb appears unresponsive. Tints catch up on the
          // change handler below when the touch ends.
        } else {
          applyPanToSelectedSteps(v);
        }
        if (valEl) valEl.textContent = formatPanLabel(v);
      });
      slider.addEventListener('change', () => {
        _endAllLaneEdit('pan');
        // Repaint chip tints to reflect the post-drag pan values
        // (skipped during input to keep the touch drag smooth).
        if (_allLaneMode) renderSequence();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // ---- Selected-step volume slider ----
    // Edits the primary (last-selected) step's volume in Mono so users
    // can shape dynamics without retouching every chip in a multi-
    // selection. In Poly with no selection, the active lane is the
    // implicit target — applies to every step in that lane.
    (function bindStepVolSlider() {
      const slider = document.getElementById('step-vol-slider');
      const valEl  = document.getElementById('step-vol-val');
      if (!slider) return;
      slider.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, parseInt(slider.value, 10) || 0));
        if (_allLaneMode) {
          _startAllLaneEdit('volume');
          _applyValueToAllLaneSteps('volume', v);
          if (valEl) valEl.textContent = v + '%';
          return;
        }
        // Eligibility now matches the Edit row's: chord and sub-sequence
        // chips qualify too, so the volume slider isn't quietly hidden
        // for them. _forEachStepLeaf below fans the write down to a
        // sub's children so each fired voice picks up the new volume.
        const selEligible = selectedStepRefs.filter(_stepHasPlayableContent);
        // Poly + no selection: drive the lane's Volume node directly.
        // Same reasoning as pan — sample-type tones bypass per-note
        // volume baked into params, but the lane Volume node sits
        // upstream of the lane's Panner so it scales every voice.
        if (selEligible.length === 0 && polyMode && lanes[activeLaneIdx]) {
          const lane = lanes[activeLaneIdx];
          lane.volume = v;
          getLaneBus(activeLaneIdx);
          try {
            const volNorm = Math.max(0, Math.min(1, v / 100));
            lane._volume.volume.value = volNorm <= 0 ? -Infinity : Tone.gainToDb(volNorm);
          } catch (e) {}
          if (valEl) valEl.textContent = v + '%';
          return;
        }
        // Selection-scoped volume — applies to every selected chip
        // (Multi on or off). Previously this only edited the primary
        // chip (last entry of selEligible), so a Multi-mode volume
        // drag silently moved one chip while leaving the others put.
        // Pan and Slip already fan out across every selected ref;
        // bring Volume in line with them.
        selEligible.forEach(top => {
          _forEachStepLeaf(top, leaf => {
            if (!leaf || leaf.isSub) return;
            if (!leaf.params) leaf.params = {};
            leaf.params.volume = v;
            if (Array.isArray(leaf.chord)) {
              leaf.chord.forEach(voice => {
                if (!voice) return;
                if (!voice.params) voice.params = {};
                voice.params.volume = v;
              });
            }
          });
        });
        if (valEl) valEl.textContent = v + '%';
      });
      slider.addEventListener('change', () => {
        _endAllLaneEdit('volume');
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // ---- Selected-step slip slider ----
    // Slip shifts each step's fire time forward (positive) or
    // backwards (negative) within its slot, expressed as a percent of
    // the step's duration. The slot itself doesn't move, so the next
    // step still fires at its original grid position — only the
    // slipped step's attack is offset.
    (function bindStepSlipSlider() {
      const slider = document.getElementById('step-slip-slider');
      const valEl  = document.getElementById('step-slip-val');
      if (!slider) return;
      slider.addEventListener('input', () => {
        const v = Math.max(-50, Math.min(50, parseInt(slider.value, 10) || 0));
        if (_allLaneMode) {
          _startAllLaneEdit('slip');
          _applyValueToAllLaneSteps('slip', v);
          if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v + '%';
          return;
        }
        const selEligible = selectedStepRefs.filter(_stepHasPlayableContent);
        if (selEligible.length === 0 && polyMode && lanes[activeLaneIdx]) {
          // Lane-scope slip — shifts every step in the active lane by
          // the same percent. Stored on the lane so selection-level
          // edits don't fight it.
          lanes[activeLaneIdx].slip = v;
        } else if (selEligible.length > 0) {
          // Selection-scope slip — per-step. Stored on step.params so
          // it survives clones / persistence the same as pan/vol. Sub
          // chips fan out to leaves so each child's fire time slips
          // by the same percent of its own duration; chord chips just
          // store on the parent (slip is read at the top scheduleStepAt
          // call, not per chord voice).
          selEligible.forEach(top => {
            _forEachStepLeaf(top, leaf => {
              if (!leaf || leaf.isSub) return;
              if (!leaf.params) leaf.params = {};
              leaf.params.slip = v;
            });
          });
        }
        if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v + '%';
      });
      slider.addEventListener('change', () => {
        _endAllLaneEdit('slip');
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // Strum slider — staggers a chord step's voices by N ms each. Stored on
    // the chord step's top-level `strum` (the scheduler reads it there, not
    // per-voice). Only the chord step(s) in the selection are touched.
    (function bindStepStrumSlider() {
      const slider = document.getElementById('step-strum-slider');
      const valEl  = document.getElementById('step-strum-val');
      if (!slider) return;
      slider.addEventListener('input', () => {
        const v = Math.max(-80, Math.min(80, parseInt(slider.value, 10) || 0));
        const selChords = selectedStepRefs.filter(s => s && Array.isArray(s.chord));
        selChords.forEach(s => { s.strum = v; });
        if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v + (v === 0 ? '' : ' ms');
      });
      slider.addEventListener('change', () => {
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // Ratchet (Roll) slider — splits the selected step(s) into N sub-hits.
    // Stored on the step's top-level `ratchet`.
    (function bindStepRatchetSlider() {
      const slider = document.getElementById('step-ratchet-slider');
      const valEl  = document.getElementById('step-ratchet-val');
      if (!slider) return;
      slider.addEventListener('input', () => {
        const v = Math.max(1, Math.min(8, parseInt(slider.value, 10) || 1));
        selectedStepRefs.filter(_stepHasPlayableContent).forEach(s => {
          if (v <= 1) delete s.ratchet; else s.ratchet = v;
        });
        if (valEl) valEl.textContent = v + '×';
      });
      slider.addEventListener('change', () => {
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // Chance (probability) slider — % chance the selected step(s) fire on
    // each loop pass. Stored on step.prob (100/unset = always).
    (function bindStepProbSlider() {
      const slider = document.getElementById('step-prob-slider');
      const valEl  = document.getElementById('step-prob-val');
      if (!slider) return;
      slider.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, parseInt(slider.value, 10)));
        selectedStepRefs.filter(_stepHasPlayableContent).forEach(s => {
          if (v >= 100) delete s.prob; else s.prob = v;
        });
        if (valEl) valEl.textContent = v + '%';
      });
      slider.addEventListener('change', () => {
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // When (conditional) — cycles which loop passes the step plays on.
    (function bindStepCondButton() {
      const btn = document.getElementById('step-cond-btn');
      if (!btn) return;
      const CONDS = ['always', '1st', '1:2', '2:2', '1:3', '1:4'];
      btn.addEventListener('click', () => {
        const sel = selectedStepRefs.filter(_stepHasPlayableContent);
        if (sel.length === 0) return;
        const cur = (typeof sel[0].cond === 'string' && sel[0].cond) ? sel[0].cond : 'always';
        const next = CONDS[(Math.max(0, CONDS.indexOf(cur)) + 1) % CONDS.length];
        sel.forEach(s => { if (next === 'always') delete s.cond; else s.cond = next; });
        btn.textContent = (next === 'always') ? 'Always' : next;
        btn.classList.toggle('active', next !== 'always');
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();

    // ---- Per-step editor tabs (Mix / Groove) ----
    (function bindStepTabs() {
      const tabs = Array.from(document.querySelectorAll('.step-tab[data-tab]'));
      const panels = Array.from(document.querySelectorAll('.step-tab-panel[data-panel]'));
      if (!tabs.length) return;
      tabs.forEach(tab => tab.addEventListener('click', () => {
        const want = tab.dataset.tab;
        tabs.forEach(t => {
          const on = t.dataset.tab === want;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panels.forEach(p => { p.hidden = p.dataset.panel !== want; });
      }));
    })();

    // ---- Per-step setting active/bypass toggles ----
    // The label of each step-editor bar is a button: click to bypass the
    // setting (its value is kept but the scheduler ignores it via step._off)
    // or re-activate it. Applies across the whole eligible selection,
    // flipping off the PRIMARY step's current state.
    function _setStepSettingBypass(step, key, off) {
      if (!step) return;
      if (off) { step._off = step._off || {}; step._off[key] = true; }
      else if (step._off) { delete step._off[key]; if (Object.keys(step._off).length === 0) delete step._off; }
    }
    document.querySelectorAll('.step-toggle[data-setting]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.setting;
        const sel = selectedStepRefs.filter(_stepHasPlayableContent);
        if (!sel.length) return;
        const primary = sel[sel.length - 1];
        const newBypass = !(primary._off && primary._off[key]);
        sel.forEach(s => _setStepSettingBypass(s, key, newBypass));
        try { syncStepEditorFromSelection(); } catch (e) {}
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    });


    // ---- Groove panel (swing / humanize) -------------------------------
    // A small popover off the ≈ transport button. Edits the global groove
    // state live; persistWorkspace (debounced) also invalidates in-flight
    // playback so a running loop picks up the new feel on its next steps.
    let _groovePanelEl = null;
    let _groovePanelOutside = null;
    function refreshGrooveUI() {
      const btn = document.getElementById('groove-btn');
      if (btn) {
        const on = (grooveSwing > 0 || grooveHumanizeMs > 0 || grooveHumanizeVel > 0
          || (grooveAccentEvery > 0 && grooveAccentAmt > 0));
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-expanded', _groovePanelEl ? 'true' : 'false');
      }
      const p = _groovePanelEl;
      if (!p) return;
      const set = (id, val, label, unit) => {
        const el = p.querySelector('#' + id); if (el) el.value = String(val);
        const lab = p.querySelector('#' + id + '-v'); if (lab) lab.textContent = label != null ? label : (val + (unit || ''));
      };
      set('gv-swing', grooveSwing, grooveSwing + '%');
      set('gv-hum',   grooveHumanizeMs, grooveHumanizeMs + ' ms');
      set('gv-vel',   grooveHumanizeVel, grooveHumanizeVel + '%');
      set('gv-acc',   grooveAccentAmt, grooveAccentAmt + '%');
      p.querySelectorAll('.gv-div-opt').forEach(b => {
        b.classList.toggle('active', Math.abs(parseFloat(b.dataset.div) - grooveSwingDiv) < 0.001);
      });
      p.querySelectorAll('.gv-acc-opt').forEach(b => {
        b.classList.toggle('active', (parseInt(b.dataset.acc, 10) || 0) === grooveAccentEvery);
      });
    }
    function closeGroovePanel() {
      if (_groovePanelOutside) {
        document.removeEventListener('pointerdown', _groovePanelOutside, true);
        document.removeEventListener('keydown', _groovePanelOutside, true);
        _groovePanelOutside = null;
      }
      if (_groovePanelEl) { _groovePanelEl.remove(); _groovePanelEl = null; }
      refreshGrooveUI();
    }
    function openGroovePanel(anchor) {
      if (_groovePanelEl) { closeGroovePanel(); return; }
      const panel = document.createElement('div');
      panel.className = 'groove-panel';
      panel.innerHTML =
        '<div class="groove-title">Groove</div>' +
        '<div class="groove-row"><div class="groove-lab">Swing <span class="groove-val" id="gv-swing-v">0%</span></div>' +
          '<input type="range" id="gv-swing" min="0" max="100" value="0" /></div>' +
        '<div class="groove-row"><div class="groove-lab">Swing grid</div>' +
          '<div class="groove-divs">' +
            '<button type="button" class="gv-div-opt" data-div="0.5">1/8</button>' +
            '<button type="button" class="gv-div-opt" data-div="0.25">1/16</button>' +
          '</div></div>' +
        '<div class="groove-row"><div class="groove-lab">Humanize time <span class="groove-val" id="gv-hum-v">0 ms</span></div>' +
          '<input type="range" id="gv-hum" min="0" max="50" value="0" /></div>' +
        '<div class="groove-row"><div class="groove-lab">Humanize vel <span class="groove-val" id="gv-vel-v">0%</span></div>' +
          '<input type="range" id="gv-vel" min="0" max="50" value="0" /></div>' +
        '<div class="groove-row"><div class="groove-lab">Accent every <span class="groove-val">beats</span></div>' +
          '<div class="groove-divs">' +
            '<button type="button" class="gv-acc-opt" data-acc="0">Off</button>' +
            '<button type="button" class="gv-acc-opt" data-acc="1">1</button>' +
            '<button type="button" class="gv-acc-opt" data-acc="2">2</button>' +
            '<button type="button" class="gv-acc-opt" data-acc="4">4</button>' +
          '</div></div>' +
        '<div class="groove-row"><div class="groove-lab">Accent depth <span class="groove-val" id="gv-acc-v">35%</span></div>' +
          '<input type="range" id="gv-acc" min="0" max="80" value="35" /></div>' +
        '<div class="groove-row groove-reset-row"><button type="button" class="groove-reset" id="gv-reset">Reset</button></div>';
      document.body.appendChild(panel);
      _groovePanelEl = panel;

      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const bindSlider = (id, setter, fmt) => {
        const el = panel.querySelector('#' + id);
        const lab = panel.querySelector('#' + id + '-v');
        if (!el) return;
        el.addEventListener('input', () => {
          const v = parseInt(el.value, 10) || 0;
          setter(v);
          if (lab) lab.textContent = fmt(v);
          refreshGrooveUI();
          persist();
        });
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
      };
      bindSlider('gv-swing', (v) => { grooveSwing = v; }, (v) => v + '%');
      bindSlider('gv-hum',   (v) => { grooveHumanizeMs = v; }, (v) => v + ' ms');
      bindSlider('gv-vel',   (v) => { grooveHumanizeVel = v; }, (v) => v + '%');
      bindSlider('gv-acc',   (v) => { grooveAccentAmt = v; }, (v) => v + '%');
      panel.querySelectorAll('.gv-acc-opt').forEach(b => {
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          grooveAccentEvery = parseInt(b.dataset.acc, 10) || 0;
          refreshGrooveUI();
          persist();
        });
      });
      panel.querySelectorAll('.gv-div-opt').forEach(b => {
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          grooveSwingDiv = parseFloat(b.dataset.div) || 0.5;
          refreshGrooveUI();
          persist();
        });
      });
      const resetBtn = panel.querySelector('#gv-reset');
      if (resetBtn) {
        resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        resetBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          grooveSwing = 0; grooveSwingDiv = 0.5;
          grooveHumanizeMs = 0; grooveHumanizeVel = 0;
          grooveAccentEvery = 0; grooveAccentAmt = 35;
          refreshGrooveUI();
          persist();
        });
      }

      // Position under the button, clamped to the viewport.
      const r = anchor.getBoundingClientRect();
      const pw = panel.offsetWidth || 200, ph = panel.offsetHeight || 200;
      const vw = window.innerWidth, vh = window.innerHeight;
      panel.style.left = Math.max(8, Math.min(r.left, vw - pw - 8)) + 'px';
      panel.style.top  = Math.min(r.bottom + 4, vh - ph - 8) + 'px';

      _groovePanelOutside = (e) => {
        if (e.type === 'keydown') { if (e.key === 'Escape') closeGroovePanel(); return; }
        if (!e.target.closest('.groove-panel') && e.target !== anchor) closeGroovePanel();
      };
      document.addEventListener('pointerdown', _groovePanelOutside, true);
      document.addEventListener('keydown', _groovePanelOutside, true);
      refreshGrooveUI();
    }
    (function bindGrooveButton() {
      const btn = document.getElementById('groove-btn');
      if (!btn) return;
      btn.addEventListener('click', (e) => { e.stopPropagation(); openGroovePanel(btn); });
      refreshGrooveUI();
    })();

    // ---- Desktop keyboard → grid notes --------------------------------
    // Maps physical keyboard keys to grid cells so a key press plays (and
    // holds) the corresponding note. Rather than re-implement the grid's
    // press logic (sustain, chord grouping, wrap / step / jump modes,
    // hold-duration → step), each key SYNTHESIZES the real pointer gesture
    // on the cell: pointerdown on key-down, pointerup + click on key-up.
    // That routes through the exact same handlers a mouse/touch press uses,
    // so every mode behaves identically and holding several keys at once
    // builds a chord just like multi-touch does.
    //
    // Keys are addressed by e.code (physical position), so the mapping is
    // independent of QWERTY/AZERTY/Dvorak layout and of Shift state. The
    // order runs low pitch → high: bottom letter row, then home row, then
    // top row, then the number row — i.e. left-to-right, bottom-to-top.
    (function bindGridKeyboard() {
      const KEY_ORDER = [
        'KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','Comma','Period','Slash',
        'KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','Quote',
        'KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP','BracketLeft','BracketRight',
        'Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','Minus','Equal',
      ];
      const keyIndex = new Map(KEY_ORDER.map((code, i) => [code, i]));
      // code → synthetic pointerId, for keys currently held. Presence also
      // guards against the OS key-repeat storm re-triggering the press.
      const held = new Map();
      // Start well above any real pointerId (mouse = 1, touch = small ints)
      // so a synthetic key-press never collides with a live pointer session.
      let _kbPointerSeq = 90000;

      // Don't steal keys while the user is typing into a field or has a
      // menu/select focused — only drive the grid when focus is "loose".
      function _typingTarget() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || el.isContentEditable;
      }
      function _cellCenter(cell) {
        const r = cell.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      function _dispatch(cell, type, pointerId, extra = {}) {
        const { x, y } = _cellCenter(cell);
        let ev;
        try {
          ev = new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId, pointerType: 'mouse', isPrimary: true,
            clientX: x, clientY: y, button: 0, buttons: extra.buttons ?? 0,
          });
        } catch (e) {
          // Older engines without the PointerEvent constructor — fall back
          // to a MouseEvent and tack the pointer fields on so the handlers
          // (which read e.pointerId) still match down ↔ up.
          ev = new MouseEvent(type === 'pointerdown' ? 'mousedown'
            : type === 'pointerup' ? 'mouseup' : type,
            { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
          try { Object.defineProperty(ev, 'pointerId', { value: pointerId }); } catch (e2) {}
        }
        cell.dispatchEvent(ev);
      }

      document.addEventListener('keydown', (e) => {
        if (e.repeat) return;                                   // ignore auto-repeat
        if (e.ctrlKey || e.metaKey || e.altKey) return;         // leave shortcuts alone
        if (_typingTarget()) return;
        const idx = keyIndex.get(e.code);
        if (idx == null) return;
        if (held.has(e.code)) return;
        const cell = cells[idx];
        if (!cell) return;
        // Out-of-scale cells are non-interactive for the mouse (CSS
        // pointer-events: none); honor that for the keyboard too — a
        // dispatchEvent would otherwise bypass the CSS and play them.
        if (cell.classList.contains('out-of-scale')) { e.preventDefault(); return; }
        e.preventDefault(); // keep Space/'/' etc. from scrolling or quick-finding
        const pointerId = ++_kbPointerSeq;
        held.set(e.code, pointerId);
        _dispatch(cell, 'pointerdown', pointerId, { buttons: 1 });
      });

      function _release(code, commit) {
        const pointerId = held.get(code);
        if (pointerId == null) return;
        held.delete(code);
        const idx = keyIndex.get(code);
        const cell = (idx != null) ? cells[idx] : null;
        if (!cell) return;
        // pointerup ends the sustain (document-level handler keys off the
        // pointerId); the follow-up click runs the same step-mutation path
        // a real tap does. On a focus-loss cleanup we release the voice but
        // skip the click so we don't commit a step the user didn't finish.
        _dispatch(cell, 'pointerup', pointerId);
        if (commit) cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      document.addEventListener('keyup', (e) => {
        if (!held.has(e.code)) return;
        e.preventDefault();
        _release(e.code, true);
      });
      // A key held across a tab switch / focus loss never fires keyup —
      // release everything so notes don't stick on. Treated like a
      // pointercancel (no step committed).
      const _releaseAll = () => { Array.from(held.keys()).forEach(code => _release(code, false)); };
      window.addEventListener('blur', _releaseAll);
      document.addEventListener('visibilitychange', () => { if (document.hidden) _releaseAll(); });
    })();
