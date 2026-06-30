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
      // BPM drives rate/bar-based unit lengths — refresh the Bloom header readouts.
      try { if (typeof _ambSyncLayerUnits === 'function') { _ambSyncLayerUnits(_masterEng); _ambSyncLayerUnits(_laneEng); } } catch (e) {}
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
        const ds = tryMake(() => new Tone.Distortion({ distortion: 0.001, wet: 0.001, oversample: '4x' }));
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
    let _keepAliveOsc = null;     // persistent ref so the keeper node is never GC'd
    let _audioUnlocked = false;   // have we ever seen the context actually running?
    function startAudioKeepAlive() {
      let ac;
      try { ac = Tone.getContext().rawContext; } catch (e) { return; }
      if (!ac || ac.state !== 'running') return;
      _audioUnlocked = true;
      // Already have a live keeper on THIS context? Nothing to do.
      if (_keepAliveStarted && _keepAliveOsc && _keepAliveOsc.context === ac) return;
      // Tear down a stale keeper (e.g. the context was recreated) first.
      try { _keepAliveOsc && _keepAliveOsc.stop && _keepAliveOsc.stop(); } catch (e) {}
      try { _keepAliveOsc && _keepAliveOsc.disconnect && _keepAliveOsc.disconnect(); } catch (e) {}
      _keepAliveOsc = null;
      try {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        g.gain.value = 0;
        osc.frequency.value = 20;
        osc.connect(g);
        g.connect(ac.destination);
        osc.start();
        _keepAliveOsc = osc;
        _keepAliveStarted = true;
      } catch (e) {}
    }
    // Watchdog — a muted oscillator alone doesn't always stop newer iOS (and
    // some Android Chrome builds) from suspending an idle AudioContext after a
    // brief screen sleep / low-power blip. Once that happens EVERY tap pays the
    // ~0.5-1s resume cost, heard as constant per-press lag. While the page is
    // visible, poll a few times a second and immediately resume + reattach the
    // keeper the moment the context drops to 'suspended', so taps keep landing
    // on the warm path. Only resumes after the first gesture has unlocked audio
    // (an unprompted resume() before any gesture just rejects). Cheap no-op when
    // the context is already running with a live keeper.
    let _keepAliveWatchdog = null;
    (function _ensureKeepAliveWatchdog() {
      if (_keepAliveWatchdog != null) return;
      _keepAliveWatchdog = setInterval(() => {
        if (document.hidden) return;
        let ac;
        try { ac = Tone.getContext().rawContext; } catch (e) { return; }
        if (!ac) return;
        if (ac.state === 'suspended') {
          if (!_audioUnlocked) return;          // no gesture yet — don't fight iOS
          try {
            const p = ac.resume && ac.resume();
            if (p && typeof p.then === 'function') p.then(() => startAudioKeepAlive(), () => {});
            else startAudioKeepAlive();
          } catch (e) {}
        } else if (ac.state === 'running') {
          startAudioKeepAlive();                // (re)attach a keeper if missing
        }
      }, 500);
    })();
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

    // Final true-peak ceiling: a transparent soft-knee clipper. Below the
    // knee (|x| < 0.8) it is exactly identity — no tone change, taps stay
    // full — and above it the signal rolls smoothly to a hard 0.95 ceiling,
    // so overlapping voices physically cannot exceed it (no destination
    // clip/crunch). Being instantaneous waveshaping, it adds NO time-varying
    // gain, so unlike a fast compressor/limiter it never pumps. This is what
    // lets the master compressor below stay gentle: peak safety lives here,
    // glue lives there. Inputs beyond ±1 clamp to ±ceil by the curve's domain.
    // Knee at 0.90 so the clipper is pure identity for any single/moderate
    // signal (which, with the masterBus headroom trim below, peaks well under
    // it) and only rounds the rare overlap peak. A lower knee waveshaped hot
    // single notes and audibly distorted dense playback.
    // Knee 0.85 (single/moderate notes pass identity). Above it the curve rolls
    // to a hard CEIL, but the tanh's INPUT width (_MASTER_CLIP_SOFT) is decoupled
    // from the small output span and made WIDE (0.6) so the rare dense-overlap
    // peak (measured ~1.3–1.4 after the limiter, which has no lookahead to catch
    // onset transients) saturates GRADUALLY — warm, low-order harmonics — instead
    // of slamming the old 0.07-wide wall, which fizzed into audible hard-clip
    // distortion at phrase ends. e.g. 1.4 → ~0.94 smoothly; 0.84 → identity.
    const _MASTER_CLIP_KNEE = 0.85, _MASTER_CLIP_CEIL = 0.97, _MASTER_CLIP_SOFT = 0.6;
    // Named so the Dynamics UI can swap it for an identity map (bypass) live.
    const _masterClipCurve = (x) => {
      const s = x < 0 ? -1 : 1, ax = Math.abs(x);
      if (ax <= _MASTER_CLIP_KNEE) return x;
      const span = _MASTER_CLIP_CEIL - _MASTER_CLIP_KNEE;
      return s * (_MASTER_CLIP_KNEE + span * Math.tanh((ax - _MASTER_CLIP_KNEE) / _MASTER_CLIP_SOFT));
    };
    const masterClipper = new Tone.WaveShaper(_masterClipCurve, 4096);
    // 2x (not 4x) oversampling: the curve is identity below the 0.85 knee, so
    // oversampling only matters for the rare peak it soft-clips — 2x handles that
    // inaudibly while halving this always-on master waveshaper's CPU (4x ran the
    // whole mix through 4x up/down-sampling every sample, a fixed drain that, with
    // dense FX-heavy Bloom stacks, contributed to glitching).
    try { masterClipper.oversample = '2x'; } catch (e) {}
    // Master FADE — the FINAL output gain. A fade-in (on play) / fade-out (on
    // capture Finalize) ramps this, so it affects ALL audio AND is included in a
    // capture (the recorder taps this node via _ambMasterTapNode). 1 = full.
    const masterFade = new Tone.Gain(1);
    masterClipper.connect(masterFade);
    masterFade.toDestination();
    // Shape the fade's progress toward its target. t (0..1 normalized time) →
    // shaped progress (0..1). Direction-aware so a named curve sounds the same
    // fading IN or OUT: 'exponential' always lingers near silence (gentle),
    // 'logarithmic' always moves fast near silence (abrupt), 's-curve' eases both
    // ends, 'linear' is a constant slope.
    function _masterFadeProgress(shape, t, rising) {
      const easeIn = t * t;                      // slow start, fast finish
      const easeOut = 1 - (1 - t) * (1 - t);     // fast start, slow finish
      switch (shape) {
        case 'exponential': return rising ? easeIn : easeOut;
        case 'logarithmic': return rising ? easeOut : easeIn;
        case 's-curve':     return t * t * (3 - 2 * t);
        default:            return t;            // linear
      }
    }
    // Ramp the master fade gain. masterFadeIn starts from silence; masterFadeOut
    // ramps from the current level to 0; masterFadeReset snaps back to full (so a
    // prior fade-out can never leave the next play silent). All no-op if the node
    // never built. Times are seconds; <=0 applies instantly. `shape` picks the
    // fade curve (linear | exponential | logarithmic | s-curve; default linear).
    function masterFadeTo(target, seconds, fromZero, shape) {
      if (typeof masterFade === 'undefined' || !masterFade) return;
      try {
        const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
        const s = Math.max(0, +seconds || 0);
        const g = masterFade.gain;
        const start = fromZero ? 0 : (g.value != null ? g.value : 1);
        g.cancelScheduledValues(now);
        if (s <= 0.005) { g.setValueAtTime(target, now); return; }
        const sh = shape || 'linear';
        if (sh === 'linear' || typeof g.setValueCurveAtTime !== 'function') {
          g.setValueAtTime(start, now);
          g.linearRampToValueAtTime(target, now + s);
          return;
        }
        // Non-linear curve: build the whole gain trajectory as a value curve. A
        // value curve (vs. exponentialRamp) can touch 0, so fades to/from silence
        // work, and it lets us shape progress per-direction (see above).
        const rising = target >= start;
        const N = 64, curve = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const t = i / (N - 1);
          curve[i] = start + (target - start) * _masterFadeProgress(sh, t, rising);
        }
        curve[0] = start; curve[N - 1] = target;   // pin exact endpoints
        g.setValueCurveAtTime(curve, now, s);
      } catch (e) {}
    }
    function masterFadeIn(seconds, shape) { masterFadeTo(1, seconds, true, shape); }
    function masterFadeOut(seconds, shape) { masterFadeTo(0, seconds, false, shape); }
    function masterFadeReset() { masterFadeTo(1, 0, false); }
    // Master bus dynamics: a GENTLE glue compressor softens broad dynamic
    // swings, then the soft-knee clipper above guarantees the true-peak
    // ceiling. The limiter stays as belt-and-suspenders before the clipper.
    // Earlier this stage was aggressive (-6 dB / 4:1 / 30 ms release), which
    // pumped audibly: a stream of sequenced steps sat above threshold and the
    // ultra-fast release re-ducked on every note onset, so lane/Game/Prog
    // playback came out quieter and "gated" versus dry grid taps. With real
    // peak safety now in the clipper, the compressor only needs to be a light
    // glue (see settings below) and the pumping is gone.
    // Threshold -3 dBFS (not -1): at -1 the limiter sat right at the clipper's
    // 0.9 knee, so accumulating release tails over a phrase reached the clipper
    // at ~1.6 (measured) and waveshaped into audible distortion at phrase ends.
    // -3 gives the limiter room to catch the sustained accumulation — dense
    // multi-lane phrases now reach the clipper at ~1.0 (gentle soft-clip) instead
    // of 1.6, while single / moderate notes (peak ~-4.7 dBFS, below threshold)
    // stay transparent. Residual ~1.0 transient onsets (no lookahead) get only a
    // ~0.3 dB soft-clip — inaudible vs. the old ~3 dB hard squash.
    const masterLimiter = new Tone.Limiter(-3).connect(masterClipper);
    // Master volume — sits right before the limiter so the slider scales
    // the entire mix (Bloops + per-track output + global FX tails) but
    // can't push the signal above the limiter's -1 dB ceiling. Volume of
    // 0 dB at unity; the UI slider drives this in dB.
    const masterVolume = new Tone.Volume(0).connect(masterLimiter);

    // ---- True lookahead brickwall limiter (AudioWorklet) -------------------
    // The Tone.Limiter / soft-clipper above are FEEDFORWARD (no lookahead), so a
    // momentary in-phase overlap peak (a step's release tail + the next step's
    // attack at the same pitch reaches ~1.0 — measured) slips past them and the
    // clipper soft-saturates it: audible as distortion "between steps", worst on
    // a pure sine. A lookahead limiter delays the signal a few ms and reduces the
    // gain BEFORE the peak emerges, catching it transparently — so we can keep
    // full per-voice loudness (masterBus back to 0.6) and still never clip.
    //
    // Inserted as masterVolume → worklet → masterClipper (replacing the Tone
    // limiter in the live path). Ceiling 0.84 sits just under the clipper's 0.85
    // knee, so the clipper stays identity on the limiter's output and only acts
    // as a final hard safety. If the worklet can't load (very old browser), the
    // original Tone-limiter + clipper chain remains as the fallback.
    let masterLookaheadLimiter = null;
    (function installLookaheadLimiter() {
      const rawCtx = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
      if (!rawCtx || !rawCtx.audioWorklet || typeof rawCtx.audioWorklet.addModule !== 'function') return;
      const code = `
        class LookaheadLimiter extends AudioWorkletProcessor {
          constructor(opt){
            super();
            const o=(opt&&opt.processorOptions)||{};
            this.ceil=o.ceiling||0.84;
            this.look=Math.max(1,Math.round((o.lookaheadMs||3)/1000*sampleRate));
            this.relC=Math.exp(-1/((o.releaseMs||90)/1000*sampleRate));     // peak-hold release
            this.gAtt=Math.exp(-1/((o.gainAttackMs||0.4)/1000*sampleRate));  // gain-reduce smoothing
            this.gRel=Math.exp(-1/((o.gainReleaseMs||90)/1000*sampleRate));  // gain-recover smoothing
            this.L=this.look+1; this.wi=0; this.delay=null; this.peak=0; this.gain=1;
            this.port.onmessage=(e)=>{ const d=e&&e.data; if(d&&typeof d.ceiling==='number'&&d.ceiling>0) this.ceil=d.ceiling; };
          }
          process(inputs,outputs){
            const inp=inputs[0], out=outputs[0];
            if(!inp||inp.length===0) return true;
            const ch=inp.length, n=inp[0].length, L=this.L, look=this.look;
            if(!this.delay||this.delay.length!==ch){ this.delay=[]; for(let c=0;c<ch;c++) this.delay.push(new Float32Array(L)); }
            for(let i=0;i<n;i++){
              let p=0; for(let c=0;c<ch;c++){ const a=Math.abs(inp[c][i]); if(a>p)p=a; }
              // peak hold: instant attack, exp release — keeps the gain ducked
              // across the lookahead window so the upcoming peak is covered.
              this.peak = (p>this.peak) ? p : (p+(this.peak-p)*this.relC);
              const target = this.peak>this.ceil ? this.ceil/this.peak : 1;
              // smooth the gain (fast when reducing, slower when recovering)
              this.gain = (target<this.gain) ? target+(this.gain-target)*this.gAtt
                                             : target+(this.gain-target)*this.gRel;
              const ri=(this.wi+L-look)%L;
              for(let c=0;c<ch;c++){ const buf=this.delay[c]; const d=buf[ri]; buf[this.wi]=inp[c][i]; out[c][i]=d*this.gain; }
              this.wi=(this.wi+1)%L;
            }
            return true;
          }
        }
        registerProcessor('bloops-lookahead-limiter', LookaheadLimiter);`;
      let url;
      try { url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' })); } catch (e) { return; }
      rawCtx.audioWorklet.addModule(url).then(() => {
        let node;
        // Tone v14 wraps the AudioContext (standardized-audio-context), so the
        // native `new AudioWorkletNode(rawCtx, …)` constructor rejects it. Use
        // Tone's own factory, which returns a node wired into Tone's graph.
        try {
          node = Tone.context.createAudioWorkletNode('bloops-lookahead-limiter', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
            processorOptions: { ceiling: 0.84, lookaheadMs: 3, releaseMs: 90 },
          });
        } catch (e) { return; }
        try {
          // Rewire: masterVolume → worklet → masterClipper (drop the Tone limiter
          // from the live path). Keep the Tone limiter object alive as fallback.
          masterVolume.disconnect();
          try { masterLimiter.disconnect(); } catch (e) {}
          masterVolume.connect(node);                 // Tone → native (Tone handles it)
          Tone.connect(node, masterClipper);          // native → Tone input
          masterLookaheadLimiter = node;
          try { applyMasterDynamics(); } catch (e) {}  // push any saved ceiling into the fresh worklet
        } catch (e) {
          // Rewire failed mid-way — restore the original feedforward chain.
          try { masterVolume.disconnect(); masterVolume.connect(masterLimiter); masterLimiter.connect(masterClipper); } catch (e2) {}
        }
        try { URL.revokeObjectURL(url); } catch (e) {}
      }).catch(() => { /* worklet unavailable — keep the Tone-limiter fallback */ });
    })();
    // Recorder worklet — taps the master output and posts raw PCM (batched) to
    // the main thread, so Bloom capture encodes WAV/MP3 directly and never relies
    // on decodeAudioData (which fails on some browsers' MediaRecorder output).
    // _bloopsRecorderReady flips true once the module is registered; capture
    // falls back to MediaRecorder until then / where worklets are unavailable.
    let _bloopsRecorderReady = false;
    (function installRecorderWorklet() {
      const rawCtx = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
      if (!rawCtx || !rawCtx.audioWorklet || typeof rawCtx.audioWorklet.addModule !== 'function') return;
      const code = `
        class BloopsRecorder extends AudioWorkletProcessor {
          constructor(){ super(); this.on=true; this.B=4096; this.l=new Float32Array(this.B); this.r=new Float32Array(this.B); this.f=0;
            this.port.onmessage=(e)=>{ if(e.data&&e.data.stop){ this.flush(); this.on=false; } }; }
          flush(){ if(this.f>0){ this.port.postMessage({ l:this.l.slice(0,this.f), r:this.r.slice(0,this.f) }); this.f=0; } }
          process(inputs){
            const inp=inputs[0];
            if(this.on&&inp&&inp.length){
              const a=inp[0], b=inp[1]||inp[0], n=a.length;
              for(let i=0;i<n;i++){ this.l[this.f]=a[i]; this.r[this.f]=b[i]; this.f++;
                if(this.f>=this.B){ this.port.postMessage({ l:this.l.slice(0), r:this.r.slice(0) }); this.f=0; } }
            }
            return true;
          }
        }
        registerProcessor('bloops-recorder', BloopsRecorder);`;
      let url;
      try { url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' })); } catch (e) { return; }
      rawCtx.audioWorklet.addModule(url).then(() => { _bloopsRecorderReady = true; try { URL.revokeObjectURL(url); } catch (e) {} }).catch(() => {});
    })();
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
    // ---- Convolution reverb (default; Freeverb kept as a selectable option) ----
    // A Tone.Convolver fed an algorithmically-generated stereo impulse response:
    // an exponentially-decaying, tone-filtered noise burst (independent L/R for
    // width). This sounds far smoother and lusher than Freeverb's comb/all-pass
    // network — the single biggest "pro" upgrade for ambient/Bloom tails. No
    // asset files: the IR is built at runtime from Reverb Size (→ decay seconds)
    // and Tone (→ IR damping). As a pure-wet send/return node it needs no
    // dry/wet mix (the per-lane send gain sets the amount).
    //   size%  → 0.30 .. 8.0 s decay   tone% → IR low-pass 0.8 .. 13 kHz
    function _reverbDecaySec(sizePct) { return 0.3 + Math.max(0, Math.min(100, sizePct)) / 100 * 7.7; }
    function _reverbToneNorm(tonePct) { return Math.max(0, Math.min(100, tonePct)) / 100; }
    function _makeReverbIR(decaySec, toneNorm) {
      const ac = Tone.getContext().rawContext;
      const sr = ac.sampleRate || 44100;
      const len = Math.max(1, Math.floor(Math.max(0.15, decaySec) * sr));
      const buf = ac.createBuffer(2, len, sr);
      const tau = Math.max(0.05, decaySec) / 6.9;            // -60 dB at decaySec
      const cut = 800 + Math.max(0, Math.min(1, toneNorm)) * 12200;  // IR damping LP, Hz
      const a = Math.exp(-2 * Math.PI * cut / sr);           // one-pole LP coef
      let peak = 0;
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const n = Math.random() * 2 - 1;
          lp = (1 - a) * n + a * lp;                         // lowpass the noise (tone)
          const env = Math.exp(-t / tau);
          const build = Math.min(1, t / 0.008);              // tiny onset build to avoid a click
          const v = lp * env * build;
          d[i] = v;
          const av = v < 0 ? -v : v;
          if (av > peak) peak = av;
        }
      }
      if (peak > 0) { const g = 0.9 / peak; for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] *= g; } }
      return buf;
    }
    const masterConvolver = new Tone.Convolver({ normalize: true });
    try { masterConvolver.buffer = _makeReverbIR(_reverbDecaySec(70), _reverbToneNorm(50)); } catch (e) {}
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
      distortion: 0, wet: 1, oversample: '4x',   // anti-alias the drive (no shrill harmonics)
    }).connect(masterAutoFilter);
    // Gentle glue compressor — sits between masterBus and the FX chain. It
    // only catches broad level swings; true-peak protection is the soft-knee
    // clipper at the end of the chain, so this no longer has to clamp hard.
    // High threshold (-3 dB) + low ratio (2:1) keep typical playback BELOW or
    // barely into the knee, and the slower 180 ms release means it doesn't
    // re-duck on every step's onset (which is what made sequenced playback
    // pump / sound quiet + gated under the old -6/4:1/30 ms settings). Net
    // measured gain reduction on a dense overlapping stream dropped from
    // ~-2.8 dB (range 4.6 dB of pumping) to ~-0.5 dB (range <1 dB).
    const masterCompressor = new Tone.Compressor({
      threshold: -3, ratio: 2, attack: 0.005, release: 0.18, knee: 10,
    }).connect(masterDistortion);
    // Master input headroom. Every entry bus (globalSendTap, per-lane buses)
    // and all FX returns sum here, so a single voice already peaks near full
    // scale — leaving NO room for overlap. When several voices stack (chords,
    // dense sequences, and especially now that sequenced steps sustain for
    // their whole step + release tail, so tails overlap the next steps) the
    // sum slammed the soft-clip ceiling and waveshaped into audible distortion.
    // 0.6 (~-4.4 dB): a single voice sits ~0.58. Even a 2x COHERENT overlap (one
    // note's release tail + the next note's attack at the SAME pitch) reaches
    // ~1.0 pre-clip, which a feedforward limiter can't catch. That's now handled
    // by the true LOOKAHEAD limiter below (masterVolume → worklet), which ducks
    // before the peak — so the trim can stay at 0.6 for full loudness AND stay
    // clean. Master Volume scales on top.
    const masterBus = new Tone.Gain(0.6).connect(masterCompressor);

    // ---- Master Warmth stage --------------------------------------------------
    // Tone-shaping inserted between masterBus and the glue compressor to round
    // off shrill highs and add body, globally (one place, not per-mode). Chain:
    //   low-shelf lift → presence dip (~3 kHz) → high-shelf cut → soft saturation
    //   (oversampled, even-harmonic warmth) → high-cut LPF (fizz).
    // A single "Warmth" macro scales the EQ moves; Drive + High-cut are separate.
    // All driven by globalFx (warmth/warmthDrive/warmthCut/warmthOn) via
    // applyMasterWarmth(); neutral when off (gains 0, identity curve, cut wide).
    function _warmthCurve(drv) {
      const n = 2048, curve = new Float32Array(n);
      const k = 1 + Math.max(0, Math.min(1, drv)) * 4;   // drive factor 1..5
      const norm = Math.tanh(k) || 1;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = (drv <= 0) ? x : Math.tanh(k * x) / norm;  // soft tanh sat, peak-normalized
      }
      return curve;
    }
    const masterWarmthLow  = new Tone.Filter({ type: 'lowshelf',  frequency: 160,  gain: 0 });
    const masterWarmthPres = new Tone.Filter({ type: 'peaking',   frequency: 3000, Q: 1, gain: 0 });
    const masterWarmthHigh = new Tone.Filter({ type: 'highshelf', frequency: 7000, gain: 0 });
    const masterWarmthDrive = new Tone.WaveShaper(_warmthCurve(0), 2048);
    try { masterWarmthDrive.oversample = '4x'; } catch (e) {}   // avoid aliased (shrill) harmonics
    const masterWarmthCut  = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.5 });
    masterWarmthLow.connect(masterWarmthPres);
    masterWarmthPres.connect(masterWarmthHigh);
    masterWarmthHigh.connect(masterWarmthDrive);
    masterWarmthDrive.connect(masterWarmthCut);
    masterWarmthCut.connect(masterCompressor);
    // ---- DC blocker + sub-rumble high-pass ----
    // Asymmetric / waveshaped voices leave a DC offset (wastes headroom, can
    // thump) and sub-30 Hz energy from low oscillators + reverb muddies the low
    // end and steals loudness. A gentle 2-pole high-pass at ~28 Hz blocks both
    // for a tighter, cleaner bottom without touching the audible range. Sits at
    // the very front of the master chain so everything benefits.
    const masterDCBlock = new Tone.Filter({ type: 'highpass', frequency: 28, Q: 0.707 });
    masterBus.disconnect();                 // was masterBus → masterCompressor
    masterBus.connect(masterDCBlock);       // now masterBus → DC/HPF → warmth → masterCompressor
    masterDCBlock.connect(masterWarmthLow);

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
    //   masterBus → masterCompressor → masterVolume → masterLimiter → masterClipper → masterFade → destination
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

    // ---- Reverb type (convolution vs Freeverb) ----------------------------
    // The active reverb node in the parallel FX send/return is swappable:
    // _masterFxNodes.reverb points at either masterConvolver (default) or
    // masterReverb (Freeverb), and rebuildMasterChain rewires the send bus to
    // whichever is current. Regenerating the convolution IR rebuilds an
    // AudioBuffer, so it's debounced off the Size/Tone sliders.
    let _irTimer = null, _irKey = '';
    function _scheduleMasterIR() {
      const decay = _reverbDecaySec(globalFx ? globalFx.reverbSize : 70);
      const tone  = _reverbToneNorm(globalFx ? globalFx.reverbTone : 50);
      const key = decay.toFixed(2) + '/' + tone.toFixed(2);
      if (key === _irKey) return;       // no change → skip the rebuild
      _irKey = key;
      if (_irTimer) clearTimeout(_irTimer);
      _irTimer = setTimeout(() => {
        try { masterConvolver.buffer = _makeReverbIR(decay, tone); } catch (e) {}
      }, 120);
    }
    function setMasterReverbType(type) {
      const t = (type === 'freeverb') ? 'freeverb' : 'convolution';
      if (globalFx) globalFx.reverbType = t;
      _masterFxNodes.reverb = (t === 'freeverb') ? masterReverb : masterConvolver;
      try { rebuildMasterChain(); } catch (e) {}
      try { applyGlobalFx(); } catch (e) {}   // reapply params (regenerates IR if convolution)
    }
    // Reflect + (once) wire the FX-panel reverb-type toggle. Idempotent so the
    // several panel binders can all call it without double-binding.
    function _wireReverbTypeToggle(panel) {
      if (!panel || typeof panel.querySelector !== 'function') return;
      const btn = panel.querySelector('#fx-rev-type');
      if (!btn) return;
      const reflect = () => {
        const fv = (globalFx && globalFx.reverbType === 'freeverb');
        btn.textContent = fv ? 'Freeverb' : 'Convolution';
        btn.classList.toggle('alt', fv);
      };
      reflect();
      if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          setMasterReverbType((globalFx && globalFx.reverbType === 'freeverb') ? 'convolution' : 'freeverb');
          reflect();
          try { persistGlobalFx(); } catch (e) {}
          // Bloom engines rebuild their own reverb lazily to match (see 17).
          try { if (typeof _ambOnReverbTypeChanged === 'function') _ambOnReverbTypeChanged(); } catch (e) {}
        });
      }
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
      reverbType:         'convolution', // 'convolution' (lush, default) | 'freeverb' (classic comb)
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
      // Master Warmth stage — OFF by default (its saturation was audibly
      // distorting sounds). warmth = macro (tilt EQ + presence dip),
      // warmthDrive = soft saturation, warmthCut = high-cut LPF (Hz). Turn it on
      // in Settings → Warmth when you want the rounding/glue.
      warmth:             30,
      warmthDrive:        12,
      warmthCut:          16000,
      warmthOn:           false,
      // Master DYNAMICS — the master-bus glue compressor + lookahead limiter +
      // soft-clip ceiling. Defaults match the tuned chain; exposed so the mix can
      // be made less compressed. *On=false bypasses that stage (made transparent,
      // no rerouting). Global: affects ALL output.
      compOn:             true,
      compThresh:         -3,    // dBFS
      compRatio:          2,     // :1
      compAttack:         5,     // ms
      compRelease:        180,   // ms
      compKnee:           10,    // dB
      limitOn:            true,
      limitCeil:          -1.5,  // dBFS (≈ 0.84 linear — the limiter's ceiling)
      clipOn:             true,
      // Configurable FX chain order — array of effect IDs (see FX_NAMES).
      // Drives both the master chain and per-note chains in playNote.
      fxOrder:            FX_NAMES.slice(),
    };
    const FX_ON_KEYS = ['reverbOn', 'delayOn', 'distortionOn', 'chorusOn', 'vibratoOn', 'tremoloOn', 'phaserOn', 'autoFilterOn', 'pingPongOn', 'autoPanOn', 'warmthOn', 'compOn', 'limitOn', 'clipOn'];
    // Keys reset by the Dynamics "Reset" button.
    const DYN_KEYS = ['compOn', 'compThresh', 'compRatio', 'compAttack', 'compRelease', 'compKnee', 'limitOn', 'limitCeil', 'clipOn'];
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
        if (globalFx.reverbType === 'freeverb') {
          masterReverb.roomSize.value  = Math.max(0, Math.min(0.99, globalFx.reverbSize / 100));
          masterReverb.dampening.value = 500 + Math.max(0, Math.min(100, globalFx.reverbTone)) * 95;
        } else {
          _scheduleMasterIR();   // convolution: regenerate IR from size/tone (debounced)
        }
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
      try { applyMasterWarmth(); } catch (e) {}
      try { applyMasterDynamics(); } catch (e) {}
    }
    // Master dynamics: write the glue-compressor params, the lookahead-limiter
    // ceiling (and the Tone.Limiter fallback threshold), and the soft-clip curve
    // from globalFx. *On=false makes that stage transparent (no rerouting):
    // compressor → unity, limiter → ceiling off, soft-clip → identity map.
    function applyMasterDynamics() {
      const cl = (v, lo, hi, d) => { const n = Number.isFinite(v) ? v : d; return Math.max(lo, Math.min(hi, n)); };
      try {
        if (globalFx.compOn === false) {
          masterCompressor.ratio.value = 1; masterCompressor.threshold.value = 0;
        } else {
          masterCompressor.threshold.value = cl(globalFx.compThresh, -60, 0, -3);
          masterCompressor.ratio.value     = cl(globalFx.compRatio, 1, 20, 2);
          masterCompressor.attack.value    = cl(globalFx.compAttack, 0, 1000, 5) / 1000;
          masterCompressor.release.value   = cl(globalFx.compRelease, 1, 2000, 180) / 1000;
          masterCompressor.knee.value      = cl(globalFx.compKnee, 0, 40, 10);
        }
      } catch (e) {}
      try {
        const on = globalFx.limitOn !== false;
        const ceilDb = on ? cl(globalFx.limitCeil, -24, 0, -1.5) : 0;       // 0 dBFS ≈ transparent
        const ceilLin = on ? Math.pow(10, ceilDb / 20) : 4;                // worklet: huge ceiling = off
        masterLimiter.threshold.value = ceilDb;                            // fallback path (no worklet)
        if (masterLookaheadLimiter && masterLookaheadLimiter.port) {
          try { masterLookaheadLimiter.port.postMessage({ ceiling: ceilLin }); } catch (e) {}
        }
      } catch (e) {}
      try { masterClipper.setMap(globalFx.clipOn === false ? ((x) => x) : _masterClipCurve); } catch (e) {}
    }
    try { applyMasterDynamics(); } catch (e) {}   // apply saved dynamics on boot
    // Apply the Master Warmth settings (globalFx.warmth/warmthDrive/warmthCut/
    // warmthOn) to the warmth node chain. The single Warmth macro scales the
    // tilt EQ + presence dip; Drive sets the saturation; High-cut the LPF.
    // Neutral (transparent) when warmthOn is false.
    function applyMasterWarmth() {
      try {
        const on  = globalFx.warmthOn !== false;
        const w   = on ? Math.max(0, Math.min(100, globalFx.warmth      || 0)) / 100 : 0;
        const drv = on ? Math.max(0, Math.min(100, globalFx.warmthDrive || 0)) / 100 : 0;
        const cut = on ? Math.max(2000, Math.min(20000, globalFx.warmthCut || 16000)) : 20000;
        masterWarmthLow.gain.value  = w * 2.5;   // low-shelf lift @160 Hz (body)
        masterWarmthPres.gain.value = -(w * 3);  // presence dip @3 kHz (harshness)
        masterWarmthHigh.gain.value = -(w * 4);  // high-shelf cut @7 kHz (air)
        masterWarmthCut.frequency.value = cut;   // high cut (fizz)
        masterWarmthDrive.curve = _warmthCurve(drv);
      } catch (e) {}
    }
    // Apply the persisted/default warmth now so sounds come up rounded on boot.
    try { applyMasterWarmth(); } catch (e) {}
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

    // ---- Lane sum bus: headroom that scales with the playing-lane count ----
    // Every sequenced lane's dry output (volume → panner → FX → here) sums into
    // laneSumBus before masterBus. Its gain is set to 1/sqrt(N) for N sounding
    // lanes, so N uncorrelated lanes sum to roughly the same level as one — the
    // fix for "runaway summing" where stacking lanes overran the static masterBus
    // trim and slammed the clipper into distortion. Live grid taps (globalSendTap,
    // no laneIdx) bypass this and stay full-level. Set on play / mute / solo.
    const laneSumBus = new Tone.Gain(1);
    laneSumBus.connect(masterBus);
    function setLaneSumCompensation(n) {
      const t = 1 / Math.sqrt(Math.max(1, n | 0));
      try {
        if (laneSumBus.gain.rampTo) laneSumBus.gain.rampTo(t, 0.04);
        else laneSumBus.gain.value = t;
      } catch (e) {}
    }
    // Count lanes that will actually sound (solo wins; else non-muted), among
    // step-bearing non-Bloom lanes — the ones that sum through laneSumBus.
    function _soundingLaneCount() {
      if (typeof lanes === 'undefined' || !Array.isArray(lanes)) return 1;
      const playable = lanes.filter(l => l && Array.isArray(l.steps) && l.steps.length > 0 && !l.ambientMode);
      const anySolo = playable.some(l => l.solo);
      const sounding = playable.filter(l => anySolo ? l.solo : !l.muted);
      return Math.max(1, sounding.length);
    }
    function updateLaneSumCompensation() { setLaneSumCompensation(_soundingLaneCount()); }
    const _globalSendGains = {};
    function applyGlobalSendGains() {
      FX_NAMES.forEach(name => {
        const g = _globalSendGains[name];
        if (!g || !g.gain) return;
        const v = Math.max(0, Math.min(100, globalFx[name] || 0)) / 100;
        try { g.gain.value = v; } catch (e) {}
      });
    }

    // Point the parallel FX reverb at the configured engine (convolution by
    // default) before the chain is wired so the right node is in the return.
    _masterFxNodes.reverb = (globalFx.reverbType === 'freeverb') ? masterReverb : masterConvolver;
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

