    // =========================================================================
    // 03b-core-voices.js — bridge to the WASM voice engine (Phase 1)
    // =========================================================================
    // Routes eligible Bloom notes to the bloops-dsp core running in ONE
    // AudioWorklet with 16 stereo outputs — one per layer slot, each connected
    // into that layer's existing WebAudio chain, so layer strips/FX/mix are
    // unchanged. The old per-note engine remains the fallback for everything
    // not yet core-supported and whenever the flag is off.
    //
    // A/B: window.bloopsCore(true|false) — live; new notes route to the chosen
    // engine, sounding notes finish where they started. Persisted in
    // localStorage 'bloopsCoreVoices'.
    //
    // Phase-1 scope: plain 'sine' and 'fm' Bloom notes (no Design features, no
    // glide, no per-note FX). See _coreVoices.eligible.
    const _coreVoices = (() => {
      const SLOTS = 16;
      let node = null, ready = false, initing = false, failed = false;
      const slotByKey = new Map();   // layer key -> slot index
      const destBySlot = new Array(SLOTS).fill(null);
      const KINDS = { sine: 0, fm: 1 };

      function enabled() {
        try { return localStorage.getItem('bloopsCoreVoices') === '1'; } catch (e) { return false; }
      }
      async function init() {
        if (initing || ready || failed) return;
        initing = true;
        try {
          const ctx = Tone.getContext();
          await ctx.rawContext.audioWorklet.addModule('js/bloops/core/voice-processor.js');
          node = ctx.createAudioWorkletNode('bloops-voice-processor', {
            numberOfInputs: 0,
            numberOfOutputs: SLOTS,
            outputChannelCount: new Array(SLOTS).fill(2),
          });
          node.port.onmessage = (e) => {
            const d = e.data || {};
            if (d.ready) { ready = true; try { console.info('[bloops-core] WASM voice engine ready'); } catch (x) {} }
            if (d.error) { failed = true; try { console.warn('[bloops-core] engine error — falling back to node engine:', d.error); } catch (x) {} }
          };
          const bytes = await (await fetch('js/bloops/core/bloops-dsp.wasm')).arrayBuffer();
          node.port.postMessage({ wasmBytes: bytes }, [bytes]);
        } catch (e) {
          failed = true;
          try { console.warn('[bloops-core] init failed — node engine only:', e); } catch (x) {}
        } finally {
          initing = false;
        }
      }
      // A layer's chain input can be REBUILT (teardown/rebuild recreates the
      // node) — reconnect the slot when the destination object changes.
      function slotFor(key, dest) {
        if (!dest) return -1;
        let slot = slotByKey.get(key);
        if (slot == null) {
          if (slotByKey.size >= SLOTS) return -1;   // out of slots → fallback engine
          slot = slotByKey.size;
          slotByKey.set(key, slot);
        }
        if (destBySlot[slot] !== dest) {
          try { node.disconnect(slot); } catch (e) {}
          try { Tone.connect(node, dest, slot, 0); } catch (e) { return -1; }
          destBySlot[slot] = dest;
        }
        return slot;
      }
      // Cheap per-note FX check: any engaged per-note effect keeps the note on
      // the old engine (Bloom layer notes carry none by default).
      function _noPerNoteFx(p) {
        return !(p.reverb || p.delay || p.distortion || p.chorus || p.vibrato || p.tremolo
          || p.phaser || p.autoFilter || p.pingPong || p.autoPan || p.fxOverrideGlobal || p.bend);
      }
      function eligible(type, p) {
        if (!(type in KINDS)) return false;
        if (p.filter && p.filter.on) return false;
        if (p.filterEnv && p.filterEnv.on) return false;
        if (Array.isArray(p.modMatrix) && p.modMatrix.length) return false;
        if (p.osc) return false;              // Design oscillator features
        if (p.glideMs > 0) return false;
        if (p._detuneMod) return false;
        return _noPerNoteFx(p);
      }
      // Returns true when the note was taken by the core.
      function noteOn(key, dest, o) {
        if (!enabled() || failed) return false;
        if (!ready) { init(); return false; }  // warm up; fall back meanwhile
        const slot = slotFor(key, dest);
        if (slot < 0) return false;
        node.port.postMessage({
          cmd: 'note', slot, kind: KINDS[o.type], freq: o.freq, vel: o.vel,
          pan: Math.max(-1, Math.min(1, (o.pan || 0) / 100)),
          t: o.t, dur: o.dur, a: o.a, dcy: o.d, s: o.s, r: o.r, detune: o.detune || 0,
        });
        return true;
      }
      function cancelFrom(key, t) {
        const slot = slotByKey.get(key);
        if (ready && slot != null) node.port.postMessage({ cmd: 'cancelFrom', slot, t: (t == null ? 0 : t) });
      }
      function stopBefore(key, t) {
        const slot = slotByKey.get(key);
        if (ready && slot != null) node.port.postMessage({ cmd: 'stopBefore', slot, t: (t == null ? 1e12 : t) });
      }
      function stopAll() {
        if (ready) node.port.postMessage({ cmd: 'stopAll' });
      }
      return { enabled, eligible, noteOn, cancelFrom, stopBefore, stopAll, init };
    })();
    // Live A/B toggle from the console.
    try {
      window.bloopsCore = (on) => {
        try { localStorage.setItem('bloopsCoreVoices', on ? '1' : '0'); } catch (e) {}
        if (on) _coreVoices.init();
        else _coreVoices.stopAll();
        console.info('[bloops-core] core voices ' + (on ? 'ON' : 'OFF') + ' (new notes route accordingly)');
      };
    } catch (e) {}
