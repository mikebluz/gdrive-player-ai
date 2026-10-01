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
  // ── TONE REJECTS EVERY capacitor:// RESPONSE (2026-09-29) ────────────────────
  // The shell's scheme handler answers `fetch` with `status: 0, ok: false` — and a
  // COMPLETE body. `ToneAudioBuffer.load` throws "could not load url" on `!ok`, so
  // EVERY library sample built on Tone.Sampler (the whole manifest: drum loops,
  // one-shots, the ◐ Loop recordings) was silent in the app while the web played
  // it. Measured in the simulator: fetch → ok=false status=0, yet the same body
  // decodes to 590400 frames. So: a status-0 answer with bytes is a success; a real
  // HTTP error or an empty body still fails. Keyed on the SCHEME, not on `wanted()`
  // — it is a transport quirk, whatever the audio routing preference says.
  try {
    if (location.protocol === 'capacitor:' && window.Tone && Tone.ToneAudioBuffer && Tone.ToneAudioBuffer.load) {
      const _toneLoad = Tone.ToneAudioBuffer.load;
      Tone.ToneAudioBuffer.load = async function (url) {
        // absolute URLs, data/blob, and Tone's "[mp3|ogg]" choice syntax keep Tone's own path
        if (typeof url !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(url) || /\[[^\]]+\|[^\]]+\]$/.test(url)) {
          return _toneLoad.call(this, url);
        }
        const res = await fetch(encodeURI((Tone.ToneAudioBuffer.baseUrl || '') + url));
        if (res.status >= 400) throw new Error('could not load url: ' + url + ' (' + res.status + ')');
        const bytes = await res.arrayBuffer();
        if (!bytes || !bytes.byteLength) throw new Error('could not load url: ' + url + ' (empty)');
        return Tone.getContext().decodeAudioData(bytes);
      };
    }
  } catch (e) {}
  if (!wanted()) return;

  const _flight = [];
  // WHICH BUILD IS THIS? Stamped by sync.sh into build.js. Printed first so a
  // harvested flight log answers "did my change even reach the device" before
  // anything else is diagnosed — several rounds were lost to that question.
  try { _flight.push(Date.now() + ' BUILD ' + (window.__BLOOPS_BUILD || 'unstamped')); } catch (e) {}
  const log = (m) => {
    try { console.log('[native-audio] ' + m); } catch (e) {}
    try {
      _flight.push(Date.now() + ' ' + m);
      if (_flight.length > 600) _flight.splice(0, _flight.length - 600);
    } catch (e) {}
  };
  // Published so any module can write to the harvestable flight log. A device
  // question ("did my tap reach the handler?") is answerable from a harvest
  // instead of from a theory — which is what several rounds of guessing cost.
  try { window._bloopsLog = (m) => log(String(m)); } catch (e) {}
  // flush the flight log to Documents so ordinary use leaves a harvestable
  // record — no more scheduled tests
  const _flush = () => {
    try {
      const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!FS || !_flight.length) return;
      FS.writeFile({
        path: 'bloops-flight.json', directory: 'DOCUMENTS', encoding: 'utf8',
        data: JSON.stringify({ at: Date.now(), lines: _flight }),
      }).catch(() => {});
    } catch (e) {}
  };
  setInterval(_flush, 20000);
  // KEEP THE PREVIOUS SESSION. Every launch overwrote the log, so a report
  // made after reopening the app arrived with the evidence already gone —
  // the glitchy session is almost always the one BEFORE the current launch.
  try {
    const FS0 = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    if (FS0) {
      FS0.readFile({ path: 'bloops-flight.json', directory: 'DOCUMENTS', encoding: 'utf8' }).then((r) => {
        if (r && r.data) return FS0.writeFile({ path: 'bloops-flight-prev.json', directory: 'DOCUMENTS', encoding: 'utf8', data: r.data });
      }).catch(() => {});
    }
  } catch (e) {}
  // ALSO ON THE WAY OUT. A 20 s interval can lose the last stretch before the
  // app backgrounds — which is exactly the stretch someone was interacting
  // with when they hit a problem, so the harvest arrives missing the evidence
  // it was collected for.
  try {
    // …AND SHORTLY AFTER COMING BACK. The unlock edge is where the stall is
    // worst, and a harvest taken seconds after foregrounding otherwise ends at
    // the last HIDDEN flush — the evidence for the unlock never reaches disk.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) _flush();
      else setTimeout(_flush, 8000);
    });
    window.addEventListener('pagehide', _flush);
  } catch (e) {}

  // ── PRESS TELEMETRY — how long a tap takes to make a sound, ON THE DEVICE ──
  // "Major lag on grid presses" measures 2-43 ms in a desktop browser, so the
  // only place the answer exists is the phone, and the phone has no console.
  // Each press leaves a line in the flight log (already flushed to Documents
  // every 20 s), so a harvest answers it with numbers instead of a theory:
  //   PRESS h=<pointerdown→playNote ms> lead=<scheduled ahead ms>
  //         ct=<audio-clock rate> cost=<voice budget in use>
  // A press whose `h` is large is MAIN-THREAD work before the note; a healthy
  // `h` with a bad `ct` is render starvation (the documented distinction — a
  // swinging clock with cost 1-2 is CPU starvation, not a Bloom bug).
  // The LISTENER goes on immediately — a 4 s arm delay missed a real press one
  // second before it (seen in a harvest). Only the playNote wrap has to wait
  // for playNote to exist.
  let pressAt = 0, pressSeq = 0;
  try {
    document.addEventListener('pointerdown', (e) => {
      try {
        if (!(e.target && e.target.closest && e.target.closest('.cell'))) return;
        pressAt = performance.now();
        // LOG THE TAP ITSELF. A press that makes NO sound is a different fault
        // from a press that sounds late, and a log with neither line cannot
        // tell either from "they never tapped" — which is what the first two
        // harvests could not answer.
        log('TAP #' + (++pressSeq));
      } catch (x) {}
    }, true);   // CAPTURE — the grid's own handler calls stopPropagation
  } catch (e) {}
  setTimeout(function armPressWatch() {
    if (typeof window.playNote !== 'function' || typeof window.startSustainedNote !== 'function') {
      setTimeout(armPressWatch, 250); return;
    }
    let seq = 0;
    // A GRID PRESS IS A HELD NOTE, and held notes do NOT go through playNote —
    // `polyStartCell` → `_polyStartSustain` → `startSustainedNote`. Wrapping
    // only playNote made 24 of 25 real taps look SILENT in a harvest, which
    // read as a finding and was my instrument's blind spot. Both paths now.
    const report = (via, params, at, dur) => {
      if (!pressAt) return;
      const h = performance.now() - pressAt;
      pressAt = 0;
      try {
          let ct = '?', cost = '?';
          const hl = window.__bloomHealthLog;
          if (hl && hl.length) { const L = hl[hl.length - 1]; ct = L.ctRate != null ? (+L.ctRate).toFixed(2) : '?'; cost = L.cost != null ? L.cost : '?'; }
          let lead = '?';
          if (window.Tone && Tone.now && Number.isFinite(+at)) lead = Math.round((+at - Tone.now()) * 1000);
          // THE NOTE'S OWN ATTACK, and whether a compose session is supplying
          // it. These separate the two candidates that a latency number alone
          // cannot: a small `h` with a big `atk` is not a slow PRESS, it is a
          // slow SOUND (the pad's envelope), and the fix for each is different.
          let atk = '?', ge = 0;
          try { if (params && Number.isFinite(+params.attack)) atk = Math.round(+params.attack); } catch (x) {}
          try { ge = (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit) ? 1 : 0; } catch (x) {}
        log('PRESS via=' + via + ' h=' + h.toFixed(1) + ' lead=' + lead + ' atk=' + atk +
            ' voice=' + ((params && params.type) || '?') + ' compose=' + ge +
            ' ct=' + ct + ' cost=' + cost);
        seq++;
      } catch (x) {}
    };
    const oPlay = window.playNote;
    window.playNote = function (freq, params, dur, at) {
      report('play', params, at, dur);
      return oPlay.apply(this, arguments);
    };
    const oSus = window.startSustainedNote;
    window.startSustainedNote = function (freq, params, startAt) {
      report('sustain', params, startAt);
      return oSus.apply(this, arguments);
    };
    log('press watch armed (playNote + startSustainedNote)');
  }, 300);

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
    // ── NAVIGATION TEARDOWN ────────────────────────────────────────────────
    // Leaving the page (← Back to SAW) destroys the DOCUMENT, but WebKit's
    // media pipeline outlives it by a beat: the broadcast element's
    // AVSampleBufferAudioRenderer keeps draining whatever it holds with its
    // feed dead — heard as a tiny stale-buffer LOOP glitching over the front
    // door. Nothing reactive on the next page can fix it (the next page does
    // not own these elements), so the dying page releases them itself:
    // mute → pause → strip the src → load() — load() on a srcless element is
    // the canonical WebKit "let go of the renderer NOW".
    //
    // pagehide NEVER fires on a plain app-background here (the webview stays
    // alive — that is the whole background-audio architecture), only on real
    // navigation or app death, so tearing down on it cannot break the
    // keep-alive. The one edge is the back-swipe returning to a bfcached copy
    // of this page — its audio rig is dead by then, so pageshow(persisted)
    // reloads for a clean boot rather than resuming a half-dead graph.
    const AUD_TEAR = [];
    function audioTeardown(why) {
      if (audioTeardown.done) return; audioTeardown.done = true;
      log('AUDIO TEARDOWN (' + why + ')');
      // A DURABLE STAMP — the console line is emitted by a dying page and the
      // CDP/flight channels can lose it, so the proof that the teardown ran
      // lives where the NEXT page can read it.
      try { localStorage.setItem('bloopsLastTeardown', why + '@' + Date.now()); } catch (e) {}
      for (let i = 0; i < AUD_TEAR.length; i++) {
        const e2 = AUD_TEAR[i];
        try {
          e2.setAttribute('data-bloops-torn', '1');
          e2.muted = true; e2.pause(); e2.srcObject = null; e2.removeAttribute('src'); e2.load();
        } catch (e) {}
      }
      try {
        const P = window.Capacitor && window.Capacitor.Plugins;
        if (P && P.BloopsAudio && P.BloopsAudio.stop) P.BloopsAudio.stop();
      } catch (e) {}
      try { raw.suspend(); } catch (e) {}
      try { if (bridge) bridge.close(); } catch (e) {}
    }
    try {
      window.addEventListener('pagehide', () => audioTeardown('pagehide'));
      window.addEventListener('pageshow', (ev2) => {
        if (ev2 && ev2.persisted && audioTeardown.done) {
          log('bfcache return after teardown — reloading for a clean rig');
          try { location.reload(); } catch (e) {}
        }
      });
    } catch (e) {}
    let armMse = () => Promise.resolve(false);
    let armNativePlugin = () => {};
    // STARTING MODAL — SHARED BY BOTH OUTPUT PATHS. Press-to-sound is ~1 s on
    // either (the MSE broadcast cushion; the native ring's 850 ms prime), and
    // that second must be NAMED, not silent. It lived only in the MSE branch,
    // so on the phone's native path Play went quiet for a second with nothing
    // on screen. Shown on the transport's off→on edge (after 300 ms — a
    // flashed modal reads as a glitch), hidden the moment `sounding(edgeAt)`
    // says sound has reached the speaker, or after 6 s whatever happens.
    // `opts.cal` = run the MSE calibration on the stop edge.
    const armStartingModal = (sounding, opts) => {
      try {
        const ov = document.createElement('div');
        ov.className = 'sm-overlay'; ov.id = 'bloops-starting-modal';
        ov.innerHTML = '<div class="sm-modal" style="text-align:center;padding:18px 22px;max-width:260px">'
          + '<div style="font-size:1.5rem;margin-bottom:6px">♪</div>'
          + '<div>Starting the music…</div>'
          + '<div class="ambient-hint" style="margin-top:6px">Filling the audio buffer first, so playback stays smooth — even if the phone locks.</div></div>';
        document.body.appendChild(ov);
        let shownFlag = false;
        const show = (on) => {
          try { ov.style.setProperty('display', on ? 'flex' : 'none', 'important'); } catch (e) {}
          if (on === shownFlag) return;
          shownFlag = on;
          // MEASURED, not assumed: a 0×0 rect is a modal nobody saw
          try {
            const m = ov.querySelector('.sm-modal'), r = m ? m.getBoundingClientRect() : null;
            log('starting-modal ' + (on ? 'SHOWN' : 'hidden') + ' +' + (shownAt ? Date.now() - shownAt : 0) + 'ms'
              + (on && r ? ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' visible=' + (getComputedStyle(ov).display !== 'none' && r.width > 0) : ''));   // fixed → offsetParent is always null
          } catch (e) {}
        };
        show(false);
        let tWasOn = false, shownAt = 0;
        setInterval(() => {
          try {
            const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
            const on = !!(E && E.timer);
            if (on && !tWasOn) { shownAt = Date.now(); }
            if (!on && tWasOn && opts && opts.cal) { setTimeout(() => { try { if (window.__bloopsCal) window.__bloopsCal(); } catch (e) {} }, 2200); }
            if (!on) { if (shownAt) { show(false); shownAt = 0; } }
            else if (shownAt) {
              let ok = false;
              try { ok = !!sounding(shownAt, E); } catch (e) {}
              if (ok || (Date.now() - shownAt > 6000)) { show(false); shownAt = 0; }
              else if (Date.now() - shownAt > 300) show(true);
            }
            // PROJECT SNAPSHOT on the play edge: the phone has no console, so
            // bloomDump (quiet — no toast/clipboard) is written into the app
            // container beside the flight log. Harvest with devicectl and
            // replay with `npm run test:replay`. (MSE-only until 2026-09-30, so
            // the native path's snapshot sat at 09-28.)
            if (on && !tWasOn) {
              setTimeout(() => {
                try {
                  const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
                  const txt = (typeof window.bloomDump === 'function') ? window.bloomDump(true) : null;
                  if (FS && txt) FS.writeFile({ path: 'bloops-project.json', directory: 'DOCUMENTS', encoding: 'utf8', data: txt })
                    .then(() => log('project snapshot written (' + (txt.length / 1024).toFixed(1) + ' KB)'), () => {});
                } catch (e) {}
              }, 1200);
            }
            tWasOn = on;
          } catch (e) {}
        }, 120);
        log('starting-modal armed');
      } catch (e) { log('starting-modal failed: ' + e.message); }
    };
    const f0ref = { fn: null };
    try {
      out.disconnect();            // severs output → rawContext.destination
      maskGain = raw.createGain(); // the resume-seam mask point (graph-side)
      out.connect(maskGain);
      maskGain.connect(streamDest);
      // PRE-MASK TAP for the interactive monitor: when the transport stops,
      // the STOP GATE closes maskGain so the broadcast carries true silence —
      // but presses must stay audible through the monitor, so it taps the mix
      // BEFORE the mask. Parallel stream, consumed by the bridge like the
      // main one. (Also the no-double guarantee: a press while stopped is
      // heard ONCE, via the monitor — the mask keeps it out of the broadcast.)
      const monTapDest = raw.createMediaStreamDestination();
      out.connect(monTapDest);
      // THE STOP GATE — the last pop standing was iOS renegotiating the audio
      // session at background/lock while the app sat "active but silent"
      // (muted element). A muted or paused renderer gets reclassified; an
      // UNMUTED element playing true silence does not — locks while PLAYING
      // were always seamless for exactly this reason. So stop closes the
      // graph here (tails cut instantly = the stop stays immediate) and the
      // element keeps playing unmuted silence: to the OS, nothing changed.
      window._bloopsStopGate = (closed) => {
        try {
          const t = raw.currentTime;
          maskGain.gain.cancelScheduledValues(t);
          maskGain.gain.setValueAtTime(maskGain.gain.value, t);
          maskGain.gain.linearRampToValueAtTime(closed ? 0 : 1, t + (closed ? 0.012 : 0.03));
        } catch (e) {}
        // WHO IS CARRYING THE SOUND. The interactive monitor is a SECOND
        // low-latency path, and it must never be open at the same time as the
        // main one or every press is heard twice. The mask is the honest test:
        // closed = the main path is silent and the monitor is the only way to
        // hear a press; open = the foreground direct path already carries it.
        window.__bloopsMaskClosed = !!closed;
        log('stop gate ' + (closed ? 'CLOSED (graph muted, element keeps playing silence)' : 'open') + ' w=' + (Date.now() % 1000000));
      };
      window.__bloopsMonTapStream = monTapDest.stream;
      // The route's PHYSICAL output latency (speaker ~0.01-0.05 s, Bluetooth
      // 0.15-0.3 s). The media-timeline lag formula self-cancels the encoder
      // delay but cannot see this term — without it every display surface
      // leads the ear by the route latency ("the readout starts earlier than
      // the music"). Read from the bridge ctx once it exists; same route.
      window._bloopsOutputLatency = () => {
        try {
          const br = bridgeRefs && bridgeRefs.bridge;
          // WebKit has no outputLatency (baseLatency is just the quantum), so
          // on the phone this falls to a measured-in-the-hand allowance for
          // the media element's decode+output pipeline. Tunable per device:
          // localStorage bloopsOutLagTrim (seconds, e.g. '0.25' on Bluetooth).
          let trim = NaN;
          try { trim = parseFloat(localStorage.getItem('bloopsOutLagTrim')); } catch (e) {}
          if (Number.isFinite(trim) && trim >= 0 && trim < 2) return trim;
          // mic-measured full-loop residue (element render pipeline + physical)
          // wins outright — it is the only number that covers the unqueryable
          // AVSampleBufferAudioRenderer depth
          let mr = NaN;
          try { mr = parseFloat(localStorage.getItem('bloopsResidue')); } catch (e) {}
          if (Number.isFinite(mr) && mr >= 0 && mr < 1.2) return mr;
          // fallback: measured stream hop + a GENEROUS pipeline allowance — a
          // display that trails slightly reads as in-sync; one that leads
          // reads broken (three field reports say so)
          let sl = NaN;
          try { sl = parseFloat(localStorage.getItem('bloopsStreamLag')); } catch (e) {}
          if (Number.isFinite(sl) && sl >= 0 && sl < 1.5) return sl + 0.30;
          const v = br ? (br.outputLatency || 0) : 0;
          if (Number.isFinite(v) && v > 0.02 && v < 1) return v + 0.30;
          return 0.35;   // iOS media-element pipeline allowance
        } catch (e) { return 0.35; }
      };
      bridge = new (window.AudioContext || window.webkitAudioContext)();
      const bSrcRaw = bridge.createMediaStreamSource(streamDest.stream);
      // ── DC BLOCKER ON THE BROADCAST PATH (2026-09-18) ─────────────────
      // An iOS audio-session INTERRUPTION freezes the graph mid-sample and the
      // resume restarts it there: the step's DC content is a thump. The
      // interactive monitor has carried exactly this filter since it was built
      // ("a context suspend/resume freezes the stream mid-sample and the step's
      // DC content THUMPS — kill it") — but the BROADCAST, which is the audible
      // path essentially all of the time, never got one, so every interruption
      // went as a step straight into the encoder and out of the speaker.
      //
      // Harvested from the device (bloops-flight.json, 12 minutes of ordinary
      // use): FOUR `ctx state → interrupted` → `rescue resume OK` pairs, one of
      // them 1.34 s after a stop press — which is the session-renegotiation
      // tick this file already documents to the tenth of a second. And the
      // mask's own re-ramp at resume is gated `!nativeArmed`, so on the plugin
      // path there is no ramp at all; the bridge context is interrupted and
      // resumed TOO (`bridge state → interrupted` in the same harvest) and
      // nothing ramps that side in either mode. A filter in the path covers
      // every one of those cases without another state machine to keep in step.
      //
      // 28 Hz / Q 0.7 — the monitor's own values, so the two paths cannot drift
      // apart, and far enough below the lowest musical fundamental to be
      // inaudible on the programme material.
      const bHp = bridge.createBiquadFilter();
      bHp.type = 'highpass'; bHp.frequency.value = 28; bHp.Q.value = 0.7;
      bSrcRaw.connect(bHp);
      // EVERY consumer taps the FILTERED node — `bridgeRefs.bSrc` is what the
      // foreground path, the monitor fallback and the encoder all read, so the
      // blocker cannot be bypassed by a route that was wired before it existed.
      const bSrc = bHp;
      bridgeRefs = { bSrc: bSrc, bSrcRaw: bSrcRaw, bHp: bHp };
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
        // PATH KILL SWITCH — `localStorage.bloopsMsePath = '0'` skips the MSE
        // broadcast entirely and takes the AVAudioEngine/stream path instead.
        // The two output paths fail in different ways and BOTH have been blamed
        // for the same reported symptom; only swapping between them at runtime
        // separates "this architecture is glitching" from "my control loop is".
        // DIAGNOSTIC DEFAULT, 2026-09-28: the MSE broadcast is OFF unless asked
        // for. A reported tremolo survived seven builds of MSE work while every
        // measurement of the MSE path came back clean, and the switch that would
        // have A/B'd it needs localStorage — which on a phone means attaching
        // Safari's Web Inspector over USB, so it never actually got run. Default
        // it OFF and the comparison happens by listening to a build instead.
        // Set localStorage bloopsMsePath='1' to get the broadcast back.
        let wantMse = false;
        try { wantMse = localStorage.getItem('bloopsMsePath') === '1'; } catch (e) {}
        if (!wantMse) {
          log('MSE SKIPPED (diagnostic default) — native/stream path is the speaker');
          return Promise.resolve(false);
        }
        // MSE gets its OWN element; the original element stays on the -40 dB
        // bridge stream as the CONTEXT KEEP-ALIVE (mode-B mechanism: a playing
        // stream-fed element is what stops WebKit suspending the contexts at
        // lock — its loss is why production died in the first flight harvest).
        const mseEl = new Audio();
        AUD_TEAR.push(mseEl);
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
          // THE TAP LIVES ON THE TONE CONTEXT, NOT THE BRIDGE (2026-09-28).
          // On the bridge it read the mix AFTER the MediaStream hop between the
          // two contexts, and that hop turns a render shortfall into DIGITAL
          // SILENCE: the bridge keeps running at 1.0 and fills whatever the tone
          // context failed to render with zeros. Captured on the ring's input:
          // every context stall arrived as a hole of silence at full frame rate,
          // so the ring saw no deficit and simply played the hole. Tapped here,
          // a shortfall arrives as FEWER FRAMES, which the splice ring can
          // stretch. The bridge + element stay only as the keep-alive.
          // Post-mask, so the stop gate's silence is what the ring hears;
          // with the 28 Hz DC blocker the bridge path carried (interruption thump).
          const TAP_SRC =
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
            "});";
          const tapUrl = () => URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
          raw.audioWorklet.addModule(tapUrl()).then(() => true, (e) => { log('tone-context tap module failed: ' + (e && e.message)); return false; }).then((modOk) => {
            let tap = null;
            if (modOk) try {
              // Tone wraps the AudioContext (standardized-audio-context): the
              // native constructor rejects it, Tone's factory does not.
              tap = Tone.context.createAudioWorkletNode('bloops-tap', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
              });
              const tHp = raw.createBiquadFilter();
              tHp.type = 'highpass'; tHp.frequency.value = 28; tHp.Q.value = 0.7;
              maskGain.connect(tHp); tHp.connect(tap);
              // a worklet with no output still needs a pull path — into the
              // stream, never rawContext.destination (the one-audible-path rule)
              const pull = raw.createGain(); pull.gain.value = 0;
              tap.connect(pull); pull.connect(streamDest);
              log('native tap on the TONE context (pre-MediaStream)');
            } catch (e) {
              log('tone-context tap failed (' + e.message + ') — tapping the bridge');
              tap = null;
            }
            if (!tap) {
              // FALLBACK: the old bridge tap (module must be registered there)
              return bridge.audioWorklet.addModule(tapUrl()).then(() => {
                const t2 = new AudioWorkletNode(bridge, 'bloops-tap');
                bSrc.connect(t2);
                const pull = bridge.createGain(); pull.gain.value = 0;
                t2.connect(pull); pull.connect(bDest);
                return t2;
              });
            }
            return tap;
          }).then((tap) => {
            if (!tap) return;
            // the element's copy drops to −74 dB: keep-alive, not speaker
            try {
              // −40 dB, NOT lower: WebKit's audible-playback test is what
              // keeps the page (and both contexts, and JS) alive at screen
              // lock, and −74 dB measured as "silent" to it — the page got
              // suspended and the native feed starved. At −40 the copy still
              // counts as audible while sitting far beneath the native mix;
              // whatever the element pipeline does to it at the lock is buried.
              // NO MIX COPY AT ALL NOW (2026-09-28) — the MSE path's answer, applied
              // here. The −40 dB copy was the only thing playing while the ring
              // primed after Play, so every start was heard as "very quiet, then
              // suddenly normal volume"; and with a deep ring it ran up to 2 s AHEAD
              // of the real output as a faint pre-echo. A 25 Hz tone at −26 dB is
              // numerically loud for WebKit's audible-playback test (the keep-alive)
              // and acoustically nothing on a phone speaker.
              // bSrc MUST STAY CONSUMED: the tone context's MediaStream being pulled
              // is what keeps WebKit from suspending it at lock (mode B), so it keeps
              // a zero-gain path to the element instead of being cut loose.
              bSrc.disconnect(bDest);
              const pullStream = bridge.createGain(); pullStream.gain.value = 0;
              bSrc.connect(pullStream); pullStream.connect(bDest);
              const ka = bridge.createOscillator(); ka.frequency.value = 25;
              const kaG = bridge.createGain(); kaG.gain.value = 0.05;
              ka.connect(kaG); kaG.connect(bDest); ka.start();
              log('keep-alive element carries a 25 Hz tone, no mix');
            } catch (e) {}
            let chunks = 0, failed = 0, engineUp = false;
            tap.port.onmessage = (ev) => {
              // NOTHING BEFORE THE ENGINE IS UP. The worklet starts feeding the
              // moment it is connected, but plug.start() is async — so ~9 s of
              // audio piled into the ring ahead of the first render callback and
              // was immediately discarded as stale (measured: writer 2.87x for
              // one interval, 413440 frames dropped, then exactly 1.00x forever
              // after). Harmless once the high-water mark exists, but it is a
              // burst of stale audio racing the first sound you hear, and the
              // fix is simply not to send it.
              if (!engineUp) return;
              // DELIVERY GAP: the ring's reserve is eaten at a lock by chunks
              // arriving LATE (the main thread busy or throttled), so the
              // longest gap between arrivals is the number to drive down.
              try {
                const now = performance.now();
                if (window.__tapLast) { const g = now - window.__tapLast; if (g > (window.__tapGapMax || 0)) window.__tapGapMax = g; }
                window.__tapLast = now;
              } catch (e) {}
              // ArrayBuffer → base64 without blowing the stack on big args
              const u8 = new Uint8Array(ev.data);
              let bin = '';
              for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
              plug.write({ data: btoa(bin) }).then(() => { chunks++; }, () => { failed++; });
            };
            // FOUR numbers, four jobs — conflating any two has cost a regression:
            //   RING_MS    capacity: headroom to absorb a delivery burst (the tap
            //              posts to the MAIN THREAD, throttled to ~2 s once
            //              hidden, so chunks can land seconds at a time). Free.
            //   PRIME_MS   buffer before sound starts after a transport flush =
            //              PRESS LATENCY. Both edges flush, so this is the whole
            //              press-to-sound cost whatever the depth was.
            //   TARGET_*   the depth the ring steers to = STALL TOLERANCE, and
            //              the lag on a grid press while playing.
            //   LAT_MS     hard ceiling, so nothing can run away (a 3 s ring once
            //              sat full because in == out and nothing drained it).
            // Measured stalls it must cover: 86-253 ms at a lock, and at the
            // UNLOCK edge ctRate 0.466 for ~1 s (~530 ms never rendered).
            // SPLICE RING (2026-09-28). The plugin no longer RESAMPLES to steer
            // depth — every correction there was a pitch bend (rate 0.95 = most
            // of a semitone flat, after every lock AND every Play press). It
            // repeats or skips short waveform-matched segments instead, so depth
            // can follow visibility freely: TARGET_VIS while visible (it is the
            // grid-press lag, and it sits just inside the ring's deadband above
            // the prime so steady visible playback never splices), TARGET_HID
            // while hidden, where nobody can
            // press anything and the unlock stall (~0.5-1 s never rendered) has to
            // come out of the reserve. LAT is only a safety ceiling now; it must
            // clear TARGET_HID plus a hidden-state delivery burst (~2 s).
            // Play/Stop latency is untouched: both edges flush, so press-to-sound
            // is PRIME_MS whatever the depth was.
            // PRIME = TARGET_VIS (2026-09-30). Priming at 350 and growing to 850 by
            // splicing put ~28 waveform repeats into the first ~10 s of EVERY
            // Play — reported as "rhythm skips and skitters for the first 10
            // seconds", and blamed on Variation. The user chose ~0.9 s to sound,
            // NAMED by the starting modal, over the skitter. Gate:
            // bloops-native tools/splice-test.swift (PRIME_MS mirrors this).
            const RING_MS = 6000, LAT_MS = 4500, PRIME_MS = 850, TARGET_VIS = 850, TARGET_HID = 2000;
            plug.start({ sampleRate: bridge.sampleRate, bufferMs: RING_MS, latencyMs: LAT_MS, primeMs: PRIME_MS, targetMs: TARGET_VIS }).then(
              () => {
                engineUp = true;
                // STARTING MODAL, native path: sound has started when a stats
                // reply ASKED after the press (so after the PLAY flush) says
                // the ring is primed and frames are moving out of it.
                {
                  let edge = 0, sound = false, inflight = false, base = -1;
                  armStartingModal((edgeAt) => {
                    if (edgeAt !== edge) { edge = edgeAt; sound = false; base = -1; }
                    if (!sound && !inflight) {
                      inflight = true;
                      const asked = Date.now();
                      plug.stats().then((st) => {
                        inflight = false;
                        if (edge !== edgeAt || asked < edgeAt + 150 || !st) return;
                        const pl = Number(st.played) || 0;
                        if (base < 0) { base = pl; return; }
                        if (st.primed && pl > base) sound = true;
                      }, () => { inflight = false; });
                    }
                    return sound;
                  });
                }
                // THE DISPLAY'S RENDER→SPEAKER LAG, for the native path too. Every
                // play head, visualiser and audible clock reads it through
                // `_bloopsMseOutLag` (07-playback-scheduler, 05-sequencer-core,
                // 21-shape, 17-ambient) — and only the MSE path ever defined it, so
                // on this path the display assumed zero and ran AHEAD of the sound by
                // the ring's whole depth: 0.85 s normally, up to 2 s after a lock —
                // "the play heads are a full bar ahead". The name is kept (label-only
                // rule); the value is what the ring actually holds, polled twice a
                // second, plus the engine's own output buffer.
                {
                  let ringLagS = PRIME_MS / 1000;
                  const srL = bridge.sampleRate || 48000;
                  setInterval(() => {
                    try { const pr = plug.stats(); if (pr && pr.then) pr.then((st) => {
                      if (st && Number.isFinite(st.buffered)) ringLagS = st.buffered / srL
                        + (Number.isFinite(st.ioBufMs) ? st.ioBufMs / 1000 : 0.003);
                    }, () => {}); } catch (e) {}
                  }, 500);
                  window._bloopsMseOutLag = () => ringLagS;
                }
                // NO RESUME-RAMP ON THE NATIVE PATH. The statechange handler
                // snaps maskGain to 0 and fades it back over 80 ms at every
                // context resume — i.e. at every lock, unlock and app switch —
                // unless `nativeArmed`. Only the MSE branch ever set it, so when
                // MSE went default-off this path ducked (a click, then a
                // dropout) at every interruption, UPSTREAM of the ring and the
                // tap: found in the ring's own INPUT capture, a 20 dB dip at each
                // resume, after a day of tuning the ring for a fault it never had.
                nativeArmed = true;
                log('NATIVE OUTPUT armed — AVAudioEngine is the speaker now (splice ring ' + RING_MS
                  + 'ms, prime ' + PRIME_MS + 'ms, target ' + TARGET_VIS + '/' + TARGET_HID
                  + 'ms vis/hidden, ceiling ' + LAT_MS + 'ms)');
                // MAIN-THREAD LAG PROBE for 3 s after every visibility change:
                // a chain of MessageChannel pings (not timers — those throttle by
                // design) whose worst turnaround is how long the main thread was
                // unavailable, i.e. how long tap chunks sat undelivered.
                try {
                  document.addEventListener('visibilitychange', () => {
                    const mc = new MessageChannel(), t0 = performance.now();
                    let last = t0, worst = 0, worstAt = 0;
                    mc.port1.onmessage = () => {
                      const now = performance.now(), lag = now - last;
                      if (lag > worst) { worst = lag; worstAt = now - t0; }
                      last = now;
                      if (now - t0 < 3000) setTimeout(() => { last = performance.now(); mc.port2.postMessage(0); }, 20);
                      else log('MAINLAG after ' + document.visibilityState + ': worst ' + Math.round(worst) + 'ms at +' + Math.round(worstAt) + 'ms');
                    };
                    mc.port2.postMessage(0);
                  });
                } catch (e) {}
                // DEPTH FOLLOWS VISIBILITY. Deepen BEFORE the stall, not after:
                // the interruption fires ~150-250 ms ahead of visibilitychange,
                // but either edge is early enough to matter and this is the one
                // that always fires.
                try {
                  document.addEventListener('visibilitychange', () => {
                    const vis = document.visibilityState === 'visible';
                    try { plug.setLatency({ targetMs: vis ? TARGET_VIS : TARGET_HID }); } catch (e) {}
                    log('native depth -> ' + (vis ? TARGET_VIS : TARGET_HID) + 'ms (' + document.visibilityState + ')');
                  });
                } catch (e) {}
                // The lock-screen Pause (media session, below) is a transport
                // edge too: it suspends the contexts, and without a flush the
                // ring would play out its whole reserve — up to TARGET_HID of
                // music AFTER the press — before going quiet.
                window._bloopsNativeFlush = (fadeMs, discardMs) => {
                  try { return plug.flush({ fadeMs: fadeMs, discardMs: discardMs || 0 }); } catch (e) { return null; }
                };
                // TRANSPORT EDGES OWN THE RING. Stop: the graph mutes in 12 ms
                // but the ring still holds the buffered pre-mute audio, so
                // without this the music ran on for the whole depth after the
                // press. Play: while stopped the tap keeps writing SILENCE, so
                // new music queued up behind a bufferful of it. Flushing both
                // edges makes press-to-sound just the prime, and stop immediate.
                // fadeMs ramps the frames about to play instead of cutting them
                // mid-waveform, which would be a click.
                let tOn = null;
                setInterval(() => {
                  let on = null;
                  try { on = (typeof _vinylTransportOn === 'function') ? !!_vinylTransportOn() : null; } catch (e) {}
                  if (on === null || on === tOn) return;
                  const was = tOn; tOn = on;
                  if (was === null) return;         // boot state, not an edge
                  if (on) {
                    try {
                      if (window.__bloopsReleaseHold && window.__bloopsReleaseHold())
                        log('in-app PLAY released a lock-screen hold — keep-alive re-armed');
                    } catch (e) {}
                  }
                  try {
                    // discardMs on STOP: audio already in flight (the tap's
                    // partial 100 ms chunk, the bridge queue, the MediaStream
                    // hop) is PRE-STOP music and used to play ~350 ms after
                    // Stop as a blip. What follows a stop is silence, so
                    // dropping 200 ms of it costs nothing.
                    plug.flush({ fadeMs: on ? 2 : 8, discardMs: on ? 0 : 200 }).then((r) => {
                      log('native ring flushed on ' + (on ? 'PLAY' : 'STOP')
                        + ' (dropped ' + ((r && r.dropped) || 0) + ' frames) w=' + (Date.now() % 1000000));
                    }, () => {});
                  } catch (e) {}
                }, 40);
              },
              (e) => log('native output start failed: ' + (e && e.message))
            );
            window._nativeAudio._pcm = () => ({ chunks, failed });
            // THE STATS WERE ALWAYS THERE AND NEVER HARVESTED: the plugin
            // resolves frames in/out, buffer depth and an underrun counter, and
            // this poll threw the result away — it only reached NSLog, which the
            // flight log does not capture. An underrun count is the difference
            // between "the ring starved" and every other theory about a lock
            // glitch, so it belongs in the log that survives to the Mac.
            let lastUnder = 0, lastRx = -1, lastIdleLog = 0;
            setInterval(() => {
              try {
                const pr = plug.stats({ take: true });   // this line owns the read-and-clear meters
                if (pr && pr.then) pr.then((st) => {
                  if (!st) return;
                  // IDLE LINES MUST NOT EVICT THE SESSION. The log keeps 600
                  // lines and this one is every ~6 s, so a quarter hour of an
                  // idle backgrounded app pushed out the whole playing session
                  // the user had just complained about (2026-10-01: 898 s of
                  // `buf=0` and nothing else). Empty ring + nothing received
                  // since the last line = one line a minute.
                  const rxNow = Number(st.received) || 0;
                  const idle = !st.primed && !(st.buffered > 0) && rxNow === lastRx;
                  lastRx = rxNow;
                  if (idle && Date.now() - lastIdleLog < 60000) return;
                  if (idle) lastIdleLog = Date.now();
                  const sr2 = bridge.sampleRate || 48000;
                  const d = (st.underrun || 0) - lastUnder;
                  const gapNow = window.__tapGapMax || 0; window.__tapGapMax = 0;
                  lastUnder = st.underrun || 0;
                  log('NATIVE buf=' + ((st.buffered || 0) / sr2 * 1000).toFixed(0) + 'ms'
                    + '/' + ((st.hwm || 0) / sr2 * 1000).toFixed(0) + 'ms'
                    + ' under=' + (st.underrun || 0) + (d > 0 ? ' (+' + d + ' NEW)' : '')
                    + ' drop=' + (st.dropped || 0)
                    + ' rx=' + (st.received || 0) + ' play=' + (st.played || 0)
                    + ' rate=' + (st.rate != null ? Number(st.rate).toFixed(4) : '?')
                    + ' prod=' + (st.prod != null ? Number(st.prod).toFixed(3) : '?')
                    // notes scheduled since the last line · how many were already
                    // LATE when scheduled · the worst · the tightest lead (see
                    // the meter in playNote). Read-and-clear per line.
                    + (() => {
                      const m = window.__noteLead; window.__noteLead = null;
                      if (!m || !m.n) return ' notes=0';
                      return ' notes=' + m.n + ' late=' + m.late + ' lateWorst=' + Math.round(m.worst * 1000) + 'ms'
                        + ' leadMin=' + Math.round(m.minLead * 1000) + 'ms';
                    })()
                    // live levels this interval (rms= is a running mean since
                    // start and read 0.15 through 30 s of a silent speaker)
                    + ' inPk=' + (st.inPeak != null ? Number(st.inPeak).toFixed(3) : '?')
                    + ' outPk=' + (st.outPeak != null ? Number(st.outPeak).toFixed(3) : '?')
                    + ' writes=' + (st.writes != null ? st.writes : '?')
                    + ' spl=+' + (st.splicesIn || 0) + '/-' + (st.splicesOut || 0)
                    + ' cbw=' + Math.round(st.cbWorstUs || 0) + 'us cbover=' + (st.cbOver || 0)
                    + ' stops=' + (st.engineStops || 0) + (st.lastStopWhy ? '(' + st.lastStopWhy + ')' : '')
                    + ' poor=' + (st.poorSplices || 0) + ' gapmax=' + Math.round(gapNow) + 'ms'
                    + ' tgt=' + ((st.target || 0) / sr2 * 1000).toFixed(0) + 'ms'
                    + ' low=' + ((st.lowWater != null ? st.lowWater : 0) / sr2 * 1000).toFixed(0) + 'ms'
                    + ' uev=' + (st.underrunEvents || 0)
                    + ' lock=' + (st.locked ? 1 : 0)
                    + ' io=' + (st.ioBufMs != null ? Number(st.ioBufMs).toFixed(1) : '?')
                    + ' primed=' + st.primed + ' running=' + st.running
                    + ' rms=' + (st.rms != null ? Number(st.rms).toFixed(4) : '?')
                    + ' vis=' + document.visibilityState);
                }, () => {});
              } catch (e) {}
            }, 5000);
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
    AUD_TEAR.push(el);
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
        // STREAM-LAG SELF-CALIBRATION. The audible clock maps element media
        // time back to TONE-graph time, and the algebra silently assumes the
        // tone→bridge MediaStream hop is instant — it is not (iOS: hundreds of
        // ms, unqueryable), so every display surface led the ear by exactly
        // that hop ("readout running ahead of playback", surviving two fixed
        // allowances). Measure it instead: a near-ultrasonic marker scheduled
        // into the tone graph at a known time, detected arriving on the
        // bridge by an analyser. One shot per boot, only while the transport
        // is idle; the result persists (bloopsStreamLag) so a skipped run
        // still has last boot's number.
        let _slDone = false, _micDone = false;
        const _calStream = () => {
          try {
            if (_slDone) return;
            // one stored measurement is enough — the stream hop is inside the
            // graph (route-independent), and every marker played is a chance
            // to be heard: the unenveloped first version's edge clicks WERE
            // the "blip after stopping"
            try { const v = parseFloat(localStorage.getItem('bloopsStreamLag')); if (Number.isFinite(v) && v >= 0) { _slDone = true; return; } } catch (e) {}
            const eng = (typeof _masterEng !== 'undefined') ? _masterEng : null;
            if (eng && eng.timer) { log('stream-lag calibration skipped (transport running)'); return; }
            if (document.visibilityState !== 'visible') return;
            const br = bridgeRefs.bridge;
            const an = br.createAnalyser(); an.fftSize = 2048;
            bridgeRefs.bSrc.connect(an);
            const buf = new Float32Array(an.fftSize);
            const F = 19200, srr = raw.sampleRate;
            const goertzel = () => {
              an.getFloatTimeDomainData(buf);
              const w = 2 * Math.PI * F / br.sampleRate;
              let s0 = 0, s1 = 0, s2 = 0;
              for (let i = 0; i < buf.length; i++) { s0 = buf[i] + 2 * Math.cos(w) * s1 - s2; s2 = s1; s1 = s0; }
              return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2)) / buf.length;
            };
            // noise floor first
            let floor = 0, fN = 0;
            const fTimer = setInterval(() => { floor = Math.max(floor, goertzel()); fN++; }, 30);
            setTimeout(() => {
              clearInterval(fTimer);
              const osc = raw.createOscillator(); osc.frequency.value = F;
              // ENVELOPED — an unenveloped start/stop is a broadband click at
              // each edge (a rectangular window on a near-ultrasonic tone),
              // audible where the tone itself is not; this was the reported
              // "blip after stopping"
              const og = raw.createGain(); og.gain.value = 0;
              osc.connect(og); og.connect(streamDest);
              const t0 = raw.currentTime + 0.06;
              const w0 = performance.now() + 60;   // wall time of the marker's graph start
              og.gain.setValueAtTime(0, t0);
              og.gain.linearRampToValueAtTime(0.02, t0 + 0.02);
              og.gain.setValueAtTime(0.02, t0 + 0.36);
              og.gain.linearRampToValueAtTime(0, t0 + 0.4);
              osc.start(t0); osc.stop(t0 + 0.42);
              const thr = Math.max(floor * 8, 0.0015);
              const deadline = performance.now() + 2500;
              const poll = setInterval(() => {
                const e = goertzel();
                if (e > thr) {
                  clearInterval(poll);
                  // subtract half the analyser window (the energy crosses the
                  // threshold once the marker fills part of the buffer)
                  const lag = Math.max(0, (performance.now() - w0) / 1000 - (an.fftSize / 2 / br.sampleRate));
                  _slDone = true;
                  try { localStorage.setItem('bloopsStreamLag', String(Math.min(1.5, lag).toFixed(3))); } catch (x) {}
                  log('stream lag measured: ' + Math.round(lag * 1000) + ' ms (floor ' + floor.toFixed(5) + ', hit ' + e.toFixed(5) + ')');
                  try { og.disconnect(); bridgeRefs.bSrc.disconnect(an); } catch (x) {}
                } else if (performance.now() > deadline) {
                  clearInterval(poll);
                  log('stream lag: marker never detected (floor ' + floor.toFixed(5) + ')');
                  try { og.disconnect(); bridgeRefs.bSrc.disconnect(an); } catch (x) {}
                }
              }, 8);
            }, 350);
          } catch (e) { log('stream-lag calibration failed: ' + e.message); }
        };
        // FULL-LOOP MIC CALIBRATION — the element's render pipeline
          // (el.currentTime → speaker) is unqueryable from JS and it is the
          // term that kept the display ahead of the ear after every modeled
          // fix (bridge hop measured at only 47 ms on-device). While stopped
          // the element plays the broadcast unmuted at the live edge, so a
          // marker fired into the graph exits the SPEAKER through the whole
          // real chain; the mic hears it, and full − mediaLag = the residue.
          // NEVER PROMPTS: runs only when mic permission is already granted
          // (the hum features ask for it); otherwise the fallback allowance
          // below stands.
        const _calMic = async () => {
            try {
              if (_micDone) return;
              // stored residue = done; clear localStorage bloopsResidue to force
              // a re-measure (e.g. after moving to Bluetooth)
              try { const v = parseFloat(localStorage.getItem('bloopsResidue')); if (Number.isFinite(v) && v >= 0) { _micDone = true; return; } } catch (e) {}
              const eng = (typeof _masterEng !== 'undefined') ? _masterEng : null;
              if (eng && eng.timer) { log('mic cal skipped (transport running)'); return; }
              if (document.visibilityState !== 'visible') { log('mic cal skipped (hidden)'); return; }
              let state = 'unknown';
              try { const q = await navigator.permissions.query({ name: 'microphone' }); state = q.state; } catch (e) {}
              if (state !== 'granted') { log('mic cal skipped (permission ' + state + ')'); return; }
              const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
              const br = bridgeRefs.bridge;
              const an = br.createAnalyser(); an.fftSize = 4096;
              const msrc = br.createMediaStreamSource(mic);
              msrc.connect(an);
              const buf = new Float32Array(an.fftSize);
              const F = 17500;
              const goe = () => {
                an.getFloatTimeDomainData(buf);
                const w = 2 * Math.PI * F / br.sampleRate;
                let s1 = 0, s2 = 0;
                for (let i = 0; i < buf.length; i++) { const s0 = buf[i] + 2 * Math.cos(w) * s1 - s2; s2 = s1; s1 = s0; }
                return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2)) / buf.length;
              };
              let floor = 0;
              const fT = setInterval(() => { floor = Math.max(floor, goe()); }, 30);
              setTimeout(() => {
                clearInterval(fT);
                const osc = raw.createOscillator(); osc.frequency.value = F;
                // enveloped for the same reason as the stream marker — edge
                // clicks are the audible part of a near-ultrasonic tone
                const og = raw.createGain(); og.gain.value = 0;
                osc.connect(og); og.connect(streamDest);
                const w0 = performance.now() + 100;
                const t0 = raw.currentTime + 0.1;
                og.gain.setValueAtTime(0, t0);
                og.gain.linearRampToValueAtTime(0.08, t0 + 0.025);
                og.gain.setValueAtTime(0.08, t0 + 0.55);
                og.gain.linearRampToValueAtTime(0, t0 + 0.6);
                osc.start(t0); osc.stop(t0 + 0.62);
                const thr = Math.max(floor * 6, 0.0012);
                const deadline = performance.now() + 4000;
                const poll = setInterval(() => {
                  const e = goe();
                  if (e > thr) {
                    clearInterval(poll);
                    const full = (performance.now() - w0) / 1000 - (an.fftSize / 2 / br.sampleRate);
                    const media = (typeof window._bloopsMseMediaLag === 'function') ? window._bloopsMseMediaLag() : 0;
                    const R = Math.max(0, Math.min(1.2, full - media));
                    _micDone = true;
                    try { localStorage.setItem('bloopsResidue', R.toFixed(3)); } catch (x) {}
                    log('mic cal: full=' + Math.round(full * 1000) + 'ms media=' + Math.round(media * 1000) + 'ms residue=' + Math.round(R * 1000) + 'ms (floor ' + floor.toFixed(5) + ' hit ' + e.toFixed(5) + ')');
                    try { og.disconnect(); msrc.disconnect(); mic.getTracks().forEach(t => t.stop()); } catch (x) {}
                  } else if (performance.now() > deadline) {
                    clearInterval(poll);
                    log('mic cal: marker not heard (floor ' + floor.toFixed(5) + ') — speaker/AAC may cut 17.5k');
                    try { og.disconnect(); msrc.disconnect(); mic.getTracks().forEach(t => t.stop()); } catch (x) {}
                  }
                }, 8);
              }, 400);
            } catch (e) { log('mic cal failed: ' + e.message); }
        };
        window.__bloopsCal = () => { _calStream(); setTimeout(() => { _calMic(); }, 3000); };
        // boot attempt (works when the app is opened and left idle)…
        setTimeout(window.__bloopsCal, 2500);
        // FOREGROUND / BACKGROUND MODE SWITCH: the broadcast's ~0.6-1 s lag is
        // the price of lock-proof playback — wrong for interactive use (grid
        // taps, auditions all land late). While VISIBLE the mix is audible
        // through the SHADOW element's live bridge stream (the pre-MSE mode-B
        // path, proven clean in foreground, ~50 ms) via fgGain, and the
        // broadcast element rides its cushion MUTED. At hide/lock fgGain ramps
        // to 0 (only the 25 Hz tone remains in the shadow — the validated
        // lock chain is untouched) and the broadcast unmutes once its
        // playhead reaches not-yet-heard material (a short gap at the
        // handoff, never an echo). EXACTLY ONE route carries the mix in
        // every state. Kill switch: localStorage bloopsFgDirect='0'.
        // OFF BY DEFAULT — REQUIREMENT: playback is CONTINUOUS AND SMOOTH
        // through lock/unlock, and that outranks foreground latency. The
        // broadcast is the one path that provably rides a lock untouched
        // (device-validated, 1.00 s/s straight through); fg mode makes every
        // lock a HANDOFF between two paths offset in time, and a handoff can
        // be made small but never seamless — three rounds of polishing the
        // seam (poll → sync unmute → interruption-ordered) each still
        // audible. Opt back in with localStorage bloopsFgDirect='1' only to
        // experiment; the latency answer within the broadcast is the modal +
        // 0.6 s cushion + speaker-synced display, all of which stay.
        // BACK TO OPT-IN (2026-09-05). Default-ON lasted one day and produced
        // the exact report fix #14 predicted: "pops/glitches when backgrounding,
        // when opening other apps, and when the phone is just sitting locked" —
        // the flight log shows the audible path HANDING OFF at every
        // interruption (boot→fg, interrupted→broadcast, visible→fg, twice in
        // 14 s of ordinary use), and while locked iOS's RECURRING interruptions
        // re-fire the handoff. A handoff between two paths offset in time can
        // be made small but never seamless — that was already established
        // three polishing rounds ago, and the continuity requirement is HARD
        // and outranks foreground latency (stated multiple times). The
        // foreground-latency answer must be designed INSIDE the broadcast
        // (rate-warped cushion, or a native monitor path) — never a runtime
        // handoff at lock/visibility edges. Stopped-state presses stay
        // immediate via the press-gated interactive monitor.
        let fgEnabled = false;
        try { if (localStorage.getItem('bloopsFgDirect') === '1') fgEnabled = true; } catch (e) {}
        if (fgEnabled) try {
          const fgGain = bridgeRefs.bridge.createGain();
          fgGain.gain.value = 0;
          bridgeRefs.bSrc.connect(fgGain); fgGain.connect(bridgeRefs.bDest);
          const ramp = (to, secs) => {
            try {
              const t = bridgeRefs.bridge.currentTime;
              fgGain.gain.cancelScheduledValues(t);
              fgGain.gain.setValueAtTime(fgGain.gain.value, t);
              fgGain.gain.linearRampToValueAtTime(to, t + secs);
            } catch (e) {}
          };
          // ORDERING IS THE WHOLE GAME AT A LOCK. The context INTERRUPTION
          // fires ~150-250 ms BEFORE visibilitychange (flight-measured: 5.07
          // vs 5.30), and for that window the live stream element was still
          // the audible path while WebKit's element→speaker pipeline did its
          // lock transition — the ORIGINAL lock artifact, reintroduced.
          // So the interruption itself is the hide signal: bail to the
          // broadcast in the statechange dispatch. And on unlock, the
          // switchback WAITS 350 ms so the reverse route transition happens
          // while the transition-immune broadcast is still what you hear.
          let fgState = null;          // null = before first transition
          let fgBackTimer = null;
          const wantFg = () => document.visibilityState === 'visible';
          const goBg = (why) => {
            if (fgState === false) return;
            fgState = false;
            if (fgBackTimer) { clearTimeout(fgBackTimer); fgBackTimer = null; }
            ramp(0, 0.012);
            window.__bloopsFgOn = false;
            try { if (window._bloopsMseFg) window._bloopsMseFg(false); } catch (e) {}
            log('audible path → broadcast [' + why + '] w=' + (Date.now() % 1000000));
          };
          const goFg = (why) => {
            if (fgState === true) return;
            fgState = true;
            if (fgBackTimer) { clearTimeout(fgBackTimer); fgBackTimer = null; }
            window.__bloopsFgOn = true;
            try { if (window._bloopsMseFg) window._bloopsMseFg(true); } catch (e) {}
            ramp(1, 0.12);   // soft entry — a hard cut between two paths 0.6 s apart reads as a glitch
            log('audible path → foreground stream [' + why + '] w=' + (Date.now() % 1000000));
          };
          const backSoon = (why, ms) => {
            if (fgBackTimer) clearTimeout(fgBackTimer);
            fgBackTimer = setTimeout(() => { fgBackTimer = null; if (wantFg()) goFg(why); }, ms);
          };
          document.addEventListener('visibilitychange', () => {
            if (wantFg()) backSoon('visible', 350);
            else goBg('hidden');
          });
          fgOnInterrupt = () => { if (fgState !== false) goBg('interrupted'); };
          // a FOREGROUND interruption with no hide following is spurious (the
          // tone context is interruption-prone even visible, probe-measured) —
          // come back once running again, on the same delayed path
          fgOnRunning = () => { if (fgState === false && wantFg() && !fgBackTimer) backSoon('recovered', 500); };
          if (wantFg()) goFg('boot'); else goBg('boot');
        } catch (e) { log('fg mode switch FAILED: ' + e.message); }
        // INTERACTIVE MONITOR — grid presses must sound IMMEDIATELY. While the
        // transport is STOPPED the broadcast element is hard-paused (the stop
        // requirement), which made every interactive press on the phone not
        // late but SILENT. This taps the mix straight to the BRIDGE context's
        // own destination — no media element, ~30-80 ms — and is connected
        // ONLY while stopped-and-visible: the broadcast is paused then, so
        // nothing plays twice, and the switch rides TRANSPORT edges, never
        // lock edges — while playing the bridge keeps no destination connect
        // and the lock-continuity invariant is untouched. The 1 s delay + ramp
        // after the stop edge keeps the engine's ring-out tails (which the
        // hard stop deliberately silences) from surfacing through the monitor.
        try {
          const mon = bridgeRefs.bridge.createGain();
          mon.gain.value = 0;
          // high-pass ahead of the speakers: a context suspend/resume freezes
          // the stream mid-sample and the step's DC content THUMPS — kill it
          const monHp = bridgeRefs.bridge.createBiquadFilter();
          monHp.type = 'highpass'; monHp.frequency.value = 28; monHp.Q.value = 0.7;
          // PRE-MASK source: presses stay audible while the stop gate holds
          // the broadcast at silence (and can never double into it)
          const monSrc = window.__bloopsMonTapStream
            ? bridgeRefs.bridge.createMediaStreamSource(window.__bloopsMonTapStream)
            : bridgeRefs.bSrc;
          monSrc.connect(monHp); monHp.connect(mon);
          let monOn = false, monConnected = false, monTimer = null;
          // TRANSIENT DUCK — the artifacts the monitor made audible (flight-
          // measured): the tone context is interrupted by app-switch gestures
          // (and spontaneously, even in foreground), and each suspend→resume
          // is a waveform discontinuity through this open speaker path. On any
          // statechange or visibility flap: hard-zero NOW, ramp back over
          // 450 ms — the pop lands in the silent window.
          // SOUND-ACTIVATED GATE — the duck alone was not enough (user-
          // confirmed): the SUSPEND-instant discontinuity happens BEFORE the
          // statechange event reaches JS, so a reactive mute always arrives
          // after the pop it exists to hide. The monitor is therefore CLOSED
          // by default and opens only around actual interactive notes
          // (playNote with no _ambEmitKey = a press, never generation): a
          // 20 ms open ramp on the press, held until the note's end + 2.5 s
          // of tail, then a 300 ms close. Idle — the exact state app switches
          // and menu taps happen in — the path is physically silent.
          let monHoldUntil = 0;
          monDuck = () => {
            try {
              if (!monConnected) return;
              const t = bridgeRefs.bridge.currentTime;
              mon.gain.cancelScheduledValues(t);
              mon.gain.setValueAtTime(0, t);
              if (monOn && performance.now() < monHoldUntil) mon.gain.linearRampToValueAtTime(1, t + 0.45);
            } catch (e) {}
          };
          document.addEventListener('visibilitychange', () => { try { if (monDuck) monDuck(); } catch (e) {} });
          // OPENING THE GATE IS PER *INTERACTIVE NOTE*, AND THERE ARE TWO KINDS.
          // This wrapped `playNote` only — but a GRID PRESS is a HELD note
          // (`polyStartCell` → `_polyStartSustain` → `startSustainedNote`), so
          // pressing the grid never opened the monitor at all. The gate happened
          // to be open for the first few presses only because the first
          // pointerdown fires `_bloopsWarmup`, whose playNote opened it for its
          // 2.5 s hold; once that expired every later press was audible ONLY
          // through the MSE broadcast, which runs ~1.4-2 s behind. That is the
          // reported "first 5 or so grid presses are fine, then those notes
          // replay (delayed) on top of what you're playing, then the grid
          // presses become delayed" — one mechanism, all three phases, and
          // invisible off-device because no browser uses the broadcast path.
          const monGate = (durMs, at) => {
            try {
              if (!(monOn && !window._ambEmitKey)) return;
              // THE MAIN PATH ALREADY HAS IT — opening here would be a second
              // audible copy of the same note. This is what "the grid notes
              // are sounding doubled" was: the foreground direct path went
              // default-on while the monitor still opened on every press, and
              // at boot the mask is OPEN (the transport has never stopped), so
              // both were live at once.
              if (window.__bloopsFgOn && !window.__bloopsMaskClosed) return;
              // CONNECT ON DEMAND — an armed-but-idle destination connect
              // left the bridge with an active output at the lock
              // transition, and the session renegotiation POPPED at the
              // system level (flight-measured, stop → lock ~10 s later).
              // Connected only press-to-tail, idle-stopped keeps exactly
              // the graph shape every seamless-lock validation ran with.
              if (!monConnected) { try { mon.connect(bridgeRefs.bridge.destination); monConnected = true; } catch (e) {} }
              const nowT = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
              const t2 = (typeof at === 'number' && at > 0) ? at : nowT;
              const endIn = Math.max(0, t2 - nowT) + Math.max(0.1, (+durMs || 300) / 1000);
              const bt = bridgeRefs.bridge.currentTime;
              mon.gain.cancelScheduledValues(bt);
              mon.gain.setValueAtTime(mon.gain.value, bt);
              mon.gain.linearRampToValueAtTime(1, bt + 0.02);
              if (monHoldUntil < performance.now()) log('monitor gate opens (press) w=' + (Date.now() % 1000000));
              monHoldUntil = Math.max(monHoldUntil, performance.now() + endIn * 1000 + 2500);
            } catch (e) {}
          };
          try {
            // A HELD note has no duration to end on — it ends at pointerup, and
            // that can be a long time. Hold the gate on a generous window and
            // let each further press extend it; a stuck-open gate at idle is
            // what the close sweep below exists for.
            if (!window.__bloopsMonWrappedSus && typeof window.startSustainedNote === 'function') {
              window.__bloopsMonWrappedSus = true;
              const oSN = window.startSustainedNote;
              window.startSustainedNote = function (freq, params, startAt) {
                monGate(3000, startAt);
                return oSN.apply(this, arguments);
              };
            }
          } catch (e) {}
          try {
            if (!window.__bloopsMonWrapped && typeof window.playNote === 'function') {
              window.__bloopsMonWrapped = true;
              const oPN = window.playNote;
              window.playNote = function (freq, params, durMs, at) {
                try {
                  monGate(durMs, at);
                } catch (e) {}
                return oPN.apply(this, arguments);
              };
            }
          } catch (e) {}
          setInterval(() => {
            let on = null;
            try { on = (typeof _vinylTransportOn === 'function') ? !!_vinylTransportOn() : null; } catch (e) {}
            if (on === null) return;
            const want = !on && document.visibilityState === 'visible';
            // gate close sweep — every tick: past the hold, ramp shut
            if (monConnected && monHoldUntil > 0 && performance.now() > monHoldUntil) {
              try {
                const t = bridgeRefs.bridge.currentTime;
                mon.gain.cancelScheduledValues(t);
                mon.gain.setValueAtTime(mon.gain.value, t);
                mon.gain.linearRampToValueAtTime(0, t + 0.3);
              } catch (e) {}
              monHoldUntil = 0;
              // fully release the speaker connect once the ramp is done —
              // idle must carry no output for a lock transition to tick through
              setTimeout(() => {
                try { if (monConnected && monHoldUntil === 0) { mon.disconnect(bridgeRefs.bridge.destination); monConnected = false; } } catch (e) {}
              }, 380);
            }
            if (want && !monOn) {
              monOn = true;
              monTimer = setTimeout(() => {
                monTimer = null;
                if (!monOn) return;
                // no connect here — the gate connects at the press and
                // releases after the tail (idle carries no speaker output)
                window.__BLOOPS_MONITOR_ON = true;
                log('interactive monitor ARMED (stopped) w=' + (Date.now() % 1000000));
              }, 1000);
            } else if (!want && monOn) {
              monOn = false;
              if (monTimer) { clearTimeout(monTimer); monTimer = null; }
              try {
                const t = bridgeRefs.bridge.currentTime;
                mon.gain.cancelScheduledValues(t);
                mon.gain.setValueAtTime(0, t);   // hard cut before the band's first onset
              } catch (e) {}
              try { if (monConnected) { mon.disconnect(bridgeRefs.bridge.destination); monConnected = false; } } catch (e) {}
              window.__BLOOPS_MONITOR_ON = false;
              log('interactive monitor OFF w=' + (Date.now() % 1000000));
            }
          }, 150);
        } catch (e) { log('interactive monitor FAILED: ' + e.message); }
        // STARTING MODAL (see armStartingModal): hidden the moment the AUDIBLE
        // clock (Tone.now − the measured broadcast lag) reaches the take's
        // start. The display clock subtracts the same lag (_shapeAudibleNow),
        // so bars hold at zero under the modal and start sweeping with the
        // first audible note.
        armStartingModal((edgeAt, E) => {
          const lag = (typeof window._bloopsMseOutLag === 'function') ? window._bloopsMseOutLag() : 0;
          const audible = ((typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0) - lag;
          const start = Number.isFinite(E._playStartAt) ? E._playStartAt : null;
          return start != null && audible >= start + 0.15;
        }, { cal: true });
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
      try { window.__bloopsNativeHold = false; } catch (e) {}
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
    // AN IN-APP PLAY OVERRIDES A LOCK-SCREEN PAUSE. Only the lock-screen ▶
    // cleared `userPaused`, so a hold outlived the app's own Play — and iOS
    // sends a media-session PAUSE by itself at launch, as the native engine
    // takes the session (measured 2026-09-30: 0.2 s before AUTOPLAY pressed
    // Play, every run). The music then played with the keep-alive element
    // paused and every rescue path standing down, so the first app switch
    // interrupted the context for good: 20 s of silence, never recovered even
    // back in the foreground. The transport's PLAY edge calls this.
    try { document.addEventListener('pointerdown', () => { window.__lastTouchAt = performance.now(); }, { capture: true, passive: true }); } catch (e) {}
    window.__bloopsReleaseHold = () => {
      if (!userPaused && !silencePaused) return false;
      userPaused = false; silencePaused = false;
      try { window.__bloopsNativeHold = false; } catch (e) {}
      try { if (bridge && bridge.state !== 'running') bridge.resume(); } catch (e) {}
      try { if (window._bloopsMseHold) window._bloopsMseHold(false); } catch (e) {}
      try { if (el.paused) kick(); } catch (e) {}
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
      return true;
    };
    // fg/bg mode-switch hooks — assigned by the MSE-armed block; the
    // statechange handler is the EARLIEST lock signal and must reach them
    let fgOnInterrupt = null, fgOnRunning = null;
    let monDuck = null;   // interactive monitor's transient duck — see the monitor block

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
          try { if (fgOnInterrupt) fgOnInterrupt(); } catch (e) {}
          try { if (monDuck) monDuck(); } catch (e) {}
          setTimeout(() => rescue('statechange'), 50);
        } else {
          try { if (fgOnRunning) fgOnRunning(); } catch (e) {}
          try { if (monDuck) monDuck(); } catch (e) {}
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
        try { window.__bloopsNativeHold = true; } catch (e) {}   // see the lock-screen pause
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

    // ENVELOPE METER — the instrument that should have existed first.
    //
    // Seven builds were aimed by ear at a reported "square wave tremolo",
    // because nothing on the device measured amplitude modulation: every
    // output-path counter (reserve, playbackRate, starvation) read CLEAN on
    // builds that sounded bad. They describe the plumbing, not the sound.
    //
    // A tremolo is objectively measurable: take the amplitude ENVELOPE of the
    // mix and look at its spectrum. A gate puts a sharp peak in it at the gate
    // rate. This taps the BRIDGE SOURCE — the mix as it leaves the graph, BEFORE
    // the AAC encode and the media element — so its verdict localises the fault:
    //   peak here      -> the mix itself is modulated (engine/DSP)
    //   nothing here   -> the mix is clean and the fault is BELOW: encode, MSE,
    //                     or the iOS output stage
    // `node test/probe-tremolo.js` asks exactly the same question of the desktop
    // engine, so the two are directly comparable. Desktop, on the user's real
    // project, measured a worst case of 7.8% (note rhythm); a real tremolo is
    // tens of percent at one sharp frequency.
    try {
      const EH = 100;                     // envelope sample rate -> resolves to 50 Hz
      const N = EH * 8;                   // 8 s window
      const eAn = bridgeRefs.bridge.createAnalyser();
      eAn.fftSize = 2048;
      bridgeRefs.bSrc.connect(eAn);
      const eBuf = new Float32Array(eAn.fftSize);
      const env = new Float32Array(N);
      let ei = 0, efull = false;
      setInterval(() => {
        eAn.getFloatTimeDomainData(eBuf);
        let s2 = 0;
        for (let i = 0; i < eBuf.length; i++) s2 += eBuf[i] * eBuf[i];
        env[ei] = Math.sqrt(s2 / eBuf.length);
        ei = (ei + 1) % N;
        if (ei === 0) efull = true;
      }, 1000 / EH);
      setInterval(() => {
        if (!efull) return;
        let mean = 0;
        for (let i = 0; i < N; i++) mean += env[i];
        mean /= N;
        if (mean < 1e-6) return;          // silence: nothing to report
        // plain DFT over 0.3-25 Hz; N is 800 points so this is cheap
        let bf = 0, bd = 0;
        for (let f = 0.3; f <= 25; f += 0.1) {
          let re = 0, im = 0;
          for (let i = 0; i < N; i++) {
            const ph = 2 * Math.PI * f * i / EH, v = env[i] - mean;
            re += v * Math.cos(ph); im += v * Math.sin(ph);
          }
          const d = (2 * Math.sqrt(re * re + im * im) / N) / mean;
          if (d > bd) { bd = d; bf = f; }
        }
        log('ENV peak=' + bf.toFixed(1) + 'Hz depth=' + (100 * bd).toFixed(1) + '%'
          + ' mean=' + mean.toFixed(5) + ' sr=' + bridgeRefs.bridge.sampleRate
          + ' vis=' + document.visibilityState);
      }, 10000);
      log('envelope meter armed (mix tap, pre-encode)');
    } catch (e) { log('envelope meter failed: ' + e.message); }

    // Shell-only heartbeat over the USB console: enough to tell "JS alive,
    // context rendering" from every other failure without a probe build.
    // localStorage bloopsNativeAudioBeats='0' silences it.
if (beatsOnRef.v) {
      setInterval(() => {
        try {
          // brct = the BRIDGE context's clock, so a deficit can be placed on
          // the heavy (tone) context or the light (bridge) one; the Bloom
          // governor's own view (voice cost vs budget) says whether shedding
          // voices is even the lever that could help.
          let gov = '';
          try {
            const hl = window.__bloomHealthLog;
            const L = hl && hl.length ? hl[hl.length - 1] : null;
            if (L) gov = ' cost=' + L.cost + ' bud=' + (L.budget != null ? L.budget : '?') + ' act=' + L.act;
          } catch (e) {}
          log('BEAT state=' + raw.state + ' br=' + (bridge ? bridge.state : '-') + ' sr=' + raw.sampleRate + ' ct=' + raw.currentTime.toFixed(2)
            + ' brct=' + (bridge ? bridge.currentTime.toFixed(2) : '-')
            + ' media=' + (el.paused ? 'paused' : el.currentTime.toFixed(2))
            + gov + ' vis=' + document.visibilityState);
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
        // ONE CARD, ONE OWNER (2026-09-21). `bloops.html` loads the Drive
        // Player too, and the Player now drives the lock screen as well — two
        // writers on one Now Playing card, and the last one to speak wins
        // whether or not it is the thing making the sound. Claiming here says
        // Bloom is, which is true: this runs when the native mix ARMS.
        try { window.__mediaSessionOwner = 'bloops'; } catch (e) {}
        // …and Bloom has no playlist, so the Player's ⏮ / ⏭ / scrubber are
        // dropped rather than left pointing at a Drive track behind a
        // generative piece. Only the actions THIS owner can honour survive.
        ['previoustrack', 'nexttrack', 'seekto'].forEach((a) => {
          try { navigator.mediaSession.setActionHandler(a, null); } catch (e) {}
        });
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Bloops',
          artist: 'generative music',
          artwork: [{ src: 'bloops-icon.png', sizes: '1024x1024', type: 'image/png' }],
        });
        navigator.mediaSession.playbackState = 'playing';
        const onSessionPause = (opts) => {
          // NOT EVERY "PAUSE" IS A PRESS. WebKit routes its OWN pause requests
          // to this handler too, and they started arriving with nobody touching
          // the phone (2026-09-30, every run): one as the native engine armed,
          // one 70 ms after the keep-alive element restarted, one 56 s into
          // visible playback. Honoured, each held the piece and stood the
          // keep-alive down, and the next app switch silenced it for good. A
          // real lock-screen press comes while HIDDEN; visible with no touch on
          // the page is the system talking to itself. Cost: a headphone or
          // Control Center pause while looking at the app is ignored — the
          // app's own Stop still works. `opts.forced` = the soak harness.
          let _vis = 'visible', _recent = false;
          try { _vis = document.visibilityState; } catch (e) {}
          try { _recent = !!window.__lastTouchAt && performance.now() - window.__lastTouchAt < 1500; } catch (e) {}
          if (_vis === 'visible' && !_recent && !(opts && opts.forced)) {
            log('session PAUSE while visible with no touch — not a user press, ignored');
            try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
            setTimeout(() => { try { if (el.paused && !userPaused && !silencePaused) kick(); } catch (e) {} }, 0);
            return;
          }
          userPaused = true;
          // STAND THE WEB KEEP-ALIVE WATCHDOG DOWN. `03-audio-bus-fx` polls
          // every 500 ms and resumes any context it finds suspended, and it
          // could only ever see `window.__bloopsAudioPaused` (Bloom's ⏸) —
          // `userPaused` is a module-local here. So a lock-screen pause
          // suspended the context and the watchdog resumed it half a second
          // later: the piece did not hold its place, and the suspend/resume
          // pair is itself a discontinuity. Its own comment predicted this
          // exact shape ("it looks like it works for ~500 ms and then the
          // context silently resumes under it").
          try { window.__bloopsNativeHold = true; } catch (e) {}
          // hold the BROADCAST element first — it is the audible copy, and
          // left running it would play out its buffered cushion and stall
          // (the old handlers only touched the shadow: "lock-screen pause
          // doesn't stop the music")
          try { if (window._bloopsMseHold) window._bloopsMseHold(true); } catch (e) {}
          try { el.pause(); } catch (e) {}
          try { raw.suspend(); } catch (e) {}
          try { if (bridge) bridge.suspend(); } catch (e) {}
          try { if (window._bloopsNativeFlush) window._bloopsNativeFlush(8, 200); } catch (e) {}
          try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
          // WHO SENT IT. iOS delivered this with nobody touching the phone in
          // 3 of 3 runs on 2026-09-30 (once at launch, once 56 s into visible
          // playback) and never on 09-28/29 — the source is not ours (the
          // native side has no remote-command code, session is mixWithOthers).
          // A real lock-screen press comes HIDDEN or from Control Center;
          // `vis=visible touch=…` with no recent touch is the unprompted kind.
          let _touchAgo = '?';
          try { if (window.__lastTouchAt) _touchAgo = Math.round(performance.now() - window.__lastTouchAt) + 'ms'; } catch (e) {}
          log('lock-screen pause — broadcast held, context suspended, piece holds its place'
            + ' [vis=' + document.visibilityState + ' focus=' + (document.hasFocus ? document.hasFocus() : '?')
            + ' touch=' + _touchAgo + ' ago]');
        };
        navigator.mediaSession.setActionHandler('pause', onSessionPause);
        // the soak harness (`AUTOPLAY=ownpause`) fires it exactly as iOS does
        if (window.__BLOOPS_SOAK) window.__bloopsSessionPause = onSessionPause;
        navigator.mediaSession.setActionHandler('play', () => {
          userPaused = false;
          try { window.__bloopsNativeHold = false; } catch (e) {}
          try { raw.resume(); } catch (e) {}
          try { if (bridge) bridge.resume(); } catch (e) {}
          kick();
          // release the broadcast AFTER the contexts are running again — it
          // re-enters like a play press (skip stale buffer, small cushion)
          try { if (window._bloopsMseHold) window._bloopsMseHold(false); } catch (e) {}
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
