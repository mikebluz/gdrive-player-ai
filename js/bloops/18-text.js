    // ============================================================
    // 18-text.js — "TEXT" mode: type text → speech synthesis (meSpeak)
    // ============================================================
    // The sixth per-lane mode (Grid → Graph → Game → Prog → Bloom → TEXT).
    // The user types text and the eSpeak-derived meSpeak engine (vendored under
    // /vendor/mespeak/, loaded lazily on first entry) renders it to a WAV. The
    // clip can be auditioned through the lane bus, exported to Google Drive, or
    // frozen into a new lane — either as one sample clip or chopped on silence
    // into a sequence of per-word steps. Frozen clips register as imported
    // samples (persisted in IndexedDB) so the lane survives a reload.
    //
    // Isolation: nothing loads or speaks unless the active lane is in TEXT mode.

    // Document-relative path to the meSpeak front script. meSpeak derives its
    // own basePath from this script's URL and resolves the core + the config/
    // voice URLs we pass to loadConfig/loadVoice RELATIVE TO THAT basePath — so
    // those are passed bare (e.g. 'mespeak_config.json'), NOT re-prefixed.
    const _TEXT_MESPEAK_SCRIPT = 'vendor/mespeak/mespeak.js';
    const _TEXT_VOICES = [
      { value: 'en/en-us', label: 'English (US)' },
      { value: 'en/en',    label: 'English (UK)' },
    ];
    // eSpeak speaker variants — character on top of the base voice. '' = plain.
    const _TEXT_VARIANTS = [
      { value: '',        label: 'Default' },
      { value: 'm1',      label: 'Male 1' },
      { value: 'm2',      label: 'Male 2' },
      { value: 'm3',      label: 'Male 3' },
      { value: 'm4',      label: 'Male 4' },
      { value: 'm5',      label: 'Male 5' },
      { value: 'm6',      label: 'Male 6' },
      { value: 'm7',      label: 'Male 7' },
      { value: 'f1',      label: 'Female 1' },
      { value: 'f2',      label: 'Female 2' },
      { value: 'f3',      label: 'Female 3' },
      { value: 'f4',      label: 'Female 4' },
      { value: 'f5',      label: 'Female 5' },
      { value: 'whisper', label: 'Whisper' },
      { value: 'croak',   label: 'Croak' },
    ];

    // ---- Per-lane config (persisted on lane.text) ----------------------
    function _textDefaultConfig() {
      return {
        text: 'Hello from Bloops.',
        voice: 'en/en-us',
        variant: '',
        pitch: 50,       // 0..99
        speed: 175,      // words/min (80..450)
        amplitude: 100,  // 0..200
        wordgap: 0,      // pause between words, ×10 ms (0..50)
        freezeMode: 'clip', // 'clip' (one sample) | 'chop' (slice on silence)
      };
    }
    function _textCfg() {
      const lane = (typeof lanes !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (!lane) return null;
      const d = _textDefaultConfig();
      let cfg = lane.text;
      if (!cfg || typeof cfg !== 'object') { lane.text = cfg = d; return cfg; }
      if (typeof cfg.text !== 'string') cfg.text = d.text;
      if (typeof cfg.voice !== 'string' || !cfg.voice) cfg.voice = d.voice;
      if (typeof cfg.variant !== 'string') cfg.variant = d.variant;
      ['pitch', 'speed', 'amplitude', 'wordgap'].forEach(k => { if (!Number.isFinite(cfg[k])) cfg[k] = d[k]; });
      if (cfg.freezeMode !== 'clip' && cfg.freezeMode !== 'chop' && cfg.freezeMode !== 'slice') cfg.freezeMode = d.freezeMode;
      return cfg;
    }
    function _textClamp(v, lo, hi) { v = +v; return v < lo ? lo : v > hi ? hi : v; }
    function _textStepSec() {
      const bpmEl = (typeof tempoInput !== 'undefined') ? tempoInput : null;
      const bpm = Math.max(20, (bpmEl ? parseInt(bpmEl.value, 10) : 120) || 120);
      const sub = (typeof stepSubdivision === 'number' && stepSubdivision > 0) ? stepSubdivision : 0.5;
      return (60 / bpm) * sub;
    }

    // ---- meSpeak engine (lazy load) ------------------------------------
    let _textEngineLoading = false;
    let _textConfigLoaded = false;
    const _textLoadedVoices = Object.create(null);
    function _textInjectScript(cb) {
      if (typeof meSpeak !== 'undefined') { cb(null); return; }
      const existing = document.getElementById('text-mespeak-js');
      if (existing) { existing.addEventListener('load', () => cb(null), { once: true }); existing.addEventListener('error', () => cb(new Error('meSpeak failed to load')), { once: true }); return; }
      _textEngineLoading = true;
      const s = document.createElement('script');
      s.id = 'text-mespeak-js';
      s.src = _TEXT_MESPEAK_SCRIPT;
      s.onload = () => { _textEngineLoading = false; cb(null); };
      s.onerror = () => { _textEngineLoading = false; cb(new Error('Could not load the speech engine.')); };
      document.head.appendChild(s);
    }
    // Ensure engine + config + the requested voice are loaded, then cb(err).
    function _textEnsureEngine(voiceId, cb) {
      _textInjectScript((err) => {
        if (err) return cb(err);
        if (typeof meSpeak === 'undefined') return cb(new Error('Speech engine unavailable.'));
        try {
          if (!_textConfigLoaded) { meSpeak.loadConfig('mespeak_config.json'); _textConfigLoaded = true; }
        } catch (e) {}
        if (_textLoadedVoices[voiceId]) return cb(null);
        try {
          meSpeak.loadVoice('voices/' + voiceId + '.json', (ok, msg) => {
            if (ok) { _textLoadedVoices[voiceId] = true; try { meSpeak.setDefaultVoice(voiceId); } catch (e) {} cb(null); }
            else cb(new Error('Voice failed to load: ' + (msg || voiceId)));
          });
        } catch (e) { cb(e); }
      });
    }

    // ---- Synthesis (cached by text+params) -----------------------------
    let _textCache = null; // { key, buffer (AudioBuffer), wavBlob }
    function _textParamsKey(cfg) {
      return [cfg.text, cfg.voice, cfg.variant, cfg.pitch, cfg.speed, cfg.amplitude, cfg.wordgap].join('');
    }
    function _textSynth(onDone, onErr) {
      const cfg = _textCfg();
      if (!cfg) return onErr && onErr(new Error('No active lane.'));
      const text = (cfg.text || '').trim();
      if (!text) return onErr && onErr(new Error('Type some text first.'));
      const key = _textParamsKey(cfg);
      if (_textCache && _textCache.key === key) return onDone(_textCache);
      _textEnsureEngine(cfg.voice, (err) => {
        if (err) return onErr && onErr(err);
        const opts = {
          rawdata: 'array',
          voice: cfg.voice,
          pitch: _textClamp(cfg.pitch, 0, 99),
          speed: _textClamp(cfg.speed, 80, 450),
          amplitude: _textClamp(cfg.amplitude, 0, 200),
          wordgap: _textClamp(cfg.wordgap, 0, 200),
        };
        if (cfg.variant) opts.variant = cfg.variant;
        try {
          meSpeak.speak(text, opts, (ok, id, stream) => {
            if (!ok || !stream) return onErr && onErr(new Error('Speech synthesis failed.'));
            try {
              const u8 = new Uint8Array(stream);
              const wavBlob = new Blob([u8], { type: 'audio/wav' });
              const ac = Tone.getContext().rawContext;
              // decodeAudioData detaches its input → hand it a copy.
              ac.decodeAudioData(u8.buffer.slice(0), (buffer) => {
                _textCache = { key, buffer, wavBlob };
                onDone(_textCache);
              }, () => onErr && onErr(new Error('Could not decode the synthesized audio.')));
            } catch (e) { onErr && onErr(e); }
          });
        } catch (e) { onErr && onErr(e); }
      });
    }

    // ---- Audition (play through the lane bus) --------------------------
    let _textSource = null;
    let _textPlaying = false;
    function _textRefreshPlayBtn() {
      const btn = document.getElementById('text-play-btn');
      if (!btn) return;
      btn.textContent = _textPlaying ? '◼ Stop' : '▶ Speak';
      btn.classList.toggle('active', _textPlaying);
    }
    function _textStop() {
      if (_textSource) { try { _textSource.stop(); } catch (e) {} try { _textSource.dispose(); } catch (e) {} _textSource = null; }
      _textPlaying = false;
      _textRefreshPlayBtn();
    }
    function _textPlay() {
      if (_textPlaying) { _textStop(); return; }
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      _textSetStatus('Synthesizing…');
      _textSynth((c) => {
        try {
          _textStop();
          const dest = (typeof getLaneBus === 'function') ? getLaneBus(activeLaneIdx) : Tone.getDestination();
          const src = new Tone.ToneBufferSource(c.buffer).connect(dest);
          src.onended = () => { if (_textSource === src) { _textSource = null; _textPlaying = false; _textRefreshPlayBtn(); } };
          _textSource = src; _textPlaying = true; _textRefreshPlayBtn();
          src.start();
          _textSetStatus('Speaking · ' + c.buffer.duration.toFixed(1) + 's');
          _textDrawWave(c.buffer);
        } catch (e) { _textSetStatus('Playback error: ' + (e.message || e)); _textPlaying = false; _textRefreshPlayBtn(); }
      }, (err) => { _textSetStatus(err.message || 'Synthesis failed'); _textPlaying = false; _textRefreshPlayBtn(); });
    }

    // ---- Register a WAV blob as a playable (imported) sample -----------
    function _textMakeSampleId(name) {
      const base = (name || 'tts').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'tts';
      let id = 'tts-' + base, n = 1;
      while (typeof sampleSamplers !== 'undefined' && sampleSamplers.has(id)) id = 'tts-' + base + '-' + (n++);
      return id;
    }
    function _textRegisterSample(wavBlob, name) {
      const id = _textMakeSampleId(name);
      const url = URL.createObjectURL(wavBlob);
      const urls = { 'C4': url };
      const sampler = new Tone.Sampler({ urls, release: 1 }).connect(globalSendTap);
      sampleSamplers.set(id, { sampler, name: name || id, rootNote: 'C4', imported: true, urls });
      // Persist so a frozen TEXT lane survives a reload (mirrors imported samples).
      if (typeof persistImportedSample === 'function') { try { persistImportedSample(id, name || id, wavBlob); } catch (e) {} }
      return id;
    }
    function _textSampleStep(type, freq, label, durUnits, sub) {
      return { freq, label, cellIndex: null, sound: type, params: { type, volume: 100 }, duration: durUnits, subdivision: sub };
    }

    // ---- Chop a buffer on silence into voiced slices -------------------
    function _textSliceBuffer(buffer) {
      const ch = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const win = Math.max(1, Math.floor(sr * 0.02)); // 20 ms windows
      // RMS envelope per window.
      const env = [];
      for (let i = 0; i < ch.length; i += win) {
        let sum = 0; const end = Math.min(ch.length, i + win);
        for (let j = i; j < end; j++) sum += ch[j] * ch[j];
        env.push(Math.sqrt(sum / Math.max(1, end - i)));
      }
      let peak = 0; for (const v of env) if (v > peak) peak = v;
      if (peak <= 0) return [];
      // Adaptive floor (12% of peak) tracks loud vs quiet renders; word-tails
      // decay below it, so a short ~60 ms dip is treated as a word boundary.
      const thresh = Math.max(0.02, peak * 0.12);
      const minSilenceWins = 3; // ~60 ms gap splits
      const padSamp = Math.floor(sr * 0.02);
      const voiced = env.map(v => v > thresh);
      // Collect voiced runs, bridging silences shorter than minSilenceWins.
      const runs = [];
      let start = -1, silence = 0;
      for (let w = 0; w < voiced.length; w++) {
        if (voiced[w]) { if (start < 0) start = w; silence = 0; }
        else if (start >= 0) {
          silence++;
          if (silence >= minSilenceWins) { runs.push([start, w - silence + 1]); start = -1; silence = 0; }
        }
      }
      if (start >= 0) runs.push([start, voiced.length]);
      const ac = Tone.getContext().rawContext;
      const out = [];
      runs.forEach(([ws, we]) => {
        const s = Math.max(0, ws * win - padSamp);
        const e = Math.min(ch.length, we * win + padSamp);
        const len = e - s;
        if (len < sr * 0.05) return; // drop < 50 ms specks
        const sub = ac.createBuffer(1, len, sr);
        sub.getChannelData(0).set(ch.subarray(s, e));
        out.push({ buffer: sub, durSec: len / sr });
      });
      return out;
    }

    // ---- Freeze → new lane ---------------------------------------------
    function _textFreezeToLane() {
      const cfg = _textCfg();
      if (!cfg) return;
      if (!(cfg.text || '').trim()) { _textSetStatus('Type some text first.'); return; }
      _textSetStatus('Synthesizing…');
      _textSynth((c) => {
        try {
          const sub = (typeof stepSubdivision === 'number' && stepSubdivision > 0) ? stepSubdivision : 0.5;
          const stepSec = Math.max(0.02, _textStepSec());
          const c4 = (function () { try { return Tone.Frequency('C4').toFrequency(); } catch (e) { return 261.63; } })();
          const full = (cfg.text || '').trim();
          const shortLabel = full.length > 18 ? full.slice(0, 18) + '…' : full;
          const steps = [];
          let sliceVoiceId = null; // set in 'slice' mode → becomes the grid voice
          if (cfg.freezeMode === 'chop') {
            const slices = _textSliceBuffer(c.buffer);
            if (!slices.length) { _textSetStatus('No speech detected to chop.'); return; }
            slices.forEach((sl, i) => {
              const blob = audioBufferToWav(sl.buffer);
              const id = _textRegisterSample(blob, shortLabel + ' ' + (i + 1));
              const durUnits = Math.max(1, Math.ceil(sl.durSec / stepSec));
              steps.push(_textSampleStep('sample:' + id, c4, '◆ ' + (i + 1), durUnits, sub));
            });
          } else if (cfg.freezeMode === 'slice') {
            // Register the whole buffer once and lay it across N step-div steps.
            // The shared setSampleGridVoice (called post-activation) makes it the
            // grid's sliceable voice — all slicing logic lives in the general code.
            const id = _textRegisterSample(c.wavBlob, shortLabel);
            sliceVoiceId = 'sample:' + id;
            const n = Math.max(1, Math.ceil(c.buffer.duration / stepSec));
            for (let i = 0; i < n; i++) steps.push(_textSampleStep('sample:' + id, c4, '◆ ' + (i + 1), 1, sub));
          } else {
            const id = _textRegisterSample(c.wavBlob, shortLabel);
            const durUnits = Math.max(1, Math.ceil(c.buffer.duration / stepSec));
            steps.push(_textSampleStep('sample:' + id, c4, '◆ ' + shortLabel, durUnits, sub));
          }
          if (typeof snapshotForUndo === 'function') snapshotForUndo('Freeze TEXT');
          const lane = (typeof _makeLane === 'function') ? _makeLane(lanes.length, steps) : null;
          if (!lane) { _textSetStatus('Could not create a lane.'); return; }
          lane.name = 'TEXT ' + (lanes.length + 1);
          try { if (typeof _captureVoiceGlobals === 'function') lane.voice = _captureVoiceGlobals(); } catch (e) {}
          lanes.push(lane);
          if (typeof gridRows !== 'undefined') gridRows = lanes.length;
          const rowsEl = document.getElementById('grid-rows-input');
          if (rowsEl) rowsEl.value = String(lanes.length);
          if (typeof activateLane === 'function') activateLane(lanes.length - 1);
          else if (typeof renderSequence === 'function') renderSequence();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          // Slice mode: make the buffer the lane's sliceable grid voice via the
          // shared general API (this also stamps sliceMode onto the new steps).
          if (sliceVoiceId && typeof setSampleGridVoice === 'function') {
            try {
              setSampleGridVoice(sliceVoiceId, 'scan');
              if (typeof _captureVoiceGlobals === 'function') lane.voice = _captureVoiceGlobals();
              if (typeof persistWorkspace === 'function') persistWorkspace();
            } catch (e) {}
          }
          _textSetStatus('Froze to lane "' + lane.name + '" (' + steps.length + (steps.length === 1 ? ' step).' : ' steps).'));
        } catch (e) { _textSetStatus('Freeze failed: ' + (e.message || e)); }
      }, (err) => _textSetStatus(err.message || 'Synthesis failed'));
    }

    // ---- Export → Google Drive -----------------------------------------
    let _textExportBusy = false;
    async function _textExportToDrive() {
      if (_textExportBusy) return;
      const cfg = _textCfg();
      if (!cfg || !(cfg.text || '').trim()) { _textSetStatus('Type some text first.'); return; }
      if (typeof showExportOptionsDialog !== 'function') { alert('Export is unavailable.'); return; }
      _textExportBusy = true;
      _textSetStatus('Synthesizing…');
      const synth = () => new Promise((res, rej) => _textSynth(res, rej));
      try {
        const c = await synth();
        const stamp = (() => { try { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); } catch (e) { return 'take'; } })();
        const choice = await showExportOptionsDialog({
          title: 'Export speech to Drive',
          defaultName: 'speech-' + stamp,
          defaultFolder: 'bloops/exports',
          includeFolder: true,
          applyLabel: 'Export',
        });
        if (!choice) { _textSetStatus('Export cancelled.'); _textExportBusy = false; return; }
        const { filename, fmt, folder } = choice;
        const ext = fmt === 'mp3' ? 'mp3' : 'wav';
        const mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav';
        const progress = (typeof showRenderProgressModal === 'function') ? showRenderProgressModal('Exporting speech…') : null;
        try {
          progress && progress.setStatus(fmt === 'mp3' ? 'Encoding MP3…' : 'Encoding WAV…');
          const blob = (fmt === 'mp3' && typeof audioBufferToMp3 === 'function')
            ? await audioBufferToMp3(c.buffer)
            : audioBufferToWav(c.buffer);
          progress && progress.setStatus('Signing in to Google Drive…');
          await googleSignInForDrive();
          progress && progress.setStatus('Uploading to Drive…');
          const folderId = await findOrCreateDriveFolder(folder);
          const file = await uploadBlobToDrive(`${filename}.${ext}`, blob, folderId, mime);
          progress && progress.markDone();
          _textSetStatus('Saved to Drive: ' + ((file && file.name) || filename + '.' + ext));
        } finally {
          progress && progress.close();
        }
      } catch (e) {
        console.error('TEXT export failed', e);
        _textSetStatus('Export failed: ' + (e && e.message || e));
      } finally {
        _textExportBusy = false;
      }
    }

    // ---- Waveform preview ----------------------------------------------
    function _textDrawWave(buffer) {
      const cv = document.getElementById('text-viz');
      if (!cv) return;
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      const w = cv.clientWidth || 320, h = cv.clientHeight || 60;
      cv.width = Math.max(1, Math.floor(w * dpr)); cv.height = Math.max(1, Math.floor(h * dpr));
      const ctx = cv.getContext('2d'); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a0a14'; ctx.fillRect(0, 0, w, h);
      if (!buffer) return;
      const ch = buffer.getChannelData(0);
      const mid = h / 2;
      const step = Math.max(1, Math.floor(ch.length / w));
      ctx.strokeStyle = '#6cc6ff'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = 0; x < w; x++) {
        let min = 1, max = -1; const s = x * step, e = Math.min(ch.length, s + step);
        for (let i = s; i < e; i++) { const v = ch[i]; if (v < min) min = v; if (v > max) max = v; }
        ctx.moveTo(x + 0.5, mid + min * mid); ctx.lineTo(x + 0.5, mid + max * mid);
      }
      ctx.stroke();
    }

    // ---- Status line ---------------------------------------------------
    function _textSetStatus(msg) {
      const el = document.getElementById('text-status');
      if (el) el.textContent = msg || '';
    }

    // ---- Panel UI ------------------------------------------------------
    let _textInited = false;
    function _textSyncControls() {
      const cfg = _textCfg();
      if (!cfg) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
      set('text-input', cfg.text);
      set('text-voice', cfg.voice);
      set('text-variant', cfg.variant);
      set('text-pitch', cfg.pitch);
      set('text-speed', cfg.speed);
      set('text-amplitude', cfg.amplitude);
      set('text-wordgap', cfg.wordgap);
      ['clip', 'chop', 'slice'].forEach(m => { const el = document.getElementById('text-freeze-' + m); if (el) el.classList.toggle('active', cfg.freezeMode === m); });
      _textRefreshPlayBtn();
    }
    function _textInit() {
      if (_textInited) { _textSyncControls(); return; }
      const host = document.getElementById('text-inner');
      if (!host) return;
      const sl = (label, id, min, max, val, hint) =>
        '<div class="ambient-ctrl"><label for="' + id + '">' + label + '</label>' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '" />' +
        (hint ? '<span class="ambient-hint">' + hint + '</span>' : '') + '</div>';
      const opts = (arr) => arr.map(o => '<option value="' + o.value + '">' + o.label + '</option>').join('');
      host.innerHTML =
        '<div class="ambient-title">TEXT — speech synthesis</div>' +
        '<textarea id="text-input" class="text-input" rows="3" placeholder="Type something to speak…"></textarea>' +
        '<div class="ambient-row">' +
          '<button type="button" id="text-play-btn" class="ambient-play">▶ Speak</button>' +
          '<button type="button" id="text-freeze-btn" class="ambient-regen" title="Render to a new lane (as a clip or chopped on silence)">❄ Freeze→lane</button>' +
          '<button type="button" id="text-export-btn" class="ambient-regen" title="Render and save the speech to Google Drive">⤓ Export→Drive</button>' +
        '</div>' +
        '<canvas id="text-viz" class="ambient-viz"></canvas>' +
        '<div class="ambient-ctrl"><label for="text-voice">Voice</label><select id="text-voice" class="ambient-select">' + opts(_TEXT_VOICES) + '</select><span class="ambient-hint">language</span></div>' +
        '<div class="ambient-ctrl"><label for="text-variant">Variant</label><select id="text-variant" class="ambient-select">' + opts(_TEXT_VARIANTS) + '</select><span class="ambient-hint">character</span></div>' +
        sl('Pitch', 'text-pitch', 0, 99, 50, 'low → high') +
        sl('Speed', 'text-speed', 80, 450, 175, 'wpm') +
        sl('Volume', 'text-amplitude', 0, 200, 100, 'amplitude') +
        sl('Word gap', 'text-wordgap', 0, 50, 0, 'pause') +
        '<div class="ambient-row ambient-timing">' +
          '<span class="ambient-hint">Freeze as</span>' +
          '<button type="button" class="ambient-seg" id="text-freeze-clip" title="One sample clip on a new lane">Clip</button>' +
          '<button type="button" class="ambient-seg" id="text-freeze-chop" title="Slice on silence into one step per word">Chop</button>' +
          '<button type="button" class="ambient-seg" id="text-freeze-slice" title="Lay the whole sample across step-div slices and make it the grid voice (sliceable, pitched)">Slice</button>' +
        '</div>' +
        '<div class="ambient-note" id="text-status">Speech runs through this lane’s bus — dial in its FX sends. Powered by meSpeak (eSpeak).</div>';

      // Textarea → cfg.text (invalidates the synth cache implicitly via key).
      const ta = document.getElementById('text-input');
      if (ta) ta.addEventListener('input', () => {
        const cfg = _textCfg(); if (!cfg) return;
        cfg.text = ta.value || '';
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
      // Selects.
      const wireSel = (id, key, dflt) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
          const cfg = _textCfg(); if (!cfg) return;
          cfg[key] = el.value || dflt;
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      };
      wireSel('text-voice', 'voice', 'en/en-us');
      wireSel('text-variant', 'variant', '');
      // Int sliders.
      const wireSlider = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
          const cfg = _textCfg(); if (!cfg) return;
          cfg[key] = parseInt(el.value, 10) || 0;
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      };
      wireSlider('text-pitch', 'pitch');
      wireSlider('text-speed', 'speed');
      wireSlider('text-amplitude', 'amplitude');
      wireSlider('text-wordgap', 'wordgap');
      // Freeze-mode segmented toggle.
      ['clip', 'chop', 'slice'].forEach(m => {
        const el = document.getElementById('text-freeze-' + m);
        if (el) el.addEventListener('click', () => {
          const cfg = _textCfg(); if (!cfg) return;
          cfg.freezeMode = m; _textSyncControls();
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      });
      // Buttons.
      const play = document.getElementById('text-play-btn');
      if (play) play.addEventListener('click', _textPlay);
      const frz = document.getElementById('text-freeze-btn');
      if (frz) frz.addEventListener('click', _textFreezeToLane);
      const exp = document.getElementById('text-export-btn');
      if (exp) exp.addEventListener('click', _textExportToDrive);

      _textInited = true;
      _textSyncControls();
    }

    // ---- Mode entry / exit ---------------------------------------------
    function _onTextModeChanged(active) {
      if (active) {
        _textInit();
        // Pre-warm the engine so the first Speak is quick.
        try { const cfg = _textCfg(); if (cfg) _textEnsureEngine(cfg.voice, () => {}); } catch (e) {}
      } else {
        _textStop();
      }
    }
