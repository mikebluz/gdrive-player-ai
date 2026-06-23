    // ============================================================
    // 17-ambient.js — "Bloom" generative ambient mode (Phases 1–3)
    // ============================================================
    // The fifth per-lane mode (Grid → Graph → Game → Prog → Bloom). A small
    // generative rig with up to three layers that share the lane's key,
    // tuning, BPM and FX sends, all driven by one free/sync schedule-ahead
    // clock:
    //   • Bed     — evolving scale-rooted drone-pad chords (long swells).
    //   • Motif   — a weighted random-walk melody over the scale.
    //   • Texture — a slowly self-mutating sparse shimmer pattern.
    // Each layer exposes an explicit Interval (time between events) and
    // Length (how long each event sounds). Plus a Sync/Free timing toggle, a
    // Space fader (stereo distribution), Seed/Regenerate, Freeze→lane, and an
    // analyser-bound visual.
    //
    // Isolation: nothing runs unless the active lane is in Bloom mode AND the
    // panel's Play is on. Voices emit through the normal playNote path with
    // the active lane's index, so they pass through the lane bus + per-lane FX
    // sends. Pitch material comes from currentScale + rootIdx + any active
    // microtonal tuning, so it tracks the workspace key for free.

    // ---- Per-lane config (persisted on lane.ambient) -------------------
    // Per-layer modulation defaults — one independent { depth, rate, shape }
    // per target (VCA/VCO/VCF). Rates staggered so an enabled default isn't
    // phase-locked across targets.
    function _ambDefaultMod() {
      return {
        vca: { depth: 0, rate: 30, shape: 'sine' },
        vco: { depth: 0, rate: 20, shape: 'sine' },
        vcf: { depth: 0, rate: 15, shape: 'sine' },
      };
    }
    // Per-layer FX defaults (all OFF: reverb send 0, delay/distortion mix 0).
    // `revSend` (0..100) feeds the engine's dedicated reverb. `delay` is a
    // FeedbackDelay (mix 0..100, timeMs, feedback 0..95). `dist` is a Distortion
    // (amount 0..100 drive, mix 0..100 wet).
    function _ambDefaultFx() {
      return { revSend: 0, delay: { mix: 0, timeMs: 300, feedback: 35 }, dist: { mix: 0, amount: 40 } };
    }
    function _defaultAmbientConfig() {
      return {
        timing: 'free',                 // 'free' | 'sync'
        seed:   1,
        space:  0,                      // 0 = centred → 100 = half full-L / half full-R
        // Instance "Key": when keyOn, the Bloom is constrained to one key —
        // root `keyRoot` (0..11 pc) + quality `keyScale` (a SCALES name). The
        // key drives two things: (1) every layer's Notes menu only offers
        // material that "works in the key" — diatonic, borrowed (modal
        // interchange from the parallel major/minor pool), or with ≤1 chromatic
        // passing tone (see _ambPcsWorkInKey); (2) scales/progressions root to
        // the key tonic (chords/wraps keep their own root so degrees & borrowed
        // chords play true). keyOff = behaviour exactly as before.
        keyOn:    false,
        keyRoot:  0,
        keyScale: 'major',
        progRateMs: 4000,               // ms per chord for "Progression" note sources
        freezeLenMs: 10000,             // per-layer Freeze loop length (last N ms)
        // Dedicated per-instance reverb (the per-layer "Reverb send" feeds it).
        // size → Freeverb roomSize (0..1); damp → dampening Hz (higher = darker).
        reverb: { size: 80, damp: 45 },
        // `tone` is the layer's instrument: '' = follow the grid voice
        // (cellParams[0]); otherwise a value from getAllSoundOptions (any
        // synth or non-drum sample). Beat uses `kit` (drums only) instead.
        // `scale` overrides the layer's note set: '' = follow the workspace
        // scale (currentScale); otherwise a SCALES name. The root stays the
        // workspace root. Beat is unpitched (drum map), so it has no scale.
        // `mod` is the per-layer VCO/VCA/VCF modulation. Each target has its
        // own { depth (0..100, 0=off), rate (0..100 -> Hz free / division sync),
        // shape }. Shapes: sine/triangle/sawtooth/square + stochastic
        // 'smooth' (ramped random) / 'sharp' (sample & hold).
        // `level` (0..100, default 70) scales the layer's output: 70 = the tuned
        // default (the layer's normal staged level), 0..70 attenuates toward
        // silence, and 70..100 boosts the layer up toward a full grid-press voice
        // (100 = grid-cell loudness). Bloom layers sit below grid level for
        // polyphony headroom; the upper half of the slider buys it back when you
        // want it. `drift` (0..99) phase-offsets the layer's events by that
        // fraction of its Interval, so layers can be staggered against each other.
        // `when` is an Elektron-style per-event conditional ('always' | '1st' |
        // 'A:B') that gates which of the layer's generated events actually fire —
        // e.g. '1:2' = every other event, for sparser/polymetric interplay.
        bed:     { on: true,  density: 4, register: 4, spread: 2, intervalMs: 4750, lengthMs: 6650, motion: 30, drift: 0, when: 'always', level: 70, panMode: 'spread', space: 0, strum: 0, strumFidelity: 0, tone: '', scale: '', mod: _ambDefaultMod(), ..._ambDefaultFx() },
        motif:   { on: false, register: 5, range: 2, proximity: 35, intervalMs: 1200, lengthMs: 1000, restProb: 30, twist: 0, accent: 0, drift: 0, when: 'always', level: 70, panMode: 'spread', space: 0, tone: '', scale: '', mod: _ambDefaultMod(), ..._ambDefaultFx() },
        texture: { on: false, register: 6, fill: 35, intervalMs: 450, lengthMs: 300, mutateRate: 40, drift: 0, when: 'always', level: 70, panMode: 'spread', space: 0, tone: '', scale: '', mod: _ambDefaultMod(), ..._ambDefaultFx() },
        beat:    { on: false, kit: 'tr808', gen: 'random', intervalMs: 500, lengthMs: 200, restProb: 25, bars: 1, pulses: 4, steps: 8, rotate: 0, rhythmVar: 0, drift: 0, when: 'always', level: 70, panMode: 'spread', space: 0, mod: _ambDefaultMod(), ..._ambDefaultFx() },
        // `seqs` is a DYNAMIC list of sequence-seeded layers (Seq1, Seq2…),
        // created by "Send to Bloom". Each replays one or more saved-sequence
        // "units", improvising variations and periodically returning to verbatim.
        // See _defaultSeqLayer() for a layer's shape. Empty by default.
        seqs:    [],
        // Dynamic list of Sample layers — each plays a single-buffer sample
        // (chopped/whole) per Interval. See _defaultSampleLayer(). Empty default.
        samples: [],
        // Additional Bed/Motif/Texture/Beat instances beyond the four primaries
        // (each {type,id,...layerParams}). Empty default. See _ambDefaultLayer().
        extras:  [],
        // `playing` is never persisted as true — the generator only starts on
        // an explicit gesture (a suspended AudioContext would swallow autostart).
      };
    }

    // ---- Engine instances ----------------------------------------------
    // Bloom runs as one or more INDEPENDENT engine instances, so a per-lane
    // Bloom and the master Bloom (in the Mix view) can play simultaneously.
    // Each instance object holds ALL per-run state (RNG, generator clocks, mod
    // chains, viz). The deep generator/mod functions read the "current" engine
    // through the module pointer `_E`; the tick + lifecycle/UI entry points set
    // `_E` before running. Ticks never interleave (JS is single-threaded and a
    // tick runs synchronously start-to-finish), so a shared pointer is safe.
    let _E = null;
    let masterAmbient = null; // global config for the master (Mix) instance
    function _makeAmbientEngine(opts) {
      return {
        getCfg: opts.getCfg, busNode: opts.busNode, laneIdx: opts.laneIdx, guard: opts.guard,
        hostId: opts.hostId, idPrefix: opts.idPrefix, vizId: opts.vizId,
        playId: opts.playId, seedId: opts.seedId, isLane: !!opts.isLane,
        // per-run state (was module-global, single-instance)
        rng: 1, motifDeg: null, texPattern: null, texStep: 0, texMutateAt: 0,
        mod: {}, reverb: null, timer: null, rampTimer: null, _cfg: null, progStep: 0, clocks: {}, iters: {}, seqState: {}, inited: false, viz: null,
      };
    }
    const _laneEng = _makeAmbientEngine({
      getCfg:  function () { return _laneAmbientCfg(); },
      busNode: function () {
        try { if (typeof getLaneBus === 'function') return getLaneBus(activeLaneIdx); } catch (e) {}
        return (typeof globalSendTap !== 'undefined' && globalSendTap) ? globalSendTap : Tone.getDestination();
      },
      laneIdx: function () { return (typeof activeLaneIdx !== 'undefined') ? activeLaneIdx : 0; },
      guard:   function () { return (typeof ambientMode !== 'undefined' && !!ambientMode); },
      hostId: 'ambient-inner', idPrefix: 'ambient', vizId: 'ambient-viz',
      playId: 'ambient-play-btn', seedId: 'ambient-seed-val', isLane: true,
    });
    // Mix-Bloom master trim. Mix Bloom routes its (often many, simultaneous)
    // layer voices straight to masterBus, while lane playback goes through the
    // laneSumBus headroom trim — so the dense Bloom mix reads much louder. A
    // single gain between all Bloom layers and masterBus evens them out
    // (−6 dB), kept lazy so masterBus/Tone exist when it's first built.
    let _bloomMasterGain = null;
    const _BLOOM_MASTER_TRIM = 0.5;
    function _ambMasterBloomBus() {
      if (_bloomMasterGain) return _bloomMasterGain;
      if (typeof masterBus === 'undefined' || !masterBus || typeof Tone === 'undefined') return (typeof masterBus !== 'undefined' && masterBus) ? masterBus : Tone.getDestination();
      try { _bloomMasterGain = new Tone.Gain(_BLOOM_MASTER_TRIM).connect(masterBus); }
      catch (e) { return masterBus; }
      return _bloomMasterGain;
    }
    const _masterEng = _makeAmbientEngine({
      getCfg:  function () { masterAmbient = masterAmbient || _defaultAmbientConfig(); return _normalizeAmbientCfg(masterAmbient); },
      busNode: function () { return _ambMasterBloomBus(); },
      laneIdx: function () { return null; },
      guard:   function () { return true; },
      hostId: 'mix-bloom-host', idPrefix: 'mix-bloom', vizId: 'mix-bloom-viz',
      playId: 'mix-bloom-play-btn', seedId: 'mix-bloom-seed-val', isLane: false,
    });
    // ---- Shape-Bloom render engine -------------------------------------
    // A hidden Bloom engine that PLAYS the Bloom-sourced master Shapes live: each
    // such shape carries its source layer's full config (entry.bloomLayer), which
    // we assemble into a synthetic Bloom config here. Driven by the Shapes
    // transport (21-shape.js) so a "shape" evolves cycle-to-cycle and sounds
    // exactly like the layer (same generators, voice, and Bloom-bus routing).
    let _shapeBloomCfgCache = null, _shapeBloomCfgSig = '';
    function _shapeBloomLayers() {
      return (Array.isArray(masterShapes) ? masterShapes : []).filter(c => c && c.bloomLayer && c.bloomLayer.type && c.bloomLayer.cfg);
    }
    function _shapeBloomSynthCfg() {
      const live = _shapeBloomLayers();
      // Solo: when ANY shape is soloed, only soloed layers get `on` (the engine
      // gates the rest). Solo state is in the sig so a toggle rebuilds the config.
      const anySolo = (Array.isArray(masterShapes) ? masterShapes : []).some(c => c && c.solo);
      const sig = live.map(c => c.id + ':' + c.bloomLayer.type + ':' + (c.solo ? 1 : 0)).join('|') + '#' + (anySolo ? 1 : 0);
      if (_shapeBloomCfgCache && sig === _shapeBloomCfgSig) {
        // Refresh the entry→render-key map (cheap) and reuse the built config.
        return _shapeBloomCfgCache;
      }
      const base = _defaultAmbientConfig();
      ['bed', 'motif', 'texture', 'beat'].forEach(k => { if (base[k]) { base[k].present = false; base[k].on = false; } });
      base.extras = []; base.seqs = []; base.samples = [];
      let xid = 1, sid = 1;
      live.forEach(c => {
        const bl = c.bloomLayer;
        const lc = JSON.parse(JSON.stringify(bl.cfg));
        lc.on = anySolo ? !!c.solo : true; lc.present = true; lc.solo = false;
        if (bl.type === 'seq') { lc.id = sid++; base.seqs.push(lc); c._renderKey = 'seq:' + lc.id; }
        else { lc.type = bl.type; lc.id = xid++; base.extras.push(lc); c._renderKey = bl.type + ':' + lc.id; }
      });
      _shapeBloomCfgCache = _normalizeAmbientCfg(base);
      _shapeBloomCfgSig = sig;
      return _shapeBloomCfgCache;
    }
    function _shapeBloomInvalidate() { _shapeBloomCfgCache = null; _shapeBloomCfgSig = ' '; }
    const _shapeBloomEng = _makeAmbientEngine({
      getCfg:  function () { return _shapeBloomSynthCfg(); },
      busNode: function () { return _ambMasterBloomBus(); },
      laneIdx: function () { return null; },
      guard:   function () { return true; },
      hostId: 'shape-bloom-host', idPrefix: 'shape-bloom', vizId: 'shape-bloom-viz',
      playId: 'shape-bloom-play', seedId: 'shape-bloom-seed', isLane: false,
    });
    _E = _laneEng;

    // Normalize a {vca,vco,vcf} mod object in place (migrate old flat schema).
    function _ambNormalizeModObj(host, dmod) {
      let mm = host.mod;
      if (!mm || typeof mm !== 'object') { host.mod = mm = _ambDefaultMod(); }
      if (typeof mm.vca === 'number' || typeof mm.shape === 'string') {
        const shp = (typeof mm.shape === 'string') ? mm.shape : 'sine';
        const rt = Number.isFinite(mm.rate) ? mm.rate : 25;
        const mk2 = (dep) => ({ depth: Number.isFinite(dep) ? dep : 0, rate: rt, shape: shp });
        host.mod = mm = { vca: mk2(mm.vca), vco: mk2(mm.vco), vcf: mk2(mm.vcf) };
      }
      ['vca', 'vco', 'vcf'].forEach(tg => {
        const dt = dmod[tg];
        if (!mm[tg] || typeof mm[tg] !== 'object') mm[tg] = { ...dt };
        else {
          if (!Number.isFinite(mm[tg].depth)) mm[tg].depth = 0;
          if (!Number.isFinite(mm[tg].rate)) mm[tg].rate = dt.rate;
          if (typeof mm[tg].shape !== 'string') mm[tg].shape = 'sine';
        }
        // Sequence-as-waveform fields (used when shape === 'seq').
        const o = mm[tg];
        if (!Number.isFinite(o.seqRef)) o.seqRef = 0;
        if (['pitch','velocity','gate'].indexOf(o.seqSource) < 0) o.seqSource = 'velocity';
        if (['step','smooth'].indexOf(o.seqInterp) < 0) o.seqInterp = 'step';
        if (['zero','hold'].indexOf(o.seqRest) < 0) o.seqRest = 'zero';
      });
    }
    // Backfill a layer's FX block in place (preserves objects across reload).
    function _ambNormalizeFx(host) {
      const d = _ambDefaultFx();
      if (!Number.isFinite(host.revSend)) host.revSend = d.revSend;
      if (!host.delay || typeof host.delay !== 'object') host.delay = { ...d.delay };
      else ['mix', 'timeMs', 'feedback'].forEach(k => { if (!Number.isFinite(host.delay[k])) host.delay[k] = d.delay[k]; });
      if (!host.dist || typeof host.dist !== 'object') host.dist = { ...d.dist };
      else ['mix', 'amount'].forEach(k => { if (!Number.isFinite(host.dist[k])) host.dist[k] = d.dist[k]; });
    }
    // A Seq layer: replays one or more saved-sequence "units", improvising
    // variations and periodically returning to verbatim. `units[]` each =
    // { events:[{freqs:number[],durMs,vel}], scale, rootIdx, baseOctave, bpm,
    //   name, reps } — a "section". `unitMode`: 'single' (one unit) | 'sequence'
    // (play sections in order, each ×reps, then loop) | 'random' (bag of Σreps
    // picks, drawn without replacement, refilled when empty). `keyMaster` (≤1 per
    // Bloom) makes this Seq drive the GLOBAL key — grid + generative layers
    // follow each section's key. `id` stable monotonic int; name positional.
    function _defaultSeqLayer(id) {
      // intervalMode 'auto' (default) → one iteration == the played unit's own
      // natural length, so the loop closes exactly on the sequence (and breathes
      // per-unit in Interleave). 'manual' → honor the Interval knob, as a knob.
      return { id: id | 0, on: true, intervalMode: 'auto', intervalMs: 2000, lengthMs: 1200, drift: 0, when: 'always',
               panMode: 'spread', space: 0,
               level: 70, accent: 0, ensembleLock: true, tone: '', scale: '', mod: _ambDefaultMod(),
               varyMode: 'pitch', varyDepth: 40, returnMode: 'everyN', returnN: 4, returnChance: 25,
               unitMode: 'single', units: [], keyMaster: false, ..._ambDefaultFx() };
    }
    function _ambValidUnit(u) {
      return !!(u && typeof u === 'object' && Array.isArray(u.events) && u.events.length > 0);
    }
    // Per-layer stereo (Spread/Pan) validation, shared by every layer type.
    function _ambNormalizeSpread(L) {
      if (!L || typeof L !== 'object') return;
      if (L.panMode !== 'pan' && L.panMode !== 'spread') L.panMode = 'spread';
      if (!Number.isFinite(L.space)) L.space = 0;
      L.space = Math.max(-100, Math.min(100, L.space | 0));
    }
    function _normalizeSeqLayer(s, id) {
      const d = _defaultSeqLayer(id);
      if (!Number.isFinite(s.id)) s.id = id;
      if (typeof s.on !== 'boolean') s.on = true;
      ['intervalMs','lengthMs','drift','level','accent','varyDepth','returnN','returnChance'].forEach(k => { if (!Number.isFinite(s[k])) s[k] = d[k]; });
      ['tone','scale'].forEach(k => { if (typeof s[k] !== 'string') s[k] = d[k]; });
      if (typeof s.when !== 'string') s.when = 'always';
      if (typeof s.ensembleLock !== 'boolean') s.ensembleLock = true;
      if (s.varyMode !== 'pitch' && s.varyMode !== 'rhythm' && s.varyMode !== 'pad') s.varyMode = 'pitch';
      if (s.intervalMode !== 'auto' && s.intervalMode !== 'manual') s.intervalMode = 'auto';
      if (s.returnMode !== 'everyN' && s.returnMode !== 'chance') s.returnMode = 'everyN';
      // unitMode: migrate legacy 'interleave' → 'random'; everything else but
      // 'random' is the ordered 'sequence'. ('single' stays meaningful for 1 unit.)
      if (s.unitMode === 'interleave') s.unitMode = 'random';
      if (s.unitMode !== 'single' && s.unitMode !== 'sequence' && s.unitMode !== 'random') s.unitMode = 'single';
      if (typeof s.keyMaster !== 'boolean') s.keyMaster = false;
      if (!Array.isArray(s.units)) s.units = [];
      s.units = s.units.filter(_ambValidUnit);
      // Per-section fields: iterations before switching + a display name.
      s.units.forEach((u, i) => {
        u.reps = Math.max(1, Math.min(64, (u.reps | 0) || 1));
        if (typeof u.name !== 'string' || !u.name) u.name = 'Section ' + (i + 1);
      });
      _ambNormalizeModObj(s, d.mod);
      _ambNormalizeFx(s);
      _ambNormalizeNotes(s);
      _ambNormalizeSpread(s);
      _ambNormalizeUnit(s);
      return s;
    }
    // A Sample layer plays a single-buffer `sample:<id>` raw. `chop` 1 = retrigger
    // the whole sample each Interval; N = chop into N slices played across the
    // Interval, in `order` (forward cursor / random). Reuses per-layer mod + FX.
    function _defaultSampleLayer(id) {
      return { id: id | 0, on: true, sampleId: '', name: '',
               chop: 1, order: 'forward',
               intervalMs: 2000, lengthMs: 1200, drift: 0, when: 'always', level: 70, panMode: 'spread', space: 0,
               mod: _ambDefaultMod(), ..._ambDefaultFx() };
    }
    function _normalizeSampleLayer(s, id) {
      const d = _defaultSampleLayer(id);
      if (!Number.isFinite(s.id)) s.id = id;
      if (typeof s.on !== 'boolean') s.on = true;
      if (typeof s.sampleId !== 'string') s.sampleId = '';
      if (typeof s.name !== 'string') s.name = '';
      ['chop','intervalMs','lengthMs','drift','level'].forEach(k => { if (!Number.isFinite(s[k])) s[k] = d[k]; });
      s.chop = Math.max(1, Math.min(16, s.chop | 0));
      if (s.order !== 'forward' && s.order !== 'random') s.order = 'forward';
      if (typeof s.when !== 'string') s.when = 'always';
      _ambNormalizeModObj(s, d.mod);
      _ambNormalizeFx(s);
      _ambNormalizeSpread(s);
      _ambNormalizeUnit(s);
      return s;
    }
    // Migrate + backfill a Bloom config in place (shared by per-lane + master).
    function _normalizeAmbientCfg(cfg) {
      if (!cfg || typeof cfg !== 'object') return _defaultAmbientConfig();
      const d = _defaultAmbientConfig();
      // Phase 1 → 2 migration: a flat config becomes the `bed` layer.
      if (!cfg.bed && Number.isFinite(cfg.density)) {
        cfg.bed = { on: true, density: cfg.density, register: cfg.register, spread: cfg.spread, evolveRate: cfg.evolveRate };
        ['density','register','spread','evolveRate'].forEach(k => delete cfg[k]);
      }
      if (cfg.timing !== 'free' && cfg.timing !== 'sync') cfg.timing = d.timing;
      if (typeof cfg.queueMode !== 'boolean') cfg.queueMode = false;
      if (typeof cfg.tails !== 'boolean') cfg.tails = false; // Queue STOP: let reverb keep feeding past the boundary (fuller tail) vs cut the wet with the gate
      if (!Number.isFinite(cfg.seed)) cfg.seed = d.seed;
      if (!Number.isFinite(cfg.space)) cfg.space = d.space;
      if (typeof cfg.keyOn !== 'boolean') cfg.keyOn = d.keyOn;
      if (!Number.isFinite(cfg.keyRoot)) cfg.keyRoot = d.keyRoot;
      cfg.keyRoot = ((((cfg.keyRoot | 0) % 12) + 12) % 12);
      if (typeof cfg.keyScale !== 'string' || !cfg.keyScale) cfg.keyScale = d.keyScale;
      if (typeof SCALES !== 'undefined' && SCALES && !SCALES[cfg.keyScale]) cfg.keyScale = d.keyScale;
      if (!Number.isFinite(cfg.progRateMs)) cfg.progRateMs = d.progRateMs;
      if (!Number.isFinite(cfg.freezeLenMs)) cfg.freezeLenMs = d.freezeLenMs;
      if (!cfg.reverb || typeof cfg.reverb !== 'object') cfg.reverb = { ...d.reverb };
      else { if (!Number.isFinite(cfg.reverb.size)) cfg.reverb.size = d.reverb.size; if (!Number.isFinite(cfg.reverb.damp)) cfg.reverb.damp = d.reverb.damp; }
      ['bed','motif','texture','beat'].forEach(layer => {
        if (!cfg[layer] || typeof cfg[layer] !== 'object') cfg[layer] = { ...d[layer] };
      });
      // Spread → per-layer migration. The old single global `cfg.space` is gone;
      // carry its width onto every layer that predates this change so existing
      // Blooms keep their stereo image. Must run BEFORE the field backfills below
      // (which would otherwise stamp the new `space: 0` default over it). New
      // layers default to centred Spread (space 0, set by the layer factories).
      {
        const legacy = Number.isFinite(cfg.space) ? (cfg.space | 0) : 0;
        const mig = (L) => {
          if (!L || typeof L !== 'object') return;
          if (L.panMode !== 'pan' && L.panMode !== 'spread') L.panMode = 'spread';
          if (!Number.isFinite(L.space)) L.space = legacy;
          L.space = Math.max(-100, Math.min(100, L.space | 0));
        };
        ['bed','motif','texture','beat'].forEach(l => mig(cfg[l]));
        if (Array.isArray(cfg.seqs)) cfg.seqs.forEach(mig);
        if (Array.isArray(cfg.samples)) cfg.samples.forEach(mig);
        if (Array.isArray(cfg.extras)) cfg.extras.forEach(mig);
      }
      ['bed','motif','texture','beat'].forEach(layer => {
        const L = cfg[layer];
        if (!L || typeof L !== 'object') return;
        if (typeof L.when === 'number' && !Number.isFinite(L.drift)) { L.drift = L.when; delete L.when; }
        if (typeof L.when !== 'string') L.when = 'always';
        if (!Number.isFinite(L.drift)) L.drift = 0;
      });
      const bed = cfg.bed;
      if (!Number.isFinite(bed.intervalMs)) {
        const ev = Number.isFinite(bed.evolveRate) ? (8 - (bed.evolveRate / 100) * 6.5) : 4.75;
        bed.intervalMs = Math.round(ev * 1000);
        bed.lengthMs = Math.round(ev * 1400);
        delete bed.evolveRate;
      }
      const mo = cfg.motif;
      if (!Number.isFinite(mo.intervalMs)) {
        mo.intervalMs = Number.isFinite(mo.density) ? Math.round((2.0 - (mo.density / 100) * 1.78) * 1000) : 1200;
        mo.lengthMs   = Number.isFinite(mo.lenScale) ? Math.round(180 + (mo.lenScale / 100) * 1800) : 1000;
        delete mo.density; delete mo.lenScale;
      }
      const tx = cfg.texture;
      if (!Number.isFinite(tx.intervalMs)) {
        if (Number.isFinite(tx.density)) { tx.fill = tx.density; tx.intervalMs = Math.round((0.9 - (tx.density / 100) * 0.62) * 1000); }
        else { tx.intervalMs = 450; }
        tx.lengthMs = 300;
        delete tx.density;
      }
      ['bed','motif','texture','beat'].forEach(layer => {
        Object.keys(d[layer]).forEach(k => {
          if (k === 'on') { if (typeof cfg[layer].on !== 'boolean') cfg[layer].on = d[layer].on; }
          else if (k === 'kit' || k === 'tone' || k === 'scale' || k === 'when' || k === 'panMode' || k === 'gen') { if (typeof cfg[layer][k] !== 'string') cfg[layer][k] = d[layer][k]; }
          else if (k === 'mod') { _ambNormalizeModObj(cfg[layer], d[layer].mod); }
          else if (k === 'delay' || k === 'dist') { /* handled by _ambNormalizeFx below */ }
          else if (!Number.isFinite(cfg[layer][k])) cfg[layer][k] = d[layer][k];
        });
        _ambNormalizeFx(cfg[layer]);
      });
      // Built-in layers are now "addable": only present ones show + play. New
      // configs start with just Bed; an Add-layer menu adds the others. Migrate
      // old saves: a layer that was ON stays present so nothing vanishes.
      ['bed', 'motif', 'texture', 'beat'].forEach(l => {
        if (typeof cfg[l].present !== 'boolean') cfg[l].present = (l === 'bed') ? true : !!cfg[l].on;
      });
      ['bed', 'motif', 'texture'].forEach(l => _ambNormalizeNotes(cfg[l]));
      ['bed', 'motif', 'texture', 'beat'].forEach(l => _ambNormalizeUnit(cfg[l]));
      // Seq layers: ensure array; migrate a legacy single `seq` slot → seqs[].
      if (!Array.isArray(cfg.seqs)) cfg.seqs = [];
      if (cfg.seq && typeof cfg.seq === 'object') {
        const old = cfg.seq, seq = _defaultSeqLayer(0);
        ['on','intervalMs','lengthMs','drift','when','level','tone','scale','varyMode','varyDepth','returnMode','returnN','returnChance'].forEach(k => { if (old[k] != null) seq[k] = old[k]; });
        if (old.mod && typeof old.mod === 'object') seq.mod = old.mod;
        if (_ambValidUnit(old.seed)) seq.units = [old.seed];
        cfg.seqs.push(seq);
        delete cfg.seq;
      }
      let maxId = 0;
      cfg.seqs.forEach(s => { if (s && Number.isFinite(s.id) && s.id > maxId) maxId = s.id; });
      cfg.seqs.forEach(s => { if (s && !Number.isFinite(s.id)) s.id = ++maxId; });
      cfg.seqs = cfg.seqs.filter(s => s && typeof s === 'object').map(s => _normalizeSeqLayer(s, s.id));
      // At most ONE Seq layer may be the key master — keep the first, clear the rest.
      { let seenKM = false; cfg.seqs.forEach(s => { if (s.keyMaster) { if (seenKM) s.keyMaster = false; else seenKM = true; } }); }
      // Sample layers (parallel dynamic list).
      if (!Array.isArray(cfg.samples)) cfg.samples = [];
      let maxSid = 0;
      cfg.samples.forEach(s => { if (s && Number.isFinite(s.id) && s.id > maxSid) maxSid = s.id; });
      cfg.samples.forEach(s => { if (s && !Number.isFinite(s.id)) s.id = ++maxSid; });
      cfg.samples = cfg.samples.filter(s => s && typeof s === 'object').map(s => _normalizeSampleLayer(s, s.id));
      // Extra layer instances (additional Bed/Motif/Texture/Beat).
      if (!Array.isArray(cfg.extras)) cfg.extras = [];
      let maxXid = 0;
      cfg.extras.forEach(x => { if (x && Number.isFinite(x.id) && x.id > maxXid) maxXid = x.id; });
      cfg.extras = cfg.extras.filter(x => x && typeof x === 'object' && _AMB_LAYER_SCHEMA[x.type]).map(x => {
        if (!Number.isFinite(x.id)) x.id = ++maxXid;
        const d = _ambDefaultLayer(x.type, x.id);
        Object.keys(d).forEach(k => { if (k === 'mod' || k === 'delay' || k === 'dist' || k === 'notes') return; if (typeof x[k] === 'undefined') x[k] = d[k]; });
        if (typeof x.on !== 'boolean') x.on = true;
        if (typeof x.present !== 'boolean') x.present = true;
        _ambNormalizeModObj(x, _ambDefaultMod());
        _ambNormalizeFx(x);
        _ambNormalizeUnit(x);
        if (x.type !== 'beat' && x.type !== 'shape' && x.type !== 'arp') _ambNormalizeNotes(x);
        if (x.type === 'shape') {
          if (!Array.isArray(x.shapes) || !x.shapes.length) x.shapes = (typeof _shapeDefault === 'function') ? [_shapeDefault()] : [];
          if (typeof _shapeNormalize === 'function') x.shapes = x.shapes.map(s => _shapeNormalize(s));
          x.sel = Math.max(0, Math.min(x.sel | 0, Math.max(0, x.shapes.length - 1)));
        }
        if (x.type === 'arp') {
          if (!Array.isArray(x.steps) || !x.steps.length) x.steps = [{ notes: { type: 'scale', scale: '' }, passes: 1 }];
          const _DIRS = ['up', 'down', 'updown', 'downup', 'random'];
          const _layerDir = (_DIRS.indexOf(x.dir) >= 0) ? x.dir : 'up';
          x.steps = x.steps.map(s => {
            const st = (s && typeof s === 'object') ? s : {};
            if (!st.notes || typeof st.notes !== 'object' || typeof st.notes.type !== 'string') st.notes = { type: 'scale', scale: '' };
            _ambNormalizeNotes(st);
            st.passes = Math.max(1, Math.min(16, (st.passes | 0) || 1));
            // Per-entry note unit: 'passes' (whole sweeps, default) or 'notes'
            // (exact count). `count` holds the exact-notes value (0 = unset).
            st.unit = (st.unit === 'notes') ? 'notes' : 'passes';
            st.count = Math.max(0, Math.min(64, (st.count | 0) || 0));
            // Direction is per ENTRY now — migrate the old layer-wide dir onto
            // any entry that lacks one.
            if (_DIRS.indexOf(st.dir) < 0) st.dir = _layerDir;
            return st;
          });
          x.sel = Math.max(0, Math.min(x.sel | 0, x.steps.length - 1));
          x.dir = _layerDir;   // kept only as the default direction for newly-added entries
          x.randomness = Math.max(0, Math.min(100, x.randomness | 0));
          x.octaves = Math.max(1, Math.min(4, (x.octaves | 0) || 2));
          x.register = Math.max(1, Math.min(8, (x.register | 0) || 4));
        }
        return x;
      });
      // Parameter ramps (LFO automation of a layer param between A and B).
      if (!Array.isArray(cfg.ramps)) cfg.ramps = [];
      let maxRid = 0;
      cfg.ramps.forEach(r => { if (r && Number.isFinite(r.id) && r.id > maxRid) maxRid = r.id; });
      cfg.ramps.forEach(r => { if (r && !Number.isFinite(r.id)) r.id = ++maxRid; });
      cfg.ramps = cfg.ramps.filter(r => r && typeof r === 'object').map(r => _normalizeRamp(r, r.id, cfg));
      return cfg;
    }
    function _laneAmbientCfg() {
      const lane = (typeof lanes !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (!lane) return null;
      if (!lane.ambient || typeof lane.ambient !== 'object') lane.ambient = _defaultAmbientConfig();
      return _normalizeAmbientCfg(lane.ambient);
    }

    // ---- Seedable RNG (mulberry32) — so Regenerate is repeatable --------
    // RNG state lives on the current engine (_E.rng) so each instance has its
    // own repeatable stream and the two engines don't perturb each other.
    function _ambSeed(s) { _E.rng = (s >>> 0) || 1; }
    function _ambRand() {
      let r = _E.rng | 0; r = (r + 0x6D2B79F5) | 0;
      let t = Math.imul(r ^ (r >>> 15), 1 | r);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      _E.rng = r;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // ---- Pitch material ------------------------------------------------
    // Each layer may carry its own `scale`; '' (or unknown) follows the
    // workspace currentScale. The root stays the workspace root.
    // ---- Time-indexed key (keyMaster Seq sections) ---------------------------
    // A keyMaster Seq pushes {at, root, scale} at each section boundary; the
    // generative layers resolve the key effective at EACH note's own play time
    // (via _ambKeyTime, stamped per note), so they flip exactly on the boundary
    // with NO rescheduling/cancellation. _ambKeyAt returns null when no schedule
    // is active, so everything falls back to the normal cfg/global key.
    let _ambKeyTime = null;
    function _ambKeyAt(E, t) {
      const sched = E && E._keySched;
      if (!Array.isArray(sched) || !sched.length || !Number.isFinite(t)) return null;
      let best = null;
      for (let i = 0; i < sched.length; i++) { const e = sched[i]; if (e.at <= t && (!best || e.at >= best.at)) best = e; }
      return best; // {at, root, scale} or null when t precedes the first boundary
    }
    function _ambKeySchedPush(E, at, root, scale) {
      if (!E || !Number.isFinite(at)) return;
      if (!Array.isArray(E._keySched)) E._keySched = [];
      const last = E._keySched[E._keySched.length - 1];
      if (last && last.root === root && last.scale === scale) return;   // no key change
      E._keySched.push({ at, root, scale, applied: false });
      const cut = ((typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0) - 4;
      while (E._keySched.length > 3 && E._keySched[0].at < cut) E._keySched.shift();
    }
    function _ambResolveScale(scale) {
      if (typeof scale === 'string' && scale && typeof SCALES !== 'undefined' && SCALES[scale]) return scale;
      // Time-indexed (keyMaster section) key takes precedence for the note now
      // being computed, so generative layers re-color exactly on the boundary.
      if (_ambKeyTime != null) {
        const ks = _ambKeyAt(_E, _ambKeyTime);
        if (ks && ks.scale && typeof SCALES !== 'undefined' && SCALES[ks.scale]) return ks.scale;
      }
      // When the Bloom's own Key mode is on, generative layers follow the Key
      // SCALE (not just its root) — so a separate Bloom key actually re-colors
      // them major↔minor↔etc.
      const kc = _ambKeyCfg();
      if (kc && kc.keyOn && typeof kc.keyScale === 'string' && typeof SCALES !== 'undefined' && SCALES[kc.keyScale]) return kc.keyScale;
      return (typeof currentScale === 'string') ? currentScale : 'chromatic';
    }
    // ---- Note source ("Notes" menu) ------------------------------------
    // A layer's pitch material is a descriptor `{ type, ... }`. Phase 1:
    //   { type:'scale', scale:'<name>'|'' }                (''/missing = workspace scale)
    //   { type:'chord', form:'maj7', root:0..11, inversion:0..n }
    // Legacy layers store a bare `scale` string — _ambNotesOf migrates it.
    const _AMB_CHORD_FORMS = [
      ['maj', 'Major', [0, 4, 7]], ['min', 'Minor', [0, 3, 7]],
      ['dom7', 'Dom 7', [0, 4, 7, 10]], ['maj7', 'Maj 7', [0, 4, 7, 11]],
      ['min7', 'Min 7', [0, 3, 7, 10]], ['m7b5', 'Min7♭5', [0, 3, 6, 10]],
      ['dim7', 'Dim 7', [0, 3, 6, 9]], ['aug', 'Aug', [0, 4, 8]],
      ['sus2', 'Sus2', [0, 2, 7]], ['sus4', 'Sus4', [0, 5, 7]],
      ['add9', 'Add 9', [0, 2, 4, 7]], ['maj9', 'Maj 9', [0, 2, 4, 7, 11]],
      ['min9', 'Min 9', [0, 2, 3, 7, 10]],
    ];
    function _ambAsNotes(x) {
      if (x && typeof x === 'object' && typeof x.type === 'string') return x;
      return { type: 'scale', scale: (typeof x === 'string') ? x : '' };
    }
    function _ambNotesOf(layer) {
      if (layer && layer.notes && typeof layer.notes === 'object' && typeof layer.notes.type === 'string') return layer.notes;
      return { type: 'scale', scale: (layer && typeof layer.scale === 'string') ? layer.scale : '' };
    }
    function _ambChordIntervals(form, inversion) {
      const def = _AMB_CHORD_FORMS.find(c => c[0] === form) || _AMB_CHORD_FORMS[0];
      let iv = Array.from(new Set(def[2].map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b);
      const inv = Math.max(0, Math.min(iv.length - 1, inversion | 0));
      for (let i = 0; i < inv; i++) iv.push(iv.shift()); // rotate → bias the bass tone
      return iv;
    }
    // Published wraps live on the master Bloom config (shared registry); both
    // master + lane Notes menus read from there.
    function _ambFindWrap(id) {
      const arr = (masterAmbient && Array.isArray(masterAmbient.publishedWraps)) ? masterAmbient.publishedWraps : [];
      return arr.find(w => w && w.id === id) || null;
    }
    // Per-layer progression override: when set (by a layer's emit to its own loop
    // index), a progression advances ONE chord per that layer's unit/loop — so the
    // unit IS a chord and prog layers stay in lockstep. null → the global clock.
    let _ambProgStepOverride = null;
    // The current chord of a progression note source. Uses the per-layer override
    // when active, else the shared global step (_E.progStep, ~progRate).
    function _ambProgCurrentChord(n) {
      const chs = Array.isArray(n.chords) ? n.chords : [];
      if (!chs.length) return null;
      const step = (_ambProgStepOverride != null) ? (_ambProgStepOverride | 0)
        : ((_E && Number.isFinite(_E.progStep)) ? (_E.progStep | 0) : 0);
      return chs[((step % chs.length) + chs.length) % chs.length] || null;
    }
    // ---- Instance "Key" -------------------------------------------------
    // Read the current engine's (already-normalized) cfg cheaply: the tick
    // caches it on E._cfg, so generation reads keyOn/keyRoot without a fresh
    // normalize. Returns null off the audio path (UI-only calls fall through).
    function _ambKeyCfg() {
      try { return (_E && (_E._cfg || (typeof _E.getCfg === 'function' && _E.getCfg()))) || null; } catch (e) { return null; }
    }
    function _ambKeyRootPc(cfg) {
      const c = cfg || _ambKeyCfg();
      return c ? ((((c.keyRoot | 0) % 12) + 12) % 12) : 0;
    }
    function _ambKeyScaleName(cfg) {
      const c = cfg || _ambKeyCfg();
      const q = (c && typeof c.keyScale === 'string' && c.keyScale) ? c.keyScale : 'major';
      return (typeof SCALES !== 'undefined' && SCALES[q]) ? q : 'major';
    }
    // Absolute pitch-class Set of the key's own scale, rooted at keyRoot.
    function _ambKeyDiatonicPcs(cfg) {
      const c = cfg || _ambKeyCfg();
      const root = _ambKeyRootPc(c);
      const iv = (typeof SCALES !== 'undefined' && SCALES[_ambKeyScaleName(c)]) || [0, 2, 4, 5, 7, 9, 11];
      const s = new Set();
      iv.forEach(x => s.add((((root + x) % 12) + 12) % 12));
      return s;
    }
    // Modal-interchange "borrowing pool": the parallel major ∪ parallel natural
    // minor rooted at keyRoot — the standard set a key can borrow chords from
    // (covers iv, ♭III, ♭VI, ♭VII, Picardy III, etc.). Excludes only ♭2 and the
    // bare tritone, which the ≤1-passing-tone rule still admits as single tones.
    function _ambKeyExtendedPcs(cfg) {
      const c = cfg || _ambKeyCfg();
      const root = _ambKeyRootPc(c);
      const pools = [
        (typeof SCALES !== 'undefined' && SCALES['major']) || [0, 2, 4, 5, 7, 9, 11],
        (typeof SCALES !== 'undefined' && SCALES['minor']) || [0, 2, 3, 5, 7, 8, 10],
      ];
      const s = new Set();
      pools.forEach(iv => iv.forEach(x => s.add((((root + x) % 12) + 12) % 12)));
      return s;
    }
    // Does a set of ABSOLUTE pitch classes "work in the key"? Allowed when every
    // tone is diatonic/borrowed (in the interchange pool), OR it strays by at
    // most one chromatic passing tone (covers secondary dominants, Lydian ♯4,
    // bluesy ♭5, etc.). keyOff → everything works (no constraint).
    function _ambPcsWorkInKey(pcs, cfg) {
      const c = cfg || _ambKeyCfg();
      if (!c || !c.keyOn) return true;
      const D = _ambKeyDiatonicPcs(c), E = _ambKeyExtendedPcs(c);
      let allInE = true, foreign = 0;
      (pcs || []).forEach(p => { p = (((p % 12) + 12) % 12); if (!E.has(p)) allInE = false; if (!D.has(p)) foreign++; });
      return allInE || foreign <= 1;
    }
    function _ambScalePcs(name, root) {
      const iv = (typeof SCALES !== 'undefined' && SCALES[name]) ? SCALES[name] : [0, 2, 4, 5, 7, 9, 11];
      return iv.map(x => (((root + x) % 12) + 12) % 12);
    }
    function _ambChordPcsOf(form, root) {
      return _ambChordIntervals(form, 0).map(x => (((root + x) % 12) + 12) % 12);
    }
    // A scale name rooted at the KEY tonic (scales play at keyRoot in key mode).
    function _ambScaleWorksInKey(name, cfg) {
      const c = cfg || _ambKeyCfg();
      return _ambPcsWorkInKey(_ambScalePcs(_ambResolveScale(name), _ambKeyRootPc(c)), c);
    }
    function _ambChordWorksInKey(form, root, cfg) {
      return _ambPcsWorkInKey(_ambChordPcsOf(form, root), cfg);
    }
    // Classify a chord against the key: 'diatonic' | 'borrowed' | 'passing' | null
    // (null = doesn't work / shouldn't be offered).
    function _ambChordKeyClass(form, root, cfg) {
      const c = cfg || _ambKeyCfg();
      if (!c || !c.keyOn) return 'diatonic';
      const D = _ambKeyDiatonicPcs(c), E = _ambKeyExtendedPcs(c);
      const pcs = _ambChordPcsOf(form, root);
      let allInD = true, allInE = true, foreign = 0;
      pcs.forEach(p => { if (!D.has(p)) { allInD = false; foreign++; } if (!E.has(p)) allInE = false; });
      if (allInD) return 'diatonic';
      if (allInE) return 'borrowed';
      if (foreign <= 1) return 'passing';
      return null;
    }
    function _ambWrapWorksInKey(w, cfg) {
      if (!w || !Array.isArray(w.intervals)) return true;
      const root = ((((w.root | 0) % 12) + 12) % 12);
      return _ambPcsWorkInKey(w.intervals.map(x => (((root + x) % 12) + 12) % 12), cfg);
    }
    // Transpose offset that maps a progression's reference tonic (its first
    // chord's root) onto keyRoot, so the whole progression is rooted in the key
    // while keeping its relative chord motion.
    function _ambProgKeyOffset(n, keyRoot) {
      const chs = Array.isArray(n.chords) ? n.chords : [];
      const ref = (chs[0] && Number.isFinite(chs[0].root)) ? (((chs[0].root % 12) + 12) % 12) : 0;
      return (((keyRoot - ref) % 12) + 12) % 12;
    }
    function _ambProgWorksInKey(n, cfg) {
      const c = cfg || _ambKeyCfg();
      if (!c || !c.keyOn) return true;
      const chs = Array.isArray(n.chords) ? n.chords : [];
      if (!chs.length) return true;
      const off = _ambProgKeyOffset(n, _ambKeyRootPc(c));
      return chs.every(ch => {
        const r = (((((ch.root | 0) + off) % 12) + 12) % 12);
        const iv = Array.isArray(ch.intervals) ? ch.intervals : [0, 4, 7];
        return _ambPcsWorkInKey(iv.map(x => (((r + x) % 12) + 12) % 12), c);
      });
    }
    // Interval set for a note source. Chord/Wrap/Prog → pitch-class set; scale → SCALES.
    // Key mode does NOT alter tones here (no conforming): the Notes menu only
    // offers material that already fits, so borrowed chords / passing tones play
    // true. The key's runtime effect is purely re-rooting (see _ambSrcRootPc).
    // Effective intervals of a custom-edited chord: its raw `intervals` minus any
    // in `muted` (never empty — a fully-muted chord falls back to its full set).
    function _ambChordEffIntervals(o) {
      if (!o || !Array.isArray(o.intervals) || !o.intervals.length) return null;
      const m = Array.isArray(o.muted) ? o.muted : [];
      const eff = o.intervals.filter(iv => m.indexOf(iv) < 0);
      return eff.length ? eff : o.intervals.slice();
    }
    function _ambScaleIntervals(src) {
      const n = _ambAsNotes(src);
      if (n.type === 'chord') { const eff = _ambChordEffIntervals(n); return eff || _ambChordIntervals(n.form, n.inversion); }
      if (n.type === 'wrap') { const w = _ambFindWrap(n.id); return (w && Array.isArray(w.intervals) && w.intervals.length) ? w.intervals : [0, 4, 7]; }
      if (n.type === 'prog') { const ch = _ambProgCurrentChord(n); const eff = ch && _ambChordEffIntervals(ch); return eff || ((ch && Array.isArray(ch.intervals) && ch.intervals.length) ? ch.intervals : [0, 4, 7]); }
      const name = _ambResolveScale(n.scale);
      return (typeof SCALES !== 'undefined' && SCALES[name]) ? SCALES[name] : [0, 2, 4, 5, 7, 9, 11];
    }
    function _ambSrcRootPc(src) {
      const n = _ambAsNotes(src);
      const kc = _ambKeyCfg();
      const keyOn = !!(kc && kc.keyOn);
      const keyRoot = keyOn ? _ambKeyRootPc(kc) : 0;
      // Chords & wraps keep their OWN root in key mode, so degrees (IV, vi) and
      // borrowed chords (♭VI, ♭VII) play on their real roots.
      if (n.type === 'chord' && Number.isFinite(n.root)) return ((n.root % 12) + 12) % 12;
      if (n.type === 'wrap') { const w = _ambFindWrap(n.id); if (w && Number.isFinite(w.root)) return ((w.root % 12) + 12) % 12; }
      // Progressions transpose so their tonic = keyRoot (relative motion kept).
      if (n.type === 'prog') {
        const ch = _ambProgCurrentChord(n);
        let r = (ch && Number.isFinite(ch.root)) ? (((ch.root % 12) + 12) % 12) : ((typeof rootIdx === 'number') ? rootIdx : 0);
        if (keyOn) r = ((r + _ambProgKeyOffset(n, keyRoot)) % 12 + 12) % 12;
        return r;
      }
      // Scales root to the key tonic. Time-indexed (keyMaster section) key first,
      // so a scale re-roots exactly on the boundary for the note now computed.
      if (_ambKeyTime != null) { const ks = _ambKeyAt(_E, _ambKeyTime); if (ks) return (((ks.root | 0) % 12) + 12) % 12; }
      if (keyOn) return keyRoot;
      return (typeof rootIdx === 'number') ? rootIdx : 0;
    }
    // Human label for the Notes button.
    function _ambNotesLabel(src) {
      const n = _ambAsNotes(src);
      if (n.type === 'chord') {
        const rootName = (typeof CHROMATIC !== 'undefined' && CHROMATIC[((n.root % 12) + 12) % 12]) || '';
        // Custom-edited chord (raw intervals): show note count, not a form name.
        if (Array.isArray(n.intervals) && n.intervals.length) {
          const eff = _ambChordEffIntervals(n) || n.intervals;
          return rootName + ' chord ✎ (' + eff.length + ')';
        }
        const def = _AMB_CHORD_FORMS.find(c => c[0] === n.form);
        const invTxt = (n.inversion | 0) > 0 ? ' inv' + (n.inversion | 0) : '';
        return rootName + ' ' + (def ? def[1] : 'Chord') + invTxt;
      }
      if (n.type === 'wrap') { const w = _ambFindWrap(n.id); return '⊕ ' + (w ? w.name : 'Wrap'); }
      if (n.type === 'prog') return '⇶ ' + (n.name || 'Progression');
      return n.scale ? (typeof prettyScaleName === 'function' ? prettyScaleName(n.scale) : n.scale) : 'Scale';
    }
    // Publish a wrap (saved-bank entry) to the master Bloom Notes registry as a
    // pitch-class set: collect its notes' pitch classes, store as {root,intervals}
    // (root + intervals reconstruct the exact pc set). Returns the new entry.
    function _ambPublishWrap(name, step) {
      let freqs = [];
      try { freqs = (typeof collectStepFreqs === 'function') ? (collectStepFreqs(step) || []) : []; } catch (e) {}
      const pcs = [], seen = new Set();
      freqs.forEach(f => {
        const m = (typeof _freqToMidi === 'function') ? _freqToMidi(f) : null;
        if (m == null) return;
        const pc = ((Math.round(m) % 12) + 12) % 12;
        if (!seen.has(pc)) { seen.add(pc); pcs.push(pc); }
      });
      if (!pcs.length) return null;
      const root = Math.min.apply(null, pcs);
      const intervals = Array.from(new Set(pcs.map(p => (((p - root) % 12) + 12) % 12))).sort((a, b) => a - b);
      masterAmbient = masterAmbient || _defaultAmbientConfig();
      if (!Array.isArray(masterAmbient.publishedWraps)) masterAmbient.publishedWraps = [];
      const id = masterAmbient.publishedWraps.reduce((m, w) => Math.max(m, w.id | 0), 0) + 1;
      const entry = { id, name: name || ('Wrap ' + id), root, intervals };
      masterAmbient.publishedWraps.push(entry);
      if (typeof persistWorkspace === 'function') persistWorkspace();
      return entry;
    }
    // ---- Progressions (Notes ▸ Progression) ---------------------------------
    // Curated standards (resolved against the workspace root on selection).
    const _AMB_PROG_STANDARDS = [
      ['I–IV–V', 'major', [[1, 'maj'], [4, 'maj'], [5, 'maj']]],
      ['I–V–vi–IV', 'major', [[1, 'maj'], [5, 'maj'], [6, 'min'], [4, 'maj']]],
      ['I–vi–IV–V', 'major', [[1, 'maj'], [6, 'min'], [4, 'maj'], [5, 'maj']]],
      ['ii–V–I (jazz)', 'major', [[2, 'min7'], [5, '7'], [1, 'maj7']]],
      ['Pachelbel', 'major', [[1, 'maj'], [5, 'maj'], [6, 'min'], [3, 'min'], [4, 'maj'], [1, 'maj'], [4, 'maj'], [5, 'maj']]],
      ['12-bar blues', 'major', [[1, '7'], [1, '7'], [1, '7'], [1, '7'], [4, '7'], [4, '7'], [1, '7'], [1, '7'], [5, '7'], [4, '7'], [1, '7'], [5, '7']]],
      ['i–iv–v', 'minor', [[1, 'min'], [4, 'min'], [5, 'min']]],
      ['i–VI–VII', 'minor', [[1, 'min'], [6, 'maj'], [7, 'maj']]],
      ['Andalusian', 'minor', [[1, 'min'], [7, 'maj'], [6, 'maj'], [5, 'maj']]],
      ['i–VI–iv–V', 'minor', [[1, 'min'], [6, 'maj'], [4, 'min'], [5, 'maj']]],
    ];
    // PROG blocks ({chordRoot, chordQuality}) → [{ root, intervals }].
    function _ambProgChordsFromBlocks(blocks) {
      return (blocks || []).map(b => {
        const def = (typeof CHORDS !== 'undefined') ? CHORDS[b.chordQuality] : null;
        const iv = (def && Array.isArray(def.semis)) ? def.semis : [0, 4, 7];
        const intervals = Array.from(new Set(iv.map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b);
        return { root: (((b.chordRoot | 0) % 12) + 12) % 12, intervals };
      });
    }
    function _ambResolveStandard(family, steps) {
      const root = (typeof rootIdx === 'number') ? rootIdx : 0;
      let blocks = [];
      try { if (typeof _progAutoFillProgression === 'function') blocks = _progAutoFillProgression(root, family, { steps }); } catch (e) {}
      return _ambProgChordsFromBlocks(blocks);
    }
    function _ambPublishProg(name, blocks) {
      const chords = _ambProgChordsFromBlocks(blocks);
      if (!chords.length) return null;
      masterAmbient = masterAmbient || _defaultAmbientConfig();
      if (!Array.isArray(masterAmbient.publishedProgs)) masterAmbient.publishedProgs = [];
      const id = masterAmbient.publishedProgs.reduce((m, p) => Math.max(m, p.id | 0), 0) + 1;
      const entry = { id, name: name || ('Prog ' + id), chords };
      masterAmbient.publishedProgs.push(entry);
      if (typeof persistWorkspace === 'function') persistWorkspace();
      return entry;
    }
    function _ambNoteFreq(intervalSemi, octave, src) {
      const notes = _ambAsNotes(src);
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const root = _ambSrcRootPc(notes);
      const pc = (((root + intervalSemi) % 12) + 12) % 12;
      const midi = 12 * (octave + 1) + pc;
      let freq = A * Math.pow(2, (midi - 69) / 12);
      try {
        // Microtuning applies to scales only (chords/wraps/progs are equal-tempered).
        if (notes.type === 'scale' || !notes.type) {
          const sName = _ambResolveScale(notes.scale);
          if (typeof MICRO_TUNINGS !== 'undefined' && MICRO_TUNINGS[sName]) {
            const micro = MICRO_TUNINGS[sName];
            const tonic = (typeof _effectiveScaleTonic === 'function') ? _effectiveScaleTonic() : root;
            const deg = (((pc - tonic) % 12) + 12) % 12;
            const dev = (micro[deg] || 0) - deg * 100;
            if (dev) freq *= Math.pow(2, dev / 1200);
          }
        }
      } catch (e) {}
      return freq;
    }
    function _ambDegreeFreq(deg, octave, src) {
      const intervals = _ambScaleIntervals(src);
      const N = intervals.length;
      const d = ((deg % N) + N) % N;
      return _ambNoteFreq(intervals[d], octave, src);
    }
    // Sanitize a layer's saved `notes` descriptor (no-op for legacy scale-string
    // layers — _ambNotesOf migrates those on the fly).
    function _ambNormalizeNotes(layer) {
      const n = layer && layer.notes;
      if (!n || typeof n !== 'object') return;
      if (n.type === 'chord') {
        if (!_AMB_CHORD_FORMS.find(c => c[0] === n.form)) n.form = 'maj';
        if (!Number.isFinite(n.root)) n.root = (typeof rootIdx === 'number') ? rootIdx : 0;
        n.root = ((n.root % 12) + 12) % 12;
        n.inversion = Math.max(0, n.inversion | 0);
      } else if (n.type === 'wrap') {
        if (!Number.isFinite(n.id)) layer.notes = { type: 'scale', scale: '' };
      } else if (n.type === 'prog') {
        if (!Array.isArray(n.chords) || !n.chords.length) layer.notes = { type: 'scale', scale: '' };
      } else {
        n.type = 'scale';
        if (typeof n.scale !== 'string') n.scale = '';
      }
    }
    // ---- "Notes" control: a button that opens a Scale / Chord menu ----------
    function _ambNotesButtonHtml(prefix) {
      return '<div class="ambient-ctrl"><label>Notes</label>' +
        '<button type="button" id="' + prefix + '-notes" class="ambient-select ambient-notes-btn">Scale</button>' +
        '<span class="ambient-hint">source</span></div>';
    }
    function _ambOpenNotesMenu(E, getLayer, x, y, afterChange) {
      if (typeof showCtxMenu !== 'function') return;
      _E = E;
      const kcfg = E.getCfg();
      const keyOn = !!(kcfg && kcfg.keyOn);
      const keyTag = keyOn ? (' — in ' + ((typeof CHROMATIC !== 'undefined' && CHROMATIC[_ambKeyRootPc(kcfg)]) || '') + ' ' + _ambKeyScaleName(kcfg)) : '';
      const apply = (notes) => {
        _E = E; const L = getLayer(); if (!L) return;
        L.notes = notes;
        if (typeof afterChange === 'function') afterChange();
        if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
        if (typeof persistWorkspace === 'function') persistWorkspace();
      };
      const scaleSub = () => {
        const items = [];
        try {
          const tmp = document.createElement('select');
          populateGroupedScaleSelect(tmp, { value: '', label: 'Workspace scale' });
          Array.from(tmp.children).forEach(node => {
            if (node.tagName === 'OPTGROUP') {
              const kids = Array.from(node.children).filter(o => !keyOn || _ambScaleWorksInKey(o.value, kcfg));
              if (!kids.length) return;
              items.push({ label: node.label, disabled: true });
              kids.forEach(o => items.push({ label: '  ' + o.textContent, fn: () => apply({ type: 'scale', scale: o.value }) }));
            } else {
              if (keyOn && !_ambScaleWorksInKey(node.value, kcfg)) return;
              items.push({ label: node.textContent, fn: () => apply({ type: 'scale', scale: node.value }) });
            }
          });
        } catch (e) {}
        if (!items.length) items.push({ label: 'No scales fit this key', disabled: true });
        showCtxMenu(x, y, items);
      };
      const wrapSub = () => {
        let wraps = (masterAmbient && Array.isArray(masterAmbient.publishedWraps)) ? masterAmbient.publishedWraps : [];
        if (keyOn) wraps = wraps.filter(w => _ambWrapWorksInKey(w, kcfg));
        if (!wraps.length) {
          showCtxMenu(x, y, keyOn
            ? [{ label: 'No published wraps fit this key', disabled: true }]
            : [{ label: 'No published wraps', disabled: true }, { label: 'Right-click a wrap chip → Publish to Bloom', disabled: true }]);
          return;
        }
        showCtxMenu(x, y, wraps.map(w => ({ label: '⊕ ' + w.name, fn: () => apply({ type: 'wrap', id: w.id }) })));
      };
      const progSub = () => {
        const items = [{ label: 'Standards', disabled: true }];
        _AMB_PROG_STANDARDS.forEach(([nm, fam, steps]) => {
          const chords = _ambResolveStandard(fam, steps);
          if (keyOn && !_ambProgWorksInKey({ chords }, kcfg)) return;
          items.push({ label: '  ' + nm, fn: () => apply({ type: 'prog', name: nm, chords }) });
        });
        const pub = (masterAmbient && Array.isArray(masterAmbient.publishedProgs)) ? masterAmbient.publishedProgs : [];
        if (pub.length) {
          const pubItems = [];
          pub.forEach(p => {
            const chords = (p.chords || []).map(c => ({ root: c.root, intervals: c.intervals }));
            if (keyOn && !_ambProgWorksInKey({ chords }, kcfg)) return;
            pubItems.push({ label: '  ' + p.name, fn: () => apply({ type: 'prog', name: p.name, chords }) });
          });
          if (pubItems.length) { items.push('hr', { label: 'Published', disabled: true }); pubItems.forEach(i => items.push(i)); }
        }
        if (items.length <= 1) items.push({ label: 'No progressions fit this key', disabled: true });
        showCtxMenu(x, y, items);
      };
      showCtxMenu(x, y, [
        (keyTag ? { label: 'Key' + keyTag, disabled: true } : null),
        { label: 'Scale ▸', fn: () => setTimeout(scaleSub, 0) },
        { label: '♪ Chord…', fn: () => _ambOpenChordPicker(E, getLayer, afterChange) },
        { label: '⊕ Wraps ▸', fn: () => setTimeout(wrapSub, 0) },
        { label: '⇶ Progression ▸', fn: () => setTimeout(progSub, 0) },
      ].filter(Boolean));
    }
    function _ambOpenChordPicker(E, getLayer, afterChange) {
      _E = E;
      const L = getLayer(); if (!L) return;
      const kcfg = E.getCfg();
      const keyOn = !!(kcfg && kcfg.keyOn);
      const curN = _ambNotesOf(L);
      const cur = (curN.type === 'chord') ? curN : { form: 'maj', root: (typeof rootIdx === 'number') ? rootIdx : 0, inversion: 0 };
      const CHROM = (typeof CHROMATIC !== 'undefined') ? CHROMATIC : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const ordinal = (i) => i === 0 ? 'Root' : (i === 1 ? '1st' : i === 2 ? '2nd' : i === 3 ? '3rd' : i + 'th');
      const invOptsFor = (form, sel) => {
        const def = _AMB_CHORD_FORMS.find(c => c[0] === form) || _AMB_CHORD_FORMS[0];
        return def[2].map((_, i) => '<option value="' + i + '"' + (i === (sel | 0) ? ' selected' : '') + '>' + ordinal(i) + '</option>').join('');
      };
      // Root <option>s. Key off → all 12. Key on → only roots where this form
      // works, grouped In key / Borrowed / Color (passing).
      const rootOptsFor = (form, selRoot) => {
        if (!keyOn) return CHROM.map((nm, i) => '<option value="' + i + '"' + (i === (selRoot | 0) ? ' selected' : '') + '>' + nm + '</option>').join('');
        const groups = { diatonic: [], borrowed: [], passing: [] };
        for (let i = 0; i < 12; i++) { const cls = _ambChordKeyClass(form, i, kcfg); if (cls && groups[cls]) groups[cls].push(i); }
        const valid = groups.diatonic.concat(groups.borrowed, groups.passing);
        const sel = (valid.indexOf(selRoot | 0) >= 0) ? (selRoot | 0) : (valid.length ? valid[0] : (selRoot | 0));
        const lbl = { diatonic: 'In key', borrowed: 'Borrowed', passing: 'Color (passing)' };
        let html = '';
        ['diatonic', 'borrowed', 'passing'].forEach(k => {
          if (!groups[k].length) return;
          html += '<optgroup label="' + lbl[k] + '">' +
            groups[k].map(i => '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + CHROM[i] + '</option>').join('') + '</optgroup>';
        });
        if (!html) html = '<option value="' + (selRoot | 0) + '">' + CHROM[(selRoot | 0) % 12] + '</option>';
        return html;
      };
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const modal = document.createElement('div'); modal.className = 'step-div-modal amb-chord-modal';
      modal.innerHTML = '<div class="keep-sdiv-title">Chord' + (keyOn ? ' · ' + ((CHROM[_ambKeyRootPc(kcfg)]) || '') + ' ' + _ambKeyScaleName(kcfg) + ' key' : '') + '</div>' +
        '<div class="keep-sdiv-row"><span class="keep-sdiv-name">Form</span><select id="amb-chord-form" class="sm-select">' +
          _AMB_CHORD_FORMS.map(c => '<option value="' + c[0] + '"' + (c[0] === cur.form ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select></div>' +
        '<div class="keep-sdiv-row"><span class="keep-sdiv-name">Root</span><select id="amb-chord-root" class="sm-select">' +
          rootOptsFor(cur.form, cur.root) + '</select></div>' +
        '<div class="keep-sdiv-row"><span class="keep-sdiv-name">Inversion</span><select id="amb-chord-inv" class="sm-select">' + invOptsFor(cur.form, cur.inversion) + '</select></div>' +
        '<div class="keep-sdiv-actions"><button type="button" class="keep-sdiv-apply" id="amb-chord-apply">Apply</button></div>';
      overlay.appendChild(modal); document.body.appendChild(overlay);
      const formSel = modal.querySelector('#amb-chord-form');
      const rootSel = modal.querySelector('#amb-chord-root');
      const invSel = modal.querySelector('#amb-chord-inv');
      formSel.addEventListener('change', () => {
        const keep = parseInt(rootSel.value, 10) || 0;
        rootSel.innerHTML = rootOptsFor(formSel.value, keep);
        invSel.innerHTML = invOptsFor(formSel.value, 0);
      });
      modal.querySelector('#amb-chord-apply').addEventListener('click', () => {
        _E = E; const layer = getLayer();
        if (layer) {
          layer.notes = {
            type: 'chord', form: formSel.value,
            root: parseInt(modal.querySelector('#amb-chord-root').value, 10) || 0,
            inversion: parseInt(invSel.value, 10) || 0,
          };
          if (typeof afterChange === 'function') afterChange();
          if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
          if (typeof persistWorkspace === 'function') persistWorkspace();
        }
        overlay.remove();
      });
      requestAnimationFrame(() => overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); }));
    }
    function _ambWireNotesBtn(E, btnId, getLayer) {
      const btn = _ambGet(E, btnId);
      if (!btn) return;
      const refresh = () => { const L = getLayer(); if (L) btn.textContent = _ambNotesLabel(_ambNotesOf(L)); };
      refresh();
      btn.addEventListener('click', () => {
        const r = btn.getBoundingClientRect();
        _ambOpenNotesMenu(E, getLayer, r.left, r.bottom + 4, refresh);
      });
    }

    // ---- Space (stereo distribution) -----------------------------------
    // For a chord of N notes (sorted), returns each note's pan (-100..100).
    //   space 0   → all 0 (centred)
    //   space 100 → first half full-left, last half full-right, odd middle 0
    //   between   → even spread converging to that split:
    //               pan_i = s·((1−s)·even_i + s·bimodal_i)
    function _ambSpacePans(n, spacePct) {
      const s = Math.max(0, Math.min(100, spacePct)) / 100;
      const out = [];
      const half = Math.floor(n / 2);
      for (let i = 0; i < n; i++) {
        const even = (n <= 1) ? 0 : (i / (n - 1)) * 2 - 1;
        let bimodal;
        if (n <= 1) bimodal = 0;
        else if (i < half) bimodal = -1;
        else if (i >= n - half) bimodal = 1;
        else bimodal = 0; // odd middle
        out.push(Math.round(s * ((1 - s) * even + s * bimodal) * 100));
      }
      return out;
    }
    // Per-layer stereo placement (replaces the old single global `space`).
    // Each layer carries `panMode` + `space`: in 'spread' mode `space` is a
    // 0..100 WIDTH (voices fan across the field — deterministic for chords /
    // slices, random ± for single hits); in 'pan' mode `space` is a -100..100
    // POSITION (every voice sits at one fixed L/R spot).
    function _ambLayerSpace(layer) {
      return (layer && Number.isFinite(layer.space)) ? (layer.space | 0) : 0;
    }
    // Pan array for an n-voice event (bed voicings, sample slices, seq notes).
    function _ambLayerPans(layer, n) {
      const val = _ambLayerSpace(layer);
      if (layer && layer.panMode === 'pan') {
        const p = Math.max(-100, Math.min(100, val));
        const out = []; for (let i = 0; i < n; i++) out.push(p); return out;
      }
      return _ambSpacePans(n, Math.max(0, Math.min(100, val)));
    }
    // Single pan for a one-shot event (motif note, texture/beat hit).
    function _ambLayerPan(layer) {
      const val = _ambLayerSpace(layer);
      if (layer && layer.panMode === 'pan') return Math.max(-100, Math.min(100, val));
      return Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, val)));
    }

    // ---- Timing helpers ------------------------------------------------
    function _ambBpm() {
      const v = (typeof tempoInput !== 'undefined' && tempoInput) ? parseInt(tempoInput.value, 10) : 120;
      return Math.max(20, v || 120);
    }
    function _ambStepSec() {
      const sub = (typeof stepSubdivision === 'number' && stepSubdivision > 0) ? stepSubdivision : 0.5;
      return (60 / _ambBpm()) * sub;
    }
    // Quantize a free interval (seconds) to whole steps in Sync mode.
    function _ambSnap(sec, cfg) {
      if (cfg.timing !== 'sync') return sec;
      const step = _ambStepSec();
      return Math.max(step, Math.round(sec / step) * step);
    }
    // Beat "Rate" — express a layer's speed as a note division of the GLOBAL
    // BPM instead of a fixed millisecond Interval. The value is beats-per-event
    // (quarter note = 1 beat). When a layer carries a `rate`, its interval is
    // derived live from the global tempo (so changing BPM scales it), and the
    // ms Interval slider is ignored. Empty/unknown rate → fall back to Interval.
    const _AMB_RATES = { '1/1': 4, '1/2': 2, '1/4': 1, '1/4T': 2 / 3, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125 };
    function _ambRateBeats(rate) { return (rate && _AMB_RATES[rate]) ? _AMB_RATES[rate] : 0; }
    // Effective interval (sec) for a layer, honoring `rate` first, else Interval
    // (snapped to the step grid in global Sync mode via _ambSnap).
    function _ambStepSecFor(lc, minSec, cfg) {
      const b = _ambRateBeats(lc && lc.rate);
      if (b > 0) return Math.max(minSec || 0.02, b * (60 / _ambBpm()));
      return _ambSnap(Math.max(minSec || 0.05, (lc.intervalMs | 0) / 1000), cfg);
    }
    // Raw effective interval (sec), no step-snap — for drift phase + playheads.
    function _ambEffIntervalSec(lc) {
      const b = _ambRateBeats(lc && lc.rate);
      return b > 0 ? b * (60 / _ambBpm()) : Math.max(0.05, ((lc && lc.intervalMs) | 0) / 1000);
    }
    // Per-layer Level (0..100): 70 = the layer's tuned default (unchanged from
    // before). 0..70 attenuates that toward silence; 70..100 BOOSTS the layer's
    // pre-staged volume up toward a full grid-press voice (100), so at the slider
    // max the layer sits at grid-cell loudness. Bloom layers are deliberately
    // staged below grid level for polyphony headroom; this upper ramp lets you
    // push any layer back up to that level when you want it — capped at 100 so a
    // single voice can never exceed full velocity.
    function _ambApplyLevel(vol, level) {
      const base = vol || 0;
      const L = Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 70;
      if (L <= 70) return Math.max(0, Math.round(base * (L / 70)));
      const t = (L - 70) / 30; // 0 at the default, 1 at the slider max
      return Math.max(0, Math.min(100, Math.round(base + (100 - base) * t)));
    }
    // Stochastic Accent (0..100): randomly widen a layer's note-to-note
    // dynamics. 0 = flat (every note at its level). As it rises, more notes pop
    // louder and a few drop to ghost-notes, so the line breathes. Per-note call.
    function _ambAccentVol(vol, accent) {
      const a = Math.max(0, Math.min(100, accent | 0)) / 100;
      if (a <= 0) return vol;
      const r = _ambRand();
      if (r < a * 0.45) return Math.max(0, Math.min(100, Math.round(vol * (1 + a * 0.6))));   // accented
      if (r > 1 - a * 0.22) return Math.max(0, Math.round(vol * (1 - a * 0.4)));               // ghost
      return vol;
    }
    // Per-layer Drift (0..99): phase-offset the layer's event grid by that
    // fraction of its Interval (snapped to the step grid in Sync mode).
    function _ambDriftOffset(layer, cfg) {
      const drift = Number.isFinite(layer.drift) ? Math.max(0, Math.min(99, layer.drift)) : 0;
      if (drift <= 0) return 0;
      const intervalSec = _ambEffIntervalSec(layer);
      let off = (drift / 100) * intervalSec;
      if (cfg && cfg.timing === 'sync') {
        const step = _ambStepSec();
        off = Math.round(off / step) * step;
      }
      return off;
    }
    // Per-layer When (per-event conditional): mirrors the Grid step `cond`.
    // 'always'/unset → fire every event; '1st' → only the layer's first event;
    // 'A:B' → fire on event A of every B (1-based, e.g. '1:2' = events 1,3,5…).
    function _ambCondFires(cond, iter) {
      if (cond == null || cond === 'always') return true;
      if (cond === '1st') return iter === 0;
      // STEP GRID: a 16-char binary string (the toggle grid) — each char is one
      // cycle in a 16-step pattern (1 = play, 0 = skip), repeating every 16.
      if (/^[01]{16}$/.test(String(cond))) return String(cond).charAt(((iter % 16) + 16) % 16) === '1';
      // Legacy numeric BITMASK: the decimal value's binary (MSB-first, min 4 bits
      // wide), repeating every bit. e.g. 2 → "0010" plays the 3rd of every 4.
      // Kept so older saves still play; the UI now writes step-grid strings.
      if (/^\d+$/.test(String(cond))) {
        const n = parseInt(cond, 10) || 0;
        if (n <= 0) return false;
        const bits = _ambWhenBitsStr(n);
        const w = bits.length;
        return bits.charAt(((iter % w) + w) % w) === '1';
      }
      const m = /^(\d+):(\d+)$/.exec(cond);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (b > 0) return (iter % b) === (((a - 1) % b + b) % b);
      }
      return true;
    }
    // Decimal → on/off bitmask STRING (MSB-first), zero-padded to at least 4 bits.
    // Only the legacy numeric-bitmask path in _ambCondFires uses this now.
    function _ambWhenBitsStr(n) {
      n = (typeof n === 'number') ? n : (parseInt(n, 10) || 0);
      if (!(n > 0)) return '0000';
      const b = n.toString(2);
      return b.length >= 4 ? b : b.padStart(4, '0');
    }
    // Any stored When (legacy 'always'/'1st'/'A:B'/decimal OR a 16-char grid
    // string) → 16 booleans for the toggle grid, by simply asking _ambCondFires
    // what fires on cycles 0..15. So every legacy form maps onto the grid and the
    // grid round-trips exactly.
    function _ambWhenGridCells(when) {
      const out = [];
      for (let i = 0; i < 16; i++) out.push(_ambCondFires(when, i));
      return out;
    }
    // 16 booleans → the stored When string (the grid's binary).
    function _ambGridToWhen(cells) {
      let s = ''; for (let i = 0; i < 16; i++) s += cells[i] ? '1' : '0';
      return s;
    }
    // Collapsed-summary text for a 16-cell pattern: "Always" (all on), "Never"
    // (all off), else the binary string (the live pattern).
    function _ambWhenSummary(cells) {
      let on = 0; for (let i = 0; i < 16; i++) if (cells[i]) on++;
      if (on === 16) return 'Always';
      if (on === 0) return 'Never';
      return _ambGridToWhen(cells);
    }
    // Paint a When grid's cells (id `<stem>when`) + its collapsed summary from a
    // stored value.
    function _ambPaintWhenGrid(grid, when) {
      if (!grid) return;
      const cells = _ambWhenGridCells(when);
      grid.querySelectorAll('.ambient-when-cell').forEach((el, i) => el.classList.toggle('on', !!cells[i]));
      const wrap = grid.closest('.ambient-when-wrap');
      const sum = wrap && wrap.querySelector('.ambient-when-summary');
      if (sum) sum.textContent = _ambWhenSummary(cells);
    }
    // Wire the collapse/expand toggle (the grid is collapsed by default; the
    // summary button reveals it). Bound once per control.
    function _ambWireWhenToggle(grid) {
      if (!grid) return;
      const wrap = grid.closest('.ambient-when-wrap'); if (!wrap || wrap._ambTogBound) return;
      const tog = wrap.querySelector('.ambient-when-toggle'); if (!tog) return;
      wrap._ambTogBound = true;
      tog.addEventListener('click', () => {
        const exp = wrap.classList.toggle('expanded');
        tog.setAttribute('aria-expanded', exp ? 'true' : 'false');
      });
    }
    // Wire a When toggle grid (id `<stem>when`): seed from the layer's value, wire
    // collapse/expand, then toggle the clicked step and store the 16-char pattern.
    // Shared by every layer type (primaries use their own inline cell handler).
    function _ambBindWhen(E, stem, get, persist) {
      const grid = _ambGet(E, stem + 'when'); if (!grid) return;
      _ambWireWhenToggle(grid);
      const L0 = get(); _ambPaintWhenGrid(grid, L0 ? L0.when : 'always');
      if (grid._ambBound) return; grid._ambBound = true;
      grid.addEventListener('click', (e) => {
        const cell = e.target && e.target.closest ? e.target.closest('.ambient-when-cell') : null;
        if (!cell || !grid.contains(cell)) return;
        _E = E; const L = get(); if (!L) return;
        const cells = _ambWhenGridCells(L.when);
        const idx = Math.max(0, Math.min(15, parseInt(cell.getAttribute('data-step'), 10) || 0));
        cells[idx] = !cells[idx];
        L.when = _ambGridToWhen(cells);
        _ambPaintWhenGrid(grid, L.when);
        persist();
      });
    }

    // ================= BED engine ===================================
    function _ambPickVoicing(bed) {
      const intervals = _ambScaleIntervals(_ambNotesOf(bed));
      const N = intervals.length;
      const chordDegrees = [0, 2, 4, 6].filter(d => d < N);
      const center = Math.max(1, Math.min(8, bed.register | 0));
      const spread = Math.max(0, Math.min(4, bed.spread | 0));
      const want = Math.max(1, Math.min(8, bed.density | 0));
      const used = new Set();
      const out = [];
      let guard = 0;
      while (out.length < want && guard++ < 64) {
        const deg = (_ambRand() < 0.75 && chordDegrees.length)
          ? chordDegrees[Math.floor(_ambRand() * chordDegrees.length)]
          : Math.floor(_ambRand() * N);
        const oct = center + Math.round((_ambRand() * 2 - 1) * spread);
        const key = deg + ':' + oct;
        if (used.has(key)) continue;
        used.add(key);
        out.push(_ambDegreeFreq(deg, oct, _ambNotesOf(bed)));
      }
      return out.sort((a, b) => a - b);
    }
    // Pad voice params. CRITICAL: attack + release stay INSIDE the note window
    // (lengthMs) — playNote's preReleaseDur = noteMs − release collapses to ~0
    // if release exceeds the note, leaving synth voices released before their
    // attack ramps up (near-silent). Gain staging is ~1/N (sustained tonal
    // chords overlap and sum near-COHERENTLY, so the app's 1/√N would slam the
    // limiter = sustained-pad distortion); OVERLAP reflects how much the
    // user's Length exceeds the Interval.
    // Resolve a layer's instrument: its own `tone`, or the grid voice when ''.
    function _ambLayerType(tone) {
      if (typeof tone === 'string' && tone) return tone;
      return (typeof cellParams !== 'undefined' && cellParams[0] && cellParams[0].type) ? cellParams[0].type : 'sine';
    }
    // Sample voices get a +SAMPLE_VOLUME_BOOST_DB (×4) gain in playNote's
    // per-note path so MELODIC samples (recorded quiet, ~-12 dBFS) match synth
    // loudness. That boost is RIGHT for Bed/Motif/Texture sample tones, so they
    // keep it. Only Beat compensates it: drum samples are recorded hot, so the
    // +12 dB over-boosts them and slams the limiter — this cancels it so a beat
    // hit sits at synth-equivalent level.
    function _ambBoostComp(type) {
      if (typeof type === 'string' && type.startsWith('sample:')
          && typeof SAMPLE_VOLUME_BOOST_DB === 'number') {
        return Math.pow(10, -SAMPLE_VOLUME_BOOST_DB / 20);
      }
      return 1;
    }
    function _ambBedParams(noteMs, density, motion, overlap, pan, tone) {
      const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' };
      const atkMs = Math.max(150, Math.round(noteMs * 0.30));
      const relMs = Math.max(300, Math.round(noteMs * 0.55));
      const baseVol = Number.isFinite(base.volume) ? base.volume : 100;
      const HEADROOM = 0.7;
      const eff = Math.max(1, density) * Math.max(1, overlap);
      const type = _ambLayerType(tone);
      // Melodic samples KEEP the full +12 dB boost (sustaining samples then
      // match synth level; decaying ones — e.g. piano — naturally sit a little
      // lower in a pad role). 1/N staging keeps the bed safe; only Beat (drums,
      // recorded hot) compensates the boost.
      const vol = Math.max(2, Math.round(baseVol * (HEADROOM / eff)));
      const out = { ...base, type, attack: atkMs, decay: 200, sustain: 85, release: relMs, volume: vol, pan: pan | 0 };
      // Motion: a small per-voice detune drift (panning is the Space fader's job).
      const m = Math.max(0, Math.min(100, motion | 0)) / 100;
      if (m > 0) out.detune = (Number.isFinite(base.detune) ? base.detune : 0) + Math.round((_ambRand() * 2 - 1) * 18 * m);
      return out;
    }
    // Strum play-order for N notes. fidelity 0 = the voicing's own order
    // (low→high) every time; higher = increasing chance each position swaps
    // with a random later one (partial Fisher–Yates), so the arpeggio order
    // wanders more. Uses the engine's seeded RNG so it's reproducible per seed.
    function _ambStrumOrder(n, fidelity) {
      const order = [];
      for (let i = 0; i < n; i++) order.push(i);
      const p = Math.max(0, Math.min(100, fidelity || 0)) / 100;
      if (p <= 0 || n < 2) return order;
      for (let i = n - 1; i > 0; i--) {
        if (_ambRand() < p) {
          const j = Math.floor(_ambRand() * (i + 1));
          const t = order[i]; order[i] = order[j]; order[j] = t;
        }
      }
      return order;
    }
    function _ambEmitBed(at, bed, space, key) {
      key = key || 'bed';
      _ambKeyTime = at;   // resolve this note's key by its play-time (keyMaster sections)
      const voicing = _ambPickVoicing(bed);
      if (!voicing.length) return;
      const durMs = Math.max(80, bed.lengthMs | 0);
      const overlap = durMs / Math.max(1, bed.intervalMs | 0);
      const pans = _ambLayerPans(bed, voicing.length);
      const dest = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      const n = voicing.length;
      // Strum: spread the chord's notes across a fraction of the bed's interval
      // (0 = a near-simultaneous pad, 100 = arpeggiated across the whole cycle),
      // in an order shaped by Strum Fidelity.
      const strumAmt = Math.max(0, Math.min(100, bed.strum || 0));
      const spanSec = (strumAmt / 100) * Math.max(0, (bed.intervalMs | 0) / 1000);
      const order = _ambStrumOrder(n, bed.strumFidelity || 0);
      order.forEach((vi, pos) => {
        const f = voicing[vi];
        const params = _ambBedParams(durMs, n, bed.motion, overlap, pans[vi], bed.tone);
        params.volume = _ambApplyLevel(params.volume, bed.level);
        if (dmod) params._detuneMod = dmod;
        // No strum → keep the tiny 12 ms stagger that de-phases the pad; with
        // strum, space the onsets evenly across spanSec in play order.
        const offset = (spanSec > 0) ? (pos / Math.max(1, n)) * spanSec : (pos * 0.012);
        try { playNote(f, params, durMs, at + offset, dest, undefined, _E.laneIdx()); } catch (e) {}
      });
    }

    // ================= BASS engine ==================================
    // A Bass layer plays a euclidean rhythmic phrase locked to the global BPM.
    // The SEED phrase is `bars` bars long; with no variation it repeats
    // identically and returns to its start every `bars` bars. Stochastic
    // Rhythm var / Pitch var perturb each repetition. The phrase is realized
    // per cycle from a deterministic per-cycle RNG (seeded by layer id + cycle
    // + project seed) so the SAME cycle always renders identically no matter
    // how many lookahead ticks observe it — only the cycle index advancing
    // changes the variation. Config is re-read at each cycle boundary, so edits
    // made mid-playback land on the NEXT phrase iteration (like other layers).
    function _ambBassParams(lenMs, pan, tone) {
      const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' };
      const baseVol = Number.isFinite(base.volume) ? base.volume : 100;
      const type = _ambLayerType(tone);
      return {
        ...base,
        type,
        attack: Math.max(6, Math.round(lenMs * 0.04)),
        decay: 160, sustain: 60,
        release: Math.max(120, Math.round(lenMs * 0.7)),
        volume: Math.max(2, Math.round(baseVol * 0.34)),
        pan: pan | 0,
      };
    }
    // Small deterministic PRNG (mulberry32-ish) seeded per cycle so a cycle's
    // variation is stable across ticks.
    function _ambSeededRand(seed) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function _ambEmitBass(E, inst, key, now, horizon, lead, space, cfg) {
      if (!E.bassPhase) E.bassPhase = {};
      if (typeof euclideanPattern !== 'function') return;
      const bpm = _ambBpm();
      const barSec = (60 / bpm) * 4 * _ambLayerScale(E, key, inst, cfg);   // 4/4, Unit-Sync scaled
      const bars   = Math.max(1, Math.min(8, inst.bars | 0) || 1);
      const phraseSec = bars * barSec;            // content length
      if (!(phraseSec > 0.05)) return;
      const loopSec = phraseSec + Math.max(0, (inst.unitPadMs | 0)) / 1000;   // + silent pad (Unit Match)
      const steps  = Math.max(2, Math.min(16, inst.steps | 0) || 8);
      const pulses = Math.max(1, Math.min(steps, inst.pulses | 0) || 1);
      const rotate = Math.max(0, inst.rotate | 0);
      const slotSec = barSec / steps;
      const lenMs  = Math.max(40, inst.lengthMs | 0);
      const rVar   = Math.max(0, Math.min(100, inst.rhythmVar | 0));
      const pVar   = Math.max(0, Math.min(100, inst.pitchVar | 0));
      const proximity = Math.max(0, Math.min(100, inst.proximity | 0));
      const maxStep = 1 + Math.round((proximity / 100) * 7);   // 1 (adjacent) … 8 (wide leaps)
      const restP  = Math.max(0, Math.min(100, inst.restProb | 0));
      const reg    = Math.max(1, Math.min(4, inst.register | 0) || 2);
      const src    = _ambNotesOf(inst);
      const N      = Math.max(1, _ambScaleIntervals(src).length);
      const dest   = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      const pat    = euclideanPattern(pulses, steps, rotate);   // base euclidean seed

      let st = E.bassPhase[key];
      if (!st) st = E.bassPhase[key] = { startAt: lead + _ambDriftOffset(inst, cfg), lastAt: null };
      const tFrom = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
      const tTo = horizon;
      if (tTo <= tFrom) { st.lastAt = Math.max(st.lastAt || 0, tTo); return; }

      const cFrom = Math.max(0, Math.floor((tFrom - st.startAt) / loopSec));
      const cTo   = Math.floor((tTo - st.startAt) / loopSec);
      let cap = 0;
      const isProg = (_ambAsNotes(src).type === 'prog');   // per-layer: one chord per phrase cycle
      try {
      for (let c = cFrom; c <= cTo && cap < 256; c++) {
        // 'when' conditional applies per phrase cycle (cycle = iteration index).
        if (!_ambCondFires(inst.when, c)) continue;
        if (isProg) _ambProgStepOverride = c;
        const cStart = st.startAt + c * loopSec;
        // Deterministic per-cycle RNG — stable across ticks, evolves per cycle.
        const rnd = _ambSeededRand(((inst.id | 0) * 2654435761) ^ ((c + 1) * 2246822519) ^ ((cfg && cfg.seed | 0) * 40503));
        let walkDeg = 0;   // scale-degree offset from the register root; resets to root each cycle
        for (let bar = 0; bar < bars; bar++) {
          for (let slot = 0; slot < steps; slot++) {
            let hit = pat[slot] === 1;
            if (rVar > 0) {
              if (hit) { if (rnd() * 100 < rVar * 0.40) hit = false; }       // drop a seed hit
              else      { if (rnd() * 100 < rVar * 0.22) hit = true; }        // add a ghost hit
            }
            if (!hit) continue;
            if (restP > 0 && rnd() * 100 < restP) continue;
            const at = cStart + (bar * steps + slot) * slotSec;
            if (at < tFrom || at >= tTo) continue;
            // Pitch: a proximity-constrained walk anchored to the root. Each
            // cycle starts on the root; when Pitch var fires the walk steps by a
            // random magnitude in [1, maxStep] scale degrees (Proximity caps the
            // leap — 0 = strictly adjacent), otherwise it holds the current note.
            // Reflected within a 2-octave bass range so it stays low.
            if (pVar > 0 && rnd() * 100 < pVar) {
              const mag = 1 + Math.floor(rnd() * maxStep);
              const dir = rnd() < 0.5 ? -1 : 1;
              walkDeg += dir * mag;
              const span = 2 * N;
              if (walkDeg < 0) walkDeg = -walkDeg;                  // reflect at root
              if (walkDeg > span) walkDeg = span - (walkDeg - span);
              walkDeg = Math.max(0, Math.min(span, walkDeg));
            }
            _ambKeyTime = at;   // this slot's key by its play-time (keyMaster sections)
            const f = _ambDegreeFreq(walkDeg % N, reg + Math.floor(walkDeg / N), src);
            if (f == null) continue;
            const bp = _ambBassParams(lenMs, _ambLayerPan(inst), inst.tone);
            bp.volume = _ambAccentVol(_ambApplyLevel(bp.volume, inst.level), inst.accent);
            if (dmod) bp._detuneMod = dmod;
            try { playNote(f, bp, lenMs, at, dest, undefined, _E.laneIdx()); } catch (e) {}
            cap++;
            if (cap >= 256) break;
          }
          if (cap >= 256) break;
        }
      }
      } finally { _ambProgStepOverride = null; }
      st.lastAt = tTo;
    }

    // ================= RUN engine ===================================
    // A "Run" is a fixed RANDOM note run, `bars` bars long, that REPEATS as a
    // loop locked to the global BPM. `density` sets notes per bar; the base run
    // is drawn once from a seed (inst.id + project seed) so every repeat is
    // identical — until `vary` is dialed up, which re-rolls that percentage of
    // slots' pitch (and rest) per cycle, so the loop slowly mutates. Pitches are
    // random scale degrees across `range` octaves above `register`, always in
    // the current Scale. Mirrors _ambEmitBass's windowed, phase-anchored
    // scheduling so it stays sample-accurate and re-reads config at cycle edges.
    function _ambEmitRun(E, inst, key, now, horizon, lead, space, cfg) {
      if (!E.runPhase) E.runPhase = {};
      const bpm = _ambBpm();
      const barSec = (60 / bpm) * 4 * _ambLayerScale(E, key, inst, cfg);   // 4/4, Unit-Sync scaled
      const bars   = Math.max(1, Math.min(16, inst.bars | 0) || 2);
      const phraseSec = bars * barSec;
      if (!(phraseSec > 0.05)) return;
      const loopSec = phraseSec + Math.max(0, (inst.unitPadMs | 0)) / 1000;   // + silent pad (Unit Match)
      const perBar = Math.max(1, Math.min(16, inst.density | 0) || 8);
      const totalSlots = bars * perBar;
      const slotSec = barSec / perBar;
      const lenMs  = Math.max(40, inst.lengthMs | 0);
      const vary   = Math.max(0, Math.min(100, inst.vary | 0));
      const restP  = Math.max(0, Math.min(100, inst.restProb | 0));
      const reg    = Math.max(2, Math.min(7, inst.register | 0) || 5);
      const range  = Math.max(1, Math.min(4, inst.range | 0) || 2);
      const transpose = Math.max(-24, Math.min(24, inst.transpose | 0));  // half steps, ±2 oct
      const tFactor = Math.pow(2, transpose / 12);
      const src    = _ambNotesOf(inst);
      const N      = Math.max(1, _ambScaleIntervals(src).length);
      const span   = Math.max(1, N * range);
      const dest   = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);

      // Fixed base run — seeded by layer id + project seed, so it repeats
      // verbatim across cycles. One random degree (+ maybe rest) per slot.
      const baseSeed = (((inst.id | 0) * 2654435761) ^ ((cfg && cfg.seed | 0) * 40503) ^ 0x5bd1e995) >>> 0;
      const baseRnd = _ambSeededRand(baseSeed);
      const baseDeg = new Array(totalSlots);
      const baseRest = new Array(totalSlots);
      for (let i = 0; i < totalSlots; i++) {
        baseDeg[i] = Math.floor(baseRnd() * span);
        baseRest[i] = (restP > 0 && baseRnd() * 100 < restP);
      }

      let st = E.runPhase[key];
      if (!st) st = E.runPhase[key] = { startAt: lead + _ambDriftOffset(inst, cfg), lastAt: null };
      const tFrom = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
      const tTo = horizon;
      if (tTo <= tFrom) { st.lastAt = Math.max(st.lastAt || 0, tTo); return; }

      const cFrom = Math.max(0, Math.floor((tFrom - st.startAt) / loopSec));
      const cTo   = Math.floor((tTo - st.startAt) / loopSec);
      let cap = 0;
      const isProg = (_ambAsNotes(src).type === 'prog');   // per-layer: one chord per loop
      try {
      for (let c = cFrom; c <= cTo && cap < 512; c++) {
        if (!_ambCondFires(inst.when, c)) continue;
        if (isProg) _ambProgStepOverride = c;
        const cStart = st.startAt + c * loopSec;
        // Per-cycle RNG drives Vary — stable within a cycle, evolves per cycle.
        const vRnd = _ambSeededRand((baseSeed ^ ((c + 1) * 2246822519)) >>> 0);
        for (let i = 0; i < totalSlots; i++) {
          let deg = baseDeg[i], rest = baseRest[i];
          if (vary > 0 && vRnd() * 100 < vary) {
            deg = Math.floor(vRnd() * span);
            rest = (restP > 0 && vRnd() * 100 < restP);
          }
          if (rest) continue;
          const at = cStart + i * slotSec;
          if (at < tFrom || at >= tTo) continue;
          _ambKeyTime = at;   // this slot's key by its play-time (keyMaster sections)
          let f = _ambDegreeFreq(deg % N, reg + Math.floor(deg / N), src);
          if (f == null) continue;
          f *= tFactor;   // transpose the whole riff by ±half steps (chromatic)
          const bp = _ambMotifParams(lenMs, _ambLayerPan(inst), inst.tone);
          bp.volume = _ambAccentVol(_ambApplyLevel(bp.volume, inst.level), inst.accent);
          if (dmod) bp._detuneMod = dmod;
          try { playNote(f, bp, lenMs, at, dest, undefined, _E.laneIdx()); } catch (e) {}
          cap++;
          if (cap >= 512) break;
        }
      }
      } finally { _ambProgStepOverride = null; }
      st.lastAt = tTo;
    }

    // ================= PEDAL engine =================================
    // A dead-simple pedal-point loop: `density` evenly-spaced hits per bar of the
    // ROOT note (degree 0 of the current key/grid), over `bars` bars, BPM-locked
    // and phase-anchored like Bass/Run. Default 1 bar × 4 quarter-note roots.
    // Follows the key (incl. keyMaster sections) via the per-note time stamp.
    function _ambEmitPedal(E, inst, key, now, horizon, lead, space, cfg) {
      if (!E.runPhase) E.runPhase = {};
      const bpm = _ambBpm();
      const barSec = (60 / bpm) * 4 * _ambLayerScale(E, key, inst, cfg);   // 4/4, Unit-Sync scaled
      const bars   = Math.max(1, Math.min(16, inst.bars | 0) || 1);
      const phraseSec = bars * barSec;
      if (!(phraseSec > 0.05)) return;
      const loopSec = phraseSec + Math.max(0, (inst.unitPadMs | 0)) / 1000;   // + silent pad (Unit Match)
      const perBar = Math.max(1, Math.min(16, inst.density | 0) || 4);
      const totalSlots = bars * perBar;
      const slotSec = barSec / perBar;
      const lenMs  = Math.max(40, inst.lengthMs | 0);
      const restP  = Math.max(0, Math.min(100, inst.restProb | 0));
      const vary   = Math.max(0, Math.min(100, inst.vary | 0));   // % of hits that roam off the root
      const reg    = Math.max(1, Math.min(7, inst.register | 0) || 4);
      const src    = _ambNotesOf(inst);
      const N      = Math.max(1, _ambScaleIntervals(src).length);
      const dest   = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      // Match a default Shape node exactly: the grid voice at FULL volume 100
      // (applyLevel'd), not the ~0.3×-attenuated Bass/Motif params — so a default
      // Pedal and a default Shape sound the same.
      const vtype  = _ambLayerType(inst.tone);
      const pan    = _ambLayerPan(inst);
      // ADSR is exposed at the layer level (Attack/Decay/Sustain/Release sliders);
      // defaults match a default Shape node's fitted bare-voice envelope.
      const atk = Math.max(0, Math.min(2000, Number.isFinite(inst.attack) ? inst.attack : 5));
      const dec = Math.max(0, Math.min(2000, Number.isFinite(inst.decay) ? inst.decay : 40));
      const sus = Math.max(0, Math.min(100, Number.isFinite(inst.sustain) ? inst.sustain : 75));
      const rel = Math.max(0, Math.min(4000, Number.isFinite(inst.release) ? inst.release : 200));

      let st = E.runPhase[key];
      if (!st) st = E.runPhase[key] = { startAt: lead + _ambDriftOffset(inst, cfg), lastAt: null };
      const tFrom = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
      const tTo = horizon;
      if (tTo <= tFrom) { st.lastAt = Math.max(st.lastAt || 0, tTo); return; }

      const isProg = (_ambAsNotes(src).type === 'prog');
      const cFrom = Math.max(0, Math.floor((tFrom - st.startAt) / loopSec));
      const cTo   = Math.floor((tTo - st.startAt) / loopSec);
      let cap = 0;
      try {
      for (let c = cFrom; c <= cTo && cap < 512; c++) {
        if (!_ambCondFires(inst.when, c)) continue;
        if (isProg) _ambProgStepOverride = c;   // per-layer progression: one chord per loop
        const cStart = st.startAt + c * loopSec;
        // One per-cycle RNG drives both Rests and Vary (stable within a cycle,
        // evolves per cycle — so the pedal stays mostly on the root and roams the
        // same way each pass until the cycle turns over).
        const cRnd = (restP > 0 || vary > 0) ? _ambSeededRand((((inst.id | 0) * 2654435761) ^ ((c + 1) * 2246822519) ^ ((cfg && cfg.seed | 0) * 40503)) >>> 0) : null;
        for (let i = 0; i < totalSlots; i++) {
          if (cRnd && restP > 0 && cRnd() * 100 < restP) continue;
          // Base degree (the "Note" control, 1 = key root) unless Vary roams it.
          let deg = Math.min(N - 1, Math.max(0, ((inst.degree | 0) || 1) - 1));
          if (cRnd && vary > 0 && cRnd() * 100 < vary) deg = Math.floor(cRnd() * N);
          const at = cStart + i * slotSec;
          if (at < tFrom || at >= tTo) continue;
          _ambKeyTime = at;
          const f = _ambDegreeFreq(deg, reg, src);   // base degree or a roamed degree
          if (f == null) continue;
          const bp = { type: vtype, attack: atk, decay: dec, sustain: sus, release: rel,
            volume: _ambAccentVol(_ambApplyLevel(100, inst.level), inst.accent), pan };
          if (dmod) bp._detuneMod = dmod;
          try { playNote(f, bp, lenMs, at, dest, undefined, _E.laneIdx()); } catch (e) {}
          cap++;
          if (cap >= 512) break;
        }
      }
      } finally { _ambProgStepOverride = null; }
      st.lastAt = tTo;
    }

    // ================= DRONE engine ================================
    // Holds a note (or the whole chord, if the Notes source is a chord/wrap/prog)
    // and RE-STRIKES every `hold` units. Time vary jitters the strike time;
    // Pitch vary drifts the octave (and the scale degree for a single-note drone).
    // Phase-anchored to a downbeat like Pedal/Run; follows the key per note.
    function _ambEmitDrone(E, inst, key, now, horizon, lead, space, cfg) {
      if (!E.runPhase) E.runPhase = {};
      const unitSec = Math.max(0.05, _ambEffIntervalSec(inst)) * _ambLayerScale(E, key, inst, cfg);   // Unit-Sync scaled
      const hold = Math.max(1, Math.min(64, inst.hold | 0) || 1);
      const cycleSec = hold * unitSec;
      if (!(cycleSec > 0.05)) return;
      const reg = Math.max(1, Math.min(7, inst.register | 0) || 3);
      const src = _ambNotesOf(inst);
      const n = _ambAsNotes(src);
      const chordLike = (n.type === 'chord' || n.type === 'wrap' || n.type === 'prog');
      const N = Math.max(1, _ambScaleIntervals(src).length);
      // Chosen root for a single-note (scale) drone — a SCALE DEGREE, so it always
      // stays in the current key/scale (1 = key root). Chord sources keep their own
      // root (set in the Notes picker).
      const rootDeg = Math.min(N - 1, Math.max(0, (((inst.degree | 0) || 1) - 1)));
      const dest = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      const vtype = _ambLayerType(inst.tone);
      const pan = _ambLayerPan(inst);
      const atk = Math.max(0, Math.min(8000, Number.isFinite(inst.attack) ? inst.attack : 200));
      const rel = Math.max(0, Math.min(12000, Number.isFinite(inst.release) ? inst.release : 1500));
      const timeVary = Math.max(0, Math.min(100, inst.timeVary | 0));
      const pitchVary = Math.max(0, Math.min(100, inst.pitchVary | 0));
      // Hold the note across (almost) the whole span so it's continuous; a hair
      // short so a long release doesn't pile onto the next strike.
      const lenMs = Math.max(60, Math.round(cycleSec * 1000 * 0.98));

      let st = E.runPhase[key];
      if (!st) st = E.runPhase[key] = { startAt: lead + _ambDriftOffset(inst, cfg), lastAt: null };
      const tFrom = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
      const tTo = horizon;
      if (tTo <= tFrom) { st.lastAt = Math.max(st.lastAt || 0, tTo); return; }

      const isProg = (n.type === 'prog');   // per-layer: one chord per drone cycle
      const cFrom = Math.max(0, Math.floor((tFrom - st.startAt) / cycleSec));
      const cTo   = Math.floor((tTo - st.startAt) / cycleSec);
      let cap = 0;
      try {
      for (let c = cFrom; c <= cTo && cap < 64; c++) {
        if (!_ambCondFires(inst.when, c)) continue;
        if (isProg) _ambProgStepOverride = c;                 // advance this layer's progression
        const cN = isProg ? Math.max(1, _ambScaleIntervals(src).length) : N;
        const cRnd = (timeVary > 0 || pitchVary > 0)
          ? _ambSeededRand((((inst.id | 0) * 2654435761) ^ ((c + 1) * 2246822519) ^ ((cfg && cfg.seed | 0) * 40503)) >>> 0) : null;
        let tOff = 0;
        if (cRnd && timeVary > 0) tOff = (cRnd() * 2 - 1) * (timeVary / 100) * unitSec * 0.5;
        const at = st.startAt + c * cycleSec + tOff;
        if (at < tFrom || at >= tTo) continue;
        let regShift = 0, degBase = rootDeg;
        if (cRnd && pitchVary > 0 && cRnd() * 100 < pitchVary) {
          regShift = (cRnd() < 0.5 ? -1 : 1);
          if (!chordLike) degBase = Math.floor(cRnd() * cN);   // single-note drone roams off the root degree
        }
        _ambKeyTime = at;
        const degs = chordLike ? Array.from({ length: cN }, (_, i) => i) : [degBase];
        const bp = { type: vtype, attack: atk, decay: 0, sustain: 100, release: rel,
          volume: _ambAccentVol(_ambApplyLevel(100, inst.level), inst.accent), pan };
        if (dmod) bp._detuneMod = dmod;
        degs.forEach((d, vi) => {
          const f = _ambDegreeFreq(d, reg + regShift, src);
          if (f == null) return;
          const vp = Object.assign({}, bp);
          try { playNote(f, vp, lenMs, at + vi * 0.006, dest, undefined, _E.laneIdx()); } catch (e) {}
        });
        cap++;
      }
      } finally { _ambProgStepOverride = null; }
      st.lastAt = tTo;
    }

    // ================= SHAPE engine =================================
    // A Shape layer holds N radial-sequencer wheels. Each wheel loops
    // continuously, phase-anchored to a downbeat (E.shapePhase[key#i].startAt)
    // and locked to the global BPM. Per tick we schedule every node occurrence
    // whose absolute time falls in (lastAt, horizon] — using lastAt (not now) as
    // the lower bound so the 1.2 s lookahead can't double-fire a node. Node
    // pitch / chord / Set-variant / voice / duration come from the SAME 21-shape
    // resolvers a normal Shape instance uses (_shapeResolveNodeEvent); only the
    // final emit is the Bloom layer path so Level / pan-spread / mod / FX apply.
    function _ambEmitShape(E, inst, key, now, horizon, lead, space, cfg) {
      if (!E.shapePhase) E.shapePhase = {};
      if (!inst || !Array.isArray(inst.shapes) || !inst.shapes.length) return;
      if (typeof _shapeBarSec !== 'function' || typeof _shapeSortedEff !== 'function' || typeof _shapeResolveNodeEvent !== 'function') return;
      const dest = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      inst.shapes.forEach((sh, si) => {
        if (!sh || !Array.isArray(sh.nodes) || !sh.nodes.length) return;
        const revSec = _shapeBarSec(sh);
        if (!(revSec > 0.02)) return;
        const skey = key + '#' + si;
        let st = E.shapePhase[skey];
        if (!st) st = E.shapePhase[skey] = { startAt: lead + _ambDriftOffset(inst, cfg), lastAt: null };
        const tFrom = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
        const tTo = horizon;
        if (tTo <= tFrom) { st.lastAt = Math.max(st.lastAt || 0, tTo); return; }
        let info; try { info = _shapeSortedEff(sh); } catch (e) { return; }
        const sortedAngles = info.sortedAngles, idxOf = info.idxOf;
        // Collect every due occurrence, then play in time order so Set-node
        // cycles advance in the order they actually sound.
        const due = [];
        info.eff.forEach(e => {
          const nd = e.nd; if (!nd || nd.muted) return;
          const a = ((e.a % 1) + 1) % 1;
          let kMin = Math.ceil((tFrom - st.startAt) / revSec - a);
          const kMax = Math.floor((tTo - st.startAt) / revSec - a - 1e-9);
          if (kMin < 0) kMin = 0;
          let guard = 0;
          for (let k = kMin; k <= kMax && guard < 64; k++, guard++) {
            const at = st.startAt + (k + a) * revSec;
            if (at >= tFrom && at < tTo) due.push({ nd, a, sortedIdx: idxOf.get(nd), at });
          }
        });
        due.sort((p, q) => p.at - q.at);
        let cap = 0;
        for (const ev of due) {
          if (cap++ > 96) break;
          let res; try { res = _shapeResolveNodeEvent(sh, ev.nd, ev.a, sortedAngles, ev.sortedIdx); } catch (e) { continue; }
          if (!res || !Array.isArray(res.voices) || !res.voices.length) continue;
          const pans = (res.voices.length > 1) ? _ambLayerPans(inst, res.voices.length) : [_ambLayerPan(inst)];
          res.voices.forEach((v, vi) => {
            const params = Object.assign({}, v.params);
            params.volume = _ambApplyLevel(params.volume != null ? params.volume : 100, inst.level);
            params.pan = pans[vi % pans.length];
            if (dmod) params._detuneMod = dmod;
            try { playNote(v.freq, params, res.durMs, ev.at + vi * 0.012, dest, undefined, _E.laneIdx()); } catch (e) {}
          });
        }
        st.lastAt = tTo;
      });
    }

    // ================= MOTIF engine =================================
    // motif random-walk position lives on the engine: _E.motifDeg
    function _ambMotifParams(lenMs, pan, tone) {
      const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' };
      const baseVol = Number.isFinite(base.volume) ? base.volume : 100;
      const type = _ambLayerType(tone);
      return {
        ...base,
        type,
        attack: Math.max(8, Math.round(lenMs * 0.10)),
        decay: 120, sustain: 70,
        release: Math.max(120, Math.round(lenMs * 0.5)),
        volume: Math.max(2, Math.round(baseVol * 0.32)),
        pan: pan | 0,
      };
    }
    // One random-walk step → frequency. Advances _E.motifDeg. Pulled out of
    // _ambEmitMotif so Twist can fire several in quick succession.
    function _ambMotifNextNote(motif) {
      const intervals = _ambScaleIntervals(_ambNotesOf(motif));
      const N = intervals.length;
      const center = Math.max(1, Math.min(8, motif.register | 0));
      const range = Math.max(1, Math.min(4, motif.range | 0));
      const lo = (center - range) * N, hi = (center + range) * N;
      if (_E.motifDeg == null) _E.motifDeg = center * N;
      // Proximity caps how far consecutive notes may leap (in scale degrees).
      // 0 → every step is EXACTLY ±1 (strictly adjacent); higher widens the
      // allowed gap up to ~an octave, picking a random magnitude in [1, maxStep].
      const proximity = Math.max(0, Math.min(100, (motif.proximity != null ? motif.proximity : 35) | 0));
      const maxStep = 1 + Math.round((proximity / 100) * 7);   // 1 (adjacent) … 8
      const mag = 1 + Math.floor(_ambRand() * maxStep);         // 1 … maxStep
      const dir = _ambRand() < 0.5 ? -1 : 1;
      let next = _E.motifDeg + dir * mag;
      if (next < lo) next = lo + (lo - next);
      if (next > hi) next = hi - (next - hi);
      next = Math.max(lo, Math.min(hi, next));
      const degInOct = ((next % N) + N) % N;
      const chordSet = [0, 2, 4].filter(d => d < N);
      // Chord-tone magnet — skipped at proximity 0 so strict adjacency holds
      // (snapping to a chord tone could otherwise jump more than one degree).
      if (proximity > 0 && !chordSet.includes(degInOct) && _ambRand() < 0.45) {
        let best = degInOct, bd = 99;
        chordSet.forEach(c => { const dd = Math.min((c - degInOct + N) % N, (degInOct - c + N) % N); if (dd < bd) { bd = dd; best = c; } });
        next += (best - degInOct);
      }
      _E.motifDeg = next;
      return _ambDegreeFreq(((next % N) + N) % N, Math.floor(next / N), _ambNotesOf(motif));
    }
    function _ambEmitMotif(at, motif, space, key) {
      key = key || 'motif';
      _ambKeyTime = at;
      if (_ambRand() * 100 < Math.max(0, Math.min(100, motif.restProb | 0))) return;
      const lenMs = Math.max(60, motif.lengthMs | 0);
      // Twist: 0 = a single note per fire (steady cadence). As it rises, the
      // chance AND size of a quick note-burst grow — a flurry of walk-steps
      // packed into a tight window, so the line stutters into runs.
      const tw = Math.max(0, Math.min(100, motif.twist | 0)) / 100;
      let count = 1;
      if (tw > 0 && _ambRand() < tw) count = 2 + Math.floor(_ambRand() * (1 + tw * 5)); // 2..~7
      const burstGap = Math.min(0.12, (lenMs / 1000) / Math.max(1, count)); // fast, ≤120 ms apart
      const dmod = _ambLayerDetuneMod(key);
      for (let i = 0; i < count; i++) {
        const f = _ambMotifNextNote(motif);
        if (f == null) continue;
        // Sequential single notes can't be "distributed" simultaneously, so
        // Space spreads them by panning each randomly within ±space.
        const pan = _ambLayerPan(motif);
        const mp = _ambMotifParams(lenMs, pan, motif.tone);
        mp.volume = _ambAccentVol(_ambApplyLevel(mp.volume, motif.level), motif.accent);
        if (dmod) mp._detuneMod = dmod;
        try { playNote(f, mp, lenMs, at + i * burstGap, _ambLayerDest(key), undefined, _E.laneIdx()); } catch (e) {}
      }
    }

    // ================= TEXTURE engine ===============================
    // texture pattern/cursor/mutate-clock live on the engine: _E.texPattern / _E.texStep / _E.texMutateAt
    function _ambTexBuildPattern(texture) {
      const intervals = _ambScaleIntervals(_ambNotesOf(texture));
      const N = intervals.length;
      const fill = Math.max(0, Math.min(100, texture.fill | 0)) / 100;
      _E.texPattern = [];
      for (let i = 0; i < 16; i++) _E.texPattern.push({ on: _ambRand() < fill * 0.6, deg: Math.floor(_ambRand() * N) });
      _E.texStep = 0;
    }
    function _ambTexMutate(texture) {
      if (!_E.texPattern) return;
      const intervals = _ambScaleIntervals(_ambNotesOf(texture));
      const N = intervals.length;
      const i = Math.floor(_ambRand() * _E.texPattern.length);
      if (_ambRand() < 0.5) _E.texPattern[i].on = !_E.texPattern[i].on;
      else _E.texPattern[i].deg = Math.floor(_ambRand() * N);
    }
    function _ambTexParams(lenMs, pan, tone) {
      const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' };
      const baseVol = Number.isFinite(base.volume) ? base.volume : 100;
      const type = _ambLayerType(tone);
      return {
        ...base,
        type,
        attack: Math.max(8, Math.round(lenMs * 0.12)), decay: 80, sustain: 0,
        release: Math.max(120, Math.round(lenMs * 0.8)),
        volume: Math.max(2, Math.round(baseVol * 0.2)), pan: pan | 0,
      };
    }
    function _ambEmitTexture(at, texture, space, key) {
      key = key || 'texture';
      _ambKeyTime = at;
      if (!_E.texPattern) _ambTexBuildPattern(texture);
      const center = Math.max(1, Math.min(8, texture.register | 0));
      const slot = _E.texPattern[_E.texStep % _E.texPattern.length];
      _E.texStep++;
      if (slot && slot.on) {
        const f = _ambDegreeFreq(slot.deg, center + (_ambRand() < 0.3 ? 1 : 0), _ambNotesOf(texture));
        const lenMs = Math.max(60, texture.lengthMs | 0);
        const pan = _ambLayerPan(texture);
        const tp = _ambTexParams(lenMs, pan, texture.tone);
        tp.volume = _ambApplyLevel(tp.volume, texture.level);
        const dmod = _ambLayerDetuneMod(key); if (dmod) tp._detuneMod = dmod;
        try { playNote(f, tp, lenMs, at, _ambLayerDest(key), undefined, _E.laneIdx()); } catch (e) {}
      }
      const mr = Math.max(0, Math.min(100, texture.mutateRate | 0));
      if (!_E.texMutateAt) _E.texMutateAt = at + (6 - mr / 100 * 5);
      if (at >= _E.texMutateAt) { _ambTexMutate(texture); _E.texMutateAt = at + (6 - mr / 100 * 5); }
    }

    // ================= ARP engine ==================================
    // Pool index for the Nth note of a directional sweep over `len` pitches.
    // Up: 0..len-1; Down: len-1..0; Up-Down / Down-Up: a triangle that visits
    // each endpoint once per cycle (no doubled top/bottom).
    function _ambArpIndexFor(dir, n, len) {
      if (len <= 1) return 0;
      const m = ((n % len) + len) % len;
      if (dir === 'down') return (len - 1) - m;
      if (dir === 'updown' || dir === 'downup') {
        const cycle = 2 * (len - 1);
        const k = ((n % cycle) + cycle) % cycle;
        let tri = (k < len) ? k : (cycle - k);     // 0→top→0 (up first)
        if (dir === 'downup') tri = (len - 1) - tri; // mirror → top→0→top
        return tri;
      }
      return m; // up
    }
    // Notes in one full pass (one entry sweep) for a direction over `len` pitches.
    function _ambArpPassLen(dir, len) {
      if (len <= 1) return 1;
      if (dir === 'updown' || dir === 'downup') return 2 * (len - 1);
      return len; // up / down / random
    }
    // How many notes one Arp series ENTRY plays before advancing to the next:
    // an EXACT `count` when the entry's unit is 'notes' (precise control — the
    // pool keeps wrapping past a full sweep), else `passLen × passes` (whole
    // sweeps, the default). `len` = pool size (scale degrees × octaves).
    function _ambArpEntryNotes(entry, dir, len) {
      if (entry && entry.unit === 'notes' && (entry.count | 0) > 0) return entry.count | 0;
      return _ambArpPassLen(dir, len) * Math.max(1, ((entry && entry.passes) | 0) || 1);
    }
    // Notes in ONE full pass through an Arp's series (Σ over entries of
    // passLen(dir, pool) × passes) + the per-note interval — so queue mode snaps
    // to the SERIES loop, not each note.
    function _ambArpSeriesInfo(arp, cfg) {
      const steps = (Array.isArray(arp.steps) && arp.steps.length) ? arp.steps : [{ notes: { type: 'scale', scale: '' }, passes: 1 }];
      const octs = Math.max(1, Math.min(4, (arp.octaves | 0) || 2));
      const entryNotes = steps.map(entry => {
        const len = Math.max(1, _ambScaleIntervals(_ambNotesOf(entry)).length) * octs;
        const dir = (entry && entry.dir) || arp.dir || 'up';
        return _ambArpEntryNotes(entry, dir, len);
      });
      const totalNotes = Math.max(1, entryNotes.reduce((a, b) => a + b, 0));
      // Use the SAME per-note interval the tick steps by (incl. sync-mode snap),
      // so the cycle boundary doesn't drift over many notes.
      const interval = cfg ? Math.max(0.02, _ambStepSecFor(arp, 0.02, cfg)) : Math.max(0.02, _ambEffIntervalSec(arp));
      return { entryNotes: entryNotes, totalNotes: totalNotes, interval: interval };
    }
    // Notes already emitted in the CURRENT cycle (from the live cursor), so the
    // remaining count gives the time to the next series-loop boundary.
    function _ambArpNotesInto(info, st) {
      if (!st) return 0;
      let into = 0;
      const e = Math.max(0, Math.min(st.entry | 0, info.entryNotes.length));
      for (let i = 0; i < e; i++) into += info.entryNotes[i];
      return Math.max(0, Math.min(info.totalNotes - 1, into + (st.note | 0)));
    }
    // One arp note per fire. Walks the current series entry's pitch pool in the
    // chosen Direction; after `entry.passes` full sweeps, advances to the next
    // entry (looping the series). Cursor state lives on _E.arpState[key].
    function _ambEmitArp(at, arp, space, key) {
      key = key || ('arp:' + (arp.id | 0));
      _ambKeyTime = at;
      const steps = (Array.isArray(arp.steps) && arp.steps.length) ? arp.steps : [{ notes: { type: 'scale', scale: '' }, passes: 1 }];
      const S = _E.arpState || (_E.arpState = {});
      let st = S[key];
      if (!st || st.entry >= steps.length) st = S[key] = { entry: 0, note: 0, pos: 0 };
      const entry = steps[Math.min(st.entry, steps.length - 1)];
      const notes = _ambNotesOf(entry);
      const _arpProg = (notes && notes.type === 'prog');   // per-layer: one chord per series loop
      if (_arpProg) _ambProgStepOverride = (st._loop | 0);
      try {
      const intervals = _ambScaleIntervals(notes);
      const N = Math.max(1, intervals.length);
      const octs = Math.max(1, Math.min(4, (arp.octaves | 0) || 2));
      const base = Math.max(1, Math.min(8, (arp.register | 0) || 4));
      const len = N * octs;
      // Direction is per series ENTRY now. Randomness (layer-wide) is how much
      // ANY direction deviates from its ordered pattern: with probability rnd a
      // note jumps to a random pool degree; otherwise it follows Up/Down/etc.
      // 'random' direction is the fully-shuffled extreme (every note random).
      const dir = (entry && entry.dir) || arp.dir || 'up';
      const rnd = Math.max(0, Math.min(100, arp.randomness | 0)) / 100;
      let idx;
      if (len <= 1) idx = 0;
      else if (dir === 'random') idx = Math.floor(_ambRand() * len);
      else if (rnd > 0 && _ambRand() < rnd) idx = Math.floor(_ambRand() * len);
      else idx = _ambArpIndexFor(dir, st.note, len);
      // Advance the pass / entry cursor for NEXT time.
      st.note += 1;
      if (st.note >= _ambArpEntryNotes(entry, dir, len)) { st.note = 0; st.pos = 0; const _wasLast = (st.entry >= steps.length - 1); st.entry = (st.entry + 1) % steps.length; if (_wasLast) st._loop = (st._loop | 0) + 1; }
      // Rests skip the note (cursor already advanced, so timing stays steady).
      if (_ambRand() * 100 < Math.max(0, Math.min(100, arp.restProb | 0))) return;
      // Resolve an ASCENDING pool: degree d within octave o, lifted so chord/scale
      // tones keep climbing across octaves (no pitch-class wrap inside one octave).
      // `carry` lifts a tone whose absolute pc already crossed the octave; passing
      // the raw interval to _ambNoteFreq still applies scale microtuning.
      const d = idx % N, o = Math.floor(idx / N);
      const carry = Math.floor((_ambSrcRootPc(notes) + (intervals[d] | 0)) / 12);
      const f = _ambNoteFreq(intervals[d] | 0, base + o + carry, notes);
      if (f == null) return;
      const lenMs = Math.max(40, arp.lengthMs | 0);
      const pan = _ambLayerPan(arp);
      const ap = _ambMotifParams(lenMs, pan, arp.tone);
      ap.volume = _ambAccentVol(_ambApplyLevel(ap.volume, arp.level), arp.accent);
      const dmod = _ambLayerDetuneMod(key); if (dmod) ap._detuneMod = dmod;
      try { playNote(f, ap, lenMs, at, _ambLayerDest(key), undefined, _E.laneIdx()); } catch (e) {}
      } finally { if (_arpProg) _ambProgStepOverride = null; }
    }

    // ================= BEAT engine ==================================
    // Works like Motif (per-event generative trigger on its own Interval),
    // but instead of a melodic scale-walk it fires DRUM samples from a chosen
    // kit. Drum kits map pitch classes to drums (C2 kick … B2 perc); each
    // event picks a weighted-random drum so kicks/snares/hats dominate. The
    // hits run through the per-note sample ADSR, so Length chokes (short) or
    // opens (long) the tails — a short hat vs. an open one.
    const _AMB_DRUMS = [
      { pc: 0,  w: 3 }, // kick   C2
      { pc: 2,  w: 2 }, // snare  D2
      { pc: 4,  w: 5 }, // closed hat E2
      { pc: 5,  w: 1 }, // open hat   F2
      { pc: 3,  w: 1 }, // clap   D#2
      { pc: 7,  w: 1 }, // mid tom G2
      { pc: 9,  w: 1 }, // crash  A2
      { pc: 11, w: 1 }, // perc   B2
    ];
    const _AMB_DRUM_WTOTAL = _AMB_DRUMS.reduce((s, d) => s + d.w, 0);
    // Pitch-class → drum label (C2 = pc 0). Used by the master-Shape chip so a
    // Beat layer reads "Kick / Snare / Hat", not a note name.
    const _AMB_DRUM_NAMES = { 0: 'Kick', 2: 'Snare', 3: 'Clap', 4: 'Hat', 5: 'Open hat', 7: 'Tom', 9: 'Crash', 11: 'Perc' };
    function _ambDrumName(midi) {
      const pc = (((Math.round(midi) - 36) % 12) + 12) % 12;
      return _AMB_DRUM_NAMES[pc] || ('Drum ' + pc);
    }
    // Melodic tone choices for Bed/Motif/Texture: "Grid voice" + every
    // non-drum tone the app offers.
    // Melodic tones for Bed/Motif/Texture (drum kits excluded — Beat owns those).
    // The "Grid voice" follow option is added separately at wiring time, so this
    // returns only the instruments and can be fed straight to the grouped builder.
    // Label for the "follow the grid voice" option ('' tone): show the actual
    // voice the grid is currently using (cell 0) rather than the generic "Grid
    // voice", so the dropdown reads e.g. "Sawtooth (grid)". Falls back to the
    // generic label when no grid voice is determinable.
    function _ambGridVoiceLabel() {
      try {
        const t = (typeof cellParams !== 'undefined' && cellParams[0] && cellParams[0].type) ? cellParams[0].type : null;
        if (t && typeof getAllSoundOptions === 'function') {
          const o = getAllSoundOptions().find(x => x.value === t);
          if (o && o.label) return o.label + ' (grid)';
        }
      } catch (e) {}
      return 'Grid voice';
    }
    function _ambGridVoiceOption() { return { value: '', label: _ambGridVoiceLabel() }; }
    function _ambToneOptions() {
      const out = [];
      try {
        if (typeof getAllSoundOptions === 'function') {
          getAllSoundOptions().forEach(o => {
            if (typeof o.value === 'string' && o.value.startsWith('sample:')) {
              const info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(o.value.slice(7)) : null;
              if (info && info.drumKit) return; // drums belong to Beat
            }
            out.push(o);
          });
        }
      } catch (e) {}
      return out;
    }
    // Re-populate this engine's per-layer Tone dropdowns from the current voice
    // list (so newly-created ensembles / imported samples appear without a full
    // panel rebuild). Preserves each select's current value when still valid.
    function _ambRefreshToneSelects(E) {
      const host = document.getElementById(E.hostId); if (!host) return;
      if (typeof populateGroupedToneSelect !== 'function') return;
      const opts = _ambToneOptions();
      host.querySelectorAll('select[id$="-tone"]').forEach(sel => {
        const cur = sel.value;
        populateGroupedToneSelect(sel, opts, _ambGridVoiceOption());
        sel.value = cur;
        if (sel.value !== cur) sel.value = ''; // chosen voice no longer exists → Grid voice
        // Seq layers show the FIRST step's tone (not a blank Grid-voice default)
        // when the layer Tone isn't explicitly overridden.
        const m = sel.id.match(/seq-(\d+)-tone$/);
        if (m) {
          const c = E.getCfg();
          const sq = (c && Array.isArray(c.seqs)) ? c.seqs.find(x => (x.id | 0) === parseInt(m[1], 10)) : null;
          if (sq) { const t = _ambSeqStepTone(sq, 0); if (t) sel.value = t; }
        }
      });
    }
    function _ambRefreshAllToneSelects() {
      try { if (_laneEng && _laneEng.inited) _ambRefreshToneSelects(_laneEng); } catch (e) {}
      try { if (_masterEng && _masterEng.inited) _ambRefreshToneSelects(_masterEng); } catch (e) {}
    }
    function _ambDrumKits() {
      const kits = [];
      try {
        if (typeof sampleSamplers !== 'undefined') {
          for (const [id, info] of sampleSamplers) {
            if (info && info.drumKit) kits.push({ id, name: info.name || id });
          }
        }
      } catch (e) {}
      if (!kits.length) kits.push({ id: 'tr808', name: 'TR-808' });
      return kits;
    }
    function _ambPickDrumPc() {
      let r = _ambRand() * _AMB_DRUM_WTOTAL;
      for (const d of _AMB_DRUMS) { if ((r -= d.w) < 0) return d.pc; }
      return 0;
    }
    function _ambBeatParams(kit, lenMs, pan) {
      // Percussive envelope; Length drives the release tail (the choke/open).
      const rel = Math.max(20, Math.round(Math.max(60, lenMs) * 0.6));
      const type = 'sample:' + kit;
      return {
        type,
        attack: 1, decay: 60, sustain: 70, release: rel,
        // Drums are always samples → cancel the +12 dB boost so a beat hit
        // sits at synth-equivalent level instead of slamming the limiter.
        volume: Math.max(2, Math.round(72 * _ambBoostComp(type))),
        pan: pan | 0,
      };
    }
    function _ambEmitBeat(at, beat, space, key) {
      key = key || 'beat';
      if (_ambRand() * 100 < Math.max(0, Math.min(100, beat.restProb | 0))) return;
      const pc = _ambPickDrumPc();
      const midi = 36 + pc; // C2 = 36
      let f;
      try { f = Tone.Frequency(midi, 'midi').toFrequency(); } catch (e) { return; }
      const lenMs = Math.max(60, beat.lengthMs | 0);
      const pan = _ambLayerPan(beat);
      const bp = _ambBeatParams(beat.kit, lenMs, pan);
      bp.volume = _ambApplyLevel(bp.volume, beat.level);
      const dmod = _ambLayerDetuneMod(key); if (dmod) bp._detuneMod = dmod;
      try { playNote(f, bp, lenMs, at, _ambLayerDest(key), undefined, _E.laneIdx()); } catch (e) {}
    }
    // Euclidean Beat: a BPM-locked drum pattern over `bars` bars. Windowed/
    // phase-anchored like Bass (uses E.runPhase) so the seed pattern + per-cycle
    // Rhythm-var stay locked to the tempo and the UNIT is a whole phrase (the
    // status bar / unit length span the bars, not a single hit). Each euclidean
    // pulse fires a drum from the layer's kit (random drum per hit, like the
    // simple Beat). `when` applies per phrase cycle.
    function _ambEmitBeatEuclid(E, inst, key, now, horizon, lead, space, cfg) {
      if (!E.runPhase) E.runPhase = {};
      if (typeof euclideanPattern !== 'function') return;
      const bpm = _ambBpm();
      const barSec = (60 / bpm) * 4 * _ambLayerScale(E, key, inst, cfg);   // 4/4, Unit-Sync scaled
      const bars   = Math.max(1, Math.min(8, inst.bars | 0) || 1);
      const phraseSec = bars * barSec;
      if (!(phraseSec > 0.05)) return;
      const loopSec = phraseSec + Math.max(0, (inst.unitPadMs | 0)) / 1000;   // + silent pad (Unit Match)
      const steps  = Math.max(2, Math.min(16, inst.steps | 0) || 8);
      const pulses = Math.max(1, Math.min(steps, inst.pulses | 0) || 1);
      const rotate = Math.max(0, inst.rotate | 0);
      const slotSec = barSec / steps;
      const lenMs  = Math.max(60, inst.lengthMs | 0);
      const rVar   = Math.max(0, Math.min(100, inst.rhythmVar | 0));
      const restP  = Math.max(0, Math.min(100, inst.restProb | 0));
      const pan    = _ambLayerPan(inst);
      const dest   = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      const pat    = euclideanPattern(pulses, steps, rotate);   // base euclidean seed

      let st = E.runPhase[key];
      if (!st) st = E.runPhase[key] = { startAt: lead + _ambDriftOffset(inst, cfg), lastAt: null };
      const tFrom = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
      const tTo = horizon;
      if (tTo <= tFrom) { st.lastAt = Math.max(st.lastAt || 0, tTo); return; }

      const cFrom = Math.max(0, Math.floor((tFrom - st.startAt) / loopSec));
      const cTo   = Math.floor((tTo - st.startAt) / loopSec);
      let cap = 0;
      for (let c = cFrom; c <= cTo && cap < 256; c++) {
        if (!_ambCondFires(inst.when, c)) continue;
        const cStart = st.startAt + c * loopSec;
        // Deterministic per-cycle RNG — stable across ticks, evolves per cycle.
        const rnd = _ambSeededRand(((inst.id | 0) * 2654435761) ^ ((c + 1) * 2246822519) ^ ((cfg && cfg.seed | 0) * 40503));
        for (let bar = 0; bar < bars; bar++) {
          for (let slot = 0; slot < steps; slot++) {
            let hit = pat[slot] === 1;
            if (rVar > 0) {
              if (hit) { if (rnd() * 100 < rVar * 0.40) hit = false; }   // drop a seed hit
              else      { if (rnd() * 100 < rVar * 0.22) hit = true; }   // add a ghost hit
            }
            if (!hit) continue;
            if (restP > 0 && rnd() * 100 < restP) continue;
            const at = cStart + (bar * steps + slot) * slotSec;
            if (at < tFrom || at >= tTo) continue;
            const pc = _ambPickDrumPc();
            let f; try { f = Tone.Frequency(36 + pc, 'midi').toFrequency(); } catch (e) { continue; }
            const bp = _ambBeatParams(inst.kit, lenMs, pan);
            bp.volume = _ambApplyLevel(bp.volume, inst.level);
            if (dmod) bp._detuneMod = dmod;
            _ambKeyTime = at;
            try { playNote(f, bp, lenMs, at, dest, undefined, _E.laneIdx()); } catch (e) {}
            cap++;
            if (cap >= 256) break;
          }
          if (cap >= 256) break;
        }
      }
      st.lastAt = tTo;
    }

    // ================= SEQ engine ===================================
    // The sequence-seeded layer. Created by "Send to Bloom layer": a saved
    // sequence is distilled into `seq.seed.events` (ordered {freqs,durMs,vel};
    // freqs=[] is a rest). Each generator fire plays ONE full phrase — the whole
    // seed walked in time by each event's own durMs — so the layer's iteration
    // counter (`_ambSeqIter`) counts CYCLES. Per cycle it either plays the phrase
    // verbatim (the periodic "return to original") or improvises a variation.
    function _seqSeedFromSaved(saved) {
      if (!saved || !Array.isArray(saved.steps)) return null;
      const bpm = Math.max(20, parseInt(saved.bpm, 10) || 120);
      const gsub = (typeof stepSubdivision === 'number' && stepSubdivision > 0) ? stepSubdivision : 0.5;
      const events = [];
      const pushFrom = (step) => {
        if (!step) return;
        const stepDur = step.duration || 1;
        const stepSub = (step.subdivision != null) ? step.subdivision : gsub;
        const durMs = Math.max(20, Math.round((60 / bpm) * stepSub * stepDur * 1000));
        if (Array.isArray(step.chord) && step.chord.length) {
          const playable = step.chord.filter(n => n && n.freq != null);
          const freqs = playable.map(n => n.freq);
          const sounds = playable.map(n => n.sound || null); // per-voice source tone (merge preserves these)
          const vel = step.chord.reduce((m, n) => Math.max(m, (n && n.params && Number.isFinite(n.params.volume)) ? n.params.volume : 100), 0) || 100;
          events.push({ freqs, sounds, durMs, vel });
        } else if (step.freq != null) {
          const vel = (step.params && Number.isFinite(step.params.volume)) ? step.params.volume : 100;
          events.push({ freqs: [step.freq], sounds: [step.sound || null], durMs, vel });
        } else {
          events.push({ freqs: [], sounds: [], durMs, vel: 0 }); // rest preserves timing
        }
      };
      saved.steps.forEach(s => {
        if (s && Array.isArray(s.subSteps) && s.subSteps.length) s.subSteps.forEach(pushFrom);
        else pushFrom(s);
      });
      if (!events.length) return null;
      // Capture the source's grid voice (cell 0) so the Bloom layer plays with
      // the settings the sequence was MADE with — not whatever lane happens to
      // be active (critical for the lane-agnostic master Bloom).
      let voice = null;
      try { if (Array.isArray(saved.cellParams) && saved.cellParams[0]) voice = JSON.parse(JSON.stringify(saved.cellParams[0])); } catch (e) {}
      return { events, voice, scale: saved.scale || '', rootIdx: saved.rootIdx | 0, baseOctave: saved.baseOctave | 0, bpm,
               name: (typeof saved.name === 'string' && saved.name) ? saved.name : '', reps: 1 };
    }
    // Nudge an absolute freq to a nearby scale degree (seeded random walk).
    // Probability of moving = depth; magnitude 1..(1+2·depth) degrees.
    function _seqNudgeFreq(freq, intervals, N, depth, scale) {
      if (!(freq > 0) || N < 1) return freq;
      if (_ambRand() >= Math.max(0, Math.min(1, depth))) return freq; // mostly unchanged at low depth
      let bestDeg = 0, bestOct = 4, best = Infinity;
      for (let oct = 1; oct <= 8; oct++) {
        for (let d = 0; d < N; d++) {
          const cand = _ambDegreeFreq(d, oct, scale);
          if (!(cand > 0)) continue;
          const e = Math.abs(Math.log2(cand / freq));
          if (e < best) { best = e; bestDeg = d; bestOct = oct; }
        }
      }
      const mag = 1 + Math.floor(_ambRand() * (1 + Math.round(depth * 2)));
      const lin = bestOct * N + bestDeg + (_ambRand() < 0.5 ? -1 : 1) * mag;
      const deg = ((lin % N) + N) % N;
      const oct = Math.max(1, Math.min(8, Math.floor(lin / N)));
      const out = _ambDegreeFreq(deg, oct, scale);
      if (!(out > 0)) return freq;
      // Blue notes: the nudge stays strictly in-key until depth crosses 3/4,
      // above which chromatic (out-of-scale) inflections ramp in (0 at 0.75 →
      // ~0.5 chance at 1.0) — a bluesy bend a semitone off the scale tone.
      if (depth >= 0.75) {
        const blueChance = ((depth - 0.75) / 0.25) * 0.5;
        if (_ambRand() < blueChance) {
          const blue = out * Math.pow(2, ((_ambRand() < 0.5) ? -1 : 1) / 12);
          if (blue > 0) return blue;
        }
      }
      return out;
    }
    // SAMPLE layer: play a single-buffer sample raw. chop=1 retriggers the whole
    // sample; chop=N plays N step-sized slices across the Interval, forward or
    // shuffled. Skips silently until the buffer is loaded (no sine fallback).
    function _ambEmitSample(at, layer, space, st) {
      if (!layer.sampleId) return;
      let info = null;
      try { info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(layer.sampleId) : null; } catch (e) {}
      if (!info || !info.sampler || !info.sampler.loaded) return;
      const key = 'samp:' + layer.id;
      const dest = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' };
      const type = 'sample:' + layer.sampleId;
      let baseFreq;
      try { baseFreq = Tone.Frequency(info.rootNote || 'C4').toFrequency(); } catch (e) { baseFreq = 261.63; }
      const chop = Math.max(1, Math.min(16, layer.chop | 0));
      const sliceSec = Math.max(0.02, (layer.intervalMs | 0) / 1000 / chop);
      const vol = _ambApplyLevel(100, layer.level);
      const pans = _ambLayerPans(layer, chop);
      for (let j = 0; j < chop; j++) {
        const idx = (chop === 1) ? 0 : (layer.order === 'random' ? Math.floor(_ambRand() * chop) : j);
        const dur = (chop > 1) ? sliceSec * 1000 : Math.max(80, layer.lengthMs | 0);
        const p = { ...base, type,
          attack: 6, decay: 120, sustain: 70, release: Math.max(60, Math.round(dur * 0.5)),
          volume: vol, pan: (pans[j] | 0) };
        if (chop > 1) { p.sampleOffsetSec = idx * sliceSec; p.sliceDurSec = sliceSec; }
        if (dmod) p._detuneMod = dmod;
        try { playNote(baseFreq, p, dur, at + j * sliceSec, dest, undefined, _E.laneIdx()); } catch (e) {}
      }
    }
    // Realize ONE iteration of a seq into a concrete, schedulable plan:
    //   { events:[{freqs,durMs,vel,sounds,padStyle,offMs}], advanceMs, ctx, baseAt, cur }
    // All the per-cycle generative decisions (unit pick, verbatim, pad/pitch/
    // rhythm vary) are made HERE, once. The scheduler then emits the plan's
    // events at their own pace — windowed across ticks in auto mode so a long
    // phrase doesn't dump its entire node creation in a single tick (the burst
    // that glitched/cut out long seq layers ~4/5 through each phrase).
    // Tone shown for a Seq layer's step `idx` (the value its Tone dropdown
    // should display): an explicit layer Tone overrides; otherwise the step's
    // own captured voice (unit event sounds), falling back to the unit voice.
    function _ambSeqStepTone(seq, idx) {
      if (seq && seq.tone && seq.tone !== '') return seq.tone;
      const u = (seq && Array.isArray(seq.units) && seq.units[0]) ? seq.units[0] : null;
      const evs = (u && Array.isArray(u.events)) ? u.events : [];
      const ev = evs[idx | 0] || evs[0];
      if (ev && Array.isArray(ev.sounds) && ev.sounds[0]) return ev.sounds[0];
      if (u && u.voice && u.voice.type) return u.voice.type;
      return 'sine';
    }
    // Live-reflect a Seq layer's Tone dropdown to the tone now playing (cheap:
    // once per loop, only when the value actually changes / the panel is up).
    function _ambSeqReflectTone(E, seqId, tone) {
      if (!tone) return;
      const sel = document.getElementById(_ambTrId(E, 'ambient-seq-' + seqId + '-tone'));
      if (sel && sel.value !== tone) { try { sel.value = tone; } catch (e) {} }
    }
    // Pick which section (unit) plays THIS phrase, advancing the per-layer
    // section state on `st`. Two modes:
    //  • 'sequence' (ordered) — play each unit `reps` times, then the next, loop.
    //  • 'random' (bag) — a pool of Σreps picks (each unit repeated `reps`×),
    //    drawn WITHOUT replacement; when the bag empties it refills (a fresh full
    //    schedule). Legacy 'interleave'/'single' map to random/sequence.
    function _ambSeqPickUnitIdx(seq, st) {
      const n = seq.units.length;
      if (n <= 1) return 0;
      const repsOf = (i) => Math.max(1, (seq.units[i] && (seq.units[i].reps | 0)) || 1);
      const mode = (seq.unitMode === 'random' || seq.unitMode === 'interleave') ? 'random' : 'sequence';
      if (mode === 'random') {
        if (!Array.isArray(st.bag) || !st.bag.length) {
          st.bag = [];
          for (let i = 0; i < n; i++) { const r = repsOf(i); for (let k = 0; k < r; k++) st.bag.push(i); }
        }
        const j = Math.floor(_ambRand() * st.bag.length);
        const idx = st.bag[j]; st.bag.splice(j, 1);
        return ((idx % n) + n) % n;
      }
      // ordered: hold the current unit for its reps, then advance.
      if (!Number.isFinite(st.secIdx)) { st.secIdx = 0; st.secRep = 0; }
      const idx = ((st.secIdx % n) + n) % n;
      st.secRep = (st.secRep | 0) + 1;
      if (st.secRep >= repsOf(idx)) { st.secRep = 0; st.secIdx = (idx + 1) % n; }
      return idx;
    }
    // keyMaster: when a Seq flagged keyMaster commits a section starting at time
    // `at`, PUBLISH that section's key onto the time-indexed schedule (instead of
    // flipping the global key now, ~1.4 s early). Generative layers then resolve
    // the key per note-time, flipping exactly on the boundary; the grid follows
    // via a deferred apply once wall-clock reaches `at` (see _ambApplyDueKey).
    // Master Bloom only.
    function _ambSeqDriveKey(E, unit, at) {
      if (!unit || !E || E.isLane) return;
      const scaleName = (unit.scale && typeof SCALES !== 'undefined' && SCALES[unit.scale]) ? unit.scale : 'chromatic';
      const root = (((unit.rootIdx | 0) % 12) + 12) % 12;
      _ambKeySchedPush(E, at, root, scaleName);
    }
    // Apply any key-schedule boundary whose time has arrived to the GLOBAL key
    // (grid + Bloom cfg). Called each tick. Generative layers don't need this —
    // they resolve per note-time — but the grid is single global state, so it
    // flips here, on the boundary, rather than early.
    function _ambApplyDueKey(E, now) {
      const sched = E && E._keySched;
      if (!Array.isArray(sched) || !sched.length) return;
      let due = null;
      for (let i = 0; i < sched.length; i++) { const e = sched[i]; if (!e.applied && e.at <= now && (!due || e.at >= due.at)) due = e; }
      if (!due) return;
      sched.forEach(e => { if (e.at <= now) e.applied = true; });
      try { if (typeof _applyKeyContext === 'function') _applyKeyContext({ root: due.root, scale: due.scale }); } catch (e) {}
      const cfg = E._cfg || (E.getCfg && E.getCfg());
      if (cfg) { cfg.keyRoot = due.root; cfg.keyScale = due.scale; }
    }
    function _ambRealizeSeqPhrase(at, seq, space, st) {
      _ambKeyTime = null;   // Seq variance uses the normal cfg/global key, not a stale generative note-time
      if (!Array.isArray(seq.units) || !seq.units.length) return null;
      let unit;
      if (seq.units.length > 1) {
        st.pick = _ambSeqPickUnitIdx(seq, st);
        unit = seq.units[st.pick];
        // Publish the section's key at its start time (boundary) on change only.
        if (seq.keyMaster && st._keyUnit !== st.pick) {
          st._keyUnit = st.pick;
          try { _ambSeqDriveKey(_E, unit, at); } catch (e) {}
        }
      } else {
        st.pick = 0;
        unit = seq.units[0];
        if (seq.keyMaster && st._keyUnit !== 0) { st._keyUnit = 0; try { _ambSeqDriveKey(_E, unit, at); } catch (e) {} }
      }
      if (!_ambValidUnit(unit)) return null;
      // Record THIS pass's unit length so the scheduler advances the loop by
      // exactly one sequence in auto mode (per-picked-unit in Interleave).
      if (st) st._lastUnitMs = _unitTotalMs(unit);
      const seed = unit;
      const key = 'seq:' + seq.id;
      const depth = Math.max(0, Math.min(100, seq.varyDepth | 0)) / 100;
      // Voice base: the unit's CAPTURED voice (from the source lane at send
      // time) so playback is lane-agnostic — falls back to the live grid only
      // for legacy units with no captured voice.
      const base = (unit && unit.voice) ? unit.voice
        : ((typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' });
      const fallbackType = (base && base.type) ? base.type : 'sine';
      const type = (seq.tone && seq.tone !== '') ? seq.tone : fallbackType;
      // When the layer Tone is "Grid voice" ('') we honor each note's own
      // captured source voice (piano notes as piano, square as square, an
      // ensemble as that ensemble); an explicit layer Tone overrides uniformly.
      const layerSet = !!(seq.tone && seq.tone !== '');
      // Ensemble lock: locked (default) → an ensemble-voiced note fires ALL its
      // members together; unlocked → members spread across notes (one per note,
      // rotating). dest/dmod are resolved per-event at emit time (the mod chain
      // can rebuild between ticks), so only the stable bits live in ctx.
      const seqEnsLock = (seq.ensembleLock !== false);
      const ctx = { seq, key, base, type, layerSet, seqEnsLock };
      // Verbatim (return-to-original) decision for THIS cycle.
      let verbatim;
      if (seq.returnMode === 'chance') {
        verbatim = (_ambRand() * 100) < Math.max(0, Math.min(100, seq.returnChance | 0));
      } else {
        const Nr = Math.max(1, seq.returnN | 0);
        verbatim = (((st && st.iter) | 0) % Nr) === 0;
      }
      const events = [];
      const advanceMs = (st && st._lastUnitMs > 0) ? st._lastUnitMs : _unitTotalMs(seed);
      // PAD mode (non-verbatim): ignore rhythm, build one sustained voicing from
      // the seed's note pool, sized by depth.
      if (seq.varyMode === 'pad' && !verbatim) {
        const pool = [];
        let poolVel = 0;
        seed.events.forEach(e => { e.freqs.forEach(f => pool.push(f)); if (e.vel > poolVel) poolVel = e.vel; });
        if (pool.length) {
          const want = Math.max(1, Math.min(pool.length, 2 + Math.round(depth * (pool.length - 2))));
          const chosen = []; const used = new Set(); let g = 0;
          while (chosen.length < want && g++ < 64) { const i = Math.floor(_ambRand() * pool.length); if (!used.has(i)) { used.add(i); chosen.push(pool[i]); } }
          chosen.sort((a, b) => a - b);
          events.push({ freqs: chosen, durMs: Math.max(300, seq.lengthMs | 0), vel: poolVel || 100, sounds: null, padStyle: true, offMs: 0 });
        }
        return { events, advanceMs, ctx, baseAt: at, cur: 0 };
      }
      // PITCH / RHYTHM / verbatim: walk the phrase, accumulating an ms offset.
      const intervals = _ambScaleIntervals(_ambNotesOf(seq));
      const N = Math.max(1, intervals.length);
      let off = 0;
      for (let i = 0; i < seed.events.length; i++) {
        const ev = seed.events[i];
        let durMs = Math.max(20, ev.durMs | 0);
        let freqs = ev.freqs;
        if (!verbatim && seq.varyMode === 'rhythm') {
          if (freqs.length && _ambRand() < 0.12 * depth) { off += durMs; continue; } // drop step
          durMs = Math.max(40, Math.round(durMs * (1 + (_ambRand() * 2 - 1) * 0.6 * depth)));
        }
        if (!verbatim && freqs.length && (seq.varyMode === 'pitch' || seq.varyMode === 'rhythm')) {
          if (_ambRand() < 0.15 * depth) { off += durMs; continue; } // drop note (keep timing)
          freqs = freqs.map(f => _seqNudgeFreq(f, intervals, N, depth, _ambNotesOf(seq)));
        }
        events.push({ freqs, durMs, vel: ev.vel, sounds: ev.sounds, padStyle: false, offMs: off });
        off += durMs;
      }
      // RHYTHM mode: occasionally append an extra nudged echo at the phrase tail.
      if (!verbatim && seq.varyMode === 'rhythm' && _ambRand() < 0.2 * depth) {
        const ev = seed.events[Math.floor(_ambRand() * seed.events.length)];
        if (ev && ev.freqs.length) {
          events.push({ freqs: ev.freqs.map(f => _seqNudgeFreq(f, intervals, N, depth, _ambNotesOf(seq))), durMs: Math.max(40, ev.durMs | 0), vel: ev.vel, sounds: ev.sounds, padStyle: false, offMs: off });
        }
      }
      return { events, advanceMs, ctx, baseAt: at, cur: 0 };
    }
    // Emit ONE realized event at an absolute time. dest/dmod resolved fresh so
    // a mod-chain rebuild between ticks can't strand a phrase on a dead node.
    function _ambEmitSeqEvent(ctx, ev, atAbs, st) {
      const freqs = ev.freqs;
      if (!freqs || !freqs.length) return;
      const seq = ctx.seq;
      const dest = _ambLayerDest(ctx.key), dmod = _ambLayerDetuneMod(ctx.key);
      const durMs = ev.durMs, padStyle = ev.padStyle, sounds = ev.sounds;
      const base = ctx.base, type = ctx.type, layerSet = ctx.layerSet, seqEnsLock = ctx.seqEnsLock;
      // Spread on a melodic (single-note) sequence has nothing to fan across, so
      // a lone note gets its own pan; chords fan their voices across the field.
      const pans = (freqs.length > 1) ? _ambLayerPans(seq, freqs.length) : [_ambLayerPan(seq)];
      const vol = _ambAccentVol(_ambApplyLevel(Math.round((ev.vel || 100) * (padStyle ? 0.5 : 0.6)), seq.level), seq.accent);
      let _ensPick = (st && Number.isFinite(st._ensPick)) ? st._ensPick : 0;
      freqs.forEach((f, vi) => {
        const vtype = layerSet ? type : ((sounds && sounds[vi]) || type);
        const p = padStyle
          ? { ...base, type: vtype, attack: Math.max(150, Math.round(durMs * 0.30)), decay: 200, sustain: 85, release: Math.max(300, Math.round(durMs * 0.50)), volume: vol, pan: pans[vi] }
          : { ...base, type: vtype, attack: Math.max(8, Math.round(durMs * 0.10)), decay: 120, sustain: 70, release: Math.max(60, Math.round(durMs * 0.50)), volume: vol, pan: pans[vi] };
        if (isEnsembleType(vtype)) {
          if (seqEnsLock) p._ensembleForceStack = true;   // locked: all members together
          else p._ensembleMemberIdx = _ensPick++;          // unlocked: one member per note, rotating
        }
        if (dmod) p._detuneMod = dmod;
        try { playNote(f, p, durMs, atAbs + vi * 0.006, dest, undefined, _E.laneIdx()); } catch (e) {}
      });
      if (st) st._ensPick = _ensPick; // carry the unlocked-ensemble rotation across fires
    }
    // Whole-phrase emit (manual interval mode, where phrases can overlap and the
    // single-plan windowing model doesn't apply). Realize + emit every event now.
    function _ambEmitSeq(at, seq, space, st) {
      const plan = _ambRealizeSeqPhrase(at, seq, space, st);
      if (!plan) return;
      for (let i = 0; i < plan.events.length; i++) {
        const ev = plan.events[i];
        _ambEmitSeqEvent(plan.ctx, ev, plan.baseAt + ev.offMs / 1000, st);
      }
    }

    // ================= Modulation (VCO / VCA / VCF) =================
    // Continuous per-layer modulation. When a layer has any non-zero mod depth,
    // its voices route through a persistent chain:
    //   voices -> VCF (Tone.Filter) -> VCA (Tone.Gain) -> lane bus
    // Each of the three targets (VCA gain, VCF cutoff, VCO detune) has its OWN
    // depth + rate + shape. The modulation source is either:
    //   • periodic  — a Tone.LFO (sine / triangle / sawtooth / square), OR
    //   • stochastic — a Tone.Signal driven by scheduled random values:
    //       'smooth' ramps between random targets (a wandering LFO),
    //       'sharp'  steps to random targets (sample & hold).
    // VCA/VCF sources connect to their param; the VCO source connects to each
    // voice's detune at emit (additive vibrato). Rate maps to Hz (free) or a
    // musical division (sync, following the global timing toggle).
    // per-layer mod chains live on the engine: _E.mod  (key -> { input, vcf, vca, src })
    const _AMB_MOD_SHAPES = ['sine', 'triangle', 'sawtooth', 'square', 'smooth', 'sharp'];
    function _ambIsStochastic(shape) { return shape === 'smooth' || shape === 'sharp'; }
    function _ambModActive(m) {
      return !!(m && (((m.vca && m.vca.depth) | 0) > 0 || ((m.vco && m.vco.depth) | 0) > 0 || ((m.vcf && m.vcf.depth) | 0) > 0));
    }
    function _ambModRateHz(rate, cfg) {
      const r = Math.max(0, Math.min(100, rate | 0)) / 100;
      if (cfg && cfg.timing === 'sync') {
        const beatsArr = [8, 4, 2, 1, 0.5, 0.25]; // slow -> fast, in beats/cycle
        const beats = beatsArr[Math.min(beatsArr.length - 1, Math.round(r * (beatsArr.length - 1)))];
        return (_ambBpm() / 60) / beats;
      }
      const lo = 0.02, hi = 8; // Hz (free): ~50 s cycle -> 8 Hz
      return lo * Math.pow(hi / lo, r);
    }
    function _ambTargetRange(target, depth) {
      const d = Math.max(0, Math.min(100, depth | 0)) / 100;
      if (target === 'vca') return [1 - d, 1];
      if (target === 'vcf') return [200, 200 + d * 8000];
      return [-d * 100, d * 100]; // vco: ± cents
    }
    // (routing moved to _E.busNode())
    function _ambDisposeSrc(src) {
      if (!src || !src.node) return;
      try { if (typeof src.node.stop === 'function' && !src.stochastic) src.node.stop(); } catch (e) {}
      try { src.node.disconnect(); } catch (e) {}
      try { src.node.dispose(); } catch (e) {}
    }
    function _ambResetTargetParam(e, target) {
      try {
        if (target === 'vca') e.vca.gain.value = 1;
        else if (target === 'vcf') e.vcf.frequency.value = 20000;
      } catch (x) {}
    }
    function _ambMakeSrc(e, target, shape, hz, min, max, t) {
      const isSeq = (shape === 'seq');
      const stochastic = _ambIsStochastic(shape);
      const src = { target, kind: isSeq ? 'seq' : (stochastic ? 'sh' : 'lfo'), stochastic, seq: isSeq, min, max };
      let node;
      try {
        if (isSeq || stochastic) {
          node = new Tone.Signal((min + max) / 2);
          if (isSeq) {
            src.curve = _seqRefCurve(t || {});
            src.smooth = !!(t && t.seqInterp === 'smooth');
            src.periodSec = 1 / Math.max(0.001, hz);
          } else {
            src.smooth = (shape === 'smooth');
            src.intervalSec = 1 / Math.max(0.001, hz);
          }
          src.nextAt = 0;
        } else {
          node = new Tone.LFO({ frequency: hz, type: shape, min, max });
          node.start();
        }
        src.node = node;
        if (target === 'vca') { e.vca.gain.value = 0; node.connect(e.vca.gain); }
        else if (target === 'vcf') { e.vcf.frequency.value = 0; node.connect(e.vcf.frequency); }
        // vco: connected to voices at emit via _ambLayerDetuneMod.
      } catch (x) { try { node && node.dispose(); } catch (y) {} return null; }
      return src;
    }
    // Reconcile one target's source against the config (build / update / drop).
    function _ambSyncTarget(e, layer, target, cfg) {
      const t = (cfg[layer].mod && cfg[layer].mod[target]) || {};
      const depth = t.depth | 0;
      const existing = e.src[target];
      if (depth <= 0) {
        if (existing) { _ambDisposeSrc(existing); e.src[target] = null; _ambResetTargetParam(e, target); }
        return;
      }
      const shape = (t.shape === 'seq' || _AMB_MOD_SHAPES.indexOf(t.shape) >= 0) ? t.shape : 'sine';
      const kind = (shape === 'seq') ? 'seq' : (_ambIsStochastic(shape) ? 'sh' : 'lfo');
      const hz = _ambModRateHz(t.rate, cfg);
      const range = _ambTargetRange(target, depth);
      // Rebuild when the kind (lfo / stochastic / seq) changes or none exists.
      if (!existing || existing.kind !== kind) {
        if (existing) _ambDisposeSrc(existing);
        e.src[target] = _ambMakeSrc(e, target, shape, hz, range[0], range[1], t);
        return;
      }
      // Update in place.
      existing.min = range[0]; existing.max = range[1];
      if (kind === 'seq') {
        existing.curve = _seqRefCurve(t);
        existing.smooth = (t.seqInterp === 'smooth');
        existing.periodSec = 1 / Math.max(0.001, hz);
      } else if (kind === 'sh') {
        existing.smooth = (shape === 'smooth');
        existing.intervalSec = 1 / Math.max(0.001, hz);
      } else {
        try { existing.node.frequency.value = hz; existing.node.type = shape; existing.node.min = range[0]; existing.node.max = range[1]; } catch (x) {}
      }
    }
    // Dedicated per-engine reverb (a send/return). Each layer's reverb-send gain
    // feeds it; its fully-wet output returns to the engine's bus.
    // Whether Bloom reverbs should use the lush convolution engine (default) or
    // classic Freeverb — follows the global FX reverb type so one toggle covers
    // master + Bloom.
    function _ambUseConvReverb() {
      return !(typeof globalFx !== 'undefined' && globalFx && globalFx.reverbType === 'freeverb')
        && typeof Tone !== 'undefined' && typeof Tone.Convolver === 'function'
        && typeof _makeReverbIR === 'function';
    }
    function _ambEnsureReverb() {
      if (_E.reverb) return _E.reverb;
      if (typeof Tone === 'undefined') return null;
      const conv = _ambUseConvReverb();
      try {
        if (conv) {
          _E.reverb = new Tone.Convolver({ normalize: true });
          _E.reverb.connect(_E.busNode());
          _E._revConv = true; _E._revIRKey = '';
          // Set the initial IR synchronously so there's no startup silence.
          const cfg = _E.getCfg(), rv = (cfg && cfg.reverb) ? cfg.reverb : { size: 80, damp: 50 };
          const decay = _reverbDecaySec(rv.size | 0), tone = _reverbToneNorm(rv.damp | 0);
          try { _E.reverb.buffer = _makeReverbIR(decay, tone); _E._revIRKey = decay.toFixed(2) + '/' + tone.toFixed(2); } catch (e) {}
        } else {
          _E.reverb = new Tone.Freeverb({ roomSize: 0.8, dampening: 2500, wet: 1 }).connect(_E.busNode());
          _E._revConv = false;
        }
      } catch (e) { _E.reverb = null; }
      _ambApplyReverb();
      return _E.reverb;
    }
    // Push the instance's reverb Size/Damp config onto its live reverb node.
    // Freeverb → roomSize/dampening; convolution → regenerate the IR (debounced,
    // engine-scoped capture so the shared _E pointer can't cross engines).
    function _ambApplyReverb() {
      const E = _E;
      if (!E.reverb) return;
      const cfg = E.getCfg(); if (!cfg || !cfg.reverb) return;
      try {
        if (E._revConv) {
          const decay = (typeof _reverbDecaySec === 'function') ? _reverbDecaySec(cfg.reverb.size | 0) : 2;
          const tone  = (typeof _reverbToneNorm === 'function') ? _reverbToneNorm(cfg.reverb.damp | 0) : 0.5;
          const key = decay.toFixed(2) + '/' + tone.toFixed(2);
          if (key !== E._revIRKey) {
            E._revIRKey = key;
            if (E._revIRTimer) clearTimeout(E._revIRTimer);
            E._revIRTimer = setTimeout(() => { try { if (E.reverb && E._revConv) E.reverb.buffer = _makeReverbIR(decay, tone); } catch (e) {} }, 120);
          }
        } else {
          const size = Math.max(0, Math.min(1, (cfg.reverb.size | 0) / 100));
          const damp = 500 + Math.max(0, Math.min(100, cfg.reverb.damp | 0)) / 100 * 5500; // Hz
          if (E.reverb.roomSize) E.reverb.roomSize.value = size;
          if (E.reverb.dampening) E.reverb.dampening.value = damp;
        }
      } catch (e) {}
    }
    // Reverb type changed globally → rebuild each engine's reverb (and the layer
    // mod chains that send to it) so the swap is heard. Playing engines rebuild
    // immediately; idle ones rebuild lazily on next play.
    function _ambOnReverbTypeChanged() {
      const prevE = _E;
      [_laneEng, _masterEng].forEach(E => {
        if (!E) return;
        _E = E;
        const wasPlaying = !!E.timer;
        try { _ambTeardownMods(); } catch (e) {}        // disposes mods + reverb
        if (wasPlaying) { try { _ambSyncMods(); } catch (e) {} } // rebuild → new reverb type
      });
      _E = prevE;
    }
    // Per-layer chain base (built for any ON layer): voices → VCF → VCA → bus,
    // plus a parallel reverb send tapped off the VCA. The Distortion and Delay
    // nodes are NO LONGER created up-front — they're heavy continuous DSP
    // (FeedbackDelay's delay line, Distortion's oversampled waveshaper) that
    // ran for every layer even at wet=0, glitching dense Bloom stacks. They're
    // now inserted lazily by _ambApplyLayerFx only when the layer's mix > 0.
    function _ambBuildMod(layer, cfg) {
      if (_E.mod[layer]) { _ambUpdateMod(layer, cfg); return; }
      if (typeof Tone === 'undefined') return;
      try {
        const out = _E.busNode();
        // Dedicated DRY output GATE (no LFO ever connected) so Queue-mode STOP
        // can ramp it to 0 at an exact boundary, silencing the dry voices already
        // committed to the look-ahead. The reverb send taps the VCA (PRE-gate) so
        // the wet can be controlled separately: a "tails on" STOP cuts only the
        // dry gate and leaves the reverb feeding for a fuller tail; "tails off"
        // ramps the send down with the gate. vca → gate is permanent; FX
        // (dist/delay) re-route the gate's out.
        const gate = new Tone.Gain(1).connect(out);
        const vca = new Tone.Gain(1).connect(gate);
        const vcf = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.7 }).connect(vca);
        const revSend = new Tone.Gain(0);
        vca.connect(revSend);
        const rev = _ambEnsureReverb();
        if (rev) revSend.connect(rev);
        _E.mod[layer] = { input: vcf, vcf, vca, gate, dist: null, delay: null, revSend, src: { vca: null, vco: null, vcf: null } };
        _ambUpdateMod(layer, cfg);
      } catch (e) {}
    }
    // Apply a layer's FX (reverb send + delay + distortion). Builds/disposes the
    // Distortion/Delay tail on demand so a layer with FX off carries no extra
    // DSP, then sets params/wet. Reconnects VCA → [Dist] → [Delay] → bus
    // (matching the original signal order) only when the tail's shape changes.
    function _ambApplyLayerFx(layer, lc) {
      const e = _E.mod[layer];
      if (!e || !lc) return;
      const dly = lc.delay || {}, dst = lc.dist || {};
      const wantDelay = (dly.mix | 0) > 0;
      const wantDist = (dst.mix | 0) > 0;
      try {
        if (wantDelay !== !!e.delay || wantDist !== !!e.dist) {
          const out = _E.busNode();
          const g = e.gate || e.vca;            // route the FX tail off the gate (post-vca)
          try { g.disconnect(); } catch (x) {}
          if (!wantDelay && e.delay) { try { e.delay.dispose(); } catch (x) {} e.delay = null; }
          if (!wantDist && e.dist) { try { e.dist.dispose(); } catch (x) {} e.dist = null; }
          let tail = out;
          if (wantDelay) {
            if (!e.delay) e.delay = new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.35, wet: 0 });
            try { e.delay.disconnect(); } catch (x) {}
            e.delay.connect(tail); tail = e.delay;
          }
          if (wantDist) {
            if (!e.dist) e.dist = new Tone.Distortion({ distortion: 0.4, wet: 0, oversample: '4x' });
            try { e.dist.disconnect(); } catch (x) {}
            e.dist.connect(tail); tail = e.dist;
          }
          g.connect(tail);
          // (reverb send taps the VCA, pre-gate — see _ambBuildMod — so it is
          // not re-routed here.)
        }
        if (e.dist) {
          e.dist.distortion = Math.max(0, Math.min(1, (dst.amount | 0) / 100));
          e.dist.wet.value = Math.max(0, Math.min(1, (dst.mix | 0) / 100));
        }
        if (e.delay) {
          e.delay.delayTime.value = Math.max(0.001, (dly.timeMs | 0) / 1000);
          e.delay.feedback.value = Math.max(0, Math.min(0.95, (dly.feedback | 0) / 100));
          e.delay.wet.value = Math.max(0, Math.min(1, (dly.mix | 0) / 100));
        }
        if (e.revSend) e.revSend.gain.value = Math.max(0, Math.min(1, (lc.revSend | 0) / 100));
      } catch (x) {}
    }
    function _ambUpdateMod(layer, cfg) {
      const e = _E.mod[layer];
      if (!e) return;
      ['vca', 'vco', 'vcf'].forEach(tg => _ambSyncTarget(e, layer, tg, cfg));
    }
    function _ambTeardownMod(layer) {
      const e = _E.mod[layer];
      if (!e) return;
      ['vca', 'vco', 'vcf'].forEach(tg => { if (e.src && e.src[tg]) _ambDisposeSrc(e.src[tg]); });
      try { e.vcf && e.vcf.dispose(); } catch (x) {}
      try { e.vca && e.vca.dispose(); } catch (x) {}
      try { e.gate && e.gate.dispose(); } catch (x) {}
      try { e.dist && e.dist.dispose(); } catch (x) {}
      try { e.delay && e.delay.dispose(); } catch (x) {}
      try { e.revSend && e.revSend.dispose(); } catch (x) {}
      delete _E.mod[layer];
    }
    function _ambTeardownMods() {
      Object.keys(_E.mod).forEach(_ambTeardownMod);
      try { if (_E.reverb) { _E.reverb.dispose(); _E.reverb = null; } } catch (x) {}
    }
    // Cheap single-layer mod/FX sync for on/off toggles. Building or tearing
    // ONLY the affected chain (not every layer's, as _ambSyncMods does) and
    // deferring it past the next paint keeps a layer toggle instant — the full
    // graph rebuild was blocking the repaint, so the click looked dropped and
    // the user clicked again, re-toggling the state ("stays highlighted").
    function _ambSyncOneLayerMod(E, key, layer) {
      const run = () => {
        _E = E;
        try {
          if (layer && layer.on && layer.present !== false) { _ambBuildMod(key, { [key]: layer }); _ambApplyLayerFx(key, layer); }
          else { _ambTeardownMod(key); }
          _ambApplyReverb();
        } catch (e) {}
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else run();
    }
    // Human "unit length" readout for a layer header: the absolute length + the
    // formula that produces it (so the user knows which parameter to tweak). e.g.
    // Arp "⟳ 14 notes × 1/8 = 1.75s", Drone "⟳ Hold 4 × 0.50s = 2.0s",
    // Bass "⟳ 2 bars = 4.0s @120", Bed "Δ Interval 4.75s".
    function _ambLayerUnitText(E, key, L, cfg) {
      if (!L) return '';
      const type = String(key).split(':')[0];
      const bpm = _ambBpm();
      const fmt = (sec) => _ambFmtMs(Math.round(Math.max(0, sec) * 1000));
      const rate = (L.rate && _ambRateBeats(L.rate) > 0) ? L.rate : null;
      const unitSec = _ambEffIntervalSec(L);
      const unitStr = rate ? (rate + ' (' + fmt(unitSec) + ')') : fmt(unitSec);
      // Synced layers show what they're locked to + the resolved length.
      if (L.unit && L.unit.mode === 'sync' && L.unit.ref) {
        const n = Math.max(1, L.unit.num | 0), d = Math.max(1, L.unit.den | 0);
        const ratioStr = (n === d) ? '' : (' ×' + (d === 1 ? n : (n + '/' + d)));
        return '🔒 ' + _ambRefLabel(E, L.unit.ref, cfg) + ratioStr + ' = ' + fmt(_ambLayerPeriodSec(E, key, L, cfg));
      }
      if (type === 'arp') {
        const info = _ambArpSeriesInfo(L, cfg);
        return '⟳ ' + info.totalNotes + ' notes × ' + (rate ? rate : fmt(info.interval)) + ' = ' + fmt(info.totalNotes * info.interval);
      }
      if (type === 'drone') {
        const hold = Math.max(1, Math.min(64, (L.hold | 0) || 1));
        return '⟳ Hold ' + hold + ' × ' + unitStr + ' = ' + fmt(hold * unitSec);
      }
      if (type === 'bass' || type === 'run' || type === 'pedal') {
        const bars = Math.max(1, (L.bars | 0) || 1);
        const pad = Math.max(0, (L.unitPadMs | 0)) / 1000, baseSec = bars * (60 / bpm) * 4;
        return '⟳ ' + bars + ' bar' + (bars === 1 ? '' : 's') + (pad > 0 ? ' + ' + fmt(pad) + ' pad' : '') + ' = ' + fmt(baseSec + pad) + ' @' + bpm;
      }
      if (type === 'seq') return '⟳ unit ' + fmt(_ambLayerPeriodSec(E, key, L, cfg));
      if (type === 'samp') return 'Δ ' + unitStr;
      if (type === 'beat' && L.gen === 'euclid') {
        const bars = Math.max(1, Math.min(8, (L.bars | 0) || 1));
        const steps = Math.max(2, Math.min(16, (L.steps | 0) || 8));
        const pulses = Math.max(1, Math.min(steps, (L.pulses | 0) || 1));
        const pad = Math.max(0, (L.unitPadMs | 0)) / 1000, baseSec = bars * (60 / bpm) * 4;
        return '⟳ ' + pulses + '/' + steps + ' × ' + bars + ' bar' + (bars === 1 ? '' : 's') + (pad > 0 ? ' + ' + fmt(pad) + ' pad' : '') + ' = ' + fmt(baseSec + pad) + ' @' + bpm;
      }
      // bed / motif / texture / beat (random) — continuous stream; unit = Interval/Rate.
      return 'Δ ' + unitStr;
    }
    // Refresh every layer header's unit readout in this engine's panel.
    function _ambSyncLayerUnits(E) {
      try {
        const host = E && document.getElementById(E.hostId); if (!host) return;
        const cfg = E.getCfg(); if (!cfg) return;
        host.querySelectorAll('.ambient-layer-unit[data-ukey]').forEach(span => {
          const key = span.getAttribute('data-ukey');
          const L = _ambLayerByKey(E, key);
          span.textContent = L ? _ambLayerUnitText(E, key, L, cfg) : '';
        });
      } catch (e) {}
    }
    // ---- Per-layer Unit controls (BPM-sync visibility + Match-to-layer) -----
    // A layer is "BPM-synced" when its Rate is a division (≠ Free); the free ms
    // Interval then does nothing, so hide it. (p = the wire prefix, trailing '-'.)
    function _ambUnitSyncViz(E, p, L) {
      const intv = _ambGet(E, p + 'intervalMs'); if (!intv) return;
      const ctrl = intv.closest('.ambient-ctrl'); if (!ctrl) return;
      ctrl.style.display = (L && L.rate && _ambRateBeats(L.rate) > 0) ? 'none' : '';
    }
    // ----- Unit-Sync control (Free / Sync = Reference × Ratio) --------------
    const _AMB_RATIOS = [[1,4,'×¼'],[1,3,'×⅓'],[1,2,'×½'],[2,3,'×⅔'],[3,4,'×¾'],[1,1,'×1'],[3,2,'×1½'],[2,1,'×2'],[3,1,'×3'],[4,1,'×4']];
    // Reference options for a layer: Bar/Beat grid + every OTHER present layer
    // (its whole unit, and a sub-unit when it divides — one chord/bar/step/hold).
    function _ambRefOptions(E, selfKey) {
      const cfg = E.getCfg();
      const opts = [['bar', 'Bar'], ['beat', 'Beat']];
      const layers = (typeof _ambMixerLayers === 'function') ? _ambMixerLayers(cfg) : [];
      layers.forEach(o => {
        if (!o || o.key === selfKey) return;
        opts.push([o.key, o.name]);
        if (_ambLayerSubCount(o.layer, o.key) > 1) opts.push([o.key + '#sub', o.name + ' · ' + _ambLayerSubLabel(o.layer, o.key)]);
      });
      return opts;
    }
    // Human label for a Reference descriptor (for the header readout).
    function _ambRefLabel(E, ref, cfg) {
      if (!ref || ref === 'bar') return 'Bar';
      if (ref === 'beat') return 'Beat';
      const sub = ref.indexOf('#sub') >= 0;
      const refKey = sub ? ref.slice(0, ref.indexOf('#sub')) : ref;
      const RL = _ambLayerByKey(E, refKey);
      const nm = RL ? _ambLayerLabel(RL, refKey) : refKey;
      return sub ? (nm + ' ' + _ambLayerSubLabel(RL, refKey)) : nm;
    }
    function _ambUnitSyncHtml(p) {
      return '<div class="ambient-ctrl ambient-unitsync" title="Unit length — Free (its own length) or Sync (lock to a reference × ratio)">' +
        '<label>Unit</label>' +
        '<span class="ambient-seg-row ambient-usync-seg">' +
          '<button type="button" class="ambient-seg amb-usync-mode" data-usmode="free" id="' + p + '-us-free">Free</button>' +
          '<button type="button" class="ambient-seg amb-usync-mode" data-usmode="sync" id="' + p + '-us-sync">Sync</button>' +
        '</span></div>' +
        '<div class="ambient-ctrl ambient-usync-lock" id="' + p + '-us-lock">' +
          '<label for="' + p + '-us-ref">Lock to</label>' +
          '<select id="' + p + '-us-ref" class="ambient-select"></select>' +
          '<select id="' + p + '-us-ratio" class="ambient-select amb-usync-ratio"></select>' +
        '</div>';
    }
    function _ambUnitSyncModeVis(E, p, L) {
      const sync = !!(L && L.unit && L.unit.mode === 'sync');
      const lock = _ambGet(E, p + 'us-lock'); if (lock) lock.style.display = sync ? '' : 'none';
      const fb = _ambGet(E, p + 'us-free'); if (fb) fb.classList.toggle('on', !sync);
      const sb = _ambGet(E, p + 'us-sync'); if (sb) sb.classList.toggle('on', sync);
    }
    // Wire the Unit-Sync control. `p` ends in '-'; `selfKey` excludes the layer
    // from its own reference list. Re-populates references each render so newly
    // added layers appear.
    function _ambWireUnitSync(E, p, get, selfKey) {
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const sync = () => { if (E.timer) { try { _ambSyncMods(); } catch (e) {} } };
      const refresh = () => { _ambUnitSyncModeVis(E, p, get()); try { _ambSyncLayerUnits(E); } catch (e) {} };
      const ref = _ambGet(E, p + 'us-ref'), ratio = _ambGet(E, p + 'us-ratio');
      const fb = _ambGet(E, p + 'us-free'), sb = _ambGet(E, p + 'us-sync');
      const L0 = get();
      if (ref) {
        ref.innerHTML = _ambRefOptions(E, selfKey).map(o => '<option value="' + o[0] + '">' + String(o[1]).replace(/[<>&"]/g, '') + '</option>').join('');
        ref.value = (L0 && L0.unit && L0.unit.ref) || 'bar'; if (!ref.value) ref.value = 'bar';
        if (!ref._usB) { ref._usB = true; ref.addEventListener('change', () => { const L = get(); if (L && L.unit) { L.unit.ref = ref.value || 'bar'; sync(); persist(); refresh(); } }); }
      }
      if (ratio) {
        ratio.innerHTML = _AMB_RATIOS.map(r => '<option value="' + r[0] + '/' + r[1] + '">' + r[2] + '</option>').join('');
        ratio.value = (L0 && L0.unit) ? (((L0.unit.num | 0) || 1) + '/' + ((L0.unit.den | 0) || 1)) : '1/1';
        if (!ratio._usB) { ratio._usB = true; ratio.addEventListener('change', () => { const L = get(); if (L && L.unit) { const m = /^(\d+)\/(\d+)$/.exec(ratio.value); if (m) { L.unit.num = parseInt(m[1], 10) || 1; L.unit.den = parseInt(m[2], 10) || 1; } sync(); persist(); refresh(); } }); }
      }
      const setMode = (mode) => { const L = get(); if (!L || !L.unit) return; L.unit.mode = mode; sync(); persist(); refresh(); };
      if (fb && !fb._usB) { fb._usB = true; fb.addEventListener('click', () => setMode('free')); }
      if (sb && !sb._usB) { sb._usB = true; sb.addEventListener('click', () => setMode('sync')); }
      _ambUnitSyncModeVis(E, p, L0);
    }
    function _ambUnitMatchHtml(p) {
      return '<div class="ambient-ctrl ambient-unitmatch"><label>Match</label>' +
        '<select id="' + p + '-umatch" class="ambient-select"></select>' +
        '<button type="button" class="ambient-umatch-btn" id="' + p + '-umatch-go" title="Set this layer\'s unit length to the chosen layer\'s — closest unit ≤ it, padded with silence to match exactly">Sync</button></div>';
    }
    function _ambWireUnitMatch(E, inst, p, get) {
      const sel = _ambGet(E, p + 'umatch'), go = _ambGet(E, p + 'umatch-go');
      if (!sel || !go) return;
      const selfKey = inst.type + ':' + inst.id;
      const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, '');
      const layers = (typeof _ambMixerLayers === 'function') ? _ambMixerLayers(E.getCfg()) : [];
      sel.innerHTML = '<option value="">— pick layer —</option>' +
        layers.filter(o => o.key !== selfKey).map(o => '<option value="' + esc(o.key) + '">' + esc(o.name) + '</option>').join('');
      if (!go._ambBound) {
        go._ambBound = true;
        go.addEventListener('click', () => { const tk = sel.value, L = get(); if (tk && L) { try { _ambShowUnitMatchEditor(E, L, selfKey, tk); } catch (e) { console.warn('Unit match editor failed', e); } } });
      }
    }
    // Set THIS layer's unit length to match the target layer's: pick the largest
    // achievable unit ≤ target, then pad with silence (unitPadMs) so it's exact.
    // Compute (without applying) the param changes that make a layer's unit equal
    // `desiredSec`: closest achievable ≤ it, plus a silent pad. Returns
    // { set, contentSec, padSec } — content plays, pad is silence to total desired.
    function _ambUnitMatchPlan(E, L, key, cfg, desiredSec) {
      const type = String(key).split(':')[0];
      if (type === 'bass' || type === 'run' || type === 'pedal' || (type === 'beat' && L.gen === 'euclid')) {
        const barSec = (60 / _ambBpm()) * 4, maxBars = (type === 'run' || type === 'pedal') ? 16 : 8;
        const bars = Math.max(1, Math.min(maxBars, Math.floor(desiredSec / barSec + 1e-6)));
        const content = bars * barSec, pad = Math.max(0, desiredSec - content);
        return { set: { bars: bars, unitPadMs: Math.round(pad * 1000) }, contentSec: content, padSec: pad };
      }
      if (type === 'drone') {
        const hold = Math.max(1, (L.hold | 0) || 1);
        return { set: { rate: '', intervalMs: Math.max(20, Math.round((desiredSec / hold) * 1000)), unitPadMs: 0 }, contentSec: desiredSec, padSec: 0 };
      }
      if (type === 'arp') {
        const n = Math.max(1, _ambArpSeriesInfo(L, cfg).totalNotes);
        return { set: { rate: '', intervalMs: Math.max(20, Math.round((desiredSec / n) * 1000)), unitPadMs: 0 }, contentSec: desiredSec, padSec: 0 };
      }
      return { set: { rate: '', intervalMs: Math.max(20, Math.round(desiredSec * 1000)), unitPadMs: 0 }, contentSec: desiredSec, padSec: 0 };
    }
    // Structural event-onset fractions [0,1) within one unit (params-derived; no
    // generator run), for the Match preview timeline.
    // Note name for a frequency (e.g. 440 → "A4").
    function _ambFreqName(f) {
      if (f == null || !(f > 0)) return '';
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const names = (typeof CHROMATIC !== 'undefined' && CHROMATIC.length === 12) ? CHROMATIC : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const m = Math.round(69 + 12 * Math.log2(f / A));
      return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
    }
    // The ordered note names an Arp plays across one series loop (ignoring
    // randomness/rests — the underlying pattern), for the Match preview.
    function _ambArpNoteNames(L, cfg) {
      const steps = (Array.isArray(L.steps) && L.steps.length) ? L.steps : [{ notes: { type: 'scale', scale: '' }, passes: 1 }];
      const octs = Math.max(1, Math.min(4, (L.octaves | 0) || 2)), base = Math.max(1, Math.min(8, (L.register | 0) || 4));
      const names = [];
      steps.forEach(entry => {
        const src = _ambNotesOf(entry), intervals = _ambScaleIntervals(src), N = Math.max(1, intervals.length), len = N * octs;
        const dir = (entry && entry.dir) || L.dir || 'up', total = _ambArpEntryNotes(entry, dir, len);
        for (let i = 0; i < total; i++) {
          const idx = _ambArpIndexFor(dir, i, len), d = idx % N, o = Math.floor(idx / N);
          const carry = Math.floor((_ambSrcRootPc(src) + (intervals[d] | 0)) / 12);
          names.push(_ambFreqName(_ambNoteFreq(intervals[d] | 0, base + o + carry, src)));
        }
      });
      return names;
    }
    // Events in one unit for the Match preview: { at, dur, label } as fractions of
    // the unit — onset, how long it sounds (from Length), and the note name(s)
    // where deterministic (random/drum layers show bars without a pitch).
    function _ambUnitEvents(E, key, L, cfg) {
      const type = String(key).split(':')[0];
      const period = Math.max(0.05, _ambLayerPeriodSec(E, key, L, cfg));
      const lenSec = Math.max(0.02, (L.lengthMs | 0) / 1000 || 0.2);
      const durFrac = Math.max(0.012, Math.min(1, lenSec / period));
      const evs = [];
      if (type === 'arp') {
        const nn = _ambArpNoteNames(L, cfg), total = Math.max(1, nn.length);
        for (let i = 0; i < total; i++) evs.push({ at: i / total, dur: durFrac, label: nn[i] });
      } else if (type === 'drone') {
        const src = _ambNotesOf(L), n = _ambAsNotes(src), N = Math.max(1, _ambScaleIntervals(src).length), reg = Math.max(1, Math.min(7, (L.register | 0) || 3));
        let label = '';
        if (n.type === 'chord' || n.type === 'wrap' || n.type === 'prog') { const a = []; for (let d = 0; d < Math.min(4, N); d++) { const f = _ambDegreeFreq(d, reg, src); if (f != null) a.push(_ambFreqName(f)); } label = a.join(' '); }
        else { const d = Math.max(0, Math.min(N - 1, ((L.degree | 0) || 1) - 1)); label = _ambFreqName(_ambDegreeFreq(d, reg, src)); }
        evs.push({ at: 0, dur: 0.985, label: label });   // held the whole cycle
      } else if (type === 'pedal') {
        const bars = Math.max(1, (L.bars | 0) || 1), dens = Math.max(1, Math.min(16, (L.density | 0) || 4)), total = bars * dens;
        const src = _ambNotesOf(L), N = Math.max(1, _ambScaleIntervals(src).length), reg = Math.max(1, Math.min(7, (L.register | 0) || 4));
        const d = Math.max(0, Math.min(N - 1, ((L.degree | 0) || 1) - 1)), lbl = _ambFreqName(_ambDegreeFreq(d, reg, src));
        const cFrac = bars * (60 / _ambBpm()) * 4 / period;   // content portion (pad is silent)
        for (let i = 0; i < total; i++) evs.push({ at: (i / total) * cFrac, dur: durFrac, label: lbl });
      } else if (type === 'bass' || (type === 'beat' && L.gen === 'euclid')) {
        const steps = Math.max(2, Math.min(16, (L.steps | 0) || 8)), pulses = Math.max(1, Math.min(steps, (L.pulses | 0) || 1)), rotate = Math.max(0, L.rotate | 0), bars = Math.max(1, Math.min(8, (L.bars | 0) || 1));
        const pat = (typeof euclideanPattern === 'function') ? euclideanPattern(pulses, steps, rotate) : [], totalS = bars * steps;
        const cFrac = bars * (60 / _ambBpm()) * 4 / period;
        for (let b = 0; b < bars; b++) for (let s = 0; s < steps; s++) if (pat[s] === 1) evs.push({ at: ((b * steps + s) / totalS) * cFrac, dur: durFrac, label: '' });
      } else if (type === 'run') {
        const bars = Math.max(1, (L.bars | 0) || 1), dens = Math.max(1, Math.min(16, (L.density | 0) || 8)), total = bars * dens;
        const cFrac = bars * (60 / _ambBpm()) * 4 / period;
        for (let i = 0; i < total; i++) evs.push({ at: (i / total) * cFrac, dur: durFrac, label: '' });
      } else {
        const iv = Math.max(0.02, _ambEffIntervalSec(L)), n = Math.max(1, Math.round(period / iv));
        for (let i = 0; i < Math.min(64, n); i++) evs.push({ at: (i * iv) / period, dur: durFrac, label: '' });
      }
      return evs.sort((a, b) => a.at - b.at);
    }
    function _ambUnitMatch(E, L, key, targetKey, ratio) {
      const cfg = E.getCfg(); if (!cfg || !L) return;
      const tgt = _ambLayerByKey(E, targetKey); if (!tgt) return;
      const T = _ambLayerPeriodSec(E, targetKey, tgt, cfg); if (!(T > 0)) return;
      const r = (Number.isFinite(ratio) && ratio > 0) ? ratio : 1;
      const desired = T * r;
      const plan = _ambUnitMatchPlan(E, L, key, cfg, desired);
      Object.assign(L, plan.set);
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
      try { _ambSyncControls(E); } catch (e) {}
      if (typeof showToast === 'function') showToast('Matched to ' + _ambLayerLabel(tgt, targetKey) + ' ×' + r + ' — ' + _ambFmtMs(Math.round(desired * 1000)));
    }
    // Sync editor: choose the ratio (this unit = target × ratio) and SEE how the
    // two layers' audio events line up over the unit before applying.
    const _AMB_UM_RATIOS = [['¼', 0.25], ['⅓', 1 / 3], ['½', 0.5], ['1', 1], ['2', 2], ['3', 3], ['4', 4]];
    function _ambShowUnitMatchEditor(E, L, key, targetKey) {
      const cfg = E.getCfg(); if (!cfg || !L) return;
      const tgt = _ambLayerByKey(E, targetKey); if (!tgt) return;
      const targetSec = _ambLayerPeriodSec(E, targetKey, tgt, cfg); if (!(targetSec > 0)) return;
      const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, '');
      const fmt = (s) => _ambFmtMs(Math.round(s * 1000));
      const rgba = (c, a) => (typeof _shapeRgba === 'function') ? _shapeRgba(c, a) : c;
      const thisName = _ambLayerLabel(L, String(key).split(':')[0]);
      const tgtName = _ambLayerLabel(tgt, targetKey);
      const tgtEvents = _ambUnitEvents(E, targetKey, tgt, cfg);
      const TGT_C = '#4fd1c5', THIS_C = '#f6ad55';
      const ratioLabel = (r) => { const f = _AMB_UM_RATIOS.find(rr => Math.abs(rr[1] - r) < 1e-6); return f ? ('×' + f[0]) : ('×' + (Math.round(r * 100) / 100)); };
      let ratio = 1;
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const modal = document.createElement('div'); modal.className = 'step-div-modal amb-um-modal';
      overlay.appendChild(modal);
      const close = () => { try { overlay.remove(); } catch (e) {} };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      // Bars span each note's DURATION (from Length); labels show the pitch where
      // deterministic. Tiled per unit with boundary lines so alignment is visible.
      const drawTimeline = (desired, plan, thisEvents) => {
        const cv = modal.querySelector('#amb-um-canvas'); if (!cv) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cssW = cv.clientWidth || 320, cssH = 120;
        cv.style.height = cssH + 'px'; cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
        const ctx = cv.getContext('2d'); if (!ctx) return; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const windowSec = Math.max(targetSec, desired) || 1;
        const pps = cssW / windowSec, laneH = 22;
        const drawLane = (y, periodSec, events, color) => {
          for (let t = 0; t <= windowSec + 1e-6; t += periodSec) {   // unit boundaries
            const x = Math.min(cssW - 0.5, t * pps);
            ctx.strokeStyle = rgba(color, 0.6); ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(x, y - laneH / 2 - 5); ctx.lineTo(x, y + laneH / 2 + 5); ctx.stroke();
          }
          for (let base = 0; base < windowSec - 1e-6; base += periodSec) {   // events, tiled per unit
            events.forEach(ev => {
              const x0 = (base + ev.at * periodSec) * pps; if (x0 > cssW) return;
              const w = Math.max(2.5, ev.dur * periodSec * pps), x1 = Math.min(cssW, x0 + w);
              ctx.fillStyle = rgba(color, 0.8); ctx.fillRect(x0, y - laneH / 2, Math.max(2.5, x1 - x0), laneH);
              ctx.strokeStyle = rgba(color, 1); ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y - laneH / 2 + 0.5, Math.max(2.5, x1 - x0) - 1, laneH - 1);
              if (ev.label && (x1 - x0) > 16) {   // pitch label inside the bar
                ctx.fillStyle = '#0a0a14'; ctx.font = '9px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(ev.label.length > 8 ? ev.label.slice(0, 8) : ev.label, x0 + 3, y);
              }
            });
          }
        };
        ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = rgba(TGT_C, 0.95); ctx.fillText(esc(tgtName) + ' · ' + tgtEvents.length + ' notes', 2, 13);
        drawLane(40, targetSec, tgtEvents, TGT_C);
        ctx.fillStyle = rgba(THIS_C, 0.95); ctx.fillText(esc(thisName) + ' · ' + thisEvents.length + ' notes', 2, 76);
        drawLane(103, desired, thisEvents, THIS_C);
      };
      const render = () => {
        const desired = targetSec * ratio;
        const plan = _ambUnitMatchPlan(E, L, key, cfg, desired);
        const thisEvents = _ambUnitEvents(E, key, Object.assign({}, L, plan.set), cfg);   // post-match structure
        modal.innerHTML =
          '<div class="keep-sdiv-title">Match unit length</div>' +
          '<div class="amb-um-ratios">' + _AMB_UM_RATIOS.map(rr => '<button type="button" class="amb-um-rbtn' + (Math.abs(rr[1] - ratio) < 1e-6 ? ' on' : '') + '" data-r="' + rr[1] + '">×' + rr[0] + '</button>').join('') + '</div>' +
          '<div class="amb-um-calc"><span style="color:' + THIS_C + '">' + esc(thisName) + '</span> = <span style="color:' + TGT_C + '">' + esc(tgtName) + '</span> ' + fmt(targetSec) + ' ' + ratioLabel(ratio) + ' = <b>' + fmt(desired) + '</b>' + (plan.padSec > 0.001 ? ' <span class="amb-um-pad">(' + fmt(plan.contentSec) + ' + ' + fmt(plan.padSec) + ' silence)</span>' : '') + '</div>' +
          '<canvas id="amb-um-canvas" class="amb-um-canvas"></canvas>' +
          '<div class="sm-footer"><button type="button" class="sm-preview amb-um-cancel">Cancel</button><button type="button" class="sm-apply amb-um-ok">Sync</button></div>';
        modal.querySelectorAll('.amb-um-rbtn').forEach(b => b.addEventListener('click', () => { ratio = parseFloat(b.dataset.r) || 1; render(); }));
        const cx = modal.querySelector('.amb-um-cancel'); if (cx) cx.addEventListener('click', close);
        const ok = modal.querySelector('.amb-um-ok'); if (ok) ok.addEventListener('click', () => { close(); _ambUnitMatch(E, L, key, targetKey, ratio); });
        requestAnimationFrame(() => drawTimeline(desired, plan, thisEvents));
      };
      render();
      document.body.appendChild(overlay);
      requestAnimationFrame(() => { const d = targetSec * ratio; const pl = _ambUnitMatchPlan(E, L, key, cfg, d); drawTimeline(d, pl, _ambUnitEvents(E, key, Object.assign({}, L, pl.set), cfg)); });
    }
    // The repeat period (seconds) of a layer's UNIT — one full iteration of
    // whatever loops: a Seq phrase, a Sample slice-grid step, a Bass phrase
    // cycle (bars), a Shape revolution, or a generative layer's event interval.
    // Used by Queue mode to land an on/off change on the layer's own boundary.
    // The layer's NATURAL (Free) unit length — its own params, no Sync scaling.
    // This is the building block; _ambLayerPeriodSec layers Sync on top.
    function _ambNaturalUnitSec(E, key, L, cfg) {
      const type = String(key).split(':')[0];
      if (type === 'seq') {
        if (L.intervalMode === 'manual') return _ambSnap(Math.max(0.1, (L.intervalMs | 0) / 1000), cfg);
        const st = E.seqState && E.seqState[L.id];
        const ms = (st && st._lastUnitMs > 0) ? st._lastUnitMs
                 : (Array.isArray(L.units) && L.units[0] ? _unitTotalMs(L.units[0]) : (L.intervalMs | 0));
        return Math.max(0.1, (ms || 0) / 1000);
      }
      if (type === 'samp') return _ambSnap(Math.max(0.1, (L.intervalMs | 0) / 1000), cfg);
      if (type === 'beat' && L && L.gen === 'euclid') { const bars = Math.max(1, Math.min(8, (L.bars | 0) || 1)); return bars * (60 / _ambBpm()) * 4 + Math.max(0, (L.unitPadMs | 0)) / 1000; }
      if (type === 'bass') { const bars = Math.max(1, Math.min(8, (L.bars | 0) || 1)); return bars * (60 / _ambBpm()) * 4 + Math.max(0, (L.unitPadMs | 0)) / 1000; }
      if (type === 'run')  { const bars = Math.max(1, Math.min(16, (L.bars | 0) || 2)); return bars * (60 / _ambBpm()) * 4 + Math.max(0, (L.unitPadMs | 0)) / 1000; }
      if (type === 'pedal') { const bars = Math.max(1, Math.min(16, (L.bars | 0) || 1)); return bars * (60 / _ambBpm()) * 4 + Math.max(0, (L.unitPadMs | 0)) / 1000; }
      if (type === 'drone') { const hold = Math.max(1, Math.min(64, (L.hold | 0) || 1)); return hold * Math.max(0.05, _ambEffIntervalSec(L)); }
      if (type === 'arp') { const info = _ambArpSeriesInfo(L, cfg); return info.totalNotes * info.interval; }
      if (type === 'shape') {
        if (Array.isArray(L.shapes) && L.shapes.length && typeof _shapeBarSec === 'function') {
          const i = Math.max(0, Math.min(L.shapes.length - 1, L.sel | 0));
          const r = _shapeBarSec(L.shapes[i] || L.shapes[0]);
          if (r > 0.02) return r;
        }
        return (60 / _ambBpm()) * 4;
      }
      return Math.max(0.05, _ambEffIntervalSec(L)); // bed/motif/texture/beat/arp
    }
    // Ensure a layer's Unit-Sync descriptor exists (default FREE). `unit` =
    // { mode:'free'|'sync', ref, num, den }. Free is the default everywhere.
    function _ambNormalizeUnit(L) {
      if (!L || typeof L !== 'object') return;
      let u = L.unit;
      if (!u || typeof u !== 'object') u = L.unit = {};
      u.mode = (u.mode === 'sync') ? 'sync' : 'free';
      if (typeof u.ref !== 'string' || !u.ref) u.ref = 'bar';
      u.num = Math.max(1, Math.min(64, (u.num | 0) || 1));
      u.den = Math.max(1, Math.min(64, (u.den | 0) || 1));
    }
    // ===== Unified Unit system =========================================
    // Every layer's unit is either FREE (its own natural length, the default) or
    // SYNC (= a Reference × a Ratio). References resolve to seconds: the BPM grid
    // ('bar'/'beat'), another layer's whole unit (its key), or a SUB-unit of
    // another layer (key + '#sub' — one chord/bar/step/hold). Sync time-SCALES the
    // layer's whole pattern to fit, locking boundaries with exact ratios (no pad).
    // Scaling is computed live and never written to params, so reverting to Free
    // restores the original rhythm exactly. Layer→layer refs are cycle-guarded.
    //
    // How many sub-cells a layer's unit divides into (for '#sub' references).
    function _ambLayerSubCount(L, key) {
      const type = String(key).split(':')[0];
      if (type === 'arp')   return Math.max(1, (Array.isArray(L.steps) ? L.steps.length : 1));
      if (type === 'drone') return Math.max(1, Math.min(64, (L.hold | 0) || 1));
      if (type === 'bass')  return Math.max(1, Math.min(8,  (L.bars | 0) || 1));
      if (type === 'run')   return Math.max(1, Math.min(16, (L.bars | 0) || 2));
      if (type === 'pedal') return Math.max(1, Math.min(16, (L.bars | 0) || 1));
      if (type === 'beat' && L.gen === 'euclid') return Math.max(1, Math.min(8, (L.bars | 0) || 1));
      if (type === 'seq')   return Math.max(1, (Array.isArray(L.units) ? L.units.length : 1));
      return 1; // bed/motif/texture/beat(random)/sample — no finer cell
    }
    // A label for a layer's sub-unit (used in the Reference dropdown).
    function _ambLayerSubLabel(L, key) {
      const type = String(key).split(':')[0];
      if (type === 'arp')   return 'chord';
      if (type === 'drone') return 'hold';
      if (type === 'seq')   return 'unit';
      return 'bar';
    }
    // Resolve a Reference descriptor → seconds. seen = keys already on the
    // resolution stack (cycle guard).
    function _ambUnitRefSec(E, ref, cfg, seen) {
      const bpm = _ambBpm();
      if (!ref || ref === 'bar')  return (60 / bpm) * 4;
      if (ref === 'beat')         return (60 / bpm);
      const sub = ref.indexOf('#sub') >= 0;
      const refKey = sub ? ref.slice(0, ref.indexOf('#sub')) : ref;
      const whole = _ambResolvedUnitSec(E, refKey, cfg, seen);
      if (!sub) return whole;
      const RL = _ambLayerByKey(E, refKey);
      return RL ? (whole / _ambLayerSubCount(RL, refKey)) : whole;
    }
    // A layer's RESOLVED unit length — its sync target if synced, else natural.
    function _ambResolvedUnitSec(E, key, cfg, seen) {
      const L = _ambLayerByKey(E, key);
      if (!L) return (60 / _ambBpm()) * 4;
      const nat = _ambNaturalUnitSec(E, key, L, cfg);
      const u = L.unit;
      if (!u || u.mode !== 'sync' || !u.ref) return nat;
      if (seen && seen.has(key)) return nat;          // break a ref cycle → fall back to natural
      const s = seen || new Set(); s.add(key);
      const refSec = _ambUnitRefSec(E, u.ref, cfg, s);
      if (!(refSec > 0)) return nat;
      const r = Math.max(1, u.num | 0) / Math.max(1, u.den | 0);
      const t = refSec * r;
      return (t > 0.001) ? t : nat;
    }
    // Live time-scale for a layer: 1 when Free, else (synced target / natural).
    // Multiply an engine's base interval / bar length by this to lock its unit.
    function _ambLayerScale(E, key, L, cfg) {
      const u = L && L.unit;
      if (!u || u.mode !== 'sync' || !u.ref) return 1;   // Free → no scaling, no work
      try {
        const nat = _ambNaturalUnitSec(E, key, L, cfg);
        if (!(nat > 0.001)) return 1;
        const res = _ambResolvedUnitSec(E, key, cfg, new Set());
        if (!(res > 0.001)) return 1;
        const sc = res / nat;
        if (!(sc > 0) || !isFinite(sc)) return 1;
        return Math.max(0.05, Math.min(40, sc));   // clamp so a pathological lock can't flood/stall the scheduler
      } catch (e) { return 1; }
    }
    // The layer's effective unit length (Sync-aware) — used by the status bar,
    // unit readout, queue boundaries, and Unit-Match.
    function _ambLayerPeriodSec(E, key, L, cfg) {
      return _ambResolvedUnitSec(E, key, cfg, new Set());
    }
    // Absolute time (Tone seconds) of the NEXT iteration boundary for layer
    // `key`. For a PLAYING layer the engine already tracks the next iteration
    // start (its clock / phase anchor) — that IS the boundary, so the current
    // iteration finishes and the next one is the cut point. For an OFF layer
    // (a queued START) there is no live phase, so we align to the engine's grid
    // anchor (E._t0) by the layer's period, so it enters on its own beat grid.
    function _ambLayerNextBoundary(E, key, L, cfg, now) {
      const type = String(key).split(':')[0];
      const P = _ambLayerPeriodSec(E, key, L, cfg);
      if (!(P > 0)) return now + 0.1;
      const eps = 0.03;
      const euclidBeat = (type === 'beat' && L && L.gen === 'euclid');
      if (L.on) {
        if (type === 'arp') {
          // Snap to the SERIES-loop boundary: next note + the notes left in the
          // current cycle, so a queued change lands when the arp restarts its series.
          const info = _ambArpSeriesInfo(L, cfg);
          const c = E.clocks && E.clocks[key];
          const st = E.arpState && E.arpState[key];
          if (c != null) { const left = info.totalNotes - _ambArpNotesInto(info, st); return c + Math.max(1, left) * info.interval * _ambLayerScale(E, key, L, cfg); }
        } else if (!euclidBeat && (type === 'seq' || type === 'samp' || type === 'bed' || type === 'motif' ||
            type === 'texture' || type === 'beat')) {
          const c = E.clocks && E.clocks[key];
          if (c != null && c > now + eps) return c;     // next phrase / slice / step start
        } else if (type === 'bass' || type === 'run' || type === 'pedal' || type === 'drone' || euclidBeat) {
          const pm = (type === 'bass') ? E.bassPhase : E.runPhase;
          const st = pm && pm[key];
          if (st && st.startAt != null) return st.startAt + Math.ceil((now + eps - st.startAt) / P) * P;
        } else if (type === 'shape') {
          const i = Math.max(0, Math.min((Array.isArray(L.shapes) ? L.shapes.length : 1) - 1, L.sel | 0));
          const st = E.shapePhase && (E.shapePhase[key + '#' + i] || E.shapePhase[key + '#0']);
          if (st && st.startAt != null) return st.startAt + Math.ceil((now + eps - st.startAt) / P) * P;
        }
      }
      const A = (E._t0 != null) ? E._t0 : now;          // off layer → engine grid
      return A + Math.ceil((now + eps - A) / P) * P;
    }
    // The next AUDIBLE boundary — the end of the iteration currently sounding,
    // i.e. the smallest point on the layer's grid that is strictly after `now`.
    // (Unlike _ambLayerNextBoundary, this ignores the look-ahead: the engine has
    // already committed events out to the horizon, but the output gate silences
    // anything past this point so a STOP cuts exactly here.) The grid phase comes
    // from the live clock (grid/seq/samp — C[key] sits ON the grid) or the phase
    // anchor (bass/shape).
    function _ambLayerAudibleBoundary(E, key, L, cfg, now) {
      const type = String(key).split(':')[0];
      const P = _ambLayerPeriodSec(E, key, L, cfg);
      if (!(P > 0)) return now + 0.1;
      const eps = 0.02;
      // Arp cuts at the end of the SERIES loop: next note + notes left in the cycle.
      if (type === 'arp') {
        const info = _ambArpSeriesInfo(L, cfg);
        const c = E.clocks && E.clocks[key];
        const st = E.arpState && E.arpState[key];
        if (c != null) { const left = info.totalNotes - _ambArpNotesInto(info, st); return c + Math.max(1, left) * info.interval * _ambLayerScale(E, key, L, cfg); }
        return (E._t0 != null ? E._t0 : now) + Math.ceil((now + eps - (E._t0 != null ? E._t0 : now)) / P) * P;
      }
      let A = null;
      const euclidBeat = (type === 'beat' && L && L.gen === 'euclid');
      if (type === 'bass' || type === 'run' || type === 'pedal' || type === 'drone' || euclidBeat) { const pm = (type === 'bass') ? E.bassPhase : E.runPhase; const st = pm && pm[key]; if (st && st.startAt != null) A = st.startAt; }
      else if (type === 'shape') {
        const i = Math.max(0, Math.min((Array.isArray(L.shapes) ? L.shapes.length : 1) - 1, L.sel | 0));
        const st = E.shapePhase && (E.shapePhase[key + '#' + i] || E.shapePhase[key + '#0']);
        if (st && st.startAt != null) A = st.startAt;
      } else { const c = E.clocks && E.clocks[key]; if (c != null) A = c; }
      if (A == null) A = (E._t0 != null) ? E._t0 : now;
      return A + Math.ceil((now + eps - A) / P) * P;
    }
    // Schedule the layer's output gate (the dedicated post-VCA Gain) to `val`
    // over `dur` seconds ending at/around `at`. Used by Queue STOP (→0 at the
    // boundary, click-free) and cancel (→1). No-op if the chain isn't built.
    function _ambGateRamp(E, key, val, at, dur) {
      const e = E.mod && E.mod[key];
      if (!e || !e.gate || !e.gate.gain) return;
      const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
      const t = Math.max(now, at || now);
      try {
        e.gate.gain.cancelScheduledValues(now);
        e.gate.gain.setValueAtTime(val === 0 ? 1 : (e.gate.gain.value || 0), t);
        e.gate.gain.linearRampToValueAtTime(val, t + Math.max(0.005, dur || 0.03));
      } catch (x) {}
    }
    // Schedule the layer's reverb send to `val` (0..1) over `dur` ending at `at`.
    // Queue STOP with tails OFF ramps it to 0 with the gate (cut the wet feed);
    // cancel restores it to the layer's configured send level. No-op if unbuilt.
    function _ambRevSendRamp(E, key, val, at, dur) {
      const e = E.mod && E.mod[key];
      if (!e || !e.revSend || !e.revSend.gain) return;
      const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
      const t = Math.max(now, at || now);
      try {
        e.revSend.gain.cancelScheduledValues(now);
        e.revSend.gain.setValueAtTime(e.revSend.gain.value || 0, t);
        e.revSend.gain.linearRampToValueAtTime(Math.max(0, val), t + Math.max(0.005, dur || 0.03));
      } catch (x) {}
    }
    // Toggle a layer's on/off. Normally immediate; in Queue mode (cfg.queueMode)
    // while the engine is playing, the change is DEFERRED to that layer's OWN
    // next iteration boundary (see _ambLayerNextBoundary) — each pending entry
    // carries its own target time `at`, and the tick's _qGate (in _ambTick)
    // schedules up to / from that exact boundary so the layer stops after its
    // current iteration completes, or starts cleanly on its next one. The button
    // shows a "queued" state until it lands; clicking again before the boundary
    // cancels the queued change.
    function _ambToggleLayer(E, key, L, onB, persist) {
      if (!L) return;
      const cfg = E.getCfg();
      const queueing = !!(cfg && cfg.queueMode) && !!E.timer;
      if (!queueing) {
        L.on = !L.on;
        if (onB) { onB.classList.toggle('on', !!L.on); onB.classList.remove('queued'); }
        if (E._queuePending) delete E._queuePending[key];
        if (E.timer) _ambSyncOneLayerMod(E, key, L);
        if (typeof persist === 'function') persist();
        return;
      }
      if (!E._queuePending) E._queuePending = {};
      const pend = E._queuePending[key];
      const desired = !(pend ? pend.desired : L.on);
      const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
      if (desired === L.on) {            // toggled back to the live state → cancel
        delete E._queuePending[key];
        if (onB) onB.classList.remove('queued');
        if (L.on) { _ambGateRamp(E, key, 1, now, 0.02); _ambRevSendRamp(E, key, Math.max(0, Math.min(1, (L.revSend | 0) / 100)), now, 0.02); } // undo a pending STOP fade
      } else if (desired === false) {    // queued STOP → cut at the next AUDIBLE boundary
        let at;
        try { at = _ambLayerAudibleBoundary(E, key, L, cfg, now); } catch (e) { at = now + (60 / _ambBpm()) * 4; }
        // Ramp the DRY gate to 0 exactly at the boundary so any voices the
        // look-ahead already committed past it are silenced (click-free fade).
        _ambGateRamp(E, key, 0, at, 0.03);
        // Tails OFF: cut the reverb send with the gate so the wet stops too.
        // Tails ON: leave the send feeding past the boundary so the reverb keeps
        // developing a fuller tail (until the layer flips off and tears down).
        if (!(cfg && cfg.tails)) _ambRevSendRamp(E, key, 0, at, 0.03);
        E._queuePending[key] = { L, onB, desired, at };
        if (onB) onB.classList.add('queued');
      } else {                           // queued START → first note on the next boundary
        let at, period = 0;
        try { at = _ambLayerNextBoundary(E, key, L, cfg, now); } catch (e) { at = now + (60 / _ambBpm()) * 4; }
        try { period = _ambLayerPeriodSec(E, key, L, cfg); } catch (e) {}
        // Stash the period so the arming tick can step the start forward onto
        // the grid if the boundary slid too close to give the first voice its
        // scheduler-lead headroom (see _qGate).
        E._queuePending[key] = { L, onB, desired, at, period };
        if (onB) onB.classList.add('queued');
      }
      if (typeof persist === 'function') persist();
    }
    // Flush every queued toggle IMMEDIATELY (ignoring boundaries). Called when
    // Queue mode is switched off so nothing dangles. (Boundary-timed application
    // happens per-layer inside _ambTick via _qGate.)
    function _ambApplyQueued(E) {
      const q = E._queuePending;
      if (!q) return;
      Object.keys(q).forEach(key => {
        const it = q[key]; if (!it || !it.L) return;
        it.L.on = !!it.desired;
        if (it.onB) { it.onB.classList.toggle('on', !!it.desired); it.onB.classList.remove('queued'); }
        try { _ambSyncOneLayerMod(E, key, it.L); } catch (e) {}
      });
      E._queuePending = {};
      E._queueAt = null;
      if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
    }
    function _ambSyncMods() {
      const cfg = _E.getCfg();
      if (!cfg) return;
      // Build a chain for EVERY on layer (not just mod-active) so per-layer FX
      // (reverb send / delay / distortion) are always available.
      const want = {};
      ['bed', 'motif', 'texture', 'beat'].forEach(l => {
        if (cfg[l] && cfg[l].present !== false && cfg[l].on) want[l] = cfg[l];
      });
      if (Array.isArray(cfg.seqs)) cfg.seqs.forEach(seq => {
        if (seq.on && Array.isArray(seq.units) && seq.units.length) want['seq:' + seq.id] = seq;
      });
      if (Array.isArray(cfg.samples)) cfg.samples.forEach(L => {
        if (L.on && L.sampleId) want['samp:' + L.id] = L;
      });
      if (Array.isArray(cfg.extras)) cfg.extras.forEach(ex => {
        if (ex && ex.present !== false && ex.on && _AMB_LAYER_SCHEMA[ex.type]) want[ex.type + ':' + ex.id] = ex;
      });
      // Build/update wanted chains (pass a one-key cfg-shim so the existing
      // _ambSyncTarget keeps reading cfg[layerKey].mod unchanged), then FX.
      Object.keys(want).forEach(key => { _ambBuildMod(key, { [key]: want[key] }); _ambApplyLayerFx(key, want[key]); });
      // Tear down chains no longer wanted (off layers, deleted seqs).
      Object.keys(_E.mod).forEach(key => { if (!(key in want)) _ambTeardownMod(key); });
      _ambApplyReverb();
    }
    // Schedule random values onto every active stochastic source within the
    // lookahead window (run each generator tick). Uses Math.random so mod
    // randomness doesn't perturb the seeded note RNG.
    function _ambScheduleStochastic(now) {
      const horizon = now + 1.2;
      for (const layer in _E.mod) {
        const e = _E.mod[layer];
        if (!e.src) continue;
        ['vca', 'vco', 'vcf'].forEach(tg => {
          const src = e.src[tg];
          if (!src || !src.node) return;
          if (src.seq) { _ambScheduleSeqSrc(src, now, horizon); return; }
          if (!src.stochastic) return;
          if (!src.nextAt || src.nextAt < now) src.nextAt = now + 0.05;
          let g = 0;
          while (src.nextAt < horizon && g++ < 48) {
            const v = src.min + Math.random() * (src.max - src.min);
            try {
              if (src.smooth) src.node.linearRampToValueAtTime(v, src.nextAt);
              else src.node.setValueAtTime(v, src.nextAt);
            } catch (x) {}
            src.nextAt += src.intervalSec;
          }
        });
      }
    }
    // Schedule-ahead a 'seq' modulation source: sample its sequence curve on a
    // uniform time grid (phase locked to the audio clock) and write it into the
    // Signal — stepped (setValueAtTime) or smooth (linearRampToValueAtTime).
    function _ambScheduleSeqSrc(src, now, horizon) {
      const curve = src.curve;
      if (!curve || !curve.points || !curve.points.length) return;
      const period = Math.max(0.02, src.periodSec || 1);
      const dt = Math.max(0.01, Math.min(period / 64, 0.04));
      if (!src.nextAt || src.nextAt < now) src.nextAt = now;
      let g = 0;
      while (src.nextAt < horizon && g++ < 256) {
        const phase = (src.nextAt / period) % 1;
        const f = _seqCurveAt(curve, phase, src.smooth ? 'smooth' : 'step');
        const v = src.min + f * (src.max - src.min);
        try {
          if (src.smooth) src.node.linearRampToValueAtTime(v, src.nextAt);
          else src.node.setValueAtTime(v, src.nextAt);
        } catch (x) {}
        src.nextAt += dt;
      }
    }
    // Routing helpers for the emit functions.
    function _ambLayerDest(layer) { const e = _E.mod[layer]; return e ? e.input : undefined; }
    function _ambLayerDetuneMod(layer) { const e = _E.mod[layer]; return (e && e.src && e.src.vco && e.src.vco.node) ? e.src.vco.node : undefined; }

    // ---- Unified schedule-ahead generator clock ------------------------
    // Per-engine clocks/iters/seqState live on the instance, keyed by layer
    // ('bed'|'motif'|'texture'|'beat'|'seq:<id>'). iters[key] also counts seq
    // CYCLES for return-to-original. Two engines can tick concurrently; each
    // tick sets the current-engine pointer _E first.
    function _ambResetClocks(E) {
      E.clocks = {}; E.iters = {}; E.seqState = {};
      E.motifDeg = null;
      E.texPattern = null; E.texStep = 0; E.texMutateAt = 0;
      E.shapePhase = {};   // per Shape-layer wheel: { startAt, lastAt } phase clocks
      E.arpState = {};     // per Arp layer: { entry, note, pos } series/sweep cursor
      E.bassPhase = {};    // per Bass layer: { startAt, lastAt } phrase-cycle clock
      E.runPhase = {};     // per Run / Pedal layer: { startAt, lastAt } loop clock — MUST reset
                           // on stop/start too, or Run/Pedal keep a stale anchor and desync
                           // from Shape (which does reset) on the next play.
      E._queuePending = null; E._queueAt = null;   // Queue-mode pending toggles
      E._t0 = null;        // engine grid anchor (set on first tick) for queued-START alignment
    }
    // Throttled tick-error logger: surfaces a scheduling fault to the console at
    // most ~once/2s (so a per-tick throw doesn't spam) without ever crashing.
    let _ambTickErrAt = 0;
    function _ambLogTickErr(e) {
      try {
        const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        if (t - _ambTickErrAt > 2000) { _ambTickErrAt = t; console.error('[Bloom] scheduling error (layer skipped):', e); }
      } catch (_) {}
    }
    function _ambTick(E) {
      _E = E;
      if (!E.guard()) { _ambStopGenerator(E); return; }
      const cfg = E.getCfg();
      // Cache the (already-normalized) cfg so the finer ramp clock can read it
      // without re-running _normalizeAmbientCfg 40×/s (that re-normalize, whose
      // cost grows with layer count, was glitching dense Bloom stacks).
      E._cfg = cfg;
      if (!cfg) return;
      const now = (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
      if (E._t0 == null) E._t0 = now;   // engine grid anchor (queued-START alignment)
      // keyMaster: drop the key schedule when no keyMaster Seq is active (so the
      // global/cfg key takes back over), then apply any boundary that's now due.
      {
        const _km = !E.isLane && Array.isArray(cfg.seqs) && cfg.seqs.some(s => s && s.keyMaster && s.on && s.present !== false && Array.isArray(s.units) && s.units.length);
        if (!_km) { E._keySched = null; } else { _ambApplyDueKey(E, now); }
      }
      // Progression clock: a shared per-engine step that advances every
      // progRateMs, so all "Progression" note-source layers move through their
      // chords together (a single harmonic pulse).
      { const pr = Math.max(250, (cfg.progRateMs | 0) || 4000); E.progStep = Math.floor((now * 1000) / pr); }
      // (Ramps run on their own finer clock — see _ambStartGenerator.)
      // Schedule lead-time: how far ahead of "now" the first events land. A
      // larger lead gives freshly-created voice nodes time to connect + the
      // audio graph time to settle before they sound, so dense stacks (several
      // lane/Seq layers) don't pop / cut in and out. Bloom is generative (not
      // touch-triggered), so the extra ~0.2 s latency is inaudible. Horizon
      // grows with it to keep a comfortable buffer across ticks.
      const horizon = now + 1.4, lead = now + 0.3;
      const space = cfg.space | 0;
      const C = E.clocks, I = E.iters;
      // Solo: if ANY on layer is soloed, only soloed layers sound.
      const anySolo = _ambComputeAnySolo(cfg);
      const _muted = (lc) => anySolo && !(lc && lc.solo);
      try { _ambScheduleStochastic(now); } catch (e) {} // feed the stochastic LFOs
      // ---- Queue mode per-layer gate ------------------------------------
      // A queued on/off change lands on THAT layer's own iteration boundary
      // (the time stored on the pending entry's `at`). For a STOP we keep the
      // layer scheduling but CLAMP its horizon to `at`, so the current
      // iteration plays out and nothing past the boundary is ever scheduled;
      // when now crosses `at` the layer flips off cleanly. For a START we hold
      // the (off) layer silent until its boundary enters the lookahead, then
      // anchor its clock/phase exactly to `at` and flip on, so the first event
      // sounds on the boundary. _qGate returns {run, hz}; `anchor(at)` seeds the
      // layer's clock when a START arms. Boolean changes are persisted once per
      // tick via _qChanged.
      let _qChanged = false;
      const _qFinalize = (key, it, val) => {
        it.L.on = val;
        if (it.onB) { it.onB.classList.toggle('on', val); it.onB.classList.remove('queued'); }
        // Build (START) / tear down (STOP) the layer's mod chain. START builds
        // SYNCHRONOUSLY (not via _ambSyncOneLayerMod's rAF) so the very first
        // emit this same tick resolves the layer's destination — otherwise the
        // first iteration routed to the default bus (wrong level / no FX) until
        // the rAF landed.
        try {
          if (val) { _ambBuildMod(key, { [key]: it.L }); _ambApplyLayerFx(key, it.L); _ambApplyReverb(); }
          else { _ambSyncOneLayerMod(E, key, it.L); }
        } catch (e) {}
        delete E._queuePending[key];
        _qChanged = true;
      };
      const _qGate = (key, on, anchor) => {
        const it = E._queuePending && E._queuePending[key];
        if (!it) return { run: on, hz: horizon };
        if (it.desired === false) {                 // queued STOP
          if (now >= it.at) { _qFinalize(key, it, false); return { run: false, hz: horizon }; }
          return { run: true, hz: Math.min(horizon, it.at) }; // schedule only up to the boundary
        }
        // queued START
        if (horizon >= it.at) {                      // boundary now within lookahead → arm it
          // The stored boundary can slide too close to `now` (ticks are coarse),
          // which would schedule the first event with no graph-settle headroom —
          // the layer popped or didn't start. Step the start forward by whole
          // periods (staying on its grid) until it has at least `lead` ahead.
          let startAt = it.at;
          const P = it.period || 0;
          if (P > 0) { let g = 0; while (startAt < lead && g++ < 4096) startAt += P; }
          else if (startAt < lead) startAt = lead;
          try { if (typeof anchor === 'function') anchor(startAt); } catch (e) {}
          _qFinalize(key, it, true);
          return { run: true, hz: horizon };
        }
        return { run: false, hz: horizon };          // still silent until the boundary nears
      };
      const runLayer = (key, lc, guardMax, minSec, emit, hz) => {
        if (!lc || lc.present === false || _ambFreezeFrozen(E, key)) return;
        if (E.windingDown) return; // Capture finalize: no new iterations (current ones, already scheduled, play out)
        const HZ = hz || horizon;
        if (!C[key] || C[key] < now) C[key] = lead + _ambDriftOffset(lc, cfg);
        const sc = _ambLayerScale(E, key, lc, cfg);   // Unit Sync time-scale (1 = Free)
        let g = 0;
        while (C[key] < HZ && g++ < guardMax) {
          if (_ambCondFires(lc.when, I[key] | 0)) emit(C[key]);
          I[key] = (I[key] | 0) + 1;
          C[key] += Math.max(minSec, _ambStepSecFor(lc, minSec, cfg) * sc);   // floor so a fast Sync can't flood
        }
      };
      // Freeze-aware wrapper: frozen → replay the captured loop; recording →
      // generate normally while teeing each note into the capture sink.
      const stepLayer = (key, lc, guardMax, minSec, emit) => {
        if (!lc) return;
        if (_muted(lc)) return; // silenced by another layer's solo
        const g = _qGate(key, !!lc.on, (t) => { C[key] = t; });
        if (!g.run) return;
        if (_ambFreezeGate(E, key, now, g.hz)) return;
        window._ambCaptureSink = _ambCapSink(E, key); // always roll-capture
        try { runLayer(key, lc, guardMax, minSec, emit, g.hz); }
        catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
      };
      // Windowed wrapper — like stepLayer but for engines that schedule a whole
      // BPM-locked phrase over the lookahead (e.g. the Euclidean Beat). Anchors a
      // phase clock in E[anchorStore] and honors solo / freeze / queue / capture.
      const windowLayer = (key, lc, anchorStore, emit) => {
        if (!lc) return;
        if (_muted(lc)) return;
        const gate = _qGate(key, !!lc.on, (t) => { if (!E[anchorStore]) E[anchorStore] = {}; E[anchorStore][key] = { startAt: t, lastAt: null }; });
        if (!gate.run) return;
        if (_ambFreezeGate(E, key, now, gate.hz)) return;
        window._ambCaptureSink = _ambCapSink(E, key);
        try { emit(E, lc, key, now, gate.hz, lead, space, cfg); }
        catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
      };
      stepLayer('bed', cfg.bed, 8, 0.05, (at) => _ambEmitBed(at, cfg.bed, space));
      stepLayer('motif', cfg.motif, 16, 0.04, (at) => _ambEmitMotif(at, cfg.motif, space));
      stepLayer('texture', cfg.texture, 16, 0.03, (at) => _ambEmitTexture(at, cfg.texture, space));
      if (cfg.beat && cfg.beat.gen === 'euclid') windowLayer('beat', cfg.beat, 'runPhase', _ambEmitBeatEuclid);
      else stepLayer('beat', cfg.beat, 16, 0.04, (at) => _ambEmitBeat(at, cfg.beat, space));
      // Seq layers (dynamic list). Auto mode WINDOWS each phrase: only the
      // events falling inside the 1.2 s horizon are scheduled per tick, and the
      // rest resume on later ticks (the phrase plan persists in stSeq.plan).
      // This spreads a long phrase's node creation across ticks the same way
      // bed/motif/etc. already do — fixing the "long seq glitches/cuts out ~4/5
      // through, then choppily resumes next iteration" burst. Manual mode (where
      // phrases can overlap) still emits a whole phrase per fire.
      if (Array.isArray(cfg.seqs)) {
        for (const seq of cfg.seqs) { try {
          if (!seq || !Array.isArray(seq.units) || !seq.units.length) continue;
          const key = 'seq:' + seq.id;
          const stSeq = E.seqState[seq.id] || (E.seqState[seq.id] = { pick: 0, iter: 0 });
          if (_muted(seq)) continue;
          if (E.windingDown) continue; // Capture finalize: let the current unit finish, start no more
          // Queue mode: STOP clamps HZ to the phrase boundary; START anchors the
          // next phrase to it and flips on.
          const gate = _qGate(key, !!seq.on, (t) => { C[key] = t; stSeq.plan = null; });
          if (!gate.run) { stSeq.plan = null; continue; }
          const HZ = gate.hz;
          if (_ambFreezeGate(E, key, now, HZ)) { stSeq.plan = null; continue; }
          window._ambCaptureSink = _ambCapSink(E, key);
          // C[key] tracks the NEXT phrase's start (always in the future); the
          // in-flight phrase streams separately via stSeq.plan, so C[key] never
          // sits in the past and the re-anchor guard below can't misfire.
          if (!C[key] || C[key] < now - 0.001) { C[key] = lead + _ambDriftOffset(seq, cfg); stSeq.plan = null; }
          const manual = (seq.intervalMode === 'manual');
          // Schedule a plan's events whose absolute start is inside the horizon;
          // returns true when the whole plan is scheduled (nothing left).
          const _streamPlan = (plan) => {
            for (; plan.cur < plan.events.length; plan.cur++) {
              const ev = plan.events[plan.cur];
              const evAt = plan.baseAt + ev.offMs / 1000;
              if (evAt >= HZ) return false;
              _ambEmitSeqEvent(plan.ctx, ev, evAt, stSeq);
            }
            return true;
          };
          // (A) Continue an in-flight auto phrase from where the last tick left off.
          if (stSeq.plan && _streamPlan(stSeq.plan)) stSeq.plan = null;
          // (B) Start new phrases whose start falls within the horizon.
          let g = 0;
          while (C[key] < HZ && g++ < 64) {
            if (!manual && stSeq.plan) break; // auto: one phrase streams at a time
            const fires = _ambCondFires(seq.when, I[key] | 0);
            stSeq.iter = I[key] | 0;
            I[key] = (I[key] | 0) + 1;
            if (!fires) {
              const skipMs = (stSeq._lastUnitMs > 0) ? stSeq._lastUnitMs : _unitTotalMs(seq.units[0]);
              C[key] += manual ? _ambSnap(Math.max(0.1, (seq.intervalMs | 0) / 1000), cfg)
                               : Math.max(0.1, (skipMs > 0 ? skipMs : (seq.intervalMs | 0)) / 1000);
              continue;
            }
            const plan = _ambRealizeSeqPhrase(C[key], seq, space, stSeq);
            if (!plan) { C[key] += Math.max(0.1, (seq.intervalMs | 0) / 1000); continue; }
            // Reflect the tone now playing onto the layer's Tone dropdown.
            try {
              const ev0 = plan.events && plan.events[0];
              _ambSeqReflectTone(E, seq.id, (ev0 && ev0.sounds && ev0.sounds[0]) || (plan.ctx && plan.ctx.type));
            } catch (e) {}
            if (manual) {
              // Whole phrase now; next starts after the (snapped) Interval knob.
              for (let i = 0; i < plan.events.length; i++) {
                const ev = plan.events[i];
                _ambEmitSeqEvent(plan.ctx, ev, plan.baseAt + ev.offMs / 1000, stSeq);
              }
              C[key] += _ambSnap(Math.max(0.1, (seq.intervalMs | 0) / 1000), cfg);
              continue;
            }
            // Auto: stream within the horizon now, advance C[key] to the NEXT
            // phrase start (future) by the unit's natural length, and keep the
            // plan if it didn't finish so the next tick resumes it.
            const done = _streamPlan(plan);
            const advMs = (plan.advanceMs > 0) ? plan.advanceMs
              : (stSeq._lastUnitMs > 0 ? stSeq._lastUnitMs : (seq.intervalMs | 0));
            C[key] = plan.baseAt + Math.max(0.1, advMs / 1000);
            stSeq.plan = done ? null : plan;
            if (!done) break; // still streaming this phrase across ticks
          }
          window._ambCaptureSink = null; _ambPruneCap(E, key, now);
        } catch (e) { _ambLogTickErr(e); window._ambCaptureSink = null; } }
      }
      // Sample layers (dynamic list). Each fire schedules up to `chop` slices.
      if (Array.isArray(cfg.samples)) {
        for (const L of cfg.samples) { try {
          if (!L || !L.sampleId) continue;
          const key = 'samp:' + L.id;
          if (_muted(L)) continue;
          if (E.windingDown) continue; // Capture finalize: start no more slices
          const gate = _qGate(key, !!L.on, (t) => { C[key] = t; });
          if (!gate.run) continue;
          const HZ = gate.hz;
          if (_ambFreezeGate(E, key, now, HZ)) continue;
          window._ambCaptureSink = _ambCapSink(E, key);
          if (!C[key] || C[key] < now) C[key] = lead + _ambDriftOffset(L, cfg);
          let g = 0;
          while (C[key] < HZ && g++ < 4) {
            if (_ambCondFires(L.when, I[key] | 0)) {
              const st = E.seqState[key] || (E.seqState[key] = { pick: 0, iter: 0 });
              st.iter = I[key] | 0;
              _ambEmitSample(C[key], L, space, st);
            }
            I[key] = (I[key] | 0) + 1;
            C[key] += _ambSnap(Math.max(0.1, (L.intervalMs | 0) / 1000), cfg);
          }
          window._ambCaptureSink = null; _ambPruneCap(E, key, now);
        } catch (e) { _ambLogTickErr(e); window._ambCaptureSink = null; } }
      }
      // Extra layer instances (additional Bed/Motif/Texture/Beat). runLayer
      // gates present/on/frozen and reads the instance's intervalMs/when.
      if (Array.isArray(cfg.extras)) {
        for (const ex of cfg.extras) { try {
          if (!ex || !_AMB_LAYER_SCHEMA[ex.type]) continue;
          const key = ex.type + ':' + ex.id;
          // Shape layers schedule continuously over the lookahead window (not on
          // the interval grid stepLayer uses), so they get their own path —
          // still honoring solo / freeze / wind-down / roll-capture.
          if (ex.type === 'shape') {
            if (ex.present === false || _muted(ex) || E.windingDown) continue;
            const gate = _qGate(key, !!ex.on, (t) => { if (!E.shapePhase) E.shapePhase = {}; (ex.shapes || []).forEach((_, i) => { E.shapePhase[key + '#' + i] = { startAt: t, lastAt: null }; }); });
            if (!gate.run) continue;
            if (_ambFreezeGate(E, key, now, gate.hz)) continue;
            window._ambCaptureSink = _ambCapSink(E, key);
            try { _ambEmitShape(E, ex, key, now, gate.hz, lead, space, cfg); }
            catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
            continue;
          }
          // Bass layers realize a multi-bar euclidean phrase over the lookahead
          // window (their own path, like Shape) so the seed phrase + per-cycle
          // variation stay locked to the BPM and re-read config at cycle edges.
          if (ex.type === 'bass') {
            if (ex.present === false || _muted(ex) || E.windingDown) continue;
            const gate = _qGate(key, !!ex.on, (t) => { if (!E.bassPhase) E.bassPhase = {}; E.bassPhase[key] = { startAt: t, lastAt: null }; });
            if (!gate.run) continue;
            if (_ambFreezeGate(E, key, now, gate.hz)) continue;
            window._ambCaptureSink = _ambCapSink(E, key);
            try { _ambEmitBass(E, ex, key, now, gate.hz, lead, space, cfg); }
            catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
            continue;
          }
          // Run layers: a fixed random note-run that loops every `bars` bars,
          // mutated by Vary. Windowed/phase-anchored like Bass.
          if (ex.type === 'run') {
            if (ex.present === false || _muted(ex) || E.windingDown) continue;
            const gate = _qGate(key, !!ex.on, (t) => { if (!E.runPhase) E.runPhase = {}; E.runPhase[key] = { startAt: t, lastAt: null }; });
            if (!gate.run) continue;
            if (_ambFreezeGate(E, key, now, gate.hz)) continue;
            window._ambCaptureSink = _ambCapSink(E, key);
            try { _ambEmitRun(E, ex, key, now, gate.hz, lead, space, cfg); }
            catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
            continue;
          }
          // Pedal layers: a simple root-note loop. Windowed/phase-anchored too.
          if (ex.type === 'pedal') {
            if (ex.present === false || _muted(ex) || E.windingDown) continue;
            const gate = _qGate(key, !!ex.on, (t) => { if (!E.runPhase) E.runPhase = {}; E.runPhase[key] = { startAt: t, lastAt: null }; });
            if (!gate.run) continue;
            if (_ambFreezeGate(E, key, now, gate.hz)) continue;
            window._ambCaptureSink = _ambCapSink(E, key);
            try { _ambEmitPedal(E, ex, key, now, gate.hz, lead, space, cfg); }
            catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
            continue;
          }
          // Drone layers: hold a note/chord, re-struck every `hold` units.
          // Windowed/phase-anchored like Pedal.
          if (ex.type === 'drone') {
            if (ex.present === false || _muted(ex) || E.windingDown) continue;
            const gate = _qGate(key, !!ex.on, (t) => { if (!E.runPhase) E.runPhase = {}; E.runPhase[key] = { startAt: t, lastAt: null }; });
            if (!gate.run) continue;
            if (_ambFreezeGate(E, key, now, gate.hz)) continue;
            window._ambCaptureSink = _ambCapSink(E, key);
            try { _ambEmitDrone(E, ex, key, now, gate.hz, lead, space, cfg); }
            catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
            continue;
          }
          // Euclidean Beat extra: windowed phrase like the primary beat.
          if (ex.type === 'beat' && ex.gen === 'euclid') {
            if (ex.present === false || _muted(ex) || E.windingDown) continue;
            const gate = _qGate(key, !!ex.on, (t) => { if (!E.runPhase) E.runPhase = {}; E.runPhase[key] = { startAt: t, lastAt: null }; });
            if (!gate.run) continue;
            if (_ambFreezeGate(E, key, now, gate.hz)) continue;
            window._ambCaptureSink = _ambCapSink(E, key);
            try { _ambEmitBeatEuclid(E, ex, key, now, gate.hz, lead, space, cfg); }
            catch (e) { _ambLogTickErr(e); } finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
            continue;
          }
          const gm = ex.type === 'bed' ? 8 : (ex.type === 'arp' ? 24 : 16);
          const ms = ex.type === 'bed' ? 0.05 : (ex.type === 'motif' ? 0.04 : 0.03);
          stepLayer(key, ex, gm, ms, (at) => {
            if (ex.type === 'bed') _ambEmitBed(at, ex, space, key);
            else if (ex.type === 'motif') _ambEmitMotif(at, ex, space, key);
            else if (ex.type === 'texture') _ambEmitTexture(at, ex, space, key);
            else if (ex.type === 'arp') _ambEmitArp(at, ex, space, key);
            else _ambEmitBeat(at, ex, space, key);
          });
        } catch (e) { _ambLogTickErr(e); window._ambCaptureSink = null; } }
      }
      // Queue mode: a layer toggle landed on its boundary this tick → persist.
      if (_qChanged && typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
      _ambKeyTime = null;   // clear the per-note key-time stamp after the tick
    }
    // Dedicated 40 Hz ramp clock — runs ONLY while the engine is playing AND
    // has at least one ramp. Reads the tick-cached cfg (no re-normalize).
    // ---- "Always listening": rolling capture of the master output ----------
    // A chain of short MediaRecorder segments (each a complete, decodable clip)
    // keeps the most recent ~36s of whatever is playing. "Grab" stitches the
    // last 30s of PCM into a WAV and registers it as a sample. Segmented (not
    // one long recorder) so a bounded tail can actually be decoded; native
    // MediaRecorder fan-out off masterLimiter adds no main-thread audio work.
    const _AL = { on: false, rec: null, dest: null, segs: [], segMs: 4000, keepMs: 36000, busy: false };
    // The node to fan recordings off — the FINAL master node (post lookahead-
    // limiter + soft-clip) so a recording matches what's heard. Falls back to
    // the (now output-orphaned) Tone limiter only if the clipper is absent.
    function _ambMasterTapNode() {
      if (typeof masterClipper !== 'undefined' && masterClipper) return masterClipper;
      if (typeof masterLimiter !== 'undefined' && masterLimiter) return masterLimiter;
      return null;
    }
    function _alSupported() { return (typeof MediaRecorder !== 'undefined') && !!_ambMasterTapNode(); }
    function _alStart() {
      if (_AL.on || !_alSupported()) return false;
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { return false; }
      try { _AL.dest = ac.createMediaStreamDestination(); _AL.tap = _ambMasterTapNode(); _AL.tap.connect(_AL.dest); } catch (e) { return false; }
      _AL.on = true; _AL.segs = [];
      _alNextSeg();
      return true;
    }
    function _alNextSeg() {
      if (!_AL.on || !_AL.dest) return;
      let rec; const chunks = [];
      try {
        const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
        const mime = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
        rec = new MediaRecorder(_AL.dest.stream, mime ? { mimeType: mime } : undefined);
      } catch (e) { _AL.on = false; return; }
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        if (chunks.length) {
          _AL.segs.push(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          const maxSegs = Math.ceil(_AL.keepMs / _AL.segMs) + 1;
          while (_AL.segs.length > maxSegs) _AL.segs.shift();
        }
        if (_AL.on) _alNextSeg();
      };
      try { rec.start(); } catch (e) { _AL.on = false; return; }
      _AL.rec = rec;
      setTimeout(() => { try { rec.stop(); } catch (e) {} }, _AL.segMs);
    }
    function _alStop() {
      _AL.on = false;
      try { _AL.rec && _AL.rec.stop(); } catch (e) {}
      try { if (_AL.dest && _AL.tap) _AL.tap.disconnect(_AL.dest); } catch (e) {}
      _AL.dest = null; _AL.tap = null; _AL.segs = [];
    }
    // Decode a list of recorded segments and stitch the LAST `seconds` of PCM
    // into one AudioBuffer (≤2ch). Shared by always-listen grab + layer freeze.
    async function _segsToBuffer(ac, segs, seconds) {
      const bufs = [];
      for (const blob of segs) { try { bufs.push(await ac.decodeAudioData(await blob.arrayBuffer())); } catch (e) {} }
      if (!bufs.length) return null;
      const sr = bufs[0].sampleRate;
      const ch = Math.min(2, bufs.reduce((m, b) => Math.max(m, b.numberOfChannels), 1));
      const total = bufs.reduce((n, b) => n + b.length, 0);
      const wantLen = Math.min(total, Math.floor(seconds * sr));
      const startSkip = total - wantLen;
      const out = ac.createBuffer(ch, wantLen, sr);
      let srcPos = 0, dstPos = 0;
      for (const b of bufs) {
        const len = b.length;
        const chans = []; for (let c = 0; c < ch; c++) chans.push(b.getChannelData(Math.min(c, b.numberOfChannels - 1)));
        for (let i = 0; i < len; i++) {
          if (srcPos + i >= startSkip) { for (let c = 0; c < ch; c++) out.getChannelData(c)[dstPos] = chans[c][i]; dstPos++; }
        }
        srcPos += len;
      }
      return out;
    }
    async function _alGrab(seconds) {
      if (_AL.busy) return;
      seconds = seconds || 30;
      const segs = _AL.segs.slice();
      if (!segs.length) { alert('Nothing buffered yet — turn on Listen and let it play a few seconds.'); return; }
      _AL.busy = true;
      try {
        let ac; try { ac = Tone.getContext().rawContext; } catch (e) { throw new Error('No audio context'); }
        const out = await _segsToBuffer(ac, segs, seconds);
        if (!out) throw new Error('Could not decode buffered audio.');
        const wantLen = out.length, sr = out.sampleRate;
        const wav = (typeof audioBufferToWav === 'function') ? audioBufferToWav(out) : null;
        if (!wav) throw new Error('WAV encoder unavailable.');
        let stamp = 'take'; try { stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); } catch (e) {}
        const reg = (typeof registerSampleFromBlob === 'function') ? await registerSampleFromBlob(wav, 'listen-' + stamp) : null;
        if (typeof showToast === 'function') showToast(reg ? ('Saved last ' + Math.round(wantLen / sr) + 's as sample “' + reg.name + '”') : 'Grab complete');
      } catch (e) { alert('Grab failed: ' + ((e && e.message) || e)); }
      finally { _AL.busy = false; }
    }
    // ---- Per-layer Freeze → loop (RETROACTIVE event capture) ----------------
    // The layer's generated notes (freq / params / step-div duration / time) are
    // ALWAYS streamed into a cheap rolling buffer (E.cap[key]) as it plays. A
    // single Freeze press loops the LAST N seconds that ALREADY played (N =
    // Freeze length), snapped to the layer's note grid so it links up; press
    // again to Thaw and resume generation. Symbolic (not audio), so it's seamless.
    // Solo: true when at least one ON layer (of any type) is soloed — in which
    // case only soloed layers sound. A soloed-but-off layer doesn't engage solo.
    function _ambComputeAnySolo(cfg) {
      if (!cfg) return false;
      if (['bed', 'motif', 'texture', 'beat'].some(k => cfg[k] && cfg[k].present !== false && cfg[k].on && cfg[k].solo)) return true;
      if (Array.isArray(cfg.extras) && cfg.extras.some(x => x && x.present !== false && x.on && x.solo)) return true;
      if (Array.isArray(cfg.seqs) && cfg.seqs.some(s => s && s.on && s.solo)) return true;
      if (Array.isArray(cfg.samples) && cfg.samples.some(s => s && s.on && s.solo)) return true;
      return false;
    }
    function _ambToggleSolo(E, key) {
      const layer = _ambLayerByKey(E, key); if (!layer) return;
      layer.solo = !layer.solo;
      _ambSoloSyncAll(E);
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _ambSoloSyncAll(E) {
      const host = document.getElementById(E.hostId); if (!host) return;
      host.querySelectorAll('.ambient-solo-btn').forEach(btn => {
        const layer = _ambLayerByKey(E, btn.dataset.skey);
        btn.classList.toggle('soloed', !!(layer && layer.solo));
      });
    }
    function _ambFreezeState(E, key) {
      E.freeze = E.freeze || {};
      return E.freeze[key] || (E.freeze[key] = { frozen: false, recording: false, recStart: 0, events: [], loopLen: 0, anchor: 0, scheduledUpto: 0, pendingThawAt: null });
    }
    function _ambFreezeFrozen(E, key) { return !!(E && E.freeze && E.freeze[key] && E.freeze[key].frozen); }
    // Resolve a freeze key ('bed' | 'bed:5' | 'seq:3' | 'samp:2') → its layer cfg.
    // Rename a layer (any type) via its header ✎ button. The user-set name lives
    // in layer.label; clearing it reverts to the type default. Updates the head
    // span live and re-renders the mixer so its channel label tracks.
    function _ambRenameLayer(E, btn) {
      const key = btn && btn.dataset && btn.dataset.rkey; if (!key) return;
      const layer = _ambLayerByKey(E, key); if (!layer) return;
      const head = btn.closest('.ambient-layer-head');
      const span = head ? head.querySelector('.ambient-layer-name') : null;
      const cur = (typeof layer.label === 'string' && layer.label.trim())
        ? layer.label.trim() : (span ? span.textContent.trim() : '');
      const next = (typeof prompt === 'function') ? prompt('Layer name (leave blank to reset):', cur) : null;
      if (next === null) return;                       // cancelled
      const name = String(next).trim();
      if (name) layer.label = name; else delete layer.label;
      if (span) span.textContent = name || cur;        // empty → keep showing default
      // If reset, recompute the default label for the span text.
      if (!name && span) {
        const ci = key.indexOf(':');
        let fb = span.textContent;
        if (ci < 0) fb = key.charAt(0).toUpperCase() + key.slice(1);   // primary: type name
        else {
          const t = key.slice(0, ci), cfg = E.getCfg() || {};
          if (t === 'seq') { const i = (cfg.seqs || []).findIndex(s => s === layer); fb = 'Seq' + (i + 1); }
          else if (t === 'samp') { const i = (cfg.samples || []).findIndex(s => s === layer); fb = 'Sample' + (i + 1); }
          else { const sch = _AMB_LAYER_SCHEMA[t]; fb = (sch && sch.label) ? sch.label : t; }
        }
        span.textContent = fb;
      }
      if (typeof persistWorkspace === 'function') persistWorkspace();
      try { _ambRenderMixer(E); } catch (e) {}
    }
    function _ambLayerByKey(E, key) {
      const cfg = E._cfg || E.getCfg(); if (!cfg) return null;
      const ci = key.indexOf(':');
      if (ci < 0) return cfg[key] || null;
      const t = key.slice(0, ci), id = parseInt(key.slice(ci + 1), 10);
      if (t === 'seq') return (cfg.seqs || []).find(s => s.id === id) || null;
      if (t === 'samp') return (cfg.samples || []).find(s => s.id === id) || null;
      return (cfg.extras || []).find(x => x.id === id && x.type === t) || null;
    }
    // Rolling-capture sink (set on window so cross-file playNote can see it),
    // active around every NON-frozen layer's emit. Stores notes by absolute time.
    function _ambCapSink(E, key) {
      E.cap = E.cap || {};
      const arr = E.cap[key] || (E.cap[key] = []);
      return (freq, params, dur, at) => {
        if (typeof freq !== 'number' || typeof at !== 'number') return;
        const p = {}; for (const k in params) { if (k === '_detuneMod') continue; p[k] = params[k]; }
        arr.push({ at: at, freq: freq, dur: dur, params: p });
      };
    }
    function _ambPruneCap(E, key, now) {
      const arr = E.cap && E.cap[key]; if (!arr || !arr.length) return;
      const keepFrom = now - 33; // keep ~last 33s (≥ max Freeze length)
      let i = 0; while (i < arr.length && arr[i].at < keepFrom) i++;
      if (i > 0) arr.splice(0, i);
    }
    // First press: mark the loop start (the layer keeps generating; notes keep
    // rolling into the capture sink). The window between this press and the next
    // becomes the loop.
    function _ambFreezeArm(E, key) {
      const st = _ambFreezeState(E, key);
      st.recording = true; st.frozen = false; st.events = []; st.pendingThawAt = null;
      st.recStart = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    }
    // Nearest captured note onset to a target time (within a sane range), so the
    // loop boundaries land on real note events rather than mid-note.
    function _ambNearestOnset(cap, target, lo, hi) {
      let best = null, bestD = Infinity;
      for (let i = 0; i < cap.length; i++) {
        const a = cap[i].at;
        if (a < lo || a > hi) continue;
        const d = Math.abs(a - target);
        if (d < bestD) { bestD = d; best = a; }
      }
      return best;
    }
    // Second press: the window between the two presses is the loop. Snap both
    // boundaries to the nearest captured note onset so the loop tiles cleanly,
    // then commit the events (relative to the start) and start looping.
    function _ambFreezeCommit(E, key) {
      const st = _ambFreezeState(E, key);
      const cap = (E.cap && E.cap[key]) || [];
      const layer = _ambLayerByKey(E, key);
      const intervalSec = Math.max(0.05, (((layer && layer.intervalMs) | 0) / 1000) || 1);
      const P1 = st.recStart || 0;
      const P2 = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
      // Capture EXACTLY what played between the two presses. Earlier this snapped
      // the window to the nearest captured onsets, which on a sparse layer (long
      // Interval) could slide the window off the notes the user actually heard.
      // The loop length is the held duration; the `anchor` below still snaps the
      // loop START onto the grid so the handoff lands cleanly.
      let loopStart = P1;
      let loopEnd = P2;
      if (loopEnd <= loopStart + 0.01) loopEnd = loopStart + intervalSec; // too-fast double press
      const eps = 0.001;
      const win = cap.filter(e => e.at >= loopStart - eps && e.at < loopEnd - eps);
      if (!win.length) {
        // Nothing played between the presses — abandon, back to idle.
        st.recording = false; st.frozen = false;
        if (typeof showToast === 'function') showToast('Freeze: no notes between the two presses — try a longer span.');
        _ambFreezeSyncAll(E);
        return;
      }
      st.events = win.map(e => ({ t: Math.max(0, e.at - loopStart), freq: e.freq, dur: e.dur, params: e.params }));
      st.loopLen = loopEnd - loopStart;
      // Begin the loop when the current generative iteration reaches its end —
      // i.e. at the layer's next scheduled onset (E.clocks[key]), so the handoff
      // from generation to loop lands cleanly on the grid. Fall back to a small
      // lead past the press if no clock is available.
      const nextOnset = E.clocks && E.clocks[key];
      const A = (typeof nextOnset === 'number' && nextOnset > P2) ? nextOnset : (P2 + 0.12);
      st.anchor = A; st.scheduledUpto = A;
      st.recording = false; st.frozen = true; st.pendingThawAt = null;
      _ambFreezeSyncAll(E);
    }
    // Schedule the frozen layer's looped events that fall in [now, horizon].
    function _ambReplayFrozen(E, key, now, horizon) {
      const st = E.freeze && E.freeze[key];
      if (!st || !st.frozen || !st.events.length || !(st.loopLen > 0)) return;
      const dest = (E.mod[key] && E.mod[key].input) || E.busNode();
      let from = st.scheduledUpto;
      if (from == null || from < now) from = Math.max(now, st.anchor || now);
      const L = st.loopLen, A = st.anchor || now;
      let k = Math.max(0, Math.floor((from - A) / L)), guard = 0;
      while (guard++ < 4096) {
        const base = A + k * L;
        if (base >= horizon) break;
        for (const e of st.events) {
          const at = base + e.t;
          if (at >= from && at < horizon) { try { playNote(e.freq, e.params, e.dur, at, dest, undefined, E.laneIdx()); } catch (x) {} }
        }
        k++;
      }
      st.scheduledUpto = horizon;
    }
    // Thaw is deferred: schedule generation to resume at the end of the loop's
    // current iteration (symmetric with Freeze, which starts on the grid). The
    // actual flip happens in _ambFreezeGate once that boundary enters the
    // scheduling horizon.
    function _ambFreezeThaw(E, key) {
      const st = E.freeze && E.freeze[key];
      if (!st) return;
      if (st.recording) { st.recording = false; st.events = []; _ambFreezeSyncAll(E); return; }
      if (!st.frozen) return;
      const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
      const A = st.anchor || now, L = st.loopLen || 0;
      if (L > 0) {
        // Resume generation only AFTER the furthest already-scheduled loop
        // iteration finishes. Loop events are committed across the lookahead
        // window (up to scheduledUpto); deferring merely to the next boundary
        // past `now` would let those queued iterations keep sounding past the
        // handoff and overlap the freshly generated notes.
        const ref = Math.max(now, st.scheduledUpto || now);
        const k = Math.max(1, Math.ceil((ref - A) / L)); // boundary at/after the last queued loop
        st.pendingThawAt = A + k * L;
      } else {
        st.frozen = false; st.scheduledUpto = 0; st.events = [];
      }
      _ambFreezeSyncAll(E);
    }
    // Per-tick freeze gate. Returns true if the caller should SKIP generation
    // (the loop is playing); false if it should generate. Handles the deferred
    // thaw: when the iteration boundary enters the horizon, it flushes the loop
    // tail up to the boundary, flips back to generation, and re-grids the clock.
    function _ambFreezeGate(E, key, now, horizon) {
      const st = E.freeze && E.freeze[key];
      if (!st || !st.frozen) return false;
      const tA = st.pendingThawAt;
      if (tA != null && horizon >= tA) {
        _ambReplayFrozen(E, key, now, tA);          // flush remaining loop events up to the boundary
        st.frozen = false; st.scheduledUpto = 0; st.pendingThawAt = null; st.events = [];
        try { _ambFreezeSyncAll(E); } catch (e) {}
        if (E.clocks && tA > now) E.clocks[key] = tA; // generation resumes exactly on the grid
        return false;
      }
      _ambReplayFrozen(E, key, now, (tA != null) ? Math.min(horizon, tA) : horizon);
      return true;
    }
    // One button, three states: idle → (arm) recording → (commit) looping → (thaw) idle.
    function _ambFreezeCycle(E, key) {
      const st = _ambFreezeState(E, key);
      if (st.frozen) _ambFreezeThaw(E, key);
      else if (st.recording) _ambFreezeCommit(E, key);
      else _ambFreezeArm(E, key);
      _ambFreezeSyncAll(E);
    }
    function _ambFreezeStopAll(E) {
      if (!E) return;
      window._ambCaptureSink = null;
      E.freeze = {}; E.cap = {};
      try { _ambFreezeSyncAll(E); } catch (e) {}
    }
    function _ambFreezeSyncAll(E) {
      const host = document.getElementById(E.hostId); if (!host) return;
      host.querySelectorAll('.ambient-freeze-btn').forEach(btn => {
        const fs = E.freeze && E.freeze[btn.dataset.fkey];
        const frozen = !!(fs && fs.frozen), recording = !!(fs && fs.recording);
        btn.classList.toggle('frozen', frozen);
        btn.classList.toggle('recording', recording);
        btn.textContent = frozen ? 'Thaw' : recording ? '◉' : '❄';
        btn.title = frozen ? 'Thaw — resume generative playback'
                  : recording ? 'Recording — press again to set the loop end'
                  : 'Freeze — press to start the loop, press again to set its length';
      });
    }
    // Reset a Bloom instance to defaults: one Bed, default parameters, no extra
    // layers / ramps. Published wraps + progressions (a shared library, not
    // instance state) are preserved on the master.
    function _ambResetInstance(E) {
      if (typeof confirm === 'function' && !confirm('Reset this Bloom to defaults? This clears its layers, ramps, and settings.')) return;
      _E = E;
      const wasPlaying = !!E.timer;
      try { _ambStopGenerator(E); } catch (e) {}
      const def = _defaultAmbientConfig();
      if (E.isLane) {
        const lane = (typeof lanes !== 'undefined') ? lanes[activeLaneIdx] : null;
        if (lane) lane.ambient = def;
      } else {
        if (masterAmbient && Array.isArray(masterAmbient.publishedWraps)) def.publishedWraps = masterAmbient.publishedWraps;
        if (masterAmbient && Array.isArray(masterAmbient.publishedProgs)) def.publishedProgs = masterAmbient.publishedProgs;
        masterAmbient = def;
      }
      // Clear per-run engine state + any built mod/FX chains + freeze loops.
      try { _ambFreezeStopAll(E); } catch (e) {}
      try { _ambTeardownMods(); } catch (e) {}
      E.seqState = {}; E.clocks = {}; E.iters = {}; E.progStep = 0;
      E.motifDeg = null; E.texPattern = null; E.texStep = 0; E.texMutateAt = 0;
      _ambSyncControls(E);
      if (wasPlaying) { try { _ambStartGenerator(E); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _ambStartRampClock(E) {
      if (!E || E.rampTimer) return;
      const c = E._cfg || (E._cfg = E.getCfg());
      if (!c || !Array.isArray(c.ramps) || !c.ramps.length) return;
      E.rampTimer = setInterval(() => {
        try {
          const cfg = E._cfg;
          if (!cfg || !Array.isArray(cfg.ramps) || !cfg.ramps.length) { _ambStopRampClock(E); return; }
          const t = (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
          // Phase is measured from PLAY START (E._t0, reset on every play) — not the
          // absolute audio clock — so each ramp begins at A on play and the wave
          // freezes (clock stops) on Stop, rather than continuing mid-cycle.
          _ambApplyRamps(cfg, t - ((E._t0 != null) ? E._t0 : t));
          // Update the visual cue at ~20 Hz (every other 25 ms tick) — smooth
          // enough to read, half the DOM writes.
          E._rampVizTick = (E._rampVizTick | 0) + 1;
          if ((E._rampVizTick & 1) === 0) _ambRampViz(E);
        } catch (e) {}
      }, 25);
    }
    function _ambStopRampClock(E) {
      if (E && E.rampTimer) { clearInterval(E.rampTimer); E.rampTimer = null; }
      try { _ambRampVizClear(E); } catch (e) {}
    }
    function _ambStartGenerator(E) {
      _E = E;
      const cfg = E.getCfg();
      if (!cfg) return;
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      if (E.timer) return;
      _ambResetClocks(E);
      _ambSeed(cfg.seed);
      try { _ambApplyRamps(cfg, 0); } catch (e) {} // reset ramped params to A so the FIRST events use A
      try { _ambSyncMods(); } catch (e) {} // build mod chains before the first voices fire
      E._playStartMs = performance.now();   // footer elapsed-time anchor
      // The first tick must NOT prevent the interval from starting: if it throws,
      // setInterval below would never run and playback would be dead forever.
      try { _ambTick(E); } catch (e) { _ambLogTickErr(e); }
      E.timer = setInterval(() => { try { _ambTick(E); } catch (e) { _ambLogTickErr(e); } }, 150);
      // The finer ramp clock only runs while ramps exist (started lazily) so a
      // ramp-free Bloom doesn't burn a 40 Hz main-thread timer that competes
      // with audio scheduling.
      _ambStartRampClock(E);
      cfg.playing = true;
      _ambRefreshPlayBtn(E);
      _ambVizKick(E);
      try { _ambShapeAnimEnsure(); } catch (e) {}   // spin any in-card Shape wheels
    }
    function _ambStopGenerator(E) {
      _E = E;
      if (E.timer) { clearInterval(E.timer); E.timer = null; }
      if (E.rampTimer) { clearInterval(E.rampTimer); E.rampTimer = null; }
      E._playStartMs = null;   // reset footer elapsed time to 00:00:00
      E._keySched = null;   // drop the keyMaster key schedule on stop
      try { _ambRampVizClear(E); } catch (e) {}
      try { _ambFreezeStopAll(E); } catch (e) {}
      _ambResetClocks(E);
      const cfg = E.getCfg();
      if (cfg) cfg.playing = false;
      _ambRefreshPlayBtn(E);
      try { _ambUpdatePlayheads(E); } catch (e) {} // zero the bars when stopped
      // Repaint shape wheels once as a clean static frame (no playhead) now that
      // the rAF loop will stop — leaves them visible, not frozen mid-sweep.
      try { _ambShapeAnimEnsure(); } catch (e) {}
      // Only hard-silence active voices when NO Bloom engine is still running —
      // otherwise stopping one engine would cut the other engine's ringing
      // voices. The stopped engine's long releases ring out meanwhile.
      try {
        if (!_laneEng.timer && !_masterEng.timer && !_shapeBloomEng.timer && typeof silenceActiveVoices === 'function') silenceActiveVoices();
      } catch (e) {}
      try { _ambTeardownMods(); } catch (e) {}
    }

    // ---- Freeze → lane -------------------------------------------------
    function _ambFreezeToLane() {
      _E = _laneEng; // freeze prints the active lane's Bloom
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      const anyOn = (cfg.bed && cfg.bed.on) || (cfg.motif && cfg.motif.on) || (cfg.texture && cfg.texture.on) || (cfg.beat && cfg.beat.on);
      if (!anyOn) return;
      const STEPS = 32;
      const sub = (typeof stepSubdivision === 'number' && stepSubdivision > 0) ? stepSubdivision : 0.5;
      const space = cfg.space | 0;
      _ambSeed(cfg.seed >>> 0);
      _E.motifDeg = null; _E.texPattern = null; _E.texStep = 0;
      const stepSec = Math.max(0.05, _ambStepSec());
      const bedEvery = Math.max(1, Math.round(((cfg.bed.intervalMs | 0) / 1000) / stepSec));
      const motifEvery = Math.max(1, Math.round(((cfg.motif.intervalMs | 0) / 1000) / stepSec));
      const beatEvery = Math.max(1, Math.round(((cfg.beat.intervalMs | 0) / 1000) / stepSec));
      const steps = [];
      // `override` lets a slot carry its own params (drum hits); `tone` sets a
      // melodic layer's instrument (falls back to the grid voice when '').
      const voiceFor = (f, pan, override, tone) => {
        const base = override ? { ...override }
          : ((typeof cellParams !== 'undefined' && cellParams[0]) ? { ...cellParams[0] } : { type: 'sine' });
        if (!override) base.type = _ambLayerType(tone);
        if (pan != null) base.pan = pan | 0;
        let label = 'note';
        try { label = Tone.Frequency(f).toNote(); } catch (e) {}
        return { freq: f, label, cellIndex: null, sound: base.type || 'sine', params: base };
      };
      for (let i = 0; i < STEPS; i++) {
        const slot = [];
        if (cfg.bed && cfg.bed.on && (i % bedEvery === 0)) {
          const v = _ambPickVoicing(cfg.bed);
          const pans = _ambLayerPans(cfg.bed, v.length);
          v.forEach((f, vi) => slot.push({ f, pan: pans[vi], tone: cfg.bed.tone }));
        }
        if (cfg.motif && cfg.motif.on && (i % motifEvery === 0)) {
          const f = _ambMotifFreezeNote(cfg.motif);
          if (f) slot.push({ f, pan: 0, tone: cfg.motif.tone });
        }
        if (cfg.texture && cfg.texture.on) {
          const f = _ambTexFreezeNote(cfg.texture);
          if (f) slot.push({ f, pan: 0, tone: cfg.texture.tone });
        }
        if (cfg.beat && cfg.beat.on && (i % beatEvery === 0)
            && !(_ambRand() * 100 < Math.max(0, Math.min(100, cfg.beat.restProb | 0)))) {
          const pc = _ambPickDrumPc();
          let f; try { f = Tone.Frequency(36 + pc, 'midi').toFrequency(); } catch (e) { f = null; }
          if (f) slot.push({ f, pan: 0, params: _ambBeatParams(cfg.beat.kit, Math.max(60, cfg.beat.lengthMs | 0), 0) });
        }
        if (slot.length === 0) steps.push({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision: sub });
        else if (slot.length === 1) steps.push({ ...voiceFor(slot[0].f, slot[0].pan, slot[0].params, slot[0].tone), duration: 1, subdivision: sub });
        else {
          const chord = slot.map(s => voiceFor(s.f, s.pan, s.params, s.tone));
          steps.push({ chord, label: chord.map(v => v.label).join('·'), duration: 1, subdivision: sub });
        }
      }
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Freeze Bloom');
      const lane = (typeof _makeLane === 'function') ? _makeLane(lanes.length, steps) : null;
      if (!lane) return;
      lane.name = 'Bloom ' + (lanes.length + 1);
      try { if (typeof _captureVoiceGlobals === 'function') lane.voice = _captureVoiceGlobals(); } catch (e) {}
      lanes.push(lane);
      if (typeof gridRows !== 'undefined') gridRows = lanes.length;
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.value = String(lanes.length);
      if (typeof activateLane === 'function') activateLane(lanes.length - 1);
      else if (typeof renderSequence === 'function') renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // ---- Send plumbing (saved-seq menu → master; lane menu → that lane) ----
    // Distill a saved sequence (by bank index) into a unit and send it to the
    // MASTER Bloom instance. Called from the saved-sequence right-click submenu.
    function _ambListMasterSeqs() {
      try { return (_masterEng.getCfg().seqs || []).map((s, i) => ({ id: s.id, name: 'Seq' + (i + 1) })); } catch (e) { return []; }
    }
    // One seq unit per lane that has playable notes — so a multi-lane
    // sequence sends each lane to Bloom as its OWN independent Seq layer
    // (lanes play in parallel; collapsing them into one polyphonic phrase
    // played as choppy rests/chords). Each lane keeps its own per-note tone.
    // Single-lane / legacy saves yield a single unit from saved.steps.
    function _ambLaneUnitsFromSaved(saved) {
      const _hasNote = (steps) => Array.isArray(steps) && steps.some(function chk(s) {
        return s && (s.freq != null || (Array.isArray(s.chord) && s.chord.length)
          || (s.isSub && Array.isArray(s.subSteps) && s.subSteps.some(chk)));
      });
      const lanesArr = (saved && Array.isArray(saved.lanes)) ? saved.lanes : null;
      if (lanesArr && lanesArr.length >= 2) {
        const out = [];
        lanesArr.forEach((l, i) => {
          if (!l || !_hasNote(l.steps)) return;
          const laneSaved = {
            steps: l.steps, bpm: saved.bpm, scale: saved.scale,
            rootIdx: saved.rootIdx, baseOctave: saved.baseOctave, cellParams: saved.cellParams,
          };
          const u = _seqSeedFromSaved(laneSaved);
          if (u) out.push({ unit: u, name: (l.name || ('Lane ' + (i + 1))) });
        });
        if (out.length) return out;
      }
      // Single lane / legacy / nothing matched → fall back to the whole save.
      const u = _seqSeedFromSaved(saved);
      return u ? [{ unit: u, name: null }] : [];
    }

    function _ambSendSavedToMaster(seqIndex, mode, targetSeqId) {
      const saved = (typeof savedSequences !== 'undefined') ? savedSequences[seqIndex] : null;
      if (!saved) return;
      const laneUnits = _ambLaneUnitsFromSaved(saved);
      if (!laneUnits.length) { try { alert('That sequence has no playable notes to send to Bloom.'); } catch (e) {} return; }
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send to Bloom');
      // Multi-lane: each lane becomes its own Seq layer. With 'new' that's a
      // fresh Seq per lane; with append/interleave each lane's unit folds into
      // the chosen target (only the first resolves the target — the rest chain
      // onto whatever it created/landed in).
      laneUnits.forEach((lu) => {
        _ambSendSeedToInstance(_masterEng, lu.unit, mode, targetSeqId, lu.name);
      });
      // Reflect immediately if the Mix Bloom panel is built.
      try { if (_masterEng.inited) _ambRenderSeqLayers(_masterEng); } catch (e) {}
    }
    // Build a unit from a LANE's own steps (+ workspace key/tempo).
    function _ambUnitFromLane(laneIdx) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      if (!lane || !Array.isArray(lane.steps)) return null;
      const bpmEl = document.getElementById('tempo-input') || (typeof tempoInput !== 'undefined' ? tempoInput : null);
      const bpm = bpmEl ? (parseInt(bpmEl.value, 10) || 120) : 120;
      // Prefer the lane's own captured voice (so a sent lane keeps its own
      // tone/settings, independent of which lane is active); fall back to the
      // live grid voice when this IS the active lane.
      const laneCellParams = (lane.voice && Array.isArray(lane.voice.cellParams)) ? lane.voice.cellParams
        : ((laneIdx === activeLaneIdx && typeof cellParams !== 'undefined') ? cellParams : null);
      return _seqSeedFromSaved({
        steps: lane.steps, bpm, cellParams: laneCellParams,
        scale: (lane.voice && lane.voice.scale) ? lane.voice.scale : ((typeof currentScale !== 'undefined') ? currentScale : ''),
        rootIdx: (typeof rootIdx !== 'undefined') ? rootIdx : 0,
        baseOctave: (typeof baseOctave !== 'undefined') ? baseOctave : 4,
      });
    }
    function _ambListLaneSeqs(laneIdx) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      if (!lane) return [];
      if (!lane.ambient || typeof lane.ambient !== 'object') return [];
      const cfg = _normalizeAmbientCfg(lane.ambient);
      return (cfg.seqs || []).map((s, i) => ({ id: s.id, name: 'Seq' + (i + 1) }));
    }
    // Send the lane's own sequence into that lane's Bloom, then switch it into
    // Bloom mode so it's immediately visible/audible.
    function _ambSendLaneToBloom(laneIdx, mode, targetSeqId) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      if (!lane) return;
      const unit = _ambUnitFromLane(laneIdx);
      if (!unit) { try { alert('That lane has no playable notes to send to Bloom.'); } catch (e) {} return; }
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send lane to Bloom');
      const wasFresh = !lane.ambient || typeof lane.ambient !== 'object';
      if (wasFresh) lane.ambient = _defaultAmbientConfig();
      lane.ambientMode = true;
      if (typeof activateLane === 'function') activateLane(laneIdx); // → _ambientInit(_laneEng)
      // Fresh Bloom config defaults Bed ON (grid voice). With the sent Seq added
      // too, both sound — so the seq's notes come out in its layer tone while
      // Bed's come out in the grid voice. Silence the default generative layers
      // on a fresh send so ONLY the sequence plays.
      if (wasFresh) { ['bed', 'motif', 'texture', 'beat'].forEach(k => { if (lane.ambient[k]) lane.ambient[k].on = false; }); }
      // Now the active lane IS this lane, so _laneEng targets its cfg.
      _ambSendSeedToInstance(_laneEng, unit, mode, targetSeqId);
      try { _ambSyncControls(_laneEng); } catch (e) {}
    }
    // ---- Send a single-buffer sample to a Bloom Sample layer ------------
    function _ambSendSampleToInstance(E, sampleId, opts) {
      const id = (typeof sampleId === 'string' && sampleId.startsWith('sample:')) ? sampleId.slice(7) : sampleId;
      if (!id) return false;
      const cfg = E.getCfg(); if (!cfg) return false;
      if (!Array.isArray(cfg.samples)) cfg.samples = [];
      const newId = cfg.samples.reduce((m, s) => Math.max(m, s.id | 0), 0) + 1;
      const L = _defaultSampleLayer(newId);
      L.sampleId = id;
      let info = null; try { info = (typeof sampleSamplers !== 'undefined') ? sampleSamplers.get(id) : null; } catch (e) {}
      L.name = (info && info.name) ? info.name : id;
      if (opts && Number.isFinite(opts.chop)) L.chop = Math.max(1, Math.min(16, opts.chop | 0));
      if (opts && (opts.order === 'random' || opts.order === 'forward')) L.order = opts.order;
      cfg.samples.push(L);
      if (E.timer) { _E = E; try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
      return true;
    }
    // Find a sliceable-sample voice id within a step list (single + chord).
    function _ambSampleIdFromSteps(steps) {
      if (!Array.isArray(steps)) return null;
      const ck = (t) => (typeof t === 'string' && t.startsWith('sample:') && (typeof isSliceableSample !== 'function' || isSliceableSample(t))) ? t.slice(7) : null;
      for (const s of steps) {
        if (!s) continue;
        let id = ck(s.params && s.params.type || s.sound);
        if (id) return id;
        if (Array.isArray(s.chord)) for (const n of s.chord) { id = ck(n && (n.params && n.params.type || n.sound)); if (id) return id; }
        if (s.isSub && Array.isArray(s.subSteps)) { id = _ambSampleIdFromSteps(s.subSteps); if (id) return id; }
      }
      return null;
    }
    function _ambSampleIdOfSaved(saved) { return (saved && Array.isArray(saved.steps)) ? _ambSampleIdFromSteps(saved.steps) : null; }
    function _ambSampleIdOfLane(laneIdx) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      return lane ? _ambSampleIdFromSteps(lane.steps) : null;
    }
    function _ambSendSampleToMaster(sampleId, opts) {
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send to Bloom (sample)');
      _ambSendSampleToInstance(_masterEng, sampleId, opts);
      try { if (_masterEng.inited) _ambRenderSampleLayers(_masterEng); } catch (e) {}
    }
    function _ambSendSampleToLane(laneIdx, sampleId, opts) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      if (!lane) return;
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send lane to Bloom (sample)');
      if (!lane.ambient || typeof lane.ambient !== 'object') lane.ambient = _defaultAmbientConfig();
      lane.ambientMode = true;
      if (typeof activateLane === 'function') activateLane(laneIdx);
      _ambSendSampleToInstance(_laneEng, sampleId, opts);
      try { _ambSyncControls(_laneEng); } catch (e) {}
    }
    function _ambMotifFreezeNote(motif) {
      const intervals = _ambScaleIntervals(_ambNotesOf(motif));
      const N = intervals.length;
      const center = Math.max(1, Math.min(8, motif.register | 0));
      const range = Math.max(1, Math.min(4, motif.range | 0));
      const lo = (center - range) * N, hi = (center + range) * N;
      if (_E.motifDeg == null) _E.motifDeg = center * N;
      if (_ambRand() * 100 < Math.max(0, Math.min(100, motif.restProb | 0))) return null;
      const leap = _ambRand() < 0.18;
      const mag = leap ? 3 + Math.floor(_ambRand() * 3) : 1 + Math.floor(_ambRand() * 2);
      const dir = _ambRand() < 0.5 ? -1 : 1;
      let next = _E.motifDeg + dir * mag;
      if (next < lo) next = lo + (lo - next);
      if (next > hi) next = hi - (next - hi);
      next = Math.max(lo, Math.min(hi, next));
      _E.motifDeg = next;
      return _ambDegreeFreq(((next % N) + N) % N, Math.floor(next / N), _ambNotesOf(motif));
    }
    function _ambTexFreezeNote(texture) {
      if (!_E.texPattern) _ambTexBuildPattern(texture);
      const center = Math.max(1, Math.min(8, texture.register | 0));
      const slot = _E.texPattern[_E.texStep % _E.texPattern.length];
      _E.texStep++;
      if (slot && slot.on) return _ambDegreeFreq(slot.deg, center, _ambNotesOf(texture));
      return null;
    }

    // ---- Export Bloom → audio file → Google Drive ----------------------
    // Bloom is generative/endless, so there's nothing to render offline the
    // way a fixed track is. Instead we capture the LIVE master output for a
    // chosen length via a MediaStreamDestination tap + MediaRecorder (runs
    // off the main thread, so it's glitch-free), decode the capture to an
    // AudioBuffer, then reuse the track-export encoders + Drive upload helpers
    // verbatim. The generator is (re)started fresh from the seed so the
    // captured take is reproducible.
    let _ambExportBusy = false;
    function _ambCaptureToBuffer(E, durSec, onProgress) {
      E = E || _laneEng;
      return new Promise(async (resolve, reject) => {
        let ac;
        try { ac = Tone.getContext().rawContext; } catch (e) { return reject(new Error('No audio context')); }
        if (typeof MediaRecorder === 'undefined') return reject(new Error('This browser cannot record audio output.'));
        const tap = _ambMasterTapNode();
        if (!tap) return reject(new Error('Master output unavailable.'));
        let dest, rec;
        try {
          dest = ac.createMediaStreamDestination();
          tap.connect(dest); // fan-out tap — does not remove the live → speakers path
          const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
          const mime = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
          rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
        } catch (e) { try { tap.disconnect(dest); } catch (_) {} return reject(e); }
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        const cleanup = () => { try { tap.disconnect(dest); } catch (e) {} };
        rec.onerror = (e) => { cleanup(); reject((e && e.error) || new Error('Recording failed')); };
        rec.onstop = async () => {
          cleanup();
          try { _ambStopGenerator(E); } catch (e) {}
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            const arr = await blob.arrayBuffer();
            const audioBuf = await ac.decodeAudioData(arr);
            resolve(audioBuf);
          } catch (e) { reject(e); }
        };
        // Fresh, reproducible take from the seed.
        try { _ambStopGenerator(E); _ambStartGenerator(E); } catch (e) {}
        try { rec.start(); } catch (e) { cleanup(); return reject(e); }
        const startMs = (typeof performance !== 'undefined') ? performance.now() : 0;
        const pi = setInterval(() => {
          const s = ((typeof performance !== 'undefined' ? performance.now() : 0) - startMs) / 1000;
          try { onProgress && onProgress(Math.min(1, s / durSec), Math.min(s, durSec), durSec); } catch (e) {}
        }, 150);
        setTimeout(() => { clearInterval(pi); try { rec.stop(); } catch (e) { cleanup(); reject(e); } }, durSec * 1000);
      });
    }
    // ---- Capture bank --------------------------------------------------
    // "Export to Drive" is split in two: CAPTURE records + encodes the take
    // into a local bank (no network), and UPLOAD (per bank item) pushes it to
    // Drive. A failed/expired upload never loses the audio — it stays in the
    // bank to retry. The bank is per-session (in-memory blobs).
    let _ambCaptureBank = [];   // [{ id, name, ext, mime, folder, durSec, bytes, blob, url, uploaded }]
    let _ambCapBankSeq = 0;
    let _ambBankPreviewAudio = null;
    function _ambCaptureToBank(E) {
      E = E || _laneEng;
      _E = E;
      if (E.capRec) { _ambCaptureFinalize(E); return; } // 2nd press → wind down + end on silence
      if (_ambExportBusy) return;
      const cfg = E.getCfg();
      if (!cfg) return;
      const anyOn = ['bed', 'motif', 'texture', 'beat'].some(k => cfg[k] && cfg[k].present !== false && cfg[k].on)
        || (Array.isArray(cfg.extras) && cfg.extras.some(x => x && x.present !== false && x.on && _AMB_LAYER_SCHEMA[x.type]))
        || (Array.isArray(cfg.seqs) && cfg.seqs.some(s => s.on && s.units && s.units.length))
        || (Array.isArray(cfg.samples) && cfg.samples.some(s => s.on && s.sampleId));
      if (!anyOn) { alert('Turn on at least one Bloom layer before capturing.'); return; }
      // Length popover: a fixed duration (auto-finalize after it elapses) or Live
      // (record until the user presses Finalize). Either way Finalize winds Bloom
      // down and ends on silence for a clean tail.
      const btn = _ambGet(E, 'ambient-export-btn');
      const opts = [
        { label: '● Live — until Finalize', fn: () => _ambCaptureBegin(E, 0) },
        'hr',
        { label: '15 sec', fn: () => _ambCaptureBegin(E, 15000) },
        { label: '30 sec', fn: () => _ambCaptureBegin(E, 30000) },
        { label: '1 min',  fn: () => _ambCaptureBegin(E, 60000) },
        { label: '2 min',  fn: () => _ambCaptureBegin(E, 120000) },
        { label: '4 min',  fn: () => _ambCaptureBegin(E, 240000) },
        'hr',
        { label: '⌨ Custom seconds…', fn: () => {
          let s = null; try { s = prompt('Capture length in seconds:', '60'); } catch (e) {}
          if (s == null) return;
          const n = parseInt(s, 10);
          if (!Number.isFinite(n) || n <= 0) { alert('Enter a positive number of seconds.'); return; }
          _ambCaptureBegin(E, n * 1000);
        } },
      ];
      if (typeof showCtxMenu === 'function' && btn) {
        const r = btn.getBoundingClientRect();
        showCtxMenu(r.left, r.top, opts);   // footer sits low — menu opens upward (clamped on-screen)
      } else {
        _ambCaptureBegin(E, 0);
      }
    }
    // Start a capture; lenMs > 0 schedules an automatic Finalize after that long
    // (simulating the user's press), lenMs = 0 records live until they Finalize.
    function _ambCaptureBegin(E, lenMs) {
      _ambCaptureStart(E);
      if (!E.capRec) return;   // start failed (alerted already)
      if (lenMs > 0) {
        if (E._capAutoTimer) { try { clearTimeout(E._capAutoTimer); } catch (e) {} }
        E._capAutoTimer = setTimeout(() => { E._capAutoTimer = null; try { _ambCaptureFinalize(E); } catch (e) {} }, lenMs);
        if (typeof showToast === 'function') showToast('Capturing — auto-finalize in ' + Math.round(lenMs / 1000) + 's (or press Finalize to end early).');
      }
    }
    // Reflect the capture state onto the Capture/Finalize button.
    function _ambRefreshCaptureBtn(E) {
      const btn = _ambGet(E, 'ambient-export-btn');
      if (!btn) return;
      // Icon-only (it's a round transport button now); the title carries the words.
      if (E.capRec && E.windingDown) { btn.textContent = '⏳'; btn.title = 'Finalizing — ending on silence'; btn.disabled = true; btn.classList.add('recording'); }
      else if (E.capRec) { btn.textContent = '■'; btn.title = 'Finalize capture'; btn.disabled = false; btn.classList.add('recording'); }
      else { btn.textContent = '⤓'; btn.title = 'Capture — pick a length or record live'; btn.disabled = false; btn.classList.remove('recording'); }
    }
    // Begin live recording the master output (fan-out tap, no seed restart).
    function _ambCaptureStart(E) {
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { alert('No audio context'); return; }
      // Tap the FINAL master node (post lookahead-limiter + soft-clip) so the
      // capture matches what's actually heard.
      const tap = _ambMasterTapNode();
      if (!tap) { alert('Master output unavailable.'); return; }
      E.windingDown = false;
      try { if (!E.timer) _ambStartGenerator(E); } catch (e) {}    // make sure something is generating
      // Silence detector — drives Finalize in both capture modes.
      let analyser = null;
      try { analyser = ac.createAnalyser(); analyser.fftSize = 1024; tap.connect(analyser); } catch (e) { analyser = null; }
      // PREFERRED: AudioWorklet recorder → raw PCM → WAV/MP3 (no decodeAudioData,
      // so it can't hit "Unable to decode audio data" / "decoding failure").
      if (typeof _bloopsRecorderReady !== 'undefined' && _bloopsRecorderReady
          && Tone.context && typeof Tone.context.createAudioWorkletNode === 'function') {
        let recNode = null, sink = null;
        try {
          recNode = Tone.context.createAudioWorkletNode('bloops-recorder', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: 'explicit',
          });
          sink = ac.createGain(); sink.gain.value = 0;   // node must reach destination to run; keep it silent
        } catch (e) { recNode = null; }
        if (recNode) {
          const r = { mode: 'worklet', recNode, sink, analyser, tap, sr: ac.sampleRate || 48000, L: [], R: [], frames: 0, silentMs: 0, pollTimer: null, finalizing: false };
          recNode.port.onmessage = (ev) => { const d = ev.data; if (!d || !d.l) return; r.L.push(d.l); r.R.push(d.r); r.frames += d.l.length; };
          try { Tone.connect(tap, recNode); Tone.connect(recNode, sink); sink.connect(ac.destination); }
          catch (e) { try { if (analyser) tap.disconnect(analyser); } catch (_) {} alert('Capture failed.'); return; }
          E.capRec = r;
          _ambRefreshCaptureBtn(E);
          if (typeof showToast === 'function') showToast('Capturing… press Finalize to wind down and end cleanly.');
          return;
        }
      }
      // FALLBACK: MediaRecorder (decoded to WAV/MP3 on finish; raw-saved if the
      // decode fails) — used where the recorder worklet isn't available/ready.
      if (typeof MediaRecorder === 'undefined') { try { if (analyser) tap.disconnect(analyser); } catch (_) {} alert('This browser cannot record audio output.'); return; }
      let dest, rec;
      try {
        dest = ac.createMediaStreamDestination(); tap.connect(dest);
        const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
        const mime = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
        rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      } catch (e) { try { tap.disconnect(dest); } catch (_) {} alert('Capture failed: ' + ((e && e.message) || e)); return; }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => _ambCaptureFinish(E);
      E.capRec = { mode: 'mr', rec, dest, analyser, tap, chunks, silentMs: 0, pollTimer: null, finalizing: false };
      try { rec.start(); } catch (e) { try { tap.disconnect(dest); } catch (_) {} E.capRec = null; alert('Capture failed.'); return; }
      _ambRefreshCaptureBtn(E);
      if (typeof showToast === 'function') showToast('Capturing… press Finalize to wind down and end cleanly.');
    }
    // Wind Bloom down (no new iterations) and end the recording once the output
    // has been silent for a short sustained window (so release/reverb tails ring
    // out fully), with a safety ceiling so it can't hang on an endless tail.
    function _ambCaptureFinalize(E) {
      const r = E.capRec; if (!r || r.finalizing) return;
      if (E._capAutoTimer) { try { clearTimeout(E._capAutoTimer); } catch (e) {} E._capAutoTimer = null; }
      r.finalizing = true;
      E.windingDown = true;
      _ambRefreshCaptureBtn(E);
      if (typeof showToast === 'function') showToast('Finalizing — winding down, ending on silence…');
      const buf = r.analyser ? new Float32Array(r.analyser.fftSize) : null;
      const SILENCE = 0.0025, NEED_SILENT_MS = 450, MAX_TAIL_MS = 30000;
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      r.pollTimer = setInterval(() => {
        let rms = 0;
        if (r.analyser && buf) { try { r.analyser.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; rms = Math.sqrt(s / buf.length); } catch (e) {} }
        r.silentMs = (rms < SILENCE) ? (r.silentMs + 100) : 0;
        const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - t0;
        if (r.silentMs >= NEED_SILENT_MS || elapsed >= MAX_TAIL_MS) {
          clearInterval(r.pollTimer); r.pollTimer = null;
          if (r.mode === 'mr') { try { r.rec.stop(); } catch (e) {} }  // onstop → _ambCaptureFinish
          else { _ambCaptureFinish(E); }
        }
      }, 100);
    }
    // Capture ended: tear down the tap, stop the (now-silent) generator, then ask
    // for name/format and save the take. Worklet mode stitches the PCM straight
    // A friendly default name for a captured take: "Adjective Noun" (e.g.
    // "Velvet Canyon"), so the Save/Upload dialog prepopulates something
    // memorable instead of a timestamp. New random pick per capture.
    const _AMB_NAME_ADJ = [
      'Velvet', 'Wobbly', 'Cosmic', 'Hazy', 'Golden', 'Crystal', 'Drifting', 'Electric', 'Midnight', 'Lush',
      'Frosted', 'Molten', 'Quiet', 'Restless', 'Sunken', 'Faded', 'Neon', 'Wild', 'Gentle', 'Distant',
      'Amber', 'Silver', 'Crooked', 'Liquid', 'Dusty', 'Hollow', 'Radiant', 'Mellow', 'Twisted', 'Floating',
      'Burnt', 'Glassy', 'Secret', 'Tidal', 'Wandering', 'Bright', 'Murky', 'Static', 'Lunar', 'Woolen',
      'Smoky', 'Shimmering', 'Frozen', 'Warm', 'Cold', 'Dim', 'Vivid', 'Pale', 'Dark', 'Bleak',
      'Sleepy', 'Drowsy', 'Brisk', 'Tender', 'Brittle', 'Supple', 'Glowing', 'Fractured', 'Weathered', 'Rusted',
      'Polished', 'Marbled', 'Ashen', 'Smoldering', 'Ghostly', 'Spectral', 'Phantom', 'Eerie', 'Mystic', 'Arcane',
      'Sacred', 'Sublime', 'Serene', 'Tranquil', 'Placid', 'Whispering', 'Humming', 'Crackling', 'Rippling', 'Swirling',
      'Tumbling', 'Soaring', 'Gliding', 'Creeping', 'Hidden', 'Buried', 'Drenched', 'Misty', 'Foggy', 'Stormy',
      'Thunderous', 'Windswept', 'Sunlit', 'Moonlit', 'Starlit', 'Gilded', 'Burnished', 'Tarnished', 'Verdant', 'Crimson',
      'Indigo', 'Violet', 'Scarlet', 'Azure', 'Teal', 'Dappled', 'Speckled', 'Striped', 'Velour', 'Satin',
      'Woven', 'Tangled', 'Knotted', 'Hushed', 'Soft', 'Sharp', 'Heavy', 'Weightless', 'Looming', 'Shifting',
    ];
    const _AMB_NAME_NOUN = [
      'Canyon', 'Pelican', 'Comet', 'Meadow', 'Lantern', 'Harbor', 'Cascade', 'Circuit', 'Glacier', 'Ember',
      'Marsh', 'Mirage', 'Orchard', 'Reef', 'Tundra', 'Drone', 'Echo', 'Grove', 'Halo', 'Loom',
      'Nebula', 'Pulse', 'Ravine', 'Signal', 'Thicket', 'Vortex', 'Willow', 'Anvil', 'Beacon', 'Current',
      'Delta', 'Fathom', 'Gully', 'Lagoon', 'Monsoon', 'Prairie', 'Quarry', 'Spire', 'Vale', 'Basin',
      'Fjord', 'Dune', 'Mesa', 'Bluff', 'Ridge', 'Summit', 'Valley', 'Gorge', 'Crater', 'Cavern',
      'Grotto', 'Cove', 'Inlet', 'Estuary', 'Bayou', 'Wetland', 'Heath', 'Moor', 'Fen', 'Glade',
      'Copse', 'Forest', 'Timber', 'Birch', 'Cedar', 'Maple', 'Aspen', 'Fern', 'Moss', 'Lichen',
      'Bramble', 'Nettle', 'Clover', 'Thistle', 'Reed', 'Rush', 'Sedge', 'Cattail', 'Pollen', 'Nectar',
      'Hive', 'Swarm', 'Flock', 'Heron', 'Falcon', 'Sparrow', 'Raven', 'Magpie', 'Finch', 'Plover',
      'Curlew', 'Otter', 'Marten', 'Lynx', 'Badger', 'Stoat', 'Vole', 'Newt', 'Toad', 'Minnow',
      'Carp', 'Perch', 'Trout', 'Eel', 'Squid', 'Anemone', 'Kelp', 'Plankton', 'Tide', 'Wake',
      'Eddy', 'Surge', 'Swell', 'Breaker', 'Spray', 'Foam', 'Brine', 'Trench', 'Abyss', 'Shoal',
    ];
    function _ambRandomTrackName() {
      const a = _AMB_NAME_ADJ[Math.floor(Math.random() * _AMB_NAME_ADJ.length)];
      const n = _AMB_NAME_NOUN[Math.floor(Math.random() * _AMB_NAME_NOUN.length)];
      return a + ' ' + n;
    }
    // into a buffer (always WAV/MP3-able); MediaRecorder mode decodes the blob
    // and falls back to saving it raw if decoding fails.
    async function _ambCaptureFinish(E) {
      const r = E.capRec;
      if (r && r.pollTimer) { clearInterval(r.pollTimer); r.pollTimer = null; }
      try { if (r && r.analyser) r.tap.disconnect(r.analyser); } catch (e) {}
      if (r && r.mode === 'worklet') {
        try { if (r.recNode && r.recNode.port) r.recNode.port.postMessage({ stop: true }); } catch (e) {}
        try { Tone.disconnect(r.tap, r.recNode); } catch (e) {}
        try { r.recNode.disconnect(); } catch (e) {}
        try { r.sink.disconnect(); } catch (e) {}
      } else if (r && r.mode === 'mr') {
        try { r.tap.disconnect(r.dest); } catch (e) {}
      }
      try { _ambStopGenerator(E); } catch (e) {}
      E.windingDown = false;
      E.capRec = null;
      _ambRefreshCaptureBtn(E);
      try { _ambRefreshPlayBtn(E); } catch (e) {}
      try {
        const ac = Tone.getContext().rawContext;
        let audioBuf = null, rawBlob = null;
        if (r && r.mode === 'worklet') {
          if (!r.frames) return;
          audioBuf = ac.createBuffer(2, r.frames, r.sr || ac.sampleRate);
          const o0 = audioBuf.getChannelData(0), o1 = audioBuf.getChannelData(1);
          let pos = 0;
          for (let i = 0; i < r.L.length; i++) { o0.set(r.L[i], pos); o1.set(r.R[i], pos); pos += r.L[i].length; }
          r.L = null; r.R = null;
        } else {
          const chunks = r ? r.chunks : null;
          if (!chunks || !chunks.length) return;
          rawBlob = new Blob(chunks, { type: (r.rec && r.rec.mimeType) || 'audio/webm' });
          try {
            audioBuf = await ac.decodeAudioData(await rawBlob.arrayBuffer());
            if (!audioBuf || !(audioBuf.duration > 0)) audioBuf = null;
          } catch (decErr) { console.warn('Bloom capture: decode failed, saving the raw recording instead.', decErr); }
        }
        if (typeof showExportOptionsDialog !== 'function') { alert('Capture is unavailable.'); return; }
        const choice = await showExportOptionsDialog({ title: 'Save capture', defaultName: _ambRandomTrackName(), defaultFolder: 'bloops/exports', includeFolder: true, applyLabel: 'Save' });
        if (!choice) return;
        const { filename, fmt, folder } = choice;
        let blob, ext, mime, durSec;
        if (audioBuf) {
          ext = fmt === 'mp3' ? 'mp3' : 'wav';
          mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav';
          blob = (fmt === 'mp3' && typeof audioBufferToMp3 === 'function') ? await audioBufferToMp3(audioBuf) : audioBufferToWav(audioBuf);
          durSec = audioBuf.duration;
        } else {
          blob = rawBlob;
          mime = (rawBlob && rawBlob.type) || 'audio/webm';
          ext = mime.indexOf('mp4') >= 0 ? 'm4a' : mime.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
          durSec = 0;
        }
        let url = null; try { url = URL.createObjectURL(blob); } catch (e) {}
        _ambCaptureBank.push({ id: ++_ambCapBankSeq, name: filename, ext, mime, folder: folder || 'bloops/exports', durSec, bytes: blob.size, blob, url, uploaded: false });
        _ambRenderCaptureBank();
        if (typeof showToast === 'function') {
          showToast(audioBuf
            ? ('Captured “' + filename + '” — upload it from the bank below.')
            : ('Captured “' + filename + '” (raw ' + ext + ' — couldn’t convert) — upload it from the bank below.'));
        }
      } catch (e) {
        console.error('Bloom capture failed', e);
        alert('Bloom capture failed: ' + ((e && e.message) || e));
      }
    }
    async function _ambUploadBankItem(item) {
      if (!item || !item.blob) return;
      if (typeof showExportOptionsDialog !== 'function') { alert('Upload is unavailable.'); return; }
      const choice = await showExportOptionsDialog({
        title: 'Upload capture to Drive', defaultName: item.name,
        defaultFolder: item.folder || 'bloops/exports', includeFolder: true, applyLabel: 'Upload',
      });
      if (!choice) return;
      const name = choice.filename || item.name;
      const folder = choice.folder || item.folder || 'bloops/exports';
      item.name = name; item.folder = folder; _ambRenderCaptureBank();
      const progress = (typeof showRenderProgressModal === 'function') ? showRenderProgressModal('Uploading to Drive…') : null;
      const is401 = (err) => !!(err && (err.status === 401 || (err.result && err.result.error && err.result.error.code === 401)));
      const doDrive = async () => {
        await googleSignInForDrive();
        progress && progress.setStatus('Uploading to Drive…');
        const folderId = await findOrCreateDriveFolder(folder);
        return uploadBlobToDrive(name + '.' + item.ext, item.blob, folderId, item.mime);
      };
      try {
        let file;
        try { file = await doDrive(); }
        catch (e1) {
          if (!is401(e1)) throw e1;
          try { window.SharedAuth && window.SharedAuth.clear && window.SharedAuth.clear(); } catch (e) {}
          try { if (typeof gapi !== 'undefined' && gapi.client && gapi.client.setToken) gapi.client.setToken({ access_token: '' }); } catch (e) {}
          progress && progress.setStatus('Re-authorizing Google Drive…');
          file = await doDrive();
        }
        progress && progress.markDone();
        item.uploaded = true; _ambRenderCaptureBank();
        alert('Uploaded “' + ((file && file.name) || (name + '.' + item.ext)) + '” to “' + folder + '”.');
      } catch (e) {
        console.error('Upload failed', e);
        alert('Upload failed — the capture is still in the bank to retry.\n' + ((e && e.message) || e));
      } finally {
        progress && progress.close();
      }
    }
    function _ambDownloadBankItem(item) {
      if (!item || !item.url) return;
      try { const a = document.createElement('a'); a.href = item.url; a.download = item.name + '.' + item.ext; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {}
    }
    function _ambRemoveBankItem(id) {
      const i = _ambCaptureBank.findIndex(x => x.id === id);
      if (i < 0) return;
      try { if (_ambCaptureBank[i].url) URL.revokeObjectURL(_ambCaptureBank[i].url); } catch (e) {}
      _ambCaptureBank.splice(i, 1);
      _ambRenderCaptureBank();
    }
    function _ambPreviewBankItem(item) {
      try {
        if (_ambBankPreviewAudio) { _ambBankPreviewAudio.pause(); _ambBankPreviewAudio = null; }
        if (!item || !item.url) return;
        const a = new Audio(item.url); _ambBankPreviewAudio = a; a.play().catch(() => {});
      } catch (e) {}
    }
    function _ambRenderCaptureBank() {
      const fmtBytes = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
      document.querySelectorAll('.ambient-capture-bank').forEach(host => {
        if (!host._capWired) {
          host._capWired = true;
          host.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest && e.target.closest('.ambient-cap-btn'); if (!btn) return;
            const row = btn.closest('.ambient-cap-item'); if (!row) return;
            const id = parseInt(row.dataset.cap, 10);
            const it = _ambCaptureBank.find(x => x.id === id); if (!it) return;
            const act = btn.dataset.act;
            if (act === 'play') _ambPreviewBankItem(it);
            else if (act === 'dl') _ambDownloadBankItem(it);
            else if (act === 'up') _ambUploadBankItem(it);
            else if (act === 'del') _ambRemoveBankItem(id);
          });
        }
        if (!_ambCaptureBank.length) { host.innerHTML = '<div class="ambient-cap-empty">No captures yet — press ⤓ Capture to record a take.</div>'; return; }
        host.innerHTML = '<div class="ambient-cap-title">Captures</div>' + _ambCaptureBank.map(it =>
          '<div class="ambient-cap-item' + (it.uploaded ? ' uploaded' : '') + '" data-cap="' + it.id + '">' +
            '<span class="ambient-cap-name" title="' + (it.uploaded ? 'Uploaded' : 'Not uploaded') + '">' + (it.uploaded ? '✓ ' : '') + String(it.name).replace(/[<>&]/g, '') + '.' + it.ext + '</span>' +
            '<span class="ambient-cap-meta">' + Math.round(it.durSec) + 's · ' + fmtBytes(it.bytes) + '</span>' +
            '<button type="button" class="ambient-cap-btn" data-act="play" title="Preview">▶</button>' +
            '<button type="button" class="ambient-cap-btn" data-act="dl" title="Download to this device">⤓</button>' +
            '<button type="button" class="ambient-cap-btn ambient-cap-up" data-act="up" title="Upload to Google Drive">⬆ Upload</button>' +
            '<button type="button" class="ambient-cap-btn ambient-cap-del" data-act="del" title="Remove from bank">✕</button>' +
          '</div>').join('');
      });
    }

    // ---- Visual (analyser-bound waveform; animates only while playing) --
    // Per-engine: viz state lives on E.viz so the lane + master canvases can
    // animate independently. Both analysers tap masterBus (decorative).
    function _ambVizFrame(E) {
      if (!E.viz) return;
      const canvas = document.getElementById(E.vizId);
      if (!canvas) { E.viz.raf = 0; return; }
      if (canvas.width !== canvas.clientWidth) canvas.width = canvas.clientWidth;
      if (canvas.height !== canvas.clientHeight) canvas.height = canvas.clientHeight;
      const ctx = canvas.getContext('2d');
      const data = E.viz.analyser.getValue();
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(159,122,234,0.85)';
      ctx.beginPath();
      const step = W / data.length;
      for (let i = 0; i < data.length; i++) {
        const y = (1 - (data[i] * 2.2)) * 0.5 * H;
        const x = i * step;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      try { _ambUpdatePlayheads(E); } catch (e) {}
      if (E.timer && !document.hidden) E.viz.raf = requestAnimationFrame(() => _ambVizFrame(E));
      else E.viz.raf = 0;
    }
    // Per-layer playback indicator: a thin bar in each layer head showing how
    // far through the current iteration (or frozen loop) playback is. Driven by
    // the viz rAF while the generator runs; reads the engine clocks/freeze state.
    // Elapsed play time as MM:SS:hundredths.
    function _ambFmtElapsed(ms) {
      ms = Math.max(0, ms | 0);
      const p2 = (n) => (n < 10 ? '0' : '') + n;
      return p2(Math.floor(ms / 60000)) + ':' + p2(Math.floor((ms % 60000) / 1000)) + ':' + p2(Math.floor((ms % 1000) / 10));
    }
    function _ambUpdatePlayheads(E) {
      const host = document.getElementById(E.hostId); if (!host) return;
      // Footer elapsed-time readout: counts up while playing, 0 when stopped.
      { const elap = _ambGet(E, 'ambient-elapsed'); if (elap) elap.textContent = _ambFmtElapsed((E.timer && E._playStartMs) ? (performance.now() - E._playStartMs) : 0); }
      const bars = host.querySelectorAll('.ambient-ph'); if (!bars.length) return;
      // Drive the bars off the AUDIBLE clock (currentTime − latency), not the
      // schedule clock (Tone.now() = currentTime + lookAhead), so they track what
      // you HEAR instead of running ~lookAhead+latency ahead of it. Matches the
      // Shape playheads (_shapeAudibleNow); the engine clocks/anchors are in the
      // same scheduled coordinate space, so this aligns every branch.
      const now = (typeof _shapeAudibleNow === 'function') ? _shapeAudibleNow()
        : ((typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0);
      bars.forEach(el => {
        const key = el.dataset.phkey; if (!key) return;
        let prog = 0, active = false, frozen = false;
        const fs = E.freeze && E.freeze[key];
        if (fs && fs.frozen && fs.loopLen > 0) {
          frozen = true; active = true;
          const d = now - (fs.anchor || now);
          prog = d <= 0 ? 0 : (d % fs.loopLen) / fs.loopLen;
        } else if (E.timer) {
          const layer = _ambLayerByKey(E, key);
          const on = !!(layer && layer.present !== false && layer.on);
          const type = String(key).split(':')[0];
          if (on && type === 'arp') {
            // Fill across the whole SERIES loop (cursor position + fraction through
            // the current note), not per-note — so the bar matches the unit length.
            const cfg2 = E._cfg || E.getCfg();
            const info = _ambArpSeriesInfo(layer, cfg2);
            const ivSc = Math.max(0.02, info.interval) * _ambLayerScale(E, key, layer, cfg2);   // Unit-Sync scaled per-note interval
            const next = E.clocks && E.clocks[key], st = E.arpState && E.arpState[key];
            if (typeof next === 'number' && info.totalNotes > 0) {
              const into = st ? _ambArpNotesInto(info, st) : 0;
              const rem = Math.max(0, Math.min(1, (next - now) / Math.max(0.02, ivSc)));
              prog = (((into - rem) / info.totalNotes) % 1 + 1) % 1;
              active = true;
            }
          } else if (on && (type === 'bass' || type === 'run' || type === 'pedal' || type === 'drone' || type === 'shape' || (type === 'beat' && layer && layer.gen === 'euclid'))) {
            // Windowed/phase-anchored layers track position in a phase clock, not
            // E.clocks — fill the bar across the unit/loop from that anchor.
            let st = null;
            if (type === 'bass') st = E.bassPhase && E.bassPhase[key];
            else if (type === 'shape') { const i = Math.max(0, Math.min((Array.isArray(layer.shapes) ? layer.shapes.length : 1) - 1, layer.sel | 0)); st = E.shapePhase && (E.shapePhase[key + '#' + i] || E.shapePhase[key + '#0']); }
            else st = E.runPhase && E.runPhase[key];
            const P = _ambLayerPeriodSec(E, key, layer, E._cfg || E.getCfg());
            if (st && st.startAt != null && P > 0 && now >= st.startAt) {
              prog = (((now - st.startAt) % P) / P + 1) % 1;
              active = true;
            }
          } else if (on && type === 'seq') {
            // Seq fills across the actual UNIT length (auto-mode phrases are spaced
            // by the unit's natural length, not the Interval knob), so the bar can't
            // reset mid-loop. E.clocks[key] is the NEXT phrase start (future).
            const next = E.clocks && E.clocks[key];
            const P = _ambLayerPeriodSec(E, key, layer, E._cfg || E.getCfg());
            if (typeof next === 'number' && next > now && P > 0.001) {
              const x = (next - now) / P;
              prog = ((Math.ceil(x) - x) % 1 + 1) % 1;
              active = true;
            }
          } else if (on) {
            const next = E.clocks && E.clocks[key];
            if (typeof next === 'number' && next > now) {
              // Divide by the SAME interval the engine advances by (snapped in
              // sync mode, and Unit-Sync time-scaled) so the bar tracks the notes.
              const cfg2 = E._cfg || E.getCfg();
              const iv = Math.max(0.05, _ambStepSecFor(layer, 0.05, cfg2) * _ambLayerScale(E, key, layer, cfg2) || 1);
              const x = (next - now) / iv;
              prog = Math.max(0, Math.min(1, Math.ceil(x) - x));
              active = true;
            }
          }
        }
        el.style.setProperty('--ph', active ? prog.toFixed(3) : '0');
        el.classList.toggle('active', active);
        el.classList.toggle('frozen', frozen);
      });
    }
    function _ambVizKick(E) { if (E.viz && !E.viz.raf) E.viz.raf = requestAnimationFrame(() => _ambVizFrame(E)); }
    function _ambStartViz(E) {
      if (E.viz) { _ambVizFrame(E); return; }
      const canvas = document.getElementById(E.vizId);
      if (!canvas || typeof Tone === 'undefined') return;
      let analyser;
      try {
        analyser = new Tone.Analyser('waveform', 512);
        if (typeof masterBus !== 'undefined' && masterBus) masterBus.connect(analyser);
        else Tone.getDestination().connect(analyser);
      } catch (e) { return; }
      E.viz = { analyser, raf: 0 };
      _ambVizFrame(E);
    }
    function _ambStopViz(E) {
      if (!E.viz) return;
      if (E.viz.raf) cancelAnimationFrame(E.viz.raf);
      try { E.viz.analyser.dispose(); } catch (e) {}
      E.viz = null;
    }

    // ---- Panel ---------------------------------------------------------
    function _ambFmtMs(ms) {
      ms = ms | 0;
      return ms >= 1000 ? (ms / 1000).toFixed(2).replace(/0$/, '').replace(/\.0?$/, '') + ' s' : ms + ' ms';
    }
    function _ambRefreshPlayBtn(E) {
      const btn = document.getElementById(E.playId);
      if (!btn) return;
      const on = !!E.timer;
      btn.textContent = on ? '⏹' : '▶';   // icon-only, like the Make footer play button
      btn.classList.toggle('active', on);
    }
    // ---- Shared control builders (module scope: used by _ambientInit AND the
    // dynamic Seq renderer). They emit 'ambient-' id stems; both callers
    // translate the stem to the engine's idPrefix after building.
    // Slider control. The third grid column shows the LIVE numeric value (like
    // _ambTm) instead of a static hint; the descriptive hint becomes the row's
    // tooltip so it's still discoverable. The value readout (id + '-v') is
    // updated live on drag by a delegated listener and on programmatic sync by
    // _ambSyncSliderReadouts.
    // Plain-language explanation per parameter (keyed by lowercased label), shown
    // as a hover/long-press tooltip on each control's label so the user knows what
    // every knob does. Falls back to the control's short hint when unmapped.
    const _AMB_PARAM_DESC = {
      register: 'Octave the layer plays in — higher is brighter.',
      note: 'Which scale degree the pedal sits on (1 = the key root, 2 = the 2nd, …).',
      range: 'How many octaves the notes span.',
      transpose: 'Shift the whole layer by half-steps (±2 octaves), chromatically.',
      bars: 'Length of the loop in bars before it repeats.',
      density: 'Notes per bar.',
      length: 'How long each note sustains.',
      interval: 'Time between events.',
      rate: 'How fast it cycles.',
      drift: 'Phase offset — nudges the layer off the downbeat for polymetric interplay.',
      vary: 'How much it deviates from its base pattern (0 = repeats exactly).',
      hold: 'How many units the note is held before it is struck again.',
      unit: 'Length of one hold unit — re-strike happens every Hold × Unit.',
      'time vary': 'Randomly nudges each re-strike earlier/later (0 = dead steady).',
      'pitch vary': 'Chance each re-strike drifts an octave (and, for a single note, to another scale degree).',
      rests: 'Chance that each hit is silent.',
      accent: 'Dynamic variation — flat to punchy.',
      level: 'Layer volume.',
      attack: 'Fade-in time of each note.',
      decay: 'Time to fall from the peak to the sustain level.',
      sustain: 'Held level after the decay, while the note is on.',
      release: 'Fade-out time after each note ends.',
      motion: 'Detune / drift movement applied to the voicing.',
      strum: 'Spread a chord from a block into an arpeggio.',
      fidelity: 'Strum order — strictly in order to random.',
      fill: 'Sparse to busy.',
      mutate: 'How fast the texture pattern evolves.',
      twist: 'Steady cadence to rhythmic bursts.',
      pulses: 'Euclidean hits per bar.',
      steps: 'Euclidean steps per bar (the grid the pulses spread across).',
      rotate: 'Rotate the euclidean pattern.',
      'rhythm var': 'Stochastic rhythm variation each repeat.',
      'pitch var': 'How often the bass leaves the root note.',
      proximity: 'Step size between notes — 0 forces adjacent steps, higher allows leaps.',
      octaves: 'Octave span of the arpeggio.',
      randomness: 'How far the arp deviates from its direction (Random = fully shuffled).',
      'every n': 'Return to the original sequence every N cycles.',
      'chance %': 'Chance of playing the original verbatim each cycle.',
      amount: 'Variation intensity.',
      chop: 'Slice the sample into N pieces across the interval.',
      gate: 'Note length as a percentage of the slot.',
      spread: 'Stereo width — fans the voices across the field.',
      depth: 'Modulation depth.',
      send: 'Amount sent to the reverb.',
      mix: 'Dry → wet balance.',
      feedback: 'How much the delay echoes repeat.',
      drive: 'Distortion amount.',
      tone: 'The voice / instrument this layer plays.',
      notes: 'The scale, chord, wrap or progression this layer draws pitches from.',
      when: 'Conditional — which cycles this layer plays on.',
      gen: 'Beat pattern source — Random (a hit each Interval) or Euclidean (a BPM-locked pattern of Pulses spread over Steps, per bar).',
      kit: 'The drum kit this Beat layer triggers.',
    };
    function _ambParamDesc(label, hint) {
      const k = String(label || '').toLowerCase().trim();
      return _AMB_PARAM_DESC[k] || hint || '';
    }
    // Quote-safe description for a title="" attribute.
    function _ambTitleAttr(label, hint) {
      return String(_ambParamDesc(label, hint)).replace(/"/g, '&quot;');
    }
    const _ambSl = (label, id, min, max, val, hint) => {
      const desc = _ambParamDesc(label, hint);
      const dt = desc ? ' title="' + String(desc).replace(/"/g, '&quot;') + '"' : '';
      return '<div class="ambient-ctrl"' + dt + '>' +
      '<label for="' + id + '"' + dt + '>' + label + '</label>' +
      '<input type="range" class="ambient-sl" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '" />' +
      '<span class="ambient-hint ambient-sl-v" id="' + id + '-v">' + ((val != null && val !== '') ? val : '') + '</span></div>';
    };
    // One delegated listener mirrors every Bloom slider's value into its readout
    // as it's dragged — across all panels (master + lanes), no matter which
    // per-control handler also fires. Capture phase so a stopPropagation can't
    // suppress it.
    try {
      document.addEventListener('input', (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'INPUT' || t.type !== 'range' || !t.id || !t.classList || !t.classList.contains('ambient-sl')) return;
        const v = document.getElementById(t.id + '-v');
        if (v) v.textContent = t.value;
      }, true);
    } catch (e) {}
    // Mirror PROGRAMMATIC slider changes (sync / restore — these don't fire
    // 'input') into the readouts. Sweeps every Bloom slider in `root`.
    function _ambSyncSliderReadouts(root) {
      const r = root || document;
      let list; try { list = r.querySelectorAll('input.ambient-sl'); } catch (e) { return; }
      list.forEach(sl => { if (!sl.id) return; const v = document.getElementById(sl.id + '-v'); if (v) v.textContent = sl.value; });
    }
    const _ambTm = (label, id, min, max, step, val) => {
      const desc = _ambParamDesc(label, '');
      const dt = desc ? ' title="' + String(desc).replace(/"/g, '&quot;') + '"' : '';
      return '<div class="ambient-ctrl"' + dt + '><label for="' + id + '"' + dt + '>' + label + '</label>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" />' +
      '<span class="ambient-hint" id="' + id + '-v"></span></div>';
    };
    // Saved sequences as a "Sequence" optgroup for shape/wave dropdowns.
    function _ambSeqWaveOptgroup() {
      const list = (typeof savedSequences !== 'undefined' && Array.isArray(savedSequences)) ? savedSequences : [];
      const o = list.map((s, i) => (s && s.type !== 'audio' && Array.isArray(s.steps) && s.steps.length)
        ? '<option value="seq:' + i + '">' + String(s.name || ('Seq ' + (i + 1))).replace(/[<>&"]/g, '') + '</option>' : '').join('');
      return o ? ('<optgroup label="Sequence">' + o + '</optgroup>') : '';
    }
    const _ambShapeSel = (id) => '<select id="' + id + '" class="ambient-select">' +
      ['sine', 'triangle', 'sawtooth', 'square', 'smooth', 'sharp'].map(s => '<option value="' + s + '">' + s + '</option>').join('') +
      _ambSeqWaveOptgroup() + '</select>';
    // The Pitch/Velocity/Gate · Stepped/Smooth · Zero/Hold sub-row shown under a
    // mod target's Shape when a sequence is selected. `base` = the target's id
    // stem ('ambient-<layer>-mod-<target>'). Values are set later via sync.
    function _ambModSeqRow(base) {
      const sel = (suf, opts) => '<select id="' + base + '-' + suf + '" class="ambient-select">' + opts.map(o => '<option value="' + o[0] + '">' + o[1] + '</option>').join('') + '</select>';
      return '<div class="ambient-ctrl ambient-mod-seqrow" id="' + base + '-seqrow" hidden>' +
        '<label>Read</label>' + sel('seqsrc', [['pitch','Pitch'],['velocity','Velocity'],['gate','Gate']]) +
        '<label>Curve</label>' + sel('seqinterp', [['step','Step'],['smooth','Smooth']]) +
        '<label>Rest</label>' + sel('seqrest', [['zero','Zero'],['hold','Hold']]) + '</div>';
    }
    // Set a mod target's shape from a dropdown value ('seq:<idx>' → seq + ref).
    function _ambSetModShape(m, value) {
      const v = value || 'sine';
      if (v.indexOf('seq:') === 0) {
        m.shape = 'seq'; m.seqRef = parseInt(v.slice(4), 10) || 0;
        if (['pitch','velocity','gate'].indexOf(m.seqSource) < 0) m.seqSource = 'velocity';
        if (['step','smooth'].indexOf(m.seqInterp) < 0) m.seqInterp = 'step';
        if (['zero','hold'].indexOf(m.seqRest) < 0) m.seqRest = 'zero';
      } else { m.shape = v; }
    }
    // Push a mod target's stored shape/seq state into its rendered controls.
    // `el(suf)` resolves an element whose id ends '...-mod-<t>-<suf>'.
    function _ambSyncModShapeEl(el, m, t) {
      if (!m) return;
      const sh = el('mod-' + t + '-shape');
      if (sh) sh.value = (m.shape === 'seq') ? ('seq:' + (m.seqRef | 0)) : (m.shape || 'sine');
      const sr = el('mod-' + t + '-seqrow'); if (sr) sr.hidden = (m.shape !== 'seq');
      const setS = (suf, val) => { const e = el('mod-' + t + '-' + suf); if (e && val) e.value = val; };
      setS('seqsrc', m.seqSource); setS('seqinterp', m.seqInterp); setS('seqrest', m.seqRest);
    }
    // Wire one mod target's Shape select (seq-aware) + the seq sub-row.
    // get() → the mod host object (has .mod); sync optional (resync audio).
    function _ambWireModTarget(E, el, get, t, sync) {
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const sh = el('mod-' + t + '-shape');
      if (sh) sh.addEventListener('change', () => {
        _E = E; const L = get(); if (!L || !L.mod || !L.mod[t]) return;
        _ambSetModShape(L.mod[t], sh.value);
        const sr = el('mod-' + t + '-seqrow'); if (sr) sr.hidden = (L.mod[t].shape !== 'seq');
        if (sync) sync(); persist();
      });
      const bindSub = (suf, key) => { const e = el('mod-' + t + '-' + suf); if (e) e.addEventListener('change', () => { _E = E; const L = get(); if (!L || !L.mod || !L.mod[t]) return; L.mod[t][key] = e.value; if (sync) sync(); persist(); }); };
      bindSub('seqsrc', 'seqSource'); bindSub('seqinterp', 'seqInterp'); bindSub('seqrest', 'seqRest');
    }
    // When control: a 16-step toggle grid, COLLAPSED by default behind a summary
    // button ("Always" all on / "Never" all off / the binary pattern). Each cell
    // is one cycle in a 16-step pattern (lit = play, dark = skip), repeating every
    // 16 cycles. The lit cells ARE the binary; tap to toggle. New layers default
    // to Always (all 16 lit).
    const _ambWhenCtrl = (stem) => {
      const dt = ' title="' + _ambTitleAttr('When', 'cond') + '"';
      let cells = '';
      for (let i = 0; i < 16; i++) cells += '<button type="button" class="ambient-when-cell" data-step="' + i + '" aria-label="step ' + (i + 1) + '"></button>';
      return '<div class="ambient-ctrl ambient-when-ctrl"' + dt + '>' +
        '<label' + dt + '>When</label>' +
        '<div class="ambient-when-wrap">' +
          '<button type="button" class="ambient-when-toggle" aria-expanded="false" title="Show / hide the 16-step play pattern">' +
            '<span class="ambient-when-summary">Always</span>' +
            '<span class="ambient-when-caret" aria-hidden="true"></span>' +
          '</button>' +
          '<div class="ambient-when-grid" id="' + stem + 'when" role="group" aria-label="When step pattern">' + cells + '</div>' +
        '</div></div>';
    };
    const _ambCondCtrl = (layer) => _ambWhenCtrl('ambient-' + layer + '-');
    // Beat "Gen" mode select: Random (one hit per Interval) vs Euclidean (a
    // BPM-locked euclidean pattern over N bars). `stem` ends with '-'.
    const _ambGenSel = (stem) =>
      '<div class="ambient-ctrl" title="' + _ambTitleAttr('Gen', 'pattern') + '"><label for="' + stem + 'gen">Gen</label>' +
      '<select id="' + stem + 'gen" class="ambient-select"><option value="random">Random</option><option value="euclid">Euclidean</option></select>' +
      '<span class="ambient-hint">pattern</span></div>';
    // Beat Gen visibility: Euclidean shows Pulses/Steps/Rotate/Phrase + Rhythm
    // var and hides the free Interval/Rate; Random does the opposite. `stem` is
    // the id prefix ending in '-'; `p` (extras only) lets Random defer Interval
    // vs Rate visibility to _ambUnitSyncViz.
    function _ambBeatGenVis(E, stem, inst, p) {
      const euclid = !!(inst && inst.gen === 'euclid');
      const rowOf = (suf) => { const e = _ambGet(E, stem + suf); return (e && e.closest) ? e.closest('.ambient-ctrl') : null; };
      const setRow = (suf, show) => { const r = rowOf(suf); if (r) r.style.display = show ? '' : 'none'; };
      // Interval tm id differs: primary 'interval', extras 'intervalMs'.
      const setIntervalRow = (show) => { const r = rowOf('intervalMs') || rowOf('interval'); if (r) r.style.display = show ? '' : 'none'; };
      ['pulses', 'steps', 'rotate', 'bars', 'rhythmVar'].forEach(s => setRow(s, euclid));
      setRow('rate', !euclid);
      if (euclid) { setIntervalRow(false); }
      else { setIntervalRow(true); if (p && typeof _ambUnitSyncViz === 'function') { try { _ambUnitSyncViz(E, p, inst); } catch (e) {} } }
    }
    const _ambModTarget = (layer, target, label, hint, defRate) =>
      '<div class="ambient-mod-target"><div class="ambient-mod-sub">' + label + '</div>' +
        _ambSl('Depth', 'ambient-' + layer + '-mod-' + target + '-depth', 0, 100, 0, hint) +
        _ambSl('Rate', 'ambient-' + layer + '-mod-' + target + '-rate', 0, 100, defRate, 'slow → fast') +
        '<div class="ambient-ctrl"><label for="ambient-' + layer + '-mod-' + target + '-shape">Shape</label>' +
          _ambShapeSel('ambient-' + layer + '-mod-' + target + '-shape') + '<span class="ambient-hint">wave</span></div>' +
        _ambModSeqRow('ambient-' + layer + '-mod-' + target) + '</div>';
    const _ambModUi = (layer) =>
      '<details class="ambient-mod"><summary class="ambient-mod-head">Mod · VCA / VCO / VCF</summary>' +
        _ambModTarget(layer, 'vca', 'VCA · amplitude', 'tremolo', 30) +
        _ambModTarget(layer, 'vco', 'VCO · pitch', 'vibrato', 20) +
        _ambModTarget(layer, 'vcf', 'VCF · cutoff', 'sweep', 15) + '</details>';
    // Per-layer FX (Reverb send + Delay + Distortion), collapsible like Mod.
    const _ambFxUi = (layer) =>
      '<details class="ambient-mod"><summary class="ambient-mod-head">FX · Reverb / Delay / Distortion</summary>' +
        '<div class="ambient-mod-target"><div class="ambient-mod-sub">Reverb</div>' +
          _ambSl('Send', 'ambient-' + layer + '-fx-rev', 0, 100, 0, 'to verb') + '</div>' +
        '<div class="ambient-mod-target"><div class="ambient-mod-sub">Delay</div>' +
          _ambSl('Mix', 'ambient-' + layer + '-fx-dly-mix', 0, 100, 0, 'dry → wet') +
          _ambTm('Time', 'ambient-' + layer + '-fx-dly-time', 20, 1500, 5, 300) +
          _ambSl('Feedback', 'ambient-' + layer + '-fx-dly-fb', 0, 95, 35, '%') + '</div>' +
        '<div class="ambient-mod-target"><div class="ambient-mod-sub">Distortion</div>' +
          _ambSl('Drive', 'ambient-' + layer + '-fx-dist-amt', 0, 100, 40, 'amount') +
          _ambSl('Mix', 'ambient-' + layer + '-fx-dist-mix', 0, 100, 0, 'dry → wet') + '</div>' +
      '</details>';
    // "Rate" selector — a layer's speed as a note division of the global BPM
    // ('' = Free, follow the ms Interval). Used by Beat layers.
    const _AMB_RATE_OPTS = [['', 'Free (ms)'], ['1/1', '1/1'], ['1/2', '1/2'], ['1/4', '1/4'], ['1/4T', '1/4T'], ['1/8', '1/8'], ['1/8T', '1/8T'], ['1/16', '1/16'], ['1/16T', '1/16T'], ['1/32', '1/32']];
    const _ambRateSel = (stem) =>
      '<div class="ambient-ctrl"><label for="' + stem + '">Rate</label><select id="' + stem + '" class="ambient-select">' +
      _AMB_RATE_OPTS.map(o => '<option value="' + o[0] + '">' + o[1] + '</option>').join('') +
      '</select><span class="ambient-hint">vs global BPM</span></div>';
    // A layer's display label: the user-set name if present, else the type
    // fallback ('Bed', 'Seq1', …). Stored in layer.label so it never collides
    // with seq.name (seed name) or sample.name (source name).
    function _ambLayerLabel(layer, fallback) {
      return (layer && typeof layer.label === 'string' && layer.label.trim()) ? layer.label.trim() : fallback;
    }
    // Confirm before removing a layer (delete is destructive + not undoable).
    function _ambConfirmDeleteLayer(name) {
      if (typeof confirm !== 'function') return true;
      return confirm('Delete layer “' + (name || 'this layer') + '”? This can’t be undone.');
    }
    const _ambEscText = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const _ambHead = (label, onId, delId, freezeKey) =>
      '<div class="ambient-layer-head"><button type="button" class="ambient-toggle" id="' + onId + '"><span class="ambient-layer-name">' + _ambEscText(label) + '</span></button>' +
      (freezeKey ? '<button type="button" class="ambient-rename-btn" data-rkey="' + freezeKey + '" title="Rename layer" aria-label="Rename layer">✎</button>' : '') +
      // Live unit-length readout (filled by _ambSyncLayerUnits) — shows the layer's
      // unit/loop length and the formula that produces it, so you know what to tweak.
      (freezeKey ? '<span class="ambient-layer-unit" data-ukey="' + freezeKey + '" title="Unit length (tap the named parameters to change it)"></span>' : '') +
      (freezeKey ? '<button type="button" class="ambient-solo-btn" data-skey="' + freezeKey + '" title="Solo — play only soloed layers">S</button>' : '') +
      (freezeKey ? '<button type="button" class="ambient-freeze-btn" data-fkey="' + freezeKey + '" title="Freeze — press to start the loop, press again to set its length">❄</button>' : '') +
      (delId ? '<button type="button" class="ambient-seq-del" id="' + delId + '" title="Remove this layer" aria-label="Remove this layer">✕</button>' : '') +
      '<button type="button" class="ambient-collapse" title="Collapse / expand layer" aria-label="Collapse or expand this layer"></button>' +
      (freezeKey ? '<span class="ambient-ph" data-phkey="' + freezeKey + '" aria-hidden="true"><i></i></span>' : '') +
      '</div>';
    // Translate an 'ambient-' id stem to the engine's DOM prefix, and look it up.
    const _ambTrId = (E, id) => (E.idPrefix === 'ambient') ? id : id.replace(/^ambient-/, E.idPrefix + '-');
    const _ambGet = (E, id) => document.getElementById(_ambTrId(E, id));
    function _ambNamespaceHtml(E, html) {
      return (E.idPrefix === 'ambient') ? html : html.replace(/((?:id|for)=")ambient-/g, '$1' + E.idPrefix + '-');
    }

    // ---- Per-layer Stereo control (Spread | Pan toggle + fader) ----------
    // Shared by every layer surface (primaries, extras, seqs, samples). `stem`
    // is the layer's id prefix WITHOUT a trailing dash (e.g. 'ambient-bed',
    // 'ambient-samp-3'); ids become '<stem>-spread' + '<stem>-spread-mode-*'.
    // Spread mode → fader is 0..100 WIDTH; Pan mode → fader is L100..C..R100.
    // Toggling either mode resets the fader to 0 (centre / no spread).
    const _ambSpreadLabel = (mode, val) =>
      (mode === 'pan') ? ((val | 0) === 0 ? 'C' : ((val < 0 ? 'L' : 'R') + Math.abs(val | 0))) : String(val | 0);
    // Element ids use a '-stereo' suffix (NOT '-spread') because some layers
    // already own a '-spread' slider (Bed's pitch voicing Spread) — reusing it
    // would collide on getElementById.
    const _ambSpreadCtrl = (stem, layer) => {
      const mode = (layer && layer.panMode === 'pan') ? 'pan' : 'spread';
      const val = (layer && Number.isFinite(layer.space)) ? (layer.space | 0) : 0;
      return '<div class="ambient-ctrl ambient-spread"><label>Stereo</label>' +
        '<span class="ambient-spread-seg">' +
          '<button type="button" class="ambient-seg' + (mode === 'spread' ? ' active' : '') + '" id="' + stem + '-stereo-mode-spread">Spread</button>' +
          '<button type="button" class="ambient-seg' + (mode === 'pan' ? ' active' : '') + '" id="' + stem + '-stereo-mode-pan">Pan</button>' +
        '</span>' +
        '<input type="range" id="' + stem + '-stereo" min="' + (mode === 'pan' ? -100 : 0) + '" max="100" step="1" value="' + val + '" />' +
        '<span class="ambient-hint" id="' + stem + '-stereo-v">' + _ambSpreadLabel(mode, val) + '</span></div>';
    };
    // Push current layer state into an already-rendered Stereo control (used by
    // the primaries, whose HTML is built once and synced separately).
    function _ambSyncSpread(E, stem, layer) {
      if (!layer) return;
      const mode = (layer.panMode === 'pan') ? 'pan' : 'spread';
      const slider = _ambGet(E, stem + '-stereo'), lbl = _ambGet(E, stem + '-stereo-v');
      const segS = _ambGet(E, stem + '-stereo-mode-spread'), segP = _ambGet(E, stem + '-stereo-mode-pan');
      if (slider) { slider.min = (mode === 'pan') ? '-100' : '0'; slider.value = String(layer.space | 0); }
      if (lbl) lbl.textContent = _ambSpreadLabel(mode, layer.space | 0);
      if (segS) segS.classList.toggle('active', mode === 'spread');
      if (segP) segP.classList.toggle('active', mode === 'pan');
    }
    // Wire the Stereo control. getLayer() → the live layer cfg; persist/sync as
    // the surrounding surface defines (sync may be null — pan is read live at
    // emit time, so no node re-wiring is needed).
    function _ambWireSpread(E, stem, getLayer, persist, sync) {
      const slider = _ambGet(E, stem + '-stereo'), lbl = _ambGet(E, stem + '-stereo-v');
      const segS = _ambGet(E, stem + '-stereo-mode-spread'), segP = _ambGet(E, stem + '-stereo-mode-pan');
      if (!slider) return;
      const refresh = (L) => { if (lbl) lbl.textContent = _ambSpreadLabel((L.panMode === 'pan') ? 'pan' : 'spread', L.space | 0); };
      slider.addEventListener('input', () => { _E = E; const L = getLayer(); if (!L) return; L.space = parseInt(slider.value, 10) || 0; refresh(L); if (sync) sync(); if (persist) persist(); });
      const setMode = (mode) => { _E = E; const L = getLayer(); if (!L) return;
        L.panMode = (mode === 'pan') ? 'pan' : 'spread';
        L.space = 0;                                    // reset fader to 0/centre on toggle
        slider.min = (mode === 'pan') ? '-100' : '0';
        slider.value = '0';
        refresh(L);
        if (segS) segS.classList.toggle('active', mode === 'spread');
        if (segP) segP.classList.toggle('active', mode === 'pan');
        if (sync) sync(); if (persist) persist(); };
      if (segS) segS.addEventListener('click', () => setMode('spread'));
      if (segP) segP.addEventListener('click', () => setMode('pan'));
    }

    // ---- Dynamic Seq layers (Seq1, Seq2…) ------------------------------
    // Label for the Seq card's Sections button: count · order/random · key flag.
    function _ambSeqSectionsBtnLabel(s) {
      const n = (s && Array.isArray(s.units)) ? s.units.length : 0;
      const mode = (s && s.unitMode === 'random') ? 'Random' : 'Order';
      return n + ' section' + (n === 1 ? '' : 's') + (n > 1 ? ' · ' + mode : '') + ((s && s.keyMaster) ? ' · 🔑' : '');
    }
    // Sections popover — edit a Seq layer's sections (units): per-section
    // iteration count (reps), reorder, delete, Order⇄Random play mode, and the
    // Key-master flag (this Seq drives the global Key; only one Seq may hold it).
    function _ambShowSeqSectionsMenu(E, seqId, anchorBtn) {
      const getSq = () => { const c = E.getCfg(); return (c && Array.isArray(c.seqs)) ? c.seqs.find(x => x.id === seqId) : null; };
      if (!getSq()) return;
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      // Editing sections invalidates the live section cursor / random bag.
      const resetState = () => { const st = E.seqState && E.seqState[seqId]; if (st) { st.secIdx = 0; st.secRep = 0; st.bag = null; st._keyUnit = null; } };
      const KEYN = (typeof CHROMATIC !== 'undefined' && Array.isArray(CHROMATIC)) ? CHROMATIC : ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const keyLabel = (u) => {
        const r = (((u.rootIdx | 0) % 12) + 12) % 12;
        const sc = (u.scale && typeof prettyScaleName === 'function') ? prettyScaleName(u.scale) : (u.scale || 'chromatic');
        return (KEYN[r] || '') + ' ' + sc;
      };
      const esc = (t) => String(t == null ? '' : t).replace(/[<>&]/g, '');
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const modal = document.createElement('div'); modal.className = 'step-div-modal amb-sections-modal';
      overlay.appendChild(modal);
      const close = () => { try { overlay.remove(); } catch (e) {} try { _ambRenderSeqLayers(E); } catch (e) {} };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      const render = () => {
        const sq = getSq(); if (!sq) { close(); return; }
        const units = sq.units || [];
        let h = '<div class="keep-sdiv-title">Sections</div>';
        h += '<div class="amb-sec-modes">' +
          '<button type="button" class="ambient-seg amb-sec-mode' + (sq.unitMode !== 'random' ? ' on' : '') + '" data-mode="sequence" title="Play sections in order, each for its iteration count.">Order</button>' +
          '<button type="button" class="ambient-seg amb-sec-mode' + (sq.unitMode === 'random' ? ' on' : '') + '" data-mode="random" title="Random bag: a pool of all iterations, drawn without repeats, refilled when empty.">Random</button>' +
          '<button type="button" class="ambient-seg amb-sec-km' + (sq.keyMaster ? ' on' : '') + '" data-km="1" title="This Seq drives the global Key — the grid and every generative layer follow each section\'s key.">🔑 Key master</button>' +
        '</div>';
        h += '<div class="amb-sec-list">';
        units.forEach((u, i) => {
          h += '<div class="amb-sec-row" data-i="' + i + '">' +
            '<span class="amb-sec-name">' + (i + 1) + '. ' + esc(u.name || ('Section ' + (i + 1))) + '</span>' +
            '<span class="amb-sec-key">' + esc(keyLabel(u)) + '</span>' +
            '<span class="amb-sec-reps"><button type="button" data-rep="-1">−</button><b>' + ((u.reps | 0) || 1) + '×</b><button type="button" data-rep="1">+</button></span>' +
            '<span class="amb-sec-move"><button type="button" data-mv="-1"' + (i === 0 ? ' disabled' : '') + '>▲</button><button type="button" data-mv="1"' + (i === units.length - 1 ? ' disabled' : '') + '>▼</button></span>' +
            '<button type="button" class="amb-sec-del" data-del="1" title="Remove section">✕</button>' +
          '</div>';
        });
        if (!units.length) h += '<div class="ambient-cap-empty">No sections — send a saved sequence here with “Append → Seq”.</div>';
        h += '</div>';
        h += '<div class="sm-footer"><button type="button" class="sm-apply amb-sec-ok">Done</button></div>';
        modal.innerHTML = h;
        modal.querySelectorAll('.amb-sec-mode').forEach(b => b.addEventListener('click', () => { const sq2 = getSq(); if (!sq2) return; sq2.unitMode = b.dataset.mode; resetState(); persist(); render(); }));
        const km = modal.querySelector('.amb-sec-km');
        if (km) km.addEventListener('click', () => {
          const cfg = E.getCfg(); const sq2 = getSq(); if (!cfg || !sq2) return;
          const on = !sq2.keyMaster;
          (cfg.seqs || []).forEach(x => { x.keyMaster = false; });
          sq2.keyMaster = on; resetState(); persist(); render();
        });
        modal.querySelectorAll('.amb-sec-row').forEach(row => {
          const i = parseInt(row.dataset.i, 10);
          row.querySelectorAll('[data-rep]').forEach(b => b.addEventListener('click', () => {
            const sq2 = getSq(); if (!sq2 || !sq2.units[i]) return;
            sq2.units[i].reps = Math.max(1, Math.min(64, (((sq2.units[i].reps | 0) || 1) + parseInt(b.dataset.rep, 10))));
            resetState(); persist(); render();
          }));
          row.querySelectorAll('[data-mv]').forEach(b => b.addEventListener('click', () => {
            const sq2 = getSq(); if (!sq2) return; const j = i + parseInt(b.dataset.mv, 10);
            if (j < 0 || j >= sq2.units.length) return;
            const t = sq2.units[i]; sq2.units[i] = sq2.units[j]; sq2.units[j] = t;
            resetState(); persist(); render();
          }));
          const del = row.querySelector('.amb-sec-del');
          if (del) del.addEventListener('click', () => {
            const sq2 = getSq(); if (!sq2) return;
            sq2.units.splice(i, 1);
            if (sq2.units.length <= 1) sq2.unitMode = 'single';
            try { _ambFitSeqInterval(sq2); } catch (e) {}
            resetState(); persist(); render();
            if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
          });
        });
        const ok = modal.querySelector('.amb-sec-ok'); if (ok) ok.addEventListener('click', close);
      };
      render();
      document.body.appendChild(overlay);
    }
    function _ambSeqLayerHtml(s, i) {
      const id = s.id, p = 'ambient-seq-' + id + '-';
      const opts = (arr, cur) => arr.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('');
      return '<div class="ambient-layer collapsed" data-seq-id="' + id + '">' +
        _ambHead(_ambLayerLabel(s, 'Seq' + (i + 1)), p + 'on', p + 'del', 'seq:' + id) +
        '<div class="ambient-ctrl"><label for="' + p + 'tone">Tone</label><select id="' + p + 'tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
        // Ensemble lock — only shown (un-hidden in wiring) when this seq's voice
        // is an ensemble. Locked = members fire together; Unlocked = members
        // spread across notes as independent generative voices.
        '<div class="ambient-ctrl ambient-ens-lock-row" id="' + p + 'enslock-row" hidden><label for="' + p + 'enslock">Ensemble</label>' +
          '<button type="button" id="' + p + 'enslock" class="ambient-seg ambient-ens-lock"></button><span class="ambient-hint">lock / spread</span></div>' +
        // No Notes source here — a Seq plays the pitches captured in its own
        // sequence; the note set is fixed by the sequence, not a scale/chord pick.
        '<div class="ambient-ctrl"><label for="' + p + 'vary">Vary</label><select id="' + p + 'vary" class="ambient-select">' + opts([['pitch', 'Pitch'], ['rhythm', 'Pitch + rhythm'], ['pad', 'Pad re-voice']], s.varyMode) + '</select><span class="ambient-hint">style</span></div>' +
        _ambSl('Amount', p + 'depth', 0, 100, s.varyDepth, 'subtle → wild') +
        // Loop length: Auto (one pass == the played sequence's own length) vs
        // Manual (the Interval knob below). Auto greys out / ignores Interval.
        '<div class="ambient-ctrl"><label for="' + p + 'intervalmode">Loop</label>' +
          '<button type="button" id="' + p + 'intervalmode" class="ambient-seg ambient-interval-mode"></button>' +
          '<span class="ambient-hint">= seq length / manual</span></div>' +
        _ambTm('Interval', p + 'interval', 200, 16000, 50, s.intervalMs) +
        _ambTm('Length', p + 'length', 300, 16000, 100, s.lengthMs) +
        _ambSl('Drift', p + 'drift', 0, 99, s.drift, 'phase offset') +
        _ambWhenCtrl(p) +
        '<div class="ambient-ctrl"><label>Sections</label>' +
          '<button type="button" id="' + p + 'sections" class="ambient-seg ambient-seq-sections">' + _ambSeqSectionsBtnLabel(s) + '</button>' +
          '<span class="ambient-hint">edit ▸</span></div>' +
        '<div class="ambient-ctrl"><label for="' + p + 'return">Return</label><select id="' + p + 'return" class="ambient-select">' + opts([['everyN', 'Every N'], ['chance', 'Chance %']], s.returnMode) + '</select><span class="ambient-hint">to original</span></div>' +
        _ambSl('Every N', p + 'returnN', 1, 16, s.returnN, 'cycles') +
        _ambSl('Chance %', p + 'returnChance', 0, 100, s.returnChance, 'verbatim') +
        _ambSl('Level', p + 'level', 0, 100, s.level, 'soft → boost') +
        _ambSl('Accent', p + 'accent', 0, 100, s.accent | 0, 'flat → dynamic') +
        _ambSpreadCtrl('ambient-seq-' + id, s) +
        _ambModUi('seq-' + id) +
        _ambFxUi('seq-' + id) +
      '</div>';
    }
    // A seq "involves an ensemble" when its layer Tone is an ensemble OR any of
    // its captured note voices are (e.g. a merged lane whose grid voice was one).
    function _seqHasEnsemble(sq) {
      if (!sq) return false;
      if (typeof isEnsembleType === 'function' && isEnsembleType(sq.tone)) return true;
      if (Array.isArray(sq.units)) {
        for (const u of sq.units) {
          if (u && Array.isArray(u.events)) {
            for (const e of u.events) { if (Array.isArray(e.sounds) && e.sounds.some(x => isEnsembleType(x))) return true; }
          }
        }
      }
      return false;
    }
    function _ambSeqEnsLockVis(E, id) {
      const c = E.getCfg(); if (!c) return;
      const sq = (c.seqs || []).find(x => x.id === id); if (!sq) return;
      const p = 'ambient-seq-' + id + '-';
      const row = _ambGet(E, p + 'enslock-row'), btn = _ambGet(E, p + 'enslock');
      if (row) row.hidden = !_seqHasEnsemble(sq);
      if (btn) { const locked = (sq.ensembleLock !== false); btn.textContent = locked ? '🔒 Locked' : '🔓 Unlocked'; btn.classList.toggle('active', locked); btn.title = locked ? 'Locked: all ensemble voices play together on each note' : 'Unlocked: ensemble voices spread across notes as independent generative voices'; }
    }
    function _ambSeqReturnVis(E, id) {
      const c = E.getCfg(); if (!c) return;
      const sq = (c.seqs || []).find(x => x.id === id); if (!sq) return;
      const p = 'ambient-seq-' + id + '-';
      const ctrl = (suf) => { const e = _ambGet(E, p + suf); return e ? e.closest('.ambient-ctrl') : null; };
      const n = ctrl('returnN'), ch = ctrl('returnChance');
      if (n) n.style.display = (sq.returnMode === 'chance') ? 'none' : '';
      if (ch) ch.style.display = (sq.returnMode === 'chance') ? '' : 'none';
    }
    // Reflect the Auto/Manual loop-length toggle: button label + state, the
    // Interval row greyed/disabled in Auto, and its value readout showing the
    // sequence's own length (longest unit) in Auto vs the manual ms otherwise.
    function _ambSeqIntervalModeVis(E, id) {
      const c = E.getCfg(); if (!c) return;
      const sq = (c.seqs || []).find(x => x.id === id); if (!sq) return;
      const p = 'ambient-seq-' + id + '-';
      const auto = (sq.intervalMode !== 'manual');
      const btn = _ambGet(E, p + 'intervalmode');
      if (btn) {
        btn.textContent = auto ? '🔒 Auto' : '🎚 Manual';
        btn.classList.toggle('active', auto);
        btn.title = auto
          ? 'Auto: each pass lasts exactly one sequence (per picked unit in Interleave). The Interval knob is ignored.'
          : 'Manual: the Interval knob sets the re-trigger time.';
      }
      const ivInput = _ambGet(E, p + 'interval');
      if (ivInput) {
        ivInput.disabled = auto;
        const row = ivInput.closest('.ambient-ctrl');
        if (row) row.style.opacity = auto ? '0.45' : '';
      }
      const v = _ambGet(E, p + 'interval-v');
      if (v) {
        if (auto) {
          let total = 0;
          (sq.units || []).forEach(u => { total = Math.max(total, _unitTotalMs(u)); });
          v.textContent = total > 0 ? ('≈ ' + _ambFmtMs(total)) : _ambFmtMs(sq.intervalMs);
        } else {
          v.textContent = _ambFmtMs(sq.intervalMs);
        }
      }
    }
    function _ambWireSeqLayer(E, s) {
      const id = s.id, p = 'ambient-seq-' + id + '-';
      const getSq = () => { const c = E.getCfg(); return (c && Array.isArray(c.seqs)) ? c.seqs.find(x => x.id === id) : null; };
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const el = (suf) => _ambGet(E, p + suf);
      const bindInt = (suf, key) => { const e = el(suf); if (!e) return; e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; sq[key] = parseInt(e.value, 10) || 0; persist(); }); };
      const bindMs = (suf, key) => { const e = el(suf), v = el(suf + '-v'); if (!e) return; e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; const val = parseInt(e.value, 10) || 0; sq[key] = val; if (v) v.textContent = _ambFmtMs(val); persist(); }); };
      const bindStr = (suf, key, after) => { const e = el(suf); if (!e) return; e.addEventListener('change', () => { _E = E; const sq = getSq(); if (!sq) return; sq[key] = e.value || sq[key]; if (after) after(); persist(); }); };
      const toneSel = el('tone');
      if (toneSel) {
        populateGroupedToneSelect(toneSel, _ambToneOptions(), _ambGridVoiceOption());
        // Show the tone of the sequence's FIRST step (per-step voice), not a
        // blank default — updated live to the playing step during playback.
        try { toneSel.value = _ambSeqStepTone(s, 0); } catch (e) {}
      }
      bindStr('tone', 'tone', () => _ambSeqEnsLockVis(E, id)); bindStr('vary', 'varyMode');
      const secBtn = el('sections');
      if (secBtn) secBtn.addEventListener('click', () => { _E = E; _ambShowSeqSectionsMenu(E, id, secBtn); });
      const lockBtn = el('enslock');
      if (lockBtn) lockBtn.addEventListener('click', () => { _E = E; const sq = getSq(); if (!sq) return; sq.ensembleLock = !(sq.ensembleLock !== false); _ambSeqEnsLockVis(E, id); persist(); });
      _ambSeqEnsLockVis(E, id);
      bindInt('depth', 'varyDepth'); bindMs('interval', 'intervalMs'); bindMs('length', 'lengthMs');
      // Loop-length Auto/Manual toggle. Dragging the Interval knob implies a
      // manual override, so it flips the mode to Manual and refreshes the UI.
      const ivModeBtn = el('intervalmode');
      if (ivModeBtn) ivModeBtn.addEventListener('click', () => { _E = E; const sq = getSq(); if (!sq) return; sq.intervalMode = (sq.intervalMode === 'manual') ? 'auto' : 'manual'; _ambSeqIntervalModeVis(E, id); persist(); });
      const ivInput = el('interval');
      if (ivInput) ivInput.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; if (sq.intervalMode !== 'manual') { sq.intervalMode = 'manual'; _ambSeqIntervalModeVis(E, id); } });
      bindInt('drift', 'drift'); _ambBindWhen(E, p, getSq, persist);
      bindStr('return', 'returnMode', () => _ambSeqReturnVis(E, id));
      bindInt('returnN', 'returnN'); bindInt('returnChance', 'returnChance'); bindInt('level', 'level'); bindInt('accent', 'accent');
      _ambWireSpread(E, 'ambient-seq-' + id, getSq, persist, null);
      ['vca', 'vco', 'vcf'].forEach(t => {
        ['depth', 'rate'].forEach(k => { const e = el('mod-' + t + '-' + k); if (!e) return; e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; sq.mod[t][k] = parseInt(e.value, 10) || 0; if (E.timer) { try { _ambSyncMods(); } catch (x) {} } persist(); }); });
        _ambWireModTarget(E, el, getSq, t, () => { if (E.timer) { try { _ambSyncMods(); } catch (x) {} } });
      });
      // Per-layer FX wiring.
      const bindFx = (suf, setter) => { const e = el('fx-' + suf); if (!e) return; const v = el('fx-' + suf + '-v'); e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; const val = parseInt(e.value, 10) || 0; setter(sq, val); if (v) v.textContent = _ambFmtMs(val); if (E.timer) { try { _ambSyncMods(); } catch (x) {} } persist(); }); };
      bindFx('rev', (q, v) => { q.revSend = v; });
      bindFx('dly-mix', (q, v) => { q.delay.mix = v; });
      bindFx('dly-time', (q, v) => { q.delay.timeMs = v; });
      bindFx('dly-fb', (q, v) => { q.delay.feedback = v; });
      bindFx('dist-amt', (q, v) => { q.dist.amount = v; });
      bindFx('dist-mix', (q, v) => { q.dist.mix = v; });
      const onB = el('on'); if (onB) { onB.classList.toggle('on', !!s.on); onB.addEventListener('click', () => { _E = E; const sq = getSq(); if (!sq) return; _ambToggleLayer(E, 'seq:' + id, sq, onB, persist); }); }
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteSeqLayer(E, id));
      const layerDiv = onB ? onB.closest('.ambient-layer') : null;
      const cB = layerDiv ? layerDiv.querySelector('.ambient-collapse') : null;
      if (cB && layerDiv) cB.addEventListener('click', () => layerDiv.classList.toggle('collapsed'));
      // Initial values not carried by `selected`/value attrs.
      const setVal = (suf, v) => { const e = el(suf); if (e && v != null) e.value = String(v); };
      // NOTE: do NOT setVal('tone', s.tone) here — a Seq layer's own `tone` is
      // usually '' (tone is per-step), and that empty set would clobber the
      // first-step tone already applied above (line ~3750). Leave the tone
      // select alone; it reflects the playing step via _ambSeqReflectTone.
      setVal('scale', s.scale);
      const iv = el('interval-v'); if (iv) iv.textContent = _ambFmtMs(s.intervalMs);
      const lv = el('length-v'); if (lv) lv.textContent = _ambFmtMs(s.lengthMs);
      ['vca', 'vco', 'vcf'].forEach(t => { if (!s.mod || !s.mod[t]) return; setVal('mod-' + t + '-depth', s.mod[t].depth); setVal('mod-' + t + '-rate', s.mod[t].rate); _ambSyncModShapeEl(el, s.mod[t], t); });
      setVal('fx-rev', s.revSend);
      if (s.delay) { setVal('fx-dly-mix', s.delay.mix); setVal('fx-dly-time', s.delay.timeMs); const dtv = el('fx-dly-time-v'); if (dtv) dtv.textContent = _ambFmtMs(s.delay.timeMs); setVal('fx-dly-fb', s.delay.feedback); }
      if (s.dist) { setVal('fx-dist-amt', s.dist.amount); setVal('fx-dist-mix', s.dist.mix); }
      _ambSeqReturnVis(E, id);
      _ambSeqIntervalModeVis(E, id); // sets the interval readout too (overrides the line above in Auto)
    }
    // Enumerate every PRESENT layer (built-ins + extras + seqs + samples) as
    // { key, name, layer } where `layer` is the live cfg object carrying a
    // `level`. Powers the Mixer's one-fader-per-layer strip.
    function _ambMixerLayers(cfg) {
      const out = [];
      if (!cfg) return out;
      [['bed', 'Bed'], ['motif', 'Motif'], ['texture', 'Texture'], ['beat', 'Beat']].forEach(([k, name]) => {
        const L = cfg[k];
        if (L && L.present !== false) out.push({ key: k, name: _ambLayerLabel(L, name), layer: L });
      });
      (Array.isArray(cfg.extras) ? cfg.extras : []).forEach((ex) => {
        if (!ex) return;
        const sch = (typeof _AMB_LAYER_SCHEMA !== 'undefined') ? _AMB_LAYER_SCHEMA[ex.type] : null;
        out.push({ key: ex.type + ':' + ex.id, name: _ambLayerLabel(ex, (sch && sch.label) ? sch.label : (ex.type || 'Layer')), layer: ex });
      });
      // Seq / Sample channel names mirror the layer CARD headers exactly
      // (_ambSeqLayerHtml uses 'Seq'+(i+1), _ambSampleLayerHtml 'Sample'+(i+1))
      // so the mixer reads the same as the layer it controls — honouring any
      // user-set label.
      (Array.isArray(cfg.seqs) ? cfg.seqs : []).forEach((s, i) => {
        if (!s) return;
        out.push({ key: 'seq:' + s.id, name: _ambLayerLabel(s, 'Seq' + (i + 1)), layer: s });
      });
      (Array.isArray(cfg.samples) ? cfg.samples : []).forEach((s, i) => {
        if (!s) return;
        out.push({ key: 'samp:' + s.id, name: _ambLayerLabel(s, 'Sample' + (i + 1)), layer: s });
      });
      return out;
    }
    // (Re)render the Mixer strip — one vertical fader per layer, bound to that
    // layer's `level`. Level is applied per-note at emit time, so a drag affects
    // subsequent notes (same as each card's Level slider, which this mirrors).
    function _ambRenderMixer(E) {
      const strip = _ambGet(E, 'ambient-mixer-strip');
      if (!strip) return;
      const cfg = E.getCfg();
      const layers = cfg ? _ambMixerLayers(cfg) : [];
      strip.innerHTML = '';
      if (!layers.length) {
        const hint = document.createElement('span');
        hint.className = 'ambient-hint';
        hint.textContent = 'No layers yet.';
        strip.appendChild(hint);
        return;
      }
      layers.forEach(({ name, layer }) => {
        const lvl = Number.isFinite(layer.level) ? layer.level : 70;
        const ch = document.createElement('div');
        ch.className = 'ambient-mix-ch';
        const val = document.createElement('span');
        val.className = 'ambient-mix-val';
        val.textContent = lvl + '%';
        const sld = document.createElement('input');
        sld.type = 'range'; sld.min = '0'; sld.max = '100'; sld.step = '1'; sld.value = String(lvl);
        sld.className = 'ambient-mix-slider';
        sld.setAttribute('orient', 'vertical');
        sld.title = name + ' level';
        sld.addEventListener('input', () => {
          const v = Math.max(0, Math.min(100, parseInt(sld.value, 10) || 0));
          layer.level = v;
          val.textContent = v + '%';
          if (typeof persistWorkspace === 'function') { try { persistWorkspace(); } catch (e) {} }
        });
        const lab = document.createElement('span');
        lab.className = 'ambient-mix-label';
        lab.textContent = name;
        lab.title = name;
        ch.appendChild(val);
        ch.appendChild(sld);
        ch.appendChild(lab);
        strip.appendChild(ch);
      });
    }
    function _ambRenderSeqLayers(E) {
      const wrap = _ambGet(E, 'ambient-seq-layers');
      if (!wrap) return;
      const cfg = E.getCfg(); if (!cfg) return;
      const seqs = Array.isArray(cfg.seqs) ? cfg.seqs : [];
      wrap.innerHTML = _ambNamespaceHtml(E, seqs.map((s, i) => _ambSeqLayerHtml(s, i)).join(''));
      seqs.forEach((s) => _ambWireSeqLayer(E, s));
      try { _ambRenderMixer(E); } catch (e) {}   // keep the mixer in sync on add/delete
    }
    function _ambDeleteSeqLayer(E, id) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.seqs)) return;
      const idx = cfg.seqs.findIndex(s => s.id === id);
      if (idx < 0) return;
      if (!_ambConfirmDeleteLayer(_ambLayerLabel(cfg.seqs[idx], 'Seq' + (idx + 1)))) return;
      cfg.seqs.splice(idx, 1);
      try { if (E.mod['seq:' + id]) _ambTeardownMod('seq:' + id); } catch (e) {}
      if (E.seqState) delete E.seqState[id];
      _ambRenderSeqLayers(E);
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // ---- Dynamic Sample layers (Sample1, Sample2…) ---------------------
    function _ambSampleLayerHtml(s, i) {
      const id = s.id, p = 'ambient-samp-' + id + '-';
      const opts = (arr, cur) => arr.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('');
      const nm = String(s.name || s.sampleId || 'sample').replace(/[<>&"]/g, '');
      return '<div class="ambient-layer collapsed" data-samp-id="' + id + '">' +
        _ambHead(_ambLayerLabel(s, 'Sample' + (i + 1)), p + 'on', p + 'del', 'samp:' + id) +
        '<div class="ambient-ctrl"><label>Source</label><span class="ambient-hint" style="margin-left:auto">' + nm + '</span></div>' +
        _ambSl('Chop', p + 'chop', 1, 16, s.chop, '1 = whole → slices') +
        '<div class="ambient-ctrl"><label for="' + p + 'order">Order</label><select id="' + p + 'order" class="ambient-select">' + opts([['forward', 'Forward'], ['random', 'Random']], s.order) + '</select><span class="ambient-hint">slices</span></div>' +
        _ambTm('Interval', p + 'interval', 200, 16000, 50, s.intervalMs) +
        _ambTm('Length', p + 'length', 80, 16000, 20, s.lengthMs) +
        _ambSl('Drift', p + 'drift', 0, 99, s.drift, 'phase offset') +
        _ambWhenCtrl(p) +
        _ambSl('Level', p + 'level', 0, 100, s.level, 'soft → boost') +
        _ambSpreadCtrl('ambient-samp-' + id, s) +
        _ambModUi('samp-' + id) +
        _ambFxUi('samp-' + id) +
      '</div>';
    }
    function _ambWireSampleLayer(E, s) {
      const id = s.id, p = 'ambient-samp-' + id + '-';
      const getL = () => { const c = E.getCfg(); return (c && Array.isArray(c.samples)) ? c.samples.find(x => x.id === id) : null; };
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const el = (suf) => _ambGet(E, p + suf);
      const sync = () => { if (E.timer) { try { _ambSyncMods(); } catch (x) {} } };
      const bindInt = (suf, key) => { const e = el(suf); if (!e) return; e.addEventListener('input', () => { _E = E; const L = getL(); if (!L) return; L[key] = parseInt(e.value, 10) || 0; sync(); persist(); }); };
      const bindMs = (suf, key) => { const e = el(suf), v = el(suf + '-v'); if (!e) return; e.addEventListener('input', () => { _E = E; const L = getL(); if (!L) return; const val = parseInt(e.value, 10) || 0; L[key] = val; if (v) v.textContent = _ambFmtMs(val); persist(); }); };
      const bindStr = (suf, key) => { const e = el(suf); if (!e) return; e.addEventListener('change', () => { _E = E; const L = getL(); if (!L) return; L[key] = e.value || L[key]; persist(); }); };
      bindInt('chop', 'chop'); bindStr('order', 'order');
      bindMs('interval', 'intervalMs'); bindMs('length', 'lengthMs');
      bindInt('drift', 'drift'); _ambBindWhen(E, p, getL, persist); bindInt('level', 'level');
      _ambWireSpread(E, 'ambient-samp-' + id, getL, persist, sync);
      ['vca', 'vco', 'vcf'].forEach(t => {
        ['depth', 'rate'].forEach(k => { const e = el('mod-' + t + '-' + k); if (!e) return; e.addEventListener('input', () => { _E = E; const L = getL(); if (!L) return; L.mod[t][k] = parseInt(e.value, 10) || 0; sync(); persist(); }); });
        _ambWireModTarget(E, el, getL, t, sync);
      });
      const bindFx = (suf, setter) => { const e = el('fx-' + suf); if (!e) return; const v = el('fx-' + suf + '-v'); e.addEventListener('input', () => { _E = E; const L = getL(); if (!L) return; const val = parseInt(e.value, 10) || 0; setter(L, val); if (v) v.textContent = _ambFmtMs(val); sync(); persist(); }); };
      bindFx('rev', (q, v) => { q.revSend = v; });
      bindFx('dly-mix', (q, v) => { q.delay.mix = v; });
      bindFx('dly-time', (q, v) => { q.delay.timeMs = v; });
      bindFx('dly-fb', (q, v) => { q.delay.feedback = v; });
      bindFx('dist-amt', (q, v) => { q.dist.amount = v; });
      bindFx('dist-mix', (q, v) => { q.dist.mix = v; });
      const onB = el('on'); if (onB) { onB.classList.toggle('on', !!s.on); onB.addEventListener('click', () => { _E = E; const L = getL(); if (!L) return; _ambToggleLayer(E, 'samp:' + id, L, onB, persist); }); }
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteSampleLayer(E, id));
      const layerDiv = onB ? onB.closest('.ambient-layer') : null;
      const cB = layerDiv ? layerDiv.querySelector('.ambient-collapse') : null;
      if (cB && layerDiv) cB.addEventListener('click', () => layerDiv.classList.toggle('collapsed'));
      const setVal = (suf, v) => { const e = el(suf); if (e && v != null) e.value = String(v); };
      const iv = el('interval-v'); if (iv) iv.textContent = _ambFmtMs(s.intervalMs);
      const lv = el('length-v'); if (lv) lv.textContent = _ambFmtMs(s.lengthMs);
      ['vca', 'vco', 'vcf'].forEach(t => { if (!s.mod || !s.mod[t]) return; setVal('mod-' + t + '-depth', s.mod[t].depth); setVal('mod-' + t + '-rate', s.mod[t].rate); _ambSyncModShapeEl(el, s.mod[t], t); });
      setVal('fx-rev', s.revSend);
      if (s.delay) { setVal('fx-dly-mix', s.delay.mix); setVal('fx-dly-time', s.delay.timeMs); const dtv = el('fx-dly-time-v'); if (dtv) dtv.textContent = _ambFmtMs(s.delay.timeMs); setVal('fx-dly-fb', s.delay.feedback); }
      if (s.dist) { setVal('fx-dist-amt', s.dist.amount); setVal('fx-dist-mix', s.dist.mix); }
    }
    function _ambRenderSampleLayers(E) {
      const wrap = _ambGet(E, 'ambient-sample-layers');
      if (!wrap) return;
      const cfg = E.getCfg(); if (!cfg) return;
      const arr = Array.isArray(cfg.samples) ? cfg.samples : [];
      wrap.innerHTML = _ambNamespaceHtml(E, arr.map((s, i) => _ambSampleLayerHtml(s, i)).join(''));
      arr.forEach((s) => _ambWireSampleLayer(E, s));
      try { _ambRenderMixer(E); } catch (e) {}   // keep the mixer in sync on add/delete
    }
    function _ambDeleteSampleLayer(E, id) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.samples)) return;
      const idx = cfg.samples.findIndex(s => s.id === id);
      if (idx < 0) return;
      if (!_ambConfirmDeleteLayer(_ambLayerLabel(cfg.samples[idx], 'Sample' + (idx + 1)))) return;
      cfg.samples.splice(idx, 1);
      try { if (E.mod['samp:' + id]) _ambTeardownMod('samp:' + id); } catch (e) {}
      if (E.seqState) delete E.seqState['samp:' + id];
      _ambRenderSampleLayers(E);
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // ---- Extra layer instances (multiple Bed/Motif/Texture/Beat) -----------
    // cfg.extras holds ADDITIONAL instances beyond the four primaries. Each is
    // a full layer of a built-in type, reusing the same emit functions (routed
    // by a 'type:id' mod key) and one data-driven card builder/wirer. (This card
    // system is what the later cleanup will use for the primaries too.)
    // Layer params are grouped into collapsible sections (Voice / Pitch / Rhythm /
    // Variation / Mix) via ['grp', name] markers — see _ambInstCardHtml. Voice +
    // Mix open by default; fold state is remembered per layer (inst.groupsOpen).
    const _AMB_LAYER_SCHEMA = {
      bed: { label: 'Bed', ctrls: [
        ['grp', 'Voice'], ['tone'],
        ['grp', 'Pitch'], ['notes'], ['sl', 'register', 'Register', 2, 6, 'octave'], ['sl', 'density', 'Density', 1, 8, 'voices'], ['sl', 'spread', 'Spread', 0, 3, '± oct'],
        ['grp', 'Unit'], ['rate'], ['tm', 'intervalMs', 'Interval', 200, 12000, 50], ['unitsync'],
        ['grp', 'Rhythm'], ['tm', 'lengthMs', 'Length', 300, 16000, 100], ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['grp', 'Variation'], ['sl', 'motion', 'Motion', 0, 100, 'detune'], ['sl', 'strum', 'Strum', 0, 100, 'chord → arp'], ['sl', 'strumFidelity', 'Fidelity', 0, 100, 'in order → random'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      motif: { label: 'Motif', ctrls: [
        ['grp', 'Voice'], ['tone'],
        ['grp', 'Pitch'], ['notes'], ['sl', 'register', 'Register', 2, 7, 'octave'], ['sl', 'range', 'Range', 1, 4, '± oct'], ['sl', 'proximity', 'Proximity', 0, 100, 'adjacent → leaps'],
        ['grp', 'Unit'], ['rate'], ['tm', 'intervalMs', 'Interval', 100, 4000, 20], ['unitsync'],
        ['grp', 'Rhythm'], ['tm', 'lengthMs', 'Length', 80, 4000, 20], ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['grp', 'Variation'], ['sl', 'restProb', 'Rests', 0, 100, '%'], ['sl', 'twist', 'Twist', 0, 100, 'steady → bursts'], ['sl', 'accent', 'Accent', 0, 100, 'flat → dynamic'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      texture: { label: 'Texture', ctrls: [
        ['grp', 'Voice'], ['tone'],
        ['grp', 'Pitch'], ['notes'], ['sl', 'register', 'Register', 3, 7, 'octave'],
        ['grp', 'Unit'], ['rate'], ['tm', 'intervalMs', 'Interval', 80, 2000, 10], ['unitsync'],
        ['grp', 'Rhythm'], ['sl', 'fill', 'Fill', 0, 100, 'sparse→busy'], ['tm', 'lengthMs', 'Length', 60, 2000, 10], ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['grp', 'Variation'], ['sl', 'mutateRate', 'Mutate', 0, 100, 'slow→fast'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      beat: { label: 'Beat', ctrls: [
        ['grp', 'Voice'], ['kit'], ['gen'],
        ['grp', 'Unit'], ['rate'], ['tm', 'intervalMs', 'Interval', 80, 2000, 10], ['sl', 'bars', 'Phrase', 1, 8, 'bars (euclid)'], ['unitsync'],
        ['grp', 'Rhythm'], ['sl', 'pulses', 'Pulses', 1, 16, 'euclid hits / bar'], ['sl', 'steps', 'Steps', 2, 16, 'euclid steps / bar'], ['sl', 'rotate', 'Rotate', 0, 15, 'euclid offset'], ['tm', 'lengthMs', 'Length', 60, 2000, 10], ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['grp', 'Variation'], ['sl', 'rhythmVar', 'Rhythm var', 0, 100, 'stochastic'], ['sl', 'restProb', 'Rests', 0, 100, '%'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      // Shape: a generative layer holding N radial-sequencer wheels (js/bloops/21-shape.js).
      // Pitch/voice/prog/gate live PER SHAPE inside the wheel editor.
      shape: { label: 'Shape', ctrls: [
        ['grp', 'Voice'], ['shapes'],
        ['grp', 'Rhythm'], ['cond'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      // Arp: arpeggiates through a user-built SERIES of scales/chords (per-row
      // Direction); Randomness deviates from it. Pitch material is the series.
      arp: { label: 'Arp', ctrls: [
        ['grp', 'Voice'], ['tone'],
        ['grp', 'Pitch'], ['arpseries'], ['sl', 'octaves', 'Octaves', 1, 4, 'span'], ['sl', 'register', 'Register', 2, 7, 'base oct'],
        ['grp', 'Unit'], ['rate'], ['tm', 'intervalMs', 'Interval', 40, 2000, 10], ['unitsync'],
        ['grp', 'Rhythm'], ['tm', 'lengthMs', 'Length', 40, 2000, 10], ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['grp', 'Variation'], ['sl', 'randomness', 'Randomness', 0, 100, 'follow → deviate'], ['sl', 'restProb', 'Rests', 0, 100, '%'], ['sl', 'accent', 'Accent', 0, 100, 'flat → dynamic'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      // Bass: a euclidean rhythmic phrase locked to the global BPM, `bars` bars
      // long; Rhythm/Pitch var add per-repeat variation.
      bass: { label: 'Bass', ctrls: [
        ['grp', 'Voice'], ['tone'],
        ['grp', 'Pitch'], ['notes'], ['sl', 'register', 'Register', 1, 4, 'octave'], ['sl', 'proximity', 'Proximity', 0, 100, 'adjacent → leaps'],
        ['grp', 'Unit'], ['sl', 'bars', 'Phrase', 1, 8, 'bars (seed length)'], ['unitsync'],
        ['grp', 'Rhythm'], ['sl', 'pulses', 'Pulses', 1, 16, 'euclid hits / bar'], ['sl', 'steps', 'Steps', 2, 16, 'euclid steps / bar'], ['sl', 'rotate', 'Rotate', 0, 15, 'euclid offset'], ['tm', 'lengthMs', 'Length', 60, 2000, 20], ['cond'],
        ['grp', 'Variation'], ['sl', 'rhythmVar', 'Rhythm var', 0, 100, 'stochastic'], ['sl', 'pitchVar', 'Pitch var', 0, 100, 'stochastic'], ['sl', 'restProb', 'Rests', 0, 100, '%'], ['sl', 'accent', 'Accent', 0, 100, 'flat → dynamic'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      // Run: a fixed RANDOM note run, `bars` bars long, looping; Vary re-rolls.
      run: { label: 'Run', ctrls: [
        ['grp', 'Voice'], ['tone'],
        ['grp', 'Pitch'], ['notes'], ['sl', 'register', 'Register', 2, 7, 'base octave'], ['sl', 'range', 'Range', 1, 4, 'octave span'], ['sl', 'transpose', 'Transpose', -24, 24, 'half steps (±2 oct)'],
        ['grp', 'Unit'], ['sl', 'bars', 'Bars', 1, 16, 'loop length'], ['unitsync'],
        ['grp', 'Rhythm'], ['sl', 'density', 'Density', 1, 16, 'notes / bar'], ['tm', 'lengthMs', 'Length', 40, 2000, 10], ['cond'],
        ['grp', 'Variation'], ['sl', 'vary', 'Vary', 0, 100, 'repeat → mutate'], ['sl', 'restProb', 'Rests', 0, 100, '%'], ['sl', 'accent', 'Accent', 0, 100, 'flat → dynamic'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      // Pedal: a simple pedal-point loop. Note = scale degree, Vary roams off it.
      pedal: { label: 'Pedal', ctrls: [
        ['grp', 'Voice'], ['tone'], ['sl', 'attack', 'Attack', 0, 2000, 'ms'], ['sl', 'decay', 'Decay', 0, 2000, 'ms'], ['sl', 'sustain', 'Sustain', 0, 100, '%'], ['sl', 'release', 'Release', 0, 4000, 'ms'],
        ['grp', 'Pitch'], ['sl', 'register', 'Register', 1, 7, 'octave'], ['sl', 'degree', 'Note', 1, 12, 'scale degree (1 = root)'],
        ['grp', 'Unit'], ['sl', 'bars', 'Bars', 1, 16, 'loop length'], ['unitsync'],
        ['grp', 'Rhythm'], ['sl', 'density', 'Density', 1, 16, 'hits / bar'], ['tm', 'lengthMs', 'Length', 40, 2000, 10], ['cond'],
        ['grp', 'Variation'], ['sl', 'vary', 'Vary', 0, 100, 'root → roam'], ['sl', 'restProb', 'Rests', 0, 100, '%'], ['sl', 'accent', 'Accent', 0, 100, 'flat → dynamic'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
      // Drone: holds a note/chord, re-striking every `hold` units. Time + Pitch
      // vary are independent. A chord Notes source holds the whole chord.
      drone: { label: 'Drone', ctrls: [
        ['grp', 'Voice'], ['tone'], ['sl', 'attack', 'Attack', 0, 8000, 'ms'], ['sl', 'release', 'Release', 0, 12000, 'ms'],
        ['grp', 'Pitch'], ['notes'], ['sl', 'degree', 'Note', 1, 12, 'scale degree (1 = key root)'], ['sl', 'register', 'Register', 1, 6, 'octave'],
        ['grp', 'Unit'], ['rate'], ['tm', 'intervalMs', 'Unit', 200, 8000, 50], ['sl', 'hold', 'Hold', 1, 16, 'units held before re-strike'], ['unitsync'],
        ['grp', 'Rhythm'], ['cond'],
        ['grp', 'Variation'], ['sl', 'timeVary', 'Time vary', 0, 100, 'strike-timing wobble'], ['sl', 'pitchVary', 'Pitch vary', 0, 100, 'octave / degree drift'],
        ['grp', 'Mix'], ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['spread'], ['mod'], ['fx']] },
    };
    // Default-open groups; the rest start collapsed. Remembered per layer in
    // inst.groupsOpen ({ groupName: bool }); Reset clears it back to these.
    const _AMB_GROUP_DEFAULT_OPEN = { Voice: true, Unit: true, Mix: true };
    function _ambGroupOpen(inst, name) {
      const go = inst && inst.groupsOpen;
      if (go && typeof go === 'object' && typeof go[name] === 'boolean') return go[name];
      return !!_AMB_GROUP_DEFAULT_OPEN[name];
    }
    function _ambDefaultLayer(type, id) {
      const base = { id: id | 0, type: type, on: true, present: true, drift: 0, when: 'always', level: 70, panMode: 'spread', space: 0, mod: _ambDefaultMod(), ..._ambDefaultFx() };
      if (type === 'bed') return Object.assign(base, { tone: '', notes: { type: 'scale', scale: '' }, density: 4, register: 4, spread: 2, intervalMs: 4750, lengthMs: 6650, motion: 30, strum: 0, strumFidelity: 0 });
      if (type === 'motif') return Object.assign(base, { tone: '', notes: { type: 'scale', scale: '' }, register: 5, range: 2, proximity: 35, intervalMs: 1200, lengthMs: 1000, restProb: 30, twist: 0 });
      if (type === 'texture') return Object.assign(base, { tone: '', notes: { type: 'scale', scale: '' }, register: 6, fill: 35, intervalMs: 450, lengthMs: 300, mutateRate: 40 });
      if (type === 'beat') return Object.assign(base, { kit: 'tr808', gen: 'random', intervalMs: 500, lengthMs: 200, restProb: 25, bars: 1, pulses: 4, steps: 8, rotate: 0, rhythmVar: 0 });
      // Shape layer: one wheel to start; the user adds more via the card browser.
      // _shapeDefault() lives in 21-shape.js (loaded later) — safe to call here
      // because _ambDefaultLayer only runs at add/normalize time, not file eval.
      if (type === 'shape') return Object.assign(base, { shapes: (typeof _shapeDefault === 'function') ? [_shapeDefault()] : [], sel: 0 });
      // Arp: a series of scale/chord entries (each with its own pass count) that
      // the engine arpeggiates through. Voice via `tone`, timing via rate/interval.
      if (type === 'arp') return Object.assign(base, {
        tone: '', steps: [{ notes: { type: 'scale', scale: '' }, passes: 1, dir: 'up' }], sel: 0,
        dir: 'up', randomness: 0, rate: '', intervalMs: 250, octaves: 2, register: 4,
        lengthMs: 220, restProb: 0, accent: 0,
      });
      // Bass: low-octave euclidean phrase. Defaults to a 'bass' voice (falls
      // back via _ambLayerType if absent), a 2-bar seed phrase, and a sparse
      // 5-in-8 euclidean pulse — a simple groove out of the box. Variation
      // sliders start at 0 so the seed repeats verbatim until dialed up.
      if (type === 'bass') return Object.assign(base, {
        tone: 'bass', notes: { type: 'scale', scale: '' }, register: 2,
        bars: 2, pulses: 5, steps: 8, rotate: 0, lengthMs: 260, unitPadMs: 0,
        rhythmVar: 0, pitchVar: 0, proximity: 40, restProb: 0, accent: 0,
      });
      // Run: a fixed random note run that loops. 2-bar loop of 8th notes across
      // 2 octaves by default; Vary starts at 0 so it repeats verbatim until
      // dialed up. A light rest % keeps the run from being wall-to-wall.
      if (type === 'run') return Object.assign(base, {
        tone: '', notes: { type: 'scale', scale: '' }, register: 5, range: 2, transpose: 0,
        bars: 2, density: 8, lengthMs: 220, unitPadMs: 0, vary: 0, restProb: 10, accent: 20,
      });
      // Pedal: 1-bar loop of 4 quarter-note roots — a steady pedal point. Register
      // 4 (C4) + full volume matches a default Shape node so they sound the same.
      if (type === 'pedal') return Object.assign(base, {
        tone: '', notes: { type: 'scale', scale: '' }, register: 4,
        bars: 1, density: 4, lengthMs: 400, unitPadMs: 0, restProb: 0, accent: 0, vary: 0, degree: 1,
        attack: 5, decay: 40, sustain: 75, release: 200,
      });
      // Drone: holds the key root every 4 units (4×2s = 8s) with a soft 200ms
      // attack + 1.5s release. Pick a chord Notes source to hold a whole chord.
      if (type === 'drone') return Object.assign(base, {
        tone: '', notes: { type: 'scale', scale: '' }, register: 3, degree: 1,
        intervalMs: 2000, hold: 4, attack: 200, release: 1500,
        timeVary: 0, pitchVary: 0, accent: 0,
      });
      return base;
    }
    function _ambInstCardHtml(inst) {
      const type = inst.type, sch = _AMB_LAYER_SCHEMA[type]; if (!sch) return '';
      const lk = type + '-' + inst.id, p = 'ambient-' + lk, fkey = type + ':' + inst.id;
      // Every layer (Shape included) starts collapsed — just its header — so a
      // fresh Bloom panel stays compact and you expand only what you're tuning.
      const _collapsed = ' collapsed';
      let html = '<div class="ambient-layer' + _collapsed + '" data-inst="' + fkey + '">' + _ambHead(_ambLayerLabel(inst, sch.label), p + '-on', p + '-del', fkey);
      // Controls render into collapsible group sections (['grp', name] markers
      // in the schema open each one). If a schema has no markers, controls fall
      // into an implicit ungrouped bucket that's always shown.
      let grpOpen = false;        // is a group <div> currently open?
      const ctrlHtml = (c) => {
        const k = c[0];
        if (k === 'tone') return '<div class="ambient-ctrl"><label for="' + p + '-tone" title="' + _ambTitleAttr('Tone', 'voice') + '">Tone</label><select id="' + p + '-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>';
        if (k === 'kit') return '<div class="ambient-ctrl"><label for="' + p + '-kit" title="' + _ambTitleAttr('Kit', 'drums') + '">Kit</label><select id="' + p + '-kit" class="ambient-select"></select><span class="ambient-hint">drums</span></div>';
        if (k === 'gen') return _ambGenSel(p + '-');
        if (k === 'rate') return _ambRateSel(p + '-rate');
        if (k === 'notes') return _ambNotesButtonHtml(p);
        if (k === 'sl') return _ambSl(c[2], p + '-' + c[1], c[3], c[4], inst[c[1]], c[5]);
        if (k === 'tm') return _ambTm(c[2], p + '-' + c[1], c[3], c[4], c[5], inst[c[1]]);
        if (k === 'cond') return _ambCondCtrl(lk);
        if (k === 'spread') return _ambSpreadCtrl(p, inst);
        if (k === 'mod') return _ambModUi(lk);
        if (k === 'fx') return _ambFxUi(lk);
        if (k === 'shapes') return _ambShapeBrowserHtml(p, inst);
        if (k === 'arpseries') return _ambArpSeriesHtml(p, inst);
        if (k === 'arpdir') return _ambArpDirHtml(p, inst);
        if (k === 'unitmatch') return _ambUnitMatchHtml(p);
        if (k === 'unitsync') return _ambUnitSyncHtml(p);
        return '';
      };
      sch.ctrls.forEach(c => {
        if (c[0] === 'grp') {
          if (grpOpen) html += '</div></div>';   // close prior group body + wrapper
          const name = c[1], open = _ambGroupOpen(inst, name);
          html += '<div class="ambient-grp' + (open ? ' open' : '') + '" data-grp="' + name + '">' +
            '<button type="button" class="ambient-grp-head" data-grp="' + name + '">' + name +
            '<span class="ambient-grp-caret" aria-hidden="true"></span></button>' +
            '<div class="ambient-grp-body">';
          grpOpen = true;
        } else {
          html += ctrlHtml(c);
        }
      });
      if (grpOpen) html += '</div></div>';
      // Per-layer Reset — restores every group to its default fold state.
      html += '<div class="ambient-grp-resetwrap"><button type="button" class="ambient-grp-reset" id="' + p + '-grp-reset" title="Reset section folds to defaults">↺ Reset sections</button></div>';
      return html + '</div>';
    }
    // Arp Direction picker.
    function _ambArpDirHtml(p, inst) {
      const dirs = [['up', 'Up'], ['down', 'Down'], ['updown', 'Up-Down'], ['downup', 'Down-Up'], ['random', 'Random']];
      return '<div class="ambient-ctrl"><label for="' + p + '-dir">Direction</label>' +
        '<select id="' + p + '-dir" class="ambient-select">' +
        dirs.map(d => '<option value="' + d[0] + '">' + d[1] + '</option>').join('') +
        '</select><span class="ambient-hint">order</span></div>';
    }
    // Arp series browser: the ordered list of scale/chord entries + an Add button.
    // Rows (Notes button · passes stepper · delete) are filled by _ambRenderArpList.
    function _ambArpSeriesHtml(p, inst) {
      return '<div class="ambient-ctrl ambient-arp-series">' +
        '<div class="ambient-arp-serieshead"><label>Series</label>' +
          '<button type="button" class="ambient-arp-edit" id="' + p + '-arp-edit" title="Edit the notes of each chord in the series (add / remove / mute)">✎ Edit</button>' +
          '<button type="button" class="ambient-arp-add" id="' + p + '-arp-add" title="Add a scale / chord to the series">+ Add</button>' +
        '</div>' +
        '<div class="ambient-arp-list" id="' + p + '-arp-list"></div>' +
      '</div>';
    }
    // Mini shapes browser inside a Shape layer card: the list of wheels plus
    // add / edit controls. Rows are filled by _ambRenderShapeList on wire.
    function _ambShapeBrowserHtml(p, inst) {
      return '<div class="ambient-ctrl ambient-shape-browser">' +
        '<div class="ambient-shape-stage">' +
          '<canvas class="ambient-shape-overlay" id="' + p + '-overlay" title="All wheels in this layer, overlaid — click to edit the selected one"></canvas>' +
          // Expandable wheel list, overlaid in the canvas's upper-right corner.
          '<div class="ambient-shape-listwrap" id="' + p + '-listwrap">' +
            '<button type="button" class="ambient-shape-listtoggle" id="' + p + '-list-toggle" title="Show / hide the wheel list">≡ Shapes</button>' +
            '<div class="ambient-shape-list" id="' + p + '-shapes-list"></div>' +
          '</div>' +
          // Add / Edit — small buttons overlaid in the canvas's lower-left.
          '<div class="ambient-shape-btns">' +
            '<button type="button" class="ambient-shape-add" id="' + p + '-shape-add" title="Add a new wheel">+ Shape</button>' +
            '<button type="button" class="ambient-shape-editbtn" id="' + p + '-shape-edit" title="Edit the selected wheel in the Shape editor">✎ Edit</button>' +
            '<button type="button" class="ambient-shape-editbtn ambient-shape-toarp" id="' + p + '-shape-toarp" title="Convert this Shape layer into an Arp layer (keeps tone / level / FX)">→ Arp</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    function _ambWireInst(E, inst) {
      const type = inst.type, sch = _AMB_LAYER_SCHEMA[type]; if (!sch) return;
      const id = inst.id, p = 'ambient-' + type + '-' + id + '-';
      const get = () => { const c = E.getCfg(); return (c && Array.isArray(c.extras)) ? c.extras.find(x => x.id === id && x.type === type) : null; };
      const el = (suf) => _ambGet(E, p + suf);
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const sync = () => { if (E.timer) { try { _ambSyncMods(); } catch (x) {} } };
      const setVal = (suf, val) => { const e = el(suf); if (e && val != null) e.value = String(val); };
      // Wire on/off, delete, and collapse FIRST so a later control-wiring error
      // (e.g. the tone picker) can never leave the layer untoggleable.
      const onB = el('on'); if (onB) { onB.classList.toggle('on', !!inst.on); onB.addEventListener('click', () => { _E = E; const L = get(); if (!L) return; _ambToggleLayer(E, type + ':' + id, L, onB, persist); }); }
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteExtra(E, type, id));
      const layerDiv = onB ? onB.closest('.ambient-layer') : null;
      const cB = layerDiv ? layerDiv.querySelector('.ambient-collapse') : null;
      if (cB && layerDiv) cB.addEventListener('click', () => layerDiv.classList.toggle('collapsed'));
      // Collapsible parameter groups: header click folds/unfolds + remembers state.
      if (layerDiv) layerDiv.querySelectorAll('.ambient-grp-head').forEach(h => {
        h.addEventListener('click', () => {
          const name = h.getAttribute('data-grp'); if (!name) return;
          const grp = h.closest('.ambient-grp'); if (!grp) return;
          const nowOpen = !grp.classList.contains('open');
          grp.classList.toggle('open', nowOpen);
          const L = get(); if (L) { if (!L.groupsOpen || typeof L.groupsOpen !== 'object') L.groupsOpen = {}; L.groupsOpen[name] = nowOpen; persist(); }
        });
      });
      // Reset sections → forget remembered folds, re-render to default state.
      const rstB = el('grp-reset');
      if (rstB) rstB.addEventListener('click', () => { const L = get(); if (L) { delete L.groupsOpen; persist(); } _ambRenderExtras(E); });
      sch.ctrls.forEach(c => {
        const k = c[0];
        try {
          if (k === 'tone') { const s = el('tone'); if (s) { populateGroupedToneSelect(s, _ambToneOptions(), _ambGridVoiceOption()); s.value = inst.tone || ''; s.addEventListener('change', () => { const L = get(); if (L) { L.tone = s.value || ''; persist(); } }); } }
          else if (k === 'kit') { const s = el('kit'); if (s) { _ambDrumKits().forEach(kk => { const o = document.createElement('option'); o.value = kk.id; o.textContent = kk.name; s.appendChild(o); }); s.value = inst.kit || 'tr808'; s.addEventListener('change', () => { const L = get(); if (L) { L.kit = s.value || 'tr808'; persist(); } }); } }
          else if (k === 'rate') { const s = el('rate'); if (s) { s.value = inst.rate || ''; s.addEventListener('change', () => { const L = get(); if (L) { L.rate = s.value || ''; _ambUnitSyncViz(E, p, L); sync(); persist(); } }); } }
          else if (k === 'unitmatch') { _ambWireUnitMatch(E, inst, p, get); }
          else if (k === 'unitsync') { _ambWireUnitSync(E, p, get, type + ':' + id); }
          else if (k === 'notes') { _ambWireNotesBtn(E, p + 'notes', get); }
          else if (k === 'sl') { const e = el(c[1]); if (e) e.addEventListener('input', () => { const L = get(); if (L) { L[c[1]] = parseInt(e.value, 10) || 0; sync(); persist(); } }); }
          else if (k === 'tm') { const e = el(c[1]), v = el(c[1] + '-v'); if (e) { if (v) v.textContent = _ambFmtMs(inst[c[1]]); e.addEventListener('input', () => { const L = get(); if (L) { const val = parseInt(e.value, 10) || 0; L[c[1]] = val; if (v) v.textContent = _ambFmtMs(val); sync(); persist(); } }); } }
          else if (k === 'cond') { _ambBindWhen(E, p, get, persist); }
          else if (k === 'spread') { _ambWireSpread(E, 'ambient-' + type + '-' + id, get, persist, sync); }
          else if (k === 'shapes') { _ambWireShapeBrowser(E, inst, p, get); }
          else if (k === 'arpseries') { _ambWireArpSeries(E, inst, p, get); }
          else if (k === 'arpdir') { const s = el('dir'); if (s) { s.value = inst.dir || 'up'; s.addEventListener('change', () => { const L = get(); if (L) { L.dir = s.value || 'up'; _ambResetArp(E, type + ':' + id); sync(); persist(); } }); } }
          else if (k === 'gen') { const s = el('gen'); if (s) { s.value = inst.gen || 'random'; s.addEventListener('change', () => { const L = get(); if (L) { L.gen = s.value || 'random'; _ambBeatGenVis(E, p, L, p); const gk = type + ':' + id; if (E.runPhase) delete E.runPhase[gk]; if (E.clocks) delete E.clocks[gk]; sync(); persist(); } }); } }
        } catch (err) { console.warn('Bloom extra control wiring failed', type, id, k, err); }
      });
      ['vca', 'vco', 'vcf'].forEach(t => {
        ['depth', 'rate'].forEach(kk => { const e = el('mod-' + t + '-' + kk); if (e) e.addEventListener('input', () => { const L = get(); if (!L) return; L.mod[t][kk] = parseInt(e.value, 10) || 0; sync(); persist(); }); });
        _ambWireModTarget(E, el, get, t, sync);
      });
      const bindFx = (suf, setter) => { const e = el('fx-' + suf); if (!e) return; const v = el('fx-' + suf + '-v'); e.addEventListener('input', () => { const L = get(); if (!L) return; const val = parseInt(e.value, 10) || 0; setter(L, val); if (v) v.textContent = _ambFmtMs(val); sync(); persist(); }); };
      bindFx('rev', (q, v) => { q.revSend = v; }); bindFx('dly-mix', (q, v) => { q.delay.mix = v; }); bindFx('dly-time', (q, v) => { q.delay.timeMs = v; }); bindFx('dly-fb', (q, v) => { q.delay.feedback = v; }); bindFx('dist-amt', (q, v) => { q.dist.amount = v; }); bindFx('dist-mix', (q, v) => { q.dist.mix = v; });
      ['vca', 'vco', 'vcf'].forEach(t => { if (inst.mod && inst.mod[t]) { setVal('mod-' + t + '-depth', inst.mod[t].depth); setVal('mod-' + t + '-rate', inst.mod[t].rate); _ambSyncModShapeEl(el, inst.mod[t], t); } });
      setVal('fx-rev', inst.revSend);
      if (inst.delay) { setVal('fx-dly-mix', inst.delay.mix); setVal('fx-dly-time', inst.delay.timeMs); const dt = el('fx-dly-time-v'); if (dt) dt.textContent = _ambFmtMs(inst.delay.timeMs); setVal('fx-dly-fb', inst.delay.feedback); }
      if (inst.dist) { setVal('fx-dist-amt', inst.dist.amount); setVal('fx-dist-mix', inst.dist.mix); }
      try { _ambUnitSyncViz(E, p, inst); } catch (e) {}   // hide free Interval when BPM-synced
      if (type === 'beat') { try { _ambBeatGenVis(E, p, inst, p); } catch (e) {} }   // Gen mode rows (after UnitSyncViz so euclid can hide Interval)
    }
    // ---- Arp layer: scale/chord series browser -----------------------------
    // Clear an Arp layer's playback cursor so a series/direction/passes edit
    // restarts cleanly from the first entry on the next tick.
    function _ambResetArp(E, key) {
      const eng = E || _E;
      if (eng && eng.arpState) delete eng.arpState[key];
    }
    // Make a chord object editable: ensure it carries a raw `intervals` array
    // (converting a form-based chord) + a `muted` list, so add/remove/mute work.
    function _ambChordEditable(o) {
      if (!o || typeof o !== 'object') return o;
      if (!Array.isArray(o.intervals) || !o.intervals.length) {
        o.intervals = (typeof _ambChordIntervals === 'function' && o.form) ? _ambChordIntervals(o.form, o.inversion).slice() : [0, 4, 7];
      }
      if (!Array.isArray(o.muted)) o.muted = [];
      return o;
    }
    // Cycle one semitone (relative to the chord root) absent → present → muted →
    // absent. `iv` is semitones above the root (0..23 = two octaves).
    function _ambChordCellCycle(o, iv) {
      _ambChordEditable(o);
      const inI = o.intervals.indexOf(iv), inM = o.muted.indexOf(iv);
      if (inI < 0) { o.intervals.push(iv); o.intervals.sort((a, b) => a - b); }   // add
      else if (inM < 0) { o.muted.push(iv); }                                      // mute
      else { o.intervals.splice(inI, 1); o.muted.splice(o.muted.indexOf(iv), 1); } // remove
    }
    // The editable chord object(s) of one series entry: a chord entry → [chord];
    // a progression entry → its chords[]; scale/wrap → null (not note-editable).
    function _ambArpEntryChords(entry) {
      const n = entry && entry.notes;
      if (!n || typeof n !== 'object') return null;
      if (n.type === 'chord') return [n];
      if (n.type === 'prog' && Array.isArray(n.chords) && n.chords.length) return n.chords;
      return null;
    }
    // Popover: edit the NOTES of every chord across the Arp series (add / remove /
    // mute each note). Two octaves of semitone cells per chord, relative to root.
    function _ambShowArpChordEditor(E, getL) {
      const L0 = getL(); if (!L0) return;
      const names = (typeof CHROMATIC !== 'undefined' && CHROMATIC.length === 12) ? CHROMATIC : ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
      const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, '');
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const modal = document.createElement('div'); modal.className = 'step-div-modal amb-chordedit-modal';
      overlay.appendChild(modal);
      const close = () => { try { overlay.remove(); } catch (e) {} };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      // Display intervals/muted WITHOUT mutating a form-based chord — conversion to
      // a custom chord happens only on an actual edit (in _ambChordCellCycle).
      const dispOf = (o) => ({
        iv: (Array.isArray(o.intervals) && o.intervals.length) ? o.intervals
          : ((o.form && typeof _ambChordIntervals === 'function') ? _ambChordIntervals(o.form, o.inversion) : [0, 4, 7]),
        m: Array.isArray(o.muted) ? o.muted : [],
      });
      const cellHtml = (disp, iv, rootPc) => {
        const inI = disp.iv.indexOf(iv) >= 0, inM = disp.m.indexOf(iv) >= 0;
        const cls = inI ? (inM ? 'muted' : 'on') : 'off';
        const nm = names[((rootPc + iv) % 12 + 12) % 12];
        const oct = iv >= 12 ? '′' : '';
        return '<button type="button" class="amb-ce-cell ' + cls + '" data-iv="' + iv + '">' + esc(nm) + oct + '</button>';
      };
      const render = () => {
        const L = getL(); if (!L) { close(); return; }
        const steps = Array.isArray(L.steps) ? L.steps : [];
        let h = '<div class="keep-sdiv-title">Edit chord notes</div>' +
          '<div class="amb-ce-hint">Tap a note: add → mute → remove. Notes are relative to each chord\'s root.</div>' +
          '<div class="amb-ce-list">';
        steps.forEach((entry, ei) => {
          const chords = _ambArpEntryChords(entry);
          h += '<div class="amb-ce-entry"><div class="amb-ce-elabel">' + (ei + 1) + '. ' + esc(_ambNotesLabel(_ambNotesOf(entry))) + '</div>';
          if (!chords) { h += '<div class="amb-ce-na">Set this row to a Chord or Progression to edit its notes.</div></div>'; return; }
          chords.forEach((o, ci) => {
            const disp = dispOf(o);
            const rootPc = ((o.root | 0) % 12 + 12) % 12;
            h += '<div class="amb-ce-chord" data-ei="' + ei + '" data-ci="' + ci + '">';
            if (chords.length > 1) h += '<span class="amb-ce-croot">' + esc(names[rootPc]) + '</span>';
            h += '<div class="amb-ce-grid">';
            for (let iv = 0; iv < 12; iv++) h += cellHtml(disp, iv, rootPc);
            h += '</div><div class="amb-ce-grid">';
            for (let iv = 12; iv < 24; iv++) h += cellHtml(disp, iv, rootPc);
            h += '</div></div>';
          });
          h += '</div>';
        });
        h += '</div><div class="sm-footer"><button type="button" class="sm-apply amb-ce-ok">Done</button></div>';
        modal.innerHTML = h;
        modal.querySelectorAll('.amb-ce-cell').forEach(btn => btn.addEventListener('click', () => {
          const chordEl = btn.closest('.amb-ce-chord'); if (!chordEl) return;
          const ei = chordEl.getAttribute('data-ei') | 0, ci = chordEl.getAttribute('data-ci') | 0;
          const L2 = getL(); if (!L2 || !L2.steps || !L2.steps[ei]) return;
          const chords = _ambArpEntryChords(L2.steps[ei]); if (!chords || !chords[ci]) return;
          _ambChordCellCycle(chords[ci], (btn.getAttribute('data-iv') | 0));
          _ambResetArp(E, L2.type + ':' + L2.id);
          persist();
          render();
        }));
        const ok = modal.querySelector('.amb-ce-ok'); if (ok) ok.addEventListener('click', () => { close(); try { _ambRenderArpList(E, getL, 'ambient-' + L.type + '-' + L.id + '-'); } catch (e) {} });
      };
      render();
      document.body.appendChild(overlay);
    }
    function _ambWireArpSeries(E, inst, p, get) {
      const edB = _ambGet(E, p + 'arp-edit');
      if (edB && !edB._ambBound) { edB._ambBound = true; edB.addEventListener('click', () => { try { _ambShowArpChordEditor(E, get); } catch (e) { console.warn('Arp chord editor failed', e); } }); }
      const addB = _ambGet(E, p + 'arp-add');
      if (addB && !addB._ambBound) {
        addB._ambBound = true;
        addB.addEventListener('click', () => {
          const L = get(); if (!L) return;
          if (!Array.isArray(L.steps)) L.steps = [];
          const src = L.steps[L.sel | 0];
          const notes = (src && src.notes) ? JSON.parse(JSON.stringify(src.notes)) : { type: 'scale', scale: '' };
          L.steps.push({ notes, passes: (src && src.passes) || 1, dir: (src && src.dir) || L.dir || 'up', unit: (src && src.unit) || 'passes', count: (src && src.count) || 0 });
          L.sel = L.steps.length - 1;
          _ambRenderArpList(E, get, p);
          _ambResetArp(E, L.type + ':' + L.id);
          if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      }
      _ambRenderArpList(E, get, p);
    }
    function _ambRenderArpList(E, get, p) {
      const list = _ambGet(E, p + 'arp-list'); if (!list) return;
      const L = get(); if (!L) return;
      const steps = Array.isArray(L.steps) ? L.steps : (L.steps = []);
      if (L.sel == null || L.sel < 0 || L.sel >= steps.length) L.sel = steps.length ? 0 : -1;
      const key = L.type + ':' + L.id;
      list.innerHTML = '';
      steps.forEach((st, i) => {
        const row = document.createElement('div');
        row.className = 'ambient-arp-row' + (i === L.sel ? ' sel' : '');
        const idx = document.createElement('span'); idx.className = 'ambient-arp-idx'; idx.textContent = (i + 1) + '.';
        // Notes button — reuses the shared Scale/Chord/Wrap/Prog menu, targeting
        // this entry (getLayer returns the entry, whose `.notes` the menu sets).
        const nb = document.createElement('button');
        nb.type = 'button'; nb.className = 'ambient-select ambient-notes-btn ambient-arp-notes';
        nb.textContent = _ambNotesLabel(_ambNotesOf(st));
        nb.addEventListener('click', () => {
          const r = nb.getBoundingClientRect();   // capture BEFORE re-render detaches this button
          L.sel = i; _ambRenderArpList(E, get, p);
          _ambOpenNotesMenu(E, () => st, r.left, r.bottom + 4, () => {
            _ambRenderArpList(E, get, p);   // rebuild so the new scale/chord label shows immediately
            _ambResetArp(E, key);
          });
        });
        // Per-entry Direction — each series row sweeps in its own order.
        const ds = document.createElement('select'); ds.className = 'ambient-select ambient-arp-dir';
        [['up', 'Up'], ['down', 'Down'], ['updown', 'Up-Dn'], ['downup', 'Dn-Up'], ['random', 'Rand']].forEach(d => {
          const o = document.createElement('option'); o.value = d[0]; o.textContent = d[1]; ds.appendChild(o);
        });
        ds.value = st.dir || 'up';
        ds.addEventListener('change', () => { st.dir = ds.value || 'up'; _ambResetArp(E, key); if (typeof persistWorkspace === 'function') persistWorkspace(); });
        // Per-entry count: a −/+ stepper plus a visible UNIT TOGGLE — × (whole
        // passes before advancing) vs ♪ (an exact note count that wraps the pool).
        // The lit segment is the active unit; −/+ adjust whichever is active.
        const pw = document.createElement('span'); pw.className = 'ambient-arp-passes';
        const dec = document.createElement('button'); dec.type = 'button'; dec.className = 'ambient-arp-pbtn'; dec.textContent = '−';
        const pv = document.createElement('span'); pv.className = 'ambient-arp-pval';
        const inc = document.createElement('button'); inc.type = 'button'; inc.className = 'ambient-arp-pbtn'; inc.textContent = '+';
        pw.appendChild(dec); pw.appendChild(pv); pw.appendChild(inc);
        const ut = document.createElement('span'); ut.className = 'ambient-arp-unit';
        const segP = document.createElement('button'); segP.type = 'button'; segP.className = 'ambient-arp-useg'; segP.textContent = '×'; segP.title = 'Whole passes';
        const segN = document.createElement('button'); segN.type = 'button'; segN.className = 'ambient-arp-useg'; segN.textContent = '♪'; segN.title = 'Exact note count';
        ut.appendChild(segP); ut.appendChild(segN);
        const persistReset = () => { _ambResetArp(E, key); if (typeof persistWorkspace === 'function') persistWorkspace(); };
        const poolLen = () => Math.max(1, _ambScaleIntervals(_ambNotesOf(st)).length) * Math.max(1, Math.min(4, (L.octaves | 0) || 2));
        const isNotes = () => st.unit === 'notes';
        const renderStep = () => {
          const notes = isNotes();
          pv.textContent = notes ? (Math.max(1, st.count | 0) + '♪') : ((st.passes || 1) + '×');
          dec.title = notes ? 'Fewer notes' : 'Fewer passes';
          inc.title = notes ? 'More notes' : 'More passes';
          segP.classList.toggle('on', !notes); segN.classList.toggle('on', notes);
        };
        const setStep = (d) => {
          if (isNotes()) st.count = Math.max(1, Math.min(64, (st.count || 1) + d));
          else st.passes = Math.max(1, Math.min(16, (st.passes || 1) + d));
          renderStep(); persistReset();
        };
        dec.addEventListener('click', () => setStep(-1));
        inc.addEventListener('click', () => setStep(1));
        segP.addEventListener('click', () => { if (isNotes()) { st.unit = 'passes'; renderStep(); persistReset(); } });
        segN.addEventListener('click', () => { if (!isNotes()) { if (!((st.count | 0) > 0)) st.count = _ambArpPassLen(st.dir || L.dir || 'up', poolLen()) * Math.max(1, (st.passes | 0) || 1); st.unit = 'notes'; renderStep(); persistReset(); } });
        renderStep();
        // Delete (keep ≥1 entry).
        const del = document.createElement('button'); del.type = 'button'; del.className = 'ambient-arp-del'; del.textContent = '✕'; del.title = 'Remove this entry';
        del.addEventListener('click', () => {
          if (steps.length <= 1) return;
          steps.splice(i, 1);
          if (L.sel >= steps.length) L.sel = steps.length - 1;
          _ambRenderArpList(E, get, p);
          _ambResetArp(E, key);
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
        row.appendChild(idx); row.appendChild(nb); row.appendChild(ds); row.appendChild(pw); row.appendChild(ut); row.appendChild(del);
        list.appendChild(row);
      });
    }
    // ---- Shape layer: N-wheel browser + editor reuse -----------------------
    // Tracks which Bloom shape (if any) currently owns the single #shape-pad
    // editor. Shared by name with 21-shape.js so master-edit can evict it.
    let _ambShapeEditRef = null;
    // Live in-card overview: ONE canvas per Shape layer with all its wheels
    // overlaid concentrically (auto-sized so every node fits). A single rAF
    // redraws the visible ones, advancing each wheel's own bar phase while the
    // engine plays and flashing nodes as the playhead crosses them.
    const _ambShapeCanvases = new Set();
    let _ambShapeRaf = 0, _ambShapeIO = null;
    // Draw one overlay canvas's wheels a single time (static frame).
    function _ambShapeDrawOne(cv) {
      if (!cv || !cv.isConnected) return;
      const m = cv._ambShape; if (!m) return;
      try {
        if (typeof _shapeRenderOverlay === 'function') {
          _shapeRenderOverlay(cv, m.inst.shapes, { phaseOf: (i) => _ambShapePhaseOf(cv, i), selIdx: m.inst.sel });
        }
      } catch (e) {}
    }
    // Event-driven draw-when-visible: an IntersectionObserver paints each wheel
    // ONCE when it scrolls/toggles into view (covers the Mix sub-view becoming
    // active, the layer expanding, the page scrolling) — no perpetual idle
    // redraw loop, which on a hardware GPU re-uploads the canvas every tick and
    // makes the wheel visibly "dissolve" in instead of appearing at once.
    function _ambShapeIOEnsure() {
      if (_ambShapeIO || typeof IntersectionObserver === 'undefined') return;
      _ambShapeIO = new IntersectionObserver((entries) => {
        entries.forEach(e => { if (e.isIntersecting) _ambShapeDrawOne(e.target); });
      }, { threshold: 0.01 });
    }
    function _ambShapeObserve(cv) { _ambShapeIOEnsure(); if (_ambShapeIO) { try { _ambShapeIO.observe(cv); } catch (e) {} } }
    // Paint the current static frame now, and start the continuous rAF loop ONLY
    // if some engine is playing (moving playheads). Called on render, on shape
    // edits, and on play/stop.
    function _ambShapeAnimEnsure() {
      // While the full Shape editor is open it covers the layer cards, so there's
      // no point redrawing their in-card wheels — skip them (cuts per-frame work
      // and compositing behind the overlay). Resumed on editor close.
      if (_ambShapeEditRef) return;
      let anyPlaying = false;
      _ambShapeCanvases.forEach(cv => {
        if (!cv.isConnected) { _ambShapeCanvases.delete(cv); return; }
        if (cv._ambShape && cv._ambShape.engine && cv._ambShape.engine.timer) anyPlaying = true;
        if (cv.offsetParent || cv.clientWidth > 0) _ambShapeDrawOne(cv);
      });
      if (anyPlaying && !_ambShapeRaf) _ambShapeRaf = requestAnimationFrame(_ambShapeAnimTick);
    }
    // Per-shape current phase for one layer canvas; also flashes crossed nodes.
    function _ambShapePhaseOf(cv, i) {
      const m = cv._ambShape; if (!m) return 0;
      const E = m.engine, sh = m.inst.shapes[i];
      if (!sh || !Array.isArray(sh.nodes)) return 0;
      const revSec = (typeof _shapeBarSec === 'function') ? _shapeBarSec(sh) : 0;
      const st = (E && E.shapePhase) ? E.shapePhase[m.key + '#' + i] : null;
      if (!(E && E.timer && st && st.startAt != null && revSec > 0 && typeof Tone !== 'undefined' && Tone.now)) return 0;
      const ph = ((((Tone.now() - st.startAt) / revSec) % 1) + 1) % 1;
      if (!cv._ambPrev) cv._ambPrev = [];
      const prev = cv._ambPrev[i];
      if (typeof prev === 'number') {
        const rot = (sh.rotationDeg || 0) / 360;
        sh.nodes.forEach(nd => {
          if (nd.muted) return;
          const a = (((nd.angleFrac + rot) % 1) + 1) % 1;
          const crossed = (prev <= ph) ? (a > prev && a <= ph) : (a > prev || a <= ph);
          if (crossed) nd._flash = performance.now();
        });
      }
      cv._ambPrev[i] = ph;
      return ph;
    }
    // Continuous redraw — runs ONLY while an engine is playing, to animate the
    // moving playheads / node flashes. When nothing is playing the loop stops and
    // the wheel is left as a single static frame (drawn by _ambShapeDrawOne via
    // the IntersectionObserver / _ambShapeAnimEnsure) — no idle GPU churn.
    function _ambShapeAnimTick() {
      _ambShapeRaf = 0;
      if (_ambShapeEditRef) return;   // editor open & covering the cards — stop redrawing them
      let anyPlaying = false;
      _ambShapeCanvases.forEach(cv => {
        if (!cv.isConnected) { _ambShapeCanvases.delete(cv); return; }
        if (!cv.offsetParent && !(cv.clientWidth > 0)) return;   // not visible — skip
        if (cv._ambShape && cv._ambShape.engine && cv._ambShape.engine.timer) anyPlaying = true;
        _ambShapeDrawOne(cv);
      });
      if (anyPlaying) _ambShapeRaf = requestAnimationFrame(_ambShapeAnimTick);
    }
    function _ambRenderShapeList(E, inst, p) {
      const list = _ambGet(E, p + 'shapes-list'); if (!list) return;
      _ambShapeCanvases.forEach(cv => { if (!cv.isConnected) _ambShapeCanvases.delete(cv); });
      const shapes = Array.isArray(inst.shapes) ? inst.shapes : (inst.shapes = []);
      if (inst.sel == null || inst.sel < 0 || inst.sel >= shapes.length) inst.sel = shapes.length ? 0 : -1;
      const key = inst.type + ':' + inst.id;
      // Overlay canvas — all wheels concentric; click opens the selected one.
      const ov = _ambGet(E, p + 'overlay');
      if (ov) {
        ov._ambShape = { engine: E, inst, key };
        if (!ov._ambBound) {
          ov._ambBound = true;
          ov.addEventListener('click', (e) => { e.stopPropagation(); if (inst.shapes && inst.shapes.length) _ambShapeEditOpen(E, inst); });
        }
        _ambShapeCanvases.add(ov);
        _ambShapeObserve(ov);   // paint once when it scrolls/toggles into view
        // Draw now (immediate) AND again after layout settles, so the wheel is
        // there at first paint at the correct size — not progressively resolved.
        _ambShapeDrawOne(ov);
        requestAnimationFrame(() => requestAnimationFrame(() => _ambShapeDrawOne(ov)));
      }
      // Rows: colour swatch (matches the overlay ring) + name + edit + delete.
      list.innerHTML = '';
      shapes.forEach((sh, i) => {
        const row = document.createElement('div');
        row.className = 'ambient-shape-row' + (i === inst.sel ? ' sel' : '');
        const sw = document.createElement('span'); sw.className = 'ambient-shape-swatch';
        try { sw.style.background = (typeof _shapeOverlayColor === 'function') ? _shapeOverlayColor(i) : '#4fd1c5'; } catch (e) {}
        const nc = (sh && Array.isArray(sh.nodes) && sh.nodes.length) || (sh && sh.nodeCount) || 0;
        const pick = document.createElement('button');
        pick.type = 'button'; pick.className = 'ambient-shape-pick';
        pick.textContent = 'Wheel ' + (i + 1) + ' · ' + nc + ' node' + (nc === 1 ? '' : 's');
        pick.addEventListener('click', () => { inst.sel = i; _ambRenderShapeList(E, inst, p); if (typeof persistWorkspace === 'function') persistWorkspace(); });
        const ed = document.createElement('button');
        ed.type = 'button'; ed.className = 'ambient-shape-editrow'; ed.textContent = '✎'; ed.title = 'Edit this wheel';
        ed.addEventListener('click', (e) => { e.stopPropagation(); inst.sel = i; _ambShapeEditOpen(E, inst); });
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'ambient-shape-del'; del.textContent = '✕'; del.title = 'Remove this wheel';
        del.addEventListener('click', (e) => { e.stopPropagation(); _ambShapeRemove(E, inst, i, p); });
        row.appendChild(sw); row.appendChild(pick); row.appendChild(ed); row.appendChild(del);
        list.appendChild(row);
      });
      const tg = _ambGet(E, p + 'list-toggle');
      if (tg) tg.textContent = '≡ Shapes (' + shapes.length + ')';
      _ambShapeAnimEnsure();
    }
    function _ambWireShapeBrowser(E, inst, p, get) {
      _ambRenderShapeList(E, inst, p);
      const addB = _ambGet(E, p + 'shape-add');
      if (addB) addB.addEventListener('click', () => _ambShapeAdd(E, get() || inst, p));
      const edB = _ambGet(E, p + 'shape-edit');
      if (edB) edB.addEventListener('click', () => _ambShapeEditOpen(E, get() || inst));
      const arpB = _ambGet(E, p + 'shape-toarp');
      if (arpB) arpB.addEventListener('click', () => {
        const ok = (typeof confirm !== 'function') || confirm('Convert this Shape layer to an Arp layer? Its wheels are replaced by an Arp series (tone, level, pan, mod & FX are kept).');
        if (ok) _ambConvertShapeToArp(E, get() || inst);
      });
      // Expandable overlaid list — toggle its open state.
      const tg = _ambGet(E, p + 'list-toggle');
      const wrap = _ambGet(E, p + 'listwrap');
      if (tg && wrap) tg.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.toggle('open'); });
    }
    function _ambShapeAdd(E, inst, p) {
      if (!inst || typeof _shapeDefault !== 'function') return;
      if (!Array.isArray(inst.shapes)) inst.shapes = [];
      inst.shapes.push(_shapeDefault());
      inst.sel = inst.shapes.length - 1;
      _ambRenderShapeList(E, inst, p);
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Convert a Shape layer in place into an Arp layer (same slot/id). The wheels
    // are dropped (Shape and Arp have no shared pitch model), but the shared sonic
    // attributes carry over so the layer keeps its place in the mix.
    function _ambConvertShapeToArp(E, inst) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.extras) || !inst) return;
      const idx = cfg.extras.findIndex(x => x && x.id === inst.id && x.type === inst.type);
      if (idx < 0) return;
      const old = cfg.extras[idx];
      const oldKey = old.type + ':' + old.id;
      // Close the wheel editor if it's open on this layer (frees #shape-pad).
      try { if (_ambShapeEditRef && _ambShapeEditRef.id === old.id && _ambShapeEditRef.type === old.type) _ambShapeEditClose(); } catch (e) {}
      // New Arp in the same slot, carrying the shared attributes that exist.
      const arp = _ambDefaultLayer('arp', old.id);
      ['on', 'present', 'level', 'accent', 'panMode', 'space', 'when', 'drift', 'tone'].forEach(k => { if (old[k] !== undefined) arp[k] = old[k]; });
      try { if (old.mod) arp.mod = JSON.parse(JSON.stringify(old.mod)); } catch (e) {}
      try { if (old.delay) arp.delay = JSON.parse(JSON.stringify(old.delay)); } catch (e) {}
      try { if (old.dist) arp.dist = JSON.parse(JSON.stringify(old.dist)); } catch (e) {}
      cfg.extras[idx] = arp;
      // Tear down the old shape's mod chain + phase state (keyed by 'shape:id').
      try { if (E.mod && E.mod[oldKey]) _ambTeardownMod(oldKey); } catch (e) {}
      if (E.shapePhase) { const pre = oldKey + '#'; Object.keys(E.shapePhase).forEach(kk => { if (kk.indexOf(pre) === 0) delete E.shapePhase[kk]; }); }
      _ambRenderExtras(E);
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
      if (typeof showToast === 'function') showToast('Converted Shape → Arp.');
    }
    // ---- Shape It: every Bloom layer → a master Shapes wheel ---------------
    // Convert a Seq layer's first unit (events {freqs,durMs,…}) into the step
    // shape _shapeSeqToShape expects ({freq|chord, duration, subdivision}).
    function _ambSeqUnitToSteps(unit) {
      const evs = (unit && Array.isArray(unit.events)) ? unit.events : [];
      const bpm = (typeof Tone !== 'undefined' && Tone.Transport && Tone.Transport.bpm) ? (Tone.Transport.bpm.value || 120) : 120;
      const spb = 60 / (bpm || 120);   // seconds per beat
      return evs.map(ev => {
        const beats = Math.max(0.05, (Math.max(20, ev.durMs | 0) / 1000) / spb);
        const fs = Array.isArray(ev.freqs) ? ev.freqs.filter(f => f != null) : [];
        const step = { duration: beats, subdivision: 1 };
        if (!fs.length) return step;                                  // rest (keeps timing)
        if (fs.length === 1) { step.freq = fs[0]; return step; }
        step.chord = fs.map(f => ({ freq: f }));                      // chord event
        return step;
      });
    }
    // Build a master-Shapes wheel from one Bloom layer. Shape layers donate their
    // selected wheel verbatim; Seq layers distill their first unit; the algorithmic
    // layers (bed/motif/texture/beat/arp/bass/run/pedal) become an evenly-spaced
    // wheel whose node count / loop length / register / voice mirror the layer —
    // a faithful starting point the user can then edit.
    // Snapshot a layer's voice characteristics into a shape soundParams object so
    // each overlaid shape SOUNDS like the layer it came from: instrument (tone),
    // level → volume, pan, and any explicit ADSR (Pedal). Generative FX/LFOs live
    // on the per-layer routing chain and can't ride a static wheel, so they're not
    // carried — the audible voice is.
    function _ambLayerSoundParams(L) {
      const sp = { type: _ambLayerType(L.tone) };
      if (Number.isFinite(L.level)) sp.volume = Math.max(2, Math.min(100, L.level | 0));
      if (L.panMode === 'pan' && Number.isFinite(L.space)) sp.pan = Math.max(-100, Math.min(100, L.space | 0));
      if (Number.isFinite(L.attack))  sp.attack  = L.attack;
      if (Number.isFinite(L.decay))   sp.decay   = L.decay;
      if (Number.isFinite(L.sustain)) sp.sustain = L.sustain;
      if (Number.isFinite(L.release)) sp.release = L.release;
      return sp;
    }
    // How long ONE loop of a layer is, in seconds — the window we bake into a
    // wheel. Bar-based layers use their bar count; Seq uses its unit length;
    // free-running layers (bed/motif/texture/beat/arp) use a few bars so several
    // events land in the loop.
    function _ambLayerLoopSec(L, type) {
      const bpm = (typeof Tone !== 'undefined' && Tone.Transport && Tone.Transport.bpm) ? (Tone.Transport.bpm.value || 120) : 120;
      const barSec = (60 / bpm) * 4;
      if (L && Number.isFinite(L.bars) && L.bars > 0) return Math.max(0.5, L.bars * barSec);
      if (type === 'seq') {
        const u = (L && Array.isArray(L.units) && L.units[0]) ? L.units[0] : null;
        const ms = (u && typeof _unitTotalMs === 'function') ? _unitTotalMs(u) : 0;
        if (ms > 0) return ms / 1000;
      }
      return barSec * 4;
    }
    // FAITHFUL conversion: bake a layer's REAL emitted notes (rolling-captured as
    // {at, freq, dur(ms), params} while the Bloom plays) into a wheel. Each note
    // becomes a node carrying its exact pitch offset, hold length, and full voice
    // params (envelope/volume/pan), so the wheel sounds like the layer note-for-
    // note. Simultaneous notes (a pad chord) become stacked nodes at one angle.
    function _ambCapToShape(events, windowSec) {
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const freqToMidi = (f) => Math.round(69 + 12 * Math.log2((f > 0 ? f : A) / A));
      const arr = (events || []).filter(e => e && typeof e.freq === 'number' && typeof e.at === 'number');
      if (!arr.length || !(windowSec > 0)) return null;
      // Most recent windowSec, ending just after the last captured onset so the
      // loop boundary lands on real notes (not mid-silence).
      const tEnd = arr[arr.length - 1].at + 1e-6;
      const t0 = tEnd - windowSec;
      const win = arr.filter(e => e.at >= t0 - 1e-6 && e.at < tEnd);
      if (!win.length) return null;
      const baseMidi = freqToMidi(Math.min.apply(null, win.map(e => e.freq)));
      const bpm = (typeof Tone !== 'undefined' && Tone.Transport && Tone.Transport.bpm) ? (Tone.Transport.bpm.value || 120) : 120;
      const nodes = win.map(e => {
        const af = (((e.at - t0) / windowSec) % 1 + 1) % 1;
        const durSec = Math.max(0.02, (e.dur || 0) / 1000);
        const sus = Math.max(0.005, Math.min(0.999, durSec / windowSec));
        const ov = { noteOffset: freqToMidi(e.freq) - baseMidi };
        if (e.params && e.params.type) ov.params = Object.assign({}, e.params);
        return { angleFrac: af, muted: false, sustainFrac: sus, override: ov };
      }).sort((a, b) => a.angleFrac - b.angleFrac);
      const sh = (typeof _shapeDefault === 'function') ? _shapeDefault() : null;
      if (!sh) return null;
      sh.timingMode = 'free';                         // notes sit at captured angles
      sh.loopBeats = Math.max(0.25, windowSec * (bpm / 60));
      sh.baseNote = baseMidi;
      const fp = win.find(e => e.params && e.params.type);
      if (fp) sh.tone = fp.params.type;               // shape-level fallback voice
      sh.nodes = nodes; sh.nodeCount = nodes.length;
      return sh;
    }
    function _ambLayerToShape(E, L, type, key) {
      if (!L) return null;
      // Shape layer → its authored wheel verbatim (already a perfect shape).
      if (type === 'shape') {
        const ws = Array.isArray(L.shapes) ? L.shapes : [];
        if (ws.length) {
          const w = ws[Math.max(0, Math.min(L.sel | 0, ws.length - 1))];
          if (w) return (typeof _shapeNormalize === 'function') ? _shapeNormalize(JSON.parse(JSON.stringify(w))) : JSON.parse(JSON.stringify(w));
        }
      }
      // Faithful path: bake the layer's real captured output if it has played.
      try {
        const ev = E && E.cap && key && E.cap[key];
        if (Array.isArray(ev) && ev.length) {
          const sh = _ambCapToShape(ev, _ambLayerLoopSec(L, type));
          if (sh && sh.nodeCount) return sh;
        }
      } catch (e) {}
      if (type === 'seq') {
        const units = Array.isArray(L.units) ? L.units : [];
        const u = units[0];
        const steps = u ? _ambSeqUnitToSteps(u) : [];
        if (steps.length && typeof _shapeSeqToShape === 'function') {
          const sh = _shapeSeqToShape(steps);
          if (typeof L.tone === 'string' && L.tone) sh.tone = L.tone;
          sh.soundParams = _ambLayerSoundParams(L);
          return sh;
        }
      }
      const sh = (typeof _shapeDefault === 'function') ? _shapeDefault() : null;
      if (!sh) return null;
      if (typeof L.tone === 'string' && L.tone) sh.tone = L.tone;
      // Node count ← the layer's rhythmic density (density / pulses / steps).
      let n = 4;
      if (Number.isFinite(L.density)) n = L.density;
      else if (Number.isFinite(L.pulses)) n = L.pulses;
      else if (Number.isFinite(L.steps)) n = L.steps;
      n = Math.max(1, Math.min(16, n | 0));
      sh.nodeCount = n;
      sh.nodes = (typeof _shapeEqualNodes === 'function') ? _shapeEqualNodes(n) : sh.nodes;
      // Loop length ← bars (1 bar = 4 beats) for bar-based layers.
      if (Number.isFinite(L.bars) && L.bars > 0) sh.loopBeats = Math.max(1, Math.min(16, L.bars | 0)) * 4;
      // Base pitch ← register (octave) + degree offset (Pedal).
      if (Number.isFinite(L.register)) {
        const deg = Number.isFinite(L.degree) ? (L.degree - 1) : 0;
        sh.baseNote = Math.max(0, Math.min(120, (L.register + 1) * 12 + deg));
      }
      sh.soundParams = _ambLayerSoundParams(L);
      return sh;
    }
    // Shape It: each layer becomes a master Shape carrying its full config
    // (entry.bloomLayer), so the Shapes transport plays it LIVE / evolving via
    // _shapeBloomEng — the master Bloom is NOT started or sounded. The baked
    // wheel is only a stopped-state preview: built from the live rolling buffer
    // when the Bloom happens to be playing, else a synthesized stand-in.
    function _ambShapeItAll(E) {
      const cfg = E.getCfg();
      if (!cfg || typeof _masterAddCopy !== 'function') return;
      _ambShapeItFromCapture(E);
    }
    function _ambShapeItFromCapture(E) {
      const cfg = E.getCfg();
      if (!cfg || typeof _masterAddCopy !== 'function') return;
      // Reflect the CURRENT Bloom: drop any shapes a previous Shape It made so a
      // re-run replaces them (rather than overlaying stale duplicates on top).
      if (Array.isArray(masterShapes)) {
        const before = masterShapes.length;
        masterShapes = masterShapes.filter(c => !(c && c.source === 'bloom'));
        if (masterShapes.length !== before && activeMasterShapeId != null && !masterShapes.some(c => c.id === activeMasterShapeId)) activeMasterShapeId = null;
      }
      let count = 0;
      const add = (L, type, name, key) => {
        if (!L) return;
        try {
          const sh = _ambLayerToShape(E, L, type, key);   // baked preview / stopped-state visual
          if (!sh) return;
          // bloomLayer carries the layer's full config so the Shapes transport can
          // play it LIVE (evolving, identical voice) via _shapeBloomEng.
          const bloomLayer = { type: type, cfg: JSON.parse(JSON.stringify(L)) };
          _masterAddCopy(sh, { name: name, source: 'bloom', sourceId: 'bloom:' + type + ':' + (L.id != null ? L.id : type), makeActive: false, bloomLayer: bloomLayer });
          count++;
        } catch (e) { console.warn('Shape It layer failed', type, e); }
      };
      // Primaries (only those present in this Bloom). Capture key = the layer name.
      [['bed', 'Bed'], ['motif', 'Motif'], ['texture', 'Texture'], ['beat', 'Beat']].forEach(([t, nm]) => {
        const L = cfg[t]; if (L && L.present !== false) add(L, t, _ambLayerLabel(L, nm), t);
      });
      // Seq layers (capture key 'seq:id').
      (Array.isArray(cfg.seqs) ? cfg.seqs : []).forEach((s, i) => add(s, 'seq', _ambLayerLabel(s, 'Seq' + (i + 1)), 'seq:' + s.id));
      // Generative extras (capture key 'type:id').
      (Array.isArray(cfg.extras) ? cfg.extras : []).forEach(ex => {
        const sch = _AMB_LAYER_SCHEMA[ex.type];
        add(ex, ex.type, _ambLayerLabel(ex, (sch && sch.label) || ex.type), ex.type + ':' + ex.id);
      });
      // Select the first shaped layer so the overview has a clear "active" ring
      // and tapping straight into the editor has a sensible default.
      if (count && Array.isArray(masterShapes)) {
        const first = masterShapes.find(c => c && c.source === 'bloom');
        if (first) activeMasterShapeId = first.id;
      }
      _shapeBloomInvalidate();   // rebuild the live render config from the new set
      // If the Shapes transport is already running, (re)start the render engine so
      // the new layers play immediately.
      try { if (typeof _shapeMaster !== 'undefined' && _shapeMaster.running) { _ambStopGenerator(_shapeBloomEng); if (_shapeBloomLayers().length) _ambStartGenerator(_shapeBloomEng); } } catch (e) {}
      // Reflect into the Shapes UI + give feedback.
      try { if (typeof _shapeMasterBrowser === 'function') _shapeMasterBrowser(); } catch (e) {}
      try { if (_shapeMaster && _shapeMaster.inited && typeof _shapeMasterDraw === 'function') _shapeMasterDraw(0); } catch (e) {}
      if (typeof showToast === 'function') {
        showToast(count ? ('Shaped ' + count + ' layer' + (count === 1 ? '' : 's') + ' → master Shapes') : 'No layers to shape');
      }
    }
    function _ambShapeRemove(E, inst, i, p) {
      if (!inst || !Array.isArray(inst.shapes) || i < 0 || i >= inst.shapes.length) return;
      if (_ambShapeEditRef && _ambShapeEditRef.id === inst.id && _ambShapeEditRef.type === inst.type && _ambShapeEditRef.sel === i) _ambShapeEditClose();
      inst.shapes.splice(i, 1);
      if (!inst.shapes.length && typeof _shapeDefault === 'function') inst.shapes.push(_shapeDefault()); // keep ≥1
      inst.sel = Math.max(0, Math.min(inst.sel | 0, inst.shapes.length - 1));
      // Re-seed this layer's per-shape phase state so wheel indices stay aligned.
      if (E.shapePhase) { const pre = inst.type + ':' + inst.id + '#'; Object.keys(E.shapePhase).forEach(k => { if (k.indexOf(pre) === 0) delete E.shapePhase[k]; }); }
      _ambRenderShapeList(E, inst, p);
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Open the FULL Shape wheel editor on a Bloom layer's selected wheel by
    // retargeting the shared editor (#shape-pad) — same mechanism master shapes
    // use. bloomMode hides the lane/Send-coupled controls in the toolbar.
    function _ambShapeEditOpen(E, inst) {
      if (!inst || !Array.isArray(inst.shapes) || !inst.shapes.length) return;
      // Single #shape-pad — evict any other editor first (master or bloom).
      try { if (typeof _shapeMasterEditId !== 'undefined' && _shapeMasterEditId != null && typeof _shapeMasterEditClose === 'function') _shapeMasterEditClose(); } catch (e) {}
      if (_ambShapeEditRef) { try { _ambShapeEditClose(); } catch (e) {} }
      const sel = Math.max(0, Math.min(inst.sel | 0, inst.shapes.length - 1));
      inst.sel = sel;
      let sh = inst.shapes[sel];
      if (typeof _shapeNormalize === 'function') sh = inst.shapes[sel] = _shapeNormalize(sh);
      try { if (typeof _shapeSpinStop === 'function') _shapeSpinStop(); } catch (e) {}
      try { _shapeEditTarget = { name: 'Bloom Shape ' + (sel + 1), shape: sh, shapeMode: true, bloomMode: true }; } catch (e) {}
      const pad = document.getElementById('shape-pad');
      const host = document.getElementById('ambient-shape-edithost');
      const box = document.getElementById('ambient-shape-editbox') || host;
      if (pad && host) {
        try { if (!_shapePadHome) _shapePadHome = { parent: pad.parentNode, next: pad.nextSibling }; } catch (e) {}
        box.appendChild(pad);
        host.hidden = false;
      }
      const doneBtn = document.getElementById('ambient-shape-editdone');
      if (doneBtn) doneBtn.onclick = function () { _ambShapeEditClose(); };
      document.body.classList.add('ambient-shape-edit');
      _ambShapeEditRef = { engine: E, type: inst.type, id: inst.id, sel: sel };
      try { if (typeof _shapeInit === 'function') _shapeInit(); } catch (e) {}
      requestAnimationFrame(() => { try { if (typeof _shapeBuildToolbar === 'function') _shapeBuildToolbar(); if (typeof _shapeResize === 'function') _shapeResize(); if (typeof _shapeDraw === 'function') _shapeDraw(); } catch (e) {} });
    }
    function _ambShapeEditClose() {
      if (!_ambShapeEditRef) return;
      const ref = _ambShapeEditRef; _ambShapeEditRef = null;
      try { if (typeof _shapeSpinStop === 'function') _shapeSpinStop(); } catch (e) {}
      const pad = document.getElementById('shape-pad');
      try {
        if (pad && _shapePadHome && _shapePadHome.parent) {
          if (_shapePadHome.next && _shapePadHome.next.parentNode === _shapePadHome.parent) _shapePadHome.parent.insertBefore(pad, _shapePadHome.next);
          else _shapePadHome.parent.appendChild(pad);
        }
        _shapePadHome = null;
      } catch (e) {}
      const host = document.getElementById('ambient-shape-edithost'); if (host) host.hidden = true;
      document.body.classList.remove('ambient-shape-edit');
      try { _shapeEditTarget = null; } catch (e) {}
      if (typeof persistWorkspace === 'function') persistWorkspace();
      try { if (typeof _shapeRetargetLane === 'function') _shapeRetargetLane(); } catch (e) {}
      // Refresh the layer's wheel list (node counts may have changed) + mods.
      try {
        const c = ref.engine && ref.engine.getCfg && ref.engine.getCfg();
        const L = (c && Array.isArray(c.extras)) ? c.extras.find(x => x.id === ref.id && x.type === ref.type) : null;
        if (L) _ambRenderShapeList(ref.engine, L, 'ambient-' + ref.type + '-' + ref.id + '-');
      } catch (e) {}
      try { if (ref.engine && ref.engine.timer) _ambSyncMods(); } catch (e) {}
      try { _ambShapeAnimEnsure(); } catch (e) {}   // resume in-card wheel previews
    }
    function _ambRenderExtras(E) {
      const wrap = _ambGet(E, 'ambient-extra-layers'); if (!wrap) return;
      const cfg = E.getCfg(); if (!cfg) return;
      if (!Array.isArray(cfg.extras)) cfg.extras = [];
      wrap.innerHTML = _ambNamespaceHtml(E, cfg.extras.map(inst => _ambInstCardHtml(inst)).join(''));
      cfg.extras.forEach(inst => _ambWireInst(E, inst));
      try { _ambRenderMixer(E); } catch (e) {}   // keep the mixer in sync on add/delete
      try { _ambSyncSliderReadouts(wrap); } catch (e) {}   // reflect synced mod/fx values
    }
    function _ambAddExtra(E, type) {
      _E = E; const cfg = E.getCfg(); if (!cfg || !_AMB_LAYER_SCHEMA[type]) return;
      if (!Array.isArray(cfg.extras)) cfg.extras = [];
      const newId = cfg.extras.reduce((m, x) => Math.max(m, x.id | 0), 0) + 1;
      cfg.extras.push(_ambDefaultLayer(type, newId));
      _ambRenderExtras(E);
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _ambDeleteExtra(E, type, id) {
      _E = E; const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.extras)) return;
      const idx = cfg.extras.findIndex(x => x.id === id && x.type === type);
      if (idx < 0) return;
      const sch = _AMB_LAYER_SCHEMA[type];
      if (!_ambConfirmDeleteLayer(_ambLayerLabel(cfg.extras[idx], (sch && sch.label) || type))) return;
      const key = type + ':' + id;
      // If this layer's wheel is open in the shared Shape editor, close it first
      // so #shape-pad returns home and _shapeEditTarget doesn't dangle.
      if (type === 'shape' && _ambShapeEditRef && _ambShapeEditRef.id === id && _ambShapeEditRef.type === type) { try { _ambShapeEditClose(); } catch (e) {} }
      cfg.extras.splice(idx, 1);
      try { if (E.mod[key]) _ambTeardownMod(key); } catch (e) {}
      try { if (E.freeze) delete E.freeze[key]; } catch (e) {}
      if (E.seqState) delete E.seqState[key];
      if (E.arpState) delete E.arpState[key];
      if (E.shapePhase) { const pre = key + '#'; Object.keys(E.shapePhase).forEach(k => { if (k.indexOf(pre) === 0) delete E.shapePhase[k]; }); }
      _ambRenderExtras(E);
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // ---- Parameter ramps (LFO automation) ------------------------------
    // A ramp continuously sweeps one layer parameter between A and B over a
    // period, shaped by a waveform: sine/triangle go A→B→A, saw ramps A→B then
    // jumps back, square alternates A/B. Applied every tick by writing the live
    // cfg value (read by the generator on its next event), so no extra audio
    // wiring is needed. Rampable params are the numeric LAYER params (read live
    // per-tick) — not the node-backed globals (reverb/space).
    const _AMB_RAMP_PARAMS = {
      bed:     [['density','Density',1,8],['register','Register',2,6],['spread','Spread',0,3],['intervalMs','Interval (ms)',200,12000],['lengthMs','Length (ms)',300,16000],['drift','Drift',0,99],['motion','Motion',0,100],['strum','Strum',0,100],['strumFidelity','Fidelity',0,100],['level','Level',0,100]],
      motif:   [['register','Register',2,7],['range','Range',1,4],['intervalMs','Interval (ms)',100,4000],['lengthMs','Length (ms)',80,4000],['drift','Drift',0,99],['restProb','Rests',0,100],['twist','Twist',0,100],['level','Level',0,100]],
      texture: [['register','Register',3,7],['fill','Fill',0,100],['intervalMs','Interval (ms)',80,2000],['lengthMs','Length (ms)',60,2000],['drift','Drift',0,99],['mutateRate','Mutate',0,100],['level','Level',0,100]],
      beat:    [['intervalMs','Interval (ms)',80,2000],['lengthMs','Length (ms)',60,2000],['drift','Drift',0,99],['restProb','Rests',0,100],['level','Level',0,100]],
      seq:     [['varyDepth','Amount',0,100],['intervalMs','Interval (ms)',200,16000],['lengthMs','Length (ms)',300,16000],['drift','Drift',0,99],['returnChance','Return %',0,100],['level','Level',0,100]],
      samp:    [['chop','Chop',1,16],['intervalMs','Interval (ms)',200,16000],['lengthMs','Length (ms)',80,16000],['drift','Drift',0,99],['level','Level',0,100]],
      bass:    [['register','Register',1,4],['bars','Bars',1,8],['pulses','Pulses',1,16],['steps','Steps',2,16],['rotate','Rotate',0,15],['lengthMs','Length (ms)',60,2000],['rhythmVar','Rhythm var',0,100],['pitchVar','Pitch var',0,100],['proximity','Proximity',0,100],['restProb','Rests',0,100],['accent','Accent',0,100],['level','Level',0,100]],
      run:     [['register','Register',2,7],['range','Range',1,4],['transpose','Transpose',-24,24],['bars','Bars',1,16],['density','Density',1,16],['lengthMs','Length (ms)',40,2000],['vary','Vary',0,100],['restProb','Rests',0,100],['accent','Accent',0,100],['level','Level',0,100]],
      pedal:   [['register','Register',1,7],['degree','Note',1,12],['bars','Bars',1,16],['density','Density',1,16],['lengthMs','Length (ms)',40,2000],['attack','Attack',0,2000],['decay','Decay',0,2000],['sustain','Sustain',0,100],['release','Release',0,4000],['vary','Vary',0,100],['restProb','Rests',0,100],['accent','Accent',0,100],['level','Level',0,100]],
      drone:   [['degree','Note',1,12],['register','Register',1,6],['intervalMs','Unit (ms)',200,8000],['hold','Hold',1,16],['attack','Attack',0,8000],['release','Release',0,12000],['timeVary','Time vary',0,100],['pitchVary','Pitch vary',0,100],['level','Level',0,100]],
      arp:     [['randomness','Randomness',0,100],['intervalMs','Interval (ms)',40,2000],['octaves','Octaves',1,4],['register','Register',2,7],['lengthMs','Length (ms)',40,2000],['drift','Drift',0,99],['restProb','Rests',0,100],['accent','Accent',0,100],['level','Level',0,100]],
      shape:   [['level','Level',0,100]],
      // Global (not per-layer): writes the shared tempo, so a BPM ramp retempos
      // grid + Bloom + Shapes together. Range is a musical 40–300.
      global:  [['bpm','BPM',40,300]],
    };
    // Live-write the global tempo from a ramp (cheap: just the inputs + the
    // top-bar readout — no digit rebuild / persist at 40 Hz; engines read
    // tempoInput.value live).
    function _ambRampSetBpm(v) {
      v = Math.max(20, Math.min(999, v | 0));
      try { if (typeof tempoInput !== 'undefined' && tempoInput) tempoInput.value = String(v); } catch (e) {}
      try { if (typeof tempoSlider !== 'undefined' && tempoSlider) tempoSlider.value = String(v); } catch (e) {}
      const xb = document.getElementById('xport-bpm'); if (xb) xb.textContent = String(v);
    }
    function _normalizeRamp(r, id, cfg) {
      if (!Number.isFinite(r.id)) r.id = id;
      if (typeof r.on !== 'boolean') r.on = true;
      // Targets: migrate the legacy single `target` (with absolute A/B) to a
      // targets[] array; A/B are now PERCENT of each target's range, so one ramp
      // can drive several params with different ranges at once.
      if (!Array.isArray(r.targets)) {
        const t0 = (typeof r.target === 'string' && r.target.indexOf('.') > 0) ? r.target : 'bed.level';
        r.targets = [t0];
        if (cfg && Number.isFinite(r.a) && Number.isFinite(r.b)) {
          const res = _ambRampResolve(cfg, t0);
          if (res && res.max > res.min) {
            r.a = (r.a - res.min) / (res.max - res.min) * 100;
            r.b = (r.b - res.min) / (res.max - res.min) * 100;
          }
        }
      }
      // Dedupe (a stale duplicate showed as "2 targets" while the picker's Set
      // ticked only one) and allow EMPTY (a target-less ramp is simply inert).
      r.targets = Array.from(new Set(r.targets.filter(t => typeof t === 'string' && t.indexOf('.') > 0)));
      delete r.target;
      if (!Number.isFinite(r.a)) r.a = 0;
      if (!Number.isFinite(r.b)) r.b = 100;
      // Keep 2-decimal precision (not integer): over a wide range like BPM (40–300)
      // 1% ≈ 2.6 BPM, so integer % can't represent a specific BPM. Finer % lets a
      // single-target ramp's real value (BPM, ms…) round-trip exactly.
      r.a = Math.max(0, Math.min(100, Math.round(r.a * 100) / 100));
      r.b = Math.max(0, Math.min(100, Math.round(r.b * 100) / 100));
      if (!Number.isFinite(r.periodMs)) r.periodMs = 4000;
      r.periodMs = Math.max(50, r.periodMs | 0);
      if (['sine','triangle','saw','square','seq'].indexOf(r.wave) < 0) r.wave = 'sine';
      // Sequence-as-waveform fields (only meaningful when wave === 'seq').
      if (!Number.isFinite(r.seqRef)) r.seqRef = 0;
      if (['pitch','velocity','gate'].indexOf(r.seqSource) < 0) r.seqSource = 'velocity';
      if (['step','smooth'].indexOf(r.seqInterp) < 0) r.seqInterp = 'step';
      if (['zero','hold'].indexOf(r.seqRest) < 0) r.seqRest = 'zero';
      return r;
    }
    // Resolve a ramp target ("bed.level", "seq:3.intervalMs", "samp:1.chop")
    // to the { obj, key, min, max } it writes. null if the layer/param is gone.
    function _ambRampResolve(cfg, target) {
      if (!cfg || typeof target !== 'string') return null;
      const dot = target.indexOf('.');
      if (dot < 0) return null;
      const head = target.slice(0, dot), key = target.slice(dot + 1);
      let obj = null, cat = head;
      if (head === 'global') {
        const spec = (_AMB_RAMP_PARAMS.global || []).find(p => p[0] === key);
        if (!spec) return null;
        if (key === 'bpm') return { global: true, key: key, min: spec[2], max: spec[3], set: _ambRampSetBpm };
        return null;
      }
      if (head === 'bed' || head === 'motif' || head === 'texture' || head === 'beat') {
        obj = cfg[head];
      } else if (head.indexOf('seq:') === 0) {
        const sid = parseInt(head.slice(4), 10);
        obj = (cfg.seqs || []).find(s => s.id === sid); cat = 'seq';
      } else if (head.indexOf('samp:') === 0) {
        const sid = parseInt(head.slice(5), 10);
        obj = (cfg.samples || []).find(s => s.id === sid); cat = 'samp';
      } else {
        // Extra-instance layer: head = '<type>:<id>' (bass/run/pedal/arp/shape, or
        // additional bed/motif/texture/beat). cat = the type.
        const ci = head.indexOf(':');
        if (ci > 0) {
          const t = head.slice(0, ci), eid = parseInt(head.slice(ci + 1), 10);
          if (typeof _AMB_LAYER_SCHEMA !== 'undefined' && _AMB_LAYER_SCHEMA[t]) {
            obj = (cfg.extras || []).find(x => x && x.type === t && x.id === eid); cat = t;
          }
        }
      }
      if (!obj) return null;
      const spec = (_AMB_RAMP_PARAMS[cat] || []).find(p => p[0] === key);
      if (!spec) return null;
      return { obj, key, min: spec[2], max: spec[3] };
    }
    // Grouped target list for the dropdown (built-in layers + dynamic layers).
    function _ambRampTargetGroups(cfg) {
      const g = [];
      const add = (label, head, cat) => g.push({ label, items: (_AMB_RAMP_PARAMS[cat] || []).map(p => ({ value: head + '.' + p[0], label: p[1] })) });
      // Built-in layers only when present.
      [['Bed', 'bed'], ['Motif', 'motif'], ['Texture', 'texture'], ['Beat', 'beat']].forEach(([lab, t]) => {
        if (cfg[t] && cfg[t].present !== false) add(lab, t, t);
      });
      (cfg.seqs || []).forEach((s, i) => add('Seq' + (i + 1), 'seq:' + s.id, 'seq'));
      (cfg.samples || []).forEach((s, i) => add('Sample' + (i + 1), 'samp:' + s.id, 'samp'));
      // Extra-instance layers (bass / run / pedal / arp / shape / extra bed…).
      const _tc = {};
      (cfg.extras || []).forEach((x) => {
        if (!x || !_AMB_LAYER_SCHEMA[x.type] || !_AMB_RAMP_PARAMS[x.type]) return;
        _tc[x.type] = (_tc[x.type] | 0) + 1;
        add((_AMB_LAYER_SCHEMA[x.type].label || x.type) + ' ' + _tc[x.type], x.type + ':' + x.id, x.type);
      });
      // Global params (BPM) — always available.
      if (_AMB_RAMP_PARAMS.global) g.push({ label: 'Global', items: _AMB_RAMP_PARAMS.global.map(p => ({ value: 'global.' + p[0], label: p[1] })) });
      return g;
    }
    // ---- Sequence-as-waveform translation -----------------------------
    // Turn a saved sequence into a looping control curve in [0,1], sampled by
    // phase. `source`: 'pitch' (note contour) | 'velocity' (step volume) |
    // 'gate' (note=1 / rest=0). `rest`: 'zero' | 'hold' (last value), ignored
    // for gate. Pitch/velocity auto-normalize to the sequence's own range so
    // the full modulation depth is used. Steps are flattened (subs expanded),
    // chords use their lowest note, and each step occupies its proportional
    // slice of the cycle. Returns { points:[{frac,val}] } (frac at step START).
    function _seqToCurve(saved, opts) {
      opts = opts || {};
      const source = (['pitch', 'velocity', 'gate'].indexOf(opts.source) >= 0) ? opts.source : 'velocity';
      const restMode = (opts.rest === 'hold') ? 'hold' : 'zero';
      const flat = [];
      (function walk(arr) { for (const s of (arr || [])) { if (s && s.isSub && Array.isArray(s.subSteps) && s.subSteps.length) walk(s.subSteps); else if (s) flat.push(s); } })(saved && saved.steps);
      if (!flat.length) return null;
      const lenOf = (s) => { const dur = s.duration || 1; const sub = (s.subdivision != null) ? s.subdivision : 1; return Math.max(1e-4, dur * sub); };
      const isRest = (s) => !s || (s.freq == null && !(Array.isArray(s.chord) && s.chord.length));
      const lowFreq = (s) => { if (Array.isArray(s.chord) && s.chord.length) { let m = Infinity; s.chord.forEach(n => { if (n && n.freq != null && n.freq < m) m = n.freq; }); return isFinite(m) ? m : null; } return (s.freq != null) ? s.freq : null; };
      const vel = (s) => { const p = s.params; return (p && Number.isFinite(p.volume)) ? p.volume : 100; };
      // Raw value per step (null = rest, to be filled by rest mode below).
      let raws = flat.map(s => {
        if (source === 'gate') return isRest(s) ? 0 : 1;
        if (isRest(s)) return null;
        return (source === 'pitch') ? lowFreq(s) : vel(s);
      });
      if (source !== 'gate') {
        let lo = Infinity, hi = -Infinity;
        raws.forEach(v => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } });
        const span = hi - lo;
        raws = raws.map(v => (v == null) ? null : (span > 1e-6 ? (v - lo) / span : 0.5));
      }
      let last = 0;
      const filled = raws.map(v => { if (v == null) { return (restMode === 'hold') ? last : 0; } last = v; return v; });
      const total = flat.reduce((a, s) => a + lenOf(s), 0) || 1;
      const points = []; let cum = 0;
      for (let i = 0; i < flat.length; i++) { points.push({ frac: cum / total, val: filled[i] }); cum += lenOf(flat[i]); }
      return { points };
    }
    // Sample a sequence curve at phase [0,1). interp 'smooth' linearly ramps
    // between consecutive step values (wrapping); otherwise it holds (stepped).
    function _seqCurveAt(curve, phase, interp) {
      if (!curve || !curve.points || !curve.points.length) return 0;
      const pts = curve.points, n = pts.length;
      phase = ((phase % 1) + 1) % 1;
      let i = n - 1;
      for (let k = 0; k < n; k++) { const f0 = pts[k].frac, f1 = (k + 1 < n) ? pts[k + 1].frac : 1; if (phase >= f0 && phase < f1) { i = k; break; } }
      if (interp === 'smooth') {
        const f0 = pts[i].frac, v0 = pts[i].val;
        const nx = (i + 1) % n, f1 = (i + 1 < n) ? pts[i + 1].frac : 1, v1 = pts[nx].val;
        const t = (f1 > f0) ? (phase - f0) / (f1 - f0) : 0;
        return v0 + t * (v1 - v0);
      }
      return pts[i].val;
    }
    // Build (and cache on the ramp/mod object) the curve for a 'seq' waveform.
    function _seqRefCurve(host) {
      const idx = host.seqRef | 0;
      const saved = (typeof savedSequences !== 'undefined' && Array.isArray(savedSequences)) ? savedSequences[idx] : null;
      const key = idx + '|' + (host.seqSource || 'velocity') + '|' + (host.seqRest || 'zero');
      if (host._seqKey === key && host._seqCurve !== undefined) return host._seqCurve;
      host._seqKey = key;
      host._seqCurve = saved ? _seqToCurve(saved, { source: host.seqSource, rest: host.seqRest }) : null;
      return host._seqCurve;
    }
    // Waveform position factor in [0,1] for phase in [0,1).
    function _ambRampFactor(wave, phase) {
      switch (wave) {
        case 'triangle': return phase < 0.5 ? phase * 2 : 2 - phase * 2;
        case 'saw':      return phase;
        case 'square':   return phase < 0.5 ? 0 : 1;
        case 'sine':
        default:         return (1 - Math.cos(2 * Math.PI * phase)) / 2;
      }
    }
    // Called each tick: write every active ramp's current value into cfg.
    // `elapsedSec` is the time since PLAY START, so phase 0 (= A) lands on play.
    function _ambApplyRamps(cfg, elapsedSec) {
      if (!cfg || !Array.isArray(cfg.ramps) || !cfg.ramps.length) return;
      const eMs = Math.max(0, elapsedSec) * 1000;
      for (const r of cfg.ramps) {
        if (!r || !r.on || !Array.isArray(r.targets) || !r.targets.length) continue;
        const period = Math.max(50, r.periodMs | 0);
        const phase = (eMs % period) / period;
        let f;
        if (r.wave === 'seq') {
          const c = _seqRefCurve(r);
          f = c ? _seqCurveAt(c, phase, (r.seqInterp === 'smooth') ? 'smooth' : 'step') : 0;
        } else {
          f = _ambRampFactor(r.wave, phase);
        }
        r._f = f;   // live sweep position (0..1) for the row's visual cue
        // A/B are percentages; map to each target's own range so a single ramp
        // can drive several params (with different ranges) together.
        const pct = (r.a + f * (r.b - r.a)) / 100;
        for (const t of r.targets) {
          const res = _ambRampResolve(cfg, t);
          if (!res) continue;
          let v = res.min + pct * (res.max - res.min);
          v = Math.max(res.min, Math.min(res.max, v));
          if (typeof res.set === 'function') res.set(Math.round(v));   // global targets (e.g. BPM)
          else if (res.obj) res.obj[res.key] = Math.round(v);
        }
      }
    }
    // Paint the live ramp cue: a position bar that tracks the sweep and a live
    // "(now X)" readout, so an active ramp visibly moves while playing. Cheap —
    // a couple of style writes per ramp; called throttled off the ramp clock.
    function _ambRampViz(E) {
      const cfg = E && E._cfg;
      if (!cfg || !Array.isArray(cfg.ramps)) return;
      const playing = !!cfg.playing;
      for (const r of cfg.ramps) {
        if (!r) continue;
        const p = 'ambient-ramp-' + r.id + '-';
        const fill = _ambGet(E, p + 'fill');
        if (!fill) continue;
        const row = fill.closest('.ambient-ramp-row');
        const active = playing && !!r.on;
        if (row) row.classList.toggle('ramp-active', active);
        if (!active) continue;
        const f = Number.isFinite(r._f) ? Math.max(0, Math.min(1, r._f)) : 0;
        fill.style.width = (f * 100) + '%';
        const rg = _ambGet(E, p + 'range');
        if (rg) {
          const pctNow = r.a + f * (r.b - r.a);
          const u = _ambRampSingleUnit(r, cfg);
          if (u) rg.textContent = u.name + ' · now ' + _ampPctToReal(pctNow, u) + (u.unit ? ' ' + u.unit : '');
          else { const n = Array.isArray(r.targets) ? r.targets.length : 0; rg.textContent = n + ' target' + (n === 1 ? '' : 's') + ' · ' + Math.round(pctNow) + '%'; }
        }
      }
    }
    // Drop the active cue (engine stopped): clear the moving bars and restore
    // each row's static range readout.
    function _ambRampVizClear(E) {
      const cfg = E && (E._cfg || (E.getCfg && E.getCfg()));
      if (!cfg || !Array.isArray(cfg.ramps)) return;
      for (const r of cfg.ramps) {
        if (!r) continue;
        const fill = _ambGet(E, 'ambient-ramp-' + r.id + '-fill');
        if (fill) { const row = fill.closest('.ambient-ramp-row'); if (row) row.classList.remove('ramp-active'); }
        try { _ambRampSyncABRange(E, r.id); } catch (e) {}
      }
    }
    function _ambRampRowHtml(r, cfg) {
      const id = r.id, p = 'ambient-ramp-' + id + '-';
      const waveOpts = [['sine','Sine'],['triangle','Triangle'],['saw','Saw'],['square','Square']]
        .map(w => '<option value="' + w[0] + '"' + (r.wave === w[0] ? ' selected' : '') + '>' + w[1] + '</option>').join('');
      // Saved sequences as selectable waveforms (value 'seq:<idx>').
      const _seqList = (typeof savedSequences !== 'undefined' && Array.isArray(savedSequences)) ? savedSequences : [];
      const seqWaveOpts = _seqList.map((s, i) => (s && s.type !== 'audio' && Array.isArray(s.steps) && s.steps.length)
        ? '<option value="seq:' + i + '"' + ((r.wave === 'seq' && (r.seqRef | 0) === i) ? ' selected' : '') + '>' + String(s.name || ('Seq ' + (i + 1))).replace(/[<>&"]/g, '') + '</option>' : '').join('');
      const _msel = (sid, opts, cur) => '<select id="' + sid + '" class="ambient-select">' + opts.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
      const seqRowHtml = '<div class="ambient-ramp-seq" id="' + p + 'seqrow"' + (r.wave === 'seq' ? '' : ' hidden') + '>' +
        '<label>Read' + _msel(p + 'seqsrc', [['pitch','Pitch'],['velocity','Velocity'],['gate','Gate']], r.seqSource || 'velocity') + '</label>' +
        '<label>Curve' + _msel(p + 'seqinterp', [['step','Stepped'],['smooth','Smooth']], r.seqInterp || 'step') + '</label>' +
        '<label>Rest' + _msel(p + 'seqrest', [['zero','Zero'],['hold','Hold']], r.seqRest || 'zero') + '</label>' +
        '</div>';
      return '<div class="ambient-ramp-row" data-ramp-id="' + id + '">' +
        '<div class="ambient-ramp-head">' +
          '<button type="button" class="ambient-toggle ambient-ramp-on" id="' + p + 'on">Ramp</button>' +
          '<button type="button" class="ambient-select ambient-ramp-target" id="' + p + 'targets" title="Choose one or more layer parameters to drive">' + _ambRampTargetsLabel(r, cfg) + '</button>' +
          '<button type="button" class="ambient-seq-del" id="' + p + 'del" title="Delete ramp" aria-label="Delete ramp">✕</button>' +
        '</div>' +
        // Live sweep cue — the fill bar tracks the ramp's current position while
        // playing (driven by _ambRampViz); hidden until the row is .ramp-active.
        '<div class="ambient-ramp-viz"><span class="ambient-ramp-fill" id="' + p + 'fill"></span></div>' +
        '<div class="ambient-ramp-params">' +
          '<span class="ambient-hint ambient-ramp-range" id="' + p + 'range"></span>' +
          '<label>A<input type="number" id="' + p + 'a" class="ambient-ramp-num" min="0" max="100" value="' + r.a + '"><span class="ambient-hint" id="' + p + 'a-u">%</span></label>' +
          '<label>B<input type="number" id="' + p + 'b" class="ambient-ramp-num" min="0" max="100" value="' + r.b + '"><span class="ambient-hint" id="' + p + 'b-u">%</span></label>' +
          '<label>Period<input type="number" id="' + p + 'period" class="ambient-ramp-num" min="50" step="50" value="' + r.periodMs + '"><span class="ambient-hint">ms</span></label>' +
          '<label>Wave<select id="' + p + 'wave" class="ambient-select ambient-ramp-wave">' + waveOpts + (seqWaveOpts ? '<optgroup label="Sequence">' + seqWaveOpts + '</optgroup>' : '') + '</select></label>' +
        '</div>' +
        seqRowHtml +
      '</div>';
    }
    // A/B are stored as PERCENT (0–100) of each target's range so one ramp can
    // drive several params. But with a SINGLE target we show/enter the real unit
    // (BPM, ms, Level…) instead of a percent — far more intuitive. This returns
    // { min, max, name, unit } for the single-target case, else null.
    function _ambRampSingleUnit(r, cfg) {
      const ts = (r && Array.isArray(r.targets)) ? r.targets : [];
      if (ts.length !== 1) return null;
      const res = _ambRampResolve(cfg, ts[0]);
      if (!res || !(res.max > res.min)) return null;
      const name = _ambRampTargetName(cfg, ts[0]);
      const unit = /\.bpm$/i.test(ts[0]) ? 'BPM' : (/\(ms\)|ms$/i.test(name) ? 'ms' : '');
      return { min: res.min, max: res.max, name: name, unit: unit };
    }
    const _ampPctToReal = (pct, u) => Math.round(u.min + (Math.max(0, Math.min(100, pct)) / 100) * (u.max - u.min));
    const _ampRealToPct = (real, u) => Math.round(((Math.max(u.min, Math.min(u.max, real)) - u.min) / (u.max - u.min)) * 10000) / 100;
    // Refresh just the A→B range readout (used live while typing).
    function _ambRampReadout(E, id) {
      const cfg = E.getCfg(); if (!cfg) return;
      const r = (cfg.ramps || []).find(x => x.id === id); if (!r) return;
      const rg = _ambGet(E, 'ambient-ramp-' + id + '-range'); if (!rg) return;
      const u = _ambRampSingleUnit(r, cfg);
      if (u) rg.textContent = u.name + ' · ' + _ampPctToReal(r.a, u) + '→' + _ampPctToReal(r.b, u) + (u.unit ? ' ' + u.unit : '');
      else { const n = Array.isArray(r.targets) ? r.targets.length : 0; rg.textContent = n + ' target' + (n === 1 ? '' : 's') + ' · ' + Math.round(r.a) + '%→' + Math.round(r.b) + '%'; }
    }
    function _ambRampSyncABRange(E, id) {
      const cfg = E.getCfg(); if (!cfg) return;
      const r = (cfg.ramps || []).find(x => x.id === id); if (!r) return;
      const p = 'ambient-ramp-' + id + '-';
      const u = _ambRampSingleUnit(r, cfg);
      const aEl = _ambGet(E, p + 'a'), bEl = _ambGet(E, p + 'b');
      const aU = _ambGet(E, p + 'a-u'), bU = _ambGet(E, p + 'b-u');
      if (u) {
        if (aEl) { aEl.min = u.min; aEl.max = u.max; aEl.value = String(_ampPctToReal(r.a, u)); }
        if (bEl) { bEl.min = u.min; bEl.max = u.max; bEl.value = String(_ampPctToReal(r.b, u)); }
        if (aU) aU.textContent = u.unit || '';
        if (bU) bU.textContent = u.unit || '';
      } else {
        if (aEl) { aEl.min = 0; aEl.max = 100; aEl.value = String(Math.round(r.a)); }
        if (bEl) { bEl.min = 0; bEl.max = 100; bEl.value = String(Math.round(r.b)); }
        if (aU) aU.textContent = '%';
        if (bU) bU.textContent = '%';
      }
      _ambRampReadout(E, id);
    }
    // Friendly name for a single target value ('bed.level' → 'Bed Level').
    function _ambRampTargetName(cfg, value) {
      const groups = _ambRampTargetGroups(cfg);
      for (const g of groups) for (const it of g.items) if (it.value === value) return g.label + ' · ' + it.label;
      return value;
    }
    function _ambRampTargetsLabel(r, cfg) {
      const ts = Array.isArray(r.targets) ? r.targets : [];
      if (!ts.length) return '+ Targets…';
      if (ts.length === 1) return _ambRampTargetName(cfg, ts[0]);
      return ts.length + ' targets ▾';
    }
    // Multi-target picker: grouped, checkable list of every layer parameter; tap
    // toggles membership in this ramp's targets[]. One ramp can drive many.
    function _ambShowRampTargetsMenu(E, id, anchorBtn) {
      const getR = () => { const c = E.getCfg(); return (c && Array.isArray(c.ramps)) ? c.ramps.find(x => x.id === id) : null; };
      if (!getR()) return;
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, '');
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const modal = document.createElement('div'); modal.className = 'step-div-modal amb-ramptgt-modal';
      overlay.appendChild(modal);
      const close = () => { try { overlay.remove(); } catch (e) {} try { _ambRenderRamps(E); } catch (e) {} };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      const render = () => {
        const r = getR(); if (!r) { close(); return; }
        const cfg = E.getCfg();
        const sel = new Set(Array.isArray(r.targets) ? r.targets : []);
        const groups = _ambRampTargetGroups(cfg);
        let h = '<div class="keep-sdiv-title">Ramp targets</div><div class="amb-ramptgt-list">';
        groups.forEach(g => {
          h += '<div class="amb-ramptgt-group">' + esc(g.label) + '</div>';
          g.items.forEach(it => {
            h += '<button type="button" class="amb-ramptgt-item' + (sel.has(it.value) ? ' on' : '') + '" data-val="' + esc(it.value) + '">' +
              '<span class="amb-ramptgt-check">' + (sel.has(it.value) ? '✓' : '') + '</span>' + esc(it.label) + '</button>';
          });
        });
        if (!groups.length) h += '<div class="ambient-cap-empty">No layers yet — add a layer first.</div>';
        h += '</div><div class="sm-footer"><button type="button" class="sm-apply amb-ramptgt-ok">Done</button></div>';
        modal.innerHTML = h;
        modal.querySelectorAll('.amb-ramptgt-item').forEach(b => b.addEventListener('click', () => {
          const r2 = getR(); if (!r2) return;
          if (!Array.isArray(r2.targets)) r2.targets = [];
          const v = b.dataset.val, i = r2.targets.indexOf(v);
          if (i >= 0) r2.targets.splice(i, 1); else r2.targets.push(v);
          persist(); render();
        }));
        const ok = modal.querySelector('.amb-ramptgt-ok'); if (ok) ok.addEventListener('click', close);
      };
      render();
      document.body.appendChild(overlay);
    }
    function _ambWireRamp(E, r) {
      const id = r.id, p = 'ambient-ramp-' + id + '-';
      const getR = () => { const c = E.getCfg(); return (c && Array.isArray(c.ramps)) ? c.ramps.find(x => x.id === id) : null; };
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const el = (suf) => _ambGet(E, p + suf);
      const onB = el('on');
      if (onB) { onB.classList.toggle('on', !!r.on); onB.addEventListener('click', () => { _E = E; const R = getR(); if (!R) return; R.on = !R.on; onB.classList.toggle('on', R.on); persist(); }); }
      const tgtBtn = el('targets');
      if (tgtBtn) tgtBtn.addEventListener('click', () => { _E = E; _ambShowRampTargetsMenu(E, id, tgtBtn); });
      // A/B accept the target's REAL unit (BPM, ms…) when there's a single target,
      // converting to the stored percent; otherwise a plain 0–100 percent.
      const _readAB = (inp) => { const R = getR(); if (!R) return null; const u = _ambRampSingleUnit(R, E.getCfg()); const raw = parseFloat(inp.value); return u ? _ampRealToPct(Number.isFinite(raw) ? raw : u.min, u) : Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0)); };
      const a = el('a'); if (a) a.addEventListener('input', () => { _E = E; const R = getR(); if (!R) return; const v = _readAB(a); if (v == null) return; R.a = v; persist(); _ambRampReadout(E, id); });
      const b = el('b'); if (b) b.addEventListener('input', () => { _E = E; const R = getR(); if (!R) return; const v = _readAB(b); if (v == null) return; R.b = v; persist(); _ambRampReadout(E, id); });
      const per = el('period'); if (per) per.addEventListener('input', () => { _E = E; const R = getR(); if (!R) return; R.periodMs = Math.max(50, parseInt(per.value, 10) || 1000); persist(); });
      const wv = el('wave'); if (wv) wv.addEventListener('change', () => {
        _E = E; const R = getR(); if (!R) return;
        const v = wv.value || 'sine';
        if (v.indexOf('seq:') === 0) {
          R.wave = 'seq'; R.seqRef = parseInt(v.slice(4), 10) || 0;
          if (['pitch','velocity','gate'].indexOf(R.seqSource) < 0) R.seqSource = 'velocity';
          if (['step','smooth'].indexOf(R.seqInterp) < 0) R.seqInterp = 'step';
          if (['zero','hold'].indexOf(R.seqRest) < 0) R.seqRest = 'zero';
        } else { R.wave = v; }
        R._seqKey = null;                       // invalidate cached curve
        const sr = el('seqrow'); if (sr) sr.hidden = (R.wave !== 'seq');
        persist();
      });
      // Sequence translation sub-controls (source / interp / rest).
      const bindSeq = (suf, key) => { const e = el(suf); if (e) e.addEventListener('change', () => { _E = E; const R = getR(); if (!R) return; R[key] = e.value; R._seqKey = null; persist(); }); };
      bindSeq('seqsrc', 'seqSource'); bindSeq('seqinterp', 'seqInterp'); bindSeq('seqrest', 'seqRest');
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteRamp(E, id));
    }
    function _ambRenderRamps(E) {
      const wrap = _ambGet(E, 'ambient-ramps');
      if (!wrap) return;
      const cfg = E.getCfg(); if (!cfg) return;
      if (!Array.isArray(cfg.ramps)) cfg.ramps = [];
      wrap.innerHTML = _ambNamespaceHtml(E, cfg.ramps.map(r => _ambRampRowHtml(r, cfg)).join(''));
      cfg.ramps.forEach(r => _ambWireRamp(E, r));
      cfg.ramps.forEach(r => _ambRampSyncABRange(E, r.id));
    }
    function _ambAddRamp(E) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg) return;
      if (!Array.isArray(cfg.ramps)) cfg.ramps = [];
      const newId = cfg.ramps.reduce((m, r) => Math.max(m, r.id | 0), 0) + 1;
      // Start with NO target so the picker's first selection IS the only target
      // (previously a default 'bed.level' lingered → "2 targets" after one pick).
      cfg.ramps.push(_normalizeRamp({ id: newId, on: true, targets: [], a: 0, b: 100, periodMs: 4000, wave: 'sine' }, newId, cfg));
      _ambRenderRamps(E);
      if (E.timer) { E._cfg = cfg; _ambStartRampClock(E); } // spin up the ramp clock if playing
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _ambDeleteRamp(E, id) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.ramps)) return;
      const idx = cfg.ramps.findIndex(r => r.id === id);
      if (idx < 0) return;
      cfg.ramps.splice(idx, 1);
      _ambRenderRamps(E);
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Add / remove a built-in layer (Bed / Motif / Texture / Beat). Settings are
    // retained on remove (the card just hides), so re-adding restores them.
    function _ambAddLayer(E, layer) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !cfg[layer]) return;
      cfg[layer].present = true;
      cfg[layer].on = true;
      _ambSyncControls(E);                                   // unhides + refreshes the card
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }  // build its chain if playing
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _ambRemoveLayer(E, layer) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !cfg[layer]) return;
      if (!_ambConfirmDeleteLayer(_ambLayerLabel(cfg[layer], layer.charAt(0).toUpperCase() + layer.slice(1)))) return;
      cfg[layer].present = false;
      _ambSyncControls(E);                                   // hides the card
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }  // tears down its chain
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Apply a distilled sequence "unit" to an engine's Seq layers.
    // mode: 'new' (new SeqN) | 'append' (add a SECTION/unit, ordered) | 'interleave'
    // (add a section + default the layer to Random order).
    // Total wall-time of a unit's phrase (sum of every event's durMs) — the
    // length one full pass of the sequence takes.
    function _unitTotalMs(unit) {
      if (!unit || !Array.isArray(unit.events)) return 0;
      return unit.events.reduce((s, e) => s + Math.max(0, e.durMs | 0), 0);
    }
    // Size a seq layer's Interval (and Length) to its phrase so the loop fires
    // exactly when the previous pass ends — no silence gaps, no overlap-cut.
    // Interleaved units use the longest so none gets truncated.
    function _ambFitSeqInterval(seq) {
      if (!seq || !Array.isArray(seq.units) || !seq.units.length) return;
      let total = 0;
      seq.units.forEach(u => { total = Math.max(total, _unitTotalMs(u)); });
      if (total > 0) { seq.intervalMs = Math.max(100, Math.round(total)); seq.lengthMs = seq.intervalMs; }
    }
    function _ambSendSeedToInstance(E, unit, mode, targetSeqId, nameHint) {
      if (!_ambValidUnit(unit)) return false;
      const cfg = E.getCfg(); if (!cfg) return false;
      if (!Array.isArray(cfg.seqs)) cfg.seqs = [];
      let eff = mode;
      if ((mode === 'append' || mode === 'interleave') && !cfg.seqs.length) eff = 'new';
      if (typeof nameHint === 'string' && nameHint) unit.name = nameHint;
      if (!Number.isFinite(unit.reps)) unit.reps = 1;
      if (eff === 'new') {
        const id = cfg.seqs.reduce((m, s) => Math.max(m, s.id | 0), 0) + 1;
        const seq = _defaultSeqLayer(id);
        if (typeof nameHint === 'string' && nameHint) seq.name = nameHint;
        seq.units = [unit];
        seq.scale = (unit.scale && typeof SCALES !== 'undefined' && SCALES[unit.scale]) ? unit.scale : '';
        // Leave Tone on '' (Grid voice = follow each note's CAPTURED voice) so
        // the layer plays every step in the tone of the step that's playing —
        // a single-tone lane sounds in that one voice, a multi-tone lane plays
        // each step in its own. The user can still pick an explicit Tone to
        // override all steps uniformly.
        // Play the sent sequence FAITHFULLY by default — the generative walk
        // (pitch/rhythm vary) would otherwise drop ~6% of notes and nudge
        // pitches on non-verbatim cycles, so you'd hear a thinned/altered take
        // rather than the merge. Variation stays opt-in via the Amount slider.
        seq.varyDepth = 0;
        _ambFitSeqInterval(seq);
        cfg.seqs.push(seq);
      } else {
        const seq = cfg.seqs.find(s => s.id === targetSeqId) || cfg.seqs[cfg.seqs.length - 1];
        // Append / Interleave both ADD a new SECTION (unit) to the target layer —
        // its sections play in turn (see the Sections popover for reps / order /
        // Random). Interleave additionally defaults the layer to Random order.
        seq.units.push(unit);
        if (seq.units.length > 1) {
          if (eff === 'interleave') seq.unitMode = 'random';
          else if (seq.unitMode === 'single') seq.unitMode = 'sequence';
        }
        seq.on = true;
        _ambFitSeqInterval(seq);
      }
      if (E.timer) { _E = E; try { _ambSyncMods(); } catch (e) {} }
      if (typeof persistWorkspace === 'function') persistWorkspace();
      return true;
    }

    function _ambSyncControls(E) {
      _E = E;
      const cfg = E.getCfg();
      if (!cfg) return;
      // Translate the 'ambient-' id stems to this engine's DOM prefix.
      const tr = (id) => (E.idPrefix === 'ambient') ? id : id.replace(/^ambient-/, E.idPrefix + '-');
      const set = (id, v) => { const el = document.getElementById(tr(id)); if (el && v != null) el.value = String(v); };
      const hint = (id, txt) => { const el = document.getElementById(tr(id)); if (el) el.textContent = txt; };
      // When is a 16-step toggle grid; paint its cells from the stored value
      // (legacy strings map onto the grid via _ambWhenGridCells).
      const setWhen = (stem, when) => { _ambPaintWhenGrid(document.getElementById(tr(stem + '-when')), when); };
      ['free', 'sync'].forEach(t => { const el = document.getElementById(tr('ambient-timing-' + t)); if (el) el.classList.toggle('active', cfg.timing === t); });
      { const qOn = document.getElementById(tr('ambient-queue-on'));
        if (qOn) { qOn.classList.toggle('active', !!cfg.queueMode); qOn.textContent = cfg.queueMode ? 'On' : 'Off'; } }
      { const qT = document.getElementById(tr('ambient-queue-tails'));
        if (qT) qT.classList.toggle('active', !!cfg.tails); }
      { const kOn = document.getElementById(tr('ambient-key-on'));
        if (kOn) kOn.classList.toggle('active', !!cfg.keyOn);
        set('ambient-key-root', cfg.keyRoot);
        set('ambient-key-scale', cfg.keyScale);
        const kSel = document.getElementById(tr('ambient-key-root')); if (kSel) kSel.disabled = !cfg.keyOn;
        const kqSel = document.getElementById(tr('ambient-key-scale')); if (kqSel) kqSel.disabled = !cfg.keyOn;
        const kName = (typeof CHROMATIC !== 'undefined' && CHROMATIC[cfg.keyRoot | 0]) || '';
        const kQual = (typeof prettyScaleName === 'function') ? prettyScaleName(cfg.keyScale) : cfg.keyScale;
        hint('ambient-key-hint', cfg.keyOn ? (kName + ' ' + kQual) : 'off'); }
      set('ambient-prog-rate', cfg.progRateMs); hint('ambient-prog-rate-v', _ambFmtMs(cfg.progRateMs));
      set('ambient-freeze-len', cfg.freezeLenMs); hint('ambient-freeze-len-v', _ambFmtMs(cfg.freezeLenMs));
      if (cfg.reverb) { set('ambient-reverb-size', cfg.reverb.size); set('ambient-reverb-damp', cfg.reverb.damp); }
      // Master Warmth (global FX) reflection — master Bloom only; these IDs
      // don't exist on lane Bloom, so the guarded set()/hint() no-op there.
      if (typeof globalFx !== 'undefined' && globalFx) {
        set('ambient-warmth', globalFx.warmth); hint('ambient-warmth-v', (globalFx.warmth | 0) + '%');
        set('ambient-warmth-drive', globalFx.warmthDrive); hint('ambient-warmth-drive-v', (globalFx.warmthDrive | 0) + '%');
        set('ambient-warmth-cut', globalFx.warmthCut); hint('ambient-warmth-cut-v', (globalFx.warmthCut | 0) + ' Hz');
        const wOn = document.getElementById(tr('ambient-warmth-on'));
        if (wOn) { const on = globalFx.warmthOn !== false; wOn.classList.toggle('active', on); wOn.textContent = on ? 'On' : 'Off'; }
      }
      const chk = (id, v) => { const el = document.getElementById(tr(id)); if (el) el.classList.toggle('on', !!v); };
      // Show only "present" built-in layer cards (Bloom starts with just Bed;
      // the rest are added via the Add-layer menu). Also grey the Add button
      // when every built-in type is already present.
      let _absentCount = 0;
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        const onBtn = document.getElementById(tr('ambient-' + layer + '-on'));
        const card = onBtn ? onBtn.closest('.ambient-layer') : null;
        const absent = !!(cfg[layer] && cfg[layer].present === false);
        if (absent) _absentCount++;
        if (card) card.style.display = absent ? 'none' : '';
      });
      const addBtn = document.getElementById(tr('ambient-add-layer'));
      if (addBtn) addBtn.disabled = false; // can always add another instance
      chk('ambient-bed-on', cfg.bed.on);
      set('ambient-bed-tone', cfg.bed.tone);
      { const _nb = document.getElementById(tr('ambient-bed-notes')); if (_nb) _nb.textContent = _ambNotesLabel(_ambNotesOf(cfg.bed)); }
      set('ambient-bed-density', cfg.bed.density);
      set('ambient-bed-register', cfg.bed.register);
      set('ambient-bed-spread', cfg.bed.spread);
      set('ambient-bed-interval', cfg.bed.intervalMs); hint('ambient-bed-interval-v', _ambFmtMs(cfg.bed.intervalMs));
      set('ambient-bed-length', cfg.bed.lengthMs);     hint('ambient-bed-length-v', _ambFmtMs(cfg.bed.lengthMs));
      set('ambient-bed-drift', cfg.bed.drift);
      setWhen('ambient-bed', cfg.bed.when);
      set('ambient-bed-motion', cfg.bed.motion);
      set('ambient-bed-strum', cfg.bed.strum);
      set('ambient-bed-strumfid', cfg.bed.strumFidelity);
      set('ambient-bed-level', cfg.bed.level);
      chk('ambient-motif-on', cfg.motif.on);
      set('ambient-motif-tone', cfg.motif.tone);
      { const _nb = document.getElementById(tr('ambient-motif-notes')); if (_nb) _nb.textContent = _ambNotesLabel(_ambNotesOf(cfg.motif)); }
      set('ambient-motif-register', cfg.motif.register);
      set('ambient-motif-range', cfg.motif.range);
      set('ambient-motif-proximity', cfg.motif.proximity);
      set('ambient-motif-interval', cfg.motif.intervalMs); hint('ambient-motif-interval-v', _ambFmtMs(cfg.motif.intervalMs));
      set('ambient-motif-length', cfg.motif.lengthMs);     hint('ambient-motif-length-v', _ambFmtMs(cfg.motif.lengthMs));
      set('ambient-motif-drift', cfg.motif.drift);
      setWhen('ambient-motif', cfg.motif.when);
      set('ambient-motif-rest', cfg.motif.restProb);
      set('ambient-motif-twist', cfg.motif.twist);
      set('ambient-motif-accent', cfg.motif.accent);
      set('ambient-motif-level', cfg.motif.level);
      chk('ambient-texture-on', cfg.texture.on);
      set('ambient-texture-tone', cfg.texture.tone);
      { const _nb = document.getElementById(tr('ambient-texture-notes')); if (_nb) _nb.textContent = _ambNotesLabel(_ambNotesOf(cfg.texture)); }
      set('ambient-texture-register', cfg.texture.register);
      set('ambient-texture-fill', cfg.texture.fill);
      set('ambient-texture-interval', cfg.texture.intervalMs); hint('ambient-texture-interval-v', _ambFmtMs(cfg.texture.intervalMs));
      set('ambient-texture-length', cfg.texture.lengthMs);     hint('ambient-texture-length-v', _ambFmtMs(cfg.texture.lengthMs));
      set('ambient-texture-drift', cfg.texture.drift);
      setWhen('ambient-texture', cfg.texture.when);
      set('ambient-texture-mutate', cfg.texture.mutateRate);
      set('ambient-texture-level', cfg.texture.level);
      chk('ambient-beat-on', cfg.beat.on);
      set('ambient-beat-kit', cfg.beat.kit);
      set('ambient-beat-gen', cfg.beat.gen || 'random');
      set('ambient-beat-rate', cfg.beat.rate || '');
      set('ambient-beat-interval', cfg.beat.intervalMs); hint('ambient-beat-interval-v', _ambFmtMs(cfg.beat.intervalMs));
      set('ambient-beat-bars', cfg.beat.bars);
      set('ambient-beat-pulses', cfg.beat.pulses);
      set('ambient-beat-steps', cfg.beat.steps);
      set('ambient-beat-rotate', cfg.beat.rotate);
      set('ambient-beat-length', cfg.beat.lengthMs);     hint('ambient-beat-length-v', _ambFmtMs(cfg.beat.lengthMs));
      set('ambient-beat-rhythmVar', cfg.beat.rhythmVar);
      set('ambient-beat-drift', cfg.beat.drift);
      setWhen('ambient-beat', cfg.beat.when);
      set('ambient-beat-rest', cfg.beat.restProb);
      set('ambient-beat-level', cfg.beat.level);
      try { _ambBeatGenVis(E, 'ambient-beat-', cfg.beat); } catch (e) {}
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => { try { _ambWireUnitSync(E, 'ambient-' + layer + '-', () => cfg[layer], layer); } catch (e) {} });
      // Per-layer FX values.
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        const L = cfg[layer]; if (!L) return;
        set('ambient-' + layer + '-fx-rev', L.revSend);
        if (L.delay) { set('ambient-' + layer + '-fx-dly-mix', L.delay.mix); set('ambient-' + layer + '-fx-dly-time', L.delay.timeMs); hint('ambient-' + layer + '-fx-dly-time-v', _ambFmtMs(L.delay.timeMs)); set('ambient-' + layer + '-fx-dly-fb', L.delay.feedback); }
        if (L.dist) { set('ambient-' + layer + '-fx-dist-amt', L.dist.amount); set('ambient-' + layer + '-fx-dist-mix', L.dist.mix); }
      });
      // Seq + Sample layers are dynamic lists — (re)render for this engine.
      _ambRenderSeqLayers(E);
      _ambRenderSampleLayers(E);
      _ambRenderExtras(E);   // each of the three renders the mixer in sync
      _ambRenderRamps(E);
      try { _ambSyncLayerUnits(E); } catch (e) {} // header unit-length readouts
      try { _ambFreezeSyncAll(E); } catch (e) {} // restore freeze-button states after re-render
      try { _ambSoloSyncAll(E); } catch (e) {}   // restore solo-button states after re-render
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        const m = cfg[layer] && cfg[layer].mod;
        if (!m) return;
        ['vca', 'vco', 'vcf'].forEach(t => {
          if (!m[t]) return;
          set('ambient-' + layer + '-mod-' + t + '-depth', m[t].depth);
          set('ambient-' + layer + '-mod-' + t + '-rate', m[t].rate);
          { const elf = (suf) => document.getElementById(tr('ambient-' + layer + '-' + suf)); _ambSyncModShapeEl(elf, m[t], t); }
        });
      });
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => _ambSyncSpread(E, 'ambient-' + layer, cfg[layer]));
      const seedEl = document.getElementById(E.seedId);
      if (seedEl) seedEl.textContent = '#' + (cfg.seed >>> 0);
      _ambRefreshPlayBtn(E);
      try { _ambRefreshCaptureBtn(E); } catch (e) {}
      // Mirror every slider's just-synced value into its numeric readout
      // (programmatic setVal above doesn't fire 'input').
      try { _ambSyncSliderReadouts(document); } catch (e) {}
    }
    function _ambientInit(E) {
      if (E.inited) { _ambSyncControls(E); _ambStartViz(E); return; }
      const host = document.getElementById(E.hostId);
      if (!host) return;
      // Build with the shared module-scope builders ('ambient-' id stems);
      // _ambNamespaceHtml rewrites the stems to E.idPrefix below.
      const sl = _ambSl, tm = _ambTm, head = _ambHead, shapeSel = _ambShapeSel,
            condCtrl = _ambCondCtrl, modTarget = _ambModTarget, modUi = _ambModUi, fxUi = _ambFxUi;
      // Primary-layer headers read any user-set label from the loaded config.
      const _cfg0 = E.getCfg() || {};
      const _plabel = (k, fb) => _ambLayerLabel(_cfg0[k], fb);
      const _keyNames = (typeof CHROMATIC !== 'undefined' && Array.isArray(CHROMATIC) && CHROMATIC.length === 12)
        ? CHROMATIC : ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
      const keyOpts = _keyNames.map((nm, i) => '<option value="' + i + '">' + nm + '</option>').join('');
      let html =
        // Everything above the first layer (viz + global Bloom settings) lives in
        // one collapsible menu so the panel opens straight onto the layer stack.
        '<details class="ambient-master-menu">' +
        '<summary class="ambient-master-summary">⚙ Configure</summary>' +
        '<div class="ambient-master-menu-body">' +
        '<canvas id="ambient-viz" class="ambient-viz"></canvas>' +
        '<div class="ambient-row">' +
          '<button type="button" id="ambient-regen-btn" class="ambient-regen" title="New random seed">✨ Regenerate</button>' +
          '<button type="button" id="ambient-reset-btn" class="ambient-regen" title="Reset this Bloom to defaults (one Bed, default settings)">↺ Reset</button>' +
          (E.isLane ? '<button type="button" id="ambient-freeze-btn" class="ambient-regen" title="Print the generated output to a new editable lane">❄ Freeze→lane</button>' : '') +
          '<span class="ambient-seed" id="ambient-seed-val">#1</span>' +
        '</div>' +
        (E.isLane ? '' :
          '<div class="ambient-row ambient-listen-row">' +
            '<button type="button" id="ambient-listen-btn" class="ambient-seg" title="Always listening: continuously buffer the last ~30s of everything playing">🎙 Listen</button>' +
            '<button type="button" id="ambient-grab-btn" class="ambient-regen" title="Save the buffered last 30s as a sample">⤓ Grab 30s</button>' +
            '<span class="ambient-hint" id="ambient-listen-hint">off</span>' +
          '</div>') +
        '<div class="ambient-row ambient-timing">' +
          '<span class="ambient-hint">Timing</span>' +
          '<button type="button" class="ambient-seg" id="ambient-timing-free">Free</button>' +
          '<button type="button" class="ambient-seg" id="ambient-timing-sync">Sync</button>' +
        '</div>' +
        // Queue mode — when on, a layer on/off click is deferred to that
        // layer's OWN next iteration boundary instead of applying immediately.
        '<div class="ambient-row ambient-queue">' +
          '<span class="ambient-hint">Queue</span>' +
          '<button type="button" class="ambient-seg" id="ambient-queue-on" title="Queue mode — a layer on/off toggle applies on that layer&#39;s next iteration boundary (its own loop/phrase end) instead of immediately">Off</button>' +
          '<button type="button" class="ambient-seg" id="ambient-queue-tails" title="Tails — when a queued STOP cuts a layer, let its reverb keep feeding past the boundary so the wet tail rings out (off = cut the reverb send with the gate)">Tails</button>' +
          '<span class="ambient-hint" id="ambient-queue-hint">toggles snap to each layer&#39;s loop</span>' +
        '</div>' +
        // Instance Key — when on, every layer roots its scales/wraps/chords at
        // the chosen root and snaps chord/wrap tones to that key's scale.
        '<div class="ambient-row ambient-key">' +
          '<button type="button" class="ambient-seg" id="ambient-key-on" title="Constrain every layer to one key — only in-key scales/chords (plus borrowed &amp; passing tones) are selectable">Key</button>' +
          '<select id="ambient-key-root" class="ambient-select" title="Key root">' + keyOpts + '</select>' +
          '<select id="ambient-key-scale" class="ambient-select" title="Key quality (defines the in-key note set)"></select>' +
          '<span class="ambient-hint" id="ambient-key-hint">off</span>' +
        '</div>' +
        tm('Prog rate', 'ambient-prog-rate', 500, 8000, 100, 4000) +
        tm('Freeze length', 'ambient-freeze-len', 1000, 30000, 500, 10000) +
        // Master Warmth (global FX) — same controls as the FX panel's Warmth
        // section, surfaced here above Reverb. GLOBAL: this is the master-chain
        // warmth that affects ALL output (every lane + grid), not just Bloom —
        // Bloom passes through it on masterBus. Master Bloom only (not lanes).
        (E.isLane ? '' :
          '<div class="ambient-warmth">' +
            '<div class="ambient-warmth-head"><span class="ambient-mod-sub">Warmth</span>' +
              '<button type="button" class="ambient-seg" id="ambient-warmth-on" title="Master warmth bypass — tilt EQ + presence dip + soft saturation. Global: affects all output, not only Bloom.">On</button>' +
              '<span class="ambient-hint">global · all output</span></div>' +
            '<div class="ambient-ctrl"><label for="ambient-warmth">Warmth</label><input type="range" id="ambient-warmth" min="0" max="100" step="1" value="30" /><span class="ambient-hint" id="ambient-warmth-v"></span></div>' +
            '<div class="ambient-ctrl"><label for="ambient-warmth-drive">Drive</label><input type="range" id="ambient-warmth-drive" min="0" max="100" step="1" value="12" /><span class="ambient-hint" id="ambient-warmth-drive-v"></span></div>' +
            '<div class="ambient-ctrl"><label for="ambient-warmth-cut">High cut</label><input type="range" id="ambient-warmth-cut" min="2000" max="20000" step="500" value="16000" /><span class="ambient-hint" id="ambient-warmth-cut-v"></span></div>' +
          '</div>') +
        // Dedicated reverb (fed by each layer's "Reverb send").
        '<div class="ambient-reverb"><div class="ambient-mod-sub">Reverb</div>' +
          sl('Size', 'ambient-reverb-size', 0, 100, 80, 'small → large') +
          sl('Damp', 'ambient-reverb-damp', 0, 100, 45, 'bright → dark') +
        '</div>' +
        '</div></details>' +   // end .ambient-master-menu-body / .ambient-master-menu
        // Mixer — one vertical fader per layer for balancing overall levels in
        // one place. Collapsible; the strip is (re)rendered by _ambRenderMixer
        // whenever the layer set changes.
        '<div class="ambient-mixer collapsed" id="ambient-mixer">' +
          '<div class="ambient-mixer-head">' +
            '<button type="button" class="ambient-mixer-toggle" id="ambient-mixer-toggle" title="Collapse / expand the mixer">▸</button>' +
            '<span class="ambient-mod-sub">Mixer</span>' +
          '</div>' +
          '<div class="ambient-mixer-strip" id="ambient-mixer-strip"></div>' +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head(_plabel('bed', 'Bed'), 'ambient-bed-on', 'ambient-bed-del', 'bed') +
          '<div class="ambient-ctrl"><label for="ambient-bed-tone">Tone</label><select id="ambient-bed-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          _ambNotesButtonHtml('ambient-bed') +
          sl('Density', 'ambient-bed-density', 1, 8, 4, 'voices') +
          sl('Register', 'ambient-bed-register', 2, 6, 4, 'octave') +
          sl('Spread', 'ambient-bed-spread', 0, 3, 2, '± oct') +
          tm('Interval', 'ambient-bed-interval', 200, 12000, 50, 4750) +
          _ambUnitSyncHtml('ambient-bed') +
          tm('Length', 'ambient-bed-length', 300, 16000, 100, 6650) +
          sl('Drift', 'ambient-bed-drift', 0, 99, 0, 'phase offset') +
          condCtrl('bed') +
          sl('Motion', 'ambient-bed-motion', 0, 100, 30, 'detune') +
          sl('Strum', 'ambient-bed-strum', 0, 100, 0, 'chord → arp') +
          sl('Fidelity', 'ambient-bed-strumfid', 0, 100, 0, 'in order → random') +
          sl('Level', 'ambient-bed-level', 0, 100, 70, 'soft → boost') +
          _ambSpreadCtrl('ambient-bed', null) +
          modUi('bed') +
          fxUi('bed') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head(_plabel('motif', 'Motif'), 'ambient-motif-on', 'ambient-motif-del', 'motif') +
          '<div class="ambient-ctrl"><label for="ambient-motif-tone">Tone</label><select id="ambient-motif-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          _ambNotesButtonHtml('ambient-motif') +
          sl('Register', 'ambient-motif-register', 2, 7, 5, 'octave') +
          sl('Range', 'ambient-motif-range', 1, 4, 2, '± oct') +
          sl('Proximity', 'ambient-motif-proximity', 0, 100, 35, 'adjacent → leaps') +
          tm('Interval', 'ambient-motif-interval', 100, 4000, 20, 1200) +
          _ambUnitSyncHtml('ambient-motif') +
          tm('Length', 'ambient-motif-length', 80, 4000, 20, 1000) +
          sl('Drift', 'ambient-motif-drift', 0, 99, 0, 'phase offset') +
          condCtrl('motif') +
          sl('Rests', 'ambient-motif-rest', 0, 100, 30, '%') +
          sl('Twist', 'ambient-motif-twist', 0, 100, 0, 'steady → bursts') +
          sl('Accent', 'ambient-motif-accent', 0, 100, 0, 'flat → dynamic') +
          sl('Level', 'ambient-motif-level', 0, 100, 70, 'soft → boost') +
          _ambSpreadCtrl('ambient-motif', null) +
          modUi('motif') +
          fxUi('motif') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head(_plabel('texture', 'Texture'), 'ambient-texture-on', 'ambient-texture-del', 'texture') +
          '<div class="ambient-ctrl"><label for="ambient-texture-tone">Tone</label><select id="ambient-texture-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          _ambNotesButtonHtml('ambient-texture') +
          sl('Register', 'ambient-texture-register', 3, 7, 6, 'octave') +
          sl('Fill', 'ambient-texture-fill', 0, 100, 35, 'sparse→busy') +
          tm('Interval', 'ambient-texture-interval', 80, 2000, 10, 450) +
          _ambUnitSyncHtml('ambient-texture') +
          tm('Length', 'ambient-texture-length', 60, 2000, 10, 300) +
          sl('Drift', 'ambient-texture-drift', 0, 99, 0, 'phase offset') +
          condCtrl('texture') +
          sl('Mutate', 'ambient-texture-mutate', 0, 100, 40, 'slow→fast') +
          sl('Level', 'ambient-texture-level', 0, 100, 70, 'soft → boost') +
          _ambSpreadCtrl('ambient-texture', null) +
          modUi('texture') +
          fxUi('texture') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head(_plabel('beat', 'Beat'), 'ambient-beat-on', 'ambient-beat-del', 'beat') +
          '<div class="ambient-ctrl"><label for="ambient-beat-kit">Kit</label>' +
            '<select id="ambient-beat-kit" class="ambient-select"></select><span class="ambient-hint">drums</span></div>' +
          _ambGenSel('ambient-beat-') +
          _ambRateSel('ambient-beat-rate') +
          tm('Interval', 'ambient-beat-interval', 80, 2000, 10, 500) +
          _ambUnitSyncHtml('ambient-beat') +
          sl('Phrase', 'ambient-beat-bars', 1, 8, 1, 'bars (euclid)') +
          sl('Pulses', 'ambient-beat-pulses', 1, 16, 4, 'euclid hits / bar') +
          sl('Steps', 'ambient-beat-steps', 2, 16, 8, 'euclid steps / bar') +
          sl('Rotate', 'ambient-beat-rotate', 0, 15, 0, 'euclid offset') +
          tm('Length', 'ambient-beat-length', 60, 2000, 10, 200) +
          sl('Drift', 'ambient-beat-drift', 0, 99, 0, 'phase offset') +
          condCtrl('beat') +
          sl('Rhythm var', 'ambient-beat-rhythmVar', 0, 100, 0, 'stochastic') +
          sl('Rests', 'ambient-beat-rest', 0, 100, 25, '%') +
          sl('Level', 'ambient-beat-level', 0, 100, 70, 'soft → boost') +
          _ambSpreadCtrl('ambient-beat', null) +
          modUi('beat') +
          fxUi('beat') +
        '</div>' +
        // Extra generative instances render here (below the built-in Bed/Motif/
        // Texture/Beat block above). The Add button follows so it always sits at
        // the BOTTOM of the generative-layer list, not stranded in the middle.
        '<div class="ambient-seq-layers" id="ambient-extra-layers"></div>' +
        // Add-layer button — Bloom starts with just Bed; this adds the other
        // built-in layer types (Motif / Texture / Beat) on demand.
        '<div class="ambient-add-layer-row">' +
          '<button type="button" class="ambient-regen ambient-add-layer" id="ambient-add-layer" title="Add a generative layer">+ Add generative layer</button>' +
        '</div>' +
        '<div class="ambient-seq-layers" id="ambient-seq-layers"></div>' +
        '<div class="ambient-seq-layers" id="ambient-sample-layers"></div>' +
        // Parameter ramps — LFO automation of a layer param (A→B, period, wave).
        '<div class="ambient-ramps-section">' +
          '<div class="ambient-ramps-head"><span class="ambient-mod-sub">Ramps</span>' +
            '<button type="button" class="ambient-regen ambient-ramp-add" id="ambient-ramp-add" title="Add a parameter ramp">+ Add ramp</button></div>' +
          '<div class="ambient-ramps" id="ambient-ramps"></div>' +
        '</div>' +
        '<div class="ambient-note">' + (E.isLane ? 'Routes through this lane’s bus — dial in its Reverb send for the full wash.' : 'Plays through the master bus, independent of lanes.') + ' Follows the current Scale &amp; Key. Use “Send to Bloom” on a saved sequence' + (E.isLane ? ' or a lane' : '') + ' to add Seq layers.</div>' +
        // Capture bank — ⤓ Capture records takes here; upload each to Drive
        // when ready so an upload error never loses the audio.
        '<div class="ambient-capture-bank"></div>' +
        // Play / Stop transport — pinned to the bottom of the viewport, styled
        // like the Make footer transport. Lives inside the (namespaced) panel so
        // it only shows while this Bloom panel is the active view.
        '<div class="ambient-footer-bar"><div class="ambient-footer-transport">' +
          // Shape It (master only) — turn every Bloom layer into its own master
          // Shapes wheel. Sits to the left of Capture.
          (!E.isLane ? '<button type="button" id="ambient-shapeit-btn" class="ambient-footer-shapeit" title="Shape It — send every layer to master Shapes as its own wheel">⬡</button>' : '') +
          '<span class="ambient-elapsed" id="ambient-elapsed" title="Elapsed play time (MM:SS:hundredths) — resets on Stop">00:00:00</span>' +
          '<button type="button" id="ambient-export-btn" class="ambient-footer-capture" title="Record Bloom into the capture bank — pick a length or record live">⤓</button>' +
          '<button type="button" id="ambient-play-btn" class="ambient-play" title="Play / stop">▶</button>' +
        '</div></div>';
      host.innerHTML = _ambNamespaceHtml(E, html);
      try { _ambRenderCaptureBank(); } catch (e) {}

      // Per-layer expand/collapse: the caret in each layer head folds that
      // layer's body away (the on/off toggle stays). UI-only state on the DOM —
      // the panel is built once, so it survives lane switches; not persisted.
      host.querySelectorAll('.ambient-collapse').forEach(btn => {
        btn.addEventListener('click', () => {
          const layer = btn.closest('.ambient-layer');
          if (layer) layer.classList.toggle('collapsed');
        });
      });
      // Mixer collapse toggle (UI-only; the strip itself is re-rendered by
      // _ambRenderMixer as layers change).
      { const mxBtn = host.querySelector('.ambient-mixer-toggle');
        if (mxBtn) mxBtn.addEventListener('click', () => {
          const mx = mxBtn.closest('.ambient-mixer');
          if (mx) { const c = mx.classList.toggle('collapsed'); mxBtn.textContent = c ? '▸' : '▾'; }
        });
        try { _ambRenderMixer(E); } catch (e) {}
      }
      // Per-layer Freeze button — one delegated handler (buttons get rebuilt as
      // dynamic layers re-render; data-fkey carries the layer key).
      host.addEventListener('click', (e) => {
        const rb = e.target && e.target.closest && e.target.closest('.ambient-rename-btn');
        if (rb) { e.stopPropagation(); try { _ambRenameLayer(E, rb); } catch (err) { console.warn('Rename failed', err); } return; }
        const sb = e.target && e.target.closest && e.target.closest('.ambient-solo-btn');
        if (sb) { e.stopPropagation(); try { _ambToggleSolo(E, sb.dataset.skey); } catch (err) { console.warn('Solo failed', err); } return; }
        const fb = e.target && e.target.closest && e.target.closest('.ambient-freeze-btn');
        if (!fb) return;
        e.stopPropagation();
        try { _ambFreezeCycle(E, fb.dataset.fkey); } catch (err) { console.warn('Freeze failed', err); }
      });
      // Any in-panel param change (slider / rate / notes / passes…) can change a
      // layer's unit length — refresh the header readouts.
      const _unitRefresh = () => { try { _ambSyncLayerUnits(E); } catch (e) {} };
      host.addEventListener('input', _unitRefresh);
      host.addEventListener('change', _unitRefresh);
      _ambFreezeSyncAll(E);
      _ambSoloSyncAll(E);

      // Per-section Tone dropdowns: "Grid voice" (follow cellParams[0]) plus
      // every melodic tone from getAllSoundOptions (drum kits excluded — Beat
      // owns those). Populated once; the core SOUNDS + remote instruments are
      // registered synchronously at startup so the list is essentially full.
      const G = (id) => _ambGet(E, id);                 // prefix-aware lookup
      const cfg0 = () => E.getCfg();
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const wireSelect = (id, layer, key, populate) => {
        const sel = G(id);
        if (!sel) return;
        populate(sel);
        sel.addEventListener('change', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg[layer][key] = sel.value || '';
          persist();
        });
      };
      ['bed', 'motif', 'texture'].forEach(layer => {
        wireSelect('ambient-' + layer + '-tone', layer, 'tone',
          (sel) => populateGroupedToneSelect(sel, _ambToneOptions(), _ambGridVoiceOption()));
        // "Notes" source button (Scale / Chord) replaces the old scale select.
        _ambWireNotesBtn(E, 'ambient-' + layer + '-notes', () => { const c = cfg0(); return c ? c[layer] : null; });
      });

      // Mod controls for the fixed layers (seq layers wire their own in the renderer).
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        ['vca', 'vco', 'vcf'].forEach(target => {
          ['depth', 'rate'].forEach(key => {
            const el = G('ambient-' + layer + '-mod-' + target + '-' + key);
            if (!el) return;
            el.addEventListener('input', () => {
              _E = E; const cfg = cfg0(); if (!cfg) return;
              cfg[layer].mod[target][key] = parseInt(el.value, 10) || 0;
              if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
              persist();
            });
          });
          _ambWireModTarget(E, (suf) => G('ambient-' + layer + '-' + suf), () => { const c = cfg0(); return c ? c[layer] : null; }, target, () => { if (E.timer) { try { _ambSyncMods(); } catch (e) {} } });
        });
      });

      const kitSel = G('ambient-beat-kit');
      if (kitSel) {
        _ambDrumKits().forEach(k => {
          const o = document.createElement('option'); o.value = k.id; o.textContent = k.name; kitSel.appendChild(o);
        });
        kitSel.addEventListener('change', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg.beat.kit = kitSel.value || 'tr808';
          persist();
        });
      }
      const beatRateSel = G('ambient-beat-rate');
      if (beatRateSel) beatRateSel.addEventListener('change', () => {
        _E = E; const cfg = cfg0(); if (!cfg) return;
        cfg.beat.rate = beatRateSel.value || '';
        persist();
      });
      const beatGenSel = G('ambient-beat-gen');
      if (beatGenSel) beatGenSel.addEventListener('change', () => {
        _E = E; const cfg = cfg0(); if (!cfg) return;
        cfg.beat.gen = beatGenSel.value || 'random';
        _ambBeatGenVis(E, 'ambient-beat-', cfg.beat);   // primary: no UnitSyncViz p
        if (E.runPhase) delete E.runPhase['beat']; if (E.clocks) delete E.clocks['beat'];
        persist();
      });

      const bind = (id, layer, key) => {
        const el = G(id);
        if (!el) return;
        el.addEventListener('input', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          if (layer === null) cfg[key] = parseInt(el.value, 10) || 0;
          else cfg[layer][key] = parseInt(el.value, 10) || 0;
          persist();
        });
      };
      const bindTime = (id, layer, key) => {
        const el = G(id);
        const vEl = G(id + '-v');
        if (!el) return;
        el.addEventListener('input', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          const v = parseInt(el.value, 10) || 0;
          cfg[layer][key] = v;
          if (vEl) vEl.textContent = _ambFmtMs(v);
          persist();
        });
      };
      { const el = G('ambient-prog-rate'), vEl = G('ambient-prog-rate-v');
        if (el) el.addEventListener('input', () => { _E = E; const c = cfg0(); if (!c) return; const v = parseInt(el.value, 10) || 4000; c.progRateMs = v; if (vEl) vEl.textContent = _ambFmtMs(v); persist(); }); }
      { const el = G('ambient-freeze-len'), vEl = G('ambient-freeze-len-v');
        if (el) el.addEventListener('input', () => { _E = E; const c = cfg0(); if (!c) return; const v = parseInt(el.value, 10) || 10000; c.freezeLenMs = v; if (vEl) vEl.textContent = _ambFmtMs(v); persist(); }); }
      // Reverb Size / Damp → live reverb node.
      ['size', 'damp'].forEach(key => {
        const el = G('ambient-reverb-' + key); if (!el) return;
        el.addEventListener('input', () => {
          _E = E; const cfg = cfg0(); if (!cfg || !cfg.reverb) return;
          cfg.reverb[key] = parseInt(el.value, 10) || 0;
          _ambApplyReverb();
          persist();
        });
      });
      // Master Warmth (global FX). Writes globalFx and drives the master-chain
      // warmth stage — same target as the FX panel's Warmth section, so this is
      // a second view onto one global setting (affects all output, not only
      // Bloom). Master Bloom only; G() returns null on lane Bloom.
      { const wireWarmth = (stem, key, unit) => {
          const el = G(stem); if (!el) return;
          const vEl = G(stem + '-v');
          el.addEventListener('input', () => {
            const v = parseInt(el.value, 10) || 0;
            if (typeof globalFx !== 'undefined' && globalFx) globalFx[key] = v;
            if (vEl) vEl.textContent = v + unit;
            try { applyGlobalFx(); } catch (e) {}
            try { persistGlobalFx(); } catch (e) {}
          });
        };
        wireWarmth('ambient-warmth', 'warmth', '%');
        wireWarmth('ambient-warmth-drive', 'warmthDrive', '%');
        wireWarmth('ambient-warmth-cut', 'warmthCut', ' Hz');
        const wOn = G('ambient-warmth-on');
        if (wOn) wOn.addEventListener('click', () => {
          if (typeof globalFx === 'undefined' || !globalFx) return;
          globalFx.warmthOn = !(globalFx.warmthOn !== false);
          const on = globalFx.warmthOn !== false;
          wOn.classList.toggle('active', on); wOn.textContent = on ? 'On' : 'Off';
          try { applyGlobalFx(); } catch (e) {}
          try { persistGlobalFx(); } catch (e) {}
        });
      }
      bind('ambient-bed-density', 'bed', 'density');
      bind('ambient-bed-register', 'bed', 'register');
      bind('ambient-bed-spread', 'bed', 'spread');
      bindTime('ambient-bed-interval', 'bed', 'intervalMs');
      bindTime('ambient-bed-length', 'bed', 'lengthMs');
      bind('ambient-bed-drift', 'bed', 'drift');
      bind('ambient-bed-motion', 'bed', 'motion');
      bind('ambient-bed-strum', 'bed', 'strum');
      bind('ambient-bed-strumfid', 'bed', 'strumFidelity');
      bind('ambient-bed-level', 'bed', 'level');
      bind('ambient-motif-register', 'motif', 'register');
      bind('ambient-motif-range', 'motif', 'range');
      bind('ambient-motif-proximity', 'motif', 'proximity');
      bindTime('ambient-motif-interval', 'motif', 'intervalMs');
      bindTime('ambient-motif-length', 'motif', 'lengthMs');
      bind('ambient-motif-drift', 'motif', 'drift');
      bind('ambient-motif-rest', 'motif', 'restProb');
      bind('ambient-motif-twist', 'motif', 'twist');
      bind('ambient-motif-accent', 'motif', 'accent');
      bind('ambient-motif-level', 'motif', 'level');
      bind('ambient-texture-register', 'texture', 'register');
      bind('ambient-texture-fill', 'texture', 'fill');
      bindTime('ambient-texture-interval', 'texture', 'intervalMs');
      bindTime('ambient-texture-length', 'texture', 'lengthMs');
      bind('ambient-texture-drift', 'texture', 'drift');
      bind('ambient-texture-mutate', 'texture', 'mutateRate');
      bind('ambient-texture-level', 'texture', 'level');
      bindTime('ambient-beat-interval', 'beat', 'intervalMs');
      bindTime('ambient-beat-length', 'beat', 'lengthMs');
      bind('ambient-beat-bars', 'beat', 'bars');
      bind('ambient-beat-pulses', 'beat', 'pulses');
      bind('ambient-beat-steps', 'beat', 'steps');
      bind('ambient-beat-rotate', 'beat', 'rotate');
      bind('ambient-beat-rhythmVar', 'beat', 'rhythmVar');
      bind('ambient-beat-drift', 'beat', 'drift');
      bind('ambient-beat-rest', 'beat', 'restProb');
      bind('ambient-beat-level', 'beat', 'level');
      ['bed', 'motif', 'texture', 'beat'].forEach(layer =>
        _ambWireSpread(E, 'ambient-' + layer, () => { const c = cfg0(); return c ? c[layer] : null; }, persist, null));
      // Per-layer FX (reverb send / delay / distortion). Apply live when playing.
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        const fxBind = (suf, setter) => {
          const el = G('ambient-' + layer + '-fx-' + suf); if (!el) return;
          const vEl = G('ambient-' + layer + '-fx-' + suf + '-v');
          el.addEventListener('input', () => {
            _E = E; const cfg = cfg0(); if (!cfg || !cfg[layer]) return;
            const v = parseInt(el.value, 10) || 0; setter(cfg[layer], v);
            if (vEl) vEl.textContent = _ambFmtMs(v);
            if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
            persist();
          });
        };
        fxBind('rev', (lc, v) => { lc.revSend = v; });
        fxBind('dly-mix', (lc, v) => { lc.delay.mix = v; });
        fxBind('dly-time', (lc, v) => { lc.delay.timeMs = v; });
        fxBind('dly-fb', (lc, v) => { lc.delay.feedback = v; });
        fxBind('dist-amt', (lc, v) => { lc.dist.amount = v; });
        fxBind('dist-mix', (lc, v) => { lc.dist.mix = v; });
      });
      const bindCond = (layer) => {
        const grid = G('ambient-' + layer + '-when');
        if (!grid) return;
        _ambWireWhenToggle(grid);
        if (grid._ambBound) return;
        grid._ambBound = true;
        grid.addEventListener('click', (e) => {
          const cell = e.target && e.target.closest ? e.target.closest('.ambient-when-cell') : null;
          if (!cell || !grid.contains(cell)) return;
          _E = E; const cfg = cfg0(); if (!cfg) return;
          const cells = _ambWhenGridCells(cfg[layer].when);
          const idx = Math.max(0, Math.min(15, parseInt(cell.getAttribute('data-step'), 10) || 0));
          cells[idx] = !cells[idx];
          cfg[layer].when = _ambGridToWhen(cells);
          _ambPaintWhenGrid(grid, cfg[layer].when);
          persist();
        });
      };
      ['bed', 'motif', 'texture', 'beat'].forEach(bindCond);
      ['bed', 'motif', 'texture', 'beat'].forEach(layer =>
        _ambWireUnitSync(E, 'ambient-' + layer + '-', () => { const c = cfg0(); return c ? c[layer] : null; }, layer));

      const toggle = (id, layer) => {
        const el = G(id);
        if (!el) return;
        el.addEventListener('click', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          _ambToggleLayer(E, layer, cfg[layer], el, persist);
        });
      };
      toggle('ambient-bed-on', 'bed');
      toggle('ambient-motif-on', 'motif');
      toggle('ambient-texture-on', 'texture');
      toggle('ambient-beat-on', 'beat');

      ['free', 'sync'].forEach(t => {
        const el = G('ambient-timing-' + t);
        if (el) el.addEventListener('click', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg.timing = t; _ambSyncControls(E);
          persist();
        });
      });

      { const qOn = G('ambient-queue-on');
        if (qOn) qOn.addEventListener('click', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg.queueMode = !cfg.queueMode;
          // Turning Queue off applies any pending toggles now so nothing dangles.
          if (!cfg.queueMode && E._queuePending && Object.keys(E._queuePending).length) { try { _ambApplyQueued(E); } catch (e) {} }
          _ambSyncControls(E); persist();
        });
      }
      { const qT = G('ambient-queue-tails');
        if (qT) qT.addEventListener('click', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg.tails = !cfg.tails; _ambSyncControls(E); persist();
        });
      }

      { const kOn = G('ambient-key-on');
        if (kOn) kOn.addEventListener('click', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg.keyOn = !cfg.keyOn; _ambSyncControls(E); persist();
        });
        const kRoot = G('ambient-key-root');
        if (kRoot) kRoot.addEventListener('change', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg.keyRoot = ((((parseInt(kRoot.value, 10) || 0) % 12) + 12) % 12);
          _ambSyncControls(E); persist();
        });
        const kScale = G('ambient-key-scale');
        if (kScale) {
          try { populateGroupedScaleSelect(kScale, null); } catch (e) {}
          const c0 = cfg0(); if (c0) kScale.value = c0.keyScale || 'major';
          kScale.addEventListener('change', () => {
            _E = E; const cfg = cfg0(); if (!cfg) return;
            cfg.keyScale = kScale.value || 'major';
            _ambSyncControls(E); persist();
          });
        }
      }

      const addRampBtn = G('ambient-ramp-add');
      if (addRampBtn) addRampBtn.addEventListener('click', () => _ambAddRamp(E));

      // Add-layer menu — lists the built-in layer types not currently present.
      const addLayerBtn = G('ambient-add-layer');
      if (addLayerBtn) addLayerBtn.addEventListener('click', () => {
        _E = E; const cfg = cfg0(); if (!cfg) return;
        const LABELS = { bed: 'Bed', motif: 'Motif', texture: 'Texture', beat: 'Beat' };
        // Always offer all four types. Picking one activates the absent primary,
        // or — if the primary is already present — adds another instance.
        const actions = ['bed', 'motif', 'texture', 'beat'].map(l => {
          const primaryAbsent = !!(cfg[l] && cfg[l].present === false);
          return { label: LABELS[l] + (primaryAbsent ? '' : ' (+1)'), fn: () => (primaryAbsent ? _ambAddLayer(E, l) : _ambAddExtra(E, l)) };
        });
        // Shape: a generative wheel layer (extras-only, no primary slot).
        actions.push({ label: 'Shape', fn: () => _ambAddExtra(E, 'shape') });
        // Arp: arpeggiates through a built series of scales/chords (extras-only).
        actions.push({ label: 'Arp', fn: () => _ambAddExtra(E, 'arp') });
        // Bass: low euclidean phrase locked to BPM (extras-only).
        actions.push({ label: 'Bass', fn: () => _ambAddExtra(E, 'bass') });
        // Run: a fixed random note run that loops every N bars (extras-only).
        actions.push({ label: 'Run', fn: () => _ambAddExtra(E, 'run') });
        // Pedal: a simple root-note pedal-point loop (extras-only).
        actions.push({ label: 'Pedal', fn: () => _ambAddExtra(E, 'pedal') });
        // Drone: holds a note/chord, re-struck every N units (extras-only).
        actions.push({ label: 'Drone', fn: () => _ambAddExtra(E, 'drone') });
        const r = addLayerBtn.getBoundingClientRect();
        if (typeof showCtxMenu === 'function') showCtxMenu(r.left, r.bottom + 4, actions);
        else _ambAddExtra(E, 'bed');
      });
      // Delete (✕) on each built-in layer head → remove it (settings retained).
      ['bed', 'motif', 'texture', 'beat'].forEach(l => {
        const delB = G('ambient-' + l + '-del');
        if (delB) delB.addEventListener('click', () => _ambRemoveLayer(E, l));
      });

      const playBtn = G('ambient-play-btn');
      if (playBtn) playBtn.addEventListener('click', () => { if (E.timer) _ambStopGenerator(E); else _ambStartGenerator(E); });
      const regenBtn = G('ambient-regen-btn');
      if (regenBtn) regenBtn.addEventListener('click', () => {
        _E = E; const cfg = cfg0(); if (!cfg) return;
        const t = (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
        cfg.seed = ((cfg.seed * 1664525 + 1013904223 + Math.floor(t * 1000)) >>> 0) || 1;
        if (E.timer) { _ambResetClocks(E); _ambSeed(cfg.seed); }
        _ambSyncControls(E);
        persist();
      });
      const resetBtn = G('ambient-reset-btn');
      if (resetBtn) resetBtn.addEventListener('click', () => { try { _ambResetInstance(E); } catch (e) { console.warn('Bloom reset failed', e); } });
      // "Always listening" — master only; rolling capture of the master output.
      if (!E.isLane) {
        const listenBtn = G('ambient-listen-btn'), grabBtn = G('ambient-grab-btn'), lHint = G('ambient-listen-hint');
        const syncAL = () => {
          if (listenBtn) listenBtn.classList.toggle('active', _AL.on);
          if (lHint) lHint.textContent = _AL.on ? 'buffering…' : 'off';
          if (grabBtn) grabBtn.disabled = !_AL.on;
        };
        if (listenBtn) listenBtn.addEventListener('click', () => { if (_AL.on) _alStop(); else _alStart(); syncAL(); });
        if (grabBtn) grabBtn.addEventListener('click', () => _alGrab(30));
        syncAL();
      }
      if (E.isLane) {
        const freezeBtn = G('ambient-freeze-btn');
        if (freezeBtn) freezeBtn.addEventListener('click', () => { try { _ambFreezeToLane(); } catch (e) { console.warn('Bloom freeze failed', e); } });
      }
      const exportBtn = G('ambient-export-btn');
      if (exportBtn) exportBtn.addEventListener('click', () => { _ambCaptureToBank(E); });
      if (!E.isLane) {
        const shapeitBtn = G('ambient-shapeit-btn');
        if (shapeitBtn) shapeitBtn.addEventListener('click', () => { try { _ambShapeItAll(E); } catch (e) { console.warn('Shape It failed', e); } });
      }

      E.inited = true;
      _ambSyncControls(E);
      _ambStartViz(E);
    }

    // ---- Mode entry/exit (called by _syncFluidGridToActiveLane) ---------
    // The per-lane engine. The master engine has its own lifecycle (Mix view).
    function _onAmbientModeChanged(active) {
      if (active) { _ambientInit(_laneEng); }
      else { _ambStopGenerator(_laneEng); _ambStopViz(_laneEng); }
    }
    // Build/refresh the master Bloom panel (Mix view). Called from the Mix tab.
    function _ambInitMaster() { try { _ambientInit(_masterEng); } catch (e) {} }
    // Lane→lane switch where BOTH lanes are Bloom (so _onAmbientModeChanged does
    // not fire). Rebind the lane engine to the now-active lane: if it was
    // playing, restart it cleanly; otherwise just refresh the panel.
    function _ambRetargetLane() {
      if (!_laneEng.inited) return;
      try {
        if (_laneEng.timer) { _ambStopGenerator(_laneEng); _ambStartGenerator(_laneEng); }
        else _ambSyncControls(_laneEng);
      } catch (e) {}
    }
