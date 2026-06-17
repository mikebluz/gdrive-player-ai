    // ---- BPM metronome ------------------------------------------------
    // Toggleable click track that fires a short percussive sound at the
    // current BPM. Independent of sequence playback — useful for the
    // user to feel the cadence while editing. Restarts whenever the
    // BPM changes (tempo digits / slider / number input all funnel to
    // tempoInput.value).
    let _metronomeOn      = false;
    let _metronomeTimer   = null;
    let _metronomeSynth   = null;
    let _metronomeNextAt  = 0;   // next click's absolute audio-context time
    function _getMetronomeSynth() {
      if (_metronomeSynth) return _metronomeSynth;
      try {
        _metronomeSynth = new Tone.MembraneSynth({
          pitchDecay: 0.008,
          octaves:    2,
          envelope:   { attack: 0.001, decay: 0.04, sustain: 0, release: 0.05 },
          volume:     -8,
        }).toDestination();
      } catch (e) {}
      return _metronomeSynth;
    }
    function _stopMetronomeTimer() {
      if (_metronomeTimer !== null) {
        clearInterval(_metronomeTimer);
        _metronomeTimer = null;
      }
      _metronomeNextAt = 0;
    }
    // Schedule any clicks falling inside a forward lookahead window
    // at their exact audio-context times. setInterval used to fire
    // the tick itself, which drifted on mobile (setInterval intervals
    // stretch under throttling), causing the metronome to slide out
    // of phase with the audio-clock-scheduled sequence playback. The
    // schedule-ahead pattern decouples WHEN we call this function
    // from WHEN the clicks actually play: events land at their pinned
    // audio times even if the JS tick is late.
    function _scheduleMetronomeAhead() {
      if (!_metronomeOn) return;
      const bpm = parseInt(tempoInput.value, 10) || 120;
      if (bpm <= 0) return;
      const intervalSec = 60 / bpm;
      const raw = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
      if (!raw) return;
      const now = raw.currentTime;
      // Fresh cadence on start or after a long stall. 60 ms lead-in
      // gives the audio thread time to spin up the first click cleanly
      // (matches the cold-start cushion used elsewhere).
      if (_metronomeNextAt === 0 || _metronomeNextAt < now - 0.05) {
        _metronomeNextAt = now + 0.06;
      }
      const horizon = now + 0.5; // 500 ms lookahead, matches the sequence scheduler
      const synth = _getMetronomeSynth();
      const btn = document.getElementById('metronome-btn');
      let safety = 0;
      while (_metronomeNextAt < horizon && safety++ < 64) {
        const t = _metronomeNextAt;
        if (synth) {
          try { synth.triggerAttackRelease('C5', '32n', t); } catch (e) {}
        }
        if (btn) {
          scheduleVisual(() => {
            if (!_metronomeOn) return;
            btn.classList.add('tick');
            setTimeout(() => btn.classList.remove('tick'), 60);
          }, t);
        }
        _metronomeNextAt += intervalSec;
      }
    }
    function _startMetronomeTimer() {
      _stopMetronomeTimer();
      if (!_metronomeOn) return;
      _scheduleMetronomeAhead();
      // Tick at 100 ms — well inside the 500 ms lookahead, so even a
      // mobile-throttled interval (which can stretch to ~300 ms) still
      // refills the schedule before any audio event runs late.
      _metronomeTimer = setInterval(_scheduleMetronomeAhead, 100);
    }
    function _restartMetronomeIfActive() {
      if (_metronomeOn) _startMetronomeTimer();
    }
    function refreshMetronomeBtn() {
      const btn = document.getElementById('metronome-btn');
      if (!btn) return;
      btn.classList.toggle('active', _metronomeOn);
      btn.title = _metronomeOn
        ? 'Metronome on — click to silence.'
        : 'Metronome — toggle a click at the current BPM so you can hear the rhythm.';
    }
    // Set true when a long-press on the metronome opened the BPM picker, so
    // the click that follows the press doesn't ALSO toggle the metronome.
    let _bpmLpFired = false;
    document.getElementById('metronome-btn')?.addEventListener('click', async () => {
      if (_bpmLpFired) { _bpmLpFired = false; return; }
      try { await Tone.start(); } catch (e) {}
      _metronomeOn = !_metronomeOn;
      refreshMetronomeBtn();
      if (_metronomeOn) _startMetronomeTimer();
      else _stopMetronomeTimer();
    });

    // ---- 3-digit BPM picker ---------------------------------------------
    const _bpmDigitH = document.getElementById('bpm-d-h');
    const _bpmDigitT = document.getElementById('bpm-d-t');
    const _bpmDigitO = document.getElementById('bpm-d-o');
    // BPM is allowed across the full 3-digit space (0..999) so each
    // +/- button on the digit picker only changes its own digit. BPM 0
    // is treated as "stopped" — the playback math has a `|| 120` fallback
    // so a zeroed display doesn't divide by zero anywhere.
    function getBpm() {
      return Math.min(999, Math.max(0, parseInt(tempoInput.value, 10) || 0));
    }
    function setBpm(v) {
      const next = Math.min(999, Math.max(0, v | 0));
      tempoInput.value  = String(next);
      tempoSlider.value = String(next);
      updateBpmAccent();
      refreshBpmDigits();
      if (typeof _restartMetronomeIfActive === 'function') _restartMetronomeIfActive();
      persistWorkspace();
    }
    // Restart the bpm-pulse animation across all digits at the next
    // animation frame, in sync. Used both when the cycle duration
    // changes (BPM / step subdivision edits) and when sequence
    // playback starts so the visual peak hits the first note attack.
    function restartBpmDigitAnimation() {
      const digitsHost = document.getElementById('bpm-digits');
      if (!digitsHost) return;
      digitsHost.querySelectorAll('.bpm-digit').forEach(el => {
        el.style.animation = 'none';
        // eslint-disable-next-line no-unused-expressions
        el.offsetWidth;
        el.style.animation = '';
      });
    }

    function refreshBpmDigits() {
      const v = getBpm();
      const h = Math.floor(v / 100);
      const t = Math.floor((v % 100) / 10);
      const o = v % 10;
      if (_bpmDigitH) _bpmDigitH.textContent = String(h);
      if (_bpmDigitT) _bpmDigitT.textContent = String(t);
      if (_bpmDigitO) _bpmDigitO.textContent = String(o);
      // Mirror onto the combined Tempo/Volume/Groove trigger so BPM stays
      // glanceable while the digits live inside its dropdown.
      const xb = document.getElementById('xport-bpm');
      if (xb) xb.textContent = String(v);
      // One pulse cycle = one step (60/BPM × stepSubdivision seconds)
      // so each step matches a flash. BPM 0 falls back to 0.5s so the
      // animation stays visible instead of stretching to an Infinity-
      // second duration browsers reject.
      const digitsHost = document.getElementById('bpm-digits');
      if (digitsHost) {
        const stepSec = (v > 0 ? (60 / v) * (Number.isFinite(stepSubdivision) ? stepSubdivision : 0.5) : 0.5);
        const dur = stepSec.toFixed(3) + 's';
        digitsHost.style.setProperty('--bpm-pulse-dur', dur);
        digitsHost.querySelectorAll('.bpm-digit').forEach(el => {
          el.style.animation = 'none';
          // eslint-disable-next-line no-unused-expressions
          el.offsetWidth;
          el.style.animation = '';
        });
      }
      // The +/- buttons stay enabled at digit extremes so they keep
      // pulsing in lockstep with the digits. Out-of-range steps clamp
      // to 60..320 inside setBpm, so a click at the bound just no-ops
      // visually instead of needing a disabled state.
    }
    // Each BPM digit is now a button that opens a 0–9 picker (via the
     // same showCtxMenu pattern used elsewhere) so the user picks the
     // exact digit they want instead of stepping with +/−. Press on
     // mobile or click on desktop both work — the menu anchors to the
     // gesture's screen coordinates and replaces the digit's value when
     // a number is selected.
    function setBpmDigitAt(place, value) {
      const v = getBpm();
      let h = Math.floor(v / 100);
      let t = Math.floor((v % 100) / 10);
      let o = v % 10;
      if      (place === 100) h = value;
      else if (place === 10)  t = value;
      else if (place === 1)   o = value;
      setBpm(h * 100 + t * 10 + o);
    }
    function openBpmDigitPicker(x, y, place) {
      const actions = [];
      for (let d = 0; d <= 9; d++) {
        actions.push({ label: String(d), fn: () => setBpmDigitAt(place, d) });
      }
      showCtxMenu(x, y, actions);
    }
    document.querySelectorAll('#bpm-digits .bpm-digit').forEach(btn => {
      const place = parseInt(btn.dataset.place, 10) || 0;
      if (!place) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBpmDigitPicker(e.clientX, e.clientY, place);
      });
      // Suppress the native long-press menu on touch so the picker is
      // the only thing that surfaces.
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // ---- BPM picker popover ----
    // The 3-digit picker no longer lives inline in the transport row — it
    // surfaces as a popover anchored to the metronome (BPM on/off) button on
    // right-click (desktop) or long-press (touch). Left-click/tap still
    // toggles the metronome.
    let _bpmPickerOutside = null;
    function closeBpmPicker() {
      const d = document.getElementById('bpm-digits');
      if (d) d.classList.remove('bpm-pop');
      if (_bpmPickerOutside) {
        document.removeEventListener('pointerdown', _bpmPickerOutside, true);
        document.removeEventListener('keydown', _bpmPickerOutside, true);
        _bpmPickerOutside = null;
      }
    }
    function openBpmPicker(anchor) {
      const d = document.getElementById('bpm-digits');
      if (!d || !anchor) return;
      // When the digits live inside the combined Tempo/Volume/Groove menu they
      // are already visible there — skip the separate metronome popover.
      if (d.closest('#xport-menu')) return;
      if (d.classList.contains('bpm-pop')) { closeBpmPicker(); return; }
      d.classList.add('bpm-pop');
      refreshBpmDigits();
      const r = anchor.getBoundingClientRect();
      const dw = d.offsetWidth || 120, dh = d.offsetHeight || 44;
      const vw = window.innerWidth, vh = window.innerHeight;
      d.style.left = Math.max(8, Math.min(r.left, vw - dw - 8)) + 'px';
      d.style.top  = Math.min(r.bottom + 6, vh - dh - 8) + 'px';
      _bpmPickerOutside = (e) => {
        if (e.type === 'keydown') { if (e.key === 'Escape') closeBpmPicker(); return; }
        // Keep open while interacting with the digits or their 0–9 menu.
        if (e.target.closest('#bpm-digits') || e.target.closest('.ctx-menu') || e.target === anchor) return;
        closeBpmPicker();
      };
      document.addEventListener('pointerdown', _bpmPickerOutside, true);
      document.addEventListener('keydown', _bpmPickerOutside, true);
    }
    (function bindBpmPickerTriggers() {
      const metro = document.getElementById('metronome-btn');
      if (!metro) return;
      metro.addEventListener('contextmenu', (e) => { e.preventDefault(); openBpmPicker(metro); });
      let _lpTimer = null;
      const cancelLp = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
      metro.addEventListener('pointerdown', (e) => {
        if (e.button && e.button !== 0) return;   // left / touch only
        cancelLp();
        _lpTimer = setTimeout(() => { _bpmLpFired = true; openBpmPicker(metro); }, 450);
      });
      metro.addEventListener('pointerup', cancelLp);
      metro.addEventListener('pointerleave', cancelLp);
      metro.addEventListener('pointercancel', cancelLp);
    })();

    updateBpmAccent();
    refreshBpmDigits();

    // iOS audio unlock + master-chain warm-up: Tone.start() alone is async
    // and often hasn't finished resuming by the time the first tap fires
    // playNote. Playing a silent buffer synchronously inside the gesture
    // forces the context to transition to running immediately, and
    // Tone.start() keeps the Tone-level state in sync. Run on EVERY
    // gesture until the context is actually 'running' — the original
    // `once: true` would fire on the sign-in tap (before OAuth even
    // returned), then never again, leaving the first several post-login
    // taps silent on iOS.
    //
    // Once the context becomes running, we ALSO push a silent
    // triggerAttackRelease through the full master bus so the WebAudio
    // graph (distortion → delay → reverb → volume → limiter → destination)
    // gets compiled / connected end-to-end. Without this warm pass, the
    // first 1–2 user-pressed notes after a cold load can come out silent
    // because the synth instantiated in playNote is the first signal the
    // chain has ever processed.
    let _bloopsAudioWarmed = false;
    // Pre-instantiates one of every synth type playNote knows about and
    // wires up a per-note FX chain (Distortion → Delay → Reverb → Panner)
    // at -100 dB so the AudioWorklets / shaders / Tone.js node graph all
    // compile end-to-end before the user's first real note. Safe to call
    // before any user gesture — node construction works on a suspended
    // context, and the silent triggerAttackRelease is just queued.
    function warmMasterChainOnce() {
      if (_bloopsAudioWarmed) return;
      if (typeof masterBus === 'undefined' || !masterBus) return;
      if (typeof Tone === 'undefined') return;
      _bloopsAudioWarmed = true;
      const muted   = -100;
      const tinyEnv = { attack: 0.001, decay: 0.001, sustain: 0, release: 0.001 };
      const created = [];
      const tryMake = (build) => {
        try { const n = build(); created.push(n); return n; } catch (e) { return null; }
      };
      try {
        // 1) Each synth type used by playNote, routed through masterBus so
        //    the synth + master path compiles end-to-end.
        [
          () => new Tone.Synth        ({ oscillator: { type: 'sine' }, envelope: tinyEnv, volume: muted }),
          () => new Tone.FMSynth      ({ envelope: tinyEnv, modulationEnvelope: tinyEnv, volume: muted }),
          () => new Tone.AMSynth      ({ envelope: tinyEnv, modulationEnvelope: tinyEnv, volume: muted }),
          () => new Tone.MonoSynth    ({ envelope: tinyEnv, filterEnvelope: tinyEnv,    volume: muted }),
          () => new Tone.MembraneSynth({ envelope: tinyEnv,                              volume: muted }),
          () => new Tone.MetalSynth   ({ envelope: { attack: 0.001, decay: 0.001, release: 0.001 }, volume: muted }),
          () => new Tone.PluckSynth   ({                                                 volume: muted }),
        ].forEach(make => {
          const s = tryMake(make);
          if (!s) return;
          try { s.connect(masterBus); } catch (e) {}
          try { s.triggerAttackRelease('C4', 0.01); } catch (e) {}
        });

        // 2) Per-note FX chain — what playNote builds for any chip with
        //    non-zero effect knobs. Push one silent attack through it so
        //    the effect nodes get compiled too.
        const pn = tryMake(() => new Tone.Panner(0));
        const rv = tryMake(() => new Tone.Freeverb({ roomSize: 0.5, dampening: 3000, wet: 0.001 }));
        const dl = tryMake(() => new Tone.FeedbackDelay({ delayTime: 0.1, feedback: 0.001, wet: 0.001 }));
        const ds = tryMake(() => new Tone.Distortion({ distortion: 0.001, wet: 0.001 }));
        const sx = tryMake(() => new Tone.Synth({ envelope: tinyEnv, volume: muted }));
        if (pn && rv && dl && ds && sx) {
          try {
            pn.connect(masterBus);
            rv.connect(pn);
            dl.connect(rv);
            ds.connect(dl);
            sx.connect(ds);
            sx.triggerAttackRelease('C4', 0.01);
          } catch (e) {}
        }

        // Generous tail covers the longest synth release (Pluck/Metal ~1s).
        setTimeout(() => {
          created.forEach(n => { try { n.dispose(); } catch (e) {} });
        }, 1500);
      } catch (e) {}
    }

    // iOS keep-alive. Mobile Safari suspends an AudioContext that goes idle
    // (no active source) for even a short spell; resuming it on the next tap
    // costs the better part of a second, heard as severe per-press lag where
    // the sound arrives ~1s late EVERY press. A single permanently-running,
    // fully-muted oscillator keeps the context 'running' so every press hits
    // the warm ~25 ms trigger path instead of the suspended cold-start
    // cushion. Started the first time the context is actually running (it
    // resumes alongside the context after a background→foreground return, so
    // it keeps protecting once visibilitychange re-resumes). gain 0 → truly
    // silent; cost is negligible.
    let _keepAliveStarted = false;
    function startAudioKeepAlive() {
      if (_keepAliveStarted) return;
      let ac;
      try { ac = Tone.getContext().rawContext; } catch (e) { return; }
      if (!ac || ac.state !== 'running') return;
      try {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        g.gain.value = 0;
        osc.frequency.value = 20;
        osc.connect(g);
        g.connect(ac.destination);
        osc.start();
        _keepAliveStarted = true;
      } catch (e) {}
    }
    (function bindIosAudioUnlock() {
      const events = ['pointerdown','touchstart','keydown'];
      const handler = () => {
        let ac;
        try { ac = Tone.getContext().rawContext; } catch (e) { return; }
        if (ac && ac.state === 'running') {
          warmMasterChainOnce();
          startAudioKeepAlive();
          return;
        }
        if (!ac) return;
        try {
          const src = ac.createBufferSource();
          src.buffer = ac.createBuffer(1, 1, 22050);
          src.connect(ac.destination);
          src.start(0);
        } catch (e) {}
        try { Tone.start(); } catch (e) {}
        try {
          const p = ac.resume?.();
          if (p && typeof p.then === 'function') {
            p.then(() => { warmMasterChainOnce(); startAudioKeepAlive(); }, () => {});
          } else {
            // Synchronous resume path (older Safari) — try the warm-up
            // immediately; if the chain isn't ready yet, the no-op
            // Synth construction is harmless and the next gesture will
            // re-fire (the _bloopsAudioWarmed flag isn't set unless
            // construction succeeds).
            warmMasterChainOnce();
            startAudioKeepAlive();
          }
        } catch (e) {}
      };
      events.forEach(ev => document.addEventListener(ev, handler, { capture: true }));
    })();
    document.addEventListener('visibilitychange', () => {
      const tctx = Tone.getContext().rawContext;
      if (document.hidden) return;
      if (tctx && tctx.state === 'suspended') {
        const rp = tctx.resume?.();
        if (rp && typeof rp.then === 'function') rp.then(() => startAudioKeepAlive(), () => {});
      }
      startAudioKeepAlive();
      // Mobile browsers suspend the AudioContext + the JS scheduler tick
      // while a tab is backgrounded. When the user comes back the
      // worklet (or main-thread closure map) may still hold dispatches
      // whose audioTimes sit in the past — Tone fires those "soonest
      // possible," producing the rushed-catchup burst that reads as
      // severe lag. Drop everything past the safety window and let the
      // walk re-schedule from the live now.
      if (typeof sequenceTimer !== 'undefined' && sequenceTimer != null) {
        try {
          if (typeof _invalidatePlayback === 'function') _invalidatePlayback();
        } catch (e) {}
      }
    });

    function getStepMs() {
      return Math.round(60000 / (parseInt(tempoInput.value) || 120) * stepSubdivision);
    }

    const SOUNDS = ['sine','square','triangle','sawtooth','pulse','fat','wavetable','fm','am','mono','duo','bass','pad','xylo','bell','pluck','kick','metal','noise:white','noise:pink','noise:brown'];

    // ---- Tone.js v14 URL double-encode patch ----------------------------
    // ToneAudioBuffer.load() does
    //   location.href = baseUrl + url; pathname = pathname.split('/').
    //     map(encodeURIComponent).join('/');
    // The browser auto-encodes any space in `href` to `%20`, then the
    // path-segment encodeURIComponent runs again and turns `%` into
    // `%25`, producing `%2520`. Filenames that contain spaces (or any
    // other char that needs URL-encoding) 404.
    //
    // Override the static loader with a direct fetch + decodeAudioData.
    // encodeURI handles literal spaces without double-encoding existing
    // %XX escapes, so both pre-encoded and literal-space inputs work.
    if (Tone && Tone.ToneAudioBuffer && Tone.ToneAudioBuffer.load) {
      const _origToneLoad = Tone.ToneAudioBuffer.load;
      Tone.ToneAudioBuffer.load = function(url) {
        let safeUrl;
        try { safeUrl = encodeURI(decodeURI(url)); }
        catch (e) { safeUrl = url; }
        return fetch(safeUrl, { credentials: 'omit' })
          .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + safeUrl);
            return r.arrayBuffer();
          })
          .then(buf => new Promise((resolve, reject) => {
            const ctx = (Tone.getContext && Tone.getContext().rawContext) || Tone.context.rawContext;
            try {
              const p = ctx.decodeAudioData(buf, resolve, reject);
              if (p && typeof p.then === 'function') p.then(resolve, reject);
            } catch (e) { reject(e); }
          }))
          .catch(err => {
            console.warn('[Tone patch] sample load failed', safeUrl, err);
            // Fall back to the original buggy loader so we at least mirror
            // the prior behavior on edge cases this patch can't handle.
            return _origToneLoad.call(this, url);
          });
      };
    }

    // Master bus: compressor softens dynamic peaks, limiter is a brick wall at
    // -1 dB so simultaneous voices (chords, overlapping tracks, long releases)
    // never clip. Aggressive settings because chord playback can spike well
    // above 0 dB from the raw sum of multiple synths.
    const masterLimiter = new Tone.Limiter(-1).toDestination();
    // Master volume — sits right before the limiter so the slider scales
    // the entire mix (Bloops + per-track output + global FX tails) but
    // can't push the signal above the limiter's -1 dB ceiling. Volume of
    // 0 dB at unity; the UI slider drives this in dB.
    const masterVolume = new Tone.Volume(0).connect(masterLimiter);
    // Global FX chain — sits post-compressor / pre-limiter so the dynamics
    // settle before reverb/delay tails layer on. wet=0 / distortion=0 are
    // effective pass-throughs; the FX panel UI updates these in place.
    // Global FX chain (built backward from masterVolume):
    //   masterDistortion → masterAutoFilter → masterPhaser → masterVibrato →
    //   masterChorus → masterTremolo → masterDelay → masterPingPong →
    //   masterReverb → masterAutoPan → masterVolume → masterLimiter
    // LFO-driven effects (Tremolo, Chorus, AutoFilter, AutoPanner) need an
    // explicit .start() to begin oscillating; idle wet=0 = transparent.
    const masterAutoPan = new Tone.AutoPanner({
      frequency: 1, depth: 1, wet: 0,
    }).connect(masterVolume);
    try { masterAutoPan.start(); } catch (e) {}
    const masterReverb = new Tone.Freeverb({
      roomSize: 0.7, dampening: 3000, wet: 0,
    }).connect(masterAutoPan);
    const masterPingPong = new Tone.PingPongDelay({
      delayTime: 0.25, feedback: 0.3, wet: 0,
    }).connect(masterReverb);
    const masterDelay = new Tone.FeedbackDelay({
      delayTime: '8n', feedback: 0.4, wet: 0,
    }).connect(masterPingPong);
    const masterTremolo = new Tone.Tremolo({
      frequency: 5, depth: 0.7, wet: 0,
    }).connect(masterDelay);
    try { masterTremolo.start(); } catch (e) {}
    const masterChorus = new Tone.Chorus({
      frequency: 4, delayTime: 3.5, depth: 0.7, feedback: 0.1, wet: 0,
    }).connect(masterTremolo);
    try { masterChorus.start(); } catch (e) {}
    const masterVibrato = new Tone.Vibrato({
      frequency: 5, depth: 0.3, wet: 0,
    }).connect(masterChorus);
    const masterPhaser = new Tone.Phaser({
      frequency: 0.5, octaves: 3, baseFrequency: 350, wet: 0,
    }).connect(masterVibrato);
    const masterAutoFilter = new Tone.AutoFilter({
      frequency: 1, depth: 1, baseFrequency: 200, octaves: 2.6, wet: 0,
    }).connect(masterPhaser);
    try { masterAutoFilter.start(); } catch (e) {}
    const masterDistortion = new Tone.Distortion({
      distortion: 0, wet: 1,
    }).connect(masterAutoFilter);
    // Soft master compressor — sits between masterBus and the FX chain to
    // smoothly absorb peak overlap from sequential / overlapping voices
    // before they reach the brick -1 dB limiter, which would otherwise
    // clip pure tones (sines especially) into audible harmonic crunch.
    // Very fast release (30 ms) so gain reduction recovers within a
    // single step, keeping loop iterations consistent — the prior
    // compressor was removed for this exact reason but had a much longer
    // release. Soft knee + 4:1 ratio = transparent on chord stacks,
    // catches the sine-tail-into-attack peaks that cause crunch.
    const masterCompressor = new Tone.Compressor({
      threshold: -6, ratio: 4, attack: 0.003, release: 0.03, knee: 8,
    }).connect(masterDistortion);
    const masterBus = new Tone.Gain(1).connect(masterCompressor);

    // ---- Master-bus oscilloscope ----
    // Single Tone.Analyser tapped on masterBus (post all sources, pre
    // compressor / FX / volume / limiter). Draws a thin waveform in the
    // footer transport so the user has a live visual confirmation that
    // audio is flowing — handy for spotting dropouts the moment they
    // happen instead of inferring them from silence. Uses rAF so the
    // canvas only redraws when the tab is visible; size is set in CSS.
    (function initMasterScope() {
      const canvas = document.getElementById('master-scope');
      if (!canvas || typeof Tone === 'undefined') return;
      const analyser = new Tone.Analyser('waveform', 512);
      try { masterBus.connect(analyser); } catch (e) {}
      const ctx = canvas.getContext('2d');
      let raf = 0;
      const draw = () => {
        // Sync canvas buffer width to its displayed width so the
        // waveform stays sharp when the viewport resizes. Only
        // re-set when it changes — assigning canvas.width clears
        // the canvas, so per-frame churn would also kill drawing.
        if (canvas.width !== canvas.clientWidth) canvas.width = canvas.clientWidth;
        const data = analyser.getValue();
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#4fd1c5';
        ctx.beginPath();
        const step = W / data.length;
        for (let i = 0; i < data.length; i++) {
          const v = data[i]; // -1..1
          const x = i * step;
          const y = (1 - v) * 0.5 * H;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        raf = requestAnimationFrame(draw);
      };
      // Pause draw when tab hidden (rAF already throttles, but this
      // prevents the analyser node from being polled when nobody's
      // looking — small CPU saving).
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancelAnimationFrame(raf);
        else if (!raf) draw();
      });
      draw();
    })();

    // ---- Configurable FX order ----
    // Single ordered list of effect IDs that drives both the master chain
    // (routed via rebuildMasterChain below) and each per-note chain
    // (built in playNote). The list defaults to the original hardcoded
    // order; the FX panel exposes ↑/↓ buttons that reorder it and persist
    // the result via globalFx.fxOrder.
    const FX_NAMES = ['distortion','autoFilter','phaser','vibrato','chorus','tremolo','delay','pingPong','reverb','autoPan'];
    const FX_LABELS = {
      distortion: 'Distortion', autoFilter: 'Auto Filter', phaser: 'Phaser',
      vibrato: 'Vibrato', chorus: 'Chorus', tremolo: 'Tremolo',
      delay: 'Delay', pingPong: 'Ping-Pong', reverb: 'Reverb', autoPan: 'Auto Pan',
    };
    const _masterFxNodes = {
      distortion: masterDistortion, autoFilter: masterAutoFilter, phaser: masterPhaser,
      vibrato: masterVibrato, chorus: masterChorus, tremolo: masterTremolo,
      delay: masterDelay, pingPong: masterPingPong, reverb: masterReverb,
      autoPan: masterAutoPan,
    };
    // Per-FX send bus. Lanes connect their per-lane send Gain nodes into
    // these buses; each bus feeds into its master FX node, which returns
    // to masterBus. Built lazily by rebuildMasterChain on first call.
    const fxSendBus = {};
    // Send/return wiring. Master chain is short and contains NO FX:
    //   masterBus → masterCompressor → masterVolume → masterLimiter → destination
    // Each master FX is a parallel return: per-lane send gains accumulate
    // into fxSendBus[name], which feeds the FX with wet=1 (always fully
    // wet — the per-lane send level controls how much of the lane signal
    // gets processed), and the FX output returns to masterBus to be summed
    // with dry signals. This avoids the multi-second graph-compile freeze
    // that happens when a new audio source connects into a deep, never-
    // used FX chain.
    //
    // fxOrder no longer affects audio (it had meaning only when FX were
    // in series). The order list UI is kept for backward compat but is
    // effectively cosmetic.
    function rebuildMasterChain() {
      try {
        try { masterCompressor.disconnect(); } catch (e) {}
        FX_NAMES.forEach(name => {
          const n = _masterFxNodes[name];
          if (n) { try { n.disconnect(); } catch (e) {} }
        });
        // Master series: compressor → volume (limiter / destination are
        // already wired downstream of volume at construction).
        masterCompressor.connect(masterVolume);
        // Parallel FX returns. Each FX is hard-wired wet=1 (the per-lane
        // send gain controls the wet AMOUNT now). Send bus → FX → masterBus.
        FX_NAMES.forEach(name => {
          const fx = _masterFxNodes[name];
          if (!fx) return;
          if (!fxSendBus[name]) fxSendBus[name] = new Tone.Gain(1);
          try { fxSendBus[name].disconnect(); } catch (e) {}
          try { fxSendBus[name].connect(fx); } catch (e) {}
          // Force the FX to always be fully wet; mix is controlled by the
          // per-lane send gain instead of the FX's wet param.
          try { if (fx.wet) fx.wet.value = 1; } catch (e) {}
          try { fx.connect(masterBus); } catch (e) {}
        });
      } catch (e) {}
    }

    // Pre-compile the audio graph at script load so the first user note
    // doesn't pay the AudioWorklet/synth-instantiation cost. The first
    // gesture (which actually resumes the AudioContext) just has to
    // unlock — all node compilation is already done.
    warmMasterChainOnce();

    // Persisted global effect mix — applied to every voice via the master
    // chain above. Loaded from localStorage so settings stick across reloads.
    const GLOBAL_FX_DEFAULTS = {
      reverb:             0,
      reverbSize:         70,
      reverbTone:         50,
      reverbOn:           true,
      delay:              0,
      delayTime:          250,
      delayFeedback:      40,
      delayOn:            true,
      distortion:         0,
      distortionOn:       true,
      chorus:             0,
      chorusFreq:         4,
      chorusDepth:        70,
      chorusOn:           true,
      vibrato:            0,
      vibratoFreq:        5,
      vibratoDepth:       30,
      vibratoOn:          true,
      tremolo:            0,
      tremoloFreq:        5,
      tremoloDepth:       70,
      tremoloOn:          true,
      phaser:             0,
      phaserFreq:         0.5,
      phaserOctaves:      3,
      phaserOn:           true,
      autoFilter:         0,
      autoFilterFreq:     1,
      autoFilterDepth:    100,
      autoFilterBaseFreq: 200,
      autoFilterOn:       true,
      pingPong:           0,
      pingPongTime:       250,
      pingPongFeedback:   30,
      pingPongOn:         true,
      autoPan:            0,
      autoPanFreq:        1,
      autoPanDepth:       100,
      autoPanOn:          true,
      // Configurable FX chain order — array of effect IDs (see FX_NAMES).
      // Drives both the master chain and per-note chains in playNote.
      fxOrder:            FX_NAMES.slice(),
    };
    const FX_ON_KEYS = ['reverbOn', 'delayOn', 'distortionOn', 'chorusOn', 'vibratoOn', 'tremoloOn', 'phaserOn', 'autoFilterOn', 'pingPongOn', 'autoPanOn'];
    const globalFx = (() => {
      try {
        const raw = JSON.parse(localStorage.getItem('sounds-global-fx') || '{}');
        const out = { ...GLOBAL_FX_DEFAULTS, fxOrder: FX_NAMES.slice() };
        Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => {
          if (k === 'fxOrder') {
            // Restore a saved order only if it's a valid permutation of
            // FX_NAMES — guards against schema drift if effect IDs
            // change and a stale stored order references unknown ones.
            if (Array.isArray(raw.fxOrder)
                && raw.fxOrder.length === FX_NAMES.length
                && raw.fxOrder.every(n => FX_NAMES.includes(n))
                && new Set(raw.fxOrder).size === FX_NAMES.length) {
              out.fxOrder = raw.fxOrder.slice();
            }
          } else if (FX_ON_KEYS.includes(k)) {
            if (typeof raw[k] === 'boolean') out[k] = raw[k];
          } else if (Number.isFinite(raw[k])) {
            out[k] = raw[k];
          }
        });
        return out;
      } catch (e) {
        return { ...GLOBAL_FX_DEFAULTS, fxOrder: FX_NAMES.slice() };
      }
    })();
    function applyGlobalFx() {
      // Send/return: master FX wets stay at 1 (always fully wet); the
      // per-lane send Gain controls how much signal goes IN to each FX.
      // applyGlobalFx now only writes FX shape parameters (room size,
      // delay time, LFO frequency, etc.) — those are still shared across
      // all lanes, since one project usually wants a consistent reverb
      // character even if each lane has its own send level.
      try {
        masterReverb.roomSize.value      = Math.max(0, Math.min(0.99, globalFx.reverbSize / 100));
        masterReverb.dampening.value     = 500 + Math.max(0, Math.min(100, globalFx.reverbTone)) * 95;
        masterDelay.delayTime.value      = Math.max(0.001, (globalFx.delayTime || 0) / 1000);
        masterDelay.feedback.value       = Math.max(0, Math.min(0.95, globalFx.delayFeedback / 100));
        // Distortion amount — kept at a moderate fixed value so the per-
        // lane "distortion send" slider behaves as a wet-mix amount.
        // Users who want softer / harder distortion can override via
        // globalFx.distortionDrive in a future iteration; for now this
        // is shared across all lanes.
        masterDistortion.distortion      = 0.4;

        masterChorus.frequency.value     = Math.max(0.01, globalFx.chorusFreq);
        masterChorus.depth               = Math.max(0, Math.min(1, globalFx.chorusDepth / 100));

        masterVibrato.frequency.value    = Math.max(0.01, globalFx.vibratoFreq);
        masterVibrato.depth.value        = Math.max(0, Math.min(1, globalFx.vibratoDepth / 100));

        masterTremolo.frequency.value    = Math.max(0.01, globalFx.tremoloFreq);
        masterTremolo.depth.value        = Math.max(0, Math.min(1, globalFx.tremoloDepth / 100));

        masterPhaser.frequency.value     = Math.max(0.01, globalFx.phaserFreq);
        masterPhaser.octaves             = Math.max(1, Math.min(7, globalFx.phaserOctaves));

        masterAutoFilter.frequency.value = Math.max(0.01, globalFx.autoFilterFreq);
        masterAutoFilter.depth.value     = Math.max(0, Math.min(1, globalFx.autoFilterDepth / 100));
        masterAutoFilter.baseFrequency   = Math.max(20, globalFx.autoFilterBaseFreq);

        masterPingPong.delayTime.value   = Math.max(0.001, (globalFx.pingPongTime || 0) / 1000);
        masterPingPong.feedback.value    = Math.max(0, Math.min(0.95, globalFx.pingPongFeedback / 100));

        masterAutoPan.frequency.value    = Math.max(0.01, globalFx.autoPanFreq);
        masterAutoPan.depth.value        = Math.max(0, Math.min(1, globalFx.autoPanDepth / 100));
      } catch (e) {}
      // Push live mix values to the live-press send gains so FX panel
      // sliders propagate to non-lane signals (cell presses, untracked
      // sequence playback). Lane sends are driven separately by
      // applyLaneSends and aren't affected.
      try { applyGlobalSendGains(); } catch (e) {}
      // Shape-param changes (room size, delay time, LFO freq, etc.) need
      // to reach every lane's already-built FX nodes too — wet stays the
      // same, but the FX character should update live. applyLaneSends
      // short-circuits cheaply when a lane has no active FX nodes.
      try {
        if (Array.isArray(lanes)) lanes.forEach(applyLaneSends);
      } catch (e) {}
    }
    function persistGlobalFx() {
      localStorage.setItem('sounds-global-fx', JSON.stringify(globalFx));
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Live-press send tap. After the master chain refactored to a
    // send/return model, only signals that pass through a lane bus
    // reach the FX returns — live cell presses (no laneIdx) hit
    // masterBus directly and play fully dry. globalSendTap mirrors
    // the per-lane structure for non-lane signals: a dry path to
    // masterBus plus per-FX wet sends fed from globalFx[name] mix
    // values. Driven by applyGlobalSendGains, which applyGlobalFx
    // calls so FX panel slider changes propagate live.
    const globalSendTap = new Tone.Gain(1);
    globalSendTap.connect(masterBus);
    const _globalSendGains = {};
    function applyGlobalSendGains() {
      FX_NAMES.forEach(name => {
        const g = _globalSendGains[name];
        if (!g || !g.gain) return;
        const v = Math.max(0, Math.min(100, globalFx[name] || 0)) / 100;
        try { g.gain.value = v; } catch (e) {}
      });
    }

    applyGlobalFx();
    rebuildMasterChain();
    // Wire the global send gains AFTER rebuildMasterChain has populated
    // fxSendBus[name] with the actual return-bus Gain nodes.
    FX_NAMES.forEach(name => {
      const g = new Tone.Gain(0);
      try { globalSendTap.connect(g); } catch (e) {}
      if (fxSendBus[name]) {
        try { g.connect(fxSendBus[name]); } catch (e) {}
      }
      _globalSendGains[name] = g;
    });
    applyGlobalSendGains();

    // ---- Master volume slider ----
    // Slider value is 0..100 percent. 100 → 0 dB (unity), 0 → silenced
    // (-Infinity dB). The curve uses `Tone.gainToDb` so the slider feels
    // perceptually-even — equal-amplitude steps along the slider, not
    // equal dB. Persisted in localStorage so the level survives reloads.
    (function initMasterVolume() {
      const slider = document.getElementById('master-vol-slider');
      if (!slider) return;
      const KEY = 'sounds-master-vol';
      const saved = parseInt(localStorage.getItem(KEY) || '', 10);
      const initial = Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 100;
      slider.value = String(initial);
      const apply = (pct) => {
        const norm = Math.max(0, Math.min(100, pct | 0)) / 100;
        try {
          masterVolume.volume.value = norm <= 0 ? -Infinity : Tone.gainToDb(norm);
        } catch (e) {}
      };
      apply(initial);
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10) || 0;
        apply(v);
        try { localStorage.setItem(KEY, String(v)); } catch (e) {}
      });
    })();

