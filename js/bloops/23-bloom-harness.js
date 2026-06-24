    // =========================================================================
    // 23-bloom-harness.js — Bloom generator INVARIANT HARNESS (Phase 0)
    // =========================================================================
    // A deterministic, headless snapshot of the Bloom note generator. It drives
    // `_ambTick` for a fixed number of synthetic ticks against a STUBBED clock
    // (Tone.now) and a WRAPPED `playNote` sink, recording every generated note
    // (time/freq/dur/voice/pan/level) into a stable per-config hash.
    //
    // Purpose: as we layer the new harmony model (Key transpose/quantize, modes,
    // colour sets, degree-relative seeds) on top, the DEFAULT path must stay
    // byte-identical — `Key off ∧ modeOffset 0 ∧ no colours ∧ no shared prog ∧
    // free/existing seeds` ⇒ same note stream. Run `__bloomHarness.record()` once
    // against today's code to capture the baseline (localStorage), then
    // `__bloomHarness.check()` after every phase to assert nothing drifted.
    //
    // It is INERT on load: it only defines `window.__bloomHarness`. Nothing runs
    // until you call it from the console. It touches no audio (playNote is stubbed
    // out), so it is safe to invoke at any time after the app has loaded.
    //
    // Console API:
    //   __bloomHarness.record()        → run the battery, save baseline, print JSON
    //   __bloomHarness.check()         → run + compare to saved baseline (PASS/FAIL)
    //   __bloomHarness.check(baseline) → compare to a pasted baseline object
    //   __bloomHarness.run()           → just return the current hashes
    //   __bloomHarness.dump('motif')   → print the full note stream for one config
    //   __bloomHarness.battery()       → the list of {name,cfg} test configs
    // =========================================================================
    (function () {
      'use strict';
      if (typeof window === 'undefined') return;

      const SEED = 12345;             // fixed RNG seed → repeatable runs
      const TICKS = 80;               // synthetic ticks per config (~12 s @ dt)
      const DT = 0.15;                // seconds per tick (matches the live 150 ms)
      const BASELINE_KEY = 'bloomHarnessBaseline.v1';

      // Round a number for a stable snapshot (kills float jitter); pass non-numbers through.
      const r = (v, dp) => {
        if (typeof v !== 'number' || !isFinite(v)) return (v === undefined ? null : v);
        const m = Math.pow(10, dp);
        return Math.round(v * m) / m;
      };
      const fnv1a = (str) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
          h ^= str.charCodeAt(i);
          h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('0000000' + h.toString(16)).slice(-8);
      };

      // Build a normalized config from the defaults with a fixed seed + a mutator.
      // Layers with tone '' follow the live grid voice (cellParams[0]); pin those
      // to a fixed voice so the baseline doesn't depend on session state and is
      // reproducible across machines. Pitch/timing/note-selection are unaffected —
      // only the recorded voice label changes.
      const mk = (mutate) => {
        const c = _defaultAmbientConfig();
        c.seed = SEED;
        if (mutate) mutate(c);
        try { _normalizeAmbientCfg(c); } catch (e) {}
        const pin = (L) => { if (L && typeof L === 'object' && L.tone === '') L.tone = 'sine'; };
        ['bed', 'motif', 'texture', 'beat'].forEach((k) => pin(c[k]));
        (c.extras || []).forEach(pin);
        (c.seqs || []).forEach(pin);
        return c;
      };
      // A small, fixed saved-sequence phrase for the Seq config.
      const seqUnit = () => ({
        events: [
          { freqs: [261.63, 329.63], sounds: ['sine', 'sine'], durMs: 500, vel: 100 },
          { freqs: [392.00],          sounds: ['sine'],         durMs: 500, vel: 90 },
          { freqs: [],                sounds: [],               durMs: 250, vel: 0 },
          { freqs: [349.23, 440.00],  sounds: ['sine', 'sine'], durMs: 500, vel: 100 },
        ],
        voice: { type: 'sine' }, scale: 'major', rootIdx: 0, baseOctave: 4, bpm: 120, name: 'U1', reps: 1,
      });
      // Enable exactly one of the four primary layers.
      const onlyPrimary = (type) => (c) => { ['bed', 'motif', 'texture', 'beat'].forEach(k => { c[k].on = (k === type); }); };
      const withExtra = (type) => (c) => { c.bed.on = false; c.extras = [_ambDefaultLayer(type, 1)]; };

      function battery() {
        return [
          { name: 'bed',         cfg: mk(onlyPrimary('bed')) },
          { name: 'motif',       cfg: mk(onlyPrimary('motif')) },
          { name: 'texture',     cfg: mk(onlyPrimary('texture')) },
          { name: 'beat-random', cfg: mk((c) => { onlyPrimary('beat')(c); c.beat.gen = 'random'; }) },
          { name: 'beat-euclid', cfg: mk((c) => { onlyPrimary('beat')(c); c.beat.gen = 'euclid'; }) },
          { name: 'arp',         cfg: mk(withExtra('arp')) },
          { name: 'bass',        cfg: mk(withExtra('bass')) },
          { name: 'run',         cfg: mk(withExtra('run')) },
          { name: 'pedal',       cfg: mk(withExtra('pedal')) },
          { name: 'drone',       cfg: mk(withExtra('drone')) },
          { name: 'seq-pitch',   cfg: mk((c) => { c.bed.on = false; const s = _defaultSeqLayer(1); s.units = [seqUnit()]; s.on = true; c.seqs = [s]; }) },
          { name: 'combo',       cfg: mk((c) => { c.bed.on = true; c.motif.on = true; c.texture.on = true; c.beat.on = true; }) },
        ];
      }

      // Drive one config headlessly and return its recorded note stream.
      // Each note = [at, freq, durMs, voiceType, pan, level]. Order is the
      // emission order across ticks — itself part of the behavior we're pinning.
      function runOne(cfg, ticks, dt) {
        const E = _makeAmbientEngine({
          getCfg: () => cfg,
          busNode: () => (typeof globalSendTap !== 'undefined' ? globalSendTap : null),
          laneIdx: () => -1,
          guard: () => true,
          hostId: 'bloom-harness', idPrefix: 'ambient', vizId: 'bloom-harness-viz',
          playId: 'bloom-harness-play', seedId: 'bloom-harness-seed', isLane: false,
        });
        E.rng = (cfg.seed >>> 0) || 1;     // seed exactly like _ambStartGenerator would

        const notes = [];
        let clock = 0;
        const nowFn = function () { return clock; };
        // Tone.now and context.now are getter-only ACCESSORS in Tone v14, so a
        // plain `Tone.now = fn` throws ("has only a getter"). Shadow them with an
        // own data property via defineProperty (which bypasses the inherited
        // accessor), and remove the shadow to restore the original getter.
        const ctx = (typeof Tone.getContext === 'function') ? Tone.getContext() : (Tone.context || null);
        const restorers = [];
        const stubNow = (obj) => {
          if (!obj) return;
          const hadOwn = Object.prototype.hasOwnProperty.call(obj, 'now');
          const prevDesc = hadOwn ? Object.getOwnPropertyDescriptor(obj, 'now') : null;
          try {
            Object.defineProperty(obj, 'now', { configurable: true, writable: true, value: nowFn });
            restorers.push(() => {
              try { if (hadOwn && prevDesc) Object.defineProperty(obj, 'now', prevDesc); else delete obj.now; } catch (e) {}
            });
          } catch (e) { console.warn('[bloom-harness] could not stub a clock source; results may be non-deterministic.', e); }
        };
        const origPlay = playNote;
        try {
          stubNow(Tone);
          stubNow(ctx);
          // eslint-disable-next-line no-global-assign
          playNote = function (freq, params, durMs, at) {
            notes.push([
              r(at, 4), r(freq, 3), r(durMs, 2),
              (params && params.type) || '',
              r(params && params.pan, 2), r(params && params.volume, 2),
            ]);
          };
          for (let i = 0; i < ticks; i++) {
            try { _ambTick(E); }
            catch (e) { notes.push(['ERR@' + i, String((e && e.message) || e)]); }
            clock += dt;
          }
        } finally {
          for (let k = restorers.length - 1; k >= 0; k--) restorers[k]();
          // eslint-disable-next-line no-global-assign
          playNote = origPlay;
        }
        return notes;
      }

      function run(opts) {
        const ticks = (opts && opts.ticks) || TICKS;
        const dt = (opts && opts.dt) || DT;
        const out = {};
        battery().forEach(({ name, cfg }) => {
          const notes = runOne(cfg, ticks, dt);
          out[name] = { hash: fnv1a(JSON.stringify(notes)), count: notes.length, sample: notes.slice(0, 6) };
        });
        return out;
      }

      // Committed golden baseline (filled in once, against today's code). check()
      // prefers a freshly recorded localStorage baseline, else falls back to this
      // so it works in a clean browser / on any machine.
      const BASELINE = {
        'bed':         { hash: '1d8eacee', count: 12 },
        'motif':       { hash: '8e39cc63', count: 9 },
        'texture':     { hash: 'b766f5dc', count: 3 },
        'beat-random': { hash: '872e5741', count: 19 },
        'beat-euclid': { hash: 'c2c8241b', count: 19 },
        'arp':         { hash: 'd5cc969a', count: 52 },
        'bass':        { hash: '0a287885', count: 32 },
        'run':         { hash: '587c0ec7', count: 46 },
        'pedal':       { hash: 'e788032c', count: 26 },
        'drone':       { hash: '45a97025', count: 2 },
        'seq-pitch':   { hash: '64b0939b', count: 38 },
        'combo':       { hash: 'ad0b1f59', count: 53 },
      };
      function loadBaseline() {
        try { const ls = JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null'); if (ls) return ls; } catch (e) {}
        return BASELINE;
      }
      function record(opts) {
        const res = run(opts);
        try { localStorage.setItem(BASELINE_KEY, JSON.stringify(res)); } catch (e) {}
        console.log('[bloom-harness] baseline recorded (' + Object.keys(res).length + ' configs) → localStorage["' + BASELINE_KEY + '"]');
        console.log('[bloom-harness] durable copy (paste into a committed file if you want it in git):');
        console.log(JSON.stringify(res, null, 2));
        return res;
      }
      function check(baseline, opts) {
        const base = baseline || loadBaseline();
        if (!base) { console.warn('[bloom-harness] no baseline — run __bloomHarness.record() first.'); return false; }
        const cur = run(opts);
        let pass = true;
        const rows = [];
        Object.keys(base).forEach((name) => {
          const b = base[name], c = cur[name];
          const ok = !!(c && c.hash === b.hash && c.count === b.count);
          if (!ok) pass = false;
          rows.push({ config: name, status: ok ? 'PASS' : 'FAIL', base: b.hash + ' (' + b.count + ')', now: c ? (c.hash + ' (' + c.count + ')') : '—' });
        });
        Object.keys(cur).forEach((name) => { if (!base[name]) rows.push({ config: name, status: 'NEW', base: '—', now: cur[name].hash + ' (' + cur[name].count + ')' }); });
        (console.table || console.log)(rows);
        console.log('[bloom-harness] ' + (pass ? '✓ ALL PASS — default path unchanged' : '✗ DRIFT DETECTED — a default-path config changed (use __bloomHarness.dump(name) to inspect)'));
        return pass;
      }
      function dump(name, opts) {
        const entry = battery().find((b) => b.name === name);
        if (!entry) { console.warn('[bloom-harness] no such config:', name, '\nAvailable:', battery().map((b) => b.name).join(', ')); return null; }
        const notes = runOne(entry.cfg, (opts && opts.ticks) || TICKS, (opts && opts.dt) || DT);
        console.log('[bloom-harness] "' + name + '" → ' + notes.length + ' notes [at, freq, durMs, voice, pan, level]:');
        console.table ? console.table(notes.map((n) => ({ at: n[0], freq: n[1], durMs: n[2], voice: n[3], pan: n[4], level: n[5] }))) : console.log(notes);
        return notes;
      }

      window.__bloomHarness = { run, record, check, dump, battery, SEED, TICKS, DT };
    })();
