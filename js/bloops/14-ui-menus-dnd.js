    // ---- Riff dropdown — Save / Random / Seed / Reverse / Shuffle / Repeat ----
    // Mirrors the Project / Voices / Colors menu chrome so the menubar look
    // carries over to the sequence-controls row. Each entry's existing
    // handler still fires; the dropdown just collapses 6 pills into 1.
    (function initRiffMenu() {
      const btn = document.getElementById('riff-menu-btn');
      const panel = document.getElementById('riff-panel');
      if (!btn || !panel) return;
      const TRIGGER_ID = 'riff-menu-btn';
      const setOpen = (open) => {
        // Refresh Drift label + disabled state right before the panel
        // shows, so its enabled-ness reflects the current lane count
        // (Drift needs ≥2 lanes) without needing a separate hook on
        // every lane add/remove path. Merge shares the same lane-count
        // gating so it piggybacks on the same hook.
        if (open && typeof refreshDriftBtn === 'function') refreshDriftBtn();
        if (open && typeof refreshMergeLanesBtn === 'function') refreshMergeLanesBtn();
        panel.classList.toggle('open', open);
        btn.classList.toggle('open', open);
        btn.textContent = open ? 'Riff ▴' : 'Riff ▾';
        // Re-position the panel using the shared viewport-clamping helper
        // every time it opens, so it can never spill past the right edge
        // (the CSS position:absolute / left:0 baseline ignores the
        // anchor's distance from the viewport edge).
        if (open) pinPanelToButton(btn, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(btn, panel);
      });
      btn.addEventListener('click', (e) => {
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
        if (panel.contains(e.target) || e.target === btn) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });
      // Close after any item click — the user picked something, get out of
      // their way. Disabled buttons don't fire click so they don't close.
      panel.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => { if (!b.disabled) setOpen(false); });
      });
    })();

    // ---- Voices: grid-only snapshots saved to Drive --------------------
    // A "voice" captures just the note grid (root, octaves, scale, palette,
    // per-cell sounds) — no workspace sequence, no tracks. Filenames are
    // namespaced by the current project name so multiple projects can have
    // their own "Lead", "Bass", etc. presets without colliding.
    function buildVoiceSnapshot(name) {
      return {
        type: 'voice',
        version: 1,
        name,
        project: currentProjectName || null,
        savedAt: new Date().toISOString(),
        grid: {
          rootIdx,
          baseOctave,
          octaveCount,
          masterFreqA,
          currentScale,
          palette: [...palette],
          chipPalette: [...chipPalette],
          restColor,
          cellSounds: [...cellSounds],
          cellParams: cellParams.map(p => ({ ...p })),
        },
      };
    }
    function applyVoiceSnapshot(snap) {
      if (!snap || !snap.grid) throw new Error('Voice file is malformed.');
      const g = snap.grid;
      rootIdx     = Number.isFinite(g.rootIdx)     ? g.rootIdx     : 0;
      baseOctave  = Number.isFinite(g.baseOctave)  ? g.baseOctave  : 4;
      octaveCount = Number.isFinite(g.octaveCount) ? g.octaveCount : 1;
      masterFreqA = Number.isFinite(g.masterFreqA) ? g.masterFreqA : 440;
      currentScale = (g.currentScale && SCALES[g.currentScale]) ? g.currentScale : 'chromatic';
      palette = Array.isArray(g.palette) && g.palette.length === 12 ? [...g.palette] : [...DEFAULT_PALETTE];
      chipPalette = Array.isArray(g.chipPalette) && g.chipPalette.length === palette.length ? [...g.chipPalette] : [...palette];
      restColor = g.restColor || DEFAULT_REST_COLOR;
      applyRestColor();

      const rootSel   = document.getElementById('root-select');
      const octRange  = document.getElementById('octave-range-select');
      const freqSl    = document.getElementById('master-freq-slider');
      const freqIn    = document.getElementById('master-freq-input');
      const scaleSel  = document.getElementById('scale-select');
      if (rootSel)   rootSel.value   = String(rootIdx);
      if (octRange)  octRange.value  = `${baseOctave}x${octaveCount}`;
      if (freqSl)    freqSl.value    = String(masterFreqA);
      if (freqIn)    freqIn.value    = String(masterFreqA);
      if (scaleSel)  scaleSel.value  = currentScale;

      rebuildGrid();

      if (Array.isArray(g.cellSounds) && g.cellSounds.length === cellSounds.length
          && Array.isArray(g.cellParams) && g.cellParams.length === cellParams.length) {
        cellSounds = [...g.cellSounds];
        cellParams = g.cellParams.map(p => ({ ...p }));
        refreshAllCellFreqLabels();
      }
      updateScaleBanner();
    }

    // Drive-safe filename token: strip anything that would mess with Drive's
    // file-name parsing or our `name.voice.something.json` convention.
    function sanitizeVoiceToken(s) {
      return String(s || '').trim().replace(/[\\/]+/g, '-').replace(/\.+/g, '-');
    }

    async function saveVoiceToDrive() {
      const btn = document.getElementById('grid-save-voice-btn');
      // Force a project name first — voices are namespaced under the current
      // project so the user always knows what they belong to.
      if (!currentProjectName || !currentProjectName.trim()) {
        const ok = confirm('Save the project first? Voices are saved with the project\'s name in the filename.');
        if (!ok) return;
        await saveProjectToDrive();
        if (!currentProjectName) return; // user cancelled the project save
      }
      const voiceRaw = prompt('Name for this Voice (grid state):', '');
      if (!voiceRaw || !voiceRaw.trim()) return;
      const voiceName = sanitizeVoiceToken(voiceRaw);
      const projectToken = sanitizeVoiceToken(currentProjectName);
      const filename = `${projectToken}.voice.${voiceName}.json`;

      const origText = btn.textContent;
      btn.disabled = true;
      try {
        btn.textContent = 'Building…';
        const snapshot = buildVoiceSnapshot(voiceName);
        const jsonString = JSON.stringify(snapshot, null, 2);

        btn.textContent = 'Signing in…';
        await googleSignInForDrive();

        btn.textContent = 'Checking…';
        const folderId = await findOrCreateDriveFolder('bloops/projects');
        const existing = await listProjectsInDrive(folderId);
        const match = existing.find(f => f.name === filename);
        let existingFileId = null;
        if (match) {
          const ok = confirm(`A voice "${voiceName}" already exists for project "${projectToken}" — overwrite it?`);
          if (!ok) {
            btn.textContent = origText;
            btn.disabled = false;
            return;
          }
          existingFileId = match.id;
        }

        btn.textContent = existingFileId ? 'Overwriting…' : 'Uploading…';
        const file = await uploadJsonToDrive(filename, jsonString, folderId, existingFileId);
        btn.textContent = existingFileId ? 'Overwritten' : 'Saved';
        alert(`${existingFileId ? 'Overwrote' : 'Saved'} voice "${voiceName}" for project "${projectToken}".`);
      } catch (e) {
        console.error(e);
        alert(`Save voice failed: ${e.message || e}`);
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1200);
      }
    }
    // ---- FX preset save / load (Drive folder "bloops/effects") ----------
    function buildEffectsSnapshot(name) {
      return {
        type: 'effects',
        version: 1,
        name,
        savedAt: new Date().toISOString(),
        globalFx: { ...globalFx },
      };
    }
    function applyEffectsSnapshot(snap) {
      if (!snap || !snap.globalFx) throw new Error('Effects file is malformed.');
      const FX_ON_KEYS_LOCAL = ['reverbOn','delayOn','distortionOn','chorusOn','vibratoOn','tremoloOn','phaserOn','autoFilterOn','pingPongOn','autoPanOn'];
      Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => {
        const v = snap.globalFx[k];
        if (k === 'fxOrder') {
          if (Array.isArray(v) && v.length === FX_NAMES.length
              && v.every(n => FX_NAMES.includes(n))
              && new Set(v).size === FX_NAMES.length) {
            globalFx.fxOrder = v.slice();
          }
        } else if (FX_ON_KEYS_LOCAL.includes(k)) {
          if (typeof v === 'boolean') globalFx[k] = v;
        } else if (Number.isFinite(v)) {
          globalFx[k] = v;
        }
      });
      rebuildMasterChain();
      applyGlobalFx();
      persistGlobalFx();
    }

    async function listEffectsInDrive(folderId) {
      const resp = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and trashed=false and mimeType='application/json'`,
        fields: 'files(id, name, modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
      });
      return resp.result.files || [];
    }

    async function saveEffectsToDrive() {
      const btn = document.getElementById('fx-save-btn');
      const name = prompt('Name for these FX settings:', '');
      if (!name || !name.trim()) return;
      const filename = name.trim().replace(/\.json$/i, '') + '.json';
      const origText = btn.textContent;
      btn.disabled = true;
      try {
        btn.textContent = 'Building…';
        const snapshot = buildEffectsSnapshot(name.trim());
        const jsonString = JSON.stringify(snapshot, null, 2);

        btn.textContent = 'Signing in…';
        await googleSignInForDrive();

        btn.textContent = 'Checking…';
        const folderId = await findOrCreateDriveFolder('bloops/effects');
        const existing = await listEffectsInDrive(folderId);
        const match = existing.find(f => f.name === filename);
        let existingFileId = null;
        if (match) {
          const ok = confirm(`FX preset "${name.trim()}" already exists. Overwrite it?`);
          if (!ok) {
            btn.textContent = origText;
            btn.disabled = false;
            return;
          }
          existingFileId = match.id;
        }
        btn.textContent = existingFileId ? 'Overwriting…' : 'Uploading…';
        const file = await uploadJsonToDrive(filename, jsonString, folderId, existingFileId);
        btn.textContent = existingFileId ? 'Overwritten' : 'Saved';
        alert(`${existingFileId ? 'Overwrote' : 'Saved'} FX preset "${name.trim()}".`);
      } catch (e) {
        console.error(e);
        alert(`Save failed: ${e.message || e}`);
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1200);
      }
    }

    async function loadEffectsFromDrive(onLoaded) {
      const btn = document.getElementById('fx-load-btn');
      const origText = btn.textContent;
      btn.disabled = true;
      try {
        btn.textContent = 'Signing in…';
        await googleSignInForDrive();
        btn.textContent = 'Listing…';
        const folderId = await findOrCreateDriveFolder('bloops/effects');
        const files = await listEffectsInDrive(folderId);
        btn.textContent = origText;
        btn.disabled = false;
        showProjectPickerDialog(files, async (file) => {
          if (!file) return;
          btn.disabled = true;
          btn.textContent = 'Loading…';
          try {
            const snap = await fetchProjectJson(file.id);
            applyEffectsSnapshot(snap);
            if (typeof onLoaded === 'function') onLoaded();
            btn.textContent = 'Loaded';
          } catch (e) {
            console.error(e);
            alert(`Load failed: ${e.message || e}`);
          } finally {
            setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1000);
          }
        });
      } catch (e) {
        console.error(e);
        alert(`Couldn't list FX presets: ${e.message || e}`);
        btn.disabled = false;
        btn.textContent = origText;
      }
    }

    // Apply a saved-project snapshot to every relevant piece of state. Stops
    // playback first, disposes the live track audio nodes (so a fresh chain
    // is built when the new tracks first play), and clears undo/redo since
    // history doesn't carry meaning across a project switch.
    async function applyProjectSnapshot(snap) {
      if (!snap || typeof snap !== 'object') throw new Error('Project file is empty or malformed.');
      stopSequence();
      stopAllTracks();
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch (e) {}
      }
      if (_previewAudio) { try { _previewAudio.pause(); } catch (e) {} _previewAudio = null; }

      // Drop history — restored state is the new origin.
      undoStack.length = 0;
      redoStack.length = 0;
      refreshHistoryButtons();

      // ---- Asset restoration --------------------------------------------
      // Newer project files extract embedded audio + imported samples into a
      // sibling assets subfolder, leaving Drive file IDs in the JSON. Pull
      // each asset back into the runtime shape (data URLs, IndexedDB +
      // sampleSamplers entries) before the rest of the snapshot is applied.
      if (Array.isArray(snap.savedSequences)) {
        for (const s of snap.savedSequences) {
          if (s && s.type === 'audio' && s.audioDriveFileId && !s.audioDataUrl) {
            try {
              const blob = await fetchDriveBinaryAsBlob(s.audioDriveFileId);
              s.audioDataUrl = await blobToDataUrl(blob);
            } catch (e) {
              console.warn('Could not restore saved-sequence audio', s.audioDriveFileId, e);
            }
          }
        }
      }
      if (Array.isArray(snap.tracks)) {
        for (const t of snap.tracks) {
          if (!Array.isArray(t.items)) continue;
          for (const it of t.items) {
            if (it && it.type === 'audio' && it.audioDriveFileId && !it.audioDataUrl) {
              try {
                const blob = await fetchDriveBinaryAsBlob(it.audioDriveFileId);
                it.audioDataUrl = await blobToDataUrl(blob);
              } catch (e) {
                console.warn('Could not restore track audio', it.audioDriveFileId, e);
              }
            }
          }
        }
      }
      if (Array.isArray(snap.importedSamples)) {
        for (const entry of snap.importedSamples) {
          if (!entry || !entry.id || !entry.driveFileId) continue;
          if (sampleSamplers.has(entry.id)) continue; // already registered
          try {
            const blob = await fetchDriveBinaryAsBlob(entry.driveFileId);
            const rootNote = entry.rootNote || 'C4';
            const tuneCents = Number.isFinite(entry.tuneCents) ? entry.tuneCents : 0;
            // Carry the pad/voice metadata through to IndexedDB so the sample
            // reloads as a pad (looping) on this device too — without padLoop it
            // would silently play as a one-shot voice.
            await persistImportedSample(entry.id, entry.name || entry.id, blob, {
              rootNote, tuneCents,
              padLoop: !!entry.padLoop,
              padAttack: Number.isFinite(entry.padAttack) ? entry.padAttack : undefined,
              padRelease: Number.isFinite(entry.padRelease) ? entry.padRelease : undefined,
            });
            const url = URL.createObjectURL(blob);
            const urls = { [rootNote]: url };
            const sampler = new Tone.Sampler({ urls, release: 1 }).connect(masterBus);
            const _info = {
              sampler,
              name: entry.name || entry.id,
              rootNote,
              tuneCents,
              imported: true,
              urls,
              padLoop: !!entry.padLoop,
            };
            if (entry.padLoop) {
              if (Number.isFinite(entry.padAttack)) _info.padAttack = entry.padAttack;
              if (Number.isFinite(entry.padRelease)) _info.padRelease = entry.padRelease;
            }
            sampleSamplers.set(entry.id, _info);
          } catch (e) {
            console.warn('Could not restore imported sample', entry.id, e);
          }
        }
      }

      const w = snap.workspace || {};
      const g = snap.grid || {};

      // Grid (notes / palette / scale).
      rootIdx     = Number.isFinite(g.rootIdx)     ? g.rootIdx     : 0;
      baseOctave  = Number.isFinite(g.baseOctave)  ? g.baseOctave  : 4;
      octaveCount = Number.isFinite(g.octaveCount) ? g.octaveCount : 1;
      masterFreqA = Number.isFinite(g.masterFreqA) ? g.masterFreqA : 440;
      currentScale = (g.currentScale && SCALES[g.currentScale]) ? g.currentScale : 'chromatic';
      palette = Array.isArray(g.palette) && g.palette.length === 12 ? [...g.palette] : [...DEFAULT_PALETTE];
      chipPalette = Array.isArray(g.chipPalette) && g.chipPalette.length === palette.length ? [...g.chipPalette] : [...palette];
      restColor = g.restColor || DEFAULT_REST_COLOR;
      applyRestColor();

      const rootSel   = document.getElementById('root-select');
      const octRange  = document.getElementById('octave-range-select');
      const freqSl    = document.getElementById('master-freq-slider');
      const freqIn    = document.getElementById('master-freq-input');
      const scaleSel  = document.getElementById('scale-select');
      if (rootSel)   rootSel.value   = String(rootIdx);
      if (octRange)  octRange.value  = `${baseOctave}x${octaveCount}`;
      if (freqSl)    freqSl.value    = String(masterFreqA);
      if (freqIn)    freqIn.value    = String(masterFreqA);
      if (scaleSel)  scaleSel.value  = currentScale;

      rebuildGrid();

      // Per-cell sound config — apply only when the dimensions match the
      // freshly-rebuilt grid (octaveCount changes can otherwise misalign).
      if (Array.isArray(g.cellSounds) && g.cellSounds.length === cellSounds.length
          && Array.isArray(g.cellParams) && g.cellParams.length === cellParams.length) {
        cellSounds = [...g.cellSounds];
        cellParams = g.cellParams.map(p => ({ ...p }));
        refreshAllCellFreqLabels();
      }

      // Workspace state.
      sequence = Array.isArray(w.sequence) ? w.sequence.map(cloneStep) : [];
      pendingChord = Array.isArray(w.pendingChord)
        ? w.pendingChord.map(p => ({ ...p, params: p.params ? { ...p.params } : undefined }))
        : [];
      selectedStepRefs = [];
      insertionPoint = null;
      activeSeqIndex = (typeof w.activeSeqIndex === 'number') ? w.activeSeqIndex : null;
      noteLength      = w.noteLength      ?? 1;
      stepSubdivision = w.stepSubdivision ?? 0.5;
      // Groove (swing / humanize) — restore, defaulting to straight when a
      // pre-groove project (or no groove block) is loaded.
      {
        const g = w.groove || {};
        grooveSwing       = Number.isFinite(g.swing)       ? g.swing       : 0;
        grooveSwingDiv    = Number.isFinite(g.swingDiv)    ? g.swingDiv    : 0.5;
        grooveHumanizeMs  = Number.isFinite(g.humanizeMs)  ? g.humanizeMs  : 0;
        grooveHumanizeVel = Number.isFinite(g.humanizeVel) ? g.humanizeVel : 0;
        grooveAccentEvery = Number.isFinite(g.accentEvery) ? g.accentEvery : 0;
        grooveAccentAmt   = Number.isFinite(g.accentAmt)   ? g.accentAmt   : 35;
        if (typeof refreshGrooveUI === 'function') { try { refreshGrooveUI(); } catch (e) {} }
      }
      gridColumns     = Math.min(8, Math.max(1, (w.gridColumns | 0) || 8));
      gridRows        = Math.min(8, Math.max(1, (w.gridRows    | 0) || 1));
      chordMode       = !!w.chordMode;
      loopMode        = !!w.loopMode;
      stepMode        = !!w.stepMode;
      multiSelectMode = !!w.multiSelectMode;
      // laneExpanderOpen defaults true (legacy snapshots predate the
      // field) so reloading an older project still shows the grid.
      _laneExpanderOpen = (w.laneExpanderOpen != null) ? !!w.laneExpanderOpen : true;

      // Poly-only world: restore lanes from the snapshot. Older
      // snapshots may have stored polyMode=false with no lanes — the
      // fall-through below seeds a single lane from the restored
      // sequence so we never end up with an empty lanes[].
      if (typeof disposeAllLaneAudio === 'function') disposeAllLaneAudio(lanes);
      activeLaneIdx = Number.isFinite(w.activeLaneIdx) ? w.activeLaneIdx : 0;
      lanes = Array.isArray(w.lanes) ? w.lanes.map((l, i) => ({
        name: (typeof l?.name === 'string' && l.name) ? l.name : _laneName(i),
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
        text: (l?.text && typeof l.text === 'object') ? JSON.parse(JSON.stringify(l.text)) : null,
        voice:  (l && l.voice && typeof l.voice === 'object')
          ? JSON.parse(JSON.stringify(l.voice)) : null,
        // Per-lane FX send levels. Migration:
        // (a) New schema: l.sends present → use it.
        // (b) Old per-lane-FX schema: l.fx had reverb/delay/... mix
        //     values → harvest those as the send seeds.
        // (c) Pre-per-lane-FX schema: no l.fx, no l.sends → fall back
        //     to globalFx mix values.
        sends: _migrateLaneSends(l),
      })) : [];
      _stashedLanes = Array.isArray(w.stashedLanes) ? w.stashedLanes.map((l, i) => ({
        name: (typeof l?.name === 'string' && l.name) ? l.name : _laneName(i),
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
        text: (l?.text && typeof l.text === 'object') ? JSON.parse(JSON.stringify(l.text)) : null,
        voice:  (l && l.voice && typeof l.voice === 'object')
          ? JSON.parse(JSON.stringify(l.voice)) : null,
        sends: _migrateLaneSends(l),
      })) : null;
      // Always-poly invariant: if the restored snapshot had no lanes
      // (older Mono-mode save), seed one from the restored sequence.
      if (lanes.length === 0) {
        lanes = [_makeLane(0, sequence)];
      }
      activeLaneIdx = Math.min(activeLaneIdx, lanes.length - 1);
      if (activeLaneIdx < 0) activeLaneIdx = 0;
      // Alias `sequence` to the active lane's steps so all add/edit
      // code reads/writes the right lane.
      sequence = lanes[activeLaneIdx].steps;
      // Apply the active lane's voice on top of the grid restore
      // that already ran above (snap.grid → globals → rebuildGrid).
      // Lanes that lack a stored voice fall through and inherit
      // whatever's in the globals — first activate-out will freeze
      // it onto the lane.
      if (lanes[activeLaneIdx] && lanes[activeLaneIdx].voice) {
        _applyVoiceToGlobals(lanes[activeLaneIdx].voice);
      }
      // Grid vs. Graph is per-lane — sync the body class + toggle
      // button to the restored active lane so the editor surface
      // matches what the user saved.
      try { _syncFluidGridToActiveLane(); } catch (e) {}
      refreshPolyModeBtn();

      const bpm = Number.isFinite(w.bpm) ? w.bpm : 120;
      if (typeof tempoInput  !== 'undefined' && tempoInput)  tempoInput.value  = String(bpm);
      if (typeof tempoSlider !== 'undefined' && tempoSlider) tempoSlider.value = String(bpm);
      refreshWrapVisuals();
      clearWrapPendingHighlights();
      const loopBtn = document.getElementById('loop-btn');
      if (loopBtn) loopBtn.classList.toggle('active', loopMode);
      const noteSel  = document.getElementById('note-length');
      if (noteSel)  noteSel.value  = String(noteLength);
      const subSel2  = document.getElementById('subdivision-select');
      if (subSel2)  subSel2.value  = String(stepSubdivision);
      const colsEl2 = document.getElementById('grid-cols-input');
      if (colsEl2) colsEl2.value = String(gridColumns);
      const rowsEl2 = document.getElementById('grid-rows-input');
      if (rowsEl2) rowsEl2.value = String(gridRows);
      const stepBtn = document.getElementById('step-mode-btn');
      if (typeof refreshStepModeBtn === 'function') refreshStepModeBtn();
      else if (stepBtn) stepBtn.classList.toggle('active', stepMode);
      const multiCb = document.getElementById('multi-select-toggle');
      if (multiCb)  multiCb.checked = multiSelectMode;
      refreshHoldEnabled();

      // Saved sequences bank — replace and persist.
      savedSequences = Array.isArray(snap.savedSequences)
        ? snap.savedSequences.map(s => JSON.parse(JSON.stringify(s)))
        : [];
      persistSaved();

      // Tracks — dispose existing live audio nodes before swapping the
      // array so the next note creates a fresh chain in the live context.
      tracks.forEach(t => {
        if (t._recording) {
          try { t._recorder?.stop(); } catch (e) {}
          if (t._recStream) {
            try { t._recStream.getTracks().forEach(s => s.stop()); } catch (e) {}
          }
          t._recording = false;
          t._recorder = null;
          t._recStream = null;
        }
        if (t._bus)    { try { t._bus.dispose(); }    catch (e) {} t._bus = null; }
        if (t._panner) { try { t._panner.dispose(); } catch (e) {} t._panner = null; }
        if (t._mono)   { try { t._mono.dispose(); }   catch (e) {} t._mono = null; }
        if (t._samplers) {
          t._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
          t._samplers = null;
        }
        if (t.timer)   { clearTimeout(t.timer); t.timer = null; }
      });
      tracks = Array.isArray(snap.tracks) ? snap.tracks.map(t => ({
        id: t.id ?? trackIdCounter++,
        name: t.name || '?',
        items: Array.isArray(t.items) ? t.items : [],
        loopMode: !!t.loopMode,
        solo: !!t.solo,
        eq: t.eq && typeof t.eq === 'object' ? t.eq : { low: 0, mid: 0, high: 0 },
        pan: Number.isFinite(t.pan) ? t.pan : 0,
        stereo: t.stereo !== false,
        playing: false,
        currentItemIdx: null,
        timer: null,
      })) : [];
      trackIdCounter = Math.max(0, ...tracks.map(t => t.id || 0)) + 1;
      persistTracks();

      // Saved grid states.
      if (Array.isArray(snap.savedGridStates)) {
        savedGridStates = JSON.parse(JSON.stringify(snap.savedGridStates));
        persistGridStates();
        refreshGridStateDropdown('');
      }

      // Ensembles — rebuild the registry before Bloom/grid restore so any
      // 'ensemble:<id>' voice references resolve.
      try {
        if (typeof ensembles !== 'undefined') {
          ensembles.clear();
          (Array.isArray(snap.ensembles) ? snap.ensembles : []).forEach(d => {
            if (d && d.id != null) ensembles.set(String(d.id), JSON.parse(JSON.stringify(d)));
          });
          if (typeof _ambRefreshAllToneSelects === 'function') _ambRefreshAllToneSelects();
        }
      } catch (e) {}

      // Master Bloom (Mix) config — global, not per-lane.
      try {
        masterAmbient = (snap.masterAmbient && typeof snap.masterAmbient === 'object')
          ? _normalizeAmbientCfg(JSON.parse(JSON.stringify({ ...snap.masterAmbient, playing: false }))) : null;
        if (typeof _masterEng !== 'undefined' && _masterEng.inited) _ambSyncControls(_masterEng);
      } catch (e) {}

      // Master Shapes (Mix) — independent shape copies (global). If the snapshot
      // predates this feature, migrate any lanes flagged sentToMaster into one
      // copy each (so older projects keep what they had "sent").
      try {
        if (typeof masterShapes !== 'undefined') {
          try { if (typeof _shapeMasterEditClose === 'function') _shapeMasterEditClose(); } catch (e) {}
          if (Array.isArray(snap.masterShapes)) {
            masterShapes = JSON.parse(JSON.stringify(snap.masterShapes)).filter(c => c && c.shape);
            activeMasterShapeId = (snap.activeMasterShapeId != null) ? snap.activeMasterShapeId : null;
          } else {
            masterShapes = [];
            (Array.isArray(lanes) ? lanes : []).forEach((l, i) => {
              if (l && l.sentToMaster && l.shape) {
                masterShapes.push({ id: i + 1, name: (l.name || ('Lane ' + (i + 1))) + ' v1', shape: JSON.parse(JSON.stringify(l.shape)) });
              }
            });
            activeMasterShapeId = masterShapes.length ? masterShapes[masterShapes.length - 1].id : null;
          }
          // Keep the id sequence ahead of every restored id.
          if (typeof _shapeMasterIdSeq !== 'undefined') {
            const maxId = masterShapes.reduce((m, c) => Math.max(m, (c && Number.isFinite(c.id)) ? c.id : 0), 0);
            _shapeMasterIdSeq = maxId + 1;
          }
        }
      } catch (e) { console.warn('master shapes restore failed', e); }

      // Global FX — write into the live globalFx and refresh the panel.
      if (snap.globalFx && typeof snap.globalFx === 'object') {
        Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => {
          if (Number.isFinite(snap.globalFx[k])) globalFx[k] = snap.globalFx[k];
        });
        applyGlobalFx();
        persistGlobalFx();
        [
          ['fx-rev',      'fx-rev-v',      'reverb',        '%'],
          ['fx-rev-size',    'fx-rev-size-v',    'reverbSize',         '%'],
          ['fx-rev-tone',    'fx-rev-tone-v',    'reverbTone',         '%'],
          ['fx-dly',         'fx-dly-v',         'delay',              '%'],
          ['fx-dly-time',    'fx-dly-time-v',    'delayTime',          ' ms'],
          ['fx-dly-fb',      'fx-dly-fb-v',      'delayFeedback',      '%'],
          ['fx-dst',         'fx-dst-v',         'distortion',         '%'],
          ['fx-cho',         'fx-cho-v',         'chorus',             '%'],
          ['fx-cho-freq',    'fx-cho-freq-v',    'chorusFreq',         ' Hz'],
          ['fx-cho-depth',   'fx-cho-depth-v',   'chorusDepth',        '%'],
          ['fx-vib',         'fx-vib-v',         'vibrato',            '%'],
          ['fx-vib-freq',    'fx-vib-freq-v',    'vibratoFreq',        ' Hz'],
          ['fx-vib-depth',   'fx-vib-depth-v',   'vibratoDepth',       '%'],
          ['fx-trm',         'fx-trm-v',         'tremolo',            '%'],
          ['fx-trm-freq',    'fx-trm-freq-v',    'tremoloFreq',        ' Hz'],
          ['fx-trm-depth',   'fx-trm-depth-v',   'tremoloDepth',       '%'],
          ['fx-phs',         'fx-phs-v',         'phaser',             '%'],
          ['fx-phs-freq',    'fx-phs-freq-v',    'phaserFreq',         ' Hz'],
          ['fx-phs-oct',     'fx-phs-oct-v',     'phaserOctaves',      ''],
          ['fx-af',          'fx-af-v',          'autoFilter',         '%'],
          ['fx-af-freq',     'fx-af-freq-v',     'autoFilterFreq',     ' Hz'],
          ['fx-af-depth',    'fx-af-depth-v',    'autoFilterDepth',    '%'],
          ['fx-af-base',     'fx-af-base-v',     'autoFilterBaseFreq', ' Hz'],
          ['fx-pp',          'fx-pp-v',          'pingPong',           '%'],
          ['fx-pp-time',     'fx-pp-time-v',     'pingPongTime',       ' ms'],
          ['fx-pp-fb',       'fx-pp-fb-v',       'pingPongFeedback',   '%'],
          ['fx-apan',        'fx-apan-v',        'autoPan',            '%'],
          ['fx-apan-freq',   'fx-apan-freq-v',   'autoPanFreq',        ' Hz'],
          ['fx-apan-depth',  'fx-apan-depth-v',  'autoPanDepth',       '%'],
        ].forEach(([id, valId, key, unit]) => {
          const input = document.getElementById(id);
          const label = document.getElementById(valId);
          if (input) input.value = String(globalFx[key]);
          if (label) label.textContent = globalFx[key] + unit;
        });
      }

      // Final renders.
      renderSequence();
      renderSavedSequences();
      renderTracks();
      const saveBtn = document.getElementById('save-btn');
      if (saveBtn) saveBtn.disabled = sequence.length === 0;
    }

    async function listProjectsInDrive(folderId) {
      const resp = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and trashed=false and mimeType='application/json'`,
        fields: 'files(id, name, modifiedTime, size)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
      });
      return resp.result.files || [];
    }

    async function fetchProjectJson(fileId) {
      const resp = await gapi.client.drive.files.get({ fileId, alt: 'media' });
      // gapi returns the body as a string for media downloads.
      return JSON.parse(resp.body || '{}');
    }

    // Drive's gapi delete() can fail silently in some environments (the
    // Request thenable resolves but the file isn't removed). The raw v3
    // DELETE endpoint is more predictable and also surfaces failures via a
    // real status code we can throw on.
    async function deleteDriveFile(fileId) {
      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${googleAccessToken}` },
      });
      // 204 No Content is success; some browsers report ok for any 2xx.
      if (!resp.ok && resp.status !== 204) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Drive delete failed: ${resp.status} ${body}`);
      }
      return true;
    }

    // List Drive projects in a picker modal. On select, fetch + apply.
    function showProjectPickerDialog(files, onPick) {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      const fmtDate = (iso) => {
        if (!iso) return '';
        try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
      };
      const rows = files.length === 0
        ? `<div style="color:#4a4a6a;font-family:'Segoe UI',sans-serif;font-size:0.85rem;padding:12px 0;text-align:center;">No projects found in "bloops/projects".</div>`
        : files.map((f, i) => `
          <button type="button" class="picker-row" data-idx="${i}" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;padding:10px 12px;border:1px solid #2d2d3f;border-radius:8px;background:transparent;color:#e2e8f0;font-family:'Segoe UI',sans-serif;cursor:pointer;transition:all 0.15s ease;">
            <span style="font-size:0.85rem;font-weight:600;">${f.name.replace(/\.json$/i, '')}</span>
            <span style="font-size:0.7rem;color:#4a4a6a;">${fmtDate(f.modifiedTime)}</span>
          </button>
        `).join('');
      modal.innerHTML = `
        <div class="sm-title">Load project</div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;margin-bottom:14px;">
          ${rows}
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="picker-cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      modal.querySelector('#picker-cancel').addEventListener('click', () => overlay.remove());
      modal.querySelectorAll('.picker-row').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#4299e1'; btn.style.background = 'rgba(66,153,225,0.08)'; });
        btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#2d2d3f'; btn.style.background = 'transparent'; });
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          overlay.remove();
          onPick(files[idx]);
        });
      });
    }

    async function loadProjectFromDrive(btn) {
      const origText = btn ? btn.textContent : '';
      const setBtn = (text) => { if (btn) btn.textContent = text; };
      if (btn) btn.disabled = true;
      try {
        setBtn('Signing in…');
        await googleSignInForDrive();

        setBtn('Listing…');
        const folderId = await findOrCreateDriveFolder('bloops/projects');
        const files = await listProjectsInDrive(folderId);
        // Voice files share the same folder; surface them under Voices, not Projects.
        const projects = files.filter(f => !/\.voice\..+\.json$/i.test(f.name));

        setBtn(origText);
        if (btn) btn.disabled = false;
        showProjectPickerDialog(projects, async (file) => {
          if (!file) return;
          if (btn) btn.disabled = true;
          const prev = btn ? btn.textContent : '';
          try {
            setBtn('Loading…');
            const snap = await fetchProjectJson(file.id);
            await applyProjectSnapshot(snap);
            currentProjectName = (file.name || '').replace(/\.json$/i, '') || null;
            refreshProjectNameLabel();
            setBtn('Loaded');
          } catch (e) {
            console.error(e);
            alert(`Load failed: ${e.message || e}`);
          } finally {
            if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1000);
          }
        });
      } catch (e) {
        console.error(e);
        alert(`Couldn't list projects: ${e.message || e}`);
        if (btn) {
          btn.disabled = false;
          btn.textContent = origText;
        }
      }
    }

    // Seed one default track on first run.
    if (tracks.length === 0) {
      addTrack();
    } else {
      renderTracks();
    }

    // ---- Restore in-progress workspace from localStorage ------------------
    // Runs once at startup. If the user had unsaved work in the previous
    // session, we round-trip it through applyProjectSnapshot (which is the
    // same path the Drive load uses) so sequence + grid + palette + tempo
    // all come back. The persist-enable flag stays off until the restore
    // completes, so no half-applied snapshot gets written back.
    async function restoreWorkspaceFromStorage() {
      let restored = false;
      try {
        const raw = localStorage.getItem(WORKSPACE_LS_KEY);
        if (raw) {
          const snap = JSON.parse(raw);
          if (snap && typeof snap === 'object') {
            await applyProjectSnapshot(snap);
            if (snap.currentProjectName) currentProjectName = snap.currentProjectName;
            refreshProjectNameLabel();
            restored = true;
          }
        }
      } catch (e) {
        console.warn('Could not restore workspace:', e);
      } finally {
        // Fresh-start fallback render: when there's no localStorage
        // snapshot, applyProjectSnapshot never runs, so no renderSequence
        // call ever fires and the lane-expander stays parked in its
        // hidden stash. Force one render here so the default lane row
        // (and the voice editor reparented above it) shows up on first
        // load.
        if (!restored) renderSequence();
        _workspacePersistEnabled = true;
      }
    }
    // Defer the restore until every script has loaded and defined its
    // symbols. applyProjectSnapshot references state + functions that live
    // in later-loaded module files (SCALES, rebuildGrid, applyPalette, …);
    // running it inline here — while this file is still executing — would
    // throw on those forward references and silently lose the user's saved
    // work (the try/catch above would swallow it). DOMContentLoaded fires
    // only after every synchronous <script> in the page has executed, so by
    // then all js/bloops/*.js modules are fully defined. Persist stays
    // disabled until this completes, so the default-state boot render can't
    // clobber the saved snapshot before we read it.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', restoreWorkspaceFromStorage, { once: true });
    } else {
      restoreWorkspaceFromStorage();
    }

    // ---- Top-bar view switching (Make ↔ Mix ↔ Listen) -------------------
    (function initTopBarTabs() {
      const bloopsTab = document.getElementById('bloops-tab');
      const mixTab    = document.getElementById('mix-tab');
      const sbTab     = document.getElementById('serialbox-tab');
      if (!bloopsTab || !sbTab) return;
      const tabs = [bloopsTab, mixTab, sbTab].filter(Boolean);
      const setActive = (which) => {
        tabs.forEach(t => t.classList.toggle('tab-active', t === which));
      };
      // Update labels so the active tab reads cleanly and inactive tabs
      // hint at direction ("← Make" on the left, "Listen →" on the right).
      const updateLabels = (active) => {
        // 'make' | 'mix' | 'serialbox'
        bloopsTab.textContent = (active === 'make') ? 'Make' : '← Make';
        if (mixTab) mixTab.textContent = 'Mix';
        sbTab.textContent     = (active === 'serialbox') ? 'Listen' : 'Listen →';
      };
      // Close every transient modal + open dropdown so a panel opened
      // for the OLD view doesn't leak into the new one (e.g., the
      // Wavetable editor lives on Make, but its .modal-overlay was
      // exempted from the view-mix hide rule and would float over Mix
      // until cancelled). Belt-and-suspenders: also closes the Sounds /
      // Tone / FX / Riff / Project / Colors dropdowns and Export /
      // Share / Step / Wavetable / Pitch-ramp modals.
      const _closeTransientUI = () => {
        document.querySelectorAll('.modal-overlay, .sm-overlay').forEach(el => {
          try { el.remove(); } catch (e) {}
        });
        document.querySelectorAll(
          '.tone-panel.open, .fx-panel.open, .grid-settings-panel.open, ' +
          '.voices-panel.open, .project-panel.open, .riff-panel.open, ' +
          '.colors-panel.open'
        ).forEach(el => { try { el.classList.remove('open'); } catch (e) {} });
        document.querySelectorAll('.banner-half.open, .menu-btn.open, button.open')
          .forEach(el => { try { el.classList.remove('open'); } catch (e) {} });
        // Leaving any view ends a master-shape edit so the reparented
        // #shape-pad is returned to its Make home (else it'd be orphaned in
        // the hidden Mix pane and the lane Shape editor would lose its body).
        try { if (typeof _shapeMasterEditClose === 'function') _shapeMasterEditClose(); } catch (e) {}
      };
      const showBloops = () => {
        // tracks-fullscreen is a Mix-internal layout class; clear it on
        // every view switch so it can't leak the Mix DOM (Export button,
        // Tracks section) onto Make or Listen via the `body.tracks-
        // fullscreen > #mix-view { display: block !important }` rule.
        document.body.classList.remove('view-serialbox', 'view-mix', 'tracks-fullscreen');
        setActive(bloopsTab);
        updateLabels('make');
        _closeTransientUI();
        // Leaving Listen pauses any background music so the user isn't
        // hearing audio from a tab they can no longer see/control.
        try { window.musicPlayer?.pause(); } catch (e) {}
      };
      const showMix = () => {
        document.body.classList.remove('view-serialbox');
        document.body.classList.add('view-mix');
        setActive(mixTab);
        updateLabels('mix');
        _closeTransientUI();
        try { window.musicPlayer?.pause(); } catch (e) {}
        // Build/refresh the master Bloom panel now that #mix-bloom-host is visible.
        try { if (typeof _ambInitMaster === 'function') _ambInitMaster(); } catch (e) {}
        // Mix was just made visible — earlier renderTracksLoopRuler
        // passes may have run while #mix-view was display:none and
        // every rect was clipped to zero, leaving the ruler stuck at
        // marginLeft=0. Re-run alignment now that the view is on-
        // screen so the loop bar sits flush with the first track grid.
        if (typeof renderTracksLoopRuler === 'function') {
          requestAnimationFrame(() => {
            try { renderTracksLoopRuler(); } catch (e) {}
          });
        }
      };
      const showSerialbox = () => {
        document.body.classList.remove('view-mix', 'tracks-fullscreen');
        document.body.classList.add('view-serialbox');
        setActive(sbTab);
        updateLabels('serialbox');
        _closeTransientUI();
      };
      bloopsTab.addEventListener('click', showBloops);
      if (mixTab) mixTab.addEventListener('click', showMix);
      sbTab.addEventListener('click', showSerialbox);

      // Mix sub-tabs: Bloom (master generative, default) / Mixdown (tracks +
      // export). Toggles a class on #mix-view; CSS shows the matching pane.
      (function initMixSubtabs() {
        const view = document.getElementById('mix-view');
        const bBtn = document.getElementById('mix-subtab-bloom');
        const sBtn = document.getElementById('mix-subtab-shapes');
        const mBtn = document.getElementById('mix-subtab-mixdown');
        if (!view || !bBtn || !mBtn) return;
        const selectSub = (which) => {
          view.classList.toggle('mix-sub-bloom', which === 'bloom');
          view.classList.toggle('mix-sub-shapes', which === 'shapes');
          view.classList.toggle('mix-sub-mixdown', which === 'mixdown');
          bBtn.classList.toggle('active', which === 'bloom');
          if (sBtn) sBtn.classList.toggle('active', which === 'shapes');
          mBtn.classList.toggle('active', which === 'mixdown');
          // Stop the master wheel animation + end any copy edit whenever we
          // leave the Shapes pane (returns the reparented #shape-pad home).
          if (which !== 'shapes') {
            try { if (typeof _shapeMasterEditClose === 'function') _shapeMasterEditClose(); } catch (e) {}
            try { if (typeof _shapeMasterStop === 'function') _shapeMasterStop(); } catch (e) {}
          }
          if (which === 'bloom') {
            try { if (typeof _ambInitMaster === 'function') _ambInitMaster(); } catch (e) {}
          } else if (which === 'shapes') {
            try { if (typeof _shapeMasterInit === 'function') _shapeMasterInit(); } catch (e) {}
          } else if (typeof renderTracksLoopRuler === 'function') {
            requestAnimationFrame(() => { try { renderTracksLoopRuler(); } catch (e) {} });
          }
        };
        bBtn.addEventListener('click', () => selectSub('bloom'));
        if (sBtn) sBtn.addEventListener('click', () => selectSub('shapes'));
        mBtn.addEventListener('click', () => selectSub('mixdown'));
        // Reflect the default (Bloom) in the button state.
        selectSub(view.classList.contains('mix-sub-mixdown') ? 'mixdown'
                : view.classList.contains('mix-sub-shapes') ? 'shapes' : 'bloom');
      })();
      // Pick the initial view in this order of preference:
      //   1. URL hash (#player / #mix) — survives mobile browsers that
      //      run the pre-body inline classList write too late, or in-app
      //      browser shells that strip body-class mutations during
      //      hand-off. This is the deep-link contract index.html uses,
      //      so we re-honor it here as the authoritative source.
      //   2. body class — set by the pre-body inline script, by the
      //      project loader, or by any other code path before init.
      //   3. Default to Make.
      const cls  = document.body.classList;
      const hash = (location.hash || '').toLowerCase();
      let initial  = hash === '#player' ? 'serialbox'
                   : hash === '#mix'    ? 'mix'
                   : cls.contains('view-serialbox') ? 'serialbox'
                   : cls.contains('view-mix')       ? 'mix'
                   : 'make';
      // Listen needs Drive access. If a #player deep-link (or stale
      // body class) lands a signed-out user here, fall back to Make
      // so they don't stare at an empty Player they can't populate.
      if (initial === 'serialbox' && !(window.bloopsAuth && window.bloopsAuth.isSignedIn())) {
        initial = 'make';
      }
      // Ensure the body class reflects the chosen view (the pre-body
      // script handled this for #player on the happy path, but some
      // mobile contexts skip that — apply unconditionally here).
      if (initial === 'serialbox') {
        cls.add('view-serialbox');
        cls.remove('view-mix');
      } else if (initial === 'mix') {
        cls.add('view-mix');
        cls.remove('view-serialbox');
      } else {
        cls.remove('view-serialbox', 'view-mix');
      }
      setActive(initial === 'serialbox' ? sbTab
              : initial === 'mix'       ? mixTab
              : bloopsTab);
      updateLabels(initial);
    })();

    // ---- Long-press context menu for saved blocks ----

    let ctxMenu = null;
    let longPressTimer = null;

    function dismissCtxMenu() {
      if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    }

    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.ctx-menu')) dismissCtxMenu();
    });

    function showCtxMenu(x, y, actions, opts) {
      opts = opts || {};
      dismissCtxMenu();
      ctxMenu = document.createElement('div');
      ctxMenu.className = 'ctx-menu';

      // Multi-step edit signal: when the selection spans 2+ steps the
      // menu wears a distinct accent + a header telling the user how
      // many steps every action will apply to. Built BEFORE the body so
      // the header is included in the height we measure for clamping.
      if (opts.multiCount && opts.multiCount > 1) {
        ctxMenu.classList.add('multi');
        const hdr = document.createElement('div');
        hdr.className = 'ctx-menu-header';
        hdr.textContent = `Editing ${opts.multiCount} steps`;
        ctxMenu.appendChild(hdr);
      }

      actions.forEach(a => {
        if (a === 'hr') { const hr = document.createElement('hr'); ctxMenu.appendChild(hr); return; }
        // Slider row: { slider:true, label, min, max, step, value, valFmt?, oninput }.
        // Stays put while dragged (pointerdown stopPropagation keeps the
        // outside-click dismiss from firing) and never auto-dismisses the menu.
        if (a.slider) {
          const row = document.createElement('div');
          row.className = 'ctx-menu-slider';
          const lab = document.createElement('span');
          lab.className = 'ctx-menu-slider-label';
          lab.textContent = a.label || '';
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = a.min; inp.max = a.max; inp.step = (a.step != null ? a.step : 1); inp.value = a.value;
          const valEl = document.createElement('span');
          valEl.className = 'ctx-menu-slider-val';
          const fmt = (v) => a.valFmt ? a.valFmt(v) : String(v);
          valEl.textContent = fmt(parseFloat(inp.value));
          inp.addEventListener('pointerdown', (e) => e.stopPropagation());
          inp.addEventListener('click', (e) => e.stopPropagation());
          inp.addEventListener('input', () => { const v = parseFloat(inp.value); valEl.textContent = fmt(v); if (a.oninput) a.oninput(v); });
          row.appendChild(lab); row.appendChild(inp); row.appendChild(valEl);
          ctxMenu.appendChild(row);
          return;
        }
        const btn = document.createElement('button');
        btn.textContent = a.label;
        if (a.danger) btn.classList.add('danger');
        if (a.disabled) btn.disabled = true;
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', () => { if (btn.disabled) return; a.fn(); dismissCtxMenu(); });
        ctxMenu.appendChild(btn);
      });

      document.body.appendChild(ctxMenu);
      const vw = window.innerWidth, vh = window.innerHeight;
      const mw = 160, mh = ctxMenu.offsetHeight || 180;
      ctxMenu.style.left = Math.min(x, vw - mw - 8) + 'px';
      ctxMenu.style.top  = Math.min(y, vh - mh - 8) + 'px';
    }

    function showRenameDialog(seqIndex) {
      const seq = savedSequences[seqIndex];
      if (!seq) return;
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Rename sequence</div>
        <input type="text" class="rename-input" maxlength="40" />
        <div class="sm-footer">
          <button type="button" class="sm-preview sm-cancel">Cancel</button>
          <button type="button" class="sm-apply sm-save">Save</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const input = modal.querySelector('.rename-input');
      input.value = seq.name;
      input.focus();
      input.select();
      const commit = () => {
        const newName = input.value.trim();
        if (newName) {
          savedSequences[seqIndex].name = newName;
          persistSaved();
          renderSavedSequences();
        }
        overlay.remove();
      };
      modal.querySelector('.sm-save').addEventListener('click', commit);
      modal.querySelector('.sm-cancel').addEventListener('click', () => overlay.remove());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') overlay.remove();
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // Inline action bar that surfaces the same options as the saved-
    // block long-press menu. Appears above the bank whenever a saved
    // sequence is selected (activeSeqIndex !== null). "Add to track…"
    // delegates back to the long-press menu (showCtxMenu) so the full
    // list of tracks stays in one place — the bar itself just shows
    // top-level actions to keep horizontal space sane on small screens.
    function refreshSavedActionsBar() {
      const bar = document.getElementById('saved-actions-bar');
      if (!bar) return;
      const seqIndex = activeSeqIndex;
      const saved = (seqIndex != null) ? savedSequences[seqIndex] : null;
      if (!saved) {
        bar.hidden = true;
        bar.innerHTML = '';
        return;
      }
      bar.hidden = false;
      bar.innerHTML = '';

      const label = document.createElement('span');
      label.className = 'saved-actions-label';
      label.textContent = saved.name;
      label.title = saved.name;
      bar.appendChild(label);

      const makeBtn = (text, title, fn, opts) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'saved-actions-btn' + (opts && opts.danger ? ' danger' : '');
        btn.textContent = text;
        if (title) btn.title = title;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          try { fn(e); } catch (err) {}
        });
        bar.appendChild(btn);
        return btn;
      };

      makeBtn('Rename…', 'Rename this sequence', () => showRenameDialog(seqIndex));
      makeBtn('⧉ Duplicate', 'Duplicate this sequence', () => {
        const copy = _cloneSavedSequence(savedSequences[seqIndex]);
        if (!copy) return;
        savedSequences.splice(seqIndex + 1, 0, copy);
        persistSaved();
        renderSavedSequences();
      });
      // Send this sequence to the master Bloom (Mix), in one of 3 modes —
      // opens the same submenu as the long-press menu, anchored to the button.
      makeBtn('🌸 Send to Bloom…', 'Send this sequence to the master Bloom', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = r.left, y = r.bottom + 4;
        setTimeout(() => {
          const seqs = (typeof _ambListMasterSeqs === 'function') ? _ambListMasterSeqs() : [];
          const sub = [{ label: '＋ New Seq', fn: () => _ambSendSavedToMaster(seqIndex, 'new') }];
          sub.push('hr');
          if (seqs.length) seqs.forEach(s => sub.push({ label: '⊕ Append → ' + s.name, fn: () => _ambSendSavedToMaster(seqIndex, 'append', s.id) }));
          else sub.push({ label: 'Append → (no Seqs yet)', disabled: true, fn: () => {} });
          sub.push('hr');
          if (seqs.length) seqs.forEach(s => sub.push({ label: '⇄ Interleave → ' + s.name, fn: () => _ambSendSavedToMaster(seqIndex, 'interleave', s.id) }));
          else sub.push({ label: 'Interleave → (no Seqs yet)', disabled: true, fn: () => {} });
          const _sid = (typeof _ambSampleIdOfSaved === 'function') ? _ambSampleIdOfSaved(saved) : null;
          if (_sid) { sub.push('hr'); sub.push({ label: '◫ As Sample layer', fn: () => _ambSendSampleToMaster(_sid, { chop: Math.max(1, (saved.steps || []).length) }) }); }
          if (typeof showCtxMenu === 'function') showCtxMenu(x, y, sub);
        }, 0);
      });
      makeBtn('Delete', 'Remove this sequence from the bank', () => {
        const removed = savedSequences[seqIndex];
        savedSequences.splice(seqIndex, 1);
        if (activeSeqIndex === seqIndex) {
          activeSeqIndex = null;
          sequence = [];
          renderSequence();
        } else if (activeSeqIndex !== null && seqIndex < activeSeqIndex) {
          activeSeqIndex--;
        }
        if (removed && removed.name) {
          replaceMatchingTrackItemsWithSilent(new Set([removed.name]));
        }
        persistSaved();
        renderSavedSequences();
      }, { danger: true });
    }

    function savedBlockActions(seqIndex, x, y) {
      const saved = savedSequences[seqIndex];
      const actions = [
        { label: 'Rename…',     fn: () => showRenameDialog(seqIndex) },
        { label: '⧉ Duplicate',  fn: () => {
          const copy = _cloneSavedSequence(savedSequences[seqIndex]);
          if (!copy) return;
          savedSequences.splice(seqIndex + 1, 0, copy);
          persistSaved();
          renderSavedSequences();
        } },
      ];
      actions.push('hr');
      // Single entry-point for adding to a track — opens the Copy ×N
      // dialog where the user can pick a destination (existing track
      // or new) and a count. The default is 1 copy so a plain "add
      // this sequence to a track" is still one click → Add.
      actions.push({ label: '⊕ Copy ×N to track…', fn: () => showCopySavedDialog(seqIndex) });
      actions.push('hr');
      // Send this sequence to the MASTER Bloom (in Mix), in one of 3 modes.
      // Deferred (setTimeout) so showCtxMenu's dismiss doesn't tear the submenu.
      actions.push({ label: '🌸 Send to Bloom ▸', fn: () => setTimeout(() => {
        const seqs = (typeof _ambListMasterSeqs === 'function') ? _ambListMasterSeqs() : [];
        const sub = [{ label: '＋ New Seq', fn: () => _ambSendSavedToMaster(seqIndex, 'new') }];
        sub.push('hr');
        if (seqs.length) seqs.forEach(s => sub.push({ label: '⊕ Append → ' + s.name, fn: () => _ambSendSavedToMaster(seqIndex, 'append', s.id) }));
        else sub.push({ label: 'Append → (no Seqs yet)', disabled: true, fn: () => {} });
        sub.push('hr');
        if (seqs.length) seqs.forEach(s => sub.push({ label: '⇄ Interleave → ' + s.name, fn: () => _ambSendSavedToMaster(seqIndex, 'interleave', s.id) }));
        else sub.push({ label: 'Interleave → (no Seqs yet)', disabled: true, fn: () => {} });
        // If this sequence's voice is a single-buffer sample, also offer the
        // raw Sample layer (chopped/whole) on the master Bloom.
        const _sid = (typeof _ambSampleIdOfSaved === 'function') ? _ambSampleIdOfSaved(saved) : null;
        if (_sid) {
          sub.push('hr');
          sub.push({ label: '◫ As Sample layer', fn: () => _ambSendSampleToMaster(_sid, { chop: Math.max(1, (saved.steps || []).length) }) });
        }
        showCtxMenu(x, y, sub);
      }, 0) });
      actions.push('hr');
      actions.push({ label: 'Delete', danger: true, fn: () => {
        const removed = savedSequences[seqIndex];
        savedSequences.splice(seqIndex, 1);
        if (activeSeqIndex === seqIndex) { activeSeqIndex = null; sequence = []; renderSequence(); }
        else if (activeSeqIndex !== null && seqIndex < activeSeqIndex) { activeSeqIndex--; }
        if (removed && removed.name) replaceMatchingTrackItemsWithSilent(new Set([removed.name]));
        persistSaved();
        renderSavedSequences();
      } });
      return actions;
    }

    // Open the "Copy ×N to track…" dialog from a saved-sequence long-press.
    // Lets the user lay down a repeated section in one shot instead of
    // dragging the same chip onto the track over and over.
    function showCopySavedDialog(seqIndex) {
      const seq = savedSequences[seqIndex];
      if (!seq) return;
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      const trackOptions = tracks.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');
      modal.innerHTML = `
        <div class="sm-title">Copy "${seq.name}" to track</div>
        <div class="sm-param">
          <div class="sm-param-row">Iterations</div>
          <div class="sm-stepper" style="display:flex;align-items:stretch;gap:6px;">
            <button type="button" id="copy-n-dec" aria-label="Decrease" style="flex:0 0 36px;padding:0;background:#0a0a14;border:1px solid #2d2d3f;border-radius:6px;color:#cbd5e0;font-family:inherit;font-size:1.1rem;font-weight:700;cursor:pointer;">−</button>
            <input type="number" id="copy-n" min="1" max="64" step="1" value="1" inputmode="numeric" style="flex:1 1 0;min-width:0;padding:6px 10px;background:#0a0a14;border:1px solid #2d2d3f;border-radius:6px;color:#e2e8f0;font-family:inherit;font-size:0.95rem;text-align:center;" />
            <button type="button" id="copy-n-inc" aria-label="Increase" style="flex:0 0 36px;padding:0;background:#0a0a14;border:1px solid #2d2d3f;border-radius:6px;color:#cbd5e0;font-family:inherit;font-size:1.1rem;font-weight:700;cursor:pointer;">+</button>
          </div>
        </div>
        <div class="sm-section-label">Destination</div>
        <select id="copy-track" style="width:100%;padding:6px 10px;background:#0a0a14;border:1px solid #2d2d3f;color:#e2e8f0;border-radius:6px;font-family:inherit;font-size:0.85rem;margin-bottom:10px;">
          <option value="new">— New track —</option>
          ${trackOptions}
        </select>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="copy-cancel">Cancel</button>
          <button type="button" class="sm-apply" id="copy-apply">Add</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const nInput = modal.querySelector('#copy-n');
      const clampN = (v) => Math.max(1, Math.min(64, Math.floor(Number(v) || 0)));
      const setN = (v) => { nInput.value = String(clampN(v)); };
      // Free typing: re-clamp on blur so partial inputs (empty string,
      // out-of-range) snap back to a valid integer when the user
      // commits, without fighting them mid-edit.
      nInput.addEventListener('blur', () => {
        const v = parseInt(nInput.value, 10);
        if (!Number.isFinite(v)) { nInput.value = '1'; return; }
        nInput.value = String(clampN(v));
      });
      modal.querySelector('#copy-n-dec').addEventListener('click', () => {
        setN(clampN(parseInt(nInput.value, 10)) - 1);
      });
      modal.querySelector('#copy-n-inc').addEventListener('click', () => {
        setN(clampN(parseInt(nInput.value, 10)) + 1);
      });

      modal.querySelector('#copy-cancel').addEventListener('click', () => overlay.remove());
      modal.querySelector('#copy-apply').addEventListener('click', async () => {
        const n = Math.max(1, Math.min(64, parseInt(nInput.value, 10) || 1));
        const dest = modal.querySelector('#copy-track').value;
        let trackIdx;
        if (dest === 'new') {
          let opts;
          if (seq && seq.type === 'audio') {
            const ch = await detectAudioChannelCount(seq.audioDataUrl);
            opts = { stereo: ch >= 2 };
          }
          trackIdx = addTrack(opts);
        } else {
          trackIdx = parseInt(dest, 10);
          if (!Number.isFinite(trackIdx) || !tracks[trackIdx]) { overlay.remove(); return; }
        }
        for (let i = 0; i < n; i++) addSavedToTrack(trackIdx, seq);
        overlay.remove();
      });
    }

    // For each track item whose name matches one of `names`, swap it for a
    // silent placeholder of the same total duration. Track items keep their
    // grid-column position so anything after the deleted entry stays put
    // instead of sliding earlier in time.
    function replaceMatchingTrackItemsWithSilent(names) {
      let touched = false;
      tracks.forEach(track => {
        track.items.forEach((item, idx) => {
          if (item.type === 'silent' || item.type === 'audio') return;
          if (item && item.name && names.has(item.name)) {
            const dur = itemDurationMs(item) / 1000;
            track.items[idx] = {
              type: 'silent',
              name: item.name + ' (removed)',
              durationSec: dur,
            };
            touched = true;
          }
        });
      });
      if (touched) {
        persistTracks();
        renderTracks();
      }
    }

    // ---- Drag-and-drop reorder ----

    let _dragIdx = null;
    let _touchClone = null;
    let _touchOffsetX = 0, _touchOffsetY = 0;
    let _touchDropTarget = null;

    function moveSequence(from, to) {
      if (from === to) return;
      const [item] = savedSequences.splice(from, 1);
      savedSequences.splice(to, 0, item);
      if (activeSeqIndex === from) activeSeqIndex = to;
      else if (from < activeSeqIndex && to >= activeSeqIndex) activeSeqIndex--;
      else if (from > activeSeqIndex && to <= activeSeqIndex) activeSeqIndex++;
      persistSaved();
      renderSavedSequences();
    }

    function clearDragOver() {
      document.getElementById('saved-grid').querySelectorAll('.drag-over')
        .forEach(el => el.classList.remove('drag-over'));
    }

    function bindDrag(block, i) {
      block.draggable = true;

      block.addEventListener('dragstart', (e) => {
        _dragIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => block.classList.add('dragging'));
      });

      block.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (_dragIdx === i) return;
        clearDragOver();
        block.classList.add('drag-over');
      });

      block.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });

      block.addEventListener('dragleave', (e) => {
        if (!block.contains(e.relatedTarget)) block.classList.remove('drag-over');
      });

      block.addEventListener('drop', (e) => {
        e.preventDefault();
        clearDragOver();
        if (_dragIdx !== null && _dragIdx !== i) moveSequence(_dragIdx, i);
        _dragIdx = null;
      });

      block.addEventListener('dragend', () => {
        block.classList.remove('dragging');
        clearDragOver();
        _dragIdx = null;
      });

      // Touch drag — threshold-based so a quick tap still fires the
      // native click (loading the saved sequence into the workspace).
      block.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const startTouch = e.touches[0];
        const startX = startTouch.clientX;
        const startY = startTouch.clientY;
        const rect = block.getBoundingClientRect();
        let dragStarted = false;
        const DRAG_THRESHOLD = 10;

        const startDrag = () => {
          dragStarted = true;
          _dragIdx = i;
          _touchOffsetX = startX - rect.left;
          _touchOffsetY = startY - rect.top;
          const clone = block.cloneNode(true);
          Object.assign(clone.style, {
            position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
            width: rect.width + 'px', height: rect.height + 'px',
            opacity: '0.85', pointerEvents: 'none', zIndex: '9999',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)', borderRadius: '8px',
          });
          document.body.appendChild(clone);
          _touchClone = clone;
          block.classList.add('dragging');
        };

        const clearAllDragOver = () => {
          clearDragOver();
          document.querySelectorAll('.track-grid.drag-over').forEach(g => g.classList.remove('drag-over'));
        };

        const onMove = (ev) => {
          const t = ev.touches[0];
          if (!dragStarted) {
            const dx = t.clientX - startX;
            const dy = t.clientY - startY;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            startDrag();
          }
          ev.preventDefault();
          _touchClone.style.left = (t.clientX - _touchOffsetX) + 'px';
          _touchClone.style.top  = (t.clientY - _touchOffsetY) + 'px';
          _touchClone.style.visibility = 'hidden';
          const el = document.elementFromPoint(t.clientX, t.clientY);
          _touchClone.style.visibility = '';
          clearAllDragOver();
          _touchDropTarget = null;
          const savedTarget = el?.closest('.saved-block');
          const trackGrid   = el?.closest('.track-grid');
          if (savedTarget) {
            const idx = parseInt(savedTarget.dataset.seqIndex);
            if (!isNaN(idx) && idx !== _dragIdx) {
              savedTarget.classList.add('drag-over');
              _touchDropTarget = { kind: 'reorder', idx };
            }
          } else if (trackGrid) {
            const tIdx = parseInt(trackGrid.dataset.trackIdx);
            if (!isNaN(tIdx)) {
              trackGrid.classList.add('drag-over');
              _touchDropTarget = { kind: 'track', idx: tIdx };
            }
          }
        };

        const onEnd = () => {
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
          if (!dragStarted) {
            // No drag occurred — let the native click event fire on the block,
            // which runs the load-saved-sequence handler.
            return;
          }
          _touchClone?.remove(); _touchClone = null;
          block.classList.remove('dragging');
          clearAllDragOver();
          if (_touchDropTarget) {
            if (_touchDropTarget.kind === 'reorder' && _touchDropTarget.idx !== _dragIdx) {
              moveSequence(_dragIdx, _touchDropTarget.idx);
            } else if (_touchDropTarget.kind === 'track' && savedSequences[_dragIdx]) {
              addSavedToTrack(_touchDropTarget.idx, savedSequences[_dragIdx]);
            }
          }
          _dragIdx = null; _touchDropTarget = null;
        };

        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
      }, { passive: true });
    }

    function bindLongPress(block, seqIndex) {
      block.addEventListener('pointerdown', (e) => {
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          navigator.vibrate?.(40);
          showCtxMenu(e.clientX, e.clientY, savedBlockActions(seqIndex, e.clientX, e.clientY));
        }, 500);
      });
      const cancel = () => { clearTimeout(longPressTimer); longPressTimer = null; };
      block.addEventListener('pointerup',    cancel);
      block.addEventListener('pointercancel', cancel);
      block.addEventListener('pointermove',  cancel);
      // Right-click also opens the same menu (desktop affordance for delete etc.)
      block.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, savedBlockActions(seqIndex, e.clientX, e.clientY));
      });
    }

    function cellActions(noteIndex) {
      const note = notes[noteIndex];
      return [
        { label: 'Sound editor…', fn: () => showSoundEditor(noteIndex) },
        'hr',
        { label: `Remove last ${note.label}`, fn: () => {
            const idx = [...sequence].map((s,i) => [s,i]).reverse().find(([s]) => s.cellIndex === noteIndex)?.[1];
            if (idx != null) { sequence.splice(idx, 1); renderSequence(); document.getElementById('save-btn').disabled = sequence.length === 0; }
        }},
        { label: `Remove all ${note.label}`, fn: () => {
            sequence = sequence.filter(s => s.cellIndex !== noteIndex);
            renderSequence();
            document.getElementById('save-btn').disabled = sequence.length === 0;
        }},
        'hr',
        { label: 'Reset sound → Sawtooth', fn: () => {
            cellSounds[noteIndex] = 'sawtooth';
            cellParams[noteIndex] = _defaultCellParams();
            const sel = cells[noteIndex].querySelector('.cell-sound-select');
            if (sel) sel.value = 'sawtooth';
            updateScaleBanner();
        }},
      ];
    }

    // Grab the loaded AudioBuffer behind a single-buffer sample voice.
    function _getSampleAudioBuffer(id) {
      try {
        const info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(id) : null;
        if (!info || !info.sampler || !info.sampler._buffers || !info.urls) return null;
        const bufs = info.sampler._buffers;
        for (const noteName of Object.keys(info.urls)) {
          let m; try { m = Math.round(Tone.Frequency(noteName).toMidi()); } catch (e) { continue; }
          if (bufs.has(m)) { const tb = bufs.get(m); return (tb && typeof tb.get === 'function') ? tb.get() : null; }
        }
      } catch (e) {}
      return null;
    }
    // Slice [startF,endF] (fractions) of an AudioBuffer into a new one, optionally reversed.
    function _sliceAudioBuffer(ac, buf, startF, endF, reverse) {
      const total = buf.length;
      let s = Math.floor(startF * total), e = Math.floor(endF * total);
      s = Math.max(0, Math.min(total - 1, s));
      e = Math.max(s + 1, Math.min(total, e));
      const len = e - s, ch = buf.numberOfChannels;
      const out = ac.createBuffer(ch, len, buf.sampleRate);
      for (let c = 0; c < ch; c++) {
        const src = buf.getChannelData(c), dst = out.getChannelData(c);
        if (reverse) { for (let i = 0; i < len; i++) dst[i] = src[e - 1 - i]; }
        else { for (let i = 0; i < len; i++) dst[i] = src[s + i]; }
      }
      return out;
    }
    // Overlay `copies` time-shifted copies of a loop slice onto itself to smooth
    // the loop seam (and thicken the sound). Each copy k is rotated CIRCULARLY by
    // k·offset samples (modulo the length), so the result stays the exact same
    // length and still loops perfectly — the discontinuity at any one copy's wrap
    // point is masked by the others, which are continuous there. The sum is
    // peak-normalized back to the input's peak so adding copies never clips.
    //
    // `spread` (0..1) pans the copies across the stereo field: each copy gets an
    // equal-power pan position fanned out from centre, so the output is stereo
    // (copies summed mono per voice, then panned). spread=0 keeps the source's
    // channel layout and sums in place (mono-faithful).
    //
    // `detuneCents` (>0) pitch-shifts each copy by a symmetric spread of ±cents
    // (read circularly with linear interpolation at the per-copy rate), which
    // decorrelates the copies into a lush, slowly-beating chorus instead of a
    // static comb. A detuned copy isn't periodic at length L, so its wrap has a
    // small step — buildOut enforces a crossfade floor when detune is on to mask
    // the summed seam.
    function _buildPadBuffer(ac, slice, copies, offsetSec, spread, detuneCents) {
      copies = Math.max(1, Math.min(8, copies | 0));
      if (copies <= 1) return slice; // spread/offset/detune need ≥2 copies to do anything
      spread = Math.max(0, Math.min(1, spread || 0));
      detuneCents = Math.max(0, Math.min(50, detuneCents || 0));
      const L = slice.length, srcCh = slice.numberOfChannels, sr = slice.sampleRate;
      if (L < 2) return slice;
      const offSamp = Math.max(0, Math.round((offsetSec || 0) * sr));
      const rateOf = (k) => detuneCents > 0 ? Math.pow(2, (((k / (copies - 1)) * 2 - 1) * detuneCents) / 1200) : 1;
      const lerp = (arr, pos) => { const p = ((pos % L) + L) % L, i0 = Math.floor(p), f = p - i0, i1 = (i0 + 1) % L; return arr[i0] * (1 - f) + arr[i1] * f; };
      let peakIn = 0;
      for (let c = 0; c < srcCh; c++) { const s = slice.getChannelData(c); for (let i = 0; i < L; i++) { const a = s[i] < 0 ? -s[i] : s[i]; if (a > peakIn) peakIn = a; } }
      const stereo = spread > 0;
      const out = ac.createBuffer(stereo ? 2 : srcCh, L, sr);
      const chans = []; for (let c = 0; c < srcCh; c++) chans.push(slice.getChannelData(c));
      const monoLerp = (pos) => { let v = 0; for (let c = 0; c < srcCh; c++) v += lerp(chans[c], pos); return v / srcCh; };
      if (stereo) {
        const dL = out.getChannelData(0), dR = out.getChannelData(1);
        for (let k = 0; k < copies; k++) {
          const sh = (offSamp * k) % L, r = rateOf(k);
          const pan = ((k / (copies - 1)) * 2 - 1) * spread;   // −spread..+spread
          const theta = (pan + 1) * Math.PI / 4;               // 0..π/2 (equal power)
          const gl = Math.cos(theta), gr = Math.sin(theta);
          for (let i = 0; i < L; i++) { const v = monoLerp(sh + i * r); dL[i] += v * gl; dR[i] += v * gr; }
        }
      } else {
        for (let c = 0; c < srcCh; c++) {
          const s = chans[c], d = out.getChannelData(c);
          for (let k = 0; k < copies; k++) {
            const sh = (offSamp * k) % L, r = rateOf(k);
            for (let i = 0; i < L; i++) d[i] += lerp(s, sh + i * r);
          }
        }
      }
      let peakOut = 0;
      for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < L; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peakOut) peakOut = a; } }
      if (peakOut > 1e-6) {
        const g = (peakIn > 1e-6 ? peakIn : 0.9) / peakOut;
        for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < L; i++) d[i] *= g; }
      }
      return out;
    }
    // Remove any DC offset (per channel) so the loop wrap doesn't tick and no
    // headroom is wasted on a constant bias. Cheap mean-subtraction, in place.
    function _dcBlockBufferInPlace(buf) {
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        let m = 0; for (let i = 0; i < d.length; i++) m += d[i];
        m /= d.length || 1;
        if (Math.abs(m) > 1e-5) for (let i = 0; i < d.length; i++) d[i] -= m;
      }
    }
    // Bake a 2nd-order (Butterworth) low-pass into a buffer, in place — RBJ
    // cookbook biquad, run per channel. Kept synchronous (no OfflineAudioContext)
    // so the pad preview and the saved WAV use the exact same rendered audio.
    function _lowpassBufferInPlace(buf, cutoffHz, Q) {
      const sr = buf.sampleRate;
      const fc = Math.max(40, Math.min(sr * 0.45, cutoffHz));
      const w0 = 2 * Math.PI * fc / sr, cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
      const alpha = sinw0 / (2 * (Q || 0.707));
      const a0 = 1 + alpha;
      const b0 = ((1 - cosw0) / 2) / a0, b1 = (1 - cosw0) / a0, b2 = b0;
      const a1 = (-2 * cosw0) / a0, a2 = (1 - alpha) / a0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < d.length; i++) {
          const x0 = d[i];
          const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
          d[i] = y0;
        }
      }
    }
    // Make a loop seamless by crossfading its tail over its head: the last
    // `xf` samples are blended (equal-power) with the first `xf` so the wrap
    // morphs continuously instead of jumping. The result is `xf` samples
    // shorter and loops cleanly with no pre-roll needed. xf=0 → unchanged.
    function _crossfadeLoopBuffer(ac, buf, xfSec) {
      const L = buf.length, ch = buf.numberOfChannels, sr = buf.sampleRate;
      let xf = Math.round((xfSec || 0) * sr);
      if (xf <= 0 || L < 4) return buf;
      xf = Math.min(xf, Math.floor(L / 2)); // can't fade more than half the loop
      const newLen = L - xf;
      const out = ac.createBuffer(ch, newLen, sr);
      for (let c = 0; c < ch; c++) {
        const s = buf.getChannelData(c), d = out.getChannelData(c);
        for (let i = xf; i < newLen; i++) d[i] = s[i];
        for (let i = 0; i < xf; i++) {
          const t = (i + 0.5) / xf;             // 0..1 across the fade
          const gin = Math.sin(t * Math.PI / 2);  // head fades in
          const gout = Math.cos(t * Math.PI / 2); // tail fades out
          d[i] = s[i] * gin + s[i + newLen] * gout; // s[i+newLen] = the tail
        }
      }
      return out;
    }
    // ---- Pad reverb (Freeverb, baked synchronously into a seamless loop) ----
    // Classic Schroeder–Moorer Freeverb: 8 parallel damped feedback-comb filters
    // → series allpass diffusers, per channel (canonical tuning.h delays/gains).
    // Because a pad is a perfect loop, we can bake a *seamless* reverb wash into
    // it: feed the loop in repeatedly until the tail reaches steady state, then
    // extract exactly one loop period from the end. A periodic input through a
    // stable LTI reverb produces a periodic output (same period), so that period
    // loops with no seam — the reverb tail wraps into itself as a continuous wash
    // (the right behaviour for a sustained, looping pad).
    //
    // Types vary the comb/allpass topology for distinct tone: Room/Hall/Plate/
    // Spring/Cathedral. `mix` 0..1 equal-power crossfades dry⇄wet (0 = 100% dry,
    // 1 = 100% wet, dry killed). `size` 0..100 scales decay length + room
    // feedback; `tone` 0..100 sets brightness (high = bright, low = dark/damped).
    // Output is stereo (the L/R Freeverb stereospread decorrelates even a mono
    // source into a natural stereo field). Returns a NEW buffer; mix<=0 → input.
    const _REVERB_TYPES = {
      // combScale: multiplies comb delays (small = denser/brighter, e.g. plate);
      // apFb: allpass diffusion feedback; apN: number of allpass stages;
      // tail: base decay seconds at size 50; width: stereo width 0..1.
      room:      { combScale: 1.00, apFb: 0.50, apN: 4, tail: 1.1, width: 0.9, roomBias: 0.00 },
      hall:      { combScale: 1.18, apFb: 0.50, apN: 4, tail: 2.6, width: 1.0, roomBias: 0.06 },
      plate:     { combScale: 0.68, apFb: 0.55, apN: 4, tail: 1.6, width: 1.0, roomBias: 0.03 },
      spring:    { combScale: 0.86, apFb: 0.66, apN: 6, tail: 1.8, width: 0.45, roomBias: 0.05 },
      cathedral: { combScale: 1.34, apFb: 0.50, apN: 4, tail: 4.6, width: 1.0, roomBias: 0.09 },
    };
    function _reverbBufferOffline(ac, buf, type, mix, size, tone) {
      mix = Math.max(0, Math.min(1, mix || 0));
      if (mix <= 0) return buf;
      const T = _REVERB_TYPES[type] || _REVERB_TYPES.room;
      const L = buf.length, sr = buf.sampleRate;
      if (L < 4) return buf;
      // Canonical Freeverb tuning (delays at 44.1 kHz), scaled to this sr & type.
      const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
      const ALLP = [556, 441, 341, 225, 180, 141];
      const STEREOSPREAD = 23, FIXEDGAIN = 0.015;
      const srScale = sr / 44100;
      const sizeN = Math.max(0, Math.min(1, (Number.isFinite(size) ? size : 70) / 100));
      const toneN = Math.max(0, Math.min(1, (Number.isFinite(tone) ? tone : 50) / 100));
      // roomsize → comb feedback (Freeverb: room*0.28 + 0.7). Bigger size → longer.
      const room = Math.max(0, Math.min(0.97, 0.55 + sizeN * 0.40 + T.roomBias));
      const feedback = room * 0.28 + 0.7;
      // damping (Freeverb: damp*0.4). Bright tone → low damping.
      const damp1 = (1 - toneN) * 0.4, damp2 = 1 - damp1;
      const apFb = T.apFb;
      const apN = Math.max(1, Math.min(ALLP.length, T.apN | 0));
      // Warm-up: feed the loop until the tail is well past its decay before we
      // grab a period, so the extracted window is deep in steady state (seamless).
      const tailSec = T.tail * (0.45 + sizeN * 1.5);
      const warmup = Math.max(L, Math.ceil(sr * tailSec * 1.6));
      // Render `xf` EXTRA samples past one loop so the wet loop's tail can be
      // equal-power crossfaded over its head. That guarantees a seamless wet
      // loop even when the reverb tail hasn't fully decayed within the warm-up
      // (high feedback / long sizes) — which is what was popping at the wrap.
      const xf = Math.max(1, Math.min(Math.round(sr * 0.06), Math.floor(L / 2)));
      const wetLen = L + xf;
      const total = warmup + wetLen;
      const out = ac.createBuffer(2, L, sr);
      const wetTmp = [new Float32Array(wetLen), new Float32Array(wetLen)];
      // Build per-channel comb + allpass banks. Channel 1 adds stereospread.
      const makeBank = (chOff) => {
        const combs = COMB.map((d) => {
          const len = Math.max(1, Math.round(d * T.combScale * srScale) + chOff);
          return { buf: new Float32Array(len), i: 0, store: 0, len };
        });
        const allps = [];
        for (let a = 0; a < apN; a++) {
          const len = Math.max(1, Math.round(ALLP[a] * T.combScale * srScale) + chOff);
          allps.push({ buf: new Float32Array(len), i: 0, len });
        }
        return { combs, allps };
      };
      const banks = [makeBank(0), makeBank(STEREOSPREAD)];
      const srcCh = buf.numberOfChannels;
      const src0 = buf.getChannelData(0);
      const src1 = srcCh > 1 ? buf.getChannelData(1) : src0;
      let peakWet = 0, peakDry = 0;
      for (let c = 0; c < srcCh; c++) {
        const s = buf.getChannelData(c);
        for (let i = 0; i < L; i++) { const a = s[i] < 0 ? -s[i] : s[i]; if (a > peakDry) peakDry = a; }
      }
      for (let ch = 0; ch < 2; ch++) {
        const { combs, allps } = banks[ch];
        const src = ch === 0 ? src0 : src1;
        const dst = wetTmp[ch];
        for (let n = 0; n < total; n++) {
          const input = src[n % L] * FIXEDGAIN;
          let acc = 0;
          for (let k = 0; k < combs.length; k++) {
            const cb = combs[k], outv = cb.buf[cb.i];
            cb.store = outv * damp2 + cb.store * damp1;
            cb.buf[cb.i] = input + cb.store * feedback;
            if (++cb.i >= cb.len) cb.i = 0;
            acc += outv;
          }
          for (let a = 0; a < allps.length; a++) {
            const ap = allps[a], bufout = ap.buf[ap.i];
            ap.buf[ap.i] = acc + bufout * apFb;
            acc = bufout - acc;
            if (++ap.i >= ap.len) ap.i = 0;
          }
          if (n >= warmup) {
            const o = n - warmup;
            dst[o] = acc;
            const aa = acc < 0 ? -acc : acc; if (aa > peakWet) peakWet = aa;
          }
        }
      }
      // Crossfade the wet loop seamless: blend its last `xf` samples (the tail,
      // s[i+L]) over its first `xf` (the head) with an equal-power curve, writing
      // the L-length result into the output channels. No wrap discontinuity → no
      // pop, independent of how far the tail decayed.
      const wL = out.getChannelData(0), wR = out.getChannelData(1);
      for (let ch = 0; ch < 2; ch++) {
        const s = wetTmp[ch], d = ch === 0 ? wL : wR;
        for (let i = xf; i < L; i++) d[i] = s[i];
        for (let i = 0; i < xf; i++) {
          const t = (i + 0.5) / xf;
          const gin = Math.sin(t * Math.PI / 2), gout = Math.cos(t * Math.PI / 2);
          d[i] = s[i] * gin + s[i + L] * gout;
        }
      }
      // Normalize wet to the dry peak so the mix slider reads consistently across
      // types/sizes, then apply stereo width, then equal-power dry⇄wet crossfade.
      const wetNorm = peakWet > 1e-6 ? (peakDry > 1e-6 ? peakDry : 0.9) / peakWet : 0;
      const width = T.width;
      const dryGain = Math.cos(mix * Math.PI / 2), wetGain = Math.sin(mix * Math.PI / 2);
      let peakOut = 0;
      for (let i = 0; i < L; i++) {
        let l = wL[i] * wetNorm, r = wR[i] * wetNorm;
        const mid = (l + r) * 0.5;
        l = mid + (l - mid) * width; r = mid + (r - mid) * width;
        const dl = src0[i], dr = src1[i];
        const ol = dl * dryGain + l * wetGain, or = dr * dryGain + r * wetGain;
        wL[i] = ol; wR[i] = or;
        const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
        if (al > peakOut) peakOut = al; if (ar > peakOut) peakOut = ar;
      }
      if (peakOut > 0.99) { const g = 0.99 / peakOut; for (let i = 0; i < L; i++) { wL[i] *= g; wR[i] *= g; } }
      return out;
    }
    // Waveform sample editor: trim (draggable start/end) + reverse + preview,
    // save as a NEW sample. `onSaved(newId)` fires after a successful save.
    // ---- Capture sample (record from mic → tuned, named voice) ---------
    function showCaptureSampleDialog() {
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { alert('Audio is not ready yet.'); return; }
      let stream = null, rec = null, chunks = [], recordedBlob = null, audioBuf = null;
      let detected = null, previewNode = null, recording = false;
      let rootNote = 'C4', tuneCents = 0;

      // Root-note options, C2..C6.
      let rootOpts = '';
      for (let m = 36; m <= 84; m++) { let nm = 'C4'; try { nm = Tone.Frequency(m, 'midi').toNote(); } catch (e) {} rootOpts += '<option value="' + nm + '">' + nm + '</option>'; }

      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal capture-sample-modal';
      modal.innerHTML =
        '<div class="sm-title">Capture sample</div>' +
        '<div class="cap-rec-row">' +
          '<button type="button" class="cap-rec-btn" id="cap-rec">● Record</button>' +
          '<span class="cap-status" id="cap-status">Press Record, make a sound, then Stop.</span>' +
        '</div>' +
        '<div class="cap-analysis" id="cap-analysis" style="display:none;">' +
          '<div class="cap-detected" id="cap-detected"></div>' +
          '<div class="ee-top">' +
            '<label class="ee-field"><span>Root note (plays natural)</span><select id="cap-root">' + rootOpts + '</select></label>' +
            '<label class="ee-field ee-name"><span>Fine tune <em id="cap-cents-v">0¢</em></span><input type="range" id="cap-cents" min="-50" max="50" step="1" value="0"></label>' +
            '<button type="button" class="sm-wave" id="cap-preview">▶ Preview</button>' +
          '</div>' +
          '<label class="ee-field ee-name" style="margin-top:6px;"><span>Name</span><input type="text" id="cap-name" placeholder="My sample"></label>' +
        '</div>' +
        '<div class="se-wave-actions">' +
          '<button type="button" class="sm-wave" id="cap-cancel">Cancel</button>' +
          '<button type="button" class="sm-apply" id="cap-save" disabled>Save sample</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const recBtn = modal.querySelector('#cap-rec');
      const statusEl = modal.querySelector('#cap-status');
      const analysisEl = modal.querySelector('#cap-analysis');
      const detectedEl = modal.querySelector('#cap-detected');
      const rootSel = modal.querySelector('#cap-root');
      const centsEl = modal.querySelector('#cap-cents');
      const centsV = modal.querySelector('#cap-cents-v');
      const nameEl = modal.querySelector('#cap-name');
      const saveBtn = modal.querySelector('#cap-save');

      const stopPreview = () => { try { previewNode && previewNode.stop(); } catch (e) {} previewNode = null; };
      const stopStream = () => { try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {} stream = null; };
      const close = () => { stopPreview(); stopStream(); try { if (rec && rec.state === 'recording') rec.stop(); } catch (e) {} try { document.body.removeChild(overlay); } catch (e) {} };

      async function startRec() {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) { statusEl.textContent = 'Microphone permission denied.'; return; }
        const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
        const mime = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
        try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
        catch (e) { statusEl.textContent = 'Recording is not supported here.'; stopStream(); return; }
        chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        rec.onstop = async () => {
          stopStream();
          recording = false;
          recBtn.textContent = '● Record';
          recBtn.classList.remove('recording');
          statusEl.textContent = 'Analyzing…';
          try {
            recordedBlob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            audioBuf = await ac.decodeAudioData(await recordedBlob.arrayBuffer());
          } catch (e) { statusEl.textContent = 'Could not decode the recording.'; return; }
          const hz = (typeof _detectPitchHz === 'function') ? _detectPitchHz(audioBuf) : null;
          detected = (hz && typeof _hzToNoteInfo === 'function') ? _hzToNoteInfo(hz) : null;
          if (detected) {
            detectedEl.textContent = 'Detected pitch: ' + hz.toFixed(1) + ' Hz · ' + detected.note +
              (detected.cents ? (detected.cents > 0 ? ' +' : ' ') + detected.cents + '¢' : '');
            rootNote = detected.note; rootSel.value = detected.note;
            // Default the fine-tune to cancel the detected deviation → in tune.
            tuneCents = detected.cents; centsEl.value = String(detected.cents); centsV.textContent = detected.cents + '¢';
          } else {
            detectedEl.textContent = 'No clear pitch detected — pick a root note manually.';
            rootNote = 'C4'; rootSel.value = 'C4'; tuneCents = 0; centsEl.value = '0'; centsV.textContent = '0¢';
          }
          analysisEl.style.display = '';
          saveBtn.disabled = false;
          statusEl.textContent = 'Recorded. Tune + name it, then Save.';
        };
        rec.start();
        recording = true;
        recBtn.textContent = '■ Stop';
        recBtn.classList.add('recording');
        statusEl.textContent = 'Recording… press Stop when done.';
      }

      recBtn.addEventListener('click', () => {
        if (recording) { try { rec.stop(); } catch (e) {} }
        else startRec();
      });
      rootSel.addEventListener('change', () => { rootNote = rootSel.value || 'C4'; });
      centsEl.addEventListener('input', () => { tuneCents = parseInt(centsEl.value, 10) || 0; centsV.textContent = tuneCents + '¢'; });
      modal.querySelector('#cap-preview').addEventListener('click', () => {
        if (!audioBuf) return;
        stopPreview();
        try {
          const src = ac.createBufferSource(); src.buffer = audioBuf;
          src.playbackRate.value = Math.pow(2, -tuneCents / 1200); // hear the fine-tuned pitch
          src.connect(ac.destination); src.start();
          previewNode = src;
        } catch (e) {}
      });
      modal.querySelector('#cap-cancel').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      saveBtn.addEventListener('click', async () => {
        if (!recordedBlob) return;
        const nm = (nameEl.value || '').trim() || 'sample';
        saveBtn.disabled = true; statusEl.textContent = 'Saving…';
        try {
          const { id } = await registerSampleFromBlob(recordedBlob, nm, { rootNote, tuneCents });
          if (typeof _ambRefreshAllToneSelects === 'function') _ambRefreshAllToneSelects();
          // Use it as the grid voice immediately, pitched (not sliced) so it
          // plays chromatically from the bound root note.
          if (typeof applyToneToAllCells === 'function') { try { applyToneToAllCells('sample:' + id, 'none'); } catch (e) {} }
          close();
        } catch (e) {
          console.warn('Capture save failed', e);
          statusEl.textContent = 'Could not save the sample.';
          saveBtn.disabled = false;
        }
      });
    }

    // ---- Ensemble editor ----------------------------------------------
    // Build / edit a multi-tone "ensemble" voice: pick N tones, shape each
    // (ADSR + per-tone octave/detune/pan/level), choose a play mode, preview,
    // and save as a named voice that appears everywhere a tone is picked.
    function _ensembleDefaultMember() {
      return { type: 'sine', attack: 10, decay: 100, sustain: 50, release: 1400, octave: 0, detune: 0, pan: 0, level: 100 };
    }
    function showEnsembleEditor(editId) {
      const C4 = 261.63;
      const existing = (editId != null) ? (typeof getEnsemble === 'function' ? getEnsemble(editId) : null) : null;
      const def = existing
        ? JSON.parse(JSON.stringify(existing))
        : { id: null, name: '', mode: 'stack', members: [_ensembleDefaultMember()] };
      if (!Array.isArray(def.members) || !def.members.length) def.members = [_ensembleDefaultMember()];

      const voiceOpts = (typeof getAllSoundOptions === 'function' ? getAllSoundOptions() : [])
        .filter(o => o && typeof o.value === 'string' && !o.value.startsWith('ensemble:'));
      const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal ensemble-editor-modal';
      const ensList = (typeof ensembles !== 'undefined') ? Array.from(ensembles.values()) : [];
      modal.innerHTML =
        '<div class="sm-title">' + (existing ? 'Edit ensemble' : 'Create ensemble') + '</div>' +
        '<div class="ee-top">' +
          '<label class="ee-field ee-name"><span>Name</span><input type="text" id="ee-name" placeholder="My ensemble" value="' + esc(def.name) + '"></label>' +
          '<label class="ee-field"><span>Play mode</span><select id="ee-mode">' +
            '<option value="stack">Stacked (unison)</option>' +
            '<option value="stackOffset">Stacked + offsets</option>' +
            '<option value="rr">Round-robin</option>' +
          '</select></label>' +
          (ensList.length ? '<label class="ee-field"><span>Load</span><select id="ee-load"><option value="">— new —</option>' +
            ensList.map(d => '<option value="' + esc(d.id) + '"' + (existing && String(d.id) === String(existing.id) ? ' selected' : '') + '>' + esc(d.name || ('Ensemble ' + d.id)) + '</option>').join('') +
          '</select></label>' : '') +
          (existing ? '<button type="button" class="ee-del" id="ee-delete" title="Delete this ensemble">🗑 Delete</button>' : '') +
        '</div>' +
        '<div class="ee-members" id="ee-members"></div>' +
        '<div class="ee-addrow"><button type="button" class="sm-wave" id="ee-add">+ Add tone</button></div>' +
        '<div class="se-wave-actions">' +
          '<button type="button" class="sm-wave" id="ee-preview">▶ Preview ensemble</button>' +
          '<button type="button" class="sm-wave" id="ee-cancel">Cancel</button>' +
          '<button type="button" class="sm-apply" id="ee-save">Save voice</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const modeSel = modal.querySelector('#ee-mode'); modeSel.value = def.mode || 'stack';
      const membersWrap = modal.querySelector('#ee-members');
      const close = () => { try { document.body.removeChild(overlay); } catch (e) {} };

      // Params for one member as playNote expects (inherits the grid base voice
      // so previews sound like the real thing, then overrides per member).
      const memberParams = (m, withOffsets) => {
        const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? { ...cellParams[0] } : { volume: 100 };
        const p = { ...base, type: m.type || 'sine' };
        ['attack', 'decay', 'sustain', 'release'].forEach(k => { if (Number.isFinite(m[k])) p[k] = m[k]; });
        if (withOffsets) {
          if (Number.isFinite(m.detune) && m.detune) p.detune = (p.detune || 0) + m.detune;
          if (Number.isFinite(m.pan)) p.pan = m.pan;
          if (Number.isFinite(m.level)) p.volume = Math.max(0, Math.min(100, Math.round((p.volume != null ? p.volume : 100) * (m.level / 100))));
        }
        return p;
      };
      const previewMember = (m) => {
        try {
          const withOff = (modeSel.value !== 'stack');
          const f = (withOff && Number.isFinite(m.octave) && m.octave) ? C4 * Math.pow(2, m.octave) : C4;
          playNote(f, memberParams(m, withOff), 650);
        } catch (e) {}
      };

      const numField = (label, key, min, max, step, val, hint) =>
        '<label class="ee-num"><span>' + label + '</span><input type="number" data-k="' + key + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '" value="' + val + '">' + (hint ? '<em>' + hint + '</em>' : '') + '</label>';

      function renderMembers() {
        membersWrap.classList.toggle('ee-no-offsets', modeSel.value === 'stack');
        membersWrap.innerHTML = def.members.map((m, i) =>
          '<div class="ee-member" data-i="' + i + '">' +
            '<div class="ee-member-head">' +
              '<select class="ee-voice" data-i="' + i + '"></select>' +
              '<button type="button" class="ee-mini ee-prev" data-i="' + i + '" title="Preview this tone">▶</button>' +
              '<button type="button" class="ee-mini ee-rm" data-i="' + i + '" title="Remove tone"' + (def.members.length <= 1 ? ' disabled' : '') + '>✕</button>' +
            '</div>' +
            '<div class="ee-adsr">' +
              numField('A', 'attack', 0, 4000, 1, m.attack, 'ms') +
              numField('D', 'decay', 0, 4000, 1, m.decay, 'ms') +
              numField('S', 'sustain', 0, 100, 1, m.sustain, '%') +
              numField('R', 'release', 0, 8000, 1, m.release, 'ms') +
            '</div>' +
            '<div class="ee-offsets">' +
              numField('Oct', 'octave', -3, 3, 1, m.octave, '') +
              numField('Detune', 'detune', -1200, 1200, 5, m.detune, '¢') +
              numField('Pan', 'pan', -100, 100, 1, m.pan, '') +
              numField('Level', 'level', 0, 100, 1, m.level, '%') +
            '</div>' +
          '</div>').join('');
        // Populate voice selects + set current value.
        membersWrap.querySelectorAll('.ee-voice').forEach(sel => {
          const i = +sel.dataset.i;
          populateGroupedToneSelect(sel, voiceOpts);
          sel.value = def.members[i].type || 'sine';
        });
      }

      // Delegated input/click handling on the members container.
      membersWrap.addEventListener('input', (e) => {
        const t = e.target;
        if (t.classList.contains('ee-voice')) { def.members[+t.dataset.i].type = t.value || 'sine'; return; }
        const wrap = t.closest('.ee-member'); if (!wrap) return;
        const i = +wrap.dataset.i, k = t.dataset.k; if (k == null) return;
        def.members[i][k] = parseFloat(t.value);
        if (Number.isNaN(def.members[i][k])) def.members[i][k] = 0;
      });
      membersWrap.addEventListener('change', (e) => {
        if (e.target.classList.contains('ee-voice')) def.members[+e.target.dataset.i].type = e.target.value || 'sine';
      });
      membersWrap.addEventListener('click', (e) => {
        const prev = e.target.closest('.ee-prev'); if (prev) { previewMember(def.members[+prev.dataset.i]); return; }
        const rm = e.target.closest('.ee-rm'); if (rm && def.members.length > 1) { def.members.splice(+rm.dataset.i, 1); renderMembers(); }
      });

      modeSel.addEventListener('change', () => { def.mode = modeSel.value; renderMembers(); });
      modal.querySelector('#ee-add').addEventListener('click', () => { def.members.push(_ensembleDefaultMember()); renderMembers(); });
      const nameInput = modal.querySelector('#ee-name');

      const loadSel = modal.querySelector('#ee-load');
      if (loadSel) loadSel.addEventListener('change', () => { close(); showEnsembleEditor(loadSel.value || undefined); });

      const delBtn = modal.querySelector('#ee-delete');
      if (delBtn) delBtn.addEventListener('click', () => {
        if (!existing) return;
        if (typeof confirm === 'function' && !confirm('Delete ensemble "' + (existing.name || existing.id) + '"?')) return;
        if (typeof ensembles !== 'undefined') ensembles.delete(String(existing.id));
        if (typeof persistWorkspace === 'function') persistWorkspace();
        if (typeof _ambRefreshAllToneSelects === 'function') _ambRefreshAllToneSelects();
        close();
      });

      modal.querySelector('#ee-preview').addEventListener('click', () => {
        // Audition through the real ensemble path via a temp registration.
        try {
          if (typeof ensembles === 'undefined') return;
          def.mode = modeSel.value; def.name = nameInput.value || def.name;
          ensembles.set('__ens_preview__', JSON.parse(JSON.stringify(def)));
          if (def.mode === 'rr') {
            // Round-robin: play the rotation as a short sequence (one note per
            // member, cursor reset to the start) so the rotation is audible
            // without notes overlapping on rapid clicks.
            _ensembleRR['__ens_preview__'] = 0;
            const n = Math.max(1, def.members.length);
            const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
            const gap = 0.5;
            for (let k = 0; k < n; k++) playNote(C4, { type: 'ensemble:__ens_preview__' }, 420, now + k * gap);
            setTimeout(() => { try { ensembles.delete('__ens_preview__'); } catch (e) {} }, n * gap * 1000 + 1600);
          } else {
            playNote(C4, { type: 'ensemble:__ens_preview__' }, 750);
            setTimeout(() => { try { ensembles.delete('__ens_preview__'); } catch (e) {} }, 1500);
          }
        } catch (e) {}
      });
      modal.querySelector('#ee-cancel').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      modal.querySelector('#ee-save').addEventListener('click', () => {
        def.mode = modeSel.value;
        def.name = (nameInput.value || '').trim();
        def.members = def.members.filter(m => m && m.type);
        if (!def.members.length) { alert('Add at least one tone.'); return; }
        if (typeof ensembles === 'undefined') { close(); return; }
        let id = existing ? String(existing.id) : null;
        if (!id) { let n = 1; while (ensembles.has(String(n))) n++; id = String(n); }
        if (!def.name) def.name = 'Ensemble ' + id;
        def.id = id;
        ensembles.set(id, JSON.parse(JSON.stringify(def)));
        if (typeof persistWorkspace === 'function') persistWorkspace();
        // Surface it in the Bloom layer Tone dropdowns right away.
        if (typeof _ambRefreshAllToneSelects === 'function') _ambRefreshAllToneSelects();
        // Make it the live grid voice so the user hears it immediately.
        if (typeof applyToneToAllCells === 'function') { try { applyToneToAllCells('ensemble:' + id); } catch (e) {} }
        close();
      });

      renderMembers();
    }

    function showSampleEditor(sampleId, onSaved) {
      const buf = _getSampleAudioBuffer(sampleId);
      if (!buf) { alert('This sample buffer isn’t loaded yet (or it’s a multi-sampled instrument, which can’t be waveform-edited).'); return; }
      const info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(sampleId) : null;
      const nm = (info && info.name) || sampleId;
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { return; }
      let startF = 0, endF = 1, reverse = false, previewSrc = null, drag = null;

      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal sample-editor-modal';
      modal.innerHTML =
        '<div class="sm-title">Edit sample — ' + String(nm).replace(/[<>&]/g, '') + '</div>' +
        '<canvas class="se-wave-canvas" id="se-wave-canvas"></canvas>' +
        '<div class="se-wave-info"><span id="se-wave-sel">full</span><label class="se-wave-rev"><input type="checkbox" id="se-wave-reverse"> Reverse</label></div>' +
        '<div class="se-wave-actions">' +
          '<button type="button" class="sm-wave" id="se-wave-preview">▶ Preview</button>' +
          '<button type="button" class="sm-wave" id="se-wave-cancel">Cancel</button>' +
          '<button type="button" class="sm-apply" id="se-wave-save">Save as new sample</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const canvas = modal.querySelector('#se-wave-canvas');
      const selEl = modal.querySelector('#se-wave-sel');
      const stopPreview = () => { try { previewSrc && previewSrc.stop(); } catch (e) {} previewSrc = null; };
      const fmtSel = () => {
        const dur = buf.duration * (endF - startF);
        selEl.textContent = (reverse ? '⇄ ' : '') + (dur >= 1 ? dur.toFixed(2) + ' s' : Math.round(dur * 1000) + ' ms') +
          ' of ' + (buf.duration >= 1 ? buf.duration.toFixed(2) + ' s' : Math.round(buf.duration * 1000) + ' ms');
      };
      const draw = () => {
        const W = canvas.width = canvas.clientWidth || 480;
        const H = canvas.height = 120;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        const sx = startF * W, ex = endF * W;
        ctx.fillStyle = 'rgba(159,122,234,0.16)'; ctx.fillRect(sx, 0, ex - sx, H);
        const data = buf.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / W)), mid = H / 2;
        ctx.strokeStyle = '#7fd6e8'; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = 0; x < W; x++) {
          let min = 1, max = -1; const o = x * step;
          for (let i = 0; i < step; i++) { const v = data[o + i] || 0; if (v < min) min = v; if (v > max) max = v; }
          ctx.moveTo(x + 0.5, mid + min * mid); ctx.lineTo(x + 0.5, mid + max * mid);
        }
        ctx.stroke();
        ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke();
        fmtSel();
      };
      requestAnimationFrame(draw);

      const xToF = (clientX) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)); };
      canvas.addEventListener('pointerdown', (e) => {
        const f = xToF(e.clientX);
        drag = (Math.abs(f - startF) <= Math.abs(f - endF)) ? 'start' : 'end';
        if (drag === 'start') startF = Math.min(f, endF - 0.001); else endF = Math.max(f, startF + 0.001);
        try { canvas.setPointerCapture(e.pointerId); } catch (x) {} draw();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const f = xToF(e.clientX);
        if (drag === 'start') startF = Math.min(f, endF - 0.001); else endF = Math.max(f, startF + 0.001);
        draw();
      });
      const endDrag = () => { drag = null; };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);

      modal.querySelector('#se-wave-reverse').addEventListener('change', (e) => { reverse = !!e.target.checked; draw(); });
      modal.querySelector('#se-wave-preview').addEventListener('click', () => {
        stopPreview();
        try { const sliced = _sliceAudioBuffer(ac, buf, startF, endF, reverse); const src = new Tone.ToneBufferSource({ url: sliced }).toDestination(); src.start(); previewSrc = src; } catch (e) {}
      });
      const close = () => { stopPreview(); overlay.remove(); };
      modal.querySelector('#se-wave-cancel').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      modal.querySelector('#se-wave-save').addEventListener('click', async () => {
        stopPreview();
        try {
          const sliced = _sliceAudioBuffer(ac, buf, startF, endF, reverse);
          const wav = (typeof audioBufferToWav === 'function') ? audioBufferToWav(sliced) : null;
          if (!wav) throw new Error('WAV encoder unavailable.');
          const base = String(nm).replace(/\.[^.]+$/, '') + '-edit';
          const reg = (typeof registerSampleFromBlob === 'function') ? await registerSampleFromBlob(wav, base) : null;
          if (typeof showToast === 'function') showToast('Saved “' + (reg ? reg.name : base) + '”');
          overlay.remove();
          if (reg && typeof onSaved === 'function') onSaved(reg.id);
        } catch (e) { alert('Save failed: ' + ((e && e.message) || e)); }
      });
    }

    // ---- Sample → Pad --------------------------------------------------
    // Pick any single-buffer sample, scrub a start/end region over its
    // waveform (with a looped preview), name it, and save it as a "Pad" voice.
    // A pad loops its trimmed slice for as long as the note event lasts — a
    // held grid press sustains indefinitely and stops on release (see the
    // `padLoop` branch in _buildSampleAdsrVoice). Modeled on showSampleEditor,
    // plus a source-sample picker and a looping preview.
    function showSampleToPadDialog() {
      const samples = [];
      if (typeof sampleSamplers !== 'undefined') {
        for (const [id, info] of sampleSamplers) {
          if (typeof isSliceableSample === 'function' && isSliceableSample('sample:' + id)) {
            samples.push({ id, name: (info && info.name) || id });
          }
        }
      }
      if (!samples.length) { alert('No single-buffer samples to turn into a pad yet — capture or import a sample first.'); return; }
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { return; }

      let buf = null, startF = 0, endF = 1, previewSrc = null, previewGain = null, drag = null, zeroLock = false;

      const optsHtml = samples.map(s =>
        '<option value="' + s.id + '">' + String(s.name).replace(/[<>&]/g, '') + '</option>').join('');
      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal sample-editor-modal';
      modal.innerHTML =
        '<div class="sm-title">Sample → Pad</div>' +
        '<label class="ee-field ee-name"><span>Source sample</span><select id="pad-src">' + optsHtml + '</select></label>' +
        '<canvas class="se-wave-canvas" id="pad-wave-canvas"></canvas>' +
        '<div class="se-wave-info"><span id="pad-wave-sel">full</span>' +
          '<label class="se-wave-rev"><input type="checkbox" id="pad-reverse"> Reverse</label>' +
          '<label class="se-wave-rev"><input type="checkbox" id="pad-zerolock"> Lock to zero</label></div>' +
        '<div class="ee-top" style="margin-top:6px;">' +
          '<label class="ee-field"><span>Overlaid copies <em id="pad-copies-v">1</em></span>' +
            '<input type="range" id="pad-copies" min="1" max="8" step="1" value="1"></label>' +
          '<label class="ee-field"><span>Copy offset <em id="pad-offset-v">25 ms</em></span>' +
            '<input type="range" id="pad-offset" min="0" max="500" step="1" value="25"></label>' +
          '<label class="ee-field"><span>Detune <em id="pad-detune-v">0¢</em></span>' +
            '<input type="range" id="pad-detune" min="0" max="30" step="1" value="0"></label>' +
        '</div>' +
        '<div class="ee-top">' +
          '<label class="ee-field"><span>Spread <em id="pad-spread-v">0%</em></span>' +
            '<input type="range" id="pad-spread" min="0" max="100" step="1" value="0"></label>' +
          '<label class="ee-field"><span>Crossfade <em id="pad-xfade-v">off</em></span>' +
            '<input type="range" id="pad-xfade" min="0" max="250" step="1" value="0"></label>' +
          '<label class="ee-field"><span>Low-pass <em id="pad-lpf-v">off</em></span>' +
            '<input type="range" id="pad-lpf" min="0" max="100" step="1" value="100"></label>' +
        '</div>' +
        '<div class="ee-top">' +
          '<label class="ee-field"><span>Reverb</span>' +
            '<select id="pad-rev-type">' +
              '<option value="room">Room</option>' +
              '<option value="hall">Hall</option>' +
              '<option value="plate">Plate</option>' +
              '<option value="spring">Spring</option>' +
              '<option value="cathedral">Cathedral</option>' +
            '</select></label>' +
          '<label class="ee-field"><span>Mix (dry→wet) <em id="pad-rev-v">off</em></span>' +
            '<input type="range" id="pad-rev" min="0" max="100" step="1" value="0"></label>' +
        '</div>' +
        '<div class="ee-top">' +
          '<label class="ee-field"><span>Reverb size <em id="pad-rev-size-v">70%</em></span>' +
            '<input type="range" id="pad-rev-size" min="0" max="100" step="1" value="70"></label>' +
          '<label class="ee-field"><span>Reverb tone <em id="pad-rev-tone-v">50%</em></span>' +
            '<input type="range" id="pad-rev-tone" min="0" max="100" step="1" value="50"></label>' +
        '</div>' +
        '<label class="ee-field ee-name" style="margin-top:6px;"><span>Pad name (required)</span><input type="text" id="pad-name" placeholder="Name your pad…"></label>' +
        '<div class="se-wave-actions">' +
          '<button type="button" class="sm-wave" id="pad-preview">▶ Preview loop</button>' +
          '<button type="button" class="sm-wave" id="pad-cancel">Cancel</button>' +
          '<button type="button" class="sm-apply" id="pad-save" disabled>Save pad</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const srcSel = modal.querySelector('#pad-src');
      const canvas = modal.querySelector('#pad-wave-canvas');
      const selEl = modal.querySelector('#pad-wave-sel');
      const nameEl = modal.querySelector('#pad-name');
      const saveBtn = modal.querySelector('#pad-save');
      const previewBtn = modal.querySelector('#pad-preview');
      const copiesEl = modal.querySelector('#pad-copies');
      const copiesV = modal.querySelector('#pad-copies-v');
      const offsetEl = modal.querySelector('#pad-offset');
      const offsetV = modal.querySelector('#pad-offset-v');
      const xfadeEl = modal.querySelector('#pad-xfade');
      const xfadeV = modal.querySelector('#pad-xfade-v');
      const lpfEl = modal.querySelector('#pad-lpf');
      const lpfV = modal.querySelector('#pad-lpf-v');
      const spreadEl = modal.querySelector('#pad-spread');
      const spreadV = modal.querySelector('#pad-spread-v');
      const detuneEl = modal.querySelector('#pad-detune');
      const detuneV = modal.querySelector('#pad-detune-v');
      const revTypeEl = modal.querySelector('#pad-rev-type');
      const revEl = modal.querySelector('#pad-rev');
      const revV = modal.querySelector('#pad-rev-v');
      const revSizeEl = modal.querySelector('#pad-rev-size');
      const revSizeV = modal.querySelector('#pad-rev-size-v');
      const revToneEl = modal.querySelector('#pad-rev-tone');
      const revToneV = modal.querySelector('#pad-rev-tone-v');
      let copies = 1, offsetSec = 0.025, crossfadeSec = 0, lpfPos = 100, spread = 0;
      let detuneCents = 0, reverse = false;
      let revType = 'room', revMix = 0, revSize = 70, revTone = 50;
      // Slider 0..100 → log cutoff ~80 Hz..20 kHz; 100 = fully open (off).
      const lpfHz = () => Math.round(80 * Math.pow(2, lpfPos * 8 / 100));

      const _disposePreview = () => {
        const s = previewSrc, g = previewGain;
        previewSrc = null; previewGain = null;
        try { s && s.stop(); } catch (e) {}
        try { s && s.dispose(); } catch (e) {}
        try { g && g.dispose(); } catch (e) {}
      };
      const stopPreview = () => { _disposePreview(); previewBtn.textContent = '▶ Preview loop'; };
      // Graceful stop for the Stop button — fade over the pad's Release so the
      // user hears the release swell (mirrors playing the pad on the grid).
      const releasePreview = () => {
        if (!previewSrc || !previewGain) { stopPreview(); return; }
        const s = previewSrc, g = previewGain;
        previewSrc = null; previewGain = null; previewBtn.textContent = '▶ Preview loop';
        try {
          const r = 0.02, now = Tone.now();   // tiny fade so Stop doesn't click
          g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now);
          g.gain.linearRampToValueAtTime(0, now + r);
          setTimeout(() => { try { s.stop(); } catch (e) {} try { s.dispose(); } catch (e) {} try { g.dispose(); } catch (e) {} }, (r + 0.1) * 1000);
        } catch (e) { try { s.stop(); s.dispose(); g.dispose(); } catch (x) {} }
      };
      // The exact buffer that gets saved/previewed: the trimmed slice → overlaid
      // offset copies (optionally stereo-spread) → loop-boundary crossfade →
      // optional low-pass. All baked synchronously so preview == saved audio.
      const buildOut = () => {
        let b = _sliceAudioBuffer(ac, buf, startF, endF, reverse);
        _dcBlockBufferInPlace(b); // strip DC before looping
        b = _buildPadBuffer(ac, b, copies, offsetSec, spread / 100, detuneCents);
        // Detuned copies aren't periodic at the loop length, so force a small
        // crossfade floor to mask the summed seam when detune is engaged.
        const effX = (detuneCents > 0 && copies > 1) ? Math.max(crossfadeSec, 0.025) : crossfadeSec;
        b = _crossfadeLoopBuffer(ac, b, effX);
        if (lpfPos < 100) _lowpassBufferInPlace(b, lpfHz(), 0.707);
        // Reverb last: bake a seamless wash into the (already seamless) loop.
        if (revMix > 0) b = _reverbBufferOffline(ac, b, revType, revMix / 100, revSize, revTone);
        return b;
      };
      // Preview the looping pad. A tiny fade-in on a fresh Preview press avoids a
      // click; slider-drag re-renders pass falsy for an instant restart. (Attack/
      // Release are set later on the lane, not here.)
      const startPreview = (withAttack) => {
        if (!buf) return;
        _disposePreview();
        try {
          const g = new Tone.Gain(1).toDestination();
          const src = new Tone.ToneBufferSource({ url: buildOut(), loop: true }).connect(g);
          if (withAttack) {
            const a = 0.01, now = Tone.now();
            g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(1, now + a);
          }
          src.start(); previewSrc = src; previewGain = g; previewBtn.textContent = '■ Stop';
        } catch (e) {}
      };
      const fmtSel = () => {
        if (!buf) { selEl.textContent = '—'; return; }
        const dur = buf.duration * (endF - startF);
        selEl.textContent = (dur >= 1 ? dur.toFixed(2) + ' s' : Math.round(dur * 1000) + ' ms') +
          ' loop of ' + (buf.duration >= 1 ? buf.duration.toFixed(2) + ' s' : Math.round(buf.duration * 1000) + ' ms');
      };
      const draw = () => {
        const W = canvas.width = canvas.clientWidth || 480;
        const H = canvas.height = 120;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        if (!buf) return;
        const sx = startF * W, ex = endF * W;
        ctx.fillStyle = 'rgba(159,122,234,0.16)'; ctx.fillRect(sx, 0, ex - sx, H);
        const data = buf.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / W)), mid = H / 2;
        ctx.strokeStyle = '#7fd6e8'; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = 0; x < W; x++) {
          let min = 1, max = -1; const o = x * step;
          for (let i = 0; i < step; i++) { const v = data[o + i] || 0; if (v < min) min = v; if (v > max) max = v; }
          ctx.moveTo(x + 0.5, mid + min * mid); ctx.lineTo(x + 0.5, mid + max * mid);
        }
        ctx.stroke();
        ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke();
        fmtSel();
      };
      // Save needs both a loaded buffer AND a name — a pad must be named to save.
      const refreshSaveEnabled = () => { saveBtn.disabled = !(buf && nameEl.value.trim()); };
      const loadSample = (id) => {
        stopPreview();
        buf = (typeof _getSampleAudioBuffer === 'function') ? _getSampleAudioBuffer(id) : null;
        startF = 0; endF = 1;
        refreshSaveEnabled();
        if (!buf) selEl.textContent = 'This sample buffer isn’t loaded yet.';
        requestAnimationFrame(draw);
      };
      nameEl.addEventListener('input', refreshSaveEnabled);

      // Nearest zero-crossing (fraction) to a given fraction, searching outward
      // on channel 0. Snapping start/end here means the loop begins and ends at
      // amplitude ~0, so the wrap (and the slice edges) don't click.
      const snapToZeroFrac = (frac) => {
        if (!buf) return frac;
        const data = buf.getChannelData(0), N = data.length;
        if (N < 2) return frac;
        const target = Math.max(0, Math.min(N - 1, Math.round(frac * N)));
        const isCross = (i) => i >= 0 && i < N - 1 && ((data[i] <= 0 && data[i + 1] > 0) || (data[i] >= 0 && data[i + 1] < 0));
        if (isCross(target)) return target / N;
        for (let r = 1; r < N; r++) {
          if (isCross(target - r)) return (target - r) / N;
          if (isCross(target + r)) return (target + r) / N;
        }
        return frac;
      };
      const applyZeroLock = () => {
        if (!zeroLock || !buf) return;
        startF = Math.max(0, Math.min(snapToZeroFrac(startF), endF - 0.001));
        endF = Math.min(1, Math.max(snapToZeroFrac(endF), startF + 0.001));
      };

      const xToF = (clientX) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)); };
      canvas.addEventListener('pointerdown', (e) => {
        if (!buf) return;
        const f = xToF(e.clientX);
        drag = (Math.abs(f - startF) <= Math.abs(f - endF)) ? 'start' : 'end';
        if (drag === 'start') startF = Math.min(f, endF - 0.001); else endF = Math.max(f, startF + 0.001);
        try { canvas.setPointerCapture(e.pointerId); } catch (x) {} draw();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag || !buf) return;
        const f = xToF(e.clientX);
        if (drag === 'start') startF = Math.min(f, endF - 0.001); else endF = Math.max(f, startF + 0.001);
        draw();
      });
      const endDrag = () => {
        if (drag && zeroLock && buf) {
          if (drag === 'start') startF = Math.max(0, Math.min(snapToZeroFrac(startF), endF - 0.001));
          else endF = Math.min(1, Math.max(snapToZeroFrac(endF), startF + 0.001));
        }
        const had = !!drag;
        drag = null;
        if (had) { draw(); if (previewSrc) startPreview(); }
      };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);

      srcSel.addEventListener('change', () => loadSample(srcSel.value));
      const reverseEl = modal.querySelector('#pad-reverse');
      reverseEl.addEventListener('change', () => {
        reverse = reverseEl.checked;
        if (previewSrc) startPreview();
      });
      const zeroLockEl = modal.querySelector('#pad-zerolock');
      zeroLockEl.addEventListener('change', () => {
        zeroLock = zeroLockEl.checked;
        if (zeroLock && buf) { applyZeroLock(); draw(); if (previewSrc) startPreview(); }
      });
      copiesEl.addEventListener('input', () => {
        copies = parseInt(copiesEl.value, 10) || 1; copiesV.textContent = String(copies);
        if (previewSrc) startPreview(); // re-render the loop live
      });
      offsetEl.addEventListener('input', () => {
        const ms = parseInt(offsetEl.value, 10) || 0; offsetSec = ms / 1000; offsetV.textContent = ms + ' ms';
        if (previewSrc) startPreview();
      });
      xfadeEl.addEventListener('input', () => {
        const ms = parseInt(xfadeEl.value, 10) || 0; crossfadeSec = ms / 1000;
        xfadeV.textContent = ms ? ms + ' ms' : 'off';
        if (previewSrc) startPreview();
      });
      lpfEl.addEventListener('input', () => {
        lpfPos = parseInt(lpfEl.value, 10); if (!Number.isFinite(lpfPos)) lpfPos = 100;
        if (lpfPos >= 100) lpfV.textContent = 'off';
        else { const hz = lpfHz(); lpfV.textContent = hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : hz + ' Hz'; }
        if (previewSrc) startPreview();
      });
      spreadEl.addEventListener('input', () => {
        spread = parseInt(spreadEl.value, 10) || 0; spreadV.textContent = spread + '%';
        if (previewSrc) startPreview();
      });
      detuneEl.addEventListener('input', () => {
        detuneCents = parseInt(detuneEl.value, 10) || 0; detuneV.textContent = detuneCents + '¢';
        if (previewSrc) startPreview();
      });
      // Reverb baking is heavier than the other stages, so update the readouts
      // live on `input` but only re-render the preview on `change` (drag release)
      // to keep the dialog responsive and avoid stacking renders mid-drag.
      revTypeEl.addEventListener('change', () => {
        revType = revTypeEl.value || 'room';
        if (previewSrc && revMix > 0) startPreview();
      });
      revEl.addEventListener('input', () => {
        revMix = parseInt(revEl.value, 10) || 0;
        revV.textContent = revMix ? revMix + '%' : 'off';
      });
      revEl.addEventListener('change', () => { if (previewSrc) startPreview(); });
      revSizeEl.addEventListener('input', () => {
        revSize = parseInt(revSizeEl.value, 10); if (!Number.isFinite(revSize)) revSize = 70;
        revSizeV.textContent = revSize + '%';
      });
      revSizeEl.addEventListener('change', () => { if (previewSrc && revMix > 0) startPreview(); });
      revToneEl.addEventListener('input', () => {
        revTone = parseInt(revToneEl.value, 10); if (!Number.isFinite(revTone)) revTone = 50;
        revToneV.textContent = revTone + '%';
      });
      revToneEl.addEventListener('change', () => { if (previewSrc && revMix > 0) startPreview(); });
      previewBtn.addEventListener('click', () => {
        if (previewSrc) releasePreview(); else startPreview(true);
      });
      const close = () => { stopPreview(); try { overlay.remove(); } catch (e) {} };
      modal.querySelector('#pad-cancel').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      saveBtn.addEventListener('click', async () => {
        if (!buf) return;
        const nm = (nameEl.value || '').trim();
        if (!nm) { refreshSaveEnabled(); nameEl.focus(); return; } // name required
        stopPreview();
        saveBtn.disabled = true;
        try {
          const wav = (typeof audioBufferToWav === 'function') ? audioBufferToWav(buildOut()) : null;
          if (!wav) throw new Error('WAV encoder unavailable.');
          const reg = await registerSampleFromBlob(wav, nm, { padLoop: true });
          if (typeof _ambRefreshAllToneSelects === 'function') _ambRefreshAllToneSelects();
          if (reg && typeof applyToneToAllCells === 'function') { try { applyToneToAllCells('sample:' + reg.id, 'none'); } catch (e) {} }
          if (typeof showToast === 'function') showToast('Saved pad “' + (reg ? reg.name : nm) + '”');
          close();
        } catch (e) {
          alert('Save failed: ' + ((e && e.message) || e));
          saveBtn.disabled = false;
        }
      });

      loadSample(srcSel.value);
    }

    function showSoundEditor(noteIndex, opts) {
      // Selection scope: when opts.steps is given, the editor targets those
      // step refs — it writes each selected step's OWN params, and only the
      // fields the user actually changes (change-only), so divergent untouched
      // properties stay per-step. Absent → classic per-cell voice-template edit.
      const _selSteps = (opts && Array.isArray(opts.steps) && opts.steps.length) ? opts.steps.slice() : null;
      const _primaryStep = _selSteps ? _selSteps[_selSteps.length - 1] : null;
      const _seedParams = _primaryStep
        ? (_primaryStep.params || (Array.isArray(_primaryStep.chord) && _primaryStep.chord[0] && _primaryStep.chord[0].params) || null)
        : null;
      const note = _primaryStep ? { label: _primaryStep.label || 'selection', freq: _primaryStep.freq } : notes[noteIndex];
      const p = _selSteps
        ? Object.assign({ ...(cellParams[noteIndex] || cellParams[0] || {}) }, _seedParams || {})
        : { ...cellParams[noteIndex] };
      const _touched = new Set();     // fields the user actually edited
      const _startApplyAll = !!(opts && opts.applyAll) && !_selSteps;

      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';

      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Sound Editor — ${note.label}</div>
        <label class="sm-apply-all"><input type="checkbox" id="sm-apply-all" /> Apply to all notes</label>
        <details class="sm-fold" open>
          <summary>Tone</summary>
          <div class="sm-fold-body">
            <div class="sm-waves" id="sm-waves"></div>
          </div>
        </details>
        <details class="sm-fold" id="sm-slice-fold" style="display:none">
          <summary>Slice</summary>
          <div class="sm-fold-body">
            <div class="sm-param">
              <div class="sm-param-row">Sequence slice mode</div>
              <select id="sm-slice-mode" class="sm-select">
                <option value="scan">Scan (advance, reset on rest)</option>
                <option value="stutter">Stutter (each step from start)</option>
                <option value="index">Index (step N = Nth slice)</option>
                <option value="none">Off (whole sample per step)</option>
              </select>
            </div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Envelope</summary>
          <div class="sm-fold-body">
            <div class="sm-param">
              <div class="sm-param-row">Attack <span class="sm-val" id="sm-atk-v">${p.attack} ms</span></div>
              <input type="range" id="sm-atk" min="1" max="500" value="${p.attack}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Decay <span class="sm-val" id="sm-dec-v">${p.decay} ms</span></div>
              <input type="range" id="sm-dec" min="10" max="1000" value="${p.decay}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Sustain <span class="sm-val" id="sm-sus-v">${p.sustain}%</span></div>
              <input type="range" id="sm-sus" min="0" max="100" value="${p.sustain}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Release <span class="sm-val" id="sm-rel-v">${p.release} ms</span></div>
              <input type="range" id="sm-rel" min="100" max="3000" value="${p.release}" />
            </div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Level &amp; tuning</summary>
          <div class="sm-fold-body">
            <div class="sm-param">
              <div class="sm-param-row">Volume <span class="sm-val" id="sm-vol-v">${p.volume}%</span></div>
              <input type="range" id="sm-vol" min="0" max="100" value="${p.volume}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Tune <span class="sm-val" id="sm-tune-v">${p.detune ?? 0} ¢</span></div>
              <input type="range" id="sm-tune" min="-100" max="100" value="${p.detune ?? 0}" />
            </div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Effects</summary>
          <div class="sm-fold-body">
            <label class="sm-checkbox-row" title="When checked, this cell skips the global FX chain — only its local effects apply.">
              <input type="checkbox" id="sm-fx-override" ${p.fxOverrideGlobal ? 'checked' : ''} />
              Override Global
            </label>
            <div class="sm-section-label">Reverb</div>
            <div class="sm-param">
              <div class="sm-param-row">Mix <span class="sm-val" id="sm-rev-v">${p.reverb ?? 0}%</span></div>
              <input type="range" id="sm-rev" min="0" max="100" value="${p.reverb ?? 0}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Size <span class="sm-val" id="sm-rev-size-v">${p.reverbSize ?? 70}%</span></div>
              <input type="range" id="sm-rev-size" min="0" max="100" value="${p.reverbSize ?? 70}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Tone <span class="sm-val" id="sm-rev-tone-v">${p.reverbTone ?? 50}%</span></div>
              <input type="range" id="sm-rev-tone" min="0" max="100" value="${p.reverbTone ?? 50}" />
            </div>
            <div class="sm-section-label">Delay</div>
            <div class="sm-param">
              <div class="sm-param-row">Mix <span class="sm-val" id="sm-dly-v">${p.delay ?? 0}%</span></div>
              <input type="range" id="sm-dly" min="0" max="100" value="${p.delay ?? 0}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Time <span class="sm-val" id="sm-dly-time-v">${p.delayTime ?? 250} ms</span></div>
              <input type="range" id="sm-dly-time" min="20" max="1000" step="10" value="${p.delayTime ?? 250}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Sync to BPM</div>
              <select id="sm-dly-sync" class="sm-select">
                <option value="">Off (use Time)</option>
                <option value="2n">1/2</option>
                <option value="4n.">1/4 dotted</option>
                <option value="4n">1/4</option>
                <option value="4t">1/4 triplet</option>
                <option value="8n.">1/8 dotted</option>
                <option value="8n">1/8</option>
                <option value="8t">1/8 triplet</option>
                <option value="16n.">1/16 dotted</option>
                <option value="16n">1/16</option>
                <option value="16t">1/16 triplet</option>
                <option value="32n">1/32</option>
              </select>
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Feedback <span class="sm-val" id="sm-dly-fb-v">${p.delayFeedback ?? 40}%</span></div>
              <input type="range" id="sm-dly-fb" min="0" max="95" value="${p.delayFeedback ?? 40}" />
            </div>
            <div class="sm-section-label">Distortion</div>
            <div class="sm-param">
              <div class="sm-param-row">Amount <span class="sm-val" id="sm-dst-v">${p.distortion ?? 0}%</span></div>
              <input type="range" id="sm-dst" min="0" max="100" value="${p.distortion ?? 0}" />
            </div>
            <details class="sm-fx-group"><summary>Chorus</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-cho-v">${p.chorus ?? 0}%</span></div><input type="range" id="sm-cho" min="0" max="100" value="${p.chorus ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="sm-cho-freq-v">${p.chorusFreq ?? 4} Hz</span></div><input type="range" id="sm-cho-freq" min="0.1" max="10" step="0.1" value="${p.chorusFreq ?? 4}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="sm-cho-depth-v">${p.chorusDepth ?? 70}%</span></div><input type="range" id="sm-cho-depth" min="0" max="100" value="${p.chorusDepth ?? 70}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Vibrato</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-vib-v">${p.vibrato ?? 0}%</span></div><input type="range" id="sm-vib" min="0" max="100" value="${p.vibrato ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="sm-vib-freq-v">${p.vibratoFreq ?? 5} Hz</span></div><input type="range" id="sm-vib-freq" min="0.1" max="20" step="0.1" value="${p.vibratoFreq ?? 5}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="sm-vib-depth-v">${p.vibratoDepth ?? 30}%</span></div><input type="range" id="sm-vib-depth" min="0" max="100" value="${p.vibratoDepth ?? 30}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Tremolo</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-trm-v">${p.tremolo ?? 0}%</span></div><input type="range" id="sm-trm" min="0" max="100" value="${p.tremolo ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="sm-trm-freq-v">${p.tremoloFreq ?? 5} Hz</span></div><input type="range" id="sm-trm-freq" min="0.1" max="20" step="0.1" value="${p.tremoloFreq ?? 5}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="sm-trm-depth-v">${p.tremoloDepth ?? 70}%</span></div><input type="range" id="sm-trm-depth" min="0" max="100" value="${p.tremoloDepth ?? 70}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Phaser</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-phs-v">${p.phaser ?? 0}%</span></div><input type="range" id="sm-phs" min="0" max="100" value="${p.phaser ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="sm-phs-freq-v">${p.phaserFreq ?? 0.5} Hz</span></div><input type="range" id="sm-phs-freq" min="0.05" max="10" step="0.05" value="${p.phaserFreq ?? 0.5}" /></div>
              <div class="sm-param"><div class="sm-param-row">Octaves <span class="sm-val" id="sm-phs-oct-v">${p.phaserOctaves ?? 3}</span></div><input type="range" id="sm-phs-oct" min="1" max="7" step="1" value="${p.phaserOctaves ?? 3}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Auto Filter</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-af-v">${p.autoFilter ?? 0}%</span></div><input type="range" id="sm-af" min="0" max="100" value="${p.autoFilter ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="sm-af-freq-v">${p.autoFilterFreq ?? 1} Hz</span></div><input type="range" id="sm-af-freq" min="0.1" max="10" step="0.1" value="${p.autoFilterFreq ?? 1}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="sm-af-depth-v">${p.autoFilterDepth ?? 100}%</span></div><input type="range" id="sm-af-depth" min="0" max="100" value="${p.autoFilterDepth ?? 100}" /></div>
              <div class="sm-param"><div class="sm-param-row">Base <span class="sm-val" id="sm-af-base-v">${p.autoFilterBaseFreq ?? 200} Hz</span></div><input type="range" id="sm-af-base" min="50" max="2000" step="10" value="${p.autoFilterBaseFreq ?? 200}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Ping-Pong Delay</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-pp-v">${p.pingPong ?? 0}%</span></div><input type="range" id="sm-pp" min="0" max="100" value="${p.pingPong ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Time <span class="sm-val" id="sm-pp-time-v">${p.pingPongTime ?? 250} ms</span></div><input type="range" id="sm-pp-time" min="20" max="1000" step="10" value="${p.pingPongTime ?? 250}" /></div>
              <div class="sm-param"><div class="sm-param-row">Sync to BPM</div><select id="sm-pp-sync" class="sm-select"><option value="">Off (use Time)</option><option value="2n">1/2</option><option value="4n.">1/4 dotted</option><option value="4n">1/4</option><option value="4t">1/4 triplet</option><option value="8n.">1/8 dotted</option><option value="8n">1/8</option><option value="8t">1/8 triplet</option><option value="16n.">1/16 dotted</option><option value="16n">1/16</option><option value="16t">1/16 triplet</option><option value="32n">1/32</option></select></div>
              <div class="sm-param"><div class="sm-param-row">Feedback <span class="sm-val" id="sm-pp-fb-v">${p.pingPongFeedback ?? 30}%</span></div><input type="range" id="sm-pp-fb" min="0" max="95" value="${p.pingPongFeedback ?? 30}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Auto Pan</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="sm-apan-v">${p.autoPan ?? 0}%</span></div><input type="range" id="sm-apan" min="0" max="100" value="${p.autoPan ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="sm-apan-freq-v">${p.autoPanFreq ?? 1} Hz</span></div><input type="range" id="sm-apan-freq" min="0.1" max="10" step="0.1" value="${p.autoPanFreq ?? 1}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="sm-apan-depth-v">${p.autoPanDepth ?? 100}%</span></div><input type="range" id="sm-apan-depth" min="0" max="100" value="${p.autoPanDepth ?? 100}" /></div>
            </details>
          </div>
        </details>
        <div class="sm-footer">
          <button class="sm-copy" id="sm-copy">Copy to…</button>
          <button class="sm-preview" id="sm-preview">▶ Preview</button>
          <button class="sm-apply" id="sm-apply">Apply</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // "Apply to all" — when checked, every param change broadcasts the
      // new value to cellParams[i] for every cell in the grid, so the
      // user can dial in one synth and propagate it everywhere with a
      // single edit. The current cell's `p` (a working copy applied at
      // Apply time) still reflects local changes; broadcastAll mirrors
      // them to the live cellParams immediately.
      const applyAllChk = modal.querySelector('#sm-apply-all');
      // Opened from the Tone menu's "Sculpt…" entry → sculpt the whole grid,
      // so start with Apply-to-all on and lead with the Envelope section.
      if (_startApplyAll && applyAllChk) {
        applyAllChk.checked = true;
        const titleEl = modal.querySelector('.sm-title');
        if (titleEl) titleEl.textContent = 'Sculpt sound — all notes';
        const folds = modal.querySelectorAll('details.sm-fold');
        folds.forEach(f => {
          const sum = f.querySelector('summary');
          f.open = !!(sum && sum.textContent.trim() === 'Envelope');
        });
      }
      const broadcastAll = (key, value) => {
        // In selection scope the checkbox means "Replace entire voice", not
        // "all cells" — never fan a live value out to the grid template here.
        if (_selSteps) return;
        if (!applyAllChk?.checked) return;
        cellParams.forEach((cp, idx) => {
          if (!cp) return;
          cp[key] = value;
          // Type changes also need the parallel cellSounds[] mirror and the
          // visible per-cell label updated to stay in sync — same updates
          // the Apply button does for the single-cell case.
          if (key === 'type') {
            cellSounds[idx] = value;
            const sel = cells[idx]?.querySelector('.cell-sound-select');
            if (sel) sel.value = value;
          }
        });
      };

      // Wave type buttons (built-in synths + any loaded samples)
      const waveRow = modal.querySelector('#sm-waves');
      const addToneButton = (opt) => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (opt.value === p.type ? ' active' : '');
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          p.type = opt.value;
          _touched.add('type');
          broadcastAll('type', opt.value);
          waveRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        return btn;
      };
      getAllSoundOptions().forEach(opt => waveRow.appendChild(addToneButton(opt)));

      // Import button — lets the user pick an audio file to use as a tone.
      const importBtn = document.createElement('button');
      importBtn.className = 'sm-wave';
      importBtn.textContent = '+ Import…';
      importBtn.title = 'Upload an audio file to use as a tone (saved across reloads)';
      importBtn.addEventListener('click', () => {
        triggerImportSample((id, label) => {
          const opt = { value: 'sample:' + id, label };
          const btn = addToneButton(opt);
          waveRow.insertBefore(btn, importBtn);
          btn.click(); // auto-select the freshly-imported sample
        });
      });
      waveRow.appendChild(importBtn);
      // Waveform editor — only for single-buffer samples (trim / reverse →
      // save as a new sample, then auto-select it as this voice).
      if (typeof isSliceableSample === 'function' && isSliceableSample(p.type)) {
        const editBtn = document.createElement('button');
        editBtn.className = 'sm-wave';
        editBtn.textContent = '✂ Edit…';
        editBtn.title = 'Trim / reverse this sample and save it as a new sample';
        editBtn.addEventListener('click', () => {
          showSampleEditor(p.type.slice(7), (newId) => {
            const opt = { value: 'sample:' + newId, label: (sampleSamplers.get(newId) || {}).name || newId };
            const btn = addToneButton(opt);
            waveRow.insertBefore(btn, importBtn);
            btn.click(); // select the edited sample as this voice
          });
        });
        waveRow.appendChild(editBtn);
      }

      // Slider bindings — parseFloat so step=0.1 sliders (Hz) keep precision;
      // integer-stepped sliders unaffected since their .value is already int.
      [
        ['sm-atk',          'sm-atk-v',          'attack',             ' ms'],
        ['sm-dec',          'sm-dec-v',          'decay',              ' ms'],
        ['sm-sus',          'sm-sus-v',          'sustain',            '%'],
        ['sm-rel',          'sm-rel-v',          'release',            ' ms'],
        ['sm-vol',          'sm-vol-v',          'volume',             '%'],
        ['sm-tune',         'sm-tune-v',         'detune',             ' ¢'],
        ['sm-rev',          'sm-rev-v',          'reverb',             '%'],
        ['sm-rev-size',     'sm-rev-size-v',     'reverbSize',         '%'],
        ['sm-rev-tone',     'sm-rev-tone-v',     'reverbTone',         '%'],
        ['sm-dly',          'sm-dly-v',          'delay',              '%'],
        ['sm-dly-time',     'sm-dly-time-v',     'delayTime',          ' ms'],
        ['sm-dly-fb',       'sm-dly-fb-v',       'delayFeedback',      '%'],
        ['sm-dst',          'sm-dst-v',          'distortion',         '%'],
        ['sm-cho',          'sm-cho-v',          'chorus',             '%'],
        ['sm-cho-freq',     'sm-cho-freq-v',     'chorusFreq',         ' Hz'],
        ['sm-cho-depth',    'sm-cho-depth-v',    'chorusDepth',        '%'],
        ['sm-vib',          'sm-vib-v',          'vibrato',            '%'],
        ['sm-vib-freq',     'sm-vib-freq-v',     'vibratoFreq',        ' Hz'],
        ['sm-vib-depth',    'sm-vib-depth-v',    'vibratoDepth',       '%'],
        ['sm-trm',          'sm-trm-v',          'tremolo',            '%'],
        ['sm-trm-freq',     'sm-trm-freq-v',     'tremoloFreq',        ' Hz'],
        ['sm-trm-depth',    'sm-trm-depth-v',    'tremoloDepth',       '%'],
        ['sm-phs',          'sm-phs-v',          'phaser',             '%'],
        ['sm-phs-freq',     'sm-phs-freq-v',     'phaserFreq',         ' Hz'],
        ['sm-phs-oct',      'sm-phs-oct-v',      'phaserOctaves',      ''],
        ['sm-af',           'sm-af-v',           'autoFilter',         '%'],
        ['sm-af-freq',      'sm-af-freq-v',      'autoFilterFreq',     ' Hz'],
        ['sm-af-depth',     'sm-af-depth-v',     'autoFilterDepth',    '%'],
        ['sm-af-base',      'sm-af-base-v',      'autoFilterBaseFreq', ' Hz'],
        ['sm-pp',           'sm-pp-v',           'pingPong',           '%'],
        ['sm-pp-time',      'sm-pp-time-v',      'pingPongTime',       ' ms'],
        ['sm-pp-fb',        'sm-pp-fb-v',        'pingPongFeedback',   '%'],
        ['sm-apan',         'sm-apan-v',         'autoPan',            '%'],
        ['sm-apan-freq',    'sm-apan-freq-v',    'autoPanFreq',        ' Hz'],
        ['sm-apan-depth',   'sm-apan-depth-v',   'autoPanDepth',       '%'],
      ].forEach(([id, valId, key, unit]) => {
        const input = modal.querySelector(`#${id}`);
        if (!input) return;
        const label = modal.querySelector(`#${valId}`);
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          p[key] = v;
          _touched.add(key);
          broadcastAll(key, v);
          if (label) label.textContent = v + unit;
        });
      });
      const overrideCheckbox = modal.querySelector('#sm-fx-override');
      if (overrideCheckbox) {
        overrideCheckbox.addEventListener('change', () => {
          p.fxOverrideGlobal = !!overrideCheckbox.checked;
          _touched.add('fxOverrideGlobal');
          broadcastAll('fxOverrideGlobal', p.fxOverrideGlobal);
        });
      }
      // Slice mode — available for ANY sample voice (single-buffer one-shots
      // AND the multi-sampled tuned instruments: slicing scans the nearest
      // mapped buffer). Single-buffer samples default to 'scan'; tuned
      // instruments default to 'none' (off) until the user opts in.
      const sliceFold = modal.querySelector('#sm-slice-fold');
      const sliceSel = modal.querySelector('#sm-slice-mode');
      if (sliceFold && sliceSel) {
        const showSlice = (typeof isSampleType === 'function') && isSampleType(p.type);
        sliceFold.style.display = showSlice ? '' : 'none';
        if (showSlice) {
          const dflt = (typeof isSliceableSample === 'function' && isSliceableSample(p.type)) ? 'scan' : 'none';
          sliceSel.value = (typeof p.sliceMode === 'string' && p.sliceMode) ? p.sliceMode : dflt;
          sliceSel.addEventListener('change', () => {
            p.sliceMode = sliceSel.value || 'none';
            _touched.add('sliceMode');
            broadcastAll('sliceMode', p.sliceMode);
          });
        }
      }
      const dlySyncSel = modal.querySelector('#sm-dly-sync');
      if (dlySyncSel) {
        dlySyncSel.value = p.delaySync || '';
        dlySyncSel.addEventListener('change', () => {
          p.delaySync = dlySyncSel.value || null;
          _touched.add('delaySync');
          broadcastAll('delaySync', p.delaySync);
        });
      }
      const ppSyncSel = modal.querySelector('#sm-pp-sync');
      if (ppSyncSel) {
        ppSyncSel.value = p.pingPongSync || '';
        ppSyncSel.addEventListener('change', () => {
          p.pingPongSync = ppSyncSel.value || null;
          _touched.add('pingPongSync');
          broadcastAll('pingPongSync', p.pingPongSync);
        });
      }

      // ---- Selection scope: relabel checkbox, mark mixed fields, retarget ----
      if (_selSteps) {
        const titleEl = modal.querySelector('.sm-title');
        if (titleEl) titleEl.textContent = 'Sound — ' + _selSteps.length + ' step' + (_selSteps.length === 1 ? '' : 's');
        // "Apply to all notes" → "Replace entire voice" (full stamp vs change-only).
        const lbl = applyAllChk ? applyAllChk.closest('.sm-apply-all') : null;
        if (lbl && applyAllChk) {
          lbl.textContent = '';
          lbl.appendChild(applyAllChk);
          lbl.appendChild(document.createTextNode(' Replace entire voice (overwrite all fields)'));
          lbl.title = 'Off: only the fields you change are written to the selected steps. On: stamp the whole voice onto them.';
        }
        // Mark fields that diverge across the selection as "Mixed" so the user
        // knows touching them unifies just that one field.
        const leafParams = (st) => (st && st.params) ? st.params
          : (st && Array.isArray(st.chord) && st.chord[0] && st.chord[0].params) ? st.chord[0].params
          : (st && Array.isArray(st.subSteps) && st.subSteps[0] && st.subSteps[0].params) ? st.subSteps[0].params : {};
        const diverges = (key) => { const f = (leafParams(_selSteps[0]) || {})[key]; return _selSteps.some(st => (leafParams(st) || {})[key] !== f); };
        [['sm-atk-v','attack'],['sm-dec-v','decay'],['sm-sus-v','sustain'],['sm-rel-v','release'],['sm-vol-v','volume'],['sm-tune-v','detune'],['sm-rev-v','reverb'],['sm-dly-v','delay'],['sm-dst-v','distortion']].forEach(([vid,key]) => {
          if (_selSteps.length >= 2 && diverges(key)) { const el = modal.querySelector('#' + vid); if (el) { el.textContent = 'Mixed'; el.style.fontStyle = 'italic'; el.style.color = '#c9a8ff'; } }
        });
      }

      modal.querySelector('#sm-preview').addEventListener('click', () => playNote(note.freq, p));

      modal.querySelector('#sm-apply').addEventListener('click', () => {
        if (_selSteps) {
          // Change-only by default — write just the touched fields to every
          // selected step's params (and chord voices / sub leaves), leaving
          // untouched (divergent) fields per-step. "Replace entire voice" writes
          // the whole bundle.
          const full = !!(applyAllChk && applyAllChk.checked);
          const keys = full ? Object.keys(p) : Array.from(_touched);
          if (keys.length) {
            if (typeof snapshotForUndo === 'function') snapshotForUndo('Sound edit');
            const writeKeys = (st) => {
              if (!st) return;
              if (st.isSub && Array.isArray(st.subSteps)) { st.subSteps.forEach(writeKeys); return; }
              if (!st.params) st.params = {};
              keys.forEach(k => { st.params[k] = p[k]; if (k === 'type') st.sound = p[k]; });
              if (Array.isArray(st.chord)) st.chord.forEach(v => { if (!v) return; if (!v.params) v.params = {}; keys.forEach(k => { v.params[k] = p[k]; if (k === 'type') v.sound = p[k]; }); });
            };
            _selSteps.forEach(writeKeys);
            if (typeof renderSequence === 'function') renderSequence();
            if (typeof persistWorkspace === 'function') persistWorkspace();
          }
          overlay.remove();
          return;
        }
        cellParams[noteIndex] = { ...p };
        cellSounds[noteIndex] = p.type;
        const sel = cells[noteIndex]?.querySelector('.cell-sound-select');
        if (sel) sel.value = p.type;
        updateCellFreqLabel(noteIndex);
        updateScaleBanner();
        overlay.remove();
      });

      // Copy-to panel
      const copyBtn = modal.querySelector('#sm-copy');
      const copyPanel = document.createElement('div');
      copyPanel.className = 'sm-copy-panel';
      copyPanel.style.display = 'none';
      copyPanel.innerHTML = `
        <div class="sm-copy-label">Copy current settings to:</div>
        <div class="sm-copy-notes" id="sm-copy-notes"></div>
        <div class="sm-copy-actions">
          <button class="sm-copy-all">Apply to all</button>
          <button class="sm-copy-sel" disabled>Apply to selected</button>
        </div>
      `;
      modal.appendChild(copyPanel);

      const picked = new Set();
      const notesContainer = copyPanel.querySelector('#sm-copy-notes');
      const selBtn = copyPanel.querySelector('.sm-copy-sel');

      notes.forEach((n, idx) => {
        if (idx === noteIndex) return;
        const nb = document.createElement('button');
        nb.className = 'sm-copy-note';
        nb.textContent = n.label;
        nb.addEventListener('click', () => {
          if (picked.has(idx)) { picked.delete(idx); nb.classList.remove('picked'); }
          else                 { picked.add(idx);    nb.classList.add('picked'); }
          selBtn.disabled = picked.size === 0;
        });
        notesContainer.appendChild(nb);
      });

      function applyToIndices(indices) {
        indices.forEach(idx => {
          cellParams[idx] = { ...p };
          cellSounds[idx] = p.type;
          const sel = cells[idx]?.querySelector('.cell-sound-select');
          if (sel) sel.value = p.type;
          updateCellFreqLabel(idx);
        });
        updateScaleBanner();
      }

      copyPanel.querySelector('.sm-copy-all').addEventListener('click', () => {
        applyToIndices(notes.map((_, idx) => idx).filter(idx => idx !== noteIndex));
        copyPanel.style.display = 'none';
        copyBtn.classList.remove('open');
      });

      selBtn.addEventListener('click', () => {
        applyToIndices([...picked]);
        picked.clear();
        notesContainer.querySelectorAll('.sm-copy-note').forEach(b => b.classList.remove('picked'));
        selBtn.disabled = true;
        copyPanel.style.display = 'none';
        copyBtn.classList.remove('open');
      });

      copyBtn.addEventListener('click', () => {
        const open = copyPanel.style.display === 'none';
        copyPanel.style.display = open ? 'block' : 'none';
        copyBtn.classList.toggle('open', open);
      });

      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // ---- Step long-press + editor ----

    // ---- Drag-to-reorder sequence steps (desktop HTML5 drag) ----
    let _stepDragIdx = null;

    function clearStepDragOver() {
      document.querySelectorAll('.seq-step.drag-over').forEach(c => c.classList.remove('drag-over'));
    }

    // Nudge a step's onset earlier (dir<0) or later (dir>0) by dUnits (in
    // 1/32-note units), zero-sum: the neighbour the step moves TOWARD shrinks by
    // dUnits and the OTHER neighbour grows by dUnits, so total length and the
    // step's own length are unchanged. At an edge (no opposite neighbour) a rest
    // is created to absorb the shift. Subsequence neighbours can't be resized.
    function nudgeStep(stepRef, dir, dUnits) {
      const i = sequence.indexOf(stepRef);
      if (i < 0) return false;
      dUnits = Math.max(1, Math.round(dUnits));
      const _toast = (m) => { if (typeof showToast === 'function') showToast(m); };
      const len32 = (s) => Math.max(1, Math.round(stepLengthFactor(s) * 32));
      const setLen32 = (s, n) => {
        n = Math.max(1, Math.round(n));
        const unit = ((s.subdivision != null ? s.subdivision : stepSubdivision) * 8); // step-div in 1/32-units
        if (unit > 0 && (n % unit) === 0) { s.duration = n / unit; }
        else { s.subdivision = 0.125; s.duration = n; }        // fall to 1/32 so dur stays integer
      };
      const mkRest = (n) => ({ freq: null, label: '—', cellIndex: null, duration: Math.max(1, Math.round(n)), subdivision: 0.125 });
      const simple = (s) => s && !s.isSub; // notes / chords / rests resize cleanly; subs don't
      const prev = sequence[i - 1] || null;
      const next = sequence[i + 1] || null;
      if (dir > 0) { // later
        if (!next) { _toast('Nudge: nothing after this step to borrow from.'); return false; }
        if (!simple(next) || (prev && !simple(prev))) { _toast('Nudge: an adjacent subsequence can’t be resized.'); return false; }
        if (len32(next) - dUnits < 1) { _toast('Nudge: not enough room after the step.'); return false; }
        snapshotForUndo('Nudge ▶');
        setLen32(next, len32(next) - dUnits);
        if (prev) setLen32(prev, len32(prev) + dUnits);
        else sequence.splice(i, 0, mkRest(dUnits)); // first step: push right with a leading rest
      } else { // earlier
        if (!prev) { _toast('Nudge: nothing before this step to borrow from.'); return false; }
        if (!simple(prev) || (next && !simple(next))) { _toast('Nudge: an adjacent subsequence can’t be resized.'); return false; }
        if (len32(prev) - dUnits < 1) { _toast('Nudge: not enough room before the step.'); return false; }
        snapshotForUndo('Nudge ◀');
        setLen32(prev, len32(prev) - dUnits);
        if (next) setLen32(next, len32(next) + dUnits);
        else sequence.splice(i + 1, 0, mkRest(dUnits)); // last step: trailing rest absorbs the shift
      }
      renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
      return true;
    }
    // Repeatable nudge dialog: pick an amount, tap ◀ / ▶ to shift the step.
    function showNudgeDialog(stepIndex) {
      const stepRef = sequence[stepIndex];
      if (!stepRef) return;
      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Nudge step</div>
        <div style="color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.8rem;padding:0 0 12px;line-height:1.45;">
          Shift this step earlier or later. The neighbouring steps give/take the same amount, so the total sequence length doesn't change.
        </div>
        <div class="sm-section-label" style="margin-top:0;">Amount</div>
        <select id="nudge-amt" style="width:100%;background:#0c0c18;border:1px solid #2d2d3f;border-radius:7px;color:#e2e8f0;padding:6px 8px;font-size:0.85rem;margin-bottom:12px;">
          <option value="8">1/4</option>
          <option value="4">1/8</option>
          <option value="2" selected>1/16</option>
          <option value="1">1/32</option>
        </select>
        <div class="sm-footer" style="justify-content:space-between;gap:8px;">
          <button type="button" class="sm-preview" id="nudge-left">◀ Earlier</button>
          <button type="button" class="sm-preview" id="nudge-right">Later ▶</button>
          <button type="button" class="sm-apply" id="nudge-close">Done</button>
        </div>`;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const amt = modal.querySelector('#nudge-amt');
      const units = () => Math.max(1, parseInt(amt.value, 10) || 2);
      modal.querySelector('#nudge-left').addEventListener('click', () => nudgeStep(stepRef, -1, units()));
      modal.querySelector('#nudge-right').addEventListener('click', () => nudgeStep(stepRef, +1, units()));
      modal.querySelector('#nudge-close').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }
    function moveSequenceStep(from, to) {
      if (from === to || from < 0 || to < 0 || from >= sequence.length) return;
      const [item] = sequence.splice(from, 1);
      // Clamp target into the new (post-removal) array range and insert exactly
      // at the hovered slot — items at/after shift right by one, items between
      // the original source and the target shift left by one to close the gap.
      const insertAt = Math.max(0, Math.min(to, sequence.length));
      sequence.splice(insertAt, 0, item);
      renderSequence();
    }

    // Whole-chip pan: press and hold a chip, then drag horizontally to
    // pan it. The visual is the chip's own background — fades from the
    // base palette tint toward a hard-pan colour (purple for left,
    // blue for right) proportional to |pan|/100. There is no separate
    // dial element; the chip itself is the control.
    const PAN_TARGET_LEFT  = { r: 168, g: 85,  b: 247 }; // #a855f7
    const PAN_TARGET_RIGHT = { r:  59, g: 130, b: 246 }; // #3b82f6

    function parseColorToRgb(input) {
      if (!input) return null;
      // Hex
      let m = /^#([0-9a-f]{3,8})$/i.exec(input.trim());
      if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length >= 6) {
          return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
          };
        }
      }
      // rgb()/rgba()
      m = /^rgba?\(([^)]+)\)$/i.exec(input.trim());
      if (m) {
        const parts = m[1].split(',').map(s => s.trim());
        if (parts.length >= 3) {
          return { r: +parts[0], g: +parts[1], b: +parts[2] };
        }
      }
      // hsl()/hsla() — convert through a temporary element.
      try {
        const tmp = document.createElement('span');
        tmp.style.color = input;
        document.body.appendChild(tmp);
        const cs = getComputedStyle(tmp).color;
        document.body.removeChild(tmp);
        const m2 = /rgba?\(([^)]+)\)/i.exec(cs);
        if (m2) {
          const parts = m2[1].split(',').map(s => s.trim());
          return { r: +parts[0], g: +parts[1], b: +parts[2] };
        }
      } catch (e) {}
      return null;
    }

    function lerpRgb(a, b, t) {
      return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t),
      };
    }

    // Pan visual: a coloured outer glow scaled by |pan|/100 with the L
    // / R target colour. Leaves the chip's fill alone so the palette
    // tint stays the chip's primary identity — pan reads as a halo.
    // baseColor is unused (kept for signature-compat with older callers);
    // pan = 0 clears the glow entirely.
    function applyPanTint(chip, _baseColor, pan) {
      const p = Math.max(-100, Math.min(100, Number.isFinite(pan) ? pan : 0));
      if (p === 0) {
        chip.style.boxShadow = '';
        return;
      }
      const target = p > 0 ? PAN_TARGET_RIGHT : PAN_TARGET_LEFT;
      const t = Math.abs(p) / 100;
      // Two-layer outer glow: a tighter brighter core + a wider softer
      // halo. Both scale with pan magnitude.
      const r1 = (6 + 8 * t).toFixed(1);
      const r2 = (14 + 12 * t).toFixed(1);
      const a1 = (0.45 * t).toFixed(2);
      const a2 = (0.7  * t).toFixed(2);
      chip.style.boxShadow =
        `0 0 ${r1}px rgba(${target.r}, ${target.g}, ${target.b}, ${a1}), ` +
        `0 0 ${r2}px rgba(${target.r}, ${target.g}, ${target.b}, ${a2})`;
    }

    // Apply a pan value to every currently-selected step and update
    // each chip's tint live (no full sequence re-render). Invoked by
    // the selected-step pan slider below the BPM row.
    function applyPanToSelectedSteps(panValue) {
      const v = Math.max(-100, Math.min(100, Math.round(panValue)));
      const display = document.getElementById('sequence-display');
      // Poly + no selection: the slider drives the active lane's
      // dedicated pan node (Volume → Panner → masterBus). This makes
      // sample-type tones pan correctly — the shared sampler skips
      // the per-note panner so per-step pan never reached the audio
      // path on samples. Routing through the lane bus fixes that.
      if (selectedStepRefs.length === 0 && polyMode && lanes[activeLaneIdx]) {
        const lane = lanes[activeLaneIdx];
        lane.pan = v;
        // Lazy-create the bus and live-update the panner; `getLaneBus`
        // returns the Volume entry but the panner sits between Volume
        // and masterBus.
        getLaneBus(activeLaneIdx);
        try { lane._panner.pan.value = Math.max(-1, Math.min(1, v / 100)); } catch (e) {}
        return;
      }
      // Selection-scoped pan. For sub-sequence chips we recurse into
      // every leaf so each fired voice picks up the new pan; chord
      // voices mirror the step's value so chord playback honors it.
      // The chip tint is applied at the top level only — subs paint
      // a single chip in the strip and that chip represents all its
      // children's pan visually.
      selectedStepRefs.forEach(top => {
        if (!top) return;
        _forEachStepLeaf(top, leaf => {
          if (!leaf || leaf.isSub) return;
          if (!leaf.params) leaf.params = {};
          leaf.params.pan = v;
          if (Array.isArray(leaf.chord)) {
            leaf.chord.forEach(voice => {
              if (!voice) return;
              if (!voice.params) voice.params = {};
              voice.params.pan = v;
            });
          }
        });
        if (!display) return;
        const idx = sequence.indexOf(top);
        if (idx < 0) return;
        const chip = display.querySelector(`.seq-step[data-step-idx="${idx}"]`);
        if (!chip) return;
        const base = chip.dataset.paletteColor || null;
        applyPanTint(chip, base, v);
      });
    }

    function formatPanLabel(p) {
      if (!Number.isFinite(p) || p === 0) return 'C';
      return (p > 0 ? 'R' : 'L') + Math.abs(p);
    }

    // Pointer-based click-drag for desktop. Mouse pointerdown captures
    // the pointer; first move past MOVE_THRESHOLD engages drag and
    // builds a floating clone that follows the cursor. Drop lands on
    // whichever chip the pointer is over on pointerup. The clone's
    // pointer-events: none keeps elementFromPoint reporting the chip
    // underneath, not the clone itself. Touch path is bindStepDragTouch
    // below — it owns its own gesture model (280 ms hold to engage so
    // vertical page scroll over chips still works).
    function bindStepDrag(chip, i) {
      let startX = 0, startY = 0;
      let pointerId = null;
      let dragging = false;
      let clone = null;
      let offX = 0, offY = 0;
      let dropIdx = null;
      const MOVE_THRESHOLD = 6;

      const engage = () => {
        dragging = true;
        _stepDragIdx = i;
        const rect = chip.getBoundingClientRect();
        offX = startX - rect.left;
        offY = startY - rect.top;
        clone = chip.cloneNode(true);
        Object.assign(clone.style, {
          position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
          width: rect.width + 'px', height: rect.height + 'px',
          opacity: '0.85', pointerEvents: 'none', zIndex: '9999',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        });
        document.body.appendChild(clone);
        chip.classList.add('dragging');
      };

      const cleanup = () => {
        if (clone) { try { clone.remove(); } catch (e) {} clone = null; }
        chip.classList.remove('dragging');
        clearStepDragOver();
        try { chip.releasePointerCapture(pointerId); } catch (e) {}
        pointerId = null;
        dragging = false;
        dropIdx = null;
        _stepDragIdx = null;
      };

      chip.addEventListener('pointerdown', (e) => {
        // Only mouse drives this path — touch falls through to
        // bindStepDragTouch which has its own gesture model.
        if (e.pointerType !== 'mouse') return;
        if (e.button !== 0) return;
        // Ignore clicks that land on interactive sub-elements (e.g.
        // inline buttons on subseq chips).
        if (e.target && e.target.closest && e.target.closest('button')) return;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        dragging = false;
        dropIdx = null;
        try { chip.setPointerCapture(e.pointerId); } catch (err) {}
      });

      chip.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging) {
          if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
          engage();
        }
        clone.style.left = (e.clientX - offX) + 'px';
        clone.style.top  = (e.clientY - offY) + 'px';
        clearStepDragOver();
        dropIdx = null;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el && el.closest && el.closest('.seq-step');
        if (target && target !== chip) {
          const idx = parseInt(target.dataset.stepIdx, 10);
          if (Number.isFinite(idx) && idx !== i) {
            target.classList.add('drag-over');
            dropIdx = idx;
          }
        }
      });

      const finish = (e) => {
        if (pointerId == null || (e && e.pointerId !== pointerId)) return;
        const didDrag = dragging;
        const target = dropIdx;
        cleanup();
        if (didDrag && Number.isFinite(target)) moveSequenceStep(i, target);
        // Suppress the click that follows pointerup so a drag that
        // ended on the original chip doesn't also fire the chip's
        // select/preview click handler.
        if (didDrag) {
          const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); chip.removeEventListener('click', swallow, true); };
          chip.addEventListener('click', swallow, true);
        }
      };
      chip.addEventListener('pointerup', finish);
      chip.addEventListener('pointercancel', finish);
    }

    // Touch drag state machine per chip:
    //   pending  — touch down, < 280ms or still below move threshold.
    //              Fast moves cancel pending → native horizontal scroll works.
    //   ready    — held ≥ 280ms without moving. Drag is "armed" but no clone yet.
    //              If still held without moving, the 500ms long-press menu fires.
    //   dragging — any move after ready creates the clone and starts following.
    function bindStepDragTouch(chip, i) {
      chip.dataset.stepIdx = String(i);
      let readyTimer = null;
      let startX = 0, startY = 0;
      let readyToDrag = false;
      let dragging = false;
      let clone = null;
      let offX = 0, offY = 0;
      let dropIdx = null;
      // ---- Drag-to-scroll state (the chip strip is a horizontal timeline).
      // A quick horizontal swipe STARTING on a chip drags the whole lane
      // sideways (chips fill the strip, so without this there's nowhere to
      // grab on mobile). Distinguished from drag-to-reorder by intent: a
      // swipe moves before the hold timer fires; a deliberate hold (no move)
      // arms the reorder. Vertical swipes fall through to native page scroll.
      let scroller = null;      // the .lane-chips this chip lives in
      let startSL = 0;          // scrollLeft captured at touchstart
      let scrolling = false;    // true once we've taken over as a lane scroll
      let lastSL = 0, lastTS = 0, slVel = 0; // for release momentum
      // Shorter hold-to-arm so touch users discover drag-to-reorder
      // more easily — 280 ms felt sluggish and read as "nothing
      // happened" before users tried moving the chip. 160 ms still
      // distinguishes a deliberate hold from a swipe that should be
      // a scroll.
      const READY_DELAY = 160;
      const MOVE_THRESHOLD = 8;

      const engageDrag = () => {
        dragging = true;
        _stepDragIdx = i;
        navigator.vibrate?.(40);
        const rect = chip.getBoundingClientRect();
        offX = startX - rect.left;
        offY = startY - rect.top;
        clone = chip.cloneNode(true);
        Object.assign(clone.style, {
          position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
          width: rect.width + 'px', height: rect.height + 'px',
          opacity: '0.85', pointerEvents: 'none', zIndex: '9999',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        });
        document.body.appendChild(clone);
        chip.classList.add('dragging');
      };

      chip.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        readyToDrag = false;
        dragging = false;
        scrolling = false;
        dropIdx = null;
        scroller = chip.closest('.lane-chips');
        startSL = scroller ? scroller.scrollLeft : 0;
        lastSL = startSL; lastTS = e.timeStamp; slVel = 0;
        readyTimer = setTimeout(() => { readyTimer = null; readyToDrag = true; }, READY_DELAY);
      }, { passive: true });

      // Follow the finger sideways, clamping to the scrollable range, and
      // track scrollLeft velocity so the release can fling. Pausing the
      // lane's auto-centering each frame keeps playback from yanking it back.
      const _dragScrollTo = (clientX, ts) => {
        if (!scroller) return;
        const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        let sl = startSL - (clientX - startX);
        if (sl < 0) sl = 0; else if (sl > max) sl = max;
        const dt = ts - lastTS;
        if (dt > 0) slVel = (sl - lastSL) / dt;
        scroller.scrollLeft = sl;
        lastSL = sl; lastTS = ts;
        if (typeof _pauseLaneAutoScroll === 'function') _pauseLaneAutoScroll(scroller);
      };

      chip.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        const adx = Math.abs(dx), ady = Math.abs(dy);
        const moved = adx > MOVE_THRESHOLD || ady > MOVE_THRESHOLD;

        // Already dragging the lane sideways — keep following the finger.
        if (scrolling) {
          e.preventDefault();
          _dragScrollTo(t.clientX, e.timeStamp);
          return;
        }

        if (readyTimer) {
          // Pre-hold window: a swipe means scroll (horizontal) or native
          // page scroll (vertical); only a deliberate hold arms reorder.
          if (moved) {
            clearTimeout(readyTimer);
            readyTimer = null;
            readyToDrag = false;
            const canScroll = scroller && (scroller.scrollWidth - scroller.clientWidth) > 1;
            if (adx > ady && canScroll) {
              // Horizontal intent → take over as a lane scroll.
              scrolling = true;
              e.preventDefault();
              _dragScrollTo(t.clientX, e.timeStamp);
            }
            // Vertical (or non-scrollable) → fall through to native scroll.
          }
          return;
        }

        if (readyToDrag && !dragging && moved) engageDrag();

        if (dragging) {
          e.preventDefault();
          clone.style.left = (t.clientX - offX) + 'px';
          clone.style.top  = (t.clientY - offY) + 'px';
          clone.style.visibility = 'hidden';
          const el = document.elementFromPoint(t.clientX, t.clientY);
          clone.style.visibility = '';
          clearStepDragOver();
          dropIdx = null;
          const target = el?.closest('.seq-step');
          if (target && target !== chip) {
            const idx = parseInt(target.dataset.stepIdx);
            if (!isNaN(idx) && idx !== i) {
              target.classList.add('drag-over');
              dropIdx = idx;
            }
          }
        }
      }, { passive: false });

      const onTouchEnd = () => {
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        readyToDrag = false;
        // Release of a lane drag-scroll → carry on with momentum.
        if (scrolling) {
          scrolling = false;
          if (typeof _laneFlingScroll === 'function') _laneFlingScroll(scroller, slVel);
          scroller = null;
          // Swallow the click the browser may synthesize after the drag so the
          // scroll gesture doesn't also select/edit the chip it started on. The
          // timeout drops the guard if no click fires, so a later real tap on
          // this chip still selects normally.
          const cleanup = () => { chip.removeEventListener('click', swallow, true); clearTimeout(tmo); };
          const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); cleanup(); };
          const tmo = setTimeout(cleanup, 400);
          chip.addEventListener('click', swallow, true);
          return;
        }
        scroller = null;
        if (dragging) {
          clone?.remove();
          clone = null;
          chip.classList.remove('dragging');
          clearStepDragOver();
          if (dropIdx !== null) moveSequenceStep(_stepDragIdx, dropIdx);
        }
        dragging = false;
        dropIdx = null;
        _stepDragIdx = null;
      };
      chip.addEventListener('touchend', onTouchEnd);
      chip.addEventListener('touchcancel', onTouchEnd);
      // Pointer mirrors — iOS sometimes drops touchend when a long-press
      // takes over (e.g. when the chip menu opens), leaving the position:
      // fixed clone orphaned in the DOM. Pointer events still flow in
      // those cases, so cleaning up on pointerup/cancel covers the gap.
      chip.addEventListener('pointerup',     onTouchEnd);
      chip.addEventListener('pointercancel', onTouchEnd);
    }

    // Shift every audible note in a step (and any nested subSteps) by `semis`
    // half-steps. Updates the displayed label via Tone.js's freq→note helper.
    // Turn a chord step into a subsequence whose subSteps are the chord's
    // notes played in order. Subdivision rules (per design):
    //   chord.subdivision <  4 (under 1/1) → each note keeps the chord's own
    //                                        subdivision (sequence stretches).
    //   chord.subdivision >= 4 (1/1 or up) → floor(chord.subdivision /
    //                                        chordSize), clamped to the
    //                                        smallest valid sub (0.125 / 1/32).
    function arpeggiateStep(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || !Array.isArray(step.chord) || step.chord.length === 0) return;
      snapshotForUndo('Arpeggiate');
      stopSequence();
      const chordSize = step.chord.length;
      const chordSub  = (step.subdivision != null) ? step.subdivision : stepSubdivision;
      const noteSub = (chordSub < 4)
        ? chordSub
        : Math.max(0.125, Math.floor(chordSub / chordSize));
      const subSteps = step.chord.map(n => ({
        freq: n.freq,
        label: n.label,
        cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
        sound: n.sound,
        params: n.params ? { ...n.params } : undefined,
        duration: 1,
        subdivision: noteSub,
      }));
      sequence[stepIndex] = {
        isSub: true,
        subSteps,
        label: '▤',
        duration: step.duration || 1,
        subdivision: 1,
      };
      renderSequence();
    }

    // Reverse of arpeggiate: collapse a subsequence into a single chord step
    // that plays for the same total time. Voices are gathered from every
    // single-note + chord subStep (rests are dropped, duplicates by freq are
    // dedup'd). The new chord's duration × subdivision is matched to the sum
    // of the subSteps' duration × subdivision so total length is preserved.
    function chordifyStep(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || !step.isSub || !Array.isArray(step.subSteps) || step.subSteps.length === 0) return;

      const voices = [];
      const seen = new Set();
      const pushVoice = (n) => {
        if (n == null || n.freq == null) return;
        const key = n.freq;
        if (seen.has(key)) return;
        seen.add(key);
        voices.push({
          freq: n.freq,
          label: n.label,
          cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
          sound: n.sound,
          params: n.params ? { ...n.params } : undefined,
        });
      };
      step.subSteps.forEach(s => {
        if (Array.isArray(s.chord)) s.chord.forEach(pushVoice);
        else                        pushVoice(s);
      });
      if (voices.length === 0) return; // all rests / nested-subs only

      snapshotForUndo('Combine to chord');
      stopSequence();

      // Total length in quarter-note units. minSub is the finest subdivision
      // in the subSteps; using it as the new step's subdivision keeps the
      // duration multiplier integral whenever every subStep is a multiple of
      // that finest grid.
      const totalLength = step.subSteps.reduce((sum, s) => {
        const sd = (s.subdivision != null) ? s.subdivision : 1;
        return sum + sd * (s.duration || 1);
      }, 0);
      const minSub = step.subSteps.reduce((m, s) => {
        const sd = (s.subdivision != null) ? s.subdivision : 1;
        return Math.min(m, sd);
      }, Infinity);
      const newSub = (Number.isFinite(minSub) && minSub > 0) ? minSub : 1;
      const newDur = Math.max(1, Math.round(totalLength / newSub));

      if (voices.length === 1) {
        // A single voice doesn't need the chord wrapper.
        const v = voices[0];
        sequence[stepIndex] = {
          freq: v.freq,
          label: v.label,
          cellIndex: v.cellIndex,
          sound: v.sound,
          params: v.params,
          duration: newDur,
          subdivision: newSub,
        };
      } else {
        sequence[stepIndex] = {
          chord: voices,
          label: voices.map(n => n.label).join('·'),
          duration: newDur,
          subdivision: newSub,
        };
      }
      renderSequence();
    }

    // Break a chord step into N consecutive single-note steps in place,
    // preserving each voice's sound + params and copying the chord's own
    // subdivision/duration onto each new step. Total play time grows from
    // 1×subdivision to N×subdivision (vs Arpeggiate, which wraps the notes
    // in a subsequence).
    function splitChord(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || !Array.isArray(step.chord) || step.chord.length === 0) return;
      snapshotForUndo('Split');
      stopSequence();
      const baseDur = step.duration || 1;
      const baseSub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
      const splitSteps = step.chord.map(n => ({
        freq: n.freq,
        label: n.label,
        cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
        sound: n.sound,
        params: n.params ? { ...n.params } : undefined,
        duration: baseDur,
        subdivision: baseSub,
      }));
      sequence.splice(stepIndex, 1, ...splitSteps);
      renderSequence();
    }

    // Reverse / shuffle a subsequence's subSteps in place. Length, voicing,
    // and per-step subdivision/duration are preserved — only the order
    // changes. Skips no-op cases (empty or length-1 subSteps).
    function reverseSubseq(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || !step.isSub || !Array.isArray(step.subSteps) || step.subSteps.length < 2) return;
      snapshotForUndo('Reverse subsequence');
      stopSequence();
      step.subSteps.reverse();
      renderSequence();
    }
    function shuffleSubseq(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || !step.isSub || !Array.isArray(step.subSteps) || step.subSteps.length < 2) return;
      snapshotForUndo('Shuffle subsequence');
      stopSequence();
      const arr = step.subSteps;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      renderSequence();
    }

    function modulateStepRec(s, semis) {
      const factor = Math.pow(2, semis / 12);
      const retune = (n) => {
        if (n.freq == null) return;
        n.freq *= factor;
        try { n.label = Tone.Frequency(n.freq).toNote(); } catch (e) {}
      };
      if (s.chord) {
        s.chord.forEach(retune);
        s.label = s.chord.map(n => n.label).join('·');
      } else if (s.freq != null) {
        retune(s);
      }
      if (s.isSub && Array.isArray(s.subSteps)) {
        s.subSteps.forEach(child => modulateStepRec(child, semis));
      }
    }
    function stepHasNotes(s) {
      if (!s) return false;
      if (s.chord && s.chord.length > 0) return true;
      if (s.freq != null) return true;
      if (s.isSub && Array.isArray(s.subSteps)) return s.subSteps.some(stepHasNotes);
      return false;
    }

    // Build the context-menu action list for the step at `stepIndex`
    // in the active workspace `sequence`. Extracted so preview chips
    // in non-active Poly lanes can show the same menu after switching
    // to that lane on long-press.
    function _buildStepCtxActions(stepIndex) {
      const step = sequence[stepIndex];
      const actions = [];
      if (step && step.isSub) {
        actions.push({ label: 'Edit subsequence…', fn: () => enterSubEditMode(stepIndex) });
        actions.push({ label: 'Combine to chord', fn: () => chordifyStep(stepIndex) });
        if (Array.isArray(step.subSteps) && step.subSteps.length > 1) {
          actions.push({ label: 'Reverse', fn: () => reverseSubseq(stepIndex) });
          actions.push({ label: 'Shuffle', fn: () => shuffleSubseq(stepIndex) });
        }
        actions.push('hr');
      } else {
        if (step && (step.chord || step.freq !== null)) {
          actions.push({ label: 'Edit step…', fn: () => showStepEditor(stepIndex) });
        }
        if (step && Array.isArray(step.chord) && step.chord.length > 1) {
          actions.push({ label: 'Arpeggiate', fn: () => arpeggiateStep(stepIndex) });
          actions.push({ label: 'Split',      fn: () => splitChord(stepIndex) });
        }
        if (actions.length > 0) actions.push('hr');
      }
      if (stepHasNotes(step)) {
        actions.push({ label: 'Modulate ↑½', fn: () => { snapshotForUndo('Modulate ↑½'); modulateStepRec(step, 1);  renderSequence(); } });
        actions.push({ label: 'Modulate ↓½', fn: () => { snapshotForUndo('Modulate ↓½'); modulateStepRec(step, -1); renderSequence(); } });
        actions.push({ label: 'Transpose…', fn: () => showTransposeDialog(stepIndex) });
        actions.push({ label: step.variance ? 'Edit variance…' : 'Variance…', fn: () => showVarianceDialog(stepIndex) });
        // Pitch ramp — quick access to the existing step.bend
        // controls (semitones + atFraction) without opening the full
        // Sound editor.
        const hasBend = step.bend && Number.isFinite(step.bend.semitones) && step.bend.semitones !== 0;
        actions.push({ label: hasBend ? 'Edit pitch ramp…' : 'Pitch ramp…', fn: () => showPitchRampDialog(stepIndex) });
        actions.push('hr');
      }
      actions.push({ label: '⧉ Duplicate',   fn: () => duplicateStep(stepIndex) });
      // Sound editor scoped to the selected steps (change-only). If the
      // long-pressed chip isn't in the selection, edit just it.
      (function () {
        const inSel = (typeof selectedStepRefs !== 'undefined') && selectedStepRefs.indexOf(sequence[stepIndex]) >= 0;
        const targets = (inSel && selectedStepRefs.length) ? selectedStepRefs.slice() : [sequence[stepIndex]];
        const n = targets.length;
        actions.push({ label: '♪ Sound editor' + (n > 1 ? ' (' + n + ' steps)…' : '…'), fn: () => showSoundEditor(stepIndex, { steps: targets }) });
      })();
      actions.push({ label: '⇕ Fold',        fn: () => foldStep(stepIndex) });
      actions.push({ label: '⇄ Nudge…',      fn: () => showNudgeDialog(stepIndex) });
      actions.push({ label: 'Insert before', fn: () => { insertionPoint = stepIndex; renderSequence(); } });
      actions.push({ label: 'Insert after',  fn: () => { insertionPoint = stepIndex + 1; renderSequence(); } });
      actions.push('hr');
      // Multi-select aware delete: when 2+ chips are selected and the
      // long-pressed chip is one of them, "Remove step" turns into
      // "Remove N steps" and wipes the entire selection in one shot.
      const selectedIdxs = (multiSelectMode || selectedStepRefs.length > 1)
        ? selectedStepIndices().slice().sort((a, b) => a - b)
        : [];
      const longPressedSelected = selectedIdxs.includes(stepIndex);
      const multiDelete = selectedIdxs.length >= 2 && longPressedSelected;
      actions.push({
        label: multiDelete ? `Remove ${selectedIdxs.length} steps` : 'Remove step',
        danger: true,
        fn: () => {
          if (multiDelete) {
            snapshotForUndo('Remove steps');
            for (let i = selectedIdxs.length - 1; i >= 0; i--) {
              const idx = selectedIdxs[i];
              sequence.splice(idx, 1);
              if (insertionPoint !== null && idx < insertionPoint) insertionPoint--;
            }
            clearSelection();
          } else {
            snapshotForUndo('Remove step');
            sequence.splice(stepIndex, 1);
            if (insertionPoint !== null && stepIndex < insertionPoint) insertionPoint--;
          }
          if (insertionPoint !== null) {
            if (insertionPoint > sequence.length) insertionPoint = sequence.length;
            if (sequence.length === 0) insertionPoint = null;
          }
          renderSequence();
          document.getElementById('save-btn').disabled = sequence.length === 0;
        }
      });
      return actions;
    }

    // The step edit menu is now opened via the dedicated Edit button
    // (left of the Pan/Vol sliders), not by long-pressing a chip.
    // bindStepLongPress is reduced to suppressing the browser's native
    // context menu / text-selection callout so a long-press still
    // doesn't trigger Copy/Look-up overlays on top of the workspace.
    function bindStepLongPress(chip, stepIndex) {
      chip.addEventListener('contextmenu', (e) => e.preventDefault());
      chip.addEventListener('selectstart', (e) => e.preventDefault());
    }

    function buildInlineSoundPanel(params, onChange) {
      const p = { ...params };
      const container = document.createElement('div');
      container.className = 'se-inline-sound';

      const waveRow = document.createElement('div');
      waveRow.className = 'sm-waves';
      waveRow.style.marginBottom = '8px';
      getAllSoundOptions().forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (opt.value === p.type ? ' active' : '');
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          p.type = opt.value;
          waveRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          onChange(p);
        });
        waveRow.appendChild(btn);
      });
      container.appendChild(waveRow);

      [
        ['attack',  ' ms', 1,   500,  p.attack],
        ['decay',   ' ms', 10,  1000, p.decay],
        ['sustain', '%',   0,   100,  p.sustain],
        ['release', ' ms', 100, 3000, p.release],
        ['volume',  '%',   0,   100,  p.volume],
        ['detune',  ' ¢',  -100, 100, p.detune ?? 0],
        // -100 = full left, 0 = center, 100 = full right. Value is divided
        // by 100 in playNote when a Tone.Panner is inserted into the
        // per-note chain so chord voices can sit in different parts of
        // the stereo image.
        ['pan',     '',   -100, 100, p.pan ?? 0],
      ].forEach(([key, unit, min, max, val]) => {
        const row = document.createElement('div');
        row.className = 'sm-param';
        const labelRow = document.createElement('div');
        labelRow.className = 'sm-param-row';
        const formatVal = (v) => {
          if (key !== 'pan') return v + unit;
          if (v === 0) return 'C';
          return (v < 0 ? 'L' : 'R') + Math.abs(v);
        };
        labelRow.innerHTML = `${key.charAt(0).toUpperCase() + key.slice(1)} <span class="sm-val">${formatVal(val)}</span>`;
        const valSpan = labelRow.querySelector('.sm-val');
        const slider = document.createElement('input');
        slider.type = 'range'; slider.min = min; slider.max = max; slider.value = val;
        slider.addEventListener('input', () => {
          p[key] = parseInt(slider.value);
          valSpan.textContent = formatVal(p[key]);
          onChange(p);
        });
        row.appendChild(labelRow); row.appendChild(slider);
        container.appendChild(row);
      });
      return container;
    }

    function showStepEditor(stepIndex) {
      const step = sequence[stepIndex];
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      if (step.chord) buildChordEditor(modal, stepIndex, overlay);
      else             buildNoteEditor(modal, stepIndex, overlay);
    }

    function buildNoteEditor(modal, stepIndex, overlay) {
      const step = sequence[stepIndex];
      // Selection scope: when the edited chip is part of a multi-selection,
      // Apply writes the fields the user actually changed to EVERY selected
      // step (change-only — untouched, divergent per-step properties stay put),
      // mirroring the "♪ Sound editor" model. A single step keeps the classic
      // full-replace behavior. `_touched` records edited fields; 'note',
      // 'duration', 'subdivision' and 'bend' are tracked under those keys.
      // Whenever there's a multi-selection, Apply fans out to it. We don't
      // require the edited step to be found IN the selection by identity —
      // that guard silently fell back to single-step editing if refs ever
      // desynced (the "only the last selected step resizes" bug on mobile).
      // Always include the edited step so the chip you opened is covered too.
      const _selTargets = (typeof selectedStepRefs !== 'undefined' && selectedStepRefs.length > 1)
        ? (selectedStepRefs.indexOf(step) >= 0 ? selectedStepRefs.slice() : selectedStepRefs.concat([step]))
        : null;
      const _touched = new Set();
      const p = {
        freq:    step.freq,
        label:   step.label,
        cellIndex: step.cellIndex,
        duration: step.duration ?? 1,
        subdivision: (step.subdivision != null) ? step.subdivision : stepSubdivision,
        type:    step.params?.type    ?? step.sound ?? 'sine',
        attack:  step.params?.attack  ?? 10,
        decay:   step.params?.decay   ?? 100,
        sustain: step.params?.sustain ?? 50,
        release: step.params?.release ?? 1400,
        volume:  step.params?.volume  ?? 100,
        detune:  step.params?.detune  ?? 0,
        reverb:        step.params?.reverb        ?? 0,
        reverbSize:    step.params?.reverbSize    ?? 70,
        reverbTone:    step.params?.reverbTone    ?? 50,
        delay:         step.params?.delay         ?? 0,
        delayTime:     step.params?.delayTime     ?? 250,
        delayFeedback: step.params?.delayFeedback ?? 40,
        distortion:    step.params?.distortion    ?? 0,
        pan:           step.params?.pan           ?? 0,
        fxOverrideGlobal: !!step.params?.fxOverrideGlobal,
        bendSemitones: step.bend?.semitones ?? 0,
        bendAt:        Math.round(((step.bend?.atFraction ?? 1) * 100)),
      };

      modal.innerHTML = `
        <div class="sm-title">Edit Step ${stepIndex + 1}</div>
        <details class="sm-fold">
          <summary>Step subdivision</summary>
          <div class="sm-fold-body">
            <div class="sm-waves" id="se-sub-row"></div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Length (steps)</summary>
          <div class="sm-fold-body">
            <div class="sm-waves" id="se-len-row"></div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Note</summary>
          <div class="sm-fold-body">
            <div class="sm-section-label" style="margin-top:0;">Octave</div>
            <div class="sm-waves" id="se-octave-picker"></div>
            <div class="sm-section-label">Pitch</div>
            <div class="sm-waves" id="se-note-picker"></div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Sound</summary>
          <div class="sm-fold-body">
            <div class="sm-waves" id="se-wave-row" style="margin-bottom:14px;"></div>
            <div class="sm-param">
              <div class="sm-param-row">Attack <span class="sm-val" id="se-atk-v">${p.attack} ms</span></div>
              <input type="range" id="se-atk" min="1" max="500" value="${p.attack}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Decay <span class="sm-val" id="se-dec-v">${p.decay} ms</span></div>
              <input type="range" id="se-dec" min="10" max="1000" value="${p.decay}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Sustain <span class="sm-val" id="se-sus-v">${p.sustain}%</span></div>
              <input type="range" id="se-sus" min="0" max="100" value="${p.sustain}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Release <span class="sm-val" id="se-rel-v">${p.release} ms</span></div>
              <input type="range" id="se-rel" min="100" max="3000" value="${p.release}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Volume <span class="sm-val" id="se-vol-v">${p.volume}%</span></div>
              <input type="range" id="se-vol" min="0" max="100" value="${p.volume}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Tune <span class="sm-val" id="se-tune-v">${p.detune} ¢</span></div>
              <input type="range" id="se-tune" min="-100" max="100" value="${p.detune}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Pan <span class="sm-val" id="se-pan-v">${p.pan === 0 ? 'C' : (p.pan < 0 ? 'L' : 'R') + Math.abs(p.pan)}</span></div>
              <input type="range" id="se-pan" min="-100" max="100" value="${p.pan}" />
            </div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Pitch bend</summary>
          <div class="sm-fold-body">
            <div class="sm-param">
              <div class="sm-param-row">Bend by <span class="sm-val" id="se-bend-v">${p.bendSemitones >= 0 ? '+' : ''}${p.bendSemitones} st</span></div>
              <input type="range" id="se-bend" min="-12" max="12" step="1" value="${p.bendSemitones}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Reach by <span class="sm-val" id="se-bend-at-v">${p.bendAt}%</span></div>
              <input type="range" id="se-bend-at" min="5" max="100" step="5" value="${p.bendAt}" />
            </div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Effects</summary>
          <div class="sm-fold-body">
            <label class="sm-checkbox-row" title="When checked, this step skips the global FX chain — only its local effects apply.">
              <input type="checkbox" id="se-fx-override" ${p.fxOverrideGlobal ? 'checked' : ''} />
              Override Global
            </label>
            <div class="sm-section-label">Reverb</div>
            <div class="sm-param">
              <div class="sm-param-row">Mix <span class="sm-val" id="se-rev-v">${p.reverb}%</span></div>
              <input type="range" id="se-rev" min="0" max="100" value="${p.reverb}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Size <span class="sm-val" id="se-rev-size-v">${p.reverbSize}%</span></div>
              <input type="range" id="se-rev-size" min="0" max="100" value="${p.reverbSize}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Tone <span class="sm-val" id="se-rev-tone-v">${p.reverbTone}%</span></div>
              <input type="range" id="se-rev-tone" min="0" max="100" value="${p.reverbTone}" />
            </div>
            <div class="sm-section-label">Delay</div>
            <div class="sm-param">
              <div class="sm-param-row">Mix <span class="sm-val" id="se-dly-v">${p.delay}%</span></div>
              <input type="range" id="se-dly" min="0" max="100" value="${p.delay}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Time <span class="sm-val" id="se-dly-time-v">${p.delayTime} ms</span></div>
              <input type="range" id="se-dly-time" min="20" max="1000" step="10" value="${p.delayTime}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Sync to BPM</div>
              <select id="se-dly-sync" class="sm-select">
                <option value="">Off (use Time)</option>
                <option value="2n">1/2</option>
                <option value="4n.">1/4 dotted</option>
                <option value="4n">1/4</option>
                <option value="4t">1/4 triplet</option>
                <option value="8n.">1/8 dotted</option>
                <option value="8n">1/8</option>
                <option value="8t">1/8 triplet</option>
                <option value="16n.">1/16 dotted</option>
                <option value="16n">1/16</option>
                <option value="16t">1/16 triplet</option>
                <option value="32n">1/32</option>
              </select>
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Feedback <span class="sm-val" id="se-dly-fb-v">${p.delayFeedback}%</span></div>
              <input type="range" id="se-dly-fb" min="0" max="95" value="${p.delayFeedback}" />
            </div>
            <div class="sm-section-label">Distortion</div>
            <div class="sm-param">
              <div class="sm-param-row">Amount <span class="sm-val" id="se-dst-v">${p.distortion}%</span></div>
              <input type="range" id="se-dst" min="0" max="100" value="${p.distortion}" />
            </div>
            <details class="sm-fx-group"><summary>Chorus</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-cho-v">${p.chorus ?? 0}%</span></div><input type="range" id="se-cho" min="0" max="100" value="${p.chorus ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="se-cho-freq-v">${p.chorusFreq ?? 4} Hz</span></div><input type="range" id="se-cho-freq" min="0.1" max="10" step="0.1" value="${p.chorusFreq ?? 4}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="se-cho-depth-v">${p.chorusDepth ?? 70}%</span></div><input type="range" id="se-cho-depth" min="0" max="100" value="${p.chorusDepth ?? 70}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Vibrato</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-vib-v">${p.vibrato ?? 0}%</span></div><input type="range" id="se-vib" min="0" max="100" value="${p.vibrato ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="se-vib-freq-v">${p.vibratoFreq ?? 5} Hz</span></div><input type="range" id="se-vib-freq" min="0.1" max="20" step="0.1" value="${p.vibratoFreq ?? 5}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="se-vib-depth-v">${p.vibratoDepth ?? 30}%</span></div><input type="range" id="se-vib-depth" min="0" max="100" value="${p.vibratoDepth ?? 30}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Tremolo</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-trm-v">${p.tremolo ?? 0}%</span></div><input type="range" id="se-trm" min="0" max="100" value="${p.tremolo ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="se-trm-freq-v">${p.tremoloFreq ?? 5} Hz</span></div><input type="range" id="se-trm-freq" min="0.1" max="20" step="0.1" value="${p.tremoloFreq ?? 5}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="se-trm-depth-v">${p.tremoloDepth ?? 70}%</span></div><input type="range" id="se-trm-depth" min="0" max="100" value="${p.tremoloDepth ?? 70}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Phaser</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-phs-v">${p.phaser ?? 0}%</span></div><input type="range" id="se-phs" min="0" max="100" value="${p.phaser ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="se-phs-freq-v">${p.phaserFreq ?? 0.5} Hz</span></div><input type="range" id="se-phs-freq" min="0.05" max="10" step="0.05" value="${p.phaserFreq ?? 0.5}" /></div>
              <div class="sm-param"><div class="sm-param-row">Octaves <span class="sm-val" id="se-phs-oct-v">${p.phaserOctaves ?? 3}</span></div><input type="range" id="se-phs-oct" min="1" max="7" step="1" value="${p.phaserOctaves ?? 3}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Auto Filter</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-af-v">${p.autoFilter ?? 0}%</span></div><input type="range" id="se-af" min="0" max="100" value="${p.autoFilter ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="se-af-freq-v">${p.autoFilterFreq ?? 1} Hz</span></div><input type="range" id="se-af-freq" min="0.1" max="10" step="0.1" value="${p.autoFilterFreq ?? 1}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="se-af-depth-v">${p.autoFilterDepth ?? 100}%</span></div><input type="range" id="se-af-depth" min="0" max="100" value="${p.autoFilterDepth ?? 100}" /></div>
              <div class="sm-param"><div class="sm-param-row">Base <span class="sm-val" id="se-af-base-v">${p.autoFilterBaseFreq ?? 200} Hz</span></div><input type="range" id="se-af-base" min="50" max="2000" step="10" value="${p.autoFilterBaseFreq ?? 200}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Ping-Pong Delay</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-pp-v">${p.pingPong ?? 0}%</span></div><input type="range" id="se-pp" min="0" max="100" value="${p.pingPong ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Time <span class="sm-val" id="se-pp-time-v">${p.pingPongTime ?? 250} ms</span></div><input type="range" id="se-pp-time" min="20" max="1000" step="10" value="${p.pingPongTime ?? 250}" /></div>
              <div class="sm-param"><div class="sm-param-row">Sync to BPM</div><select id="se-pp-sync" class="sm-select"><option value="">Off (use Time)</option><option value="2n">1/2</option><option value="4n.">1/4 dotted</option><option value="4n">1/4</option><option value="4t">1/4 triplet</option><option value="8n.">1/8 dotted</option><option value="8n">1/8</option><option value="8t">1/8 triplet</option><option value="16n.">1/16 dotted</option><option value="16n">1/16</option><option value="16t">1/16 triplet</option><option value="32n">1/32</option></select></div>
              <div class="sm-param"><div class="sm-param-row">Feedback <span class="sm-val" id="se-pp-fb-v">${p.pingPongFeedback ?? 30}%</span></div><input type="range" id="se-pp-fb" min="0" max="95" value="${p.pingPongFeedback ?? 30}" /></div>
            </details>
            <details class="sm-fx-group"><summary>Auto Pan</summary>
              <div class="sm-param"><div class="sm-param-row">Mix <span class="sm-val" id="se-apan-v">${p.autoPan ?? 0}%</span></div><input type="range" id="se-apan" min="0" max="100" value="${p.autoPan ?? 0}" /></div>
              <div class="sm-param"><div class="sm-param-row">Rate <span class="sm-val" id="se-apan-freq-v">${p.autoPanFreq ?? 1} Hz</span></div><input type="range" id="se-apan-freq" min="0.1" max="10" step="0.1" value="${p.autoPanFreq ?? 1}" /></div>
              <div class="sm-param"><div class="sm-param-row">Depth <span class="sm-val" id="se-apan-depth-v">${p.autoPanDepth ?? 100}%</span></div><input type="range" id="se-apan-depth" min="0" max="100" value="${p.autoPanDepth ?? 100}" /></div>
            </details>
          </div>
        </details>
        <div class="sm-footer">
          <button class="sm-remove-step">Remove</button>
          <button class="sm-preview">▶ Preview</button>
          <button class="sm-apply">Apply</button>
        </div>
      `;

      // In multi-select scope, retitle so it's clear edits hit every selected
      // step (and that untouched fields are left per-step).
      if (_selTargets) {
        const t = modal.querySelector('.sm-title');
        if (t) t.textContent = 'Edit ' + _selTargets.length + ' steps — only changed fields apply';
      }

      // Subdivision picker
      const subRow = modal.querySelector('#se-sub-row');
      const SUBS = [[4,'1/1'],[2,'1/2'],[1,'1/4'],[0.5,'1/8'],[0.25,'1/16'],[0.125,'1/32']];
      SUBS.forEach(([v, lbl]) => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (v === p.subdivision ? ' active' : '');
        btn.textContent = lbl;
        btn.addEventListener('click', () => {
          p.subdivision = v; _touched.add('subdivision');
          subRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        subRow.appendChild(btn);
      });

      // Length picker
      const lenRow = modal.querySelector('#se-len-row');
      [1,2,3,4,8].forEach(len => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (len === p.duration ? ' active' : '');
        btn.textContent = String(len);
        btn.addEventListener('click', () => {
          p.duration = len; _touched.add('duration');
          lenRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        lenRow.appendChild(btn);
      });

      // Note picker — broken into an Octave row and a Pitch row so the
      // user can retune the step to any octave, not just the octaves the
      // grid currently exposes. Picking an octave outside the grid range
      // leaves cellIndex null (no live cell to highlight) but the freq
      // still plays back correctly via the freq field.
      const notePicker = modal.querySelector('#se-note-picker');
      const octavePicker = modal.querySelector('#se-octave-picker');
      // Parse the step's current octave from its label ("C4" → 4, "F#-1" → -1).
      // Falls back to the workspace baseOctave if the label is missing or
      // doesn't match (e.g., for restored projects with custom labels).
      const _parseOctave = (lbl) => {
        const m = (lbl || '').match(/(-?\d+)$/);
        return m ? parseInt(m[1], 10) : baseOctave;
      };
      const OCT_MIN = 0, OCT_MAX = 8;
      let octavePickerCurrent = Math.max(OCT_MIN, Math.min(OCT_MAX, _parseOctave(p.label)));
      // Build one octave's worth of chromatic notes anchored at the
      // workspace's rootIdx (so the row starts on the chosen root, same
      // ordering as the main grid).
      const _notesForOctaveAt = (oct) => {
        const out = [];
        for (let i = 0; i < 12; i++) {
          const semi = rootIdx + i;
          const noteIdx = semi % 12;
          const octaveNum = oct + Math.floor(semi / 12);
          const midi = 12 * (octaveNum + 1) + noteIdx;
          const freq = masterFreqA * Math.pow(2, (midi - 69) / 12);
          out.push({ freq, label: CHROMATIC[noteIdx] + octaveNum });
        }
        return out;
      };
      const renderPitchRow = () => {
        notePicker.innerHTML = '';
        const octNotes = _notesForOctaveAt(octavePickerCurrent);
        octNotes.forEach((n) => {
          const btn = document.createElement('button');
          btn.className = 'sm-wave' + (Math.abs(n.freq - p.freq) / n.freq < 0.001 ? ' active' : '');
          btn.textContent = n.label;
          btn.addEventListener('click', () => {
            p.freq = n.freq; p.label = n.label; _touched.add('note');
            // Map freq back to a grid cell when it lives in range; null
            // out otherwise so playback doesn't flash a wrong cell.
            const gridIdx = (typeof _findCellIdxForFreq === 'function') ? _findCellIdxForFreq(n.freq) : -1;
            p.cellIndex = (gridIdx >= 0) ? gridIdx : null;
            notePicker.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
          notePicker.appendChild(btn);
        });
      };
      const renderOctaveRow = () => {
        octavePicker.innerHTML = '';
        for (let o = OCT_MIN; o <= OCT_MAX; o++) {
          const btn = document.createElement('button');
          btn.className = 'sm-wave' + (o === octavePickerCurrent ? ' active' : '');
          btn.textContent = String(o);
          btn.addEventListener('click', () => {
            octavePickerCurrent = o;
            renderOctaveRow();
            renderPitchRow();
          });
          octavePicker.appendChild(btn);
        }
      };
      renderOctaveRow();
      renderPitchRow();

      // Wave type
      const waveRow = modal.querySelector('#se-wave-row');
      SOUNDS.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (s === p.type ? ' active' : '');
        btn.textContent = s.charAt(0).toUpperCase() + s.slice(1);
        btn.addEventListener('click', () => {
          p.type = s; _touched.add('type');
          waveRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        waveRow.appendChild(btn);
      });

      // Sliders. Pan uses an L/C/R formatter instead of a unit suffix.
      [
        ['se-atk',       'se-atk-v',       'attack',        ' ms'],
        ['se-dec',       'se-dec-v',       'decay',         ' ms'],
        ['se-sus',       'se-sus-v',       'sustain',       '%'],
        ['se-rel',       'se-rel-v',       'release',       ' ms'],
        ['se-vol',       'se-vol-v',       'volume',        '%'],
        ['se-tune',      'se-tune-v',      'detune',        ' ¢'],
        ['se-pan',       'se-pan-v',       'pan',           'pan'],
        ['se-rev',       'se-rev-v',       'reverb',        '%'],
        ['se-rev-size',  'se-rev-size-v',  'reverbSize',    '%'],
        ['se-rev-tone',  'se-rev-tone-v',  'reverbTone',    '%'],
        ['se-dly',       'se-dly-v',       'delay',              '%'],
        ['se-dly-time',  'se-dly-time-v',  'delayTime',          ' ms'],
        ['se-dly-fb',    'se-dly-fb-v',    'delayFeedback',      '%'],
        ['se-dst',       'se-dst-v',       'distortion',         '%'],
        ['se-cho',       'se-cho-v',       'chorus',             '%'],
        ['se-cho-freq',  'se-cho-freq-v',  'chorusFreq',         ' Hz'],
        ['se-cho-depth', 'se-cho-depth-v', 'chorusDepth',        '%'],
        ['se-vib',       'se-vib-v',       'vibrato',            '%'],
        ['se-vib-freq',  'se-vib-freq-v',  'vibratoFreq',        ' Hz'],
        ['se-vib-depth', 'se-vib-depth-v', 'vibratoDepth',       '%'],
        ['se-trm',       'se-trm-v',       'tremolo',            '%'],
        ['se-trm-freq',  'se-trm-freq-v',  'tremoloFreq',        ' Hz'],
        ['se-trm-depth', 'se-trm-depth-v', 'tremoloDepth',       '%'],
        ['se-phs',       'se-phs-v',       'phaser',             '%'],
        ['se-phs-freq',  'se-phs-freq-v',  'phaserFreq',         ' Hz'],
        ['se-phs-oct',   'se-phs-oct-v',   'phaserOctaves',      ''],
        ['se-af',        'se-af-v',        'autoFilter',         '%'],
        ['se-af-freq',   'se-af-freq-v',   'autoFilterFreq',     ' Hz'],
        ['se-af-depth',  'se-af-depth-v',  'autoFilterDepth',    '%'],
        ['se-af-base',   'se-af-base-v',   'autoFilterBaseFreq', ' Hz'],
        ['se-pp',        'se-pp-v',        'pingPong',           '%'],
        ['se-pp-time',   'se-pp-time-v',   'pingPongTime',       ' ms'],
        ['se-pp-fb',     'se-pp-fb-v',     'pingPongFeedback',   '%'],
        ['se-apan',      'se-apan-v',      'autoPan',            '%'],
        ['se-apan-freq', 'se-apan-freq-v', 'autoPanFreq',        ' Hz'],
        ['se-apan-depth','se-apan-depth-v','autoPanDepth',       '%'],
      ].forEach(([id, valId, key, unit]) => {
        const input = modal.querySelector(`#${id}`);
        if (!input) return;
        const label = modal.querySelector(`#${valId}`);
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          p[key] = v; _touched.add(key);
          if (!label) return;
          if (unit === 'pan') {
            label.textContent = v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v);
          } else {
            label.textContent = v + unit;
          }
        });
      });
      const seOverrideCheckbox = modal.querySelector('#se-fx-override');
      if (seOverrideCheckbox) {
        seOverrideCheckbox.addEventListener('change', () => {
          p.fxOverrideGlobal = !!seOverrideCheckbox.checked; _touched.add('fxOverrideGlobal');
        });
      }
      const seDlySyncSel = modal.querySelector('#se-dly-sync');
      if (seDlySyncSel) {
        seDlySyncSel.value = p.delaySync || '';
        seDlySyncSel.addEventListener('change', () => {
          p.delaySync = seDlySyncSel.value || null; _touched.add('delaySync');
        });
      }
      const sePpSyncSel = modal.querySelector('#se-pp-sync');
      if (sePpSyncSel) {
        sePpSyncSel.value = p.pingPongSync || '';
        sePpSyncSel.addEventListener('change', () => {
          p.pingPongSync = sePpSyncSel.value || null; _touched.add('pingPongSync');
        });
      }

      // Pitch-bend sliders. "Bend by" is in semitones; "Reach by" is the
      // fraction of the step duration at which the bend reaches its target
      // (the pitch then holds for the remainder).
      const bendSlider = modal.querySelector('#se-bend');
      const bendValEl  = modal.querySelector('#se-bend-v');
      const bendAtSlider = modal.querySelector('#se-bend-at');
      const bendAtValEl  = modal.querySelector('#se-bend-at-v');
      bendSlider.addEventListener('input', () => {
        p.bendSemitones = parseInt(bendSlider.value) || 0; _touched.add('bend');
        bendValEl.textContent = (p.bendSemitones >= 0 ? '+' : '') + p.bendSemitones + ' st';
      });
      bendAtSlider.addEventListener('input', () => {
        p.bendAt = parseInt(bendAtSlider.value) || 100; _touched.add('bend');
        bendAtValEl.textContent = p.bendAt + '%';
      });

      const buildPreviewParams = () => {
        const out = {
          type: p.type, attack: p.attack, decay: p.decay, sustain: p.sustain,
          release: p.release, volume: p.volume, detune: p.detune,
          pan: p.pan,
          reverb: p.reverb, reverbSize: p.reverbSize, reverbTone: p.reverbTone,
          delay:  p.delay,  delayTime:  p.delayTime,  delayFeedback: p.delayFeedback,
          distortion: p.distortion,
          fxOverrideGlobal: !!p.fxOverrideGlobal,
        };
        if (p.bendSemitones !== 0) out.bend = { semitones: p.bendSemitones, atFraction: p.bendAt / 100 };
        return out;
      };
      modal.querySelector('.sm-preview').addEventListener('click', () => playNote(p.freq, buildPreviewParams()));

      modal.querySelector('.sm-remove-step').addEventListener('click', () => {
        sequence.splice(stepIndex, 1);
        renderSequence();
        document.getElementById('save-btn').disabled = sequence.length === 0;
        overlay.remove();
      });

      modal.querySelector('.sm-apply').addEventListener('click', () => {
        // Multi-select scope: write ONLY the fields the user changed to every
        // selected step (change-only), so divergent untouched per-step
        // properties stay intact. Note identity ('note') is applied only to
        // plain-note steps; FX/envelope params fan out to chord voices and
        // sub-step leaves too.
        if (_selTargets) {
          if (!_touched.size) { overlay.remove(); return; }
          if (typeof snapshotForUndo === 'function') snapshotForUndo('Edit step');
          const META = ['note', 'duration', 'subdivision', 'bend'];
          const paramKeys = Array.from(_touched).filter(k => META.indexOf(k) < 0);
          const writeParamsDeep = (st) => {
            if (!st) return;
            if (st.isSub && Array.isArray(st.subSteps)) { st.subSteps.forEach(writeParamsDeep); return; }
            if (paramKeys.length) {
              if (!st.params) st.params = {};
              paramKeys.forEach(k => { st.params[k] = p[k]; if (k === 'type') st.sound = p[k]; });
              if (Array.isArray(st.chord)) st.chord.forEach(v => {
                if (!v) return; if (!v.params) v.params = {};
                paramKeys.forEach(k => { v.params[k] = p[k]; if (k === 'type') v.sound = p[k]; });
              });
            }
          };
          const writeSel = (st) => {
            if (!st) return;
            if (_touched.has('note') && !Array.isArray(st.chord) && !st.isSub) {
              st.freq = p.freq; st.label = p.label; st.cellIndex = p.cellIndex;
            }
            if (_touched.has('duration'))    st.duration = p.duration;
            if (_touched.has('subdivision')) st.subdivision = p.subdivision;
            if (_touched.has('bend')) {
              if (p.bendSemitones !== 0) st.bend = { semitones: p.bendSemitones, atFraction: p.bendAt / 100 };
              else delete st.bend;
            }
            writeParamsDeep(st);
          };
          _selTargets.forEach(writeSel);
          renderSequence();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          overlay.remove();
          return;
        }
        const next = { freq: p.freq, label: p.label, cellIndex: p.cellIndex,
          sound: p.type, duration: p.duration, subdivision: p.subdivision,
          params: {
            type: p.type, attack: p.attack, decay: p.decay, sustain: p.sustain,
            release: p.release, volume: p.volume, detune: p.detune,
            pan: p.pan,
            reverb: p.reverb, reverbSize: p.reverbSize, reverbTone: p.reverbTone,
            delay:  p.delay,  delayTime:  p.delayTime,  delayFeedback: p.delayFeedback,
            distortion: p.distortion,
            fxOverrideGlobal: !!p.fxOverrideGlobal,
          } };
        if (p.bendSemitones !== 0) next.bend = { semitones: p.bendSemitones, atFraction: p.bendAt / 100 };
        sequence[stepIndex] = next;
        renderSequence();
        overlay.remove();
      });
    }

    function buildChordEditor(modal, stepIndex, overlay) {
      const step = sequence[stepIndex];
      let chordNotes = step.chord.map(n => ({
        ...n,
        params: n.params ? { ...n.params } : { type: n.sound || 'sine', attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0, reverb: 0, reverbSize: 70, reverbTone: 50, delay: 0, delayTime: 250, delayFeedback: 40, delaySync: null, distortion: 0, chorus: 0, chorusFreq: 4, chorusDepth: 70, vibrato: 0, vibratoFreq: 5, vibratoDepth: 30, tremolo: 0, tremoloFreq: 5, tremoloDepth: 70, phaser: 0, phaserFreq: 0.5, phaserOctaves: 3, autoFilter: 0, autoFilterFreq: 1, autoFilterDepth: 100, autoFilterBaseFreq: 200, pingPong: 0, pingPongTime: 250, pingPongFeedback: 30, pingPongSync: null, autoPan: 0, autoPanFreq: 1, autoPanDepth: 100 },
      }));
      let expandedIdx = null;       // 'sound' panel index
      let pitchExpandedIdx = null;  // 'pitch' picker index
      let chordDuration = step.duration ?? 1;
      let chordSubdivision = (step.subdivision != null) ? step.subdivision : stepSubdivision;
      let chordBendSemitones = step.bend?.semitones ?? 0;
      // Chord-wide pan override: stays at 0 (center) by default so
      // individual voice pans pass through. Setting to a non-center
      // value writes step.chordPan on Apply; chordVoiceParams uses
      // that to override every voice's pan during playback.
      let chordPan = Number.isFinite(step.chordPan) ? step.chordPan : 0;
      let chordBendAt = Math.round(((step.bend?.atFraction ?? 1) * 100));

      modal.innerHTML = `
        <div class="sm-title">Edit Chord — Step ${stepIndex + 1}</div>
        <details class="sm-fold">
          <summary>Step subdivision</summary>
          <div class="sm-fold-body">
            <div class="sm-waves" id="se-chord-sub-row"></div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Length (steps)</summary>
          <div class="sm-fold-body">
            <div class="sm-waves" id="se-chord-len-row"></div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Notes</summary>
          <div class="sm-fold-body">
            <div class="se-chord-list" id="se-chord-list"></div>
            <div class="sm-section-label">Add note</div>
            <div class="sm-section-label" style="opacity:0.7;margin-top:4px;">Octave</div>
            <div class="sm-waves" id="se-add-oct-row"></div>
            <div class="sm-section-label" style="opacity:0.7;margin-top:6px;">Pitch</div>
            <div class="sm-waves" id="se-add-picker"></div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Pan / Volume (whole chord)</summary>
          <div class="sm-fold-body">
            <div class="sm-param">
              <div class="sm-param-row">Pan (all voices) <span class="sm-val" id="se-cpan-all-v">C</span></div>
              <input type="range" id="se-cpan-all" min="-100" max="100" value="0" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Volume (all voices) <span class="sm-val" id="se-cvol-all-v">100%</span></div>
              <input type="range" id="se-cvol-all" min="0" max="100" value="100" />
            </div>
            <div class="sm-hint" style="color:#6c7186;font-size:0.72rem;margin-top:6px;">
              Moving these overrides every voice's pan / volume. Open a voice's <em>Sound ▾</em> for per-voice control.
            </div>
          </div>
        </details>
        <details class="sm-fold">
          <summary>Pitch bend (whole chord)</summary>
          <div class="sm-fold-body">
            <div class="sm-param">
              <div class="sm-param-row">Bend by <span class="sm-val" id="se-cbend-v">${chordBendSemitones >= 0 ? '+' : ''}${chordBendSemitones} st</span></div>
              <input type="range" id="se-cbend" min="-12" max="12" step="1" value="${chordBendSemitones}" />
            </div>
            <div class="sm-param">
              <div class="sm-param-row">Reach by <span class="sm-val" id="se-cbend-at-v">${chordBendAt}%</span></div>
              <input type="range" id="se-cbend-at" min="5" max="100" step="5" value="${chordBendAt}" />
            </div>
          </div>
        </details>
        <div class="sm-footer">
          <button class="sm-remove-step">Remove step</button>
          <button class="sm-preview">▶ Preview</button>
          <button class="sm-apply">Apply</button>
        </div>
      `;

      const chordSubRow = modal.querySelector('#se-chord-sub-row');
      const SUBS_C = [
        [4,    '1/1'],
        [2,    '1/2'],
        [1,    '1/4'],
        [0.5,  '1/8'],
        [1/3,  '1/8t'],
        [0.25, '1/16'],
        [1/6,  '1/16t'],
        [0.125,'1/32'],
        [1/12, '1/32t'],
      ];
      SUBS_C.forEach(([v, lbl]) => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (v === chordSubdivision ? ' active' : '');
        btn.textContent = lbl;
        btn.addEventListener('click', () => {
          chordSubdivision = v;
          chordSubRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        chordSubRow.appendChild(btn);
      });

      const chordLenRow = modal.querySelector('#se-chord-len-row');
      [1,2,3,4,8].forEach(len => {
        const btn = document.createElement('button');
        btn.className = 'sm-wave' + (len === chordDuration ? ' active' : '');
        btn.textContent = String(len);
        btn.addEventListener('click', () => {
          chordDuration = len;
          chordLenRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        chordLenRow.appendChild(btn);
      });

      // Per-octave note table — chord voices can land outside the grid's
      // current octave by picking a different one in the Add / Pitch
      // pickers. cellIndex is set to -1 for off-grid voices so the
      // existing flash-by-cellIndex path doesn't light up the wrong cell.
      const _octRowVals = [1, 2, 3, 4, 5, 6, 7];
      function _notesForChordOct(oct) {
        const out = [];
        for (let pc = 0; pc < 12; pc++) {
          const semi = (rootIdx + pc) % 12;
          const labelOct = oct + Math.floor((rootIdx + pc) / 12);
          const midi = 12 * (labelOct + 1) + semi;
          const freq = masterFreqA * Math.pow(2, (midi - 69) / 12);
          out.push({ freq, label: CHROMATIC[semi] + labelOct });
        }
        return out;
      }
      function _octaveOfLabel(lbl) {
        const m = (lbl || '').match(/(-?\d+)$/);
        return m ? parseInt(m[1], 10) : baseOctave;
      }
      function _cellIndexForFreq(freq) {
        let best = -1, bestDelta = Infinity;
        for (let i = 0; i < notes.length; i++) {
          const d = Math.abs(notes[i].freq - freq);
          if (d < bestDelta) { bestDelta = d; best = i; }
        }
        // Only adopt the cell mapping if the freq matches within a few
        // cents — voices that sit a full semitone away from any grid
        // cell stay marked off-grid so we don't pull them onto the wrong
        // cell highlight at playback.
        return (bestDelta < 0.5) ? best : -1;
      }

      // Add-note octave row + pitch picker. Both repaint when the
      // selected octave changes so the pitch buttons reflect the
      // current octave choice.
      let addOctave = baseOctave;
      const addOctRow = modal.querySelector('#se-add-oct-row');
      const addPicker = modal.querySelector('#se-add-picker');
      function _renderAddOctRow() {
        addOctRow.innerHTML = '';
        _octRowVals.forEach(v => {
          const b = document.createElement('button');
          b.className = 'sm-wave' + (v === addOctave ? ' active' : '');
          b.textContent = String(v);
          b.addEventListener('click', () => {
            addOctave = v;
            _renderAddOctRow();
            _renderAddPicker();
          });
          addOctRow.appendChild(b);
        });
      }
      function _renderAddPicker() {
        addPicker.innerHTML = '';
        _notesForChordOct(addOctave).forEach(n => {
          const btn = document.createElement('button');
          btn.className = 'sm-wave';
          btn.textContent = n.label;
          btn.addEventListener('click', () => {
            const ci = _cellIndexForFreq(n.freq);
            const baseParams = (ci >= 0 && cellParams[ci])
              ? cellParams[ci]
              : { type: 'sine', attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0, reverb: 0, reverbSize: 70, reverbTone: 50, delay: 0, delayTime: 250, delayFeedback: 40, distortion: 0 };
            chordNotes.push({ freq: n.freq, label: n.label, cellIndex: ci, sound: baseParams.type,
              params: { ...baseParams } });
            renderList();
          });
          addPicker.appendChild(btn);
        });
      }
      _renderAddOctRow();
      _renderAddPicker();

      // Chord-wide Pan + Volume. Pan stays per-voice when the slider
      // is centered (chordPan=0) — only at non-center does playback
      // override each voice via chordVoiceParams. Volume still
      // broadcasts to every voice's params.volume directly because
      // there's no playback-side override path for volume yet.
      const cpanAll  = modal.querySelector('#se-cpan-all');
      const cpanAllV = modal.querySelector('#se-cpan-all-v');
      const cvolAll  = modal.querySelector('#se-cvol-all');
      const cvolAllV = modal.querySelector('#se-cvol-all-v');
      const fmtPan = (v) => (v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v));
      if (cpanAll && cpanAllV) {
        cpanAll.value = String(chordPan);
        cpanAllV.textContent = fmtPan(chordPan);
        cpanAll.addEventListener('input', () => {
          const v = parseInt(cpanAll.value, 10) || 0;
          chordPan = v;
          cpanAllV.textContent = fmtPan(v);
        });
      }
      if (cvolAll && cvolAllV) {
        cvolAll.addEventListener('input', () => {
          const v = Math.max(0, Math.min(100, parseInt(cvolAll.value, 10) || 0));
          cvolAllV.textContent = v + '%';
          chordNotes.forEach(n => {
            if (!n.params) n.params = {};
            n.params.volume = v;
          });
        });
      }

      function renderList() {
        const listEl = modal.querySelector('#se-chord-list');
        listEl.innerHTML = '';
        if (chordNotes.length === 0) {
          const empty = document.createElement('div');
          Object.assign(empty.style, { color:'#4a4a6a', fontSize:'0.8rem', fontFamily:'Segoe UI,sans-serif', padding:'8px 0' });
          empty.textContent = 'No notes — add some below.';
          listEl.appendChild(empty); return;
        }
        chordNotes.forEach((n, ni) => {
          const row = document.createElement('div');
          row.className = 'se-chord-row';

          // Clickable note label — opens the inline pitch picker for
          // this voice. Doubles as the "change which note this voice
          // plays" affordance: tapping the label is the natural
          // gesture, no extra button needed.
          const lbl = document.createElement('button');
          lbl.type = 'button';
          lbl.className = 'se-chord-note-label';
          lbl.textContent = n.label + (pitchExpandedIdx === ni ? ' ▴' : ' ▾');
          lbl.title = pitchExpandedIdx === ni
            ? 'Close the pitch picker'
            : 'Click to change this voice’s pitch';

          const badge = document.createElement('span');
          badge.className = 'se-wave-badge';
          badge.textContent = (n.params?.type || n.sound || 'sine').slice(0, 3);

          const editBtn = document.createElement('button');
          editBtn.className = 'se-edit-btn';
          editBtn.textContent = expandedIdx === ni ? 'Sound ▲' : 'Sound ▾';

          const removeBtn = document.createElement('button');
          removeBtn.className = 'se-remove-btn';
          removeBtn.textContent = '×';

          row.appendChild(lbl); row.appendChild(badge);
          row.appendChild(editBtn); row.appendChild(removeBtn);
          listEl.appendChild(row);

          // Inline pitch picker — Octave row + pitch row. Clicking an
          // octave repaints the pitch row with that octave's chromatic
          // pitches; clicking a pitch retunes this voice. Voices can
          // sit outside the grid's current octave (cellIndex = -1) so
          // the user isn't constrained to the active octave count.
          if (pitchExpandedIdx === ni) {
            const curOct = _octaveOfLabel(n.label);
            let pickOct = curOct;
            const octLabel = document.createElement('div');
            octLabel.className = 'sm-section-label';
            octLabel.style.opacity = '0.7';
            octLabel.style.marginTop = '4px';
            octLabel.textContent = 'Octave';
            listEl.appendChild(octLabel);
            const octRow = document.createElement('div');
            octRow.className = 'sm-waves';
            const paintOct = () => {
              octRow.innerHTML = '';
              _octRowVals.forEach(v => {
                const ob = document.createElement('button');
                ob.className = 'sm-wave' + (v === pickOct ? ' active' : '');
                ob.textContent = String(v);
                ob.addEventListener('click', () => {
                  pickOct = v;
                  paintOct();
                  paintPitch();
                });
                octRow.appendChild(ob);
              });
            };
            const pitchLabel = document.createElement('div');
            pitchLabel.className = 'sm-section-label';
            pitchLabel.style.opacity = '0.7';
            pitchLabel.style.marginTop = '6px';
            pitchLabel.textContent = 'Pitch';
            const picker = document.createElement('div');
            picker.className = 'sm-waves';
            const paintPitch = () => {
              picker.innerHTML = '';
              _notesForChordOct(pickOct).forEach(note => {
                const pb = document.createElement('button');
                const isActive = Math.abs(note.freq - n.freq) < 1e-3;
                pb.className = 'sm-wave' + (isActive ? ' active' : '');
                pb.textContent = note.label;
                pb.addEventListener('click', () => {
                  chordNotes[ni].freq      = note.freq;
                  chordNotes[ni].label     = note.label;
                  chordNotes[ni].cellIndex = _cellIndexForFreq(note.freq);
                  pitchExpandedIdx = null;
                  renderList();
                });
                picker.appendChild(pb);
              });
            };
            paintOct();
            paintPitch();
            listEl.appendChild(octRow);
            listEl.appendChild(pitchLabel);
            listEl.appendChild(picker);
          }

          if (expandedIdx === ni) {
            const panel = buildInlineSoundPanel(n.params, (updated) => {
              chordNotes[ni].params = { ...updated };
              chordNotes[ni].sound  = updated.type;
              badge.textContent = updated.type.slice(0, 3);
            });
            listEl.appendChild(panel);
          }

          lbl.addEventListener('click', () => {
            pitchExpandedIdx = pitchExpandedIdx === ni ? null : ni;
            // Collapse the sound panel for this row when opening pitch
            // so the two expansions don't stack and crowd the modal.
            if (pitchExpandedIdx === ni && expandedIdx === ni) expandedIdx = null;
            renderList();
          });
          editBtn.addEventListener('click', () => {
            expandedIdx = expandedIdx === ni ? null : ni;
            if (expandedIdx === ni && pitchExpandedIdx === ni) pitchExpandedIdx = null;
            renderList();
          });
          removeBtn.addEventListener('click', () => {
            chordNotes.splice(ni, 1);
            if (expandedIdx === ni) expandedIdx = null;
            else if (expandedIdx > ni) expandedIdx--;
            if (pitchExpandedIdx === ni) pitchExpandedIdx = null;
            else if (pitchExpandedIdx > ni) pitchExpandedIdx--;
            renderList();
          });
        });
      }

      renderList();

      // Pitch-bend sliders (chord-wide). The same semitone offset is applied
      // to every voice so the chord shape is preserved as it glides.
      const cBendSlider = modal.querySelector('#se-cbend');
      const cBendValEl  = modal.querySelector('#se-cbend-v');
      const cBendAtSlider = modal.querySelector('#se-cbend-at');
      const cBendAtValEl  = modal.querySelector('#se-cbend-at-v');
      cBendSlider.addEventListener('input', () => {
        chordBendSemitones = parseInt(cBendSlider.value) || 0;
        cBendValEl.textContent = (chordBendSemitones >= 0 ? '+' : '') + chordBendSemitones + ' st';
      });
      cBendAtSlider.addEventListener('input', () => {
        chordBendAt = parseInt(cBendAtSlider.value) || 100;
        cBendAtValEl.textContent = chordBendAt + '%';
      });

      modal.querySelector('.sm-preview').addEventListener('click', () => {
        const previewBend = (chordBendSemitones !== 0)
          ? { semitones: chordBendSemitones, atFraction: chordBendAt / 100 }
          : null;
        const size = chordNotes.length;
        // Synthesize the in-flight step state so chordVoiceParams can
        // apply the chord-wide pan override during preview, matching
        // what playback will hear once Apply commits.
        const previewStep = { chordPan };
        chordNotes.forEach(n => playNote(n.freq, paramsWithBend(chordVoiceParams(n.params, size, previewStep), previewBend)));
      });

      modal.querySelector('.sm-remove-step').addEventListener('click', () => {
        sequence.splice(stepIndex, 1);
        renderSequence();
        document.getElementById('save-btn').disabled = sequence.length === 0;
        overlay.remove();
      });

      modal.querySelector('.sm-apply').addEventListener('click', () => {
        const bendObj = (chordBendSemitones !== 0)
          ? { semitones: chordBendSemitones, atFraction: chordBendAt / 100 }
          : null;
        if (chordNotes.length === 0) {
          sequence.splice(stepIndex, 1);
        } else if (chordNotes.length === 1) {
          const n = chordNotes[0];
          const next = { freq: n.freq, label: n.label, cellIndex: n.cellIndex,
            sound: n.params.type, duration: chordDuration, subdivision: chordSubdivision, params: { ...n.params } };
          if (bendObj) next.bend = bendObj;
          // Single-voice "chord" — fold chord-wide pan into the voice's
          // own pan so the override survives even though the step is no
          // longer a chord. No-op at center.
          if (chordPan !== 0) next.params.pan = chordPan;
          sequence[stepIndex] = next;
        } else {
          const next = { chord: chordNotes.map(n => ({ ...n, params: { ...n.params } })),
            label: chordNotes.map(n => n.label).join('·'), duration: chordDuration, subdivision: chordSubdivision };
          if (bendObj) next.bend = bendObj;
          // Only carry chordPan on the step when non-zero — keeps the
          // saved-step shape minimal and lets chordVoiceParams skip
          // the override fast path at playback when the field is absent.
          if (chordPan !== 0) next.chordPan = chordPan;
          sequence[stepIndex] = next;
        }
        renderSequence();
        overlay.remove();
      });
    }

    // ---- Poly press session — sustain + drag-to-play + chord-on-multi --
    // Keeps every active sustain alive until the *last* pointer holding
    // it releases, supports dragging across cells with the pointer down
    // (each cell crossed starts its own sustain), and aggregates anything
    // that was pressed during a multi-touch session into a single chord
    // step at session-end.
    const _polySession = {
      pointerCells:    new Map(), // pointerId -> Set<cellIndex>
      cellSustains:    new Map(), // cellIndex -> sustain handle
      cellRefCount:    new Map(), // cellIndex -> # pointers currently holding it
      pressed:         new Map(), // cellIndex -> voice (snapshot at first touch)
      // Did *this* pointer's first pointerdown land on a cell? Drag-to-play
      // only fires while true, so a scroll gesture that began outside the
      // grid and happens to drag through cells won't pile up sustains and
      // jam the main thread (which on mobile reads as "scroll gets stuck").
      pointerStartedOnCell: new Map(), // pointerId -> bool
      endTimer:        null,
      suppressClickUntil: 0,
    };
    // Common pointerdown bookkeeping for sustained voices, shared between
    // regular cell presses and wrap-template auditions. The voiceStarter
    // callback is invoked exactly once (when the cell goes from 0 → 1
    // reference count) and should return a handle with .release() (or
    // null when no sustain is appropriate, e.g. sub-shaped wraps that
    // play sequentially). pressedSnapshot, when non-null, registers the
    // press in _polySession.pressed so multi-press chord-grouping picks
    // it up at session end; wraps pass null to stay out of grouping.
    function _polyStartSustain(cellIdx, pointerId, voiceStarter, pressedSnapshot) {
      let set = _polySession.pointerCells.get(pointerId);
      if (!set) { set = new Set(); _polySession.pointerCells.set(pointerId, set); }
      if (set.has(cellIdx)) return;
      set.add(cellIdx);
      // New press → cancel any pending session-finalize so consecutive
      // taps coalesce into the same chord-vs-single decision.
      if (_polySession.endTimer) {
        clearTimeout(_polySession.endTimer);
        _polySession.endTimer = null;
      }
      const refs = (_polySession.cellRefCount.get(cellIdx) || 0) + 1;
      _polySession.cellRefCount.set(cellIdx, refs);
      if (refs === 1) {
        let handle = null;
        try { handle = voiceStarter(); } catch (e) {}
        if (handle) {
          _polySession.cellSustains.set(cellIdx, handle);
          // Persistent press highlight — stays until refs hits 0 in
          // polyEndCellForPointer. Skipped when no handle (e.g. sub
          // wrap one-shot) since there's nothing held to highlight.
          cells[cellIdx]?.classList.add('sustaining');
        }
      }
      if (pressedSnapshot && !_polySession.pressed.has(cellIdx)) {
        _polySession.pressed.set(cellIdx, {
          ...pressedSnapshot,
          // Wall-clock window of the user's press. pressEnd is filled in
          // by polyEndCellForPointer when the cell's last pointer
          // releases; held-step duration is derived from the difference.
          pressStart: performance.now(),
          pressEnd: null,
        });
      }
    }
    function polyStartCell(cellIdx, pointerId, opts = {}) {
      if (!notes[cellIdx]) return;
      const note = notes[cellIdx];
      const params = { ...cellParams[cellIdx] };
      // Radial Tone overrides the cell's stored detune with a press-position-
      // derived value (see radialBendCents); subsequent pointermoves update
      // the live synth via the sustain handle.
      if (Number.isFinite(opts.detune)) params.detune = opts.detune;
      _polyStartSustain(cellIdx, pointerId,
        () => startSustainedNote(note.freq, params),
        {
          freq: note.freq,
          label: note.label,
          cellIndex: cellIdx,
          sound: params.type,
          params,
        }
      );
    }
    // Wrap-template press: each chord voice sustains for the duration of
    // the press, releasing on pointerup. Sub-shaped wraps fall back to a
    // one-shot (their voices are scheduled sequentially and don't have a
    // single sustain to hold).
    function polyStartWrapCell(cellIdx, pointerId, opts = {}) {
      if (!notes[cellIdx] || !wrapTemplate) return;
      _polyStartSustain(cellIdx, pointerId,
        () => startSustainedWrapOnCell(cellIdx, opts),
        null
      );
    }
    function polyEndCellForPointer(cellIdx, pointerId, opts = {}) {
      const set = _polySession.pointerCells.get(pointerId);
      if (!set || !set.has(cellIdx)) return;
      set.delete(cellIdx);
      const refs = (_polySession.cellRefCount.get(cellIdx) || 1) - 1;
      if (refs <= 0) {
        _polySession.cellRefCount.delete(cellIdx);
        const handle = _polySession.cellSustains.get(cellIdx);
        _polySession.cellSustains.delete(cellIdx);
        if (handle) { try { handle.release(); } catch (e) {} }
        cells[cellIdx]?.classList.remove('sustaining');
        // Restore the cell's static "Hz" label after a Radial Tone bend.
        // _radialBend itself is preserved until the click handler consumes
        // it (so the appended step gets the bent detune); only the
        // visible label resets.
        if (typeof resetCellFreqDisplay === 'function') resetCellFreqDisplay(cellIdx);
        // Record press-end so polyFinalizeSession (and the cell click
        // handler) can compute how long the user actually held the cell
        // and stamp that as the new step's duration.
        const entry = _polySession.pressed.get(cellIdx);
        if (entry && entry.pressEnd == null) entry.pressEnd = performance.now();
        // Drag hand-off: when this cell is being released mid-drag (the
        // pointer crossed into a new cell, not the final pointerup),
        // commit it as its own single-note step right now — duration
        // matches how long the finger actually sat on this cell. Without
        // this, every cell traversed in one drag would either be lost
        // (Keep on, last-press wins as a single-note) or collapsed into
        // one chord at session end (multi-press grouping).
        if (opts.handoff
            && entry
            && keepMode
            && !chordMode
            && !wrapTemplate
            && !stepMode
            && gridMode === 'sequencer'
            && selectedStepRefs.length === 0
            && notes[cellIdx]) {
          const baseParams = entry.params ? { ...entry.params } : { ...cellParams[cellIdx] };
          const heldMs = Math.max(0, (entry.pressEnd ?? performance.now()) - entry.pressStart);
          const heldParams = _holdAdjustedParams(baseParams, heldMs);
          addToSequence(_radialBendApplyToStep(cellIdx, {
            freq:       notes[cellIdx].freq,
            label:      notes[cellIdx].label,
            cellIndex:  cellIdx,
            sound:      heldParams.type,
            params:     heldParams,
            duration:   _holdStepDurationFromMs(heldMs),
            subdivision: stepSubdivision,
          }));
          // Drop the entry so polyFinalizeSession doesn't see it again
          // (would otherwise re-emit it as half of a chord at session
          // end). The final cell still commits via its own click event;
          // no suppression needed since each press window now becomes a
          // separate single-note step rather than a multi-voice chord.
          _polySession.pressed.delete(cellIdx);
        }
      } else {
        _polySession.cellRefCount.set(cellIdx, refs);
      }
    }
    // Translate a press window (ms) into step.duration units at the
    // current subdivision. Quick taps fall back to the user's chosen
    // noteLength so a stray short tap doesn't land as a sub-1-step
    // chip; longer holds round to whole step counts so the chip
    // renders cleanly. The resulting step is played in sequence with
    // a single attack-release whose `targetDur` matches the held time
    // — synth voices sustain through it, sample voices decay naturally
    // when their buffer ends.
    function _holdStepDurationFromMs(holdMs) {
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      const stepSec = (60 / bpm) * stepSubdivision;
      const heldSec = Math.max(0, holdMs) / 1000;
      // Quantize on: round to the NEAREST step (minimum 1), uniformly.
      // Off (default): keep the original "quick tap ⇒ noteLength, longer
      // hold ⇒ round UP" rule so users who relied on the upward bias
      // don't see a behavior change.
      if (quantizeHolds) {
        return Math.max(1, Math.round(heldSec / stepSec));
      }
      // Quick tap (under ~40% of a step's duration) → noteLength.
      if (heldSec < stepSec * 0.4) return noteLength;
      // Chip width = press time, rounded up to a whole step. The release
      // cap in _holdAdjustedParams keeps the audio playback within this
      // window so chip-width and audible-duration match.
      return Math.max(1, Math.ceil(heldSec / stepSec));
    }
    function _holdStepDurationForCell(cellIdx) {
      const entry = _polySession.pressed.get(cellIdx);
      if (!entry || entry.pressStart == null) return noteLength;
      const end = entry.pressEnd ?? performance.now();
      return _holdStepDurationFromMs(end - entry.pressStart);
    }
    function _holdStepDurationForVoice(voice) {
      if (!voice || voice.pressStart == null) return noteLength;
      const end = voice.pressEnd ?? performance.now();
      return _holdStepDurationFromMs(end - voice.pressStart);
    }
    function _holdMsForCell(cellIdx) {
      const entry = _polySession.pressed.get(cellIdx);
      if (!entry || entry.pressStart == null) return 0;
      const end = entry.pressEnd ?? performance.now();
      return Math.max(0, end - entry.pressStart);
    }
    function _holdMsForVoice(voice) {
      if (!voice || voice.pressStart == null) return 0;
      const end = voice.pressEnd ?? performance.now();
      return Math.max(0, end - voice.pressStart);
    }
    // For genuine holds (>200 ms), hard-cap release so the chip's audio
    // is dominated by the SUSTAINED tone, not the release fade. The
    // previous "balanced" caps left the chip mostly fading — the user
    // heard a brief peak then a long quiet decay, no real sustain.
    // With release pinned at 150 ms (or shorter if the user explicitly
    // chose less), preReleaseDur becomes (chipDuration - 150ms), so a
    // 1 s chip plays as ~850 ms of clearly sustained tone + 150 ms
    // snappy fade. Audio duration still matches chip width.
    function _holdAdjustedParams(baseParams, holdMs) {
      if (!baseParams || holdMs <= 200) return baseParams;
      const out = { ...baseParams };
      const original = out.release ?? 1400;
      out.release = Math.min(original, 150);
      return out;
    }
    function polyEndPointer(pointerId) {
      _polySession.pointerStartedOnCell.delete(pointerId);
      const set = _polySession.pointerCells.get(pointerId);
      if (!set) return;
      Array.from(set).forEach(idx => polyEndCellForPointer(idx, pointerId));
      _polySession.pointerCells.delete(pointerId);
      if (_polySession.pointerCells.size === 0) {
        // Defer finalize so multiple pointers releasing within a frame or
        // two collapse into one chord rather than racing each other.
        _polySession.endTimer = setTimeout(polyFinalizeSession, 60);
        // Cycling: the press's sound event is over now that the gesture's
        // last pointer has lifted — arm the next wrap for the next press.
        if (_wrapCyclePendingAdvance) {
          _wrapCyclePendingAdvance = false;
          advanceWrapCycle();
        }
      }
    }
    function polyShouldSuppressClick() {
      return performance.now() < _polySession.suppressClickUntil;
    }
    // Did the bubble-phase cell click handler already commit a step for
    // this gesture? Some platforms (notably long touch holds on iOS, and
    // fast pointer drift on desktop) drop the click event entirely after
    // a sustained press, leaving polyFinalizeSession as the only handler
    // that runs at session end. The flag lets that fallback add the
    // single-note step itself without double-adding when click DID fire.
    let _cellTapAdded = false;
    // Perform recorder: append the just-completed press (note or chord) to the
    // sequence with its real timing — a leading rest fills the silence since
    // the previous capture, then the note sized by how long it was held. All
    // lengths are integer units of the resolution grid (or 1/32 when quantize
    // is off), tracked on a cursor so notes land where they were played.
    function _performEmit(voices) {
      const live = (voices || []).filter(v => v && v.pressStart != null && Number.isFinite(v.freq));
      if (!live.length) return;
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      const unitSub = performQuantize ? performResolution : 0.125;
      const unitMs = Math.max(1, (60000 / bpm) * unitSub);
      let startMs = Infinity, endMs = -Infinity;
      live.forEach(v => { startMs = Math.min(startMs, v.pressStart); endMs = Math.max(endMs, v.pressEnd ?? performance.now()); });
      if (_performStartMs == null) {
        _performStartMs = startMs; _performEmittedUnits = 0;
        // Listen mode: recording begins on this first note — start the lanes so
        // the performance overdubs in time with the existing playback.
        try { if (typeof playSequence === 'function') playSequence(); } catch (e) {}
      }
      const desiredStart = Math.max(0, Math.round((startMs - _performStartMs) / unitMs));
      const restUnits = Math.max(0, desiredStart - _performEmittedUnits);
      snapshotForUndo('Perform');
      if (restUnits > 0) addToSequence({ freq: null, label: '—', cellIndex: null, duration: restUnits, subdivision: unitSub });
      const noteUnits = Math.max(1, Math.round((endMs - startMs) / unitMs));
      let step;
      if (live.length >= 2) {
        step = { chord: live.map(v => ({ freq: v.freq, label: v.label, cellIndex: v.cellIndex, sound: v.sound, params: v.params ? { ...v.params } : undefined })), label: live.map(v => v.label).join('·'), duration: noteUnits, subdivision: unitSub };
      } else {
        const v = live[0];
        step = { freq: v.freq, label: v.label, cellIndex: v.cellIndex, sound: v.sound, params: v.params ? { ...v.params } : undefined, duration: noteUnits, subdivision: unitSub };
      }
      addToSequence(step);
      _performEmittedUnits = desiredStart + noteUnits;
    }
    function polyFinalizeSession() {
      _polySession.endTimer = null;
      const voices = Array.from(_polySession.pressed.values());
      const tapAlreadyAdded = _cellTapAdded;
      _cellTapAdded = false;
      _polySession.pressed.clear();
      // Perform mode owns capture in default Sequencer mode: record the press
      // with timing instead of the normal Keep single/chord append below.
      if (performMode && gridMode === 'sequencer' && !wrapTemplate && !chordMode && !stepMode && selectedStepRefs.length === 0) {
        // During a count-in the layer is armed but not yet recording.
        if (!_performCountingIn) { try { _performEmit(voices); } catch (e) { console.warn('Perform capture failed', e); } }
        _polySession.suppressClickUntil = performance.now() + 250;
        return;
      }
      if (voices.length >= 2) {
        // Multi-press → emit a chord step. Suppress the per-cell click
        // handlers that fire right after each pointerup so they don't
        // also append individual notes on top of the chord. Capture is
        // gated by keepMode (off = audition only); the suppression
        // still fires either way so the bubble-phase click handlers
        // don't sneak in extra single-note appends.
        if (keepMode) {
          // Chord step duration follows the LONGEST-held voice so the
          // chord rings until the last finger lifts (matching how the
          // user actually heard it during the press).
          const chordHold = Math.max(
            ...voices.map(v => _holdStepDurationForVoice(v))
          );
          snapshotForUndo('Add chord');
          const chordStep = {
            chord: voices.map(v => ({
              freq: v.freq, label: v.label, cellIndex: v.cellIndex,
              sound: v.sound,
              params: v.params ? { ...v.params } : undefined,
            })),
            label: voices.map(v => v.label).join('·'),
            duration: chordHold,
            subdivision: stepSubdivision,
          };
          addToSequence(chordStep);
          maybePromptStepDiv(chordStep);
        }
        _polySession.suppressClickUntil = performance.now() + 250;
        return;
      }
      // Single-voice fallback — when the cell's click event didn't fire
      // (long hold + minor pointer drift, or iOS Safari's long-touch
      // click suppression), the user's tap was real and they expect a
      // step to land. Reproduce the click-handler's default add path
      // here, gated by the same conditions, when click hasn't already
      // committed it.
      // Variance edit: a sustained press without a click event still
      // counts as "next note pressed" for the variance pool.
      if (voices.length === 1 && _varianceEdit && _varianceEdit.stepRef
          && Number.isFinite(voices[0].cellIndex)) {
        if (_captureVarianceNote(voices[0].cellIndex)) return;
      }
      if (voices.length === 1 && !tapAlreadyAdded
          && keepMode
          && !chordMode
          && !wrapTemplate
          && !stepMode
          && gridMode === 'sequencer'
          && selectedStepRefs.length === 0) {
        const v = voices[0];
        const _heldMs = _holdMsForVoice(v);
        const _heldParams = _holdAdjustedParams(v.params ? { ...v.params } : undefined, _heldMs);
        const _newStep = _radialBendApplyToStep(v.cellIndex, {
          freq:       v.freq,
          label:      v.label,
          cellIndex:  v.cellIndex,
          sound:      v.sound,
          params:     _heldParams,
          duration:   _holdStepDurationForVoice(v),
          subdivision: stepSubdivision,
        });
        addToSequence(_newStep);
        maybePromptStepDiv(_newStep, { heldMs: _heldMs });
      }
    }
    document.addEventListener('pointerup',     (e) => polyEndPointer(e.pointerId));
    document.addEventListener('pointercancel', (e) => polyEndPointer(e.pointerId));

    // Drag-to-play / drag-handoff / live Radial Tone bend at the document
    // level. Per-cell pointermove can't drive these on touch because
    // touch input gets implicit pointer capture: every pointermove after
    // pointerdown fires on the originating cell, never on the cell the
    // finger drags onto. Hit-testing via elementFromPoint here always
    // resolves to the cell currently under the pointer regardless of
    // capture, so drag-to-play and the new hand-off both work on touch.
    document.addEventListener('pointermove', (e) => {
      if (!_polySession.pointerStartedOnCell.get(e.pointerId)) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target) return;
      if (target.closest('.cell-sound-select, .cell-edit-carrot')) return;
      const cell = target.closest('.cell');
      if (!cell) return;
      const i = cells.indexOf(cell);
      if (i < 0) return;

      const wrapActive = !!wrapTemplate;
      if (gridMode !== 'sequencer' && !wrapActive) return;

      const rect = cell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const xFrac = (e.clientX - rect.left) / rect.width;
      const yFrac = (e.clientY - rect.top)  / rect.height;
      const set = _polySession.pointerCells.get(e.pointerId);
      const isCurrentCell = !!(set && set.has(i));

      // Live Radial Tone bend on the cell currently being pressed.
      // Skipped for sample-typed cells — Tone.Sampler doesn't expose a
      // per-voice detune ramp, so live bends don't sound. (The initial
      // bend from press position is still baked into the attack
      // frequency at pointerdown for samples.)
      if (radialTone && isCurrentCell) {
        const cellType = cellParams[i]?.type;
        if (!isSampleType(cellType)) {
          const handle = _polySession.cellSustains.get(i);
          if (handle && typeof handle.setDetune === 'function') {
            const cents = radialBendCents(xFrac, yFrac);
            _radialBendUpdate(i, cents);
            handle.setDetune(cents);
            setCellFreqDisplayCents(i, cents);
          }
        }
        // Already on this cell — no hand-off needed regardless of
        // whether the bend was applied.
        return;
      }

      // Drag hand-off: once the pointer crosses into a *new* cell,
      // release every previously-held cell on this same pointer (each
      // committed as its own step via polyEndCellForPointer's handoff
      // path) and start the new one. The hit-test from elementFromPoint
      // already proves the pointer is inside this cell's rect, so no
      // additional inner-zone gate — the previous 25%–75% box made the
      // hand-off feel laggy (a press dragged horizontally near the top
      // or bottom of cells would never satisfy the y-axis check). With
      // a wrap active, route through polyStartWrapCell so the wrap
      // shape stays intact and re-auditions transposed to the new cell
      // as its first note. Radial Tone bend (initial press position)
      // is forwarded as opts.detune so the new cell starts at the bent
      // pitch.
      if (e.buttons === 0) return;
      if (isCurrentCell) return;
      if (xFrac < 0 || xFrac > 1 || yFrac < 0 || yFrac > 1) return;
      let opts = {};
      if (radialTone) {
        const cents = radialBendCents(xFrac, yFrac);
        _radialBendInit(i, cents);
        opts.detune = cents;
        setCellFreqDisplayCents(i, cents);
      } else {
        _radialBend.delete(i);
      }
      if (set) {
        Array.from(set).forEach(prevIdx => {
          if (prevIdx !== i) polyEndCellForPointer(prevIdx, e.pointerId, { handoff: true });
        });
      }
      if (wrapActive) {
        polyStartWrapCell(i, e.pointerId, opts);
      } else {
        polyStartCell(i, e.pointerId, opts);
      }
    });

    renderSavedSequences();

