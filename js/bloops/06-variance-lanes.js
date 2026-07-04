    // ---- Step variance (Random / Linear) ------------------------------
    // While a variance edit is active, _varianceEdit.stepRef points at
    // the step being edited and the next note presses are appended to
    // its variance.notes pool instead of being added as new steps.
    // The blinking chip click finalizes the edit.
    let _varianceEdit = null; // { stepRef, stepIdx } | null
    // Per-variance-pool shuffle queue. Keyed by the variance object on
    // a step so two different steps each cycle their own pool; entries
    // are auto-removed when the step (and its variance object) get
    // garbage-collected.
    const _varianceShuffleState = new WeakMap();

    // Pitch ramp dialog — picks a target note (as a semitone offset
    // from the step's pitch) and how far through the step duration
    // the bend should complete (atFraction). Saves to step.bend, the
    // same shape the playback path already honors.
    // Modal that lets the user define a wavetable's partial-amplitude
    // series (harmonics 1..8). Hands the resulting array to onApply
    // when the user accepts; cancelling closes without invoking the
    // callback so the prior tone setting stays in place.
    function showWavetableEditor(onApply) {
      if (document.querySelector('.wavetable-overlay')) return;
      // Seed from any existing wavetable mix already on cellParams[0];
      // fall back to a sine-dominant default.
      const seed = (Array.isArray(cellParams[0]?.wavetableMix) && cellParams[0].wavetableMix.length === 3)
        ? cellParams[0].wavetableMix.slice()
        : [1.0, 0.5, 0.3];
      const mix = seed.map(v => Math.max(0, Math.min(1, Number(v) || 0)));
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay wavetable-overlay';
      const modal = document.createElement('div');
      modal.className = 'pitch-ramp-modal';
      const labels = ['Sine', 'Sawtooth', 'Triangle'];
      const presets = {
        Sine:     [1.0, 0.0, 0.0],
        Saw:      [0.0, 1.0, 0.0],
        Tri:      [0.0, 0.0, 1.0],
        Hollow:   [0.0, 0.5, 1.0],
        Warm:     [1.0, 0.4, 0.6],
        Bright:   [0.4, 1.0, 0.2],
      };
      const presetButtons = Object.keys(presets).map(k =>
        `<button type="button" class="sm-wave" data-wt-preset="${k}">${k}</button>`
      ).join('');
      const sliderRows = labels.map((lbl, i) => `
        <div class="pr-param">
          <div class="pr-row">${lbl} <span class="pr-val" id="wt-v-${i}">${mix[i].toFixed(2)}</span></div>
          <input type="range" id="wt-${i}" min="0" max="1" step="0.01" value="${mix[i]}" />
        </div>
      `).join('');
      modal.innerHTML = `
        <div class="pr-title">Wavetable</div>
        <div class="pr-sub">Blend sine + sawtooth + triangle oscillators.</div>
        <div class="sm-waves" id="wt-presets">${presetButtons}</div>
        ${sliderRows}
        <div class="pr-footer">
          <button class="pr-cancel">Cancel</button>
          <button class="sm-wave" id="wt-test">▶ Test</button>
          <button class="pr-apply">Apply</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const sliders = labels.map((_, i) => modal.querySelector(`#wt-${i}`));
      const valEls  = labels.map((_, i) => modal.querySelector(`#wt-v-${i}`));
      const testBtn = modal.querySelector('#wt-test');
      // Test mode: snapshot current cellSounds + cellParams, apply
      // 'wavetable' + the modal's mix live to every cell. Sliders /
      // presets re-apply while test is on so each tweak retunes the
      // grid immediately. Test again or Cancel reverts; Apply commits.
      let testActive = false;
      let previousSnap = null;
      const captureSnap = () => ({
        cellSounds: cellSounds.slice(),
        cellParams: cellParams.map(p => ({ ...p })),
      });
      const refreshCellSelects = () => {
        cells.forEach((cell, idx) => {
          const sel = cell.querySelector('.cell-sound-select');
          if (sel) sel.value = cellSounds[idx];
        });
        if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels();
        if (typeof updateScaleBanner === 'function') updateScaleBanner();
      };
      const applyTestNow = () => {
        cellParams.forEach((p, i) => {
          p.type = 'wavetable';
          cellSounds[i] = 'wavetable';
          p.wavetableMix = mix.slice();
        });
        refreshCellSelects();
      };
      const revertTest = () => {
        if (!previousSnap) return;
        cellSounds = previousSnap.cellSounds.slice();
        cellParams = previousSnap.cellParams.map(p => ({ ...p }));
        refreshCellSelects();
        previousSnap = null;
      };
      const setTestActive = (active) => {
        testActive = active;
        testBtn.textContent = active ? '■ Stop' : '▶ Test';
        testBtn.classList.toggle('active', active);
      };
      testBtn.addEventListener('click', () => {
        if (testActive) {
          revertTest();
          setTestActive(false);
        } else {
          previousSnap = captureSnap();
          applyTestNow();
          setTestActive(true);
        }
      });
      const writeSlider = (i, v) => {
        mix[i] = v;
        sliders[i].value = String(v);
        valEls[i].textContent = v.toFixed(2);
        if (testActive) applyTestNow();
      };
      sliders.forEach((s, i) => {
        s.addEventListener('input', () => {
          const v = Math.max(0, Math.min(1, parseFloat(s.value) || 0));
          writeSlider(i, v);
        });
      });
      modal.querySelectorAll('[data-wt-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = presets[btn.dataset.wtPreset];
          if (!p) return;
          p.forEach((v, i) => writeSlider(i, v));
        });
      });
      const close = (opts) => {
        const keepTest = !!(opts && opts.keepTest);
        if (testActive && !keepTest) {
          revertTest();
          testActive = false;
        }
        try { overlay.remove(); } catch (e) {}
      };
      modal.querySelector('.pr-cancel').addEventListener('click', () => close());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      modal.querySelector('.pr-apply').addEventListener('click', () => {
        close({ keepTest: true });
        onApply(mix.slice());
      });
    }

    // Grain editor — modal that defines the grain voice's settings
    // (window size, overlap, playback rate). Mirrors the wavetable
    // modal in shape so the two "advanced" presets feel like one
    // family. Callback receives a settings object that the picker
    // copies onto every cell's params.
    function showGrainEditor(onApply) {
      if (document.querySelector('.grain-overlay')) return;
      const seed = {
        grainSize:    Number.isFinite(cellParams[0]?.grainSize)    ? cellParams[0].grainSize    : 0.1,
        grainOverlap: Number.isFinite(cellParams[0]?.grainOverlap) ? cellParams[0].grainOverlap : 0.05,
        grainRate:    Number.isFinite(cellParams[0]?.grainRate)    ? cellParams[0].grainRate    : 1.0,
      };
      const cur = { ...seed };
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay grain-overlay';
      const modal = document.createElement('div');
      modal.className = 'pitch-ramp-modal';
      const presets = {
        // [grainSize, overlap, rate]
        Smooth:   [0.20, 0.30, 1.0],
        Default:  [0.10, 0.05, 1.0],
        Pebbles:  [0.04, 0.10, 1.0],
        Slow:     [0.15, 0.10, 0.5],
        Fast:     [0.08, 0.05, 2.0],
        Reverse:  [0.10, 0.10, -1.0],
      };
      const presetButtons = Object.keys(presets).map(k =>
        `<button type="button" class="sm-wave" data-grain-preset="${k}">${k}</button>`
      ).join('');
      const grainInfo0 = sampleSamplers.get('grain');
      modal.innerHTML = `
        <div class="pr-title">Grain</div>
        <div class="pr-sub">Set grain window, overlap, and playback speed.</div>
        <div class="sm-waves" id="grain-presets">${presetButtons}</div>
        <div class="pr-param">
          <div class="pr-row">Source</div>
          <select id="g-source-sel" style="width:100%;padding:6px;background:#0a0a14;color:#cbd5e0;border:1px solid #2d2d3f;border-radius:6px;font-family:'Segoe UI',sans-serif;font-size:0.85rem;"></select>
          <div class="grain-record-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
            <button type="button" class="sm-wave" id="g-record">● Record</button>
            <select id="g-rec-ch" class="sm-wave" title="Record the mic in stereo or mono" style="padding:6px;background:#0a0a14;color:#cbd5e0;border:1px solid #2d2d3f;border-radius:6px;font-family:'Segoe UI',sans-serif;font-size:0.85rem;"><option value="2">Stereo</option><option value="1">Mono</option></select>
          </div>
        </div>
        <div class="pr-param">
          <div class="pr-row">Grain size <span class="pr-val" id="g-size-v">${cur.grainSize.toFixed(3)} s</span></div>
          <input type="range" id="g-size" min="0.01" max="0.5" step="0.005" value="${cur.grainSize}" />
        </div>
        <div class="pr-param">
          <div class="pr-row">Overlap <span class="pr-val" id="g-ov-v">${cur.grainOverlap.toFixed(2)}</span></div>
          <input type="range" id="g-ov" min="0" max="1" step="0.01" value="${cur.grainOverlap}" />
        </div>
        <div class="pr-param">
          <div class="pr-row">Playback rate <span class="pr-val" id="g-rate-v">${cur.grainRate.toFixed(2)}×</span></div>
          <input type="range" id="g-rate" min="-2" max="4" step="0.05" value="${cur.grainRate}" />
        </div>
        <div class="pr-footer">
          <button class="pr-cancel">Cancel</button>
          <button class="sm-wave" id="g-test">▶ Test</button>
          <button class="pr-apply">Apply</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const sizeS  = modal.querySelector('#g-size'),  sizeV  = modal.querySelector('#g-size-v');
      const ovS    = modal.querySelector('#g-ov'),    ovV    = modal.querySelector('#g-ov-v');
      const rateS  = modal.querySelector('#g-rate'),  rateV  = modal.querySelector('#g-rate-v');
      const testBtn = modal.querySelector('#g-test');
      // Test mode: snapshot the grid's current cellSounds + cellParams,
      // then apply 'sample:grain' + the modal's current settings live.
      // Adjusting any slider while test is on re-applies, so the user
      // hears every tweak without re-clicking. Cancelling the modal or
      // clicking Test again reverts to the snapshot. Apply commits the
      // settings (no revert needed — they're already on the grid).
      let testActive = false;
      let previousSnap = null;
      const captureSnap = () => ({
        cellSounds: cellSounds.slice(),
        cellParams: cellParams.map(p => ({ ...p })),
      });
      const refreshCellSelects = () => {
        cells.forEach((cell, idx) => {
          const sel = cell.querySelector('.cell-sound-select');
          if (sel) sel.value = cellSounds[idx];
        });
        if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels();
        if (typeof updateScaleBanner === 'function') updateScaleBanner();
      };
      const applyTestNow = () => {
        cellParams.forEach((p, i) => {
          p.type = 'sample:grain';
          cellSounds[i] = 'sample:grain';
          p.grainSize    = cur.grainSize;
          p.grainOverlap = cur.grainOverlap;
          p.grainRate    = cur.grainRate;
        });
        refreshCellSelects();
      };
      const revertTest = () => {
        if (!previousSnap) return;
        // Reassign the module-level arrays (let-bound) so playNote /
        // startSustainedNote read the restored values.
        cellSounds = previousSnap.cellSounds.slice();
        cellParams = previousSnap.cellParams.map(p => ({ ...p }));
        refreshCellSelects();
        previousSnap = null;
      };
      const setTestActive = (active) => {
        testActive = active;
        testBtn.textContent = active ? '■ Stop' : '▶ Test';
        testBtn.classList.toggle('active', active);
      };
      testBtn.addEventListener('click', () => {
        if (testActive) {
          revertTest();
          setTestActive(false);
        } else {
          previousSnap = captureSnap();
          applyTestNow();
          setTestActive(true);
        }
      });
      sizeS.addEventListener('input', () => {
        cur.grainSize = parseFloat(sizeS.value) || 0.1;
        sizeV.textContent = cur.grainSize.toFixed(3) + ' s';
        if (testActive) applyTestNow();
      });
      ovS.addEventListener('input', () => {
        cur.grainOverlap = parseFloat(ovS.value) || 0;
        ovV.textContent = cur.grainOverlap.toFixed(2);
        if (testActive) applyTestNow();
      });
      rateS.addEventListener('input', () => {
        cur.grainRate = parseFloat(rateS.value) || 1;
        rateV.textContent = cur.grainRate.toFixed(2) + '×';
        if (testActive) applyTestNow();
      });
      modal.querySelectorAll('[data-grain-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = presets[btn.dataset.grainPreset];
          if (!p) return;
          cur.grainSize = p[0]; sizeS.value = String(p[0]); sizeV.textContent = p[0].toFixed(3) + ' s';
          cur.grainOverlap = p[1]; ovS.value = String(p[1]); ovV.textContent = p[1].toFixed(2);
          cur.grainRate = p[2]; rateS.value = String(p[2]); rateV.textContent = p[2].toFixed(2) + '×';
          if (testActive) applyTestNow();
        });
      });
      // Source-selection wiring. The dropdown lists every available
      // grain source: the default Salamander A4, every loaded
      // sample-based instrument (and imported samples), the user's
      // custom recording if they made one, and an "Import…" entry
      // that triggers the file picker. Picking any option swaps
      // grainInfo.buffer so subsequent voices play from the new
      // sample. Test-mode listens to grainInfo.buffer so live
      // preview retunes immediately.
      const recordBtn = modal.querySelector('#g-record');
      const sourceSel = modal.querySelector('#g-source-sel');
      const DEFAULT_GRAIN_URL = 'https://tonejs.github.io/audio/salamander/A4.mp3';
      // Stash the user's recorded buffer separately so picking other
      // sources doesn't lose it; it's restored when the user picks
      // "Custom recording" from the dropdown.
      let recordedBuffer = (grainInfo0 && grainInfo0.userRecorded) ? grainInfo0.buffer : null;
      let recordedDur    = (grainInfo0 && grainInfo0.recordedDurSec) || 0;
      const populateSourceSelect = (selectedValue) => {
        sourceSel.innerHTML = '';
        const opts = [];
        opts.push({ value: '__default', label: 'Default (Piano A4)' });
        // Loaded sample-based instruments (each has a urls map). Skip
        // grain itself to avoid recursion. Drum kits get a "(kit)"
        // hint since playing them granularly chops the kit's mapped
        // hits into texture.
        sampleSamplers.forEach((info, id) => {
          if (id === 'grain' || !info.urls) return;
          const lbl = info.name + (info.drumKit ? ' (kit)' : info.imported ? ' (imported)' : '');
          opts.push({ value: id, label: lbl });
        });
        if (recordedBuffer) {
          opts.push({ value: '__recorded', label: `Custom recording (${recordedDur.toFixed(2)} s)` });
        }
        opts.push({ value: '__import', label: '— Import a file… —' });
        opts.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          sourceSel.appendChild(opt);
        });
        if (selectedValue) sourceSel.value = selectedValue;
      };
      const swapGrainBuffer = (urlOrBuffer) => {
        const grainInfo = sampleSamplers.get('grain');
        if (!grainInfo) return;
        try { grainInfo.buffer?.dispose?.(); } catch (e) {}
        if (urlOrBuffer instanceof Tone.ToneAudioBuffer) {
          grainInfo.buffer = urlOrBuffer;
        } else if (typeof urlOrBuffer === 'string') {
          grainInfo.buffer = new Tone.ToneAudioBuffer(urlOrBuffer);
        }
        // If test mode is on, re-apply settings now so the new buffer
        // gets reflected on cellParams (which playNote re-reads on
        // every voice fire — no per-cell change needed, but force a
        // refresh anyway for any UI bits that key off cellParams).
        if (testActive) applyTestNow();
      };
      const onSourceChange = () => {
        const v = sourceSel.value;
        if (v === '__default') {
          swapGrainBuffer(DEFAULT_GRAIN_URL);
        } else if (v === '__recorded') {
          if (recordedBuffer) {
            // Reuse the stashed recorded buffer rather than disposing.
            const grainInfo = sampleSamplers.get('grain');
            if (grainInfo) grainInfo.buffer = recordedBuffer;
            if (testActive) applyTestNow();
          }
        } else if (v === '__import') {
          if (typeof triggerImportSample !== 'function') return;
          triggerImportSample((id, name) => {
            // The new sample is now in sampleSamplers — repopulate
            // the dropdown so it shows up, and select it as the
            // active grain source.
            populateSourceSelect(id);
            onSourceChange();
          });
        } else {
          // sample-instrument id — load its first URL. Drum kits and
          // multi-note samplers have many entries; pick the first
          // for a representative buffer.
          const info = sampleSamplers.get(v);
          if (info && info.urls) {
            const noteKey = Object.keys(info.urls)[0];
            const file = info.urls[noteKey];
            const url = (info.baseUrl || '') + file;
            swapGrainBuffer(url);
          }
        }
      };
      // Resolve the initial dropdown selection from the existing
      // grainInfo.buffer state so reopening the modal lands on the
      // right entry.
      let initialSel = '__default';
      if (recordedBuffer) initialSel = '__recorded';
      populateSourceSelect(initialSel);
      sourceSel.addEventListener('change', onSourceChange);
      let recState = { recording: false, recorder: null, stream: null, chunks: [] };
      const setRecordBtn = (text, active) => {
        recordBtn.textContent = text;
        recordBtn.classList.toggle('active', !!active);
      };
      const stopMicStream = () => {
        try { recState.stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
        recState.stream = null;
      };
      recordBtn.addEventListener('click', async () => {
        if (recState.recording) {
          // Stop — onstop handler decodes the blob below.
          try { recState.recorder?.stop(); } catch (e) {}
          return;
        }
        if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          alert('Recording is not supported in this browser.');
          return;
        }
        try { await Tone.start(); } catch (e) {}
        let stream;
        try {
          // Sampling wants RAW STEREO, not voice-call processing: request 2 channels and
          // disable echo-cancel / noise-suppress / AGC (they degrade samples and often force
          // mono). Fall back to plain audio if the device rejects the constraints.
          const _chSel = document.getElementById('g-rec-ch');
          const _wantCh = (_chSel && _chSel.value === '1') ? 1 : 2;   // user-chosen mono / stereo
          const rawStereo = { channelCount: { ideal: _wantCh }, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
          try { stream = await navigator.mediaDevices.getUserMedia({ audio: rawStereo }); }
          catch (e2) { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        } catch (e) {
          alert('Could not access microphone: ' + (e.message || e));
          return;
        }
        recState.stream = stream;
        recState.chunks = [];
        const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
        const mimeType = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recState.recorder = recorder;
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recState.chunks.push(e.data); };
        recorder.onstop = async () => {
          recState.recording = false;
          setRecordBtn('● Record', false);
          stopMicStream();
          if (recState.chunks.length === 0) return;
          try {
            const blob = new Blob(recState.chunks, { type: recorder.mimeType || 'audio/webm' });
            const arrayBuffer = await blob.arrayBuffer();
            const audioCtx = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : new AudioContext();
            const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
            // Stash as the new recorded buffer; dropdown picks it up
            // on next populate. Don't dispose the previous recorded
            // buffer yet — the swap below will if it's still active.
            recordedBuffer = new Tone.ToneAudioBuffer(decoded);
            recordedDur    = decoded.duration;
            const grainInfo = sampleSamplers.get('grain');
            if (grainInfo) {
              grainInfo.userRecorded = true;
              grainInfo.recordedDurSec = decoded.duration;
            }
            populateSourceSelect('__recorded');
            onSourceChange();
          } catch (e) {
            console.warn('Grain recording decode failed', e);
          }
        };
        try {
          recorder.start();
          recState.recording = true;
          setRecordBtn('■ Stop', true);
          setSourceLabel('Recording…');
        } catch (e) {
          stopMicStream();
          alert('Recorder start failed: ' + (e.message || e));
        }
      });
      // (Reset is folded into the dropdown — the "Default (Piano A4)"
      // option does the same thing the old Reset button did.)
      // Cancel / dismiss path: revert any test-mode changes so the
      // grid lands on whatever it was before the modal opened.
      const close = (opts) => {
        const keepTest = !!(opts && opts.keepTest);
        if (testActive && !keepTest) {
          revertTest();
          testActive = false;
        }
        if (recState.recording) {
          try { recState.recorder?.stop(); } catch (e) {}
        }
        stopMicStream();
        try { overlay.remove(); } catch (e) {}
      };
      modal.querySelector('.pr-cancel').addEventListener('click', () => close());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      modal.querySelector('.pr-apply').addEventListener('click', () => {
        // Apply commits — settings already match the grid if test was
        // on; otherwise the picker's onApply callback will write them
        // now. Pass keepTest so close() doesn't revert.
        close({ keepTest: true });
        onApply({ ...cur });
      });
    }

    function showPitchRampDialog(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || step.isSub) return;
      if (step.freq == null && !Array.isArray(step.chord)) return;
      if (document.querySelector('.pitch-ramp-overlay')) return;
      const baseFreq = (Array.isArray(step.chord) && step.chord[0]) ? step.chord[0].freq : step.freq;
      const seedSemis = (step.bend && Number.isFinite(step.bend.semitones)) ? step.bend.semitones : 0;
      const seedAt    = (step.bend && Number.isFinite(step.bend.atFraction))
        ? Math.max(5, Math.min(100, Math.round(step.bend.atFraction * 100))) : 50;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay pitch-ramp-overlay';
      const modal = document.createElement('div');
      modal.className = 'pitch-ramp-modal';
      const targetLabel = (semis) => {
        if (typeof Tone === 'undefined' || !Number.isFinite(baseFreq)) return '—';
        try {
          const f = baseFreq * Math.pow(2, semis / 12);
          return Tone.Frequency(f).toNote();
        } catch (e) { return '—'; }
      };
      modal.innerHTML = `
        <div class="pr-title">Pitch ramp</div>
        <div class="pr-sub">From <strong>${(step.label || '?')}</strong> to <strong id="pr-target">${targetLabel(seedSemis)}</strong></div>
        <div class="pr-param">
          <div class="pr-row">Bend by <span class="pr-val" id="pr-bend-v">${seedSemis >= 0 ? '+' : ''}${seedSemis} st</span></div>
          <input type="range" id="pr-bend" min="-12" max="12" step="1" value="${seedSemis}" />
        </div>
        <div class="pr-param">
          <div class="pr-row">Reach target by <span class="pr-val" id="pr-at-v">${seedAt}%</span> of step</div>
          <input type="range" id="pr-at" min="5" max="100" step="5" value="${seedAt}" />
        </div>
        <div class="pr-actions">
          <button type="button" class="pr-btn pr-cancel">Cancel</button>
          <button type="button" class="pr-btn pr-clear">Clear ramp</button>
          <button type="button" class="pr-btn pr-save">Save</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const bendSlider = modal.querySelector('#pr-bend');
      const bendVal    = modal.querySelector('#pr-bend-v');
      const atSlider   = modal.querySelector('#pr-at');
      const atVal      = modal.querySelector('#pr-at-v');
      const targetEl   = modal.querySelector('#pr-target');
      bendSlider.addEventListener('input', () => {
        const v = parseInt(bendSlider.value, 10) || 0;
        bendVal.textContent = (v >= 0 ? '+' : '') + v + ' st';
        targetEl.textContent = targetLabel(v);
      });
      atSlider.addEventListener('input', () => {
        const v = parseInt(atSlider.value, 10) || 50;
        atVal.textContent = v + '%';
      });
      modal.querySelector('.pr-cancel').addEventListener('click', () => overlay.remove());
      modal.querySelector('.pr-clear').addEventListener('click', () => {
        snapshotForUndo('Clear pitch ramp');
        delete step.bend;
        renderSequence();
        if (typeof persistWorkspace === 'function') persistWorkspace();
        overlay.remove();
      });
      modal.querySelector('.pr-save').addEventListener('click', () => {
        const semis = parseInt(bendSlider.value, 10) || 0;
        const at    = Math.max(5, Math.min(100, parseInt(atSlider.value, 10) || 50));
        snapshotForUndo('Pitch ramp');
        if (semis === 0) {
          delete step.bend;
        } else {
          step.bend = { semitones: semis, atFraction: at / 100 };
        }
        renderSequence();
        if (typeof persistWorkspace === 'function') persistWorkspace();
        overlay.remove();
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }

    function showVarianceDialog(stepIndex) {
      const step = sequence[stepIndex];
      if (!step || step.isSub) return;
      // Variance works on every non-sub step type — single notes,
      // chords, and rests. Variants are still added as single notes
      // via cell presses; when picked they override the parent step
      // (chord array gets cleared, rest freq=null gets a real freq)
      // so any step in a lane can be made to mutate across loops.
      if (document.querySelector('.variance-overlay')) return;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay variance-overlay';
      const modal = document.createElement('div');
      modal.className = 'variance-modal';
      // Pre-fill the iteration count + random toggle from any
      // existing variance settings on the step so re-opening the
      // modal shows the user's prior choices.
      const existing = sequence[stepIndex] && sequence[stepIndex].variance;
      const seedIters = (existing && Number.isFinite(existing.itersPerVariant) && existing.itersPerVariant > 0)
        ? existing.itersPerVariant : 1;
      const seedRandomEach = !!(existing && existing.randomEachIter);
      modal.innerHTML = `
        <div class="vrn-title">Variance for this step</div>
        <label class="vrn-iters">
          Iterations per variance
          <input type="number" id="vrn-iters" min="1" max="64" step="1" value="${seedIters}" />
        </label>
        <label class="vrn-random">
          <input type="checkbox" id="vrn-random" ${seedRandomEach ? 'checked' : ''} />
          Random — pick a variant randomly each loop iteration (overrides Linear sequencing)
        </label>
        <div class="vrn-grid">
          <button type="button" class="vrn-opt" data-mode="random">Random</button>
          <button type="button" class="vrn-opt" data-mode="linear">Linear</button>
        </div>
        <div class="vrn-hint">Press grid notes after picking a mode to add alternates. Tap the blinking chip to finish.</div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const itersInput = modal.querySelector('#vrn-iters');
      const randomCb   = modal.querySelector('#vrn-random');
      modal.querySelectorAll('.vrn-opt').forEach(b => {
        b.addEventListener('click', () => {
          const baseMode = b.dataset.mode === 'linear' ? 'linear' : 'random';
          // Random checkbox forces random regardless of which mode
          // button the user picked; otherwise the button selection wins.
          const randomEach = !!(randomCb && randomCb.checked);
          const mode = randomEach ? 'random' : baseMode;
          let iters = parseInt((itersInput && itersInput.value) || '1', 10);
          if (!Number.isFinite(iters) || iters < 1) iters = 1;
          if (iters > 64) iters = 64;
          beginVarianceEdit(stepIndex, mode, { itersPerVariant: iters, randomEachIter: randomEach });
          overlay.remove();
        });
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }

    function beginVarianceEdit(stepIndex, mode, opts) {
      const step = sequence[stepIndex];
      if (!step || step.isSub) return;
      const itersPerVariant = (opts && Number.isFinite(opts.itersPerVariant) && opts.itersPerVariant > 0)
        ? Math.min(64, Math.floor(opts.itersPerVariant)) : 1;
      const randomEachIter = !!(opts && opts.randomEachIter);
      snapshotForUndo('Variance');
      // Auto-finalize any in-flight variance edit on another step
      // before starting a new one — without this the previous step's
      // pool stayed armed for cell-press capture even after the user
      // moved on, so a second variance attempt landed variants on the
      // wrong step (matching the user's "doesn't work for more than
      // one note in a lane" report).
      if (_varianceEdit && _varianceEdit.stepRef && _varianceEdit.stepRef !== step) {
        try { finalizeVarianceEdit(); } catch (e) { _varianceEdit = null; }
      }
      if (!step.variance || !Array.isArray(step.variance.notes)) {
        // Seed the pool with the step's current shape so the existing
        // sound is one of the variants from the start. Carry the
        // step's chord array if any (chord steps get chord-shaped
        // seeds), single-note params otherwise, or just freq=null for
        // rests. _resolveVariantStep below handles each case.
        const seed = (Array.isArray(step.chord) && step.chord.length > 0)
          ? {
              chord: step.chord.map(n => ({
                ...n,
                params: n.params ? { ...n.params } : undefined,
              })),
              label: step.label,
            }
          : {
              freq: step.freq,
              label: step.label,
              cellIndex: step.cellIndex,
              sound: step.sound || (step.params && step.params.type) || undefined,
              params: step.params ? { ...step.params } : (step.sound ? { type: step.sound } : undefined),
            };
        step.variance = {
          mode,
          itersPerVariant,
          randomEachIter,
          notes: [seed],
        };
      } else {
        step.variance.mode = mode;
        step.variance.itersPerVariant = itersPerVariant;
        step.variance.randomEachIter = randomEachIter;
      }
      _varianceEdit = { stepRef: step, stepIdx: stepIndex };
      renderSequence();
    }

    function finalizeVarianceEdit() {
      if (!_varianceEdit) return;
      const step = _varianceEdit.stepRef;
      _varianceEdit = null;
      // If only one variant ended up in the pool, drop the variance —
      // it'd be a no-op during playback and a misleading marker.
      if (step && step.variance && Array.isArray(step.variance.notes)
          && step.variance.notes.length <= 1) {
        delete step.variance;
      }
      renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Append a note to the active variance pool. Returns true if the
    // press was consumed; the caller skips its normal note-add logic
    // when this returns true.
    function _captureVarianceNote(noteCellIdx) {
      if (!_varianceEdit || !_varianceEdit.stepRef) return false;
      if (!Array.isArray(_varianceEdit.stepRef.variance?.notes)) return false;
      const i = noteCellIdx;
      if (!Array.isArray(notes) || !notes[i]) return false;
      const params = { ...cellParams[i] };
      _varianceEdit.stepRef.variance.notes.push({
        freq:      notes[i].freq,
        label:     notes[i].label,
        cellIndex: i,
        sound:     params.type,
        params,
      });
      // Audition the note for feedback so the user hears what they're
      // adding to the pool.
      try { playNote(notes[i].freq, params); } catch (e) {}
      renderSequence();
      return true;
    }

    // Pick the active variant of a step at a given iteration count.
    // Linear cycles, random samples uniformly. Returns the step
    // unchanged when there's no variance pool with multiple entries.
    function _resolveVariantStep(step, iter) {
      if (!step || !step.variance) return step;
      const arr = step.variance.notes;
      if (!Array.isArray(arr) || arr.length < 2) return step;
      const v = step.variance;
      // randomEachIter overrides the mode buttons — every iteration
      // picks at random from the pool. Otherwise:
      //   linear → cycle, holding each variant for itersPerVariant
      //            iterations before advancing.
      //   random → shuffle the pool, play through once, reshuffle.
      //            Plain uniform Math.random() per pick produced
      //            audible streaks of the same variant; shuffle
      //            guarantees each variant plays once per cycle and
      //            avoids picking the same variant twice in a row
      //            across the refill boundary.
      const itersPer = (Number.isFinite(v.itersPerVariant) && v.itersPerVariant > 0)
        ? Math.floor(v.itersPerVariant) : 1;
      let pickIdx;
      // Shuffle for random/shuffle modes (and randomEachIter); 'linear' cycles
      // forward and 'backward' cycles in reverse — both hold each variant for
      // itersPerVariant iterations. (Set wraps use these same modes.)
      const _useShuffle = v.randomEachIter || (v.mode !== 'linear' && v.mode !== 'backward');
      if (_useShuffle) {
        let state = _varianceShuffleState.get(v);
        if (!state || state.queue.length === 0) {
          const queue = arr.map((_, i) => i);
          for (let i = queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]];
          }
          // Swap the head of the new queue if it matches the previous
          // refill's last pick — keeps streaks from forming at the
          // boundary between cycles when the pool happens to shuffle
          // with the same index back-to-back.
          if (state && state.lastPick != null
              && queue[0] === state.lastPick
              && queue.length > 1) {
            [queue[0], queue[1]] = [queue[1], queue[0]];
          }
          state = { queue, lastPick: state ? state.lastPick : null };
          _varianceShuffleState.set(v, state);
        }
        pickIdx = state.queue.shift();
        state.lastPick = pickIdx;
      } else {
        const cycleStep = Math.floor(((iter | 0) / itersPer));
        let idx = ((cycleStep % arr.length) + arr.length) % arr.length;
        if (v.mode === 'backward') idx = arr.length - 1 - idx;   // cycle in reverse
        pickIdx = idx;
      }
      const variant = arr[pickIdx];
      if (!variant) return step;
      // Strip the parent step's chord array first — if the variant
      // is a single-note or rest the step should play that pitch (or
      // silence), not the original chord underneath. Chord variants
      // re-add their own chord below. Without this, a chord step's
      // variance would always sound the underlying chord regardless
      // of which variant the cycler picked.
      const base = { ...step };
      delete base.chord;
      // Chord variant — variant carries a chord[]. Drop the variant
      // shape on top of the bare step (with chord already cleared).
      if (Array.isArray(variant.chord) && variant.chord.length > 0) {
        return {
          ...base,
          chord: variant.chord.map(n => ({
            ...n,
            params: n.params ? { ...n.params } : undefined,
          })),
          label: variant.label != null ? variant.label : step.label,
          freq:  null,
          cellIndex: null,
          sound: undefined,
          params: undefined,
        };
      }
      // Single-note variant (the original path). Fall back to the
      // parent step's tone whenever the variant lacks its own — a
      // variant authored without a sibling sound/params would
      // otherwise silently play a sine on its iteration.
      const variantParams = variant.params
        ? { ...variant.params }
        : (step.params ? { ...step.params } : (variant.sound ? { type: variant.sound } : undefined));
      const variantSound = variant.sound
        || (variantParams && variantParams.type)
        || step.sound
        || (step.params && step.params.type);
      return {
        ...base,
        freq:      (variant.freq != null) ? variant.freq : step.freq,
        label:     (variant.label != null) ? variant.label : step.label,
        cellIndex: (variant.cellIndex != null) ? variant.cellIndex : step.cellIndex,
        sound:     variantSound,
        params:    variantParams,
      };
    }

    // ---- Poly-mode lane management ------------------------------------
    // Lane name = letter A..Z, A2..Z2, … so we never run out at 8×8 grids.
    function _laneName(idx) {
      const a = idx % 26;
      const cycle = Math.floor(idx / 26);
      return String.fromCharCode(65 + a) + (cycle > 0 ? String(cycle + 1) : '');
    }
    // Deep-clone an FX state object (globalFx or lane.fx). Preserves
    // numeric / boolean fields and the fxOrder array. Used when seeding
    // a new lane's fx from the current globalFx (so existing tuning
    // carries forward to per-lane edit) or when persisting a workspace
    // snapshot.
    function _cloneFxState(src) {
      if (!src) return null;
      try { return JSON.parse(JSON.stringify(src)); }
      catch (e) { return null; }
    }
    function _makeLane(idx, steps = []) {
      return {
        name: _laneName(idx),
        steps,
        muted: false,
        solo: false,
        // Portamento — pitch glide (ms) between this lane's consecutive single notes (0 = off).
        portamento: 0,
        // Drift state machine:
        //   A: driftMs=0,  driftLocked=false  → button "Drift"
        //   B: driftMs>0,  driftLocked=false  → button "Lock"   (active drifting)
        //   C: driftMs=0,  driftLocked=true   → button "Reset"  (offset frozen)
        // driftOffsetSec preserves the locked accumulated offset so the
        // lane starts at the same lag on the next playback.
        driftMs: 0,
        driftLocked: false,
        driftOffsetSec: 0,
        // Lane mix — applied via a dedicated Volume → Panner chain
        // (built lazily by getLaneBus). pan: -100..100, volume: 0..100.
        pan: 0,
        volume: 100,
        // Slip — shifts every step in this lane's fire time forward
        // (positive) or backward (negative) by `slip` percent of each
        // step's duration. Doesn't change the cadence, only the
        // attack offset within the slot. -50..50.
        slip: 0,
        // Display: when true, lane chips render as a single
        // horizontal-scroll row; when false (default) they wrap
        // vertically so every step is visible at once.
        collapsed: false,
        // Per-lane voice — the cell-grid configuration that defines
        // this lane's instrument (cell sound assignments, scale, root
        // / octave, palette, master tuning). When the lane is the
        // active lane its voice is mirrored into the global voice
        // state (cellSounds / palette / etc) so the existing single-
        // grid code path keeps working unchanged. Switching lanes
        // swaps voices via _captureVoiceGlobals / _applyVoiceToGlobals.
        // Initialised lazily on first activate so a freshly-built
        // lane inherits whatever voice is currently in the globals.
        voice: null,
        // Per-lane FX wet levels. Each entry is 0-100 — the lazy lane FX
        // graph in applyLaneSends maps these to a per-lane Tone FX node
        // built only when non-zero (disposed when returned to zero), so
        // lanes with no FX dialed in cost nothing beyond volume + panner.
        // Seeded from globalFx so any tuning carries forward as the lane's
        // starting point.
        sends: (typeof _defaultLaneSends === 'function') ? _defaultLaneSends() : null,
        // Grid vs. Graph (fluid XY pad) is per-lane so the user can
        // keep one lane on the cell grid for chord work and another on
        // the XY pad for pitch-bend gestures. Mirrored into the global
        // fluidGridMode whenever this lane is active.
        fluidGridMode: false,
        // Bloom (generative ambient) mode + its config. `ambient` is built
        // lazily by 17-ambient.js on first entry so a fresh lane stays light.
        ambientMode: false,
        ambient: null,
        // TEXT (speech synthesis) mode + its config, built lazily by 18-text.js.
        textMode: false,
        text: null,
        // Seq (sequence-bank clip launcher) mode — no per-lane config; the pad
        // reads the shared savedSequences bank. See 19-seq-pad.js.
        seqMode: false,
        // Shape (radial wheel) mode + its config, built lazily by 21-shape.js.
        shapeMode: false,
        shape: null,
        // Piano mode — Grid functionality with a piano-keyboard layout (no extra
        // config; reuses the grid cells + steps). See body.piano-mode CSS.
        pianoMode: false,
        // Whether this lane's shape is sent to the Mix "Master Shape" overview.
        sentToMaster: false,
      };
    }
    // Snapshot the currently-mirrored voice globals into a plain object
    // suitable for storing on a lane. Deep-clones the cell arrays so
    // future grid mutations don't bleed across lanes.
    function _captureVoiceGlobals() {
      const v = {
        cellSounds: Array.isArray(cellSounds) ? [...cellSounds] : [],
        cellParams: Array.isArray(cellParams) ? cellParams.map(p => ({ ...p })) : [],
        scale:      currentScale,
        palette:    Array.isArray(palette)     ? [...palette]     : [...DEFAULT_PALETTE],
        chipPalette: Array.isArray(chipPalette) ? [...chipPalette] : [...DEFAULT_PALETTE],
        rootIdx,
        baseOctave,
        octaveCount,
        masterFreqA,
        restColor,
      };
      // While a step-select grid preview is loaded, the live globals hold the
      // step's transient tone/key. Capture the REAL pre-preview tone + key
      // instead so the preview never bleeds into a lane voice or a saved
      // project. (_stepPreviewSnap lives in 05, loaded before this file.)
      if (typeof _stepPreviewSnap !== 'undefined' && _stepPreviewSnap) {
        v.cellSounds = [..._stepPreviewSnap.cellSounds];
        v.cellParams = _stepPreviewSnap.cellParams.map(p => ({ ...p }));
        v.scale      = _stepPreviewSnap.scale;
        v.rootIdx    = _stepPreviewSnap.rootIdx;
      }
      return v;
    }
    // Load a previously-captured voice into the globals. Triggers a
    // grid rebuild + UI selector sync so the visible cell row matches
    // the new active lane. Tolerant of partial / stale snapshots —
    // missing fields fall back to current globals.
    function _applyVoiceToGlobals(voice) {
      if (!voice || typeof voice !== 'object') return;
      if (Number.isFinite(voice.rootIdx))     rootIdx     = voice.rootIdx;
      if (Number.isFinite(voice.baseOctave))  baseOctave  = voice.baseOctave;
      if (Number.isFinite(voice.octaveCount)) octaveCount = Math.max(1, Math.min(3, voice.octaveCount));
      if (Number.isFinite(voice.masterFreqA)) masterFreqA = voice.masterFreqA;
      if (typeof voice.scale === 'string' && SCALES[voice.scale]) currentScale = voice.scale;
      if (Array.isArray(voice.palette)     && voice.palette.length === 12) palette     = [...voice.palette];
      if (Array.isArray(voice.chipPalette) && voice.chipPalette.length === palette.length) chipPalette = [...voice.chipPalette];
      else chipPalette = [...palette];
      if (typeof voice.restColor === 'string') { restColor = voice.restColor; applyRestColor(); }
      // UI selectors — keep them in lockstep with the swapped voice
      // so the dropdowns / range inputs reflect the new lane's state
      // immediately, without waiting for the next applyProjectSnapshot.
      const rootSel  = document.getElementById('root-select');
      const octRange = document.getElementById('octave-range-select');
      const freqSl   = document.getElementById('master-freq-slider');
      const freqIn   = document.getElementById('master-freq-input');
      const scaleSel = document.getElementById('scale-select');
      if (rootSel)  rootSel.value  = String(rootIdx);
      if (octRange) octRange.value = `${baseOctave}x${octaveCount}`;
      if (freqSl)   freqSl.value   = String(masterFreqA);
      if (freqIn)   freqIn.value   = String(masterFreqA);
      if (scaleSel) scaleSel.value = currentScale;
      // Rebuild the cell grid with the new octaveCount / palette /
      // scale, then apply the captured per-cell sound + param arrays
      // when their lengths line up with the freshly-built grid.
      rebuildGrid();
      if (Array.isArray(voice.cellSounds) && voice.cellSounds.length === cellSounds.length
          && Array.isArray(voice.cellParams) && voice.cellParams.length === cellParams.length) {
        cellSounds = [...voice.cellSounds];
        cellParams = voice.cellParams.map(p => ({ ...p }));
        cells.forEach((cell, idx) => {
          const sel = cell.querySelector('.cell-sound-select');
          if (sel) sel.value = cellSounds[idx];
        });
        refreshAllCellFreqLabels();
        updateScaleBanner();
      }
    }
    // Lazy per-lane audio chain — Volume → Panner → [active FX in series] →
    // masterBus. The FX chain is empty at lane creation: each FX node is
    // built only when its lane.sends[name] crosses above 0, and disposed
    // again when it returns to 0. A lane with every FX at 0 = zero FX
    // nodes = zero CPU beyond the volume/panner pair. Tone's wet/dry is
    // used inside each FX node so the lane.sends value (0–100) maps to
    // the FX's wet parameter; chained in series in FX_NAMES order (or
    // lane.fx.fxOrder if the user has reordered).
    function getLaneBus(laneIdx) {
      const lane = lanes[laneIdx];
      if (!lane) return masterBus;
      if (lane._volume) return lane._volume;
      if (!lane.sends) lane.sends = _defaultLaneSends();
      const panNorm = Math.max(-1, Math.min(1, (lane.pan || 0) / 100));
      const volNorm = Math.max(0, Math.min(1, (Number.isFinite(lane.volume) ? lane.volume : 100) / 100));
      const volDb = volNorm <= 0 ? -Infinity : Tone.gainToDb(volNorm);
      const panner = new Tone.Panner(panNorm);
      // Tone.Panner forces a mono input, which downmixes any upstream STEREO
      // signal (per-note/per-voice pans — e.g. Bloom's Space spread, panned
      // chord voices) to mono before re-panning, collapsing the stereo image.
      // Force the underlying node to accept stereo so those per-note pans
      // survive through the lane bus.
      try { panner.channelCount = 2; panner.channelCountMode = 'max'; } catch (e) {}
      try { if (panner._panner) { panner._panner.channelCount = 2; panner._panner.channelCountMode = 'max'; } } catch (e) {}
      const volume = new Tone.Volume(volDb);
      volume.connect(panner);
      // → laneSumBus (count-compensated) → masterBus, so stacking lanes doesn't
      // run away (live grid taps via globalSendTap stay on masterBus, full level).
      panner.connect(typeof laneSumBus !== 'undefined' ? laneSumBus : masterBus);
      lane._panner    = panner;
      lane._volume    = volume;
      lane._fxNodes   = {};   // name → Tone FX node, only entries with non-zero send exist
      lane._fxChain   = [];   // [{ name, node }] in current signal-flow order
      // Sync any non-zero sends now so lanes restored from saved state
      // come up with their FX chain already populated.
      applyLaneSends(lane);
      return lane._volume;
    }
    // Default per-lane sends. Seeded from globalFx mix values so users
    // who had global FX dialed in before the send/return refactor keep
    // hearing those same effects on each lane (now as per-lane send
    // levels). New lanes inherit the user's current globalFx defaults.
    function _defaultLaneSends() {
      const out = {};
      FX_NAMES.forEach(name => {
        const v = (globalFx && Number.isFinite(globalFx[name])) ? globalFx[name] : 0;
        out[name] = Math.max(0, Math.min(100, v));
      });
      return out;
    }
    // All-off FX sends — a freshly *added* lane starts dry, ignoring whatever
    // FX the active lane / globalFx currently has dialed in (so a new lane
    // shares no effects state with its neighbors).
    function _zeroLaneSends() {
      const out = {};
      FX_NAMES.forEach(name => { out[name] = 0; });
      return out;
    }
    // The canonical "fresh grid" voice — default sawtooth tones, chromatic
    // scale, C root, one octave at A=440, default palette. A newly *added*
    // lane gets this instead of inheriting the active lane's sounds / scale /
    // root, so each new lane is an independent blank slate.
    function _defaultVoice() {
      const oc = 1;                       // default octave count
      const cellCount = 12 * oc;
      const mk = (typeof _defaultCellParams === 'function')
        ? _defaultCellParams
        : () => ({ type: 'sawtooth' });
      const params = [];
      for (let i = 0; i < cellCount; i++) params.push(mk());
      const pal = (typeof DEFAULT_PALETTE !== 'undefined') ? [...DEFAULT_PALETTE] : [...palette];
      return {
        cellSounds: params.map(p => p.type || 'sawtooth'),
        cellParams: params,
        scale: 'chromatic',
        palette: pal,
        chipPalette: [...pal],
        rootIdx: 0,
        baseOctave: 4,
        octaveCount: oc,
        masterFreqA: 440,
        restColor: (typeof DEFAULT_REST_COLOR !== 'undefined') ? DEFAULT_REST_COLOR : restColor,
      };
    }
    // Pull send levels out of a persisted lane object. Handles three
    // generations of state: new `sends`, mid-refactor `fx`, and
    // pre-per-lane (no field at all).
    function _migrateLaneSends(l) {
      if (l && l.sends && typeof l.sends === 'object') {
        const out = {};
        FX_NAMES.forEach(name => {
          const v = Number(l.sends[name]);
          out[name] = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
        });
        return out;
      }
      if (l && l.fx && typeof l.fx === 'object') {
        const out = {};
        FX_NAMES.forEach(name => {
          const v = Number(l.fx[name]);
          out[name] = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
        });
        return out;
      }
      return _defaultLaneSends();
    }
    // Build one per-lane FX node on demand. Wet starts at 0; applyLaneSends
    // pushes the real value immediately after. LFO-driven nodes get an
    // explicit .start() — Tremolo/Chorus/AutoFilter/AutoPanner need it to
    // begin oscillating, same as the master nodes do.
    function _buildOneLaneFxNode(name) {
      try {
        switch (name) {
          case 'reverb':     return new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0 });
          case 'delay':      return new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.4, wet: 0 });
          case 'distortion': return new Tone.Distortion({ distortion: 0.4, wet: 0, oversample: '4x' });
          case 'chorus':     { const n = new Tone.Chorus({ frequency: 4, delayTime: 3.5, depth: 0.7, feedback: 0.1, wet: 0 }); try { n.start(); } catch (e) {} return n; }
          case 'vibrato':    return new Tone.Vibrato({ frequency: 5, depth: 0.3, wet: 0 });
          case 'tremolo':    { const n = new Tone.Tremolo({ frequency: 5, depth: 0.7, wet: 0 }); try { n.start(); } catch (e) {} return n; }
          case 'phaser':     return new Tone.Phaser({ frequency: 0.5, octaves: 3, baseFrequency: 350, wet: 0 });
          case 'autoFilter': { const n = new Tone.AutoFilter({ frequency: 1, depth: 1, baseFrequency: 200, octaves: 2.6, wet: 0 }); try { n.start(); } catch (e) {} return n; }
          case 'pingPong':   return new Tone.PingPongDelay({ delayTime: 0.25, feedback: 0.3, wet: 0 });
          case 'autoPan':    { const n = new Tone.AutoPanner({ frequency: 1, depth: 1, wet: 0 }); try { n.start(); } catch (e) {} return n; }
        }
      } catch (e) { console.warn('[lane-fx] build failed for', name, e); }
      return null;
    }
    // Find the splice index that keeps the lane chain ordered by FX_NAMES
    // (or lane.fx.fxOrder when the user has reordered). Lazy insert/remove
    // walks this position rather than rebuilding the whole order array.
    function _laneFxInsertPos(lane, chain, name) {
      const order = (lane && lane.fx && Array.isArray(lane.fx.fxOrder) && lane.fx.fxOrder.length === FX_NAMES.length)
        ? lane.fx.fxOrder
        : FX_NAMES;
      const targetIdx = order.indexOf(name);
      if (targetIdx < 0) return chain.length;
      for (let i = 0; i < chain.length; i++) {
        if (order.indexOf(chain[i].name) > targetIdx) return i;
      }
      return chain.length;
    }
    // Re-wire panner → chain[0] → chain[1] → … → masterBus. Called once
    // per applyLaneSends invocation that changed the chain (insert/remove).
    // Param-only updates skip this and just push values to existing nodes.
    function _wireLaneFxChain(lane) {
      if (!lane || !lane._panner) return;
      try { lane._panner.disconnect(); } catch (e) {}
      lane._fxChain.forEach(({ node }) => { try { node.disconnect(); } catch (e) {} });
      let upstream = lane._panner;
      for (const { node } of lane._fxChain) {
        try { upstream.connect(node); } catch (e) {}
        upstream = node;
      }
      // Lane chain tail → laneSumBus (count-compensated) → masterBus.
      try { upstream.connect(typeof laneSumBus !== 'undefined' ? laneSumBus : masterBus); } catch (e) {}
    }
    // Push shape params + wet to one lane FX node. FX shape (size, freq,
    // depth, etc.) reads from globalFx — a single project-wide character
    // shared across lanes. Wet reads from lane.sends[name] — the per-lane
    // amount. Per-lane shape overrides via lane.fx are a future iteration.
    // Apply lane FX node params. `fxOverride` lets the caller supply a
    // per-item / per-snapshot FX shape (e.g. the item.globalFx the
    // offline export wants) instead of always reading the live
    // workspace globalFx. Without this, every per-lane FX node in
    // the export ends up sharing the same shape params regardless of
    // which item's globalFx the lane was saved with.
    function _applyLaneFxNodeParams(name, node, lane, fxOverride) {
      if (!node || !lane) return;
      const wet = Math.max(0, Math.min(1, (lane.sends[name] || 0) / 100));
      const fx = (fxOverride && typeof fxOverride === 'object') ? fxOverride : globalFx;
      try {
        switch (name) {
          case 'reverb':
            if (Number.isFinite(fx.reverbSize)) node.roomSize.value  = Math.max(0, Math.min(0.99, fx.reverbSize / 100));
            if (Number.isFinite(fx.reverbTone)) node.dampening.value = 500 + Math.max(0, Math.min(100, fx.reverbTone)) * 95;
            node.wet.value       = wet;
            break;
          case 'delay':
            if (Number.isFinite(fx.delayTime))     node.delayTime.value = Math.max(0.001, (fx.delayTime || 0) / 1000);
            if (Number.isFinite(fx.delayFeedback)) node.feedback.value  = Math.max(0, Math.min(0.95, fx.delayFeedback / 100));
            node.wet.value       = wet;
            break;
          case 'distortion':
            node.distortion = 0.4;
            node.wet.value  = wet;
            break;
          case 'chorus':
            if (Number.isFinite(fx.chorusFreq))  node.frequency.value = Math.max(0.01, fx.chorusFreq);
            if (Number.isFinite(fx.chorusDepth)) node.depth           = Math.max(0, Math.min(1, fx.chorusDepth / 100));
            node.wet.value       = wet;
            break;
          case 'vibrato':
            if (Number.isFinite(fx.vibratoFreq))  node.frequency.value = Math.max(0.01, fx.vibratoFreq);
            if (Number.isFinite(fx.vibratoDepth)) node.depth.value     = Math.max(0, Math.min(1, fx.vibratoDepth / 100));
            node.wet.value       = wet;
            break;
          case 'tremolo':
            if (Number.isFinite(fx.tremoloFreq))  node.frequency.value = Math.max(0.01, fx.tremoloFreq);
            if (Number.isFinite(fx.tremoloDepth)) node.depth.value     = Math.max(0, Math.min(1, fx.tremoloDepth / 100));
            node.wet.value       = wet;
            break;
          case 'phaser':
            if (Number.isFinite(fx.phaserFreq))    node.frequency.value = Math.max(0.01, fx.phaserFreq);
            if (Number.isFinite(fx.phaserOctaves)) node.octaves         = Math.max(1, Math.min(7, fx.phaserOctaves));
            node.wet.value       = wet;
            break;
          case 'autoFilter':
            if (Number.isFinite(fx.autoFilterFreq))     node.frequency.value = Math.max(0.01, fx.autoFilterFreq);
            if (Number.isFinite(fx.autoFilterDepth))    node.depth.value     = Math.max(0, Math.min(1, fx.autoFilterDepth / 100));
            if (Number.isFinite(fx.autoFilterBaseFreq)) node.baseFrequency   = Math.max(20, fx.autoFilterBaseFreq);
            node.wet.value       = wet;
            break;
          case 'pingPong':
            if (Number.isFinite(fx.pingPongTime))     node.delayTime.value = Math.max(0.001, (fx.pingPongTime || 0) / 1000);
            if (Number.isFinite(fx.pingPongFeedback)) node.feedback.value  = Math.max(0, Math.min(0.95, fx.pingPongFeedback / 100));
            node.wet.value       = wet;
            break;
          case 'autoPan':
            if (Number.isFinite(fx.autoPanFreq))  node.frequency.value = Math.max(0.01, fx.autoPanFreq);
            if (Number.isFinite(fx.autoPanDepth)) node.depth.value     = Math.max(0, Math.min(1, fx.autoPanDepth / 100));
            node.wet.value       = wet;
            break;
        }
      } catch (e) {}
    }
    // Lazy/teardown sync from lane.sends to the audio graph. Walks every
    // FX name and reconciles:
    //   send>0 + no node → build node + splice into chain
    //   send=0 + node    → remove from chain + dispose
    //   send>0 + node    → push current params (wet + shape)
    //   send=0 + no node → no-op (zero cost)
    // A lane with every send at 0 holds zero FX nodes; "per-lane FX without
    // performance impact when not used" is enforced at this layer.
    function applyLaneSends(lane) {
      if (!lane || !lane.sends) return;
      if (!lane._fxNodes) lane._fxNodes = {};
      if (!lane._fxChain) lane._fxChain = [];
      let chainChanged = false;
      for (const name of FX_NAMES) {
        const sendVal = Math.max(0, Math.min(100, lane.sends[name] || 0));
        const existing = lane._fxNodes[name];
        if (sendVal > 0 && !existing) {
          const node = _buildOneLaneFxNode(name);
          if (!node) continue;
          lane._fxNodes[name] = node;
          const pos = _laneFxInsertPos(lane, lane._fxChain, name);
          lane._fxChain.splice(pos, 0, { name, node });
          _applyLaneFxNodeParams(name, node, lane);
          chainChanged = true;
        } else if (sendVal === 0 && existing) {
          const idx = lane._fxChain.findIndex(e => e.name === name);
          if (idx >= 0) lane._fxChain.splice(idx, 1);
          try { existing.disconnect(); } catch (e) {}
          try { existing.dispose(); } catch (e) {}
          delete lane._fxNodes[name];
          chainChanged = true;
        } else if (existing) {
          _applyLaneFxNodeParams(name, existing, lane);
        }
      }
      if (chainChanged) _wireLaneFxChain(lane);
    }
    // applyLaneFx is retained as an alias so any call site that reaches
    // for the "FX" name (rather than "sends") works without churn.
    const applyLaneFx = applyLaneSends;
    // Per-lane Tone.Sampler instances bound to each lane's bus, so
    // sample-based voices flow through the lane's pan / volume instead
    // of the global sampler that connects straight to masterBus.
    function getOrCreateLaneSampler(laneIdx, sampleId) {
      const lane = lanes[laneIdx];
      if (!lane) return null;
      if (!lane._samplers) lane._samplers = new Map();
      if (lane._samplers.has(sampleId)) return lane._samplers.get(sampleId);
      const info = sampleSamplers.get(sampleId);
      if (!info || !info.urls) return null;
      try {
        const samp = new Tone.Sampler({
          urls: info.urls,
          baseUrl: info.baseUrl,
          release: 1,
        }).connect(getLaneBus(laneIdx));
        // Lift this per-lane sampler to synth level, same as the single-lane
        // path does via getSampleEntry. Without this, samples played in
        // Poly / multi-lane mode got NO volume boost at all and sat even
        // quieter than the (already boosted) single-lane samples.
        if (typeof _boostSampler === 'function') _boostSampler(samp);
        lane._samplers.set(sampleId, samp);
        return samp;
      } catch (e) {
        console.warn('Failed to create per-lane sampler', sampleId, e);
        return null;
      }
    }
    function disposeLaneAudio(lane) {
      if (!lane) return;
      if (lane._samplers) {
        lane._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
        lane._samplers = null;
      }
      if (lane._volume) { try { lane._volume.dispose(); } catch (e) {} lane._volume = null; }
      if (lane._panner) { try { lane._panner.dispose(); } catch (e) {} lane._panner = null; }
      // Per-lane FX nodes built lazily by applyLaneSends. Dispose every
      // active one so a lane swap or project load doesn't leak Tone nodes.
      if (lane._fxNodes) {
        Object.values(lane._fxNodes).forEach(n => { try { n.disconnect(); } catch (e) {} try { n.dispose(); } catch (e) {} });
        lane._fxNodes = null;
      }
      lane._fxChain = null;
    }
    function disposeAllLaneAudio(arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(disposeLaneAudio);
    }
    // Sync `sequence` with the active lane so all existing add/edit
    // code (addToSequence, click handlers, undo, etc.) continues to
    // operate on the lane the user has selected. Lanes hold their own
    // step arrays — assigning to `sequence = laneSteps` aliases by
    // reference, so mutations to `sequence` are visible on the lane.
    function _aliasSequenceToActiveLane() {
      if (lanes.length === 0) return;
      if (activeLaneIdx < 0 || activeLaneIdx >= lanes.length) activeLaneIdx = 0;
      sequence = lanes[activeLaneIdx].steps;
    }
    function _resizeLanesToGridRows() {
      const target = Math.max(1, gridRows | 0);
      while (lanes.length < target) {
        // Grid-rows-added lanes get their OWN default voice up front (not the
        // lazy voice:null that would inherit the active lane's tone on first
        // activation) so each lane stays discrete — see activateLane.
        const ln = _makeLane(lanes.length);
        if (typeof _defaultVoice === 'function') ln.voice = _defaultVoice();
        lanes.push(ln);
      }
      if (lanes.length > target) {
        // Dispose audio nodes on lanes about to be trimmed so they
        // don't leak Tone.Panner / Tone.Volume / Tone.Sampler instances.
        const trimmed = lanes.slice(target);
        if (typeof disposeAllLaneAudio === 'function') disposeAllLaneAudio(trimmed);
        lanes.length = target;
      }
      if (activeLaneIdx >= lanes.length) activeLaneIdx = lanes.length - 1;
      _aliasSequenceToActiveLane();
    }
    // Add a fresh lane immediately BELOW the active one and make it active.
    // (Replaces growing the lane stack via the old grid-rows dropdown.)
    function _addLaneBelowActive() {
      if (lanes.length >= 8) return; // grid is laid out as max 8 lanes
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Add lane');
      const at = Math.min(lanes.length, (activeLaneIdx | 0) + 1);
      // A newly added lane is a blank slate: default sounds / scale / root
      // (voice) and dry FX (sends), sharing nothing with the active lane.
      // We set an explicit default voice (rather than the lazy `voice: null`,
      // which would capture the current globals on activate) so activateLane
      // rebuilds the grid to defaults instead of cloning the neighbor.
      const lane = _makeLane(at, []);
      lane.voice = _defaultVoice();
      lane.sends = _zeroLaneSends();
      lanes.splice(at, 0, lane);
      if (typeof gridRows !== 'undefined') gridRows = lanes.length;
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.value = String(Math.min(8, lanes.length));
      if (typeof activateLane === 'function') activateLane(at);
      else if (typeof renderSequence === 'function') renderSequence();
      // Wraps are global, not per-lane — clear any armed wrap and reset the
      // bank view to default so the new lane doesn't start "holding" the
      // previous lane's wrap.
      if (typeof resetWrapArming === 'function') { try { resetWrapArming(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    (function initAddLaneBtn() {
      const b = document.getElementById('add-lane-btn');
      if (b) b.addEventListener('click', _addLaneBelowActive);
    })();
    // Pick a unique "<base> copy N" name for a cloned lane. Strips an existing
    // " copy N" suffix off the source so cloning "A copy 1" yields "A copy 2",
    // not "A copy 1 copy 1". N is the lowest integer that isn't already taken.
    function _cloneLaneName(srcName) {
      const base = String(srcName || 'Lane').replace(/\s+copy\s+\d+$/i, '');
      const taken = new Set(lanes.map(l => l && l.name));
      let n = 1;
      while (taken.has(base + ' copy ' + n)) n++;
      return base + ' copy ' + n;
    }
    // Clone a lane: an exact, ref-free copy inserted right below the source,
    // with a fresh "<name> copy N" name. Mirrors the persist projection so the
    // copy shares no references with the source (steps/voice/shape/sends/…) and
    // carries none of the source's live Tone-node fields (the clone builds its
    // own lane bus lazily when it next plays).
    function _cloneLane(idx) {
      if (!Array.isArray(lanes) || idx == null || idx < 0 || idx >= lanes.length) return;
      if (lanes.length >= 8) return; // grid is laid out as max 8 lanes
      const src = lanes[idx];
      if (!src) return;
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Clone lane');
      const _cs = (typeof cloneStep === 'function') ? cloneStep : (s) => JSON.parse(JSON.stringify(s));
      const copy = {
        name: _cloneLaneName(src.name),
        steps: (src.steps || []).map(_cs),
        muted: !!src.muted,
        solo:  !!src.solo,
        driftMs:        Number.isFinite(src.driftMs)        ? src.driftMs        : 0,
        driftLocked:    !!src.driftLocked,
        driftOffsetSec: Number.isFinite(src.driftOffsetSec) ? src.driftOffsetSec : 0,
        pan:    Number.isFinite(src.pan)    ? src.pan    : 0,
        volume: Number.isFinite(src.volume) ? src.volume : 100,
        slip:   Number.isFinite(src.slip)   ? src.slip   : 0,
        collapsed: !!src.collapsed,
        fluidGridMode: !!src.fluidGridMode,
        ambientMode: !!src.ambientMode,
        ambient: src.ambient ? JSON.parse(JSON.stringify({ ...src.ambient, playing: false })) : null,
        textMode: !!src.textMode,
        text: src.text ? JSON.parse(JSON.stringify(src.text)) : null,
        seqMode: !!src.seqMode,
        shapeMode: !!src.shapeMode,
        pianoMode: !!src.pianoMode,
        shape: src.shape ? JSON.parse(JSON.stringify(src.shape)) : null,
        sentToMaster: !!src.sentToMaster,
        // Active lane's live voice lives in the globals; capture those so the
        // clone gets the up-to-date voice rather than a stale lane.voice.
        voice: (idx === activeLaneIdx && typeof _captureVoiceGlobals === 'function')
          ? _captureVoiceGlobals()
          : (src.voice ? JSON.parse(JSON.stringify(src.voice)) : null),
        sends: src.sends ? { ...src.sends } : null,
      };
      const at = idx + 1;
      lanes.splice(at, 0, copy);
      // The splice shifted every lane at index >= `at` down by one. If the
      // currently-active lane was among them, its integer activeLaneIdx is now
      // stale — and activateLane() below writes the live `sequence` + voice back
      // to lanes[activeLaneIdx] FIRST, which would dump the active lane's steps /
      // tone into the wrong lane (the classic "lane took on another lane's
      // steps/tone" bug when cloning a lane ABOVE the active one). Re-point it.
      if (activeLaneIdx >= at) activeLaneIdx++;
      if (typeof gridRows !== 'undefined') gridRows = lanes.length;
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.value = String(Math.min(8, lanes.length));
      if (typeof activateLane === 'function') activateLane(at);
      else if (typeof renderSequence === 'function') renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Delete a lane. Refuses to remove the last remaining lane; clamps the
    // active lane and re-activates so mode sync / Bloom retarget run for the
    // new active lane. Undoable via the snapshot.
    function _deleteLane(idx) {
      if (!Array.isArray(lanes) || lanes.length <= 1) return;
      if (idx == null || idx < 0 || idx >= lanes.length) return;
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Delete lane');
      // Whether we're removing the lane the user is currently editing, and a
      // reference to the active lane object so we can find where it lands once
      // the splice shifts indices.
      const deletingActive = (idx === activeLaneIdx);
      const activeObj = (activeLaneIdx >= 0 && activeLaneIdx < lanes.length) ? lanes[activeLaneIdx] : null;
      // Free the removed lane's Tone nodes (panner / volume / samplers) so
      // deleting a lane doesn't leak audio graph nodes — mirrors the trim path
      // in _resizeLanesToGridRows.
      const removed = lanes[idx];
      if (removed && typeof disposeAllLaneAudio === 'function') {
        try { disposeAllLaneAudio([removed]); } catch (e) {}
      }
      lanes.splice(idx, 1);
      if (typeof gridRows !== 'undefined') gridRows = lanes.length;
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.value = String(Math.min(8, lanes.length));
      // Re-establish a consistent active-lane state BEFORE activateLane so its
      // "sync the working `sequence` back to the previously-active lane" step
      // can't write the now-stale `sequence` (still aliasing the DELETED lane's
      // steps) into the shifted-in lane — the bug where the deleted lane's
      // steps bled into the remaining lane until the next full re-render.
      let next;
      if (deletingActive) {
        // The active lane is gone: pick the lane now occupying the deleted
        // slot (clamped). Mark activeLaneIdx invalid so activateLane SKIPS its
        // sync-back and instead loads the new lane's own steps + voice fresh.
        next = Math.min(idx, lanes.length - 1);
        activeLaneIdx = -1;
      } else {
        // The active lane survives: find its new (possibly shifted) index and
        // point activeLaneIdx + `sequence` at it, so activateLane's sync-back
        // correctly flushes the active lane's live edits back into it.
        next = activeObj ? lanes.indexOf(activeObj) : (activeLaneIdx | 0);
        if (next < 0 || next >= lanes.length) next = Math.min(Math.max(0, activeLaneIdx | 0), lanes.length - 1);
        activeLaneIdx = next;
        _aliasSequenceToActiveLane();
      }
      if (typeof activateLane === 'function') activateLane(next);
      else { _aliasSequenceToActiveLane(); if (typeof renderSequence === 'function') renderSequence(); }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Build + show a context menu listing every OTHER lane as a copy-
    // source option. Clicking an entry clones that lane's voice onto
    // the target lane (the one the user right-clicked). When the
    // target is the active lane we apply the copied voice to the
    // globals so the grid + selectors re-render immediately; when the
    // target is a non-active lane we just update its `voice` field —
    // the next activate will mirror it into the globals.
    function _showCopyVoiceMenu(targetLaneIdx, clientX, clientY) {
      if (!Array.isArray(lanes) || lanes.length < 2) return;
      const sources = lanes
        .map((l, i) => ({ lane: l, idx: i }))
        .filter(({ idx }) => idx !== targetLaneIdx);
      if (sources.length === 0) return;
      // Always read the active lane's voice from the live globals so
      // a copy from "the lane I'm currently editing" picks up the
      // edits the user has made since last activate-out.
      const sourceVoiceFor = (idx) => (idx === activeLaneIdx)
        ? _captureVoiceGlobals()
        : (lanes[idx] && lanes[idx].voice ? lanes[idx].voice : null);
      const actions = sources.map(({ lane, idx }) => ({
        label: `Copy voice from ${lane.name}`,
        fn: () => {
          const src = sourceVoiceFor(idx);
          if (!src) return;
          const cloned = JSON.parse(JSON.stringify(src));
          if (targetLaneIdx === activeLaneIdx) {
            _applyVoiceToGlobals(cloned);
            lanes[targetLaneIdx].voice = _captureVoiceGlobals();
          } else {
            lanes[targetLaneIdx].voice = cloned;
          }
          renderSequence();
          if (typeof persistWorkspace === 'function') persistWorkspace();
        },
      }));
      showCtxMenu(clientX, clientY, actions);
    }

    // Lane label menu — opened by tapping a lane's label pill (the label
    // first focuses the lane via the caller). Offers grid show/hide, solo,
    // mute, and the global sequence actions Save / Clear / Riff that used
    // to sit in the clear-riff-row. Save/Clear/Riff delegate to the now-
    // hidden transport buttons so all their existing wiring + disabled
    // gating is reused verbatim; the Riff entry opens a second menu built
    // live from the riff panel's buttons (so Drift / Merge labels + enable
    // state stay in sync).
    // Normalize every step's TONE in a lane to the current grid voice
    // (cellParams[0]) — the synth/sample TYPE, its sculpting (envelope,
    // wavetable mix, grain settings…), and all per-note FX. Pitch and
    // performance are deliberately left intact: each step keeps its freq /
    // label / cellIndex, and the per-step detune, volume, pan, slip, strum
    // (plus top-level bend / ratchet / chance / when / variance, which this
    // never touches) all survive. Rests carry no tone, so they're skipped.
    // Returns the number of voices retoned so the caller can no-op on an
    // empty lane.
    const _NORMALIZE_PRESERVE = ['detune', 'volume', 'pan', 'slip', 'strum'];
    function normalizeLaneTones(laneIdx) {
      const lane = lanes[laneIdx];
      if (!lane || !Array.isArray(lane.steps) || lane.steps.length === 0) return 0;
      const ref = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : null;
      if (!ref) return 0;
      // Tone fields only — strip the pitch / dynamics keys so each existing
      // step's own values pass through untouched.
      const tone = { ...ref };
      _NORMALIZE_PRESERVE.forEach(k => delete tone[k]);
      // Re-parsed per leaf so reference-type fields (e.g. the wavetableMix
      // array) aren't shared by reference across every retoned step.
      const toneJson = JSON.stringify(tone);
      let count = 0;
      const applyLeaf = (leaf) => {
        if (!leaf) return;
        const base = (leaf.params && typeof leaf.params === 'object') ? leaf.params : {};
        leaf.params = { ...base, ...JSON.parse(toneJson) };
        if (tone.type) leaf.sound = tone.type;
        count++;
      };
      const walk = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) {
          s.subSteps.forEach(walk);
        } else if (Array.isArray(s.chord)) {
          s.chord.forEach(applyLeaf);
        } else if (s.freq != null) {
          applyLeaf(s); // skip rests
        }
        // Variance pool: each alternate carries its own sound/params, so a
        // step with variance must have its variants retoned too — otherwise
        // the iterations that swap in a variant revert to the old tone. Runs
        // independent of the branch above (a rest can still hold variants).
        if (s.variance && Array.isArray(s.variance.notes)) {
          s.variance.notes.forEach(walk);
        }
      };
      lane.steps.forEach(walk);
      return count;
    }

    // Set a lane's volume (0-100) and push it to the live lane bus Volume node
    // immediately (lazily building the bus if needed), so a drag is audible
    // without restarting playback. Mirrors the step-vol slider's poly path.
    function _setLaneVolumeLive(laneIdx, v) {
      const lane = lanes[laneIdx];
      if (!lane) return;
      lane.volume = Math.max(0, Math.min(100, v | 0));
      try {
        if (typeof getLaneBus === 'function') getLaneBus(laneIdx);
        const volNorm = Math.max(0, Math.min(1, lane.volume / 100));
        if (lane._volume && lane._volume.volume) {
          lane._volume.volume.value = volNorm <= 0 ? -Infinity : Tone.gainToDb(volNorm);
        }
      } catch (e) {}
    }
    function _showLaneMenu(laneIdx, x, y) {
      const lane = lanes[laneIdx];
      if (!lane) return;
      const saveBtn = document.getElementById('save-btn');
      const clearBtn = document.getElementById('clear-btn');
      const riffActions = [...document.querySelectorAll('#riff-panel button')]
        .map(b => ({ label: b.textContent.trim(), disabled: b.disabled, fn: () => b.click() }))
        .filter(a => a.label);
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      // Relocated step-control drivers (the toolbar group is hidden; we drive
      // its real elements/handlers): select-by-rule, Quantize, grid size.
      const _rule = (r, n) => { try { if (typeof _selectByRule === 'function') _selectByRule(r, n); } catch (e) {} };
      const _clickEl = (id) => { const el = document.getElementById(id); if (el) el.click(); };
      const _toggleCheck = (id) => { const el = document.getElementById(id); if (el) { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); } };
      const _setGrid = (r, c) => { const re = document.getElementById('grid-rows-input'), ce = document.getElementById('grid-cols-input'); if (re) re.value = String(r); if (ce) ce.value = String(c); const drv = re || ce; if (drv) drv.dispatchEvent(new Event('change', { bubbles: true })); };
      const actions = [
        { label: _laneExpanderOpen ? 'Hide grid' : 'Show grid', fn: () => {
            _laneExpanderOpen = !_laneExpanderOpen;
            renderSequence();
            if (typeof _placeLaneExpander === 'function') _placeLaneExpander();
            persist();
          } },
        // Collapse/Expand — the per-lane collapse toggle moved here when the
        // lane-controls were removed (a lane row is now just its steps viewer).
        { label: lane.collapsed ? 'Expand lane' : 'Collapse lane', fn: () => {
            lane.collapsed = !lane.collapsed;
            renderSequence();
            persist();
          } },
        // Chip drag mode (the Free/Fixed-bar toggle is hidden) — Reorder drags
        // chips to rearrange, Resize drags them to change length.
        { label: 'Chip drag: ' + ((typeof _laneDragMode !== 'undefined' && _laneDragMode === 'resize') ? 'Resize' : 'Reorder'),
          fn: () => { try { if (typeof setLaneDragMode === 'function') setLaneDragMode((typeof _laneDragMode !== 'undefined' && _laneDragMode === 'resize') ? 'reorder' : 'resize'); } catch (e) {} } },
        // Resize behaviour (used in Chip drag: Resize mode).
        { label: 'Resize grid: ' + ((typeof _fmtLen32 === 'function') ? _fmtLen32(_resizeIncr32) : '1/16'),
          fn: () => { try { const order = [8, 4, 2, 1]; const idx = order.indexOf(_resizeIncr32); _setResizeIncr32(order[(idx + 1) % order.length]); } catch (e) {} } },
        { label: 'Resize edges: ' + ((typeof _resizeBothEdges !== 'undefined' && _resizeBothEdges) ? 'Both' : 'Right only'),
          fn: () => { try { _setResizeBothEdges(!_resizeBothEdges); } catch (e) {} } },
        { label: 'Resize keeps length: ' + ((typeof _resizeKeepTotal !== 'undefined' && _resizeKeepTotal) ? 'On' : 'Off'),
          fn: () => { try { _setResizeKeepTotal(!_resizeKeepTotal); } catch (e) {} } },
        { label: lane.solo ? 'Unsolo' : 'Solo', fn: () => { lane.solo = !lane.solo; renderSequence(); persist(); try { if (typeof updateLaneSumCompensation === 'function') updateLaneSumCompensation(); } catch (e) {} } },
        { label: lane.muted ? 'Unmute' : 'Mute', fn: () => { lane.muted = !lane.muted; renderSequence(); persist(); try { if (typeof updateLaneSumCompensation === 'function') updateLaneSumCompensation(); } catch (e) {} } },
        // Per-lane volume — drives the lane bus Volume node live (built lazily
        // by getLaneBus) and stores lane.volume so it persists + carries into
        // track/Bloom playback like every other lane mix setting.
        { slider: true, label: 'Volume', min: 0, max: 100, step: 1,
          value: Number.isFinite(lane.volume) ? lane.volume : 100,
          valFmt: (v) => Math.round(v) + '%',
          oninput: (v) => { _setLaneVolumeLive(laneIdx, v); persist(); } },
        // Per-lane Portamento — pitch glide (ms) between consecutive single notes (0 = off).
        // Max 300 ms — longer glides smear every note into the next.
        { slider: true, label: 'Portamento', min: 0, max: 300, step: 5,
          value: Number.isFinite(lane.portamento) ? Math.min(300, lane.portamento) : 0,
          valFmt: (v) => Math.round(v) + ' ms',
          oninput: (v) => { lane.portamento = Math.max(0, Math.min(300, Math.round(v))); persist(); } },
        'hr',
        // Save moved out of the lane menu — it saves the whole workspace (all
        // lanes), so it lives next to "+ Lane" as a half-row button.
        { label: 'Clear', danger: true, disabled: !clearBtn || clearBtn.disabled, fn: () => clearBtn && clearBtn.click() },
        // Normalize: stamp the current grid voice (tone + sculpting + FX)
        // onto every step in this lane, leaving each step's pitch and
        // performance settings alone.
        { label: 'Normalize', disabled: !lane.steps || lane.steps.length === 0, fn: () => {
            if (typeof snapshotForUndo === 'function') snapshotForUndo('Normalize tones');
            const n = normalizeLaneTones(laneIdx);
            if (n > 0) { renderSequence(); persist(); }
          } },
        // Clone: exact copy of this lane (steps, voice, FX, shape/Bloom config,
        // mix) inserted right below, named "<name> copy N". Disabled at the
        // 8-lane grid cap.
        { label: 'Clone lane', disabled: lanes.length >= 8, fn: () => _cloneLane(laneIdx) },
        // Delete the whole lane. Disabled when it's the only one. Confirms
        // first if the lane has any steps (undo can still recover it).
        { label: 'Delete lane', danger: true, disabled: lanes.length <= 1, fn: () => {
            const hasSteps = !!(lane.steps && lane.steps.length);
            if (hasSteps && !confirm(`Delete "${lane.name}" and its ${lane.steps.length} step(s)?`)) return;
            _deleteLane(laneIdx);
          } },
      ];
      // Lane Bloom (per-lane generative) is on ice — the "🌸 Send to Bloom ▸"
      // action that routed this lane into its own _laneEng Bloom instance was
      // removed here. Master Bloom (Mix ▸ Bloom) is untouched; its publish/send
      // options live elsewhere. _ambSendLaneToBloom/_ambSendSampleToLane stay
      // wired in 17-ambient.js for an easy restore.
      actions.push('hr');
      // Send to Shape — turn this lane's sequence into a radial wheel (each
      // sounding step a node; per-node sustain = the step's length) and switch
      // the lane into Shape mode.
      actions.push({ label: '◆ Send to Shape', disabled: !lane.steps || lane.steps.length === 0, fn: () => {
        try { if (typeof _sendLaneToShape === 'function') _sendLaneToShape(laneIdx); } catch (e) { console.warn('Send lane to Shape failed', e); }
      } });
      // "Steps ▸" — the SELECTION actions only (scope readout + select-by-rule).
      actions.push('hr');
      actions.push({ label: '⛬ Steps ▸', fn: () => setTimeout(() => {
        const selN = (typeof selectedStepRefs !== 'undefined') ? selectedStepRefs.length : 0;
        const sub = [
          { label: 'Scope: ' + (selN ? (selN + (selN === 1 ? ' step selected' : ' steps selected')) : 'whole lane (none selected)'), disabled: true, fn: () => {} },
          'hr',
          { label: 'Select all', fn: () => _rule('all') },
          { label: 'Select none', fn: () => _rule('none') },
          { label: 'Invert selection', fn: () => _rule('invert') },
          { label: 'Every 2nd', fn: () => _rule('nth', 2) },
          { label: 'Every 3rd', fn: () => _rule('nth', 3) },
          { label: 'Every 4th', fn: () => _rule('nth', 4) },
          { label: 'All rests', fn: () => _rule('rests') },
          { label: 'All chords / wraps', fn: () => _rule('chords') },
          { label: 'On the beat', fn: () => _rule('onbeat') },
        ];
        showCtxMenu(x, y, sub);
      }, 0) });
      // Quantize holds — its own toggle.
      {
        const qh = (typeof quantizeHolds !== 'undefined') ? quantizeHolds : false;
        actions.push({ label: 'Quantize holds: ' + (qh ? 'Nearest (→ Up)' : 'Up (→ Nearest)'), fn: () => _toggleCheck('quantize-holds-toggle') });
      }
      // Keep flow: per-note step-div prompt is optional. Off (default) =
      // notes append silently and you size them all once on Keep-off; on =
      // the old per-note picker fires after each kept note.
      {
        const on = (typeof _keepAskPerNote !== 'undefined') ? _keepAskPerNote : false;
        actions.push({ label: 'Keep: ask size per note ' + (on ? '✓' : '✗'), fn: () => {
          _keepAskPerNote = !_keepAskPerNote;
          try { localStorage.setItem('bloops-keep-ask-pernote', _keepAskPerNote ? '1' : '0'); } catch (e) {}
        }});
      }
      if (riffActions.length) {
        // Defer the submenu to the next tick: showCtxMenu's click handler
        // runs dismissCtxMenu() right after fn(), which would otherwise
        // tear down the submenu we just opened.
        actions.push({ label: 'Manipulate ▸', fn: () => setTimeout(() => showCtxMenu(x, y, riffActions), 0) });
      }
      // Lane view-resolution zoom — horizontal density of the step timeline
      // (global). Lives here now instead of the banner row.
      actions.push('hr');
      actions.push({
        slider: true, label: 'Zoom', min: 5, max: 200, step: 5,
        value: Math.round(((typeof laneViewScale === 'number') ? laneViewScale : 1) * 100),
        valFmt: (v) => v + '%',
        oninput: (v) => { if (typeof setLaneViewScale === 'function') setLaneViewScale(v / 100); },
      });
      showCtxMenu(x, y, actions);
    }

    // Sync the global fluidGridMode mirror + body class + toggle button
    // to the currently-active lane's `fluidGridMode`. Called from
    // activateLane (lane switch), the toggle button (mode flip), and
    // project-load paths once lanes are populated. Guards against
    // _endFluidPress / _renderXyOverlay being undefined when this runs
    // during early init (the XY pad wiring lives near the bottom of
    // the file).
    function _syncFluidGridToActiveLane() {
      const lane = lanes[activeLaneIdx];
      const wantFluid   = !!(lane && lane.fluidGridMode);
      const wantGame    = !!(lane && lane.gameMode);
      const wantProg    = !!(lane && lane.progMode);
      const wantAmbient = !!(lane && lane.ambientMode);
      const wantText    = !!(lane && lane.textMode);
      const wantSeq     = !!(lane && lane.seqMode);
      const wantShape   = !!(lane && lane.shapeMode);
      const wantPiano   = !!(lane && lane.pianoMode);
      const wasFluid   = fluidGridMode;
      const wasGame    = gameMode;
      const wasProg    = progMode;
      const wasAmbient = (typeof ambientMode !== 'undefined') ? ambientMode : false;
      const wasText    = (typeof textMode !== 'undefined') ? textMode : false;
      const wasSeq     = (typeof seqMode !== 'undefined') ? seqMode : false;
      const wasShape   = (typeof shapeMode !== 'undefined') ? shapeMode : false;
      fluidGridMode = wantFluid;
      gameMode      = wantGame;
      progMode      = wantProg;
      if (typeof ambientMode !== 'undefined') ambientMode = wantAmbient;
      if (typeof textMode !== 'undefined') textMode = wantText;
      if (typeof seqMode !== 'undefined') seqMode = wantSeq;
      if (typeof shapeMode !== 'undefined') shapeMode = wantShape;
      if (typeof pianoMode !== 'undefined') pianoMode = wantPiano;
      // Piano = Grid functionality with a keyboard layout — it does NOT hide the
      // grid (other modes do); the class only re-styles #grid into piano keys.
      document.body.classList.toggle('piano-mode', wantPiano);
      document.body.classList.toggle('fluid-grid',  wantFluid);
      document.body.classList.toggle('game-mode',   wantGame);
      document.body.classList.toggle('prog-mode',   wantProg);
      document.body.classList.toggle('ambient-mode', wantAmbient);
      document.body.classList.toggle('text-mode', wantText);
      document.body.classList.toggle('seq-mode', wantSeq);
      document.body.classList.toggle('shape-mode', wantShape);
      const btn = document.getElementById('fluid-grid-toggle');
      if (btn) {
        btn.textContent = wantShape ? 'Shape'
                        : wantSeq ? 'Seq'
                        : wantText ? 'TEXT'
                        : wantAmbient ? 'Bloom'
                        : wantProg ? 'Key'
                        : wantGame ? 'Game'
                        : wantPiano ? 'Piano'
                        : wantFluid ? 'Graph' : 'Grid';
      }
      // Reflect the active mode onto the banner-row mode dropdown.
      {
        const _mode = wantShape ? 'shape' : wantSeq ? 'seq' : wantText ? 'text' : wantAmbient ? 'bloom' : wantProg ? 'prog'
                    : wantGame ? 'game' : wantPiano ? 'piano' : wantFluid ? 'graph' : 'grid';
        const sel = document.getElementById('mode-select');
        if (sel && sel.value !== _mode) sel.value = _mode;
        try { if (typeof window._syncModeBtns === 'function') window._syncModeBtns(); } catch (e) {}
      }
      if (wasAmbient !== wantAmbient) {
        try { if (typeof _onAmbientModeChanged === 'function') _onAmbientModeChanged(wantAmbient); } catch (e) {}
      } else if (wasAmbient && wantAmbient) {
        // Bloom → Bloom lane switch: rebind the lane engine to the new lane.
        try { if (typeof _ambRetargetLane === 'function') _ambRetargetLane(); } catch (e) {}
      }
      if (wasText !== wantText) {
        try { if (typeof _onTextModeChanged === 'function') _onTextModeChanged(wantText); } catch (e) {}
      }
      if (wasSeq !== wantSeq) {
        try { if (typeof _onSeqModeChanged === 'function') _onSeqModeChanged(wantSeq); } catch (e) {}
      }
      if (wasShape !== wantShape) {
        try { if (typeof _onShapeModeChanged === 'function') _onShapeModeChanged(wantShape); } catch (e) {}
      } else if (wasShape && wantShape) {
        // Shape → Shape lane switch: rebind the canvas to the new lane.
        try { if (typeof _shapeRetargetLane === 'function') _shapeRetargetLane(); } catch (e) {}
      }
      if (wasFluid && !wantFluid) {
        try { if (typeof _endFluidPress === 'function') _endFluidPress(); } catch (e) {}
      } else if (!wasFluid && wantFluid) {
        try { if (typeof _renderXyOverlay === 'function') _renderXyOverlay(); } catch (e) {}
      }
      if (wasProg !== wantProg) {
        try { if (typeof _onProgModeChanged === 'function') _onProgModeChanged(wantProg); } catch (e) {}
      }
      if (wasFluid !== wantFluid || wasGame !== wantGame || wasProg !== wantProg) {
        // Wrap is Grid-only — reset the Keep button's label so any
        // chord/wrap name carried over from the last Grid session
        // doesn't sit in the button while in Graph / Game / Prog.
        try { if (typeof updateKeepLabel === 'function') updateKeepLabel(); } catch (e) {}
      }
      if (wasGame !== wantGame) {
        // Grid and Game keep separate Chords + Hits state — stash the
        // outgoing mode's working values, then load the incoming
        // mode's. Active-mode globals (currentProgression, _gameProgressionIdx,
        // _gameProgressionHits, _gameUserHitsPerChord) all flip atomically.
        try { _stashCurrentMode(wasGame ? 'game' : 'grid'); } catch (e) {}
        try { _loadModeState(wantGame ? 'game' : 'grid'); } catch (e) {}
        try { if (typeof _onGameModeChanged === 'function') _onGameModeChanged(wantGame); } catch (e) {}
        // Repaint chip labels (label format depends on gameMode) + Root
        // dropdown + Hits dropdown value + Hits enable gate from the
        // freshly-loaded state.
        try { if (typeof window._renderProgressionChips === 'function') window._renderProgressionChips(); } catch (e) {}
        try { if (typeof window._populateProgressionRoot === 'function') window._populateProgressionRoot(); } catch (e) {}
        try { if (typeof window._updateHitsEnabled === 'function') window._updateHitsEnabled(); } catch (e) {}
        try {
          const hitsSel = document.getElementById('hits-per-chord');
          if (hitsSel) {
            const v = Math.max(1, Math.min(10, _gameUserHitsPerChord || 1));
            hitsSel.value = String(v);
          }
        } catch (e) {}
      }
      // (The master-volume speaker button moved to the tempo cluster, so
      // the old banner-row width-matching against the Grid/Graph button is
      // no longer needed.)
    }
    function activateLane(idx) {
      if (idx == null || idx < 0 || idx >= lanes.length) return;
      // Trans-mode: if we're leaving a Shape lane with pending wheel edits, fold
      // them into its steps FIRST so the steps writeback just below captures them.
      try { if (typeof _shapeFlushNow === 'function') _shapeFlushNow(); } catch (e) {}
      // Sync current `sequence` back to the previously-active lane in
      // case it was reassigned (e.g., Clear/Reverse/Shuffle/Random
      // build new arrays). Without this, switching lanes after a
      // reassignment would resurrect the lane's old content.
      if (activeLaneIdx >= 0 && activeLaneIdx < lanes.length) {
        lanes[activeLaneIdx].steps = sequence;
        // Capture the currently-mirrored voice globals onto the lane
        // we're leaving so any edits the user made (cell sound swaps,
        // root / scale changes, palette tweaks) persist on that lane
        // when it's activated again.
        lanes[activeLaneIdx].voice = _captureVoiceGlobals();
      }
      activeLaneIdx = idx;
      // The active lane's chip strip is the workspace's working
      // surface — uncollapse it so its chips are visible and the
      // voice expander has a row to dock above.
      if (lanes[activeLaneIdx]) lanes[activeLaneIdx].collapsed = false;
      _aliasSequenceToActiveLane();
      // Apply the new lane's voice. A lane that never had a voice set (added via
      // the grid-rows resize, or a legacy/voice-less save) must NOT just keep
      // the current globals — those still hold the PREVIOUS lane's (possibly
      // just-edited) tone, so the new lane would silently adopt it, and every
      // unvoiced lane visited afterward would inherit the same tone. That's the
      // "changing one lane's tone changes them all" bug. Instead seed an
      // INDEPENDENT default voice and apply it, so each lane is discrete.
      if (lanes[activeLaneIdx].voice) {
        _applyVoiceToGlobals(lanes[activeLaneIdx].voice);
      } else {
        lanes[activeLaneIdx].voice = (typeof _defaultVoice === 'function')
          ? _defaultVoice()
          : _captureVoiceGlobals();
        _applyVoiceToGlobals(lanes[activeLaneIdx].voice);
      }
      // Per-lane FX sends: notify the FX panel its source-of-truth
      // changed so Mix sliders + bypass UI re-read from the new lane.
      try { document.dispatchEvent(new CustomEvent('activeLaneChanged', { detail: { idx } })); } catch (e) {}
      // Grid vs. Graph is per-lane — push the new lane's mode to the
      // global mirror, body class, and toggle button so the editor
      // surface swaps in sync with the lane swap.
      try { _syncFluidGridToActiveLane(); } catch (e) {}
      // Selection is tied to the previous lane's chip refs; clear so
      // selection state doesn't carry across lanes.
      selectedStepRefs = [];
      // The new lane's voice was just applied above; drop any step-select grid
      // preview state tied to the lane we left (no restore — the captured voice
      // at the top already recorded the real tone via the guard, and the new
      // lane's voice now owns the grid).
      if (typeof _stepPreviewSnap !== 'undefined') { _stepPreviewSnap = null; _previewStepRef = null; }
      // Then make the grid reflect the lane's FIRST step's tone + key (keeps
      // octave/palette from the voice). No-op when the lane has no steps yet.
      try { if (typeof _applyFirstStepToGrid === 'function') _applyFirstStepToGrid(lanes[activeLaneIdx]); } catch (e) {}
      insertionPoint = null;
      renderSequence();
      syncStepEditorFromSelection();
      // Drift label is per-lane — flip Drift ↔ Clear when switching to
      // a (non-)drifting lane.
      if (typeof refreshDriftBtn === 'function') refreshDriftBtn();
      // Keep label is now scoped to the active lane's playing step
      // (see updateKeepLabel) — refresh on lane switch so the readout
      // jumps to the new lane's current step instead of holding the
      // last-painted value from the previous lane.
      if (typeof updateKeepLabel === 'function') updateKeepLabel();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Lazy-init lanes on first use so the always-poly invariant holds
    // even before any user action: lanes always has at least one entry
    // matching gridRows and `sequence` is aliased to lanes[0].steps.
    // Called from boot + every render path that might run before the
    // user explicitly creates a lane (renderSequence, playSequence,
    // applyProjectSnapshot fall-back).
    function ensureLanesInitialized() {
      if (Array.isArray(lanes) && lanes.length > 0) return;
      lanes = [];
      const target = Math.max(1, gridRows | 0);
      lanes.push(_makeLane(0, Array.isArray(sequence) ? sequence.slice() : []));
      for (let i = 1; i < target; i++) lanes.push(_makeLane(i));
      activeLaneIdx = 0;
      _aliasSequenceToActiveLane();
      // Seed every lane's voice from the current globals so a fresh
      // workspace doesn't show empty grids when the user clicks
      // through lanes for the first time.
      const seedVoice = _captureVoiceGlobals();
      lanes.forEach(l => { if (!l.voice) l.voice = JSON.parse(JSON.stringify(seedVoice)); });
    }
    // Mono mode has been removed; these stay as no-ops so call sites
    // (legacy buttons, save/load fall-throughs) don't need surgery.
    function enterPolyMode() { ensureLanesInitialized(); }
    function exitPolyMode()  { /* always poly — no-op */ }
    function refreshPolyModeBtn() {
      // The Mono / Poly toggle is gone — this stays so legacy callers
      // (load paths, init code) don't have to be edited. Still nudges
      // the step-mode helper + footer-transport class + drift button
      // because those used to be triggered indirectly via the pill.
      if (typeof refreshStepModeBtn === 'function') refreshStepModeBtn();
      const tport = document.querySelector('.footer-transport');
      if (tport) tport.classList.add('poly-mode-on');
      if (typeof refreshDriftBtn === 'function') refreshDriftBtn();
    }
    // Drift button — three states keyed off the active lane:
    //   "Drift" → no drift yet; click prompts for ms factor.
    //   "Lock"  → lane is actively drifting; click freezes the
    //             current accumulated offset (no further drift, but
    //             the lag persists across stops/saves/replays).
    //   "Reset" → lane is locked; click un-drifts completely (offset
    //             zeroed, drift styling removed, lane re-syncs at the
    //             next iteration boundary).
    function refreshDriftBtn() {
      const btn = document.getElementById('drift-btn');
      if (!btn) return;
      // Drift is only meaningful relative to a sibling lane — disable
      // the button when there's just one lane. The Riff menu open
      // handler calls this so the disabled state is fresh whenever
      // the menu is shown.
      const hasSiblings = Array.isArray(lanes) && lanes.length >= 2;
      btn.disabled = !hasSiblings;
      const lane = (activeLaneIdx >= 0 && activeLaneIdx < lanes.length) ? lanes[activeLaneIdx] : null;
      const drifting = !!(lane && Number.isFinite(lane.driftMs) && lane.driftMs > 0);
      const locked   = !!(lane && lane.driftLocked);
      let label, title;
      if (!hasSiblings) {
        label = 'Drift';
        title = 'Drift needs at least 2 lanes — add another lane first.';
      } else if (locked) {
        label = 'Reset';
        title = `Reset lane ${lane.name} — clears the locked drift offset entirely and re-syncs with the un-drifted lanes.`;
      } else if (drifting) {
        label = 'Lock';
        title = `Lock the current drift offset on lane ${lane.name} — keeps the existing lag forever, stops adding new drift.`;
      } else {
        label = 'Drift';
        title = 'Drift: pick a millisecond factor; the active lane\'s loop iteration N is delayed by factor × N. Lock to keep the offset; Reset to undo.';
      }
      btn.textContent = label;
      btn.classList.toggle('active', drifting || locked);
      btn.title = title;
    }

    function makeInsertCursor() {
      const cursor = document.createElement('div');
      cursor.className = 'seq-cursor';
      cursor.title = 'Insertion point — click to cancel';
      cursor.addEventListener('click', () => {
        insertionPoint = null;
        renderSequence();
      });
      return cursor;
    }

