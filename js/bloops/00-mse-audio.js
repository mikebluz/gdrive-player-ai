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
    log('MSE stage: creating MMS');
    const mms = new ManagedMediaSource();
    try { el.pause(); } catch (e) {}
    el.srcObject = null;
    el.removeAttribute('src');
    el.disableRemotePlayback = true;
    try { if (!el.isConnected) { el.style.display = 'none'; document.body.appendChild(el); } } catch (e) {}
    el.src = URL.createObjectURL(mms);
    log('MSE stage: waiting for sourceopen (readyState=' + mms.readyState + ')');
    const opened = await new Promise((res) => {
      const t = setTimeout(() => res(false), 4000);
      mms.addEventListener('sourceopen', () => { clearTimeout(t); res(true); }, { once: true });
    });
    if (!opened) { log('MSE sourceopen never fired (readyState=' + mms.readyState + ')'); return false; }
    log('MSE stage: source open');
    const sb = mms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
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
    const CUSHION = 1.2;        // deep cushion: stall recovery
    const PLAY_CUSHION = 0.6;   // start-of-play cushion — the depth that rode a real
                                // device lock untouched; halves press-to-sound vs 1.2
    let needCushion = true;
    let cushionTarget = CUSHION;
    let stopHold = false;       // transport stopped → the element stays PAUSED
    let userHold = false;       // lock-screen pause → the element stays PAUSED
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
      if (document.visibilityState === 'visible' && !stopHold) {
        try { el.pause(); } catch (e) {} needCushion = true; cushionTarget = CUSHION;
      }
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
          // residual buffered music under the cover mute instead: the in-flight
          // pre-mask audio is ≤ ~0.5 s (tap block + encoder + segment batch),
          // the cushion stays intact, and nothing ends.
          try { el.muted = true; } catch (e) {}
          setTimeout(() => {
            try { if (stopHold && !fgMode) el.muted = false; } catch (e) {}
          }, 900);
          log('stop: gated immediately (element plays through under mute) w=' + (Date.now() % 1000000));
        }
        // PLAY EDGE: everything buffered ahead of the playhead is stale
        // content from before/during the stop — skip it, and rebuild only the
        // small start cushion so sound arrives ~0.6-0.9 s after the press.
        if (on === true && wasOn === false) {
          stopHold = false;
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
    let mtick = 0;
    setInterval(() => {
      try {
        // NOTHING may resume the element while the transport is stopped or a
        // lock-screen pause holds it — the auto-resume paths below were the
        // blip factory in every earlier design (a paused element + a
        // refilling buffer = a deferred tail).
        if (stopHold || userHold) {
          if (userHold) { if (!el.paused) { try { el.pause(); } catch (e) {} } }
          else {
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
        if (++mtick % 20 === 0 && sb.buffered.length) {
          log('MSESTAT elT=' + el.currentTime.toFixed(2)
            + ' bufEnd=' + sb.buffered.end(sb.buffered.length - 1).toFixed(2)
            + ' seq=' + seq + ' playing=' + !el.paused
            + ' outLag=' + (window._bloopsMseOutLag ? window._bloopsMseOutLag().toFixed(2) : '?'));
        }
        if (!sb.buffered.length) return;
        const end = sb.buffered.end(sb.buffered.length - 1);
        const lag = end - el.currentTime;
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
