// 00-mse-audio.js — the "radio station" output path for the native shell.
//
// The one class of audio that survives an iOS screen lock smoothly is a media
// element playing MEDIA DATA (files/streams — the Drive player proves it on
// this very phone). Everything live-generated (MediaStream srcObject, mixable
// native engines) gets a transition artifact at lock. So: encode the live mix
// to AAC on the fly (WebCodecs AudioEncoder), wrap it in fMP4 fragments, and
// feed it to an <audio> element through ManagedMediaSource — to iOS, Bloops
// becomes a streaming-audio app playing its own endless broadcast.
//
// This file is pure machinery (muxer + encoder pipeline); 00-native-audio.js
// decides whether to engage it. Inert unless started.
(function () {
  'use strict';

  // ---- minimal fMP4 writer (AAC-LC, stereo, one track) --------------------
  const u32 = (v) => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255];
  const u16 = (v) => [v >>> 8 & 255, v & 255];
  const str = (s) => Array.from(s, (c) => c.charCodeAt(0));
  function box(type, ...payloads) {
    const body = [].concat(...payloads);
    return [...u32(body.length + 8), ...str(type), ...body];
  }
  function full(type, ver, flags, ...payloads) {
    return box(type, [ver, flags >>> 16 & 255, flags >>> 8 & 255, flags & 255], ...payloads);
  }

  function initSegment(sr, asc) {
    // The encoder's decoderConfig.description is EITHER a bare
    // AudioSpecificConfig (2-5 bytes, per spec) OR a full ES_Descriptor
    // (WebKit hands ~39 bytes starting 0x03). Wrap only the bare form —
    // wrapping a descriptor inside a descriptor is a malformed esds and the
    // demuxer rejects the whole stream.
    const esdsBody = (asc.length > 5 && asc[0] === 0x03)
      ? asc
      : [0x03, 23 + asc.length, 0x00, 0x01, 0x00,
         0x04, 15 + asc.length, 0x40, 0x15, 0x00, 0x00, 0x00,
         ...u32(0), ...u32(0),
         0x05, asc.length, ...asc,
         0x06, 0x01, 0x02];
    const esds = full('esds', 0, 0, esdsBody);
    const mp4a = box('mp4a',
      [0,0,0,0,0,0, ...u16(1),                                      // reserved + data_ref_index
       0,0,0,0, 0,0,0,0,                                            // reserved
       ...u16(2), ...u16(16), 0,0,0,0,                              // channels, samplesize
       ...u16(sr), ...u16(0)],                                      // samplerate 16.16
      esds);
    const stbl = box('stbl',
      full('stsd', 0, 0, u32(1), mp4a),
      full('stts', 0, 0, u32(0)),
      full('stsc', 0, 0, u32(0)),
      full('stsz', 0, 0, u32(0), u32(0)),
      full('stco', 0, 0, u32(0)));
    const minf = box('minf',
      full('smhd', 0, 0, u32(0)),
      box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
      stbl);
    const mdia = box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(sr), u32(0), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), str('soun'), u32(0), u32(0), u32(0), str('Bloops'), [0]),
      minf);
    const trak = box('trak',
      full('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(0),
        u32(0), u32(0), [0,0,0,0,0,0,0,0], u16(0), u16(0), u16(0x0100), u16(0),
        u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0),
        u32(0), u32(0), u32(0x40000000), u32(0), u32(0)),
      mdia);
    const moov = box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
        u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0),
        u32(0), u32(0), u32(0x40000000),
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], u32(2)),
      trak,
      box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(1024), u32(0), u32(0))));
    return new Uint8Array([...box('ftyp', str('iso5'), u32(512), str('iso5'), str('iso6'), str('mp41')), ...moov]);
  }

  function mediaSegment(seq, baseTime, frames) {
    // frames: array of Uint8Array raw AAC access units, 1024 samples each
    const sizes = frames.map((f) => f.length);
    const total = sizes.reduce((a, b) => a + b, 0);
    const trun = full('trun', 0, 0x000201,                          // data-offset + sample-size present
      u32(frames.length), u32(0 /* patched below */),
      [].concat(...sizes.map(u32)));
    const traf = box('traf',
      full('tfhd', 0, 0x020008, u32(1), u32(1024)),                 // default-base-is-moof + default duration
      full('tfdt', 1, 0, u32(Math.floor(baseTime / 4294967296)), u32(baseTime >>> 0)),
      trun);
    const moof = box('moof', full('mfhd', 0, 0, u32(seq)), traf);
    // patch trun data_offset: moof size + 8 (mdat header)
    const moofArr = moof;
    const offAt = (() => {                                          // find trun data_offset position
      // trun sits at a fixed place from the end: total - (trun body) ... compute directly:
      // moof = [size type mfhd traf]; traf = [size type tfhd tfdt trun]
      // data_offset is 16 bytes into trun box (8 header + 4 verflags + 4 count)
      const trunSize = trun.length;
      return moofArr.length - trunSize + 16;
    })();
    const dataOffset = moofArr.length + 8;
    moofArr[offAt] = dataOffset >>> 24 & 255; moofArr[offAt + 1] = dataOffset >>> 16 & 255;
    moofArr[offAt + 2] = dataOffset >>> 8 & 255; moofArr[offAt + 3] = dataOffset & 255;
    const out = new Uint8Array(moofArr.length + 8 + total);
    out.set(moofArr, 0);
    out.set(u32(total + 8), moofArr.length); out.set(str('mdat'), moofArr.length + 4);
    let p = moofArr.length + 8;
    for (const f of frames) { out.set(f, p); p += f.length; }
    return out;
  }

  // ---- the pipeline --------------------------------------------------------
  // start(bridgeCtx, sourceNode, el, log) → resolves true when the element is
  // playing encoded mix. sourceNode is tapped via a worklet; el.src becomes
  // the ManagedMediaSource.
  async function start(ctx, sourceNode, el, log) {
    const startedAt = Date.now();   // the attach budget is measured from here
    let servoOn = true;   // localStorage bloopsMseServo='0' pins rate at 1.000 (A/B the servo)
    try { if (localStorage.getItem('bloopsMseServo') === '0') servoOn = false; } catch (e) {}
    if (typeof ManagedMediaSource === 'undefined' || typeof AudioEncoder === 'undefined') return false;
    if (!ManagedMediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')) return false;
    const sr = ctx.sampleRate;

    // 1. worklet tap → Float32 planar chunks
    const CHUNK = 2048;
    log('MSE stage: adding tap worklet');
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([
      "registerProcessor('mse-tap', class extends AudioWorkletProcessor {" +
      "  constructor() { super(); this.l = new Float32Array(" + CHUNK + "); this.r = new Float32Array(" + CHUNK + "); this.n = 0; }" +
      "  process(inputs) {" +
      "    const inp = inputs[0]; if (!inp || !inp[0]) return true;" +
      "    const L = inp[0], R = inp[1] || inp[0];" +
      "    for (let i = 0; i < L.length; i++) {" +
      "      this.l[this.n] = L[i]; this.r[this.n] = R[i];" +
      "      if (++this.n === " + CHUNK + ") {" +
      "        const l = this.l.slice(0), r = this.r.slice(0);" +
      "        this.port.postMessage({ l: l.buffer, r: r.buffer }, [l.buffer, r.buffer]);" +
      "        this.n = 0;" +
      "      }" +
      "    }" +
      "    return true;" +
      "  }" +
      "});"], { type: 'application/javascript' })));
    const tap = new AudioWorkletNode(ctx, 'mse-tap');
    sourceNode.connect(tap);
    const pull = ctx.createGain(); pull.gain.value = 0;
    tap.connect(pull); pull.connect(ctx.destination);

    // 2. MMS + element. MMS is picky: remote playback must be disabled
    // BEFORE src is assigned, and the element should live in the DOM.
    // ATTACHING THE MMS IS A RETRY, NOT A ONE-SHOT — and the budget is bounded
    // by the CALLER. `armMse` races start() against 8 s and arms the AVAudioEngine
    // fallback if the race wins; `armNativePlugin` only tests
    // `__BLOOPS_MSE_ACTIVE` at call time, so a LATE success would leave BOTH
    // paths audible (the "quiet voice then a loud copy" duplication). So every
    // attempt must finish comfortably inside 8 s.
    //
    // Why a retry at all: whether `sourceopen` fires depends on HOW EARLY in boot
    // the MMS is attached, and nothing else found so far. The run that worked
    // created it at 4.18 s (only because `audioWorklet.addModule` happened to
    // take 3.2 s) and opened 0.13 s later; the two that failed created it at
    // 0.52 s and 0.43 s and never opened, `readyState` stuck at `closed`.
    // DEMAND IS NOT THE GATE — the nudge below does give the element demand
    // (flight 2026-09-28 11:04 logs `mseEl event: waiting` at 0.47 s, then
    // `stalled`), and it still did not open. So retry across the early-boot
    // window and log what differs per attempt rather than guessing again.
    // Budget from when start() BEGAN, not from here: addModule above took 3.2 s
    // in one flight, and a deadline measured from this line would have pushed the
    // last attempt past the caller's race — the one thing that must not happen.
    // Bail outright if boot has already eaten the budget; a refusal is safe, a
    // late success is not.
    let mms = null, sb = null, attempt = 0;
    const attachBy = startedAt + 6800;
    if (Date.now() >= attachBy) {
      log('MSE: boot too slow to attach safely (' + (Date.now() - startedAt) + 'ms used) — leaving it to the fallback');
      return false;
    }
    while (Date.now() < attachBy) {
      attempt++;
      mms = new ManagedMediaSource();
      try { el.pause(); } catch (e) {}
      el.srcObject = null;
      el.removeAttribute('src');
      el.disableRemotePlayback = true;
      try { if (!el.isConnected) { el.style.display = 'none'; document.body.appendChild(el); } } catch (e) {}
      el.src = URL.createObjectURL(mms);
      if (attempt === 1) log('MSE stage: waiting for sourceopen (readyState=' + mms.readyState + ')');
      const opened = await new Promise((res) => {
        let done = false;
        // DECLARED BEFORE `finish` CLOSES OVER THEM. `finish` is reachable from the
        // sourceopen listener, which is registered before kick() runs — so if that
        // event ever dispatched synchronously, `clearInterval(nudge)` would be a
        // temporal-dead-zone throw. That is not hypothetical: the same shape took
        // the whole broadcast down on 2026-09-28 (`Cannot access 'servoOn' before
        // initialization` -> silent fallback). `npm run lint` pins it.
        let nudge = 0, t = 0;
        const finish = (v) => { if (!done) { done = true; clearInterval(nudge); clearTimeout(t); res(v); } };
        mms.addEventListener('sourceopen', () => finish(true), { once: true });
        // give the element real demand; with no source buffer it just stalls
        const kick = () => { try { el.play().catch(() => {}); } catch (e) {} };
        kick();
        nudge = setInterval(kick, 300);
        t = setTimeout(() => finish(false), 1200);
      });
      if (opened) {
        log('MSE stage: source open (attempt ' + attempt + ', ' + Math.round(performance.now()) + 'ms into boot)');
        log('MSE servo: ' + (servoOn ? 'ON' : 'OFF (bloopsMseServo=0, rate pinned 1.000)'));
        // the nudge left the element PLAYING — hand it back to the cushion gate,
        // or the first segment to land plays against a ~0 reserve
        try { el.pause(); } catch (e) {}
        sb = mms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
        break;
      }
      // the one line that will name the gate if this still fails
      log('MSE attach ' + attempt + ' no-open: mms=' + mms.readyState
        + ' elRS=' + el.readyState + ' net=' + el.networkState
        + ' err=' + (el.error ? el.error.code : '-')
        + ' paused=' + el.paused
        + ' act=' + (navigator.userActivation ? navigator.userActivation.hasBeenActive : '?')
        + ' vis=' + document.visibilityState
        + ' t=' + Math.round(performance.now()) + 'ms');
      try { URL.revokeObjectURL(el.src); } catch (e) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!sb) {
      log('MSE sourceopen never fired after ' + attempt + ' attempts — broadcast unavailable');
      return false;
    }
    let queue = [], appending = false;
    const pump = () => {
      if (appending || !queue.length || sb.updating) return;
      appending = true;
      const seg = queue.shift();
      try { sb.appendBuffer(seg); } catch (e) { log('MSE append failed: ' + e.message); }
    };
    sb.addEventListener('updateend', () => { appending = false; pump(); });

    // 3. encoder → muxer
    let asc = null, seq = 0, baseTime = 0, pending = [], inited = false;
    const SEG_FRAMES = 16;                                          // ≈ 0.34 s per segment
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        if (!inited) {
          const d = meta && meta.decoderConfig && meta.decoderConfig.description;
          asc = d ? new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer || d) : new Uint8Array([0x11, 0x90]);
          log('MSE desc[0..7]=' + Array.from(asc.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
          queue.push(initSegment(sr, Array.from(asc))); inited = true; pump();
          log('MSE init segment queued (asc ' + asc.length + 'B)');
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        pending.push(buf);
        if (pending.length >= SEG_FRAMES) {
          queue.push(mediaSegment(++seq, baseTime, pending));
          baseTime += pending.length * 1024;
          pending = []; pump();
        }
      },
      error: (e) => log('MSE encoder error: ' + e.message),
    });
    enc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: 2, bitrate: 160000 });

    let ts = 0;
    tap.port.onmessage = (ev) => {
      const l = new Float32Array(ev.data.l), r = new Float32Array(ev.data.r);
      const data = new Float32Array(l.length * 2);
      data.set(l, 0); data.set(r, l.length);
      try {
        enc.encode(new AudioData({
          format: 'f32-planar', sampleRate: sr, numberOfFrames: l.length,
          numberOfChannels: 2, timestamp: ts, data,
        }));
      } catch (e) { log('MSE encode failed: ' + e.message); }
      ts += Math.round(l.length / sr * 1e6);
    };

    // 4. playback rides the live edge with a jitter cushion; prune history
    // JITTER: with no cushion the element rides ~0.05s behind the encoder and
    // every main-thread hiccup starves it (measured). Hold playback until a
    // real cushion exists; after a foreground stall, rebuild it before resuming.
    // THE SERVO MODULE OWNS THE TUNABLES so one number has one home: CUSHION is
    // both the cushion gate's deep target and the servo's ride target, and two
    // copies of it would be two mechanisms. 00-mse-servo.js is pure arithmetic
    // and is pinned by `node test/mse-servo.js` (which replays real device
    // traces) — keep the servo's decisions THERE, not inline here, or the gate
    // stops testing what the app runs.
    const SERVO = (typeof window !== 'undefined' && window._bloopsMseServo) || null;
    const CUSHION = SERVO ? SERVO.DEFAULTS.cushion : 1.2;   // deep cushion: stall recovery
    const PLAY_CUSHION = 0.6;   // start-of-play cushion — the depth that rode a real
                                // device lock untouched; halves press-to-sound vs 1.2
    let needCushion = true;
    let cushionTarget = CUSHION;
    // preservesPitch ON makes a rate warp a TEMPO trim, not a transpose: a
    // semitone that snaps back at unlock would be unmissable, a few percent of
    // tempo drift while the phone is in a pocket is not.
    const SV = SERVO ? SERVO.create() : null;   // servo state; null = servo unavailable
    let rate = 1;         // last rate WRITTEN to the element (the servo owns its own)
    try { el.preservesPitch = true; } catch (e) {}
    try { el.webkitPreservesPitch = true; } catch (e) {}
    let stopHold = false;       // transport stopped → the element stays PAUSED
    let userHold = false;       // lock-screen pause → the element stays PAUSED
    let coverUntil = 0;         // media time the stop-cover mute must reach (0 = none)
    let coverGen = 0;           // generation, so a stale backstop cannot cut a newer cover short
    let fgMode = false;         // foreground: the low-latency stream path is
                                // audible and THIS element rides its cushion
                                // MUTED, ready to take over at hide/lock
    let unmuteAtMedia = 0;      // >0 = hidden, waiting to unmute at the media
                                // time where NOT-YET-HEARD material begins — a
                                // short gap at the handoff instead of an echo
                                // of the last second (the two paths are
                                // time-offset by the cushion; overlap = echo)
    window._bloopsMseFg = (on) => {
      fgMode = !!on;
      if (on) { try { el.muted = true; } catch (e) {} unmuteAtMedia = 0; }
      else {
        // HIDE HANDOFF — SYNCHRONOUS, in the visibilitychange dispatch. The
        // first design waited (muted) for the playhead to reach not-yet-heard
        // material, polled at 80 ms — but hidden pages throttle timers to
        // ~1 s, AND iOS pauses a muted media element the instant the app
        // backgrounds, so the handoff measured on-device as ~0.9 s of
        // SILENCE followed by a stall-recovery seek that landed 0.4 s behind
        // the heard boundary ("cut out briefly and stuttered"). Doing it
        // here: unmute NOW (an audible element is never OS-paused, so there
        // is no pause/resume seam at all) and seek to bufEnd − 0.6 — the
        // lock-proven cushion. ~0.6 s of just-heard material replays as the
        // broadcast takes over: continuity, never silence.
        try {
          if (sb.buffered.length) {
            const end = sb.buffered.end(sb.buffered.length - 1);
            const target = end - 0.6;
            if (target > el.currentTime) el.currentTime = target;
          }
        } catch (e) {}
        try { el.muted = false; } catch (e) {}
        try { if (el.paused && !stopHold && !userHold) { needCushion = false; el.play().catch(() => {}); } } catch (e) {}
        unmuteAtMedia = 0;
        log('bg handoff: unmuted synchronously at hide w=' + (Date.now() % 1000000));
      }
    };
    // LOCK-SCREEN PAUSE/PLAY: the shell suspends the contexts (the piece holds
    // its place), but the broadcast element would otherwise play out its
    // buffered cushion and then stall — the audible copy must be held too.
    // Release re-enters exactly like a play press: skip the stale pre-pause
    // buffer, rebuild the small cushion, resume with fresh material.
    window._bloopsMseHold = (on) => {
      userHold = !!on;
      if (on) {
        try { el.pause(); } catch (e) {}
        log('mse hold: paused (lock-screen) w=' + (Date.now() % 1000000));
      } else {
        try {
          if (sb.buffered.length) {
            const liveEnd = sb.buffered.end(sb.buffered.length - 1);
            if (liveEnd - 0.05 > el.currentTime) el.currentTime = liveEnd - 0.05;
          }
        } catch (e) {}
        needCushion = true; cushionTarget = PLAY_CUSHION;
        log('mse hold released: cushioning ' + PLAY_CUSHION + 's w=' + (Date.now() % 1000000));
      }
    };
    el.addEventListener('waiting', () => {
      if (stopHold) return;
      if (document.visibilityState === 'visible') {
        try { el.pause(); } catch (e) {} needCushion = true; cushionTarget = CUSHION;
        return;
      }
      // HIDDEN: a starve here used to fall through to NOTHING, and the 250 ms
      // loop then re-play()ed into an empty buffer — four pause→playing cycles
      // in 9 s (flight 2026-09-28). Pausing is not available as a recovery
      // while hidden (a paused renderer is what iOS reclassifies, popping the
      // session), so drop the consumer to the floor instead and let the servo
      // walk the reserve back up while the element stays audible throughout.
      // Undershoot the measured production rate so the reserve rebuilds; the
      // servo takes it from here on its next (throttled, ~2 s) tick.
      if (!SV) return;
      rate = SERVO.starve(SV);
      try { el.playbackRate = rate; } catch (e) {}
      log('starve while hidden — consumer to ' + rate.toFixed(3) + ', staying audible w=' + (Date.now() % 1000000));
    });
    // TRANSPORT EDGES on a FAST poll — the REQUIREMENT is that music stops the
    // INSTANT stop is pressed, and the 250 ms maintenance tick is too coarse
    // for that. Two earlier designs tried to play the engine's ringing tail
    // through the stop (seek to the live edge, ride a cushion, defer the
    // re-cushion) and BOTH produced audible artifacts — a starve hole, then a
    // deferred-tail blip ("cuts out, comes back, cuts out"). The broadcast is
    // ~0.5-1 s behind the graph, so ANY attempt to render the tail after the
    // press is playing the past. Hard pause wins: the tail rings into the
    // encoder unheard, and the element stays paused until the next play.
    let wasOn = null;
    setInterval(() => {
      try {
        // belt: the synchronous hide-handoff owns the unmute; this only
        // catches a missed visibilitychange (never observed — cheap insurance)
        // muted now has TWO owners: fg mode AND the stopped state (stop mutes
        // instead of pausing — fix #18). The belt must never unmute a hold, or
        // it re-opens the stop 80 ms after every press ("stop isn't immediate").
        if (!fgMode && el.muted && !stopHold && !userHold && !needCushion) {
          try { el.muted = false; } catch (e) {}
          log('bg handoff belt: unmuted by poll w=' + (Date.now() % 1000000));
        }
        let on = null;
        try { on = (typeof _vinylTransportOn === 'function') ? !!_vinylTransportOn() : null; } catch (e) {}
        if (on === null) return;
        // BOOT SHAPE: the transport is stopped at boot but no edge has fired,
        // so the stop gate sat OPEN — a boot-time press reached the broadcast
        // ~1.4 s late on top of the monitor's immediate copy (a double). Close
        // it once, to match the state; the first play edge opens it as usual.
        if (wasOn === null && on === false && !window.__bloopsMaskClosed) {
          try { if (window._bloopsStopGate) window._bloopsStopGate(true); } catch (e) {}
        }
        if (on === false && wasOn === true) {
          stopHold = true; needCushion = false;
          // THE STOP GATE owns immediacy now: the graph is muted at the mask
          // (tails cut instantly) and the element KEEPS PLAYING UNMUTED — a
          // muted-or-paused renderer is what iOS reclassifies at background,
          // popping the session transition (flight-measured twice). The brief
          // mute here only covers the ~1 s of already-buffered pre-stop music
          // while we skip past it; content after the skip is true silence, so
          // the unmute at +500 ms is inaudible and the stopped state looks
          // IDENTICAL to playing as far as the session is concerned.
          try { if (window._bloopsStopGate) window._bloopsStopGate(true); } catch (e) {}
          // NO SEEK — seeking to the live edge left ~50 ms of buffer against a
          // ~0.34 s segment batch, the element hit 'ended', and an ENDED
          // renderer is the "playback finished" signal that makes iOS
          // re-evaluate the session (flight: stop → ended → interrupted 1.35 s
          // later = the tick, reintroduced). The element plays THROUGH the
          // residual buffered music under the cover mute instead: the cushion
          // stays intact and nothing ends.
          // THE COVER IS MEASURED, NEVER A FIXED DELAY. It was 900 ms on the
          // claim that in-flight pre-mask audio is ≤ ~0.5 s; flight 2026-09-28
          // measured 1.25-1.56 s all session, so the last 0.4-0.7 s of pre-stop
          // music played out ~0.9 s AFTER the press — the intermittent "blip at
          // stop". ts/1e6 is the production head, so everything before it is
          // pre-gate material and everything after is true silence: unmute when
          // the PLAYHEAD passes it, whatever the reserve happens to be. The
          // rate servo deepens the reserve, which would have made a fixed cover
          // steadily worse.
          try { el.muted = true; } catch (e) {}
          coverUntil = ts / 1e6 + (CHUNK / sr);
          // backstop: a stalled playhead must never leave the element muted —
          // an OS-visible mute is the reclassification trigger this all avoids.
          // Generation-tagged: stop → play → stop inside 4 s otherwise lets the
          // FIRST press's backstop fire against the SECOND press's cover.
          const gen = ++coverGen;
          setTimeout(() => {
            try {
              if (stopHold && !fgMode && coverUntil && coverGen === gen) {
                coverUntil = 0; el.muted = false;
                log('stop cover released by backstop w=' + (Date.now() % 1000000));
              }
            } catch (e) {}
          }, 4000);
          log('stop: gated immediately (element plays through under mute, cover to media '
            + coverUntil.toFixed(2) + ' = +' + (coverUntil - el.currentTime).toFixed(2) + 's) w=' + (Date.now() % 1000000));
        }
        // PLAY EDGE: everything buffered ahead of the playhead is stale
        // content from before/during the stop — skip it, and rebuild only the
        // small start cushion so sound arrives ~0.6-0.9 s after the press.
        if (on === true && wasOn === false) {
          stopHold = false;
          coverUntil = 0;   // the cushion gate owns the unmute from here
          try { if (window._bloopsStopGate) window._bloopsStopGate(false); } catch (e) {}
          if (sb.buffered.length) {
            const liveEnd = sb.buffered.end(sb.buffered.length - 1);
            if (liveEnd - 0.05 > el.currentTime) el.currentTime = liveEnd - 0.05;
          }
          try { el.pause(); } catch (e) {}
          needCushion = true; cushionTarget = PLAY_CUSHION;
          log('play-edge: skipped stale content; cushioning ' + PLAY_CUSHION + 's w=' + (Date.now() % 1000000));
        }
        wasOn = on;
      } catch (e) {}
    }, 80);
    let mtick = 0;        // wall ms of the last periodic MSESTAT line
    let lastThin = 0;     // wall ms of the last THIN-reserve warning
    setInterval(() => {
      try {
        // NOTHING may resume the element while the transport is stopped or a
        // lock-screen pause holds it — the auto-resume paths below were the
        // blip factory in every earlier design (a paused element + a
        // refilling buffer = a deferred tail).
        if (stopHold || userHold) {
          // a held element consumes nothing — the servo has no error to act on
          if (rate !== 1) {
            rate = 1;
            if (SV) SERVO.reset(SV);
            try { el.playbackRate = 1; } catch (e) {}
          }
          if (userHold) { if (!el.paused) { try { el.pause(); } catch (e) {} } }
          else {
            // COVER RELEASE: the playhead has passed the last pre-gate material,
            // so what follows is true silence and the unmute is inaudible.
            if (coverUntil && el.currentTime >= coverUntil) {
              coverUntil = 0;
              if (!fgMode) { try { el.muted = false; } catch (e) {} }
              log('stop cover released at media ' + el.currentTime.toFixed(2) + ' w=' + (Date.now() % 1000000));
            }
            // stopped = the element plays true silence UNMUTED (the stop gate
            // holds the graph at zero) — never re-mute here, an OS-visible
            // mute is exactly the reclassification trigger being avoided.
            // If it somehow ENDED (buffer momentarily drained), re-enter just
            // behind the live edge — an element left 'ended' is a finished
            // renderer to the session, the reclassification trigger itself.
            try {
              if (el.ended && sb.buffered.length) {
                const end = sb.buffered.end(sb.buffered.length - 1);
                if (end > 0.3) el.currentTime = end - 0.3;
              }
            } catch (e) {}
            if (el.paused && document.visibilityState === 'visible') { try { el.play().catch(() => {}); } catch (e) {} }
          }
          if (sb.buffered.length) {
            const endS = sb.buffered.end(sb.buffered.length - 1);
            const startS = sb.buffered.start(0);
            if (endS - startS > 30 && !sb.updating && !queue.length) sb.remove(startS, endS - 10);
          }
          return;
        }
        if (needCushion && sb.buffered.length) {
          const end0 = sb.buffered.end(sb.buffered.length - 1);
          if (end0 - el.currentTime >= cushionTarget) {
            needCushion = false;
            if (!fgMode) { try { el.muted = false; } catch (e) {} }
            el.play().catch(() => {});
          }
        }
        // WALL-CLOCK cadence, not a tick count: the loop is throttled to ~2 s
        // while hidden, so `% 20` sampled every 40 s there and a brief starve
        // fell between samples entirely.
        if (sb.buffered.length && Date.now() - mtick >= 5000) {
          mtick = Date.now();
          log('MSESTAT elT=' + el.currentTime.toFixed(2)
            + ' bufEnd=' + sb.buffered.end(sb.buffered.length - 1).toFixed(2)
            + ' seq=' + seq + ' playing=' + !el.paused
            + ' rate=' + el.playbackRate.toFixed(3) + ' vis=' + document.visibilityState
            // the ENCODER HEAD, so a harvested log yields a faithful production
            // trace: bufEnd is quantised to 0.372 s segments, and sampling that
            // every 5 s aliases to +/-7.4% — which is indistinguishable from real
            // production wobble and poisoned the servo gate's first fixtures.
            + ' head=' + (ts / 1e6).toFixed(3)
            + ' outLag=' + (window._bloopsMseOutLag ? window._bloopsMseOutLag().toFixed(2) : '?'));
        }
        if (!sb.buffered.length) return;
        const end = sb.buffered.end(sb.buffered.length - 1);
        const lag = end - el.currentTime;
        // THE RATE SERVO — rate MATCHING, not depth building. The element consumes
        // at playbackRate × wall exactly, while production is NOT realtime (measured
        // 0.873 and 0.907 across two hidden stretches on 2026-09-28, which starved
        // it to 'ended' twice). Why feed-forward rather than feedback, why the
        // derivative avoids `lag`, and why the slew cap is per second: all in
        // js/bloops/00-mse-servo.js, pinned by `node test/mse-servo.js`.
        //
        // KILL SWITCH — `localStorage.bloopsMseServo = '0'` pins the rate at 1.000
        // and reverts to the pre-servo behaviour, so "is the servo causing this?"
        // is an A/B you can run in seconds instead of a rebuild. It is a real
        // question to be able to ask: the servo's first version was itself heard
        // as a square-wave tremolo, and only a comparison separates a servo
        // artifact from a starvation artifact by ear.
        if (!servoOn) {
          if (rate !== 1) {
            rate = 1;
            if (SV) SERVO.reset(SV);
            try { el.playbackRate = 1; } catch (e) {}
          }
        } else if (SV && !needCushion && !el.paused) {
          // ALL the arithmetic lives in 00-mse-servo.js, replayed against real
          // device traces by `node test/mse-servo.js`. Here we only supply the
          // physical readings and apply the answer.
          //   lag      the reserve the element can actually PLAY (segment-quantised)
          //   prodHead the encoder's head, ~46 ms resolution
          //   headroom the same reserve at that finer resolution — the servo takes
          //            its derivative on this, never on lag (one 0.372 s segment
          //            step inside a 2 s window fakes a slope of +/-0.186/s, which
          //            is the square-wave tremolo of 2026-09-28)
          const prodHead = ts / 1e6;
          const want = SERVO.step(SV, {
            nowS: Date.now() / 1000,
            lag: lag,
            prodHead: prodHead,
            headroom: prodHead - el.currentTime,
          });
          if (Math.abs(want - rate) > 0.0005) {
            rate = want;
            try { el.playbackRate = rate; } catch (e) {}
          }
          // A near-empty reserve is the one event worth a line of its own — the
          // periodic stat can still miss it, and it is the direct precursor of
          // every 'ended'. Rate-limited so a sustained dip cannot flood the log.
          if (lag < 0.4 && Date.now() - lastThin > 1000) {
            lastThin = Date.now();
            log('THIN reserve=' + lag.toFixed(2) + ' rate=' + rate.toFixed(3)
              + ' vis=' + document.visibilityState + ' w=' + (Date.now() % 1000000));
          }
        }
        // NEVER SEEK BACKWARD. When production stalls (a lock-time context
        // suspension, or the user stopping the transport), the buffered end
        // freezes — a rewind then replays the same tail forever, which is
        // audibly "a long buffer loop" and "it kept playing after stop".
        // Fall silent at the live edge and wait for fresh segments instead.
        const target = Math.max(sb.buffered.start(0), end - 1.0);
        if ((el.paused || lag > 3) && target > el.currentTime + 0.05) el.currentTime = target;
        if (el.paused && !needCushion) el.play().catch(() => {});
        const start0 = sb.buffered.start(0);
        if (end - start0 > 30 && !sb.updating && !queue.length) sb.remove(start0, end - 10);
      } catch (e) {}
    }, 250);

    const kicked = true;   // playback starts via the cushion gate above
    // RENDER→SPEAKER LAG: material rendered at graph time T is heard when the
    // element's playhead reaches it — the delay is (shipped − played), i.e.
    // ts/1e6 (total tapped audio handed to the encoder) minus el.currentTime,
    // plus the tap worklet's own chunk (2048 frames). While the element is
    // paused (play-edge cushioning) the lag GROWS, which is exactly right:
    // an audible clock derived as (now − lag) FREEZES until sound resumes.
    // Display code subtracts this so progress bars track what is HEARD.
    window._bloopsMseOutLag = () => {
      try {
        // the route's physical output latency (Bluetooth is the big case) —
        // the media-timeline formula below cannot see it, and without it the
        // display leads the ear by exactly this much on every surface
        const outLat = (typeof window._bloopsOutputLatency === 'function') ? window._bloopsOutputLatency() : 0;
        // foreground: the audible path is the live bridge stream, not this
        // element — the display should track that (~stream-element latency)
        if (fgMode) return 0.08;
        // stopped + interactive monitor: presses are audible ~immediately on
        // the bridge's direct path — preview highlights etc. must not add the
        // (paused) broadcast's stale lag
        if (window.__BLOOPS_MONITOR_ON) return 0.06;
        const lag = (ts / 1e6) - el.currentTime + (CHUNK / sr) + outLat;
        return Math.max(0, Math.min(8, lag));
      } catch (e) { return 0; }
    };
    // raw media-timeline lag (encode head vs element position), NO residue —
    // the mic calibrator subtracts this from the measured full-loop latency
    // to isolate the element's unqueryable render-pipeline depth
    window._bloopsMseMediaLag = () => {
      try { return Math.max(0, Math.min(8, (ts / 1e6) - el.currentTime + (CHUNK / sr))); } catch (e) { return 0; }
    };
    window._bloopsMseStats = () => ({
      buffered: sb.buffered.length ? +(sb.buffered.end(sb.buffered.length - 1) - el.currentTime).toFixed(2) : null,
      elT: +el.currentTime.toFixed(2), seq, queued: queue.length, playing: !el.paused,
    });
    return kicked || true;
  }

  window._bloopsMse = { start };
})();
