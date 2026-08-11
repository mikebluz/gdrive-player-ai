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
    // Core-supported kinds (each spectrally calibrated against recorded Tone
    // output): sine, fm, bass, bell, xylo, am, pad — plain Bloom notes only
    // (no Design features, no glide, no per-note FX). See _coreVoices.eligible.
    const _coreVoices = (() => {
      const SLOTS = 16;
      let node = null, ready = false, initing = false, failed = false;
      const slotByKey = new Map();   // layer key -> slot index (voices + strips share it)
      const destBySlot = new Array(SLOTS).fill(null);
      // Phase 2: in-core layer strips. key -> handle {slot, input, cmd, ...}.
      // Only meaningful when BOTH flags are on; strips release their slots on
      // layer teardown (Phase-1 voice-only slots are never released).
      const stripByKey = new Map();
      const freeSlots = [];
      const KINDS = { sine: 0, fm: 1, bass: 2, bell: 3, xylo: 4, am: 5, pad: 6,
                      duo: 7, kick: 9, metal: 10, pluck: 11, wavetable: 12 };
      // basic waves render as kind 13 with a wave id param
      const WAVES = { square: 0, triangle: 1, sawtooth: 2, pulse: 3, fat: 4 };
      // kinds that accept Design params (filter/env/matrix/osc) in the core
      const DESIGN_OK = { 0: 1, 1: 1, 5: 1, 13: 1, 14: 1 };
      const LFO_SHAPES = { sine: 0, triangle: 1, sawtooth: 2, square: 3, smooth: 4, sharp: 5 };
      const MOD_SRC = { lfo1: 0, lfo2: 1, env2: 2, vel: 3, macro1: 4, macro2: 5, macro3: 6, macro4: 7 };
      const MOD_DEST = { pitch: 0, cutoff: 1, reso: 2, amp: 3, pan: 4 };
      // 'noise' / 'noise:white|pink|brown' → kind 8 + color param
      function kindFor(type) {
        if (typeof type !== 'string') return null;
        if (type.indexOf('noise') === 0) {
          const c = type.indexOf(':') >= 0 ? type.split(':')[1] : 'white';
          return { kind: 8, p0: c === 'brown' ? 2 : (c === 'pink' ? 1 : 0) };
        }
        if (type in WAVES) return { kind: 13, p0: WAVES[type] };
        // hard sync (core kind 14): p0 = slave/master ratio. 2.5 default —
        // non-integer, so the sync formant is audible (integer ratios
        // degenerate to a plain saw at ratio·f). Design patches override
        // ratio/sweep via osc.harmonicity/modIndex (dp[16]/dp[17]).
        if (type === 'sync') return { kind: 14, p0: 2.5 };
        return (type in KINDS) ? { kind: KINDS[type], p0: 0 } : null;
      }

      // DEFAULT ON (since the Phase 2+3 ear-test soak): unset = enabled;
      // window.bloopsCore(false) / bloopsCoreStrips(false) are the kill
      // switches (persisted '0'). The node engine remains the automatic
      // fallback for cold starts, ineligible notes, and slot exhaustion.
      function enabled() {
        try { return localStorage.getItem('bloopsCoreVoices') !== '0'; } catch (e) { return false; }
      }
      // Phase 2 sub-flag: run the layer strip (vcf/eq/vca/level/tg/gate/pan)
      // and FX inside the core, slot outputs wired straight to the bus.
      // ONE-TIME SELF-REPAIR. A shipped bug called `bloopsCoreStrips()` as though it
      // were a getter; it is a SETTER, so the no-argument call wrote '0' and disabled
      // the core engine on any browser that merely opened the Bloom panel. Clear that
      // once, restoring the default, and leave a marker so a DELIBERATE later choice
      // is never touched again. Runs before anything reads the flag.
      try {
        if (localStorage.getItem('bloopsCoreStripsRepair') !== '1') {
          if (localStorage.getItem('bloopsCoreStrips') === '0') {
            localStorage.removeItem('bloopsCoreStrips');
            console.info('[bloops-core] core strips were disabled by a known bug — restored to the default (on).');
          }
          localStorage.setItem('bloopsCoreStripsRepair', '1');
        }
      } catch (e) {}
      function stripsEnabled() {
        try { return enabled() && localStorage.getItem('bloopsCoreStrips') !== '0'; } catch (e) { return false; }
      }
      async function init() {
        if (initing || ready || failed) return;
        initing = true;
        try {
          const ctx = Tone.getContext();
          await ctx.rawContext.audioWorklet.addModule('js/bloops/core/voice-processor.js?v=DEPLOYVER');
          // 16 inputs = per-slot strip inputs (node-rendered voices/samples
          // under Phase-2 strips); 17th output = the summed reverb-send bus.
          node = ctx.createAudioWorkletNode('bloops-voice-processor', {
            numberOfInputs: SLOTS,
            numberOfOutputs: SLOTS + 1,
            outputChannelCount: new Array(SLOTS + 1).fill(2),
            channelCount: 2,
            channelCountMode: 'clamped-max',
          });
          node.port.onmessage = (e) => {
            const d = e.data || {};
            if (d.ready) { ready = true; try { console.info('[bloops-core] WASM voice engine ready (rev ' + (d.rev || '?') + ')'); } catch (x) {} }
            if (d.error) { failed = true; try { console.warn('[bloops-core] engine error — falling back to node engine:', d.error); } catch (x) {} }
          };
          // cache: 'no-cache' revalidates the .wasm with the server on every
          // load — a stale cached core silently reintroduces fixed DSP bugs.
          const bytes = await (await fetch('js/bloops/core/bloops-dsp.wasm?v=DEPLOYVER', { cache: 'no-cache' })).arrayBuffer();
          // Keep a copy for offline bounce sessions — postMessage TRANSFERS
          // the buffer (it's neutered after this line), and the bounce should
          // not depend on a second network fetch.
          try { _wasmCopy = bytes.slice(0); } catch (e) {}
          node.port.postMessage({ wasmBytes: bytes }, [bytes]);
          // Keep-pull sink: a permanent zero-gain path to the destination so
          // the graph ALWAYS renders this node. Without it, tearing down the
          // layer chains between plays disconnects every output — Chrome
          // stops pulling, voices freeze mid-release, and their fade tails
          // replayed as a ghost blip at the NEXT play's first note.
          // It hangs off the SEND output (16), which nothing ever calls
          // node.disconnect(16) on — slot outputs get disconnected on
          // reconnect/release, which would silently drop a slot-0 sink.
          try {
            const keep = new Tone.Gain(0);
            Tone.connect(node, keep, SLOTS, 0);
            keep.toDestination();
          } catch (e) {}
        } catch (e) {
          failed = true;
          try { console.warn('[bloops-core] init failed — node engine only:', e); } catch (x) {}
        } finally {
          initing = false;
        }
      }
      function allocSlot() {
        if (freeSlots.length) return freeSlots.pop();
        if (slotByKey.size >= SLOTS) return -1;
        const used = new Set(slotByKey.values());
        for (let i = 0; i < SLOTS; i++) if (!used.has(i)) return i;
        return -1;
      }
      // A layer's chain input can be REBUILT (teardown/rebuild recreates the
      // node) — reconnect the slot when the destination object changes.
      function slotFor(key, dest) {
        // strip-managed key: the slot output is already wired to the bus and
        // must NOT be re-routed to the note's dest (that's the strip input).
        if (stripByKey.has(key)) return slotByKey.get(key);
        if (!dest) return -1;
        let slot = slotByKey.get(key);
        if (slot == null) {
          slot = allocSlot();
          if (slot < 0) return -1;   // out of slots → fallback engine
          slotByKey.set(key, slot);
        }
        if (destBySlot[slot] !== dest) {
          try { node.disconnect(slot); } catch (e) {}
          try { Tone.connect(node, dest, slot, 0); } catch (e) { return -1; }
          destBySlot[slot] = dest;
        }
        return slot;
      }
      // ---- Phase 2: strip lifecycle -------------------------------------
      const _post = (m) => { try { node.port.postMessage(m); } catch (e) {} };
      // A WebAudio-param shim over one strip value (0 gate / 1 level /
      // 2 revSend / 3 pan): mirrors value/cancel/set/ramp onto strip_setv /
      // strip_rampv and tracks the segment locally so `.value` reads work.
      // Covers every param write-site in 17-ambient without branching them.
      function makeShimParam(slot, which, init, post) {
        post = post || _post;
        const seg = { t0: 0, v0: init, t1: 0, v1: init };
        let anchor = null;
        const now = () => { try { return Tone.getContext().rawContext.currentTime; } catch (e) { return 0; } };
        const evalAt = (t) => (t <= seg.t0 || seg.t1 <= seg.t0) ? (t >= seg.t1 ? seg.v1 : seg.v0)
          : t >= seg.t1 ? seg.v1
          : seg.v0 + (seg.v1 - seg.v0) * ((t - seg.t0) / (seg.t1 - seg.t0));
        const p = {
          get value() { return evalAt(now()); },
          set value(v) {
            anchor = null; seg.t0 = seg.t1 = 0; seg.v0 = seg.v1 = v;
            post({ cmd: 'strip', fn: 'strip_setv', a: [slot, which, v] });
          },
          cancelScheduledValues() { anchor = null; return p; },
          setValueAtTime(v, t) {
            anchor = { t: t || now(), v };
            // a lone set must still land core-side; a following linearRamp
            // just overwrites this degenerate segment
            seg.t0 = anchor.t; seg.v0 = v; seg.t1 = anchor.t; seg.v1 = v;
            post({ cmd: 'strip', fn: 'strip_rampv', a: [slot, which, anchor.t, v, v, 0.005] });
            return p;
          },
          linearRampToValueAtTime(v1, t1) {
            const a = anchor || { t: now(), v: evalAt(now()) };
            anchor = null;
            seg.t0 = a.t; seg.v0 = a.v; seg.t1 = Math.max(t1, a.t + 0.005); seg.v1 = v1;
            post({ cmd: 'strip', fn: 'strip_rampv', a: [slot, which, a.t, a.v, v1, Math.max(0.005, t1 - a.t)] });
            return p;
          },
          rampTo(v, dur) {
            const t = now();
            p.setValueAtTime(evalAt(t), t);
            return p.linearRampToValueAtTime(v, t + Math.max(0.005, dur || 0.03));
          },
        };
        return p;
      }
      // Acquire an in-core strip for a layer: slot output → the Bloom bus,
      // a feeder Gain → the worklet input (node-rendered voices/samples).
      // Returns null when strips are off / engine not ready / out of slots —
      // caller falls back to the node strip.
      function stripAcquire(key, bus) {
        if (offline()) return stripsEnabled() ? _offStripAcquire(key, bus) : null;   // bounce in flight
        if (!stripsEnabled() || failed || !bus) return null;
        if (!ready) { init(); return null; }
        if (!_running()) return null;
        const have = stripByKey.get(key);
        if (have) {
          if (destBySlot[have.slot] !== bus) {
            try { node.disconnect(have.slot); } catch (e) {}
            try { Tone.connect(node, bus, have.slot, 0); } catch (e) {}
            destBySlot[have.slot] = bus;
          }
          return have;
        }
        const slot = allocSlot();
        if (slot < 0) return null;
        try { node.disconnect(slot); } catch (e) {}
        try { Tone.connect(node, bus, slot, 0); } catch (e) { return null; }
        destBySlot[slot] = bus;
        slotByKey.set(key, slot);
        const input = new Tone.Gain(1);
        try { Tone.connect(input, node, 0, slot); } catch (e) {}
        _post({ cmd: 'strip', fn: 'strip_reset', a: [slot] });
        _post({ cmd: 'strip', fn: 'strip_enable', a: [slot, 1] });
        const h = {
          key, slot, input,
          cmd: (fn, ...a) => _post({ cmd: 'strip', fn, a }),
          curve: (fn, a, curve) => _post({ cmd: 'strip', fn, a, curve }),
          param: (which, init0) => makeShimParam(slot, which, init0),
          tap: (an) => { try { Tone.connect(node, an, slot, 0); } catch (e) {} },
        };
        stripByKey.set(key, h);
        return h;
      }
      function stripRelease(key) {
        if (offline()) { const oh = off.strips.get(key); if (oh) { off.strips.delete(key); off.slots.delete(key); try { oh.input.dispose(); } catch (e) {} } return; }
        const h = stripByKey.get(key);
        if (!h) return;
        stripByKey.delete(key);
        _post({ cmd: 'strip', fn: 'strip_enable', a: [h.slot, 0] });
        try { h.input.dispose(); } catch (e) {}
        try { node.disconnect(h.slot); } catch (e) {}
        destBySlot[h.slot] = null;
        slotByKey.delete(key);
        freeSlots.push(h.slot);
      }
      // Area-transition departure: the fading chain moves to a temp key while
      // the layer key rebuilds fresh — the slot follows the DEPARTED key so
      // its gate fade + voice stops hit the old slot, and the fresh build
      // acquires a new one.
      function stripRekey(oldKey, newKey) {
        if (offline()) { const oh = off.strips.get(oldKey); if (oh) { off.strips.delete(oldKey); off.strips.set(newKey, oh); oh.key = newKey;
          const os = off.slots.get(oldKey); off.slots.delete(oldKey); off.slots.set(newKey, os); } return; }
        const h = stripByKey.get(oldKey);
        if (!h) return;
        stripByKey.delete(oldKey);
        stripByKey.set(newKey, h);
        h.key = newKey;
        const s = slotByKey.get(oldKey);
        slotByKey.delete(oldKey);
        slotByKey.set(newKey, s);
      }
      function stripFor(key) { return offline() ? (off.strips.get(key) || null) : (stripByKey.get(key) || null); }
      // ---- Phase 3: sample voices ----------------------------------------
      // PCM buffers transfer to the core ONCE (keyed by the app's buffer key,
      // e.g. 'pianoC4#60' or '...#loop'); voices then play by id. The core
      // table holds 96 ids — beyond that, new buffers fall back to the node
      // path (typical projects use far fewer).
      const sampleIdByKey = new Map();
      let sampleIdSeq = 0;
      // Recycled numeric ids from deleted user samples (releaseSampleKeys).
      // sample_load reuses a slot's core allocation in place when the id is
      // re-loaded, so recycling ids here fully prevents 96-slot exhaustion
      // from import/delete churn without a core-side free.
      const freeSampleIds = [];
      let sTagSeq = 1 << 20;   // sample tags live above holdOn's tag range
      function _ensureSample(bufKey, audioBuf) {
        let id = sampleIdByKey.get(bufKey);
        if (id != null) return id;
        if ((freeSampleIds.length === 0 && sampleIdSeq >= 96) || !audioBuf || !audioBuf.length) return -1;
        const ch = Math.min(2, audioBuf.numberOfChannels || 1);
        const chans = [];
        try {
          // copy — transferring the live channel data would detach the app's buffer
          for (let c = 0; c < ch; c++) chans.push(audioBuf.getChannelData(c).slice());
        } catch (e) { return -1; }
        id = freeSampleIds.length ? freeSampleIds.pop() : sampleIdSeq++;
        sampleIdByKey.set(bufKey, id);
        try {
          node.port.postMessage(
            { cmd: 'sample', id, ch, len: audioBuf.length, sr: audioBuf.sampleRate, chans },
            chans.map((a) => a.buffer),
          );
        } catch (e) { sampleIdByKey.delete(bufKey); return -1; }
        return id;
      }
      // Release every core buffer id whose bufKey belongs to a deleted user
      // sample (bufKeys are '<sampleId>#<midi>' / '...#loop'). The numeric ids
      // go on the free list for reuse; the core slot's heap allocation is
      // reused in place on the next load of that id.
      function releaseSampleKeys(sampleId) {
        if (!sampleId) return 0;
        const prefix = String(sampleId) + '#';
        let n = 0;
        for (const [k, id] of Array.from(sampleIdByKey)) {
          if (k.startsWith(prefix)) { sampleIdByKey.delete(k); freeSampleIds.push(id); n++; }
        }
        return n;
      }
      // Play a sample voice in the core. o carries FINAL values (the caller —
      // 04's sample path — owns the node-parity math: rate incl. tuneCents,
      // per-channel gains incl. norm/boost/vel/pan+makeup, env floors, slice
      // window in BUFFER seconds, loop window). Returns a truthy tag when
      // taken; 0 → node path.
      // Upload a buffer to THIS RENDER's core. The offline session keeps its own
      // id table (the live one indexes the live node's heap), so a bounce never
      // borrows a live id and never leaks into it.
      function _offEnsureSample(bufKey, audioBuf) {
        let id = off.sampleIdByKey.get(bufKey);
        if (id != null) return id;
        if (off.sampleIdSeq >= 96 || !audioBuf || !audioBuf.length) return -1;
        const ch = Math.min(2, audioBuf.numberOfChannels || 1);
        const chans = [];
        try { for (let c = 0; c < ch; c++) chans.push(audioBuf.getChannelData(c).slice()); }
        catch (e) { return -1; }
        id = off.sampleIdSeq++;
        off.sampleIdByKey.set(bufKey, id);
        try {
          off.node.port.postMessage(
            { cmd: 'sample', id, ch, len: audioBuf.length, sr: audioBuf.sampleRate, chans },
            chans.map((a) => a.buffer),
          );
        } catch (e) { off.sampleIdByKey.delete(bufKey); return -1; }
        return id;
      }
      // Offline sample voice: the same marshaling as the live one, on the
      // bounce's node. WITHOUT THIS a sample note falls through to the Tone
      // sampler, which is wired at the master stage — so it bypasses its
      // layer's strip and loses that layer's pan, spread and FX, while live
      // playback renders the very same note INSIDE the strip. A project whose
      // layers are samples then bounces mono and dry. Returns 0 on any miss so
      // the caller still has the node path to fall back to.
      function _offSampleNoteOn(key, dest, o) {
        // Every `return 0` here drops the note to the plain offline sampler,
        // which is wired at the MASTER STAGE — so it sounds with no level, no
        // pan and no FX. A layer whose notes alternate between the two reads as
        // "cutting in and out", and nothing used to count them; off.sampFail is
        // what makes that audible failure a number.
        if (!stripsEnabled() || !dest) { off.sampFail++; return 0; }
        const slot = _offSlotFor(key, dest);
        if (slot == null || slot < 0) { off.sampFail++; return 0; }
        const id = _offEnsureSample(o.bufKey, o.buf);
        if (id < 0) { off.sampFail++; return 0; }
        const sp = new Float32Array(15);
        sp[0] = id; sp[1] = o.rate; sp[2] = o.gl; sp[3] = o.gr;
        sp[4] = o.a; sp[5] = o.d; sp[6] = o.s; sp[7] = o.r;
        sp[8] = o.off || 0; sp[9] = (o.len != null) ? o.len : -1;
        sp[10] = (o.loop ? 1 : 0) | (o.reverse ? 2 : 0);
        sp[11] = o.loopA || 0; sp[12] = o.loopB || 0;
        sp[13] = (o.cutoff != null) ? o.cutoff : -1; sp[14] = o.fq || 0.7;
        // Same shape as the live post — pan is already baked into sp[2]/sp[3]
        // (gain L/R) by the caller, and offline times are absolute buffer
        // positions, so t is passed verbatim like _offNoteOn does.
        try {
          off.node.port.postMessage({
            cmd: 'snote', slot, t: (typeof o.t === 'number' && o.t > 0) ? o.t : 0,
            dur: o.dur, tag: 0, sp,
          });
        } catch (e) { off.sampFail++; return 0; }
        off.taken++; off.sampOk++;
        return 1;
      }
      function sampleNoteOn(key, dest, o) {
        if (offline()) return _offSampleNoteOn(key, dest, o);   // render it in THIS bounce's core
        if (!stripsEnabled() || failed) return 0;
        if (!ready) { init(); return 0; }
        if (!_running()) return 0;
        const slot = slotFor(key, dest);
        if (slot == null || slot < 0) return 0;
        const id = _ensureSample(o.bufKey, o.buf);
        if (id < 0) return 0;
        const tag = o.glide ? ++sTagSeq : 0;
        const sp = new Float32Array(15);
        sp[0] = id; sp[1] = o.rate; sp[2] = o.gl; sp[3] = o.gr;
        sp[4] = o.a; sp[5] = o.d; sp[6] = o.s; sp[7] = o.r;
        sp[8] = o.off || 0; sp[9] = (o.len != null) ? o.len : -1;
        sp[10] = (o.loop ? 1 : 0) | (o.reverse ? 2 : 0);
        sp[11] = o.loopA || 0; sp[12] = o.loopB || 0;
        sp[13] = (o.cutoff != null) ? o.cutoff : -1; sp[14] = o.fq || 0.7;
        node.port.postMessage({ cmd: 'snote', slot, t: _tNow(o.t), dur: o.dur, tag, sp });
        // sample portamento: start at the previous rate, glide to the target
        if (o.glide && o.glide.mult > 0) {
          node.port.postMessage({ cmd: 'srateTag', tag, mult: o.glide.mult, ramp: o.glide.ramp });
        }
        return tag || 1;
      }
      // HELD sample voice (grid press-and-hold, looping pads): the core's
      // sample voice natively holds with dur < 0 until release_tag — pads are
      // just loop + hold. Returns a {release, setDetune} handle compatible
      // with startSustainedNote's contract, or null → node engine. setDetune
      // rides srate_tag (absolute mult vs the base rate), so held-press pitch
      // bends work like the synth holdOn's bendTag.
      function holdSampleOn(key, dest, o) {
        if (offline()) return null;   // bounce in flight -> node/sampler path
        if (!stripsEnabled() || failed) return null;
        if (!ready) { init(); return null; }
        if (!_running()) return null;
        const slot = slotFor(key, dest);
        if (slot == null || slot < 0) return null;
        const id = _ensureSample(o.bufKey, o.buf);
        if (id < 0) return null;
        const tag = ++sTagSeq;
        const _holdT0 = performance.now();
        const sp = new Float32Array(15);
        sp[0] = id; sp[1] = o.rate; sp[2] = o.gl; sp[3] = o.gr;
        sp[4] = o.a; sp[5] = o.d; sp[6] = o.s; sp[7] = o.r;
        sp[8] = o.off || 0; sp[9] = (o.len != null) ? o.len : -1;
        sp[10] = (o.loop ? 1 : 0) | (o.reverse ? 2 : 0);
        sp[11] = o.loopA || 0; sp[12] = o.loopB || 0;
        sp[13] = (o.cutoff != null) ? o.cutoff : -1; sp[14] = o.fq || 0.7;
        node.port.postMessage({ cmd: 'snote', slot, t: _tNow(o.t), dur: -1, tag, sp });
        let released = false;
        return {
          release: () => {
            if (released) return; released = true;
            // A release landing before the (padded) start FREES the still-
            // Scheduled voice (silent tap) or chops the attack mid-rise
            // (click). Defer fast taps' release — every click becomes a
            // short-but-real note.
            const _dt = performance.now() - _holdT0;
            if (_dt < 45) { setTimeout(() => { try { node.port.postMessage({ cmd: 'releaseTag', tag, r: o.r }); } catch (e) {} }, 45 - _dt); return; }
            node.port.postMessage({ cmd: 'releaseTag', tag, r: o.r });
          },
          setDetune: (cents) => {
            if (released) return;
            node.port.postMessage({ cmd: 'srateTag', tag, mult: Math.pow(2, (cents || 0) / 1200), ramp: 0.03 });
          },
        };
      }
      // Route the summed reverb-send bus (output 16) into an engine's reverb.
      // The bus is GLOBAL (one sum across all strips) so it feeds ONE reverb at
      // a time; re-routing goes through a persistent native gain — output 16
      // itself is never disconnected (the keep-pull sink hangs off it) and a
      // disposed reverb can't strand the bus. Whichever engine last claims it
      // wins (17-ambient re-claims on every core-strip build, so the engine
      // that's actually generating owns the bus — a lane/Shape Bloom playing
      // alone no longer sends into a master reverb that was never built).
      let sendVia = null, sendDest = null;
      function connectSend(dest) {
        // Offline: claim THIS render's summed reverb-send bus (output 16) for
        // the offline reverb — without it a core-strip bounce loses every
        // per-layer Reverb send.
        if (offline()) {
          if (!dest) return;
          try {
            if (!off.sendVia) { off.sendVia = Tone.getContext().rawContext.createGain(); Tone.connect(off.node, off.sendVia, SLOTS, 0); }
            try { off.sendVia.disconnect(); } catch (e) {}
            Tone.connect(off.sendVia, dest);
          } catch (e) {}
          return;
        }
        if (!dest || dest === sendDest) return;
        try {
          if (!sendVia) {
            sendVia = Tone.getContext().rawContext.createGain();
            Tone.connect(node, sendVia, SLOTS, 0);
          }
          try { sendVia.disconnect(); } catch (e) {}
          Tone.connect(sendVia, dest);
          sendDest = dest;
        } catch (e) { sendDest = null; }
      }
      // Cheap per-note FX check: any engaged per-note effect keeps the note on
      // the old engine (Bloom layer notes carry none by default).
      function _noPerNoteFx(p) {
        return !(p.reverb || p.delay || p.distortion || p.chorus || p.vibrato || p.tremolo
          || p.phaser || p.autoFilter || p.pingPong || p.autoPan || p.fxOverrideGlobal || p.bend);
      }
      function _hasDesign(p) {
        return !!((p.filter && p.filter.on) || (p.filterEnv && p.filterEnv.on)
          || (Array.isArray(p.modMatrix) && p.modMatrix.length)
          || (p.pitchEnv && p.pitchEnv.on && p.pitchEnv.amount) || p.osc);
      }
      function eligible(type, p, held) {
        const kf = kindFor(type);
        if (!kf) return false;
        if (type === 'wavetable' && (p.wtPosition != null || p.wavetableMix)) return false; // design wavetable → node engine
        if (_hasDesign(p)) {
          // RETREAT LIFTED (2026-07-16): design notes render in the core again
          // (all paths). The retreat was a suspicion-based mitigation for the
          // mid-bar pad cutoff, whose ACTUAL causes were found and fixed
          // separately (stale voice-cost weights saturating the budget, the
          // persisted budget=8 from the capture-watchdog bug, kept-loop
          // replay gating dropping chord instances). Meanwhile the retreat
          // itself pushed whole design areas onto heavy node chains — on real
          // hardware that saturated the audio thread and made interactive
          // presses late/silent ("finicky grid presses", ~50% at 4 Hz).
          if (!DESIGN_OK[kf.kind]) return false;
          // wtpos mod routes need the wavetable crossfade rig — node engine
          if (Array.isArray(p.modMatrix) && p.modMatrix.some((r) => r && r.dest === 'wtpos' && r.amount)) return false;
          // sequence-as-waveform LFOs (shape 'seq') have no core mapping —
          // the design-voice LFO shapes are 0-5; keep those notes node-side
          if (Array.isArray(p.lfos) && p.lfos.some((l) => l && l.on && l.shape === 'seq')) return false;
        }
        if (p.glideMs > 0) return false;
        if (p._detuneMod) return false;
        return _noPerNoteFx(p);
      }
      // Marshal Design params into the core's staging layout (see dsp lib.rs).
      function designParams(p) {
        if (!_hasDesign(p)) return null;
        const dp = new Float32Array(64);
        let flags = 0;
        if (p.filter && p.filter.on) {
          flags |= 1;
          dp[1] = p.filter.type === 'highpass' ? 1 : (p.filter.type === 'bandpass' ? 2 : 0);
          dp[2] = Number.isFinite(p.filter.cutoff) ? p.filter.cutoff : 12000;
          dp[3] = Number.isFinite(p.filter.q) ? p.filter.q : 0.7;
        }
        if (p.filterEnv && p.filterEnv.on) {
          flags |= 2;
          dp[4] = p.filterEnv.amount || 0;
          dp[5] = p.filterEnv.vel || 0;
          dp[6] = Math.max(0.001, (p.filterEnv.attack || 0) / 1000);
          dp[7] = Math.max(0.001, (p.filterEnv.decay || 0) / 1000);
          dp[8] = Math.max(0, Math.min(1, (p.filterEnv.sustain || 0) / 100));
          dp[9] = Math.max(0.001, (p.filterEnv.release || 0) / 1000);
        }
        const o = p.osc;
        dp[16] = -1; dp[17] = -1;
        if (o) {
          if ((o.unison | 0) > 1) { flags |= 16; dp[10] = Math.min(7, o.unison | 0); dp[11] = Number.isFinite(o.spread) ? o.spread : 20; }
          if (o.sub > 0) { flags |= 4; dp[12] = Math.min(1, o.sub / 100); dp[13] = o.subShape === 'square' ? 1 : 0; }
          if (o.ring > 0) { flags |= 8; dp[14] = Math.min(1, o.ring / 100); dp[15] = Number.isFinite(o.ringRatio) ? o.ringRatio : 1; }
          if (Number.isFinite(o.harmonicity)) dp[16] = o.harmonicity;
          if (Number.isFinite(o.modIndex)) dp[17] = o.modIndex;
        }
        // Dedicated PITCH ENVELOPE (drum boom→thud): amount SEMITONES → cents,
        // fast AD. Flag 64. Deep range, separate from the mod matrix.
        const pe = p.pitchEnv;
        if (pe && pe.on && Number.isFinite(pe.amount) && pe.amount !== 0) {
          flags |= 64;
          dp[55] = pe.amount * 100;                          // semitones → cents
          dp[56] = Math.max(0, (pe.attack || 0) / 1000);
          dp[57] = Math.max(0.001, (pe.decay || 0) / 1000);
        }
        const routes = (Array.isArray(p.modMatrix) ? p.modMatrix : []).filter((r) => r && r.amount && (r.src in MOD_SRC) && (r.dest in MOD_DEST)).slice(0, 8);
        if (routes.length) {
          flags |= 32;
          const l1 = p.lfos && p.lfos[0], l2 = p.lfos && p.lfos[1];
          dp[18] = (l1 && l1.on && (l1.shape in LFO_SHAPES)) ? LFO_SHAPES[l1.shape] : -1;
          dp[19] = Math.max(0.01, (l1 && l1.rateHz) || 1);
          dp[20] = (l2 && l2.on && (l2.shape in LFO_SHAPES)) ? LFO_SHAPES[l2.shape] : -1;
          dp[21] = Math.max(0.01, (l2 && l2.rateHz) || 1);
          const e2 = p.env2;
          dp[22] = (e2 && e2.on) ? Math.max(0.001, (e2.attack || 0) / 1000) : -1;
          dp[23] = Math.max(0.001, ((e2 && e2.decay) || 0) / 1000);
          dp[24] = Math.max(0, Math.min(1, ((e2 && e2.sustain) || 0) / 100));
          dp[25] = Math.max(0.001, ((e2 && e2.release) || 0) / 1000);
          for (let i = 0; i < 4; i++) {
            const m = p.macros && p.macros[i];
            dp[26 + i] = m ? Math.max(0, Math.min(1, (m.value || 0) / 100)) : 0;
          }
          dp[30] = routes.length;
          routes.forEach((r, i) => {
            dp[31 + i * 3] = MOD_SRC[r.src];
            dp[32 + i * 3] = MOD_DEST[r.dest];
            dp[33 + i * 3] = r.amount / 100;
          });
        } else if (!flags) {
          return null;
        }
        dp[0] = flags;
        return dp;
      }
      function _running() {
        try { return Tone.getContext().rawContext.state === 'running'; } catch (e) { return false; }
      }
      // Immediate notes must carry the REAL context time as t_start — the
      // core derives envelope time from (now - t_start), so t=0 would mean
      // "started at the beginning of time" (envelope long expired).
      function _tNow(t) {
        if (typeof t === 'number' && t > 0) return t;
        try { return Tone.getContext().rawContext.currentTime; } catch (e) { return 0; }
      }
      // Returns true when the note was taken by the core.
      function noteOn(key, dest, o) {
        if (offline()) return _offNoteOn(key, dest, o);   // bounce in flight → its own node
        if (!enabled() || failed) return false;
        if (!ready) { init(); return false; }  // warm up; fall back meanwhile
        if (!_running()) return false;         // cold start → node engine handles the resume dance
        const slot = slotFor(key, dest);
        if (slot < 0) return false;
        const kf = kindFor(o.type);
        node.port.postMessage({
          cmd: 'note', slot, kind: kf.kind, p0: kf.p0, freq: o.freq, vel: o.vel,
          pan: Math.max(-1, Math.min(1, (o.pan || 0) / 100)),
          t: _tNow(o.t), dur: o.dur, a: o.a, dcy: o.d, s: o.s, r: o.r, detune: o.detune || 0,
          dp: o.dp || null, tag: o.tag || 0,
        });
        return true;
      }
      // Held note (grid press-and-hold): returns a handle {release, setDetune}
      // compatible with startSustainedNote's contract, or null → node engine.
      let tagSeq = 0;
      function holdOn(key, dest, o) {
        if (offline()) return null;                 // bounce in flight → node engine for holds
        if (!enabled() || failed || !ready || !_running()) { if (!ready && enabled()) init(); return null; }
        const slot = slotFor(key, dest);
        if (slot < 0) return null;
        const kf = kindFor(o.type);
        const tag = ++tagSeq;
        const _holdT0 = performance.now();
        // ONSET CLICK GUARD: an immediate hold stamped t = "currentTime at
        // post" is already a few ms in the PAST when the worklet processes it
        // — the envelope then starts PARTWAY up its attack (a step = click at
        // note onset). Pad immediate starts ~20 ms into the future so the
        // attack always rises from zero; explicitly-scheduled starts (o.t>0,
        // e.g. wrap chord auditions pinning voices together) pass through.
        const _tHold = (o.t && o.t > 0) ? _tNow(o.t) : _tNow(0) + 0.02;
        node.port.postMessage({
          cmd: 'note', slot, kind: kf.kind, p0: kf.p0, freq: o.freq, vel: o.vel,
          pan: Math.max(-1, Math.min(1, (o.pan || 0) / 100)),
          t: _tHold, dur: -1, a: o.a, dcy: o.d, s: o.s, r: o.r, detune: o.detune || 0,
          dp: o.dp || null, tag,
        });
        let released = false;
        return {
          release: () => {
            if (released) return; released = true;
            // A release landing before the (padded) start FREES the still-
            // Scheduled voice (silent tap) or chops the attack mid-rise
            // (click). Defer fast taps' release — every click becomes a
            // short-but-real note.
            const _dt = performance.now() - _holdT0;
            if (_dt < 45) { setTimeout(() => { try { node.port.postMessage({ cmd: 'releaseTag', tag, r: o.r }); } catch (e) {} }, 45 - _dt); return; }
            node.port.postMessage({ cmd: 'releaseTag', tag, r: o.r });
          },
          setDetune: (cents) => {
            node.port.postMessage({ cmd: 'bendTag', tag, cents: cents || 0 });
          },
        };
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
      // ---- OFFLINE SESSION (the Bloom bounce) ------------------------------
      // A SECOND voice-processor node, built on whatever context is current —
      // called from inside Tone.Offline, that is the OFFLINE context, so core
      // voices render into the bounce buffer instead of falling back to
      // expensive per-note Tone graphs (measured: a dense project's Tone-only
      // render runs ~3x SLOWER than realtime; the core benches ~28-70x).
      // While a session is active, noteOn routes to it — playNote's existing
      // core gate then works offline unchanged. The session keeps its OWN
      // slot maps; the live node and its state are never touched.
      let _wasmCopy = null;   // cached module bytes (init() stores them — see the transfer note there)
      let off = null;         // active offline session, or null
      // A session is only honoured while 17-ambient's render flag is ALSO up.
      // Both are cleared in the same finally, so a bounce that throws, hangs or
      // returns early can never leave live playback routed at a dead offline
      // node — which silently costs the reverb send bus (connectSend) and every
      // strip, i.e. "no reverb on normal playback".
      const offline = () => {
        if (!off) return false;
        try { if (typeof window !== 'undefined' && !window.__bloopsOfflineRender) return false; } catch (e) {}
        return true;
      };
      async function offlineBegin(timeoutMs) {
        if (off) return null;               // one at a time
        if (!enabled()) return null;        // the kill switch governs offline too
        try {
          if (!_wasmCopy) {
            _wasmCopy = await (await fetch('js/bloops/core/bloops-dsp.wasm?v=DEPLOYVER', { cache: 'no-cache' })).arrayBuffer();
          }
          const ctx = Tone.getContext();
          await ctx.rawContext.audioWorklet.addModule('js/bloops/core/voice-processor.js?v=DEPLOYVER');
          const n2 = ctx.createAudioWorkletNode('bloops-voice-processor', {
            numberOfInputs: SLOTS,
            numberOfOutputs: SLOTS + 1,
            outputChannelCount: new Array(SLOTS + 1).fill(2),
            channelCount: 2,
            channelCountMode: 'clamped-max',
          });
          let readyRes; const readyP = new Promise((r) => { readyRes = r; });
          let statsRes = null;
          n2.port.onmessage = (e) => {
            const d = e.data || {};
            if (d.ready) readyRes(true);
            if (d.stats && statsRes) { const r = statsRes; statsRes = null; r(true); }
            if (d.error) { try { console.warn('[bloops-core] offline session:', d.error); } catch (x) {} }
          };
          const bcopy = _wasmCopy.slice(0);
          n2.port.postMessage({ wasmBytes: bcopy }, [bcopy]);
          const ok = await Promise.race([readyP, new Promise((r) => setTimeout(() => r(false), timeoutMs || 6000))]);
          if (!ok) { try { n2.disconnect(); } catch (e) {} return null; }
          off = { node: n2, slots: new Map(), dests: new Array(SLOTS).fill(null), taken: 0,
                  strips: new Map(), post: (m) => { try { n2.port.postMessage(m); } catch (e) {} }, sendVia: null,
                  // this render's OWN sample-buffer table (see _offEnsureSample)
                  sampleIdByKey: new Map(), sampleIdSeq: 0, sampOk: 0, sampFail: 0 };
          return true;
        } catch (e) {
          try { console.warn('[bloops-core] offline session unavailable:', e); } catch (x) {}
          off = null; return null;
        }
      }
      // Port-drain barrier: stats is answered AFTER every earlier message on
      // the port has been dispatched (FIFO), so awaiting the reply guarantees
      // all posted notes have reached the core — required before resuming a
      // suspended offline render, or a note near the checkpoint could miss
      // its onset while the message is still in flight.
      function offlineFlush(timeoutMs) {
        if (!off) return Promise.resolve(false);
        const n2 = off.node;
        return new Promise((resolve) => {
          const to = setTimeout(() => { resolve(false); }, timeoutMs || 3000);
          const prev = n2.port.onmessage;
          n2.port.onmessage = (e) => {
            const d = e.data || {};
            // Resolve with the core's ACTIVE VOICE COUNT, not a bare true: the
            // pool steals past its cap, and a bounce that delivers a wider
            // lookahead than live playback can sit near that cap without any
            // other signal — "layers cut in and out". The caller records the
            // peak so the render can report it instead of it being invisible.
            if (d.stats) { clearTimeout(to); n2.port.onmessage = prev;
              resolve((d.stats && typeof d.stats.voices === 'number') ? d.stats.voices : true); return; }
            if (prev) prev(e);
          };
          try { n2.port.postMessage({ cmd: 'stats' }); } catch (e) { clearTimeout(to); n2.port.onmessage = prev; resolve(false); }
        });
      }
      // OFFLINE CORE STRIPS. Live playback runs each layer's strip + FX inside
      // the core; the bounce used to fall back to the NODE implementations,
      // which are different DSP (and Glitch has no node build at all), so a
      // bounce did not sound like what you heard. These build the same strips
      // on the offline node, so the render is the same engine.
      function _offStripAcquire(key, bus) {
        if (!bus) return null;
        const have = off.strips.get(key);
        if (have) {
          if (off.dests[have.slot] !== bus) {
            try { off.node.disconnect(have.slot); } catch (e) {}
            try { Tone.connect(off.node, bus, have.slot, 0); } catch (e) {}
            off.dests[have.slot] = bus;
          }
          return have;
        }
        if (off.slots.size >= SLOTS) return null;   // out of slots → node chain
        const used = new Set(off.slots.values());
        let slot = -1;
        for (let i = 0; i < SLOTS; i++) if (!used.has(i)) { slot = i; break; }
        if (slot < 0) return null;
        try { off.node.disconnect(slot); } catch (e) {}
        try { Tone.connect(off.node, bus, slot, 0); } catch (e) { return null; }
        off.dests[slot] = bus;
        off.slots.set(key, slot);
        const input = new Tone.Gain(1);
        try { Tone.connect(input, off.node, 0, slot); } catch (e) {}
        off.post({ cmd: 'strip', fn: 'strip_reset', a: [slot] });
        off.post({ cmd: 'strip', fn: 'strip_enable', a: [slot, 1] });
        const h = {
          key, slot, input,
          cmd: (fn, ...a) => off.post({ cmd: 'strip', fn, a }),
          curve: (fn, a, curve) => off.post({ cmd: 'strip', fn, a, curve }),
          param: (which, init0) => makeShimParam(slot, which, init0, off.post),
          tap: () => {},   // meters are a live-UI concern
        };
        off.strips.set(key, h);
        return h;
      }
      // The offline node itself, so a bounce can TAP a strip's slot output for
      // per-layer metering (the mix cannot show one layer dropping in and out).
      function offlineNode() { return off ? off.node : null; }
      function offlineStats() { return off ? { sampOk: off.sampOk, sampFail: off.sampFail, bufs: off.sampleIdSeq } : null; }
      function offlineEnd() {
        if (!off) return 0;
        const taken = off.taken;
        try { off.node.disconnect(); } catch (e) {}
        off = null;
        return taken;
      }
      function _offSlotFor(key, dest) {
        // A strip-managed key already has its slot wired to the bus, and its
        // notes render INTO the strip — never re-route it to the note's dest
        // (same contract as the live slotFor).
        if (off.strips.has(key)) return off.slots.get(key);
        let s = off.slots.get(key);
        if (s == null) {
          if (off.slots.size >= SLOTS) return -1;   // out of slots → Tone voice
          s = off.slots.size;
          off.slots.set(key, s);
        }
        if (off.dests[s] !== dest) {
          try { off.node.disconnect(s); } catch (e) {}
          try { Tone.connect(off.node, dest, s, 0); } catch (e) { return -1; }
          off.dests[s] = dest;
        }
        return s;
      }
      // Offline noteOn: same marshaling as the live one, minus the _running()
      // gate (an offline context is 'suspended' until startRendering) and with
      // t passed verbatim (offline times are absolute buffer positions).
      function _offNoteOn(key, dest, o) {
        if (!dest) return false;
        const slot = _offSlotFor(key, dest);
        if (slot < 0) return false;
        const kf = kindFor(o.type);
        off.node.port.postMessage({
          cmd: 'note', slot, kind: kf.kind, p0: kf.p0, freq: o.freq, vel: o.vel,
          pan: Math.max(-1, Math.min(1, (o.pan || 0) / 100)),
          t: (typeof o.t === 'number' && o.t > 0) ? o.t : 0,
          dur: o.dur, a: o.a, dcy: o.d, s: o.s, r: o.r, detune: o.detune || 0,
          dp: o.dp || null, tag: 0,
        });
        off.taken++;
        return true;
      }
      return { enabled, stripsEnabled, eligible, noteOn, holdOn, sampleNoteOn, holdSampleOn, releaseSampleKeys, cancelFrom, stopBefore, stopAll, init, designParams,
               stripAcquire, stripRelease, stripRekey, stripFor, connectSend, _node: () => node,
               offlineBegin, offlineEnd, offlineFlush, offlineStats, offlineNode, offlineActive: () => !!off };
    })();
    // Live A/B toggles from the console.
    try {
      // NO ARGUMENT = READ. These were pure setters, so `bloopsCore()` /
      // `bloopsCoreStrips()` wrote '0' and silently turned the engine off — which is
      // exactly how a "is the core on?" check disabled it for everyone. Reading is the
      // obvious thing to want from a name like this, so make it do that instead of
      // relying on every future caller knowing better.
      window.bloopsCore = (on) => {
        if (typeof on === 'undefined') return _coreVoices.enabled();
        try { localStorage.setItem('bloopsCoreVoices', on ? '1' : '0'); } catch (e) {}
        if (on) _coreVoices.init();
        else _coreVoices.stopAll();
        console.info('[bloops-core] core voices ' + (on ? 'ON' : 'OFF') + ' (new notes route accordingly)');
      };
      window.bloopsCoreStrips = (on) => {
        if (typeof on === 'undefined') return _coreVoices.stripsEnabled();
        try { localStorage.setItem('bloopsCoreStrips', on ? '1' : '0'); } catch (e) {}
        if (on) _coreVoices.init();
        console.info('[bloops-core] core STRIPS ' + (on ? 'ON' : 'OFF') + ' (layers rebuild on next play/edit)');
      };
    } catch (e) {}
    // Warm the worklet at load (default-on): addModule + the wasm fetch run
    // fine on the still-suspended context, so the FIRST play can acquire
    // core strips instead of falling back to the node engine for one play.
    try {
      if (_coreVoices.enabled()) setTimeout(() => { try { _coreVoices.init(); } catch (e) {} }, 250);
    } catch (e) {}
