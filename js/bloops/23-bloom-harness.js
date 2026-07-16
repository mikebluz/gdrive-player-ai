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
        // The app default is now an EMPTY area (no auto-Bed) — the pins were
        // recorded under the old "bed on, all primaries present" defaults, so
        // restore that baseline shape BEFORE each config's mutate applies.
        ['bed', 'motif', 'texture', 'beat'].forEach((k) => { c[k].present = true; });
        c.bed.on = true;
        if (mutate) mutate(c);
        try { _normalizeAmbientCfg(c); } catch (e) {}
        // Loop defaults to WRITE (2026-07-15) — but the pins are GENERATION
        // semantics, not looping: zero the backfilled auto-cycle so every
        // config's stream stays pure generation (byte-identical to the era
        // before the default flip).
        const noW = (L) => { if (L && typeof L === 'object') L.write = { on: false, bars: 2, times: 4 }; };
        ['bed', 'motif', 'texture', 'beat'].forEach((k) => noW(c[k]));
        (c.extras || []).forEach(noW);
        (c.seqs || []).forEach(noW);
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
          // Arp-series migration pin (2026-07-15, PRE-migration): a series with
          // per-entry SCALES and mixed passes/dir — the legacy shapes the
          // series→degrees derivation must reproduce byte-identically.
          { name: 'arp-series-legacy', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('arp', 1);
              L.steps = [
                { notes: { type: 'scale', scale: 'major' }, passes: 1, dir: 'up' },
                { notes: { type: 'scale', scale: 'minor pentatonic' }, passes: 2, dir: 'down' },
              ];
              c.extras = [L];
          }) },
          { name: 'bass',        cfg: mk(withExtra('bass')) },
          // YOKE pin (2026-07-15): a bass harmonizing generatively with the Bed —
          // its KEY frame is whatever the bed is SOUNDING at each onset
          // (keyOv mode 'yoke' → _ambYokeChordAt over the capture buffer).
          { name: 'yoke-bass', cfg: mk((c) => {
              c.bed.on = true;
              const L = _ambDefaultLayer('bass', 1);
              L.keyOv = { mode: 'yoke', src: 'bed' };
              c.extras = [L];
          }) },
          { name: 'run',         cfg: mk(withExtra('run')) },
          { name: 'pedal',       cfg: mk(withExtra('pedal')) },
          { name: 'drone',       cfg: mk(withExtra('drone')) },
          { name: 'seq-pitch',   cfg: mk((c) => { c.bed.on = false; const s = _defaultSeqLayer(1); s.units = [seqUnit()]; s.on = true; c.seqs = [s]; }) },
          { name: 'combo',       cfg: mk((c) => { c.bed.on = true; c.motif.on = true; c.texture.on = true; c.beat.on = true; }) },
          // Key ON (root G major) — lock the new transpose/quantize behavior.
          // keyFollow=false: these pin a CUSTOM key (G major) — under the
          // key-integration default (keyOn+follow-workspace) an explicit
          // root/scale means detached, exactly like editing the Configure row.
          { name: 'key-transpose', cfg: mk((c) => { c.bed.on = true; c.motif.on = true; c.keyOn = true; c.keyFollow = false; c.keyRoot = 7; c.keyScale = 'major'; c.keyMode = 'transpose'; }) },
          { name: 'key-quantize',  cfg: mk((c) => { c.bed.on = true; c.motif.on = true; c.keyOn = true; c.keyFollow = false; c.keyRoot = 7; c.keyScale = 'major'; c.keyMode = 'quantize'; }) },
          // Phase 3 — relative mode (bed re-centred to the 6th, the relative minor).
          { name: 'mode-relminor', cfg: mk((c) => { c.bed.on = true; c.motif.on = true; c.bed.modeRot = 5; c.motif.modeRot = 5; }) },
          // Phase 4 — colour set (blue notes at 50%) inflecting bed + motif.
          { name: 'color-blue', cfg: mk((c) => { c.bed.on = true; c.motif.on = true; c.bed.colors = ['blue']; c.bed.colorAmt = 50; c.motif.colors = ['blue']; c.motif.colorAmt = 50; }) },
          // Prog rework 1b — a bass on a 3-chord progression (I–IV–V in C), 1 bar/chord.
          // Locks the new bar-aligned, PER-ONSET chord resolution (chord follows the
          // bars within the multi-bar bass loop). Record this baseline AFTER 1b lands.
          // CHORD MASK pins (2026-07-15): the per-layer chord sequencer — a bass
          // under I-IV-V playing (a) only chord 0 (steps [100,0,0]) and (b) only
          // the END half of every chord (part 50/end). Gate = _ambChordGateOK.
          { name: 'chordmask-steps', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('bass', 1);
              L.notes = { type: 'prog', name: 'I-IV-V', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] },
              ] };
              L.chordMask = { steps: [100, 0, 0] };
              c.extras = [L]; c.barsPerChord = 1;
          }) },
          { name: 'chordmask-part', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('bass', 1);
              L.notes = { type: 'prog', name: 'I-IV-V', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] },
              ] };
              L.chordMask = { part: { size: 50, place: 'end' } };
              c.extras = [L]; c.barsPerChord = 1;
          }) },
          { name: 'prog-bass', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('bass', 1);
              L.notes = { type: 'prog', name: 'I-IV-V', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] },
              ] };
              c.extras = [L]; c.barsPerChord = 1;
          }) },
          // Phase 2 — GLOBAL progression: a DEFAULT-scale bass (notes scale:'') that
          // INHERITS the global prog. Should produce the SAME stream as prog-bass
          // above (inheritance ≡ an explicit prog source).
          { name: 'prog-global', cfg: mk((c) => {
              c.bed.on = false;
              c.extras = [_ambDefaultLayer('bass', 1)];   // default notes {scale:''} → inherits
              c.barsPerChord = 1;
              c.prog = { on: true, name: 'I-IV-V', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] },
              ] };
          }) },
          // Arp on a progression, 1 bar/chord — locks the bar-aligned chord (decoupled
          // from the series cursor): it arpeggiates C-E-G in bar 1, F-A-C in bar 2, …
          { name: 'prog-arp', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('arp', 1);
              L.steps = [{ notes: { type: 'prog', name: 'I-IV-V', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] },
              ] }, passes: 1, dir: 'up' }];
              c.extras = [L]; c.barsPerChord = 1;
          }) },
          // ---- KEY-axis pins (added pre-migration, 2026-07-14): lock the existing
          // keyOv / keyModeRot / variable-bars / seq-harmony behavior BEFORE the
          // degree-storage migration (Option C) touches any of these paths. ----
          // Per-layer KEY override, mode 'key': a riff pinned to D minor while the
          // area stays on the default key — pins the keyOv 'key' branch of _ambNotesOf.
          { name: 'keyov-key', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('run', 1);
              L.keyOv = { mode: 'key', root: 2, scale: 'minor' };
              c.extras = [L];
          }) },
          // Per-layer KEY override, mode 'prog': a riff following its OWN I-IV
          // progression — pins the keyOv 'prog' branch (a per-layer moving key).
          { name: 'keyov-prog', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('run', 1);
              L.keyOv = { mode: 'prog', name: 'I-IV', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
              ] };
              c.extras = [L]; c.barsPerChord = 1;
          }) },
          // AREA-level relative mode (keyModeRot) cascading to inheriting layers —
          // the area-side twin of mode-relminor (which sets per-layer modeRot).
          { name: 'key-modrot-area', cfg: mk((c) => {
              c.bed.on = true; c.motif.on = true;
              c.keyOn = true; c.keyFollow = false; c.keyRoot = 0; c.keyScale = 'major';
              c.keyModeRot = 5;
          }) },
          // Variable-length chords: per-chord `bars` (2 + 1 + 0.5) on the GLOBAL
          // prog — pins the cumulative lens[] walk in _ambProgStepAt (vs the
          // uniform fast path). NOTE: `bars` only engages on cfg.prog today —
          // _ambProgStepAt reads cfg.prog.chords for lengths, so a per-LAYER
          // prog's `bars` are silently uniform (found while pinning, 2026-07-14;
          // the KEY consolidation should unify this).
          { name: 'prog-varbars', cfg: mk((c) => {
              c.bed.on = false;
              c.extras = [_ambDefaultLayer('bass', 1)];   // default notes {scale:''} → inherits the global prog
              c.barsPerChord = 1;
              c.prog = { on: true, name: 'varbars', chords: [
                { root: 0, intervals: [0, 4, 7], bars: 2 }, { root: 5, intervals: [0, 4, 7], bars: 1 }, { root: 7, intervals: [0, 4, 7], bars: 0.5 },
              ] };
          }) },
          // v4 fix: per-chord `bars` on a LAYER progression (keyOv) — pins the
          // lens walk now that _ambProgStepAt reads the active source's chords
          // (pre-v4 a layer prog's bars were silently uniform). Same chords as
          // prog-varbars, so the streams should MATCH it (layer ≡ global).
          { name: 'keyov-varbars', cfg: mk((c) => {
              c.bed.on = false;
              const L = _ambDefaultLayer('bass', 1);
              L.keyOv = { mode: 'prog', name: 'varbars', chords: [
                { root: 0, intervals: [0, 4, 7], bars: 2 }, { root: 5, intervals: [0, 4, 7], bars: 1 }, { root: 7, intervals: [0, 4, 7], bars: 0.5 },
              ] };
              c.extras = [L]; c.barsPerChord = 1;
          }) },
          // Seq Harmony 'diatonic' under a detached G-major area key — pins the
          // capture-root→current-root transpose + scale snap in _ambSeqHarmonizeFreqs.
          { name: 'seq-diatonic', cfg: mk((c) => {
              c.bed.on = false;
              const s = _defaultSeqLayer(1); s.units = [seqUnit()]; s.on = true; s.harmony = 'diatonic';
              c.seqs = [s];
              c.keyOn = true; c.keyFollow = false; c.keyRoot = 7; c.keyScale = 'major'; c.keyMode = 'transpose';
          }) },
          // Seq Harmony 'chordlock' following its own I-IV-V keyOv progression —
          // pins the chord-DEGREE comping + scale-borrowed tensions (default
          // revoice smooth). Key DETACHED (C major) like key-transpose above:
          // the borrow walk reads the key scale, so following the live workspace
          // key would make the baseline depend on session state.
          { name: 'seq-chordlock', cfg: mk((c) => {
              c.bed.on = false;
              const s = _defaultSeqLayer(1); s.units = [seqUnit()]; s.on = true; s.harmony = 'chordlock';
              s.keyOv = { mode: 'prog', name: 'I-IV-V', chords: [
                { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] },
              ] };
              c.seqs = [s]; c.barsPerChord = 1;
              c.keyOn = true; c.keyFollow = false; c.keyRoot = 0; c.keyScale = 'major';
          }) },
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
        // Bypass the cold-start context gate (added 2026-06-25): headless has no
        // running AudioContext, and without this every tick returns early — the
        // whole battery silently compares EMPTY note streams and always "passes".
        E._everRan = true;

        const notes = [];
        let clock = 0;
        const nowFn = function () { return clock; };
        // Tone.now and context.now are getter-only ACCESSORS in Tone v14, so a
        // plain `Tone.now = fn` throws ("has only a getter"). Shadow them with an
        // own data property via defineProperty (which bypasses the inherited
        // accessor), and remove the shadow to restore the original getter.
        const restorers = [];
        const stubNow = (obj) => {
          if (!obj) return false;
          const hadOwn = Object.prototype.hasOwnProperty.call(obj, 'now');
          const prevDesc = hadOwn ? Object.getOwnPropertyDescriptor(obj, 'now') : null;
          try {
            Object.defineProperty(obj, 'now', { configurable: true, writable: true, value: nowFn });
            restorers.push(() => { try { if (hadOwn && prevDesc) Object.defineProperty(obj, 'now', prevDesc); else delete obj.now; } catch (e) {} });
            return true;
          } catch (e) { return false; }   // non-configurable source — fine as long as Tone (critical) took
        };
        const origPlay = playNote;
        try {
          stubNow(Tone);
          // context.now() is belt-and-suspenders — generation reads Tone.now(),
          // not context.now() — so ignore quietly if it can't be redefined.
          try { stubNow((typeof Tone.getContext === 'function') ? Tone.getContext() : Tone.context); } catch (e) {}
          // Verify the clock the generator actually reads is controlled, instead
          // of warning on the optional one.
          let _ctl = false; try { _ctl = (Tone.now() === clock); } catch (e) {}
          if (!_ctl) console.warn('[bloom-harness] Tone.now() not controllable — results may be non-deterministic.');
          // eslint-disable-next-line no-global-assign
          playNote = function (freq, params, durMs, at) {
            notes.push([
              r(at, 4), r(freq, 3), r(durMs, 2),
              (params && params.type) || '',
              r(params && params.pan, 2), r(params && params.volume, 2),
            ]);
          };
          // Mirror the live tick wrapper so the per-note colour engine engages
          // (it gates on _ambInGeneration). No-op for configs without colours.
          if (typeof _ambInGeneration !== 'undefined') _ambInGeneration = true;
          for (let i = 0; i < ticks; i++) {
            try { _ambTick(E); }
            catch (e) { notes.push(['ERR@' + i, String((e && e.message) || e)]); }
            clock += dt;
          }
        } finally {
          if (typeof _ambInGeneration !== 'undefined') _ambInGeneration = false;
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
        'bed':           { hash: '1d8eacee', count: 12 },
        'motif':         { hash: '8e39cc63', count: 9 },
        'texture':       { hash: '2c80e9bc', count: 25 },   // Track D/D2: unified step-grid emitter (grid-synced shimmer) — deliberate re-baseline, ear-checked. Old free-scanner baseline was b766f5dc/3; revert via bloomStepGrid(false).
        'beat-random':   { hash: '872e5741', count: 19 },
        'beat-euclid':   { hash: 'c2c8241b', count: 19 },
        'arp':           { hash: 'd5cc969a', count: 52 },
        'bass':          { hash: '0a287885', count: 32 },
        'run':           { hash: '587c0ec7', count: 46 },
        'pedal':         { hash: 'e788032c', count: 26 },
        'drone':         { hash: '053bdf7f', count: 1 },   // Drone default Unit 2000→8000 ms (Hold 4 = 32 s cycle) — deliberate: the drone is now the long-hold pad layer. Was 45a97025/2.
        'seq-pitch':     { hash: '64b0939b', count: 38 },
        'combo':         { hash: '5801b9eb', count: 63 },   // Track D/D2: includes the texture layer, so it re-baselines with texture (was ad0b1f59/53).
        // Phase 1 — Key transpose/quantize (G major). Locks the new behavior.
        'key-transpose': { hash: '56adac6e', count: 18 },
        'key-quantize':  { hash: 'dc3ce346', count: 18 },
        // Phase 3 — relative mode (re-centred to the relative minor).
        'mode-relminor': { hash: '33f6b03a', count: 18 },
        // Phase 4 — blue-notes colour set at 50%.
        'color-blue':    { hash: '94d352e9', count: 19 },
        // Progressions (bar-aligned chord clock) — recorded 2026-07-05; these
        // were in the battery but never baselined (verified stable across the
        // key-integration change: identical hashes before/after).
        'prog-bass':     { hash: 'c6987a55', count: 32 },
        'prog-global':   { hash: 'c6987a55', count: 32 },
        'prog-arp':      { hash: 'be2ab3a6', count: 52 },   // 2026-07-12: pattern RESTART at each chord change (sweep from the top — classic arp; was 4d144e5a, cursor ran continuously through boundaries = per-bar pattern rotation)
        // KEY-axis pins (2026-07-14, recorded pre-migration) — lock keyOv/keyModeRot/
        // variable-bars/seq-harmony behavior before the degree-storage migration.
        'keyov-key':       { hash: '40aa0745', count: 46 },
        'keyov-prog':      { hash: '0c078c11', count: 46 },
        'key-modrot-area': { hash: '9eedc324', count: 18 },
        'prog-varbars':    { hash: '5b83b2e3', count: 32 },
        'keyov-varbars':   { hash: '5b83b2e3', count: 32 },
        'arp-series-legacy': { hash: '33952b9c', count: 52 },
        'yoke-bass':       { hash: 'f18415bc', count: 44 },
        'chordmask-steps': { hash: '7a4c9c6a', count: 12 },   // 2026-07-15: chord sequencer — bass plays ONLY chord 0 of I-IV-V (verified: zero off-chord notes under the engine clock)
        'chordmask-part':  { hash: 'fdef4148', count: 19 },   // 2026-07-15: partial window — END half of every chord only (verified: zero first-half notes)   // 2026-07-15: YOKE — a bass whose KEY frame is the bed's sounding notes per onset (keyOv mode 'yoke'); boundary notes harmonize the PREVIOUS chord (pick-time frame — 'play what you hear')   // 2026-07-15 pre-migration pin: per-entry scales + mixed passes/dir — the series→degrees derivation must keep this byte-identical   // v4: DELIBERATELY identical to prog-varbars — a layer prog's per-chord bars now drive the same lens walk as the global's (the asymmetry fix)
        'seq-diatonic':    { hash: 'e31a6dbb', count: 38 },
        'seq-chordlock':   { hash: '5d9f97e6', count: 38 },   // 2026-07-14: chord-DEGREE comping (re-anchor to each chord root + scale-borrowed tensions) replaced the Hz nearest-snap, AND the config detached its key (the original c90d8daf pin followed the live workspace scale = session-dependent). Verified: all output diatonic, captured C-E motif re-anchors to F-A over IV.
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
