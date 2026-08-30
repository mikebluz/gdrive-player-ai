// 00-native-audio.js — background-audio routing for the native (Capacitor) shell.
//
// Measured on-device (iPhone 12 Pro, 2026-08-29, the _bgaudio.html probe):
//   - A bare AudioContext is SUSPENDED by WebKit the moment the app is
//     backgrounded or the screen locks, whatever the native audio session says.
//   - The SAME graph keeps rendering at 100% of wall clock — JS timers
//     included — when its output feeds a MediaStreamDestination consumed by a
//     playing <audio> element. The playing media element IS the keep-alive.
//   - A silent media element merely playing ALONGSIDE the graph is not enough
//     (probe mode D): the app stays alive but the context is suspended anyway.
//
// So in the native shell, the ONE audible path is:
//   everything → Tone.getDestination().input → .output ⇒ MediaStream → <audio>
// The reroute is a single cut at Tone.Destination's output — the chokepoint
// every .toDestination() source already funnels through — so no call site
// changes. Direct raw-context connections (silent keep-alives, the worklet
// keep-pull, interactive previews) still reach the speakers on their own path;
// they are independent sounds, not copies of the mix, so nothing doubles.
//
// Inert everywhere but the shell: gated on Capacitor.isNativePlatform().
// Escape hatches: localStorage bloopsNativeAudio '0' disables in the shell,
// '1' forces it on the web (for headless testing of this very file).
(function () {
  'use strict';

  function wanted() {
    let pref = null;
    try { pref = localStorage.getItem('bloopsNativeAudio'); } catch (e) {}
    if (pref === '0') return false;
    if (pref === '1') return true;
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }
  if (!wanted()) return;

  const _flight = [];
  const log = (m) => {
    try { console.log('[native-audio] ' + m); } catch (e) {}
    try {
      _flight.push(Date.now() + ' ' + m);
      if (_flight.length > 600) _flight.splice(0, _flight.length - 600);
    } catch (e) {}
  };
  // flush the flight log to Documents so ordinary use leaves a harvestable
  // record — no more scheduled tests
  setInterval(() => {
    try {
      const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!FS || !_flight.length) return;
      FS.writeFile({
        path: 'bloops-flight.json', directory: 'DOCUMENTS', encoding: 'utf8',
        data: JSON.stringify({ at: Date.now(), lines: _flight }),
      }).catch(() => {});
    } catch (e) {}
  }, 20000);

  let rig = null;   // { el, streamDest } once installed

  function install() {
    if (rig) return true;
    if (!window.Tone || !Tone.getDestination) return false;
    let d, raw;
    try { d = Tone.getDestination(); raw = Tone.getContext().rawContext; } catch (e) { return false; }
    if (!d || !raw || !raw.createMediaStreamDestination) return false;

    // Tone 14.9.17: Destination is input(Volume) → output(Gain) → raw destination.
    // Cut after output so every .toDestination() source rides along untouched.
    const out = d.output;
    if (!out || typeof out.connect !== 'function') { log('NO d.output — cannot reroute'); return false; }

    const streamDest = raw.createMediaStreamDestination();
    // THE BRIDGE (measured, probe mode X): a Tone/standardized-audio-context
    // context is singled out by WebKit and interrupted at every screen lock —
    // the ~100 ms stall starves the media element and its adaptive resampler
    // bends pitch audibly. A PLAIN native context never gets interrupted. So
    // the element hangs off a plain bridge context fed from Tone's context by
    // MediaStream: the Tone side still stalls-and-rescues (the engine keeps
    // composing), but the element's feed renders continuously — the stall
    // arrives as clean in-stream silence, nothing for a resampler to chase.
    let maskGain = null, bridge = null, elStream = streamDest.stream, nativeArmed = false;
    let bridgeRefs = null;
    let armMse = () => Promise.resolve(false);
    let armNativePlugin = () => {};
    const f0ref = { fn: null };
    try {
      out.disconnect();            // severs output → rawContext.destination
      maskGain = raw.createGain(); // the resume-seam mask point (graph-side)
      out.connect(maskGain);
      maskGain.connect(streamDest);
      bridge = new (window.AudioContext || window.webkitAudioContext)();
      const bSrc = bridge.createMediaStreamSource(streamDest.stream);
      bridgeRefs = { bSrc: bSrc };
      window.__bloopsBridgeSrc = bSrc;
      const bDest = bridge.createMediaStreamDestination();
      bridgeRefs.bDest = bDest; bridgeRefs.bridge = bridge;
      bSrc.connect(bDest);
      elStream = bDest.stream;                 // the element consumes the BRIDGE side
      if (bridge.state !== 'running') bridge.resume();

      // OUTPUT PREFERENCE 1 — MSE "radio station": encode the mix to AAC and
      // feed the element MEDIA DATA via ManagedMediaSource. Media-data
      // playback is the one class that survives an iOS lock smoothly (the
      // Drive player proves it on this phone); everything live-generated
      // glitches. Engaged async; until it resolves the stream path plays.
      armMse = () => {
        if (!window._bloopsMse) return Promise.resolve(false);
        // MSE gets its OWN element; the original element stays on the -40 dB
        // bridge stream as the CONTEXT KEEP-ALIVE (mode-B mechanism: a playing
        // stream-fed element is what stops WebKit suspending the contexts at
        // lock — its loss is why production died in the first flight harvest).
        const mseEl = new Audio();
        try { mseEl.style.display = 'none'; document.body.appendChild(mseEl); } catch (e) {}
        for (const evn of ['playing', 'pause', 'ended', 'waiting', 'stalled', 'error']) {
          // w= is WALL ms (mod 1e6): a pause→playing pair 0.07 apart in media
          // time once hid a 1.2 s wall-time silence hole — always read both
          mseEl.addEventListener(evn, () => log('mseEl event: ' + evn + ' t=' + mseEl.currentTime.toFixed(2) + ' w=' + (Date.now() % 1000000)));
        }
        // a hang in any stage must never strand the app with NO audible path
        return Promise.race([
          window._bloopsMse.start(bridge, bSrc, mseEl, log),
          new Promise((res) => setTimeout(() => res(false), 8000)),
        ]);
      };
      // OUTPUT PREFERENCE 2 — when the BloopsAudio plugin exists, the AUDIBLE path is
      // AVAudioEngine — a worklet on the bridge context ships Int16 PCM over
      // the Capacitor bridge into a native ring buffer, and WebKit's
      // element→speaker pipeline (which manufactures the lock glitch) carries
      // only a −74 dB copy, kept solely because a consumed MediaStream is what
      // stops WebKit suspending the context and JS in the background.
      armNativePlugin = function () {
      try {
        const plug = window.__BLOOPS_MSE_ACTIVE ? null : (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BloopsAudio);
        if (!plug) log('BloopsAudio plugin ABSENT — plugins: ' + Object.keys((window.Capacitor && window.Capacitor.Plugins) || {}).join(','));
        if (plug) {
          const CHUNK = 4800;   // 100 ms @ 48 k
          bridge.audioWorklet.addModule(URL.createObjectURL(new Blob([
            "registerProcessor('bloops-tap', class extends AudioWorkletProcessor {" +
            "  constructor() { super(); this.buf = new Int16Array(" + (CHUNK * 2) + "); this.n = 0; }" +
            "  process(inputs) {" +
            "    const inp = inputs[0]; if (!inp || !inp[0]) return true;" +
            "    const L = inp[0], R = inp[1] || inp[0];" +
            "    for (let i = 0; i < L.length; i++) {" +
            "      let l = L[i] * 32767, r = R[i] * 32767;" +
            "      this.buf[this.n * 2] = l > 32767 ? 32767 : (l < -32768 ? -32768 : l);" +
            "      this.buf[this.n * 2 + 1] = r > 32767 ? 32767 : (r < -32768 ? -32768 : r);" +
            "      if (++this.n === " + CHUNK + ") {" +
            "        const out = this.buf.slice(0);" +
            "        this.port.postMessage(out.buffer, [out.buffer]);" +
            "        this.n = 0;" +
            "      }" +
            "    }" +
            "    return true;" +
            "  }" +
            "});"], { type: 'application/javascript' }))).then(() => {
            const tap = new AudioWorkletNode(bridge, 'bloops-tap');
            bSrc.connect(tap);
            // a worklet with no output still needs a pull path
            const pull = bridge.createGain(); pull.gain.value = 0;
            tap.connect(pull); pull.connect(bDest);
            // the element's copy drops to −74 dB: keep-alive, not speaker
            try {
              // −40 dB, NOT lower: WebKit's audible-playback test is what
              // keeps the page (and both contexts, and JS) alive at screen
              // lock, and −74 dB measured as "silent" to it — the page got
              // suspended and the native feed starved. At −40 the copy still
              // counts as audible while sitting far beneath the native mix;
              // whatever the element pipeline does to it at the lock is buried.
              const quiet = bridge.createGain(); quiet.gain.value = 0.01;
              bSrc.disconnect(bDest);
              bSrc.connect(quiet); quiet.connect(bDest);
            } catch (e) {}
            let chunks = 0, failed = 0;
            tap.port.onmessage = (ev) => {
              // ArrayBuffer → base64 without blowing the stack on big args
              const u8 = new Uint8Array(ev.data);
              let bin = '';
              for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
              plug.write({ data: btoa(bin) }).then(() => { chunks++; }, () => { failed++; });
            };
            plug.start({ sampleRate: bridge.sampleRate, bufferMs: 400 }).then(
              () => log('NATIVE OUTPUT armed — AVAudioEngine is the speaker now'),
              (e) => log('native output start failed: ' + (e && e.message))
            );
            window._nativeAudio._pcm = () => ({ chunks, failed });
            setInterval(() => { try { plug.stats(); } catch (e) {} }, 5000);
          }, (e) => log('tap worklet failed: ' + e.message));
        }
      } catch (e) { log('native output setup failed: ' + e.message); }
      };
      try { bridge.onstatechange = () => log('bridge state → ' + bridge.state); } catch (e) {}
      log('bridge context up (never-interrupted class)');
    } catch (e) {
      // Put it back the way it was rather than leave the app silent.
      try { out.disconnect(); } catch (e2) {}
      try { out.connect(raw.destination); } catch (e2) {}
      log('REROUTE FAILED, restored direct path: ' + e.message);
      return true;                 // installed-as-noop; do not retry forever
    }

    // THE ONE AUDIBLE PATH RULE: in the shell, anything that would connect to
    // rawContext.destination connects here instead. Measured on-device: a
    // context with ANY node feeding the raw destination is treated by WebKit
    // as "playing to the speakers" and gets interrupted (with an audible
    // skip + pitch-bend) when the speaker route reconfigures at screen lock;
    // a context feeding ONLY a consumed MediaStream sails through untouched.
    window._bloopsSpeakerSink = function (ac) {
      try { if (ac === raw) return streamDest; } catch (e) {}
      return ac.destination;   // offline contexts, or anything unexpected
    };

    const el = new Audio();
    for (const evn of ['play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'ratechange', 'error']) {
      el.addEventListener(evn, () => log('el event: ' + evn + ' t=' + el.currentTime.toFixed(2) + ' rate=' + el.playbackRate));
    }
    el.srcObject = elStream;
    // Not looped, not muted: this element is the speakers now.
    const kick = () => {
      el.play().then(
        () => log('media element playing — background audio armed'),
        (e) => log('media play() rejected: ' + e.name)
      );
    };
    kick();
    rig = { el, streamDest, kick };
    armMse().then((ok) => {
      if (ok) {
        window.__BLOOPS_MSE_ACTIVE = 1;
        nativeArmed = true;    // same contract: no resume-ramp masking
        // The shadow element exists ONLY as the context keep-alive — and any
        // copy of the MIX in it is audible somewhere ("a quiet voice, then a
        // very loud copy 1-2 s later": −40 dB is soft, not silent). So the
        // shadow carries NO mix at all: a 25 Hz tone at −26 dB — numerically
        // loud enough for any silence/audibility check, acoustically nothing
        // (a phone speaker cannot reproduce 25 Hz). Duplication is now
        // structurally impossible; the tap still consumes the mix for MSE.
        try {
          bridgeRefs.bSrc.disconnect(bridgeRefs.bDest);
          const osc = bridgeRefs.bridge.createOscillator();
          osc.frequency.value = 25;
          const og = bridgeRefs.bridge.createGain(); og.gain.value = 0.05;
          osc.connect(og); og.connect(bridgeRefs.bDest);
          osc.start();
          log('shadow element now carries a 25 Hz keep-alive tone (no mix)');
        } catch (e) { log('shadow retone FAILED: ' + e.message); }
        log('MSE OUTPUT armed — the element plays encoded media now');
        // STARTING MODAL: the broadcast cushion makes press-to-sound ~1 s, and
        // that second must be NAMED, not silent. Shown on the transport's
        // off→on edge, hidden the moment the AUDIBLE clock (Tone.now − the
        // measured broadcast lag) reaches the take's start — i.e. exactly when
        // sound arrives at the speaker. The display clock subtracts the same
        // lag (see _shapeAudibleNow), so bars hold at zero under this modal
        // and start sweeping in sync with the first audible note.
        try {
          const ov = document.createElement('div');
          ov.className = 'sm-overlay'; ov.id = 'bloops-starting-modal';
          ov.innerHTML = '<div class="sm-modal" style="text-align:center;padding:18px 22px;max-width:260px">'
            + '<div style="font-size:1.5rem;margin-bottom:6px">♪</div>'
            + '<div>Starting the music…</div></div>';
          document.body.appendChild(ov);
          const show = (on) => { try { ov.style.setProperty('display', on ? 'flex' : 'none', 'important'); } catch (e) {} };
          show(false);
          let tWasOn = false, shownAt = 0;
          setInterval(() => {
            try {
              const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
              const on = !!(E && E.timer);
              if (on && !tWasOn) { shownAt = Date.now(); show(true); }
              if (!on) { if (shownAt) { show(false); shownAt = 0; } }
              else if (shownAt) {
                const lag = (typeof window._bloopsMseOutLag === 'function') ? window._bloopsMseOutLag() : 0;
                const audible = ((typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0) - lag;
                const start = Number.isFinite(E._playStartAt) ? E._playStartAt : null;
                if ((start != null && audible >= start + 0.15) || (Date.now() - shownAt > 6000)) { show(false); shownAt = 0; }
              }
              tWasOn = on;
            } catch (e) {}
          }, 120);
          log('starting-modal armed');
        } catch (e) { log('starting-modal failed: ' + e.message); }
      } else {
        log('MSE unavailable — falling back to native/stream path');
        armNativePlugin();
      }
    }, (e) => { log('MSE start failed: ' + e.message); armNativePlugin(); });
    log('rerouted Tone destination through MediaStream (sr=' + raw.sampleRate + ')');

    // One-shot geometry report: answers "does the app sit under the notch /
    // home indicator" over the USB console without anyone looking at a screen.
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);bottom:env(safe-area-inset-bottom,0px);left:0;width:1px;visibility:hidden;pointer-events:none';
      document.documentElement.appendChild(probe);
      requestAnimationFrame(() => {
        const r = probe.getBoundingClientRect();
        const vm = document.querySelector('meta[name="viewport"]');
        log('GEOMETRY win=' + window.innerWidth + 'x' + window.innerHeight
          + ' safeTop=' + r.top.toFixed(0) + ' safeBottom=' + (window.innerHeight - r.bottom).toFixed(0)
          + ' viewportMeta="' + (vm ? vm.content : 'NONE') + '"');
        probe.remove();
      });
    } catch (e) {}

    // Resilience: an interruption (call, Siri, route change) can pause the
    // element or leave the context suspended; take both back when we return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || userPaused) return;
      silencePaused = false;
      try { if (raw.state !== 'running' && raw.resume) raw.resume(); } catch (e) {}
      try { if (el.paused) kick(); } catch (e) {}
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
    });

    // RESCUE: on screen lock iOS can flip the context to WebKit's
    // "interrupted" state even while JS keeps running (measured: the probe's
    // JS ran gapless through a 33 s lock). An interrupted context can often be
    // resumed from JS — try every second and say what happened, because the
    // outcome of these attempts is itself the diagnostic.
    // A deliberate pause (lock screen / control center) is the ONE not-running
    // state the rescue must leave alone — otherwise pausing on the lock screen
    // becomes an argument with a robot.
    let userPaused = false;
    let silencePaused = false;   // battery watchdog released the keep-alive

    const rescue = (why) => {
      try { if (bridge && bridge.state !== 'running' && !userPaused && !silencePaused) bridge.resume(); } catch (e) {}
      if (!raw || raw.state === 'running' || userPaused || silencePaused) return;
      const was = raw.state;
      try {
        raw.resume().then(
          () => log('rescue resume OK [' + why + '] (' + was + ' → ' + raw.state + ')'),
          (e) => log('rescue resume REJECTED [' + why + '] (' + was + '): ' + (e && e.name))
        );
      } catch (e) { log('rescue resume THREW: ' + e.message); }
    };
    // The statechange handler fires the moment iOS interrupts the context on
    // lock, so resuming HERE closes the gap to ~one event-loop turn — the
    // 1 s poll is only the belt for a missed event or a rejected resume.
    try {
      raw.onstatechange = () => {
        log('ctx state → ' + raw.state);
        if (raw.state !== 'running') {
          setTimeout(() => rescue('statechange'), 50);
        } else {
          // Soften the resume seam in the graph. Two DEAD ENDS, both measured
          // on-device, must not return: muting the element (a muted element
          // stops counting as audible playback — the app gets suspended) and
          // resetting el.srcObject at lock (iOS pauses a locked element whose
          // source is torn down — stutter, then suspension).
          try {
            // ELEMENT-mode only: with native output the resumed context is
            // continuous in content-time and the pre-charged ring rides the
            // stall — this ramp would BE the seam artifact, not the cure.
            if (maskGain && !nativeArmed) {
              const t = raw.currentTime;
              maskGain.gain.cancelScheduledValues(t);
              maskGain.gain.setValueAtTime(0, t);
              maskGain.gain.linearRampToValueAtTime(1, t + 0.08);
            }
          } catch (e) {}
          // SLEW TELEMETRY: prove or refute the resync theory — for 3 s after
          // every resume, how fast is the element's clock moving vs wall?
          try {
            let n = 0;
            const w0 = performance.now(), m0 = el.currentTime;
            const iv = setInterval(() => {
              n++;
              const dw = (performance.now() - w0) / 1000;
              log('SLEW t+' + dw.toFixed(2) + ' media+' + (el.currentTime - m0).toFixed(3)
                + ' rate=' + (el.playbackRate != null ? el.playbackRate : '?'));
              if (n >= 8) clearInterval(iv);
            }, 400);
          } catch (e) {}
        }
      };
    } catch (e) {}
    setInterval(() => rescue('poll'), 1000);

    // BATTERY: the playing media element is what keeps the app alive in the
    // background — so with the app HIDDEN and the mix genuinely silent for
    // 20 s, release it. iOS then suspends the app like any quiet app instead
    // of us holding a wake-lock to play nothing. Foreground is never touched.
    const silAn = raw.createAnalyser(); silAn.fftSize = 1024;
    try { out.connect(silAn); } catch (e) {}
    const silBuf = new Float32Array(silAn.fftSize);
    let silentFor = 0;
    setInterval(() => {
      const hidden = (document.visibilityState === 'hidden') || window._navForceHidden;
      if (!hidden || userPaused || silencePaused) { silentFor = 0; return; }
      let sum = 0;
      try { silAn.getFloatTimeDomainData(silBuf); } catch (e) { return; }
      for (let i = 0; i < silBuf.length; i++) sum += silBuf[i] * silBuf[i];
      const rms = Math.sqrt(sum / silBuf.length);
      silentFor = rms < 1e-4 ? silentFor + 1 : 0;
      if (silentFor >= 20 && !el.paused) {
        silencePaused = true;
        try { el.pause(); } catch (e) {}
        try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
        log('silent in background 20s — released the keep-alive, iOS may suspend us now');
      }
    }, 1000);

    const beatsOnRef = { v: true };
    try { beatsOnRef.v = localStorage.getItem('bloopsNativeAudioBeats') !== '0'; } catch (e) {}
        // PITCH WATCH: track the dominant frequency on BOTH sides of the bridge
    // (tone-side = what the app renders; bridge-side = what feeds the element).
    // The lock-glitch pitch bend has never once been MEASURED — states and
    // clocks all read clean while the ear hears a bend — so this is the
    // instrument that finally locates it: if the stream's own f0 bends, the
    // artifact is ours to fix; if both sides hold steady while the ear bends,
    // it lives downstream in WebKit's element→speaker pipeline.
    // [investigation concluded 2026-08-29: the artifact is downstream, in
    // WebKit's pipeline — OPT-IN now (localStorage bloopsPitchWatch='1').
    // Left running it costs ~2M multiplies every 150 ms on the main thread
    // and floods the flight buffer down to ~45 s of usable history.]
    let pitchOn = false;
    try { pitchOn = localStorage.getItem('bloopsPitchWatch') === '1'; } catch (e) {}
    if (pitchOn) try {
      const tapT = raw.createAnalyser(); tapT.fftSize = 2048;
      maskGain.connect(tapT);
      let tapB = null, bufB = null;
      if (bridge) {
        tapB = bridge.createAnalyser(); tapB.fftSize = 2048;
        // bSrc is scoped to the bridge try-block; re-tap from a fresh source
        // is not possible — expose via closure instead:
        if (window.__bloopsBridgeSrc) window.__bloopsBridgeSrc.connect(tapB);
        bufB = new Float32Array(2048);
      }
      const bufT = new Float32Array(2048);
      const f0 = (an, buf, sr) => {
        try { an.getFloatTimeDomainData(buf); } catch (e) { return null; }
        let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        if (rms < 1e-4) return { f: 0, rms };
        // autocorrelation over 60–1000 Hz
        let best = 0, bestLag = 0;
        const minLag = Math.floor(sr / 1000), maxLag = Math.min(Math.floor(sr / 60), buf.length >> 1);
        const cs = new Float32Array(maxLag + 1);
        for (let lag = minLag; lag <= maxLag; lag++) {
          let c = 0;
          for (let i = 0; i < buf.length - lag; i += 2) c += buf[i] * buf[i + lag];
          cs[lag] = c;
          if (c > best) { best = c; bestLag = lag; }
        }
        if (!bestLag) return { f: 0, rms };
        // octave-error fix: if a SUBMULTIPLE of the winning lag is nearly as
        // strong, the true period is the submultiple (the global max landed on
        // a harmonic of the period). Test exact divisions only — never the
        // rising slope, which is what a naive threshold scan hits.
        for (let k = 8; k >= 2; k--) {
          const cand = Math.round(bestLag / k);
          if (cand >= minLag && cs[cand] >= best * 0.85) { bestLag = cand; break; }
        }
        // parabolic refinement for sub-sample lag
        const at = (lag) => { let c = 0; for (let i = 0; i < buf.length - lag; i += 2) c += buf[i] * buf[i + lag]; return c; };
        const y0 = at(bestLag - 1), y1 = best, y2 = at(bestLag + 1);
        const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
        return { f: sr / (bestLag + d), rms };
      };
      setInterval(() => {
        if (!beatsOnRef.v) return;
        const t = f0(tapT, bufT, raw.sampleRate);
        const b = tapB ? f0(tapB, bufB, bridge.sampleRate) : null;
        if (!t) return;
        log('PITCH tone=' + t.f.toFixed(1) + '/' + t.rms.toFixed(3)
          + (b ? ' bridge=' + b.f.toFixed(1) + '/' + b.rms.toFixed(3) : '')
          + ' vis=' + document.visibilityState + ' st=' + raw.state);
      }, 150);
      f0ref.fn = f0;
    } catch (e) { log('pitch watch failed: ' + e.message); }

    // MIC WATCH: every in-graph tap reads what we RENDER; only the microphone
    // hears what the SPEAKER plays — comb from a double path, a pitch bend in
    // the output pipeline, a gap. Diagnostics only: engaged when the soak
    // driver sets window.__BLOOPS_MICWATCH (never in normal use).
    const micArm = setInterval(() => {
      if (!window.__BLOOPS_MICWATCH) return;
      clearInterval(micArm);
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then((ms) => {
        const mCtx = new (window.AudioContext || window.webkitAudioContext)();
        const mSrc = mCtx.createMediaStreamSource(ms);
        const mAn = mCtx.createAnalyser(); mAn.fftSize = 2048;
        mSrc.connect(mAn);
        const mBuf = new Float32Array(2048);
        if (mCtx.state !== 'running') mCtx.resume();
        log('MIC watch armed (sr=' + mCtx.sampleRate + ')');
        setInterval(() => {
          const r = f0ref.fn ? f0ref.fn(mAn, mBuf, mCtx.sampleRate) : null;
          if (r) log('MIC f=' + r.f.toFixed(1) + ' rms=' + r.rms.toFixed(4) + ' vis=' + document.visibilityState);
        }, 150);
      }, (e) => log('MIC watch denied: ' + e.name));
    }, 500);

    // Shell-only heartbeat over the USB console: enough to tell "JS alive,
    // context rendering" from every other failure without a probe build.
    // localStorage bloopsNativeAudioBeats='0' silences it.
if (beatsOnRef.v) {
      setInterval(() => {
        try {
          log('BEAT state=' + raw.state + ' br=' + (bridge ? bridge.state : '-') + ' sr=' + raw.sampleRate + ' ct=' + raw.currentTime.toFixed(2)
            + ' media=' + (el.paused ? 'paused' : el.currentTime.toFixed(2))
            + ' vis=' + document.visibilityState);
        } catch (e) {}
      }, 1000);
    }
    el.addEventListener('pause', () => {
      // Only fight a pause while the app is in the foreground — a background
      // pause is the OS's call and retrying from a suspended page is futile.
      if (document.visibilityState === 'visible' && !userPaused && !silencePaused) setTimeout(kick, 250);
    });

    // LOCK-SCREEN CONTROLS: with the mix riding a media element, iOS shows
    // transport controls whether we like it or not — wiring them is how they
    // do something sane. Pause = suspend the context (Tone's clock freezes, so
    // the piece HOLDS ITS PLACE and resumes mid-thought rather than stopping).
    if (navigator.mediaSession) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Bloops',
          artist: 'generative music',
          artwork: [{ src: 'bloops-icon.png', sizes: '1024x1024', type: 'image/png' }],
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('pause', () => {
          userPaused = true;
          try { el.pause(); } catch (e) {}
          try { raw.suspend(); } catch (e) {}
          try { if (bridge) bridge.suspend(); } catch (e) {}
          try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
          log('lock-screen pause — context suspended, piece holds its place');
        });
        navigator.mediaSession.setActionHandler('play', () => {
          userPaused = false;
          try { raw.resume(); } catch (e) {}
          try { if (bridge) bridge.resume(); } catch (e) {}
          kick();
          try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
          log('lock-screen play — resumed');
        });
        log('media session controls wired');
      } catch (e) { log('media session unavailable: ' + e.message); }
    }
    return true;
  }

  // Tone loads from a CDN tag ahead of us, but the context is created lazily —
  // poll until the reroute lands. Connections are legal on a suspended context,
  // so this succeeds long before the first user gesture.
  const t = setInterval(() => { if (install()) clearInterval(t); }, 250);

  // Debug handle for the USB console / tests.
  window._nativeAudio = {
    rig: () => rig && {
      playing: !rig.el.paused,
      mediaTime: rig.el.currentTime,
      tracks: rig.streamDest.stream.getAudioTracks().length,
    },
    _forceHidden: (v) => { window._navForceHidden = !!v; },
  };
})();
