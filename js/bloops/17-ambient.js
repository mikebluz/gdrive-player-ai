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
        bed:     { on: true,  density: 4, register: 4, spread: 2, intervalMs: 4750, lengthMs: 6650, motion: 30, drift: 0, when: 'always', level: 70, strum: 0, strumFidelity: 0, tone: '', scale: '', mod: _ambDefaultMod(), ..._ambDefaultFx() },
        motif:   { on: false, register: 5, range: 2, intervalMs: 1200, lengthMs: 1000, restProb: 30, twist: 0, drift: 0, when: 'always', level: 70, tone: '', scale: '', mod: _ambDefaultMod(), ..._ambDefaultFx() },
        texture: { on: false, register: 6, fill: 35, intervalMs: 450, lengthMs: 300, mutateRate: 40, drift: 0, when: 'always', level: 70, tone: '', scale: '', mod: _ambDefaultMod(), ..._ambDefaultFx() },
        beat:    { on: false, kit: 'tr808', intervalMs: 500, lengthMs: 200, restProb: 25, drift: 0, when: 'always', level: 70, mod: _ambDefaultMod(), ..._ambDefaultFx() },
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
    const _masterEng = _makeAmbientEngine({
      getCfg:  function () { masterAmbient = masterAmbient || _defaultAmbientConfig(); return _normalizeAmbientCfg(masterAmbient); },
      busNode: function () { return (typeof masterBus !== 'undefined' && masterBus) ? masterBus : Tone.getDestination(); },
      laneIdx: function () { return null; },
      guard:   function () { return true; },
      hostId: 'mix-bloom-host', idPrefix: 'mix-bloom', vizId: 'mix-bloom-viz',
      playId: 'mix-bloom-play-btn', seedId: 'mix-bloom-seed-val', isLane: false,
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
    // { events:[{freqs:number[],durMs,vel}], scale, rootIdx, baseOctave, bpm }.
    // `unitMode`: 'single' (iterate units[0]) | 'interleave' (stochastic pick
    // among units each cycle). `id` is a stable monotonic int; display name is
    // positional (Seq1, Seq2…).
    function _defaultSeqLayer(id) {
      return { id: id | 0, on: true, intervalMs: 2000, lengthMs: 1200, drift: 0, when: 'always',
               level: 70, tone: '', scale: '', mod: _ambDefaultMod(),
               varyMode: 'pitch', varyDepth: 40, returnMode: 'everyN', returnN: 4, returnChance: 25,
               unitMode: 'single', units: [], ..._ambDefaultFx() };
    }
    function _ambValidUnit(u) {
      return !!(u && typeof u === 'object' && Array.isArray(u.events) && u.events.length > 0);
    }
    function _normalizeSeqLayer(s, id) {
      const d = _defaultSeqLayer(id);
      if (!Number.isFinite(s.id)) s.id = id;
      if (typeof s.on !== 'boolean') s.on = true;
      ['intervalMs','lengthMs','drift','level','varyDepth','returnN','returnChance'].forEach(k => { if (!Number.isFinite(s[k])) s[k] = d[k]; });
      ['tone','scale'].forEach(k => { if (typeof s[k] !== 'string') s[k] = d[k]; });
      if (typeof s.when !== 'string') s.when = 'always';
      if (s.varyMode !== 'pitch' && s.varyMode !== 'rhythm' && s.varyMode !== 'pad') s.varyMode = 'pitch';
      if (s.returnMode !== 'everyN' && s.returnMode !== 'chance') s.returnMode = 'everyN';
      if (s.unitMode !== 'single' && s.unitMode !== 'interleave') s.unitMode = 'single';
      if (!Array.isArray(s.units)) s.units = [];
      s.units = s.units.filter(_ambValidUnit);
      _ambNormalizeModObj(s, d.mod);
      _ambNormalizeFx(s);
      _ambNormalizeNotes(s);
      return s;
    }
    // A Sample layer plays a single-buffer `sample:<id>` raw. `chop` 1 = retrigger
    // the whole sample each Interval; N = chop into N slices played across the
    // Interval, in `order` (forward cursor / random). Reuses per-layer mod + FX.
    function _defaultSampleLayer(id) {
      return { id: id | 0, on: true, sampleId: '', name: '',
               chop: 1, order: 'forward',
               intervalMs: 2000, lengthMs: 1200, drift: 0, when: 'always', level: 70,
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
      if (!Number.isFinite(cfg.seed)) cfg.seed = d.seed;
      if (!Number.isFinite(cfg.space)) cfg.space = d.space;
      if (!Number.isFinite(cfg.progRateMs)) cfg.progRateMs = d.progRateMs;
      if (!Number.isFinite(cfg.freezeLenMs)) cfg.freezeLenMs = d.freezeLenMs;
      if (!cfg.reverb || typeof cfg.reverb !== 'object') cfg.reverb = { ...d.reverb };
      else { if (!Number.isFinite(cfg.reverb.size)) cfg.reverb.size = d.reverb.size; if (!Number.isFinite(cfg.reverb.damp)) cfg.reverb.damp = d.reverb.damp; }
      ['bed','motif','texture','beat'].forEach(layer => {
        if (!cfg[layer] || typeof cfg[layer] !== 'object') cfg[layer] = { ...d[layer] };
      });
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
          else if (k === 'kit' || k === 'tone' || k === 'scale' || k === 'when') { if (typeof cfg[layer][k] !== 'string') cfg[layer][k] = d[layer][k]; }
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
        if (x.type !== 'beat') _ambNormalizeNotes(x);
        return x;
      });
      // Parameter ramps (LFO automation of a layer param between A and B).
      if (!Array.isArray(cfg.ramps)) cfg.ramps = [];
      let maxRid = 0;
      cfg.ramps.forEach(r => { if (r && Number.isFinite(r.id) && r.id > maxRid) maxRid = r.id; });
      cfg.ramps.forEach(r => { if (r && !Number.isFinite(r.id)) r.id = ++maxRid; });
      cfg.ramps = cfg.ramps.filter(r => r && typeof r === 'object').map(r => _normalizeRamp(r, r.id));
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
    function _ambResolveScale(scale) {
      if (typeof scale === 'string' && scale && typeof SCALES !== 'undefined' && SCALES[scale]) return scale;
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
    // The current chord of a progression note source (advances with _E.progStep).
    function _ambProgCurrentChord(n) {
      const chs = Array.isArray(n.chords) ? n.chords : [];
      if (!chs.length) return null;
      const step = (_E && Number.isFinite(_E.progStep)) ? (_E.progStep | 0) : 0;
      return chs[((step % chs.length) + chs.length) % chs.length] || null;
    }
    // Interval set for a note source. Chord/Wrap/Prog → pitch-class set; scale → SCALES.
    function _ambScaleIntervals(src) {
      const n = _ambAsNotes(src);
      if (n.type === 'chord') return _ambChordIntervals(n.form, n.inversion);
      if (n.type === 'wrap') { const w = _ambFindWrap(n.id); return (w && Array.isArray(w.intervals) && w.intervals.length) ? w.intervals : [0, 4, 7]; }
      if (n.type === 'prog') { const ch = _ambProgCurrentChord(n); return (ch && Array.isArray(ch.intervals) && ch.intervals.length) ? ch.intervals : [0, 4, 7]; }
      const name = _ambResolveScale(n.scale);
      return (typeof SCALES !== 'undefined' && SCALES[name]) ? SCALES[name] : [0, 2, 4, 5, 7, 9, 11];
    }
    function _ambSrcRootPc(src) {
      const n = _ambAsNotes(src);
      if (n.type === 'chord' && Number.isFinite(n.root)) return ((n.root % 12) + 12) % 12;
      if (n.type === 'wrap') { const w = _ambFindWrap(n.id); if (w && Number.isFinite(w.root)) return ((w.root % 12) + 12) % 12; }
      if (n.type === 'prog') { const ch = _ambProgCurrentChord(n); if (ch && Number.isFinite(ch.root)) return ((ch.root % 12) + 12) % 12; }
      return (typeof rootIdx === 'number') ? rootIdx : 0;
    }
    // Human label for the Notes button.
    function _ambNotesLabel(src) {
      const n = _ambAsNotes(src);
      if (n.type === 'chord') {
        const def = _AMB_CHORD_FORMS.find(c => c[0] === n.form);
        const rootName = (typeof CHROMATIC !== 'undefined' && CHROMATIC[((n.root % 12) + 12) % 12]) || '';
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
              items.push({ label: node.label, disabled: true });
              Array.from(node.children).forEach(o => items.push({ label: '  ' + o.textContent, fn: () => apply({ type: 'scale', scale: o.value }) }));
            } else {
              items.push({ label: node.textContent, fn: () => apply({ type: 'scale', scale: node.value }) });
            }
          });
        } catch (e) {}
        showCtxMenu(x, y, items);
      };
      const wrapSub = () => {
        const wraps = (masterAmbient && Array.isArray(masterAmbient.publishedWraps)) ? masterAmbient.publishedWraps : [];
        if (!wraps.length) {
          showCtxMenu(x, y, [{ label: 'No published wraps', disabled: true }, { label: 'Right-click a wrap chip → Publish to Bloom', disabled: true }]);
          return;
        }
        showCtxMenu(x, y, wraps.map(w => ({ label: '⊕ ' + w.name, fn: () => apply({ type: 'wrap', id: w.id }) })));
      };
      const progSub = () => {
        const items = [{ label: 'Standards', disabled: true }];
        _AMB_PROG_STANDARDS.forEach(([nm, fam, steps]) => items.push({ label: '  ' + nm, fn: () => apply({ type: 'prog', name: nm, chords: _ambResolveStandard(fam, steps) }) }));
        const pub = (masterAmbient && Array.isArray(masterAmbient.publishedProgs)) ? masterAmbient.publishedProgs : [];
        if (pub.length) {
          items.push('hr', { label: 'Published', disabled: true });
          pub.forEach(p => items.push({ label: '  ' + p.name, fn: () => apply({ type: 'prog', name: p.name, chords: (p.chords || []).map(c => ({ root: c.root, intervals: c.intervals })) }) }));
        }
        showCtxMenu(x, y, items);
      };
      showCtxMenu(x, y, [
        { label: 'Scale ▸', fn: () => setTimeout(scaleSub, 0) },
        { label: '♪ Chord…', fn: () => _ambOpenChordPicker(E, getLayer, afterChange) },
        { label: '⊕ Wraps ▸', fn: () => setTimeout(wrapSub, 0) },
        { label: '⇶ Progression ▸', fn: () => setTimeout(progSub, 0) },
      ]);
    }
    function _ambOpenChordPicker(E, getLayer, afterChange) {
      const L = getLayer(); if (!L) return;
      const curN = _ambNotesOf(L);
      const cur = (curN.type === 'chord') ? curN : { form: 'maj', root: (typeof rootIdx === 'number') ? rootIdx : 0, inversion: 0 };
      const CHROM = (typeof CHROMATIC !== 'undefined') ? CHROMATIC : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const ordinal = (i) => i === 0 ? 'Root' : (i === 1 ? '1st' : i === 2 ? '2nd' : i === 3 ? '3rd' : i + 'th');
      const invOptsFor = (form, sel) => {
        const def = _AMB_CHORD_FORMS.find(c => c[0] === form) || _AMB_CHORD_FORMS[0];
        return def[2].map((_, i) => '<option value="' + i + '"' + (i === (sel | 0) ? ' selected' : '') + '>' + ordinal(i) + '</option>').join('');
      };
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const modal = document.createElement('div'); modal.className = 'step-div-modal amb-chord-modal';
      modal.innerHTML = '<div class="keep-sdiv-title">Chord</div>' +
        '<div class="keep-sdiv-row"><span class="keep-sdiv-name">Root</span><select id="amb-chord-root" class="sm-select">' +
          CHROM.map((nm, i) => '<option value="' + i + '"' + (i === (cur.root | 0) ? ' selected' : '') + '>' + nm + '</option>').join('') + '</select></div>' +
        '<div class="keep-sdiv-row"><span class="keep-sdiv-name">Form</span><select id="amb-chord-form" class="sm-select">' +
          _AMB_CHORD_FORMS.map(c => '<option value="' + c[0] + '"' + (c[0] === cur.form ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select></div>' +
        '<div class="keep-sdiv-row"><span class="keep-sdiv-name">Inversion</span><select id="amb-chord-inv" class="sm-select">' + invOptsFor(cur.form, cur.inversion) + '</select></div>' +
        '<div class="keep-sdiv-actions"><button type="button" class="keep-sdiv-apply" id="amb-chord-apply">Apply</button></div>';
      overlay.appendChild(modal); document.body.appendChild(overlay);
      const formSel = modal.querySelector('#amb-chord-form');
      const invSel = modal.querySelector('#amb-chord-inv');
      formSel.addEventListener('change', () => { invSel.innerHTML = invOptsFor(formSel.value, 0); });
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
    // Per-layer Drift (0..99): phase-offset the layer's event grid by that
    // fraction of its Interval (snapped to the step grid in Sync mode).
    function _ambDriftOffset(layer, cfg) {
      const drift = Number.isFinite(layer.drift) ? Math.max(0, Math.min(99, layer.drift)) : 0;
      if (drift <= 0) return 0;
      const intervalSec = Math.max(0.05, (layer.intervalMs | 0) / 1000);
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
      if (!cond || cond === 'always') return true;
      if (cond === '1st') return iter === 0;
      const m = /^(\d+):(\d+)$/.exec(cond);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (b > 0) return (iter % b) === (((a - 1) % b + b) % b);
      }
      return true;
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
      const voicing = _ambPickVoicing(bed);
      if (!voicing.length) return;
      const durMs = Math.max(80, bed.lengthMs | 0);
      const overlap = durMs / Math.max(1, bed.intervalMs | 0);
      const pans = _ambSpacePans(voicing.length, space);
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
      const leap = _ambRand() < 0.18;
      const mag = leap ? 3 + Math.floor(_ambRand() * 3) : 1 + Math.floor(_ambRand() * 2);
      const dir = _ambRand() < 0.5 ? -1 : 1;
      let next = _E.motifDeg + dir * mag;
      if (next < lo) next = lo + (lo - next);
      if (next > hi) next = hi - (next - hi);
      next = Math.max(lo, Math.min(hi, next));
      const degInOct = ((next % N) + N) % N;
      const chordSet = [0, 2, 4].filter(d => d < N);
      if (!chordSet.includes(degInOct) && _ambRand() < 0.45) {
        let best = degInOct, bd = 99;
        chordSet.forEach(c => { const dd = Math.min((c - degInOct + N) % N, (degInOct - c + N) % N); if (dd < bd) { bd = dd; best = c; } });
        next += (best - degInOct);
      }
      _E.motifDeg = next;
      return _ambDegreeFreq(((next % N) + N) % N, Math.floor(next / N), _ambNotesOf(motif));
    }
    function _ambEmitMotif(at, motif, space, key) {
      key = key || 'motif';
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
        const pan = Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, space)));
        const mp = _ambMotifParams(lenMs, pan, motif.tone);
        mp.volume = _ambApplyLevel(mp.volume, motif.level);
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
      if (!_E.texPattern) _ambTexBuildPattern(texture);
      const center = Math.max(1, Math.min(8, texture.register | 0));
      const slot = _E.texPattern[_E.texStep % _E.texPattern.length];
      _E.texStep++;
      if (slot && slot.on) {
        const f = _ambDegreeFreq(slot.deg, center + (_ambRand() < 0.3 ? 1 : 0), _ambNotesOf(texture));
        const lenMs = Math.max(60, texture.lengthMs | 0);
        const pan = Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, space)));
        const tp = _ambTexParams(lenMs, pan, texture.tone);
        tp.volume = _ambApplyLevel(tp.volume, texture.level);
        const dmod = _ambLayerDetuneMod(key); if (dmod) tp._detuneMod = dmod;
        try { playNote(f, tp, lenMs, at, _ambLayerDest(key), undefined, _E.laneIdx()); } catch (e) {}
      }
      const mr = Math.max(0, Math.min(100, texture.mutateRate | 0));
      if (!_E.texMutateAt) _E.texMutateAt = at + (6 - mr / 100 * 5);
      if (at >= _E.texMutateAt) { _ambTexMutate(texture); _E.texMutateAt = at + (6 - mr / 100 * 5); }
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
    // Melodic tone choices for Bed/Motif/Texture: "Grid voice" + every
    // non-drum tone the app offers.
    // Melodic tones for Bed/Motif/Texture (drum kits excluded — Beat owns those).
    // The "Grid voice" follow option is added separately at wiring time, so this
    // returns only the instruments and can be fed straight to the grouped builder.
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
        populateGroupedToneSelect(sel, opts, { value: '', label: 'Grid voice' });
        sel.value = cur;
        if (sel.value !== cur) sel.value = ''; // chosen voice no longer exists → Grid voice
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
      const pan = Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, space)));
      const bp = _ambBeatParams(beat.kit, lenMs, pan);
      bp.volume = _ambApplyLevel(bp.volume, beat.level);
      const dmod = _ambLayerDetuneMod(key); if (dmod) bp._detuneMod = dmod;
      try { playNote(f, bp, lenMs, at, _ambLayerDest(key), undefined, _E.laneIdx()); } catch (e) {}
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
          const freqs = step.chord.filter(n => n && n.freq != null).map(n => n.freq);
          const vel = step.chord.reduce((m, n) => Math.max(m, (n && n.params && Number.isFinite(n.params.volume)) ? n.params.volume : 100), 0) || 100;
          events.push({ freqs, durMs, vel });
        } else if (step.freq != null) {
          const vel = (step.params && Number.isFinite(step.params.volume)) ? step.params.volume : 100;
          events.push({ freqs: [step.freq], durMs, vel });
        } else {
          events.push({ freqs: [], durMs, vel: 0 }); // rest preserves timing
        }
      };
      saved.steps.forEach(s => {
        if (s && Array.isArray(s.subSteps) && s.subSteps.length) s.subSteps.forEach(pushFrom);
        else pushFrom(s);
      });
      if (!events.length) return null;
      return { events, scale: saved.scale || '', rootIdx: saved.rootIdx | 0, baseOctave: saved.baseOctave | 0, bpm };
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
      return (out > 0) ? out : freq;
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
      const pans = _ambSpacePans(chop, space);
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
    function _ambEmitSeq(at, seq, space, st) {
      if (!Array.isArray(seq.units) || !seq.units.length) return;
      // Pick the unit for this cycle: 'single' iterates units[0]; 'interleave'
      // stochastically picks among the units so the layer wanders between them.
      let unit;
      if (seq.unitMode === 'interleave' && seq.units.length > 1) {
        st.pick = Math.floor(_ambRand() * seq.units.length);
        unit = seq.units[st.pick];
      } else {
        unit = seq.units[0];
      }
      if (!_ambValidUnit(unit)) return;
      const seed = unit; // walk/pad code below reads `seed`
      const key = 'seq:' + seq.id;
      const dest = _ambLayerDest(key), dmod = _ambLayerDetuneMod(key);
      const depth = Math.max(0, Math.min(100, seq.varyDepth | 0)) / 100;
      const base = (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : { type: 'sine' };
      const type = _ambLayerType(seq.tone);
      // Verbatim (return-to-original) decision for THIS cycle, on the picked unit.
      let verbatim;
      if (seq.returnMode === 'chance') {
        verbatim = (_ambRand() * 100) < Math.max(0, Math.min(100, seq.returnChance | 0));
      } else {
        const Nr = Math.max(1, seq.returnN | 0);
        verbatim = (((st && st.iter) | 0) % Nr) === 0;
      }
      const emitEvent = (freqs, durMs, vel, t, padStyle) => {
        if (!freqs || !freqs.length) return;
        const pans = _ambSpacePans(freqs.length, space);
        const vol = _ambApplyLevel(Math.round((vel || 100) * (padStyle ? 0.5 : 0.6)), seq.level);
        freqs.forEach((f, vi) => {
          const p = padStyle
            ? { ...base, type, attack: Math.max(150, Math.round(durMs * 0.30)), decay: 200, sustain: 85, release: Math.max(300, Math.round(durMs * 0.50)), volume: vol, pan: pans[vi] }
            : { ...base, type, attack: Math.max(8, Math.round(durMs * 0.10)), decay: 120, sustain: 70, release: Math.max(60, Math.round(durMs * 0.50)), volume: vol, pan: pans[vi] };
          if (dmod) p._detuneMod = dmod;
          try { playNote(f, p, durMs, t + vi * 0.006, dest, undefined, _E.laneIdx()); } catch (e) {}
        });
      };
      // PAD mode (non-verbatim): ignore rhythm, build one sustained voicing from
      // the seed's note pool, sized by depth.
      if (seq.varyMode === 'pad' && !verbatim) {
        const pool = [];
        let poolVel = 0;
        seed.events.forEach(e => { e.freqs.forEach(f => pool.push(f)); if (e.vel > poolVel) poolVel = e.vel; });
        if (!pool.length) return;
        const want = Math.max(1, Math.min(pool.length, 2 + Math.round(depth * (pool.length - 2))));
        const chosen = []; const used = new Set(); let g = 0;
        while (chosen.length < want && g++ < 64) { const i = Math.floor(_ambRand() * pool.length); if (!used.has(i)) { used.add(i); chosen.push(pool[i]); } }
        chosen.sort((a, b) => a - b);
        emitEvent(chosen, Math.max(300, seq.lengthMs | 0), poolVel || 100, at, true);
        return;
      }
      // PITCH / RHYTHM / verbatim: walk the phrase on a within-phrase cursor.
      let t = at;
      const intervals = _ambScaleIntervals(_ambNotesOf(seq));
      const N = Math.max(1, intervals.length);
      for (let i = 0; i < seed.events.length; i++) {
        const ev = seed.events[i];
        let durMs = Math.max(20, ev.durMs | 0);
        let freqs = ev.freqs;
        if (!verbatim && seq.varyMode === 'rhythm') {
          if (freqs.length && _ambRand() < 0.12 * depth) { t += durMs / 1000; continue; } // drop step
          durMs = Math.max(40, Math.round(durMs * (1 + (_ambRand() * 2 - 1) * 0.6 * depth)));
        }
        if (!verbatim && freqs.length && (seq.varyMode === 'pitch' || seq.varyMode === 'rhythm')) {
          if (_ambRand() < 0.15 * depth) { t += durMs / 1000; continue; } // drop note (keep timing)
          freqs = freqs.map(f => _seqNudgeFreq(f, intervals, N, depth, _ambNotesOf(seq)));
        }
        emitEvent(freqs, durMs, ev.vel, t, false);
        t += durMs / 1000;
      }
      // RHYTHM mode: occasionally append an extra nudged echo at the phrase tail.
      if (!verbatim && seq.varyMode === 'rhythm' && _ambRand() < 0.2 * depth) {
        const ev = seed.events[Math.floor(_ambRand() * seed.events.length)];
        if (ev && ev.freqs.length) emitEvent(ev.freqs.map(f => _seqNudgeFreq(f, intervals, N, depth, _ambNotesOf(seq))), Math.max(40, ev.durMs | 0), ev.vel, t, false);
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
    function _ambMakeSrc(e, target, shape, hz, min, max) {
      const stochastic = _ambIsStochastic(shape);
      const src = { target, stochastic, min, max };
      let node;
      try {
        if (stochastic) {
          node = new Tone.Signal((min + max) / 2);
          src.smooth = (shape === 'smooth');
          src.intervalSec = 1 / Math.max(0.001, hz);
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
      const shape = (_AMB_MOD_SHAPES.indexOf(t.shape) >= 0) ? t.shape : 'sine';
      const stochastic = _ambIsStochastic(shape);
      const hz = _ambModRateHz(t.rate, cfg);
      const range = _ambTargetRange(target, depth);
      // Rebuild when the kind (periodic↔stochastic) changes or nothing exists.
      if (!existing || existing.stochastic !== stochastic) {
        if (existing) _ambDisposeSrc(existing);
        e.src[target] = _ambMakeSrc(e, target, shape, hz, range[0], range[1]);
        return;
      }
      // Update in place.
      existing.min = range[0]; existing.max = range[1];
      if (stochastic) {
        existing.smooth = (shape === 'smooth');
        existing.intervalSec = 1 / Math.max(0.001, hz);
      } else {
        try { existing.node.frequency.value = hz; existing.node.type = shape; existing.node.min = range[0]; existing.node.max = range[1]; } catch (x) {}
      }
    }
    // Dedicated per-engine reverb (a send/return). Each layer's reverb-send gain
    // feeds it; its fully-wet output returns to the engine's bus.
    function _ambEnsureReverb() {
      if (_E.reverb) return _E.reverb;
      if (typeof Tone === 'undefined') return null;
      try { _E.reverb = new Tone.Freeverb({ roomSize: 0.8, dampening: 2500, wet: 1 }).connect(_E.busNode()); }
      catch (e) { _E.reverb = null; }
      _ambApplyReverb();
      return _E.reverb;
    }
    // Push the instance's reverb Size/Damp config onto its live reverb node.
    function _ambApplyReverb() {
      if (!_E.reverb) return;
      const cfg = _E.getCfg(); if (!cfg || !cfg.reverb) return;
      try {
        const size = Math.max(0, Math.min(1, (cfg.reverb.size | 0) / 100));
        const damp = 500 + Math.max(0, Math.min(100, cfg.reverb.damp | 0)) / 100 * 5500; // Hz
        if (_E.reverb.roomSize) _E.reverb.roomSize.value = size;
        if (_E.reverb.dampening) _E.reverb.dampening.value = damp;
      } catch (e) {}
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
        const vca = new Tone.Gain(1).connect(out);
        const vcf = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.7 }).connect(vca);
        const revSend = new Tone.Gain(0);
        vca.connect(revSend);
        const rev = _ambEnsureReverb();
        if (rev) revSend.connect(rev);
        _E.mod[layer] = { input: vcf, vcf, vca, dist: null, delay: null, revSend, src: { vca: null, vco: null, vcf: null } };
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
          try { e.vca.disconnect(); } catch (x) {}
          if (!wantDelay && e.delay) { try { e.delay.dispose(); } catch (x) {} e.delay = null; }
          if (!wantDist && e.dist) { try { e.dist.dispose(); } catch (x) {} e.dist = null; }
          let tail = out;
          if (wantDelay) {
            if (!e.delay) e.delay = new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.35, wet: 0 });
            try { e.delay.disconnect(); } catch (x) {}
            e.delay.connect(tail); tail = e.delay;
          }
          if (wantDist) {
            if (!e.dist) e.dist = new Tone.Distortion({ distortion: 0.4, wet: 0 });
            try { e.dist.disconnect(); } catch (x) {}
            e.dist.connect(tail); tail = e.dist;
          }
          e.vca.connect(tail);
          e.vca.connect(e.revSend); // re-tap the parallel reverb send
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
      try { e.dist && e.dist.dispose(); } catch (x) {}
      try { e.delay && e.delay.dispose(); } catch (x) {}
      try { e.revSend && e.revSend.dispose(); } catch (x) {}
      delete _E.mod[layer];
    }
    function _ambTeardownMods() {
      Object.keys(_E.mod).forEach(_ambTeardownMod);
      try { if (_E.reverb) { _E.reverb.dispose(); _E.reverb = null; } } catch (x) {}
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
          if (!src || !src.stochastic || !src.node) return;
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
      // Progression clock: a shared per-engine step that advances every
      // progRateMs, so all "Progression" note-source layers move through their
      // chords together (a single harmonic pulse).
      { const pr = Math.max(250, (cfg.progRateMs | 0) || 4000); E.progStep = Math.floor((now * 1000) / pr); }
      // (Ramps run on their own finer clock — see _ambStartGenerator.)
      const horizon = now + 1.2, lead = now + 0.1;
      const space = cfg.space | 0;
      const C = E.clocks, I = E.iters;
      // Solo: if ANY on layer is soloed, only soloed layers sound.
      const anySolo = _ambComputeAnySolo(cfg);
      const _muted = (lc) => anySolo && !(lc && lc.solo);
      try { _ambScheduleStochastic(now); } catch (e) {} // feed the stochastic LFOs
      const runLayer = (key, lc, guardMax, minSec, emit) => {
        if (!lc || lc.present === false || !lc.on || _ambFreezeFrozen(E, key)) return;
        if (!C[key] || C[key] < now) C[key] = lead + _ambDriftOffset(lc, cfg);
        let g = 0;
        while (C[key] < horizon && g++ < guardMax) {
          if (_ambCondFires(lc.when, I[key] | 0)) emit(C[key]);
          I[key] = (I[key] | 0) + 1;
          C[key] += _ambSnap(Math.max(minSec, (lc.intervalMs | 0) / 1000), cfg);
        }
      };
      // Freeze-aware wrapper: frozen → replay the captured loop; recording →
      // generate normally while teeing each note into the capture sink.
      const stepLayer = (key, lc, guardMax, minSec, emit) => {
        if (_muted(lc)) return; // silenced by another layer's solo
        if (_ambFreezeGate(E, key, now, horizon)) return;
        window._ambCaptureSink = _ambCapSink(E, key); // always roll-capture
        try { runLayer(key, lc, guardMax, minSec, emit); }
        finally { window._ambCaptureSink = null; _ambPruneCap(E, key, now); }
      };
      stepLayer('bed', cfg.bed, 8, 0.05, (at) => _ambEmitBed(at, cfg.bed, space));
      stepLayer('motif', cfg.motif, 16, 0.04, (at) => _ambEmitMotif(at, cfg.motif, space));
      stepLayer('texture', cfg.texture, 16, 0.03, (at) => _ambEmitTexture(at, cfg.texture, space));
      stepLayer('beat', cfg.beat, 16, 0.04, (at) => _ambEmitBeat(at, cfg.beat, space));
      // Seq layers (dynamic list). Each fire schedules a whole phrase, so a
      // smaller per-tick guard bounds overlapping voices.
      if (Array.isArray(cfg.seqs)) {
        for (const seq of cfg.seqs) {
          if (!seq || !seq.on || !Array.isArray(seq.units) || !seq.units.length) continue;
          const key = 'seq:' + seq.id;
          if (_muted(seq)) continue;
          if (_ambFreezeGate(E, key, now, horizon)) continue;
          window._ambCaptureSink = _ambCapSink(E, key);
          if (!C[key] || C[key] < now) C[key] = lead + _ambDriftOffset(seq, cfg);
          let g = 0;
          while (C[key] < horizon && g++ < 4) {
            if (_ambCondFires(seq.when, I[key] | 0)) {
              const st = E.seqState[seq.id] || (E.seqState[seq.id] = { pick: 0, iter: 0 });
              st.iter = I[key] | 0;
              _ambEmitSeq(C[key], seq, space, st);
            }
            I[key] = (I[key] | 0) + 1;
            C[key] += _ambSnap(Math.max(0.1, (seq.intervalMs | 0) / 1000), cfg);
          }
          window._ambCaptureSink = null; _ambPruneCap(E, key, now);
        }
      }
      // Sample layers (dynamic list). Each fire schedules up to `chop` slices.
      if (Array.isArray(cfg.samples)) {
        for (const L of cfg.samples) {
          if (!L || !L.on || !L.sampleId) continue;
          const key = 'samp:' + L.id;
          if (_muted(L)) continue;
          if (_ambFreezeGate(E, key, now, horizon)) continue;
          window._ambCaptureSink = _ambCapSink(E, key);
          if (!C[key] || C[key] < now) C[key] = lead + _ambDriftOffset(L, cfg);
          let g = 0;
          while (C[key] < horizon && g++ < 4) {
            if (_ambCondFires(L.when, I[key] | 0)) {
              const st = E.seqState[key] || (E.seqState[key] = { pick: 0, iter: 0 });
              st.iter = I[key] | 0;
              _ambEmitSample(C[key], L, space, st);
            }
            I[key] = (I[key] | 0) + 1;
            C[key] += _ambSnap(Math.max(0.1, (L.intervalMs | 0) / 1000), cfg);
          }
          window._ambCaptureSink = null; _ambPruneCap(E, key, now);
        }
      }
      // Extra layer instances (additional Bed/Motif/Texture/Beat). runLayer
      // gates present/on/frozen and reads the instance's intervalMs/when.
      if (Array.isArray(cfg.extras)) {
        for (const ex of cfg.extras) {
          if (!ex || !_AMB_LAYER_SCHEMA[ex.type]) continue;
          const key = ex.type + ':' + ex.id;
          const gm = ex.type === 'bed' ? 8 : 16;
          const ms = ex.type === 'bed' ? 0.05 : (ex.type === 'motif' ? 0.04 : 0.03);
          stepLayer(key, ex, gm, ms, (at) => {
            if (ex.type === 'bed') _ambEmitBed(at, ex, space, key);
            else if (ex.type === 'motif') _ambEmitMotif(at, ex, space, key);
            else if (ex.type === 'texture') _ambEmitTexture(at, ex, space, key);
            else _ambEmitBeat(at, ex, space, key);
          });
        }
      }
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
    function _alSupported() { return (typeof MediaRecorder !== 'undefined') && (typeof masterLimiter !== 'undefined' && !!masterLimiter); }
    function _alStart() {
      if (_AL.on || !_alSupported()) return false;
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { return false; }
      try { _AL.dest = ac.createMediaStreamDestination(); masterLimiter.connect(_AL.dest); } catch (e) { return false; }
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
      try { if (_AL.dest) masterLimiter.disconnect(_AL.dest); } catch (e) {}
      _AL.dest = null; _AL.segs = [];
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
      // Round the start/end presses to the nearest note onset (search a little
      // past P2 so the end can snap up to the next note for seamless tiling).
      const startOnset = _ambNearestOnset(cap, P1, P1 - intervalSec, P2 + intervalSec);
      const endOnset = _ambNearestOnset(cap, P2, P1, P2 + intervalSec * 1.5);
      let loopStart = (startOnset != null) ? startOnset : P1;
      let loopEnd = (endOnset != null) ? endOnset : P2;
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
        const k = Math.max(1, Math.ceil((now - A) / L)); // end of the current iteration
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
          _ambApplyRamps(cfg, t);
        } catch (e) {}
      }, 25);
    }
    function _ambStopRampClock(E) {
      if (E && E.rampTimer) { clearInterval(E.rampTimer); E.rampTimer = null; }
    }
    function _ambStartGenerator(E) {
      _E = E;
      const cfg = E.getCfg();
      if (!cfg) return;
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      if (E.timer) return;
      _ambResetClocks(E);
      _ambSeed(cfg.seed);
      try { _ambSyncMods(); } catch (e) {} // build mod chains before the first voices fire
      _ambTick(E);
      E.timer = setInterval(() => _ambTick(E), 150);
      // The finer ramp clock only runs while ramps exist (started lazily) so a
      // ramp-free Bloom doesn't burn a 40 Hz main-thread timer that competes
      // with audio scheduling.
      _ambStartRampClock(E);
      cfg.playing = true;
      _ambRefreshPlayBtn(E);
      _ambVizKick(E);
    }
    function _ambStopGenerator(E) {
      _E = E;
      if (E.timer) { clearInterval(E.timer); E.timer = null; }
      if (E.rampTimer) { clearInterval(E.rampTimer); E.rampTimer = null; }
      try { _ambFreezeStopAll(E); } catch (e) {}
      _ambResetClocks(E);
      const cfg = E.getCfg();
      if (cfg) cfg.playing = false;
      _ambRefreshPlayBtn(E);
      try { _ambUpdatePlayheads(E); } catch (e) {} // zero the bars when stopped
      // Only hard-silence active voices when NO Bloom engine is still running —
      // otherwise stopping one engine would cut the other engine's ringing
      // voices. The stopped engine's long releases ring out meanwhile.
      try {
        if (!_laneEng.timer && !_masterEng.timer && typeof silenceActiveVoices === 'function') silenceActiveVoices();
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
          const pans = _ambSpacePans(v.length, space);
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
    function _ambSendSavedToMaster(seqIndex, mode, targetSeqId) {
      const saved = (typeof savedSequences !== 'undefined') ? savedSequences[seqIndex] : null;
      if (!saved) return;
      const unit = _seqSeedFromSaved(saved);
      if (!unit) { try { alert('That sequence has no playable notes to send to Bloom.'); } catch (e) {} return; }
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send to Bloom');
      _ambSendSeedToInstance(_masterEng, unit, mode, targetSeqId);
      // Reflect immediately if the Mix Bloom panel is built.
      try { if (_masterEng.inited) _ambRenderSeqLayers(_masterEng); } catch (e) {}
    }
    // Build a unit from a LANE's own steps (+ workspace key/tempo).
    function _ambUnitFromLane(laneIdx) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      if (!lane || !Array.isArray(lane.steps)) return null;
      const bpmEl = document.getElementById('tempo-input') || (typeof tempoInput !== 'undefined' ? tempoInput : null);
      const bpm = bpmEl ? (parseInt(bpmEl.value, 10) || 120) : 120;
      return _seqSeedFromSaved({
        steps: lane.steps, bpm,
        scale: (typeof currentScale !== 'undefined') ? currentScale : '',
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
      if (!lane.ambient || typeof lane.ambient !== 'object') lane.ambient = _defaultAmbientConfig();
      lane.ambientMode = true;
      if (typeof activateLane === 'function') activateLane(laneIdx); // → _ambientInit(_laneEng)
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
        const tap = (typeof masterLimiter !== 'undefined' && masterLimiter) ? masterLimiter : null;
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
    async function _ambExportToDrive(E) {
      if (_ambExportBusy) return;
      E = E || _laneEng;
      _E = E;
      const cfg = E.getCfg();
      if (!cfg) return;
      const anyOn = ['bed', 'motif', 'texture', 'beat'].some(k => cfg[k] && cfg[k].present !== false && cfg[k].on)
        || (Array.isArray(cfg.extras) && cfg.extras.some(x => x && x.present !== false && x.on && _AMB_LAYER_SCHEMA[x.type]))
        || (Array.isArray(cfg.seqs) && cfg.seqs.some(s => s.on && s.units && s.units.length))
        || (Array.isArray(cfg.samples) && cfg.samples.some(s => s.on && s.sampleId));
      if (!anyOn) { alert('Turn on at least one Bloom layer before exporting.'); return; }
      // Length first (Bloom has no inherent duration).
      const durStr = (typeof prompt === 'function') ? prompt('Bloom export length in seconds:', '60') : '60';
      if (durStr == null) return;
      const durSec = Math.max(2, Math.min(600, parseFloat(durStr) || 60));
      if (typeof showExportOptionsDialog !== 'function') { alert('Export is unavailable.'); return; }
      const stamp = (() => { try { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); } catch (e) { return 'take'; } })();
      const choice = await showExportOptionsDialog({
        title: 'Export Bloom to Drive',
        defaultName: 'bloom-' + stamp,
        defaultFolder: 'bloops/exports',
        includeFolder: true,
        applyLabel: 'Export',
      });
      if (!choice) return;
      const { filename, fmt, folder } = choice;
      const ext = fmt === 'mp3' ? 'mp3' : 'wav';
      const mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav';
      _ambExportBusy = true;
      // Bloom export records the LIVE output in real time, so keep the progress
      // indicator non-blocking — the user can tweak layers / FX / solo / ramps
      // while it records and those changes are captured in the take.
      const progress = (typeof showRenderProgressModal === 'function')
        ? showRenderProgressModal('Exporting Bloom…', { nonBlocking: true, note: 'Keep tweaking — edits are captured live until the recording ends.' })
        : null;
      try {
        progress && progress.setStatus('Recording ' + durSec + 's…');
        const buffer = await _ambCaptureToBuffer(E, durSec, (pct, sec, tot) => progress && progress.setProgress(pct, sec, tot));
        progress && progress.setStatus(fmt === 'mp3' ? 'Encoding MP3…' : 'Encoding WAV…');
        const blob = (fmt === 'mp3' && typeof audioBufferToMp3 === 'function')
          ? await audioBufferToMp3(buffer)
          : audioBufferToWav(buffer);
        progress && progress.setStatus('Signing in to Google Drive…');
        await googleSignInForDrive();
        progress && progress.setStatus('Uploading to Drive…');
        const folderId = await findOrCreateDriveFolder(folder);
        const file = await uploadBlobToDrive(`${filename}.${ext}`, blob, folderId, mime);
        progress && progress.markDone();
        alert(`Saved "${(file && file.name) || filename + '.' + ext}" to Drive folder "${folder}".`);
      } catch (e) {
        console.error('Bloom export failed', e);
        alert(`Bloom export failed: ${(e && e.message) || e}`);
      } finally {
        progress && progress.close();
        _ambExportBusy = false;
      }
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
    function _ambUpdatePlayheads(E) {
      const host = document.getElementById(E.hostId); if (!host) return;
      const bars = host.querySelectorAll('.ambient-ph'); if (!bars.length) return;
      const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
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
          const next = E.clocks && E.clocks[key];
          if (on && typeof next === 'number' && next > now) {
            const iv = Math.max(0.05, ((layer.intervalMs | 0) / 1000) || 1);
            const x = (next - now) / iv;
            prog = Math.max(0, Math.min(1, Math.ceil(x) - x));
            active = true;
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
      btn.textContent = on ? '◼ Stop' : '▶ Play';
      btn.classList.toggle('active', on);
    }
    // ---- Shared control builders (module scope: used by _ambientInit AND the
    // dynamic Seq renderer). They emit 'ambient-' id stems; both callers
    // translate the stem to the engine's idPrefix after building.
    const _ambSl = (label, id, min, max, val, hint) =>
      '<div class="ambient-ctrl"><label for="' + id + '">' + label + '</label>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '" />' +
      (hint ? '<span class="ambient-hint">' + hint + '</span>' : '') + '</div>';
    const _ambTm = (label, id, min, max, step, val) =>
      '<div class="ambient-ctrl"><label for="' + id + '">' + label + '</label>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" />' +
      '<span class="ambient-hint" id="' + id + '-v"></span></div>';
    const _ambShapeSel = (id) => '<select id="' + id + '" class="ambient-select">' +
      ['sine', 'triangle', 'sawtooth', 'square', 'smooth', 'sharp'].map(s => '<option value="' + s + '">' + s + '</option>').join('') + '</select>';
    const _ambCondCtrl = (layer) => '<div class="ambient-ctrl"><label for="ambient-' + layer + '-when">When</label>' +
      '<select id="ambient-' + layer + '-when" class="ambient-select">' +
      ['always', '1st', '1:2', '2:2', '1:3', '1:4'].map(c => '<option value="' + c + '">' + (c === 'always' ? 'Always' : c) + '</option>').join('') +
      '</select><span class="ambient-hint">cond</span></div>';
    const _ambModTarget = (layer, target, label, hint, defRate) =>
      '<div class="ambient-mod-target"><div class="ambient-mod-sub">' + label + '</div>' +
        _ambSl('Depth', 'ambient-' + layer + '-mod-' + target + '-depth', 0, 100, 0, hint) +
        _ambSl('Rate', 'ambient-' + layer + '-mod-' + target + '-rate', 0, 100, defRate, 'slow → fast') +
        '<div class="ambient-ctrl"><label for="ambient-' + layer + '-mod-' + target + '-shape">Shape</label>' +
          _ambShapeSel('ambient-' + layer + '-mod-' + target + '-shape') + '<span class="ambient-hint">wave</span></div></div>';
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
    const _ambHead = (label, onId, delId, freezeKey) =>
      '<div class="ambient-layer-head"><button type="button" class="ambient-toggle" id="' + onId + '">' + label + '</button>' +
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

    // ---- Dynamic Seq layers (Seq1, Seq2…) ------------------------------
    function _ambSeqLayerHtml(s, i) {
      const id = s.id, p = 'ambient-seq-' + id + '-';
      const opts = (arr, cur) => arr.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('');
      return '<div class="ambient-layer collapsed" data-seq-id="' + id + '">' +
        _ambHead('Seq' + (i + 1), p + 'on', p + 'del', 'seq:' + id) +
        '<div class="ambient-ctrl"><label for="' + p + 'tone">Tone</label><select id="' + p + 'tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
        _ambNotesButtonHtml(p.slice(0, -1)) +
        '<div class="ambient-ctrl"><label for="' + p + 'vary">Vary</label><select id="' + p + 'vary" class="ambient-select">' + opts([['pitch', 'Pitch'], ['rhythm', 'Pitch + rhythm'], ['pad', 'Pad re-voice']], s.varyMode) + '</select><span class="ambient-hint">style</span></div>' +
        _ambSl('Amount', p + 'depth', 0, 100, s.varyDepth, 'subtle → wild') +
        _ambTm('Interval', p + 'interval', 200, 16000, 50, s.intervalMs) +
        _ambTm('Length', p + 'length', 300, 16000, 100, s.lengthMs) +
        _ambSl('Drift', p + 'drift', 0, 99, s.drift, 'phase offset') +
        '<div class="ambient-ctrl"><label for="' + p + 'when">When</label><select id="' + p + 'when" class="ambient-select">' + opts([['always', 'Always'], ['1st', '1st'], ['1:2', '1:2'], ['2:2', '2:2'], ['1:3', '1:3'], ['1:4', '1:4']], s.when) + '</select><span class="ambient-hint">cond</span></div>' +
        '<div class="ambient-ctrl"><label for="' + p + 'unitmode">Units</label><select id="' + p + 'unitmode" class="ambient-select">' + opts([['single', 'Single'], ['interleave', 'Interleave']], s.unitMode) + '</select><span class="ambient-hint">' + s.units.length + ' unit' + (s.units.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="ambient-ctrl"><label for="' + p + 'return">Return</label><select id="' + p + 'return" class="ambient-select">' + opts([['everyN', 'Every N'], ['chance', 'Chance %']], s.returnMode) + '</select><span class="ambient-hint">to original</span></div>' +
        _ambSl('Every N', p + 'returnN', 1, 16, s.returnN, 'cycles') +
        _ambSl('Chance %', p + 'returnChance', 0, 100, s.returnChance, 'verbatim') +
        _ambSl('Level', p + 'level', 0, 100, s.level, 'soft → boost') +
        _ambModUi('seq-' + id) +
        _ambFxUi('seq-' + id) +
      '</div>';
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
    function _ambWireSeqLayer(E, s) {
      const id = s.id, p = 'ambient-seq-' + id + '-';
      const getSq = () => { const c = E.getCfg(); return (c && Array.isArray(c.seqs)) ? c.seqs.find(x => x.id === id) : null; };
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const el = (suf) => _ambGet(E, p + suf);
      const bindInt = (suf, key) => { const e = el(suf); if (!e) return; e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; sq[key] = parseInt(e.value, 10) || 0; persist(); }); };
      const bindMs = (suf, key) => { const e = el(suf), v = el(suf + '-v'); if (!e) return; e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; const val = parseInt(e.value, 10) || 0; sq[key] = val; if (v) v.textContent = _ambFmtMs(val); persist(); }); };
      const bindStr = (suf, key, after) => { const e = el(suf); if (!e) return; e.addEventListener('change', () => { _E = E; const sq = getSq(); if (!sq) return; sq[key] = e.value || sq[key]; if (after) after(); persist(); }); };
      const toneSel = el('tone'); if (toneSel) populateGroupedToneSelect(toneSel, _ambToneOptions(), { value: '', label: 'Grid voice' });
      _ambWireNotesBtn(E, p + 'notes', getSq); // Notes source button (Scale / Chord)
      bindStr('tone', 'tone'); bindStr('vary', 'varyMode'); bindStr('unitmode', 'unitMode');
      bindInt('depth', 'varyDepth'); bindMs('interval', 'intervalMs'); bindMs('length', 'lengthMs');
      bindInt('drift', 'drift'); bindStr('when', 'when');
      bindStr('return', 'returnMode', () => _ambSeqReturnVis(E, id));
      bindInt('returnN', 'returnN'); bindInt('returnChance', 'returnChance'); bindInt('level', 'level');
      ['vca', 'vco', 'vcf'].forEach(t => {
        ['depth', 'rate'].forEach(k => { const e = el('mod-' + t + '-' + k); if (!e) return; e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; sq.mod[t][k] = parseInt(e.value, 10) || 0; if (E.timer) { try { _ambSyncMods(); } catch (x) {} } persist(); }); });
        const sh = el('mod-' + t + '-shape'); if (sh) sh.addEventListener('change', () => { _E = E; const sq = getSq(); if (!sq) return; sq.mod[t].shape = sh.value || 'sine'; if (E.timer) { try { _ambSyncMods(); } catch (x) {} } persist(); });
      });
      // Per-layer FX wiring.
      const bindFx = (suf, setter) => { const e = el('fx-' + suf); if (!e) return; const v = el('fx-' + suf + '-v'); e.addEventListener('input', () => { _E = E; const sq = getSq(); if (!sq) return; const val = parseInt(e.value, 10) || 0; setter(sq, val); if (v) v.textContent = _ambFmtMs(val); if (E.timer) { try { _ambSyncMods(); } catch (x) {} } persist(); }); };
      bindFx('rev', (q, v) => { q.revSend = v; });
      bindFx('dly-mix', (q, v) => { q.delay.mix = v; });
      bindFx('dly-time', (q, v) => { q.delay.timeMs = v; });
      bindFx('dly-fb', (q, v) => { q.delay.feedback = v; });
      bindFx('dist-amt', (q, v) => { q.dist.amount = v; });
      bindFx('dist-mix', (q, v) => { q.dist.mix = v; });
      const onB = el('on'); if (onB) { onB.classList.toggle('on', !!s.on); onB.addEventListener('click', () => { _E = E; const sq = getSq(); if (!sq) return; sq.on = !sq.on; onB.classList.toggle('on', sq.on); if (E.timer) { try { _ambSyncMods(); } catch (x) {} } persist(); }); }
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteSeqLayer(E, id));
      const layerDiv = onB ? onB.closest('.ambient-layer') : null;
      const cB = layerDiv ? layerDiv.querySelector('.ambient-collapse') : null;
      if (cB && layerDiv) cB.addEventListener('click', () => layerDiv.classList.toggle('collapsed'));
      // Initial values not carried by `selected`/value attrs.
      const setVal = (suf, v) => { const e = el(suf); if (e && v != null) e.value = String(v); };
      setVal('tone', s.tone); setVal('scale', s.scale);
      const iv = el('interval-v'); if (iv) iv.textContent = _ambFmtMs(s.intervalMs);
      const lv = el('length-v'); if (lv) lv.textContent = _ambFmtMs(s.lengthMs);
      ['vca', 'vco', 'vcf'].forEach(t => { if (!s.mod || !s.mod[t]) return; setVal('mod-' + t + '-depth', s.mod[t].depth); setVal('mod-' + t + '-rate', s.mod[t].rate); const sh = el('mod-' + t + '-shape'); if (sh) sh.value = s.mod[t].shape; });
      setVal('fx-rev', s.revSend);
      if (s.delay) { setVal('fx-dly-mix', s.delay.mix); setVal('fx-dly-time', s.delay.timeMs); const dtv = el('fx-dly-time-v'); if (dtv) dtv.textContent = _ambFmtMs(s.delay.timeMs); setVal('fx-dly-fb', s.delay.feedback); }
      if (s.dist) { setVal('fx-dist-amt', s.dist.amount); setVal('fx-dist-mix', s.dist.mix); }
      _ambSeqReturnVis(E, id);
    }
    function _ambRenderSeqLayers(E) {
      const wrap = _ambGet(E, 'ambient-seq-layers');
      if (!wrap) return;
      const cfg = E.getCfg(); if (!cfg) return;
      const seqs = Array.isArray(cfg.seqs) ? cfg.seqs : [];
      wrap.innerHTML = _ambNamespaceHtml(E, seqs.map((s, i) => _ambSeqLayerHtml(s, i)).join(''));
      seqs.forEach((s) => _ambWireSeqLayer(E, s));
    }
    function _ambDeleteSeqLayer(E, id) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.seqs)) return;
      const idx = cfg.seqs.findIndex(s => s.id === id);
      if (idx < 0) return;
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
        _ambHead('Sample' + (i + 1), p + 'on', p + 'del', 'samp:' + id) +
        '<div class="ambient-ctrl"><label>Source</label><span class="ambient-hint" style="margin-left:auto">' + nm + '</span></div>' +
        _ambSl('Chop', p + 'chop', 1, 16, s.chop, '1 = whole → slices') +
        '<div class="ambient-ctrl"><label for="' + p + 'order">Order</label><select id="' + p + 'order" class="ambient-select">' + opts([['forward', 'Forward'], ['random', 'Random']], s.order) + '</select><span class="ambient-hint">slices</span></div>' +
        _ambTm('Interval', p + 'interval', 200, 16000, 50, s.intervalMs) +
        _ambTm('Length', p + 'length', 80, 16000, 20, s.lengthMs) +
        _ambSl('Drift', p + 'drift', 0, 99, s.drift, 'phase offset') +
        '<div class="ambient-ctrl"><label for="' + p + 'when">When</label><select id="' + p + 'when" class="ambient-select">' + opts([['always', 'Always'], ['1st', '1st'], ['1:2', '1:2'], ['2:2', '2:2'], ['1:3', '1:3'], ['1:4', '1:4']], s.when) + '</select><span class="ambient-hint">cond</span></div>' +
        _ambSl('Level', p + 'level', 0, 100, s.level, 'soft → boost') +
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
      bindInt('drift', 'drift'); bindStr('when', 'when'); bindInt('level', 'level');
      ['vca', 'vco', 'vcf'].forEach(t => {
        ['depth', 'rate'].forEach(k => { const e = el('mod-' + t + '-' + k); if (!e) return; e.addEventListener('input', () => { _E = E; const L = getL(); if (!L) return; L.mod[t][k] = parseInt(e.value, 10) || 0; sync(); persist(); }); });
        const sh = el('mod-' + t + '-shape'); if (sh) sh.addEventListener('change', () => { _E = E; const L = getL(); if (!L) return; L.mod[t].shape = sh.value || 'sine'; sync(); persist(); });
      });
      const bindFx = (suf, setter) => { const e = el('fx-' + suf); if (!e) return; const v = el('fx-' + suf + '-v'); e.addEventListener('input', () => { _E = E; const L = getL(); if (!L) return; const val = parseInt(e.value, 10) || 0; setter(L, val); if (v) v.textContent = _ambFmtMs(val); sync(); persist(); }); };
      bindFx('rev', (q, v) => { q.revSend = v; });
      bindFx('dly-mix', (q, v) => { q.delay.mix = v; });
      bindFx('dly-time', (q, v) => { q.delay.timeMs = v; });
      bindFx('dly-fb', (q, v) => { q.delay.feedback = v; });
      bindFx('dist-amt', (q, v) => { q.dist.amount = v; });
      bindFx('dist-mix', (q, v) => { q.dist.mix = v; });
      const onB = el('on'); if (onB) { onB.classList.toggle('on', !!s.on); onB.addEventListener('click', () => { _E = E; const L = getL(); if (!L) return; L.on = !L.on; onB.classList.toggle('on', L.on); sync(); persist(); }); }
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteSampleLayer(E, id));
      const layerDiv = onB ? onB.closest('.ambient-layer') : null;
      const cB = layerDiv ? layerDiv.querySelector('.ambient-collapse') : null;
      if (cB && layerDiv) cB.addEventListener('click', () => layerDiv.classList.toggle('collapsed'));
      const setVal = (suf, v) => { const e = el(suf); if (e && v != null) e.value = String(v); };
      const iv = el('interval-v'); if (iv) iv.textContent = _ambFmtMs(s.intervalMs);
      const lv = el('length-v'); if (lv) lv.textContent = _ambFmtMs(s.lengthMs);
      ['vca', 'vco', 'vcf'].forEach(t => { if (!s.mod || !s.mod[t]) return; setVal('mod-' + t + '-depth', s.mod[t].depth); setVal('mod-' + t + '-rate', s.mod[t].rate); const sh = el('mod-' + t + '-shape'); if (sh) sh.value = s.mod[t].shape; });
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
    }
    function _ambDeleteSampleLayer(E, id) {
      _E = E;
      const cfg = E.getCfg(); if (!cfg || !Array.isArray(cfg.samples)) return;
      const idx = cfg.samples.findIndex(s => s.id === id);
      if (idx < 0) return;
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
    const _AMB_LAYER_SCHEMA = {
      bed: { label: 'Bed', ctrls: [['tone'], ['notes'],
        ['sl', 'density', 'Density', 1, 8, 'voices'], ['sl', 'register', 'Register', 2, 6, 'octave'], ['sl', 'spread', 'Spread', 0, 3, '± oct'],
        ['tm', 'intervalMs', 'Interval', 200, 12000, 50], ['tm', 'lengthMs', 'Length', 300, 16000, 100],
        ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['sl', 'motion', 'Motion', 0, 100, 'detune'], ['sl', 'strum', 'Strum', 0, 100, 'chord → arp'], ['sl', 'strumFidelity', 'Fidelity', 0, 100, 'in order → random'],
        ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['mod'], ['fx']] },
      motif: { label: 'Motif', ctrls: [['tone'], ['notes'],
        ['sl', 'register', 'Register', 2, 7, 'octave'], ['sl', 'range', 'Range', 1, 4, '± oct'],
        ['tm', 'intervalMs', 'Interval', 100, 4000, 20], ['tm', 'lengthMs', 'Length', 80, 4000, 20],
        ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['sl', 'restProb', 'Rests', 0, 100, '%'], ['sl', 'twist', 'Twist', 0, 100, 'steady → bursts'],
        ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['mod'], ['fx']] },
      texture: { label: 'Texture', ctrls: [['tone'], ['notes'],
        ['sl', 'register', 'Register', 3, 7, 'octave'], ['sl', 'fill', 'Fill', 0, 100, 'sparse→busy'],
        ['tm', 'intervalMs', 'Interval', 80, 2000, 10], ['tm', 'lengthMs', 'Length', 60, 2000, 10],
        ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['sl', 'mutateRate', 'Mutate', 0, 100, 'slow→fast'],
        ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['mod'], ['fx']] },
      beat: { label: 'Beat', ctrls: [['kit'],
        ['tm', 'intervalMs', 'Interval', 80, 2000, 10], ['tm', 'lengthMs', 'Length', 60, 2000, 10],
        ['sl', 'drift', 'Drift', 0, 99, 'phase offset'], ['cond'],
        ['sl', 'restProb', 'Rests', 0, 100, '%'],
        ['sl', 'level', 'Level', 0, 100, 'soft → boost'], ['mod'], ['fx']] },
    };
    function _ambDefaultLayer(type, id) {
      const base = { id: id | 0, type: type, on: true, present: true, drift: 0, when: 'always', level: 70, mod: _ambDefaultMod(), ..._ambDefaultFx() };
      if (type === 'bed') return Object.assign(base, { tone: '', notes: { type: 'scale', scale: '' }, density: 4, register: 4, spread: 2, intervalMs: 4750, lengthMs: 6650, motion: 30, strum: 0, strumFidelity: 0 });
      if (type === 'motif') return Object.assign(base, { tone: '', notes: { type: 'scale', scale: '' }, register: 5, range: 2, intervalMs: 1200, lengthMs: 1000, restProb: 30, twist: 0 });
      if (type === 'texture') return Object.assign(base, { tone: '', notes: { type: 'scale', scale: '' }, register: 6, fill: 35, intervalMs: 450, lengthMs: 300, mutateRate: 40 });
      if (type === 'beat') return Object.assign(base, { kit: 'tr808', intervalMs: 500, lengthMs: 200, restProb: 25 });
      return base;
    }
    function _ambInstCardHtml(inst) {
      const type = inst.type, sch = _AMB_LAYER_SCHEMA[type]; if (!sch) return '';
      const lk = type + '-' + inst.id, p = 'ambient-' + lk, fkey = type + ':' + inst.id;
      let html = '<div class="ambient-layer collapsed" data-inst="' + fkey + '">' + _ambHead(sch.label, p + '-on', p + '-del', fkey);
      sch.ctrls.forEach(c => {
        const k = c[0];
        if (k === 'tone') html += '<div class="ambient-ctrl"><label for="' + p + '-tone">Tone</label><select id="' + p + '-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>';
        else if (k === 'kit') html += '<div class="ambient-ctrl"><label for="' + p + '-kit">Kit</label><select id="' + p + '-kit" class="ambient-select"></select><span class="ambient-hint">drums</span></div>';
        else if (k === 'notes') html += _ambNotesButtonHtml(p);
        else if (k === 'sl') html += _ambSl(c[2], p + '-' + c[1], c[3], c[4], inst[c[1]], c[5]);
        else if (k === 'tm') html += _ambTm(c[2], p + '-' + c[1], c[3], c[4], c[5], inst[c[1]]);
        else if (k === 'cond') html += _ambCondCtrl(lk);
        else if (k === 'mod') html += _ambModUi(lk);
        else if (k === 'fx') html += _ambFxUi(lk);
      });
      return html + '</div>';
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
      const onB = el('on'); if (onB) { onB.classList.toggle('on', !!inst.on); onB.addEventListener('click', () => { const L = get(); if (!L) return; L.on = !L.on; onB.classList.toggle('on', L.on); sync(); persist(); }); }
      const delB = el('del'); if (delB) delB.addEventListener('click', () => _ambDeleteExtra(E, type, id));
      const layerDiv = onB ? onB.closest('.ambient-layer') : null;
      const cB = layerDiv ? layerDiv.querySelector('.ambient-collapse') : null;
      if (cB && layerDiv) cB.addEventListener('click', () => layerDiv.classList.toggle('collapsed'));
      sch.ctrls.forEach(c => {
        const k = c[0];
        try {
          if (k === 'tone') { const s = el('tone'); if (s) { populateGroupedToneSelect(s, _ambToneOptions(), { value: '', label: 'Grid voice' }); s.value = inst.tone || ''; s.addEventListener('change', () => { const L = get(); if (L) { L.tone = s.value || ''; persist(); } }); } }
          else if (k === 'kit') { const s = el('kit'); if (s) { _ambDrumKits().forEach(kk => { const o = document.createElement('option'); o.value = kk.id; o.textContent = kk.name; s.appendChild(o); }); s.value = inst.kit || 'tr808'; s.addEventListener('change', () => { const L = get(); if (L) { L.kit = s.value || 'tr808'; persist(); } }); } }
          else if (k === 'notes') { _ambWireNotesBtn(E, p + 'notes', get); }
          else if (k === 'sl') { const e = el(c[1]); if (e) e.addEventListener('input', () => { const L = get(); if (L) { L[c[1]] = parseInt(e.value, 10) || 0; sync(); persist(); } }); }
          else if (k === 'tm') { const e = el(c[1]), v = el(c[1] + '-v'); if (e) { if (v) v.textContent = _ambFmtMs(inst[c[1]]); e.addEventListener('input', () => { const L = get(); if (L) { const val = parseInt(e.value, 10) || 0; L[c[1]] = val; if (v) v.textContent = _ambFmtMs(val); sync(); persist(); } }); } }
          else if (k === 'cond') { const s = el('when'); if (s) { s.value = inst.when || 'always'; s.addEventListener('change', () => { const L = get(); if (L) { L.when = s.value || 'always'; persist(); } }); } }
        } catch (err) { console.warn('Bloom extra control wiring failed', type, id, k, err); }
      });
      ['vca', 'vco', 'vcf'].forEach(t => {
        ['depth', 'rate'].forEach(kk => { const e = el('mod-' + t + '-' + kk); if (e) e.addEventListener('input', () => { const L = get(); if (!L) return; L.mod[t][kk] = parseInt(e.value, 10) || 0; sync(); persist(); }); });
        const sh = el('mod-' + t + '-shape'); if (sh) sh.addEventListener('change', () => { const L = get(); if (!L) return; L.mod[t].shape = sh.value || 'sine'; sync(); persist(); });
      });
      const bindFx = (suf, setter) => { const e = el('fx-' + suf); if (!e) return; const v = el('fx-' + suf + '-v'); e.addEventListener('input', () => { const L = get(); if (!L) return; const val = parseInt(e.value, 10) || 0; setter(L, val); if (v) v.textContent = _ambFmtMs(val); sync(); persist(); }); };
      bindFx('rev', (q, v) => { q.revSend = v; }); bindFx('dly-mix', (q, v) => { q.delay.mix = v; }); bindFx('dly-time', (q, v) => { q.delay.timeMs = v; }); bindFx('dly-fb', (q, v) => { q.delay.feedback = v; }); bindFx('dist-amt', (q, v) => { q.dist.amount = v; }); bindFx('dist-mix', (q, v) => { q.dist.mix = v; });
      ['vca', 'vco', 'vcf'].forEach(t => { if (inst.mod && inst.mod[t]) { setVal('mod-' + t + '-depth', inst.mod[t].depth); setVal('mod-' + t + '-rate', inst.mod[t].rate); const sh = el('mod-' + t + '-shape'); if (sh) sh.value = inst.mod[t].shape; } });
      setVal('fx-rev', inst.revSend);
      if (inst.delay) { setVal('fx-dly-mix', inst.delay.mix); setVal('fx-dly-time', inst.delay.timeMs); const dt = el('fx-dly-time-v'); if (dt) dt.textContent = _ambFmtMs(inst.delay.timeMs); setVal('fx-dly-fb', inst.delay.feedback); }
      if (inst.dist) { setVal('fx-dist-amt', inst.dist.amount); setVal('fx-dist-mix', inst.dist.mix); }
    }
    function _ambRenderExtras(E) {
      const wrap = _ambGet(E, 'ambient-extra-layers'); if (!wrap) return;
      const cfg = E.getCfg(); if (!cfg) return;
      if (!Array.isArray(cfg.extras)) cfg.extras = [];
      wrap.innerHTML = _ambNamespaceHtml(E, cfg.extras.map(inst => _ambInstCardHtml(inst)).join(''));
      cfg.extras.forEach(inst => _ambWireInst(E, inst));
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
      const key = type + ':' + id;
      cfg.extras.splice(idx, 1);
      try { if (E.mod[key]) _ambTeardownMod(key); } catch (e) {}
      try { if (E.freeze) delete E.freeze[key]; } catch (e) {}
      if (E.seqState) delete E.seqState[key];
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
    };
    function _normalizeRamp(r, id) {
      if (!Number.isFinite(r.id)) r.id = id;
      if (typeof r.on !== 'boolean') r.on = true;
      if (typeof r.target !== 'string') r.target = 'bed.level';
      if (!Number.isFinite(r.a)) r.a = 0;
      if (!Number.isFinite(r.b)) r.b = 100;
      if (!Number.isFinite(r.periodMs)) r.periodMs = 4000;
      r.periodMs = Math.max(50, r.periodMs | 0);
      if (['sine','triangle','saw','square'].indexOf(r.wave) < 0) r.wave = 'sine';
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
      if (head === 'bed' || head === 'motif' || head === 'texture' || head === 'beat') {
        obj = cfg[head];
      } else if (head.indexOf('seq:') === 0) {
        const sid = parseInt(head.slice(4), 10);
        obj = (cfg.seqs || []).find(s => s.id === sid); cat = 'seq';
      } else if (head.indexOf('samp:') === 0) {
        const sid = parseInt(head.slice(5), 10);
        obj = (cfg.samples || []).find(s => s.id === sid); cat = 'samp';
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
      add('Bed', 'bed', 'bed'); add('Motif', 'motif', 'motif'); add('Texture', 'texture', 'texture'); add('Beat', 'beat', 'beat');
      (cfg.seqs || []).forEach((s, i) => add('Seq' + (i + 1), 'seq:' + s.id, 'seq'));
      (cfg.samples || []).forEach((s, i) => add('Sample' + (i + 1), 'samp:' + s.id, 'samp'));
      return g;
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
    function _ambApplyRamps(cfg, nowSec) {
      if (!cfg || !Array.isArray(cfg.ramps) || !cfg.ramps.length) return;
      for (const r of cfg.ramps) {
        if (!r || !r.on) continue;
        const res = _ambRampResolve(cfg, r.target);
        if (!res) continue;
        const period = Math.max(50, r.periodMs | 0);
        const phase = ((nowSec * 1000) % period) / period;
        const f = _ambRampFactor(r.wave, phase);
        let v = r.a + f * (r.b - r.a);
        v = Math.max(res.min, Math.min(res.max, v));
        res.obj[res.key] = Math.round(v);
      }
    }
    function _ambRampRowHtml(r, cfg) {
      const id = r.id, p = 'ambient-ramp-' + id + '-';
      const groups = _ambRampTargetGroups(cfg);
      const tgtOpts = groups.map(grp =>
        '<optgroup label="' + grp.label + '">' +
        grp.items.map(it => '<option value="' + it.value + '"' + (it.value === r.target ? ' selected' : '') + '>' + it.label + '</option>').join('') +
        '</optgroup>').join('');
      const waveOpts = [['sine','Sine'],['triangle','Triangle'],['saw','Saw'],['square','Square']]
        .map(w => '<option value="' + w[0] + '"' + (r.wave === w[0] ? ' selected' : '') + '>' + w[1] + '</option>').join('');
      return '<div class="ambient-ramp-row" data-ramp-id="' + id + '">' +
        '<div class="ambient-ramp-head">' +
          '<button type="button" class="ambient-toggle ambient-ramp-on" id="' + p + 'on">Ramp</button>' +
          '<select id="' + p + 'target" class="ambient-select ambient-ramp-target">' + tgtOpts + '</select>' +
          '<button type="button" class="ambient-seq-del" id="' + p + 'del" title="Delete ramp" aria-label="Delete ramp">✕</button>' +
        '</div>' +
        '<div class="ambient-ramp-params">' +
          '<span class="ambient-hint ambient-ramp-range" id="' + p + 'range"></span>' +
          '<label>A<input type="number" id="' + p + 'a" class="ambient-ramp-num" value="' + r.a + '"></label>' +
          '<label>B<input type="number" id="' + p + 'b" class="ambient-ramp-num" value="' + r.b + '"></label>' +
          '<label>Period<input type="number" id="' + p + 'period" class="ambient-ramp-num" min="50" step="50" value="' + r.periodMs + '"><span class="ambient-hint">ms</span></label>' +
          '<label>Wave<select id="' + p + 'wave" class="ambient-select ambient-ramp-wave">' + waveOpts + '</select></label>' +
        '</div>' +
      '</div>';
    }
    function _ambRampSyncABRange(E, id) {
      const cfg = E.getCfg(); if (!cfg) return;
      const r = (cfg.ramps || []).find(x => x.id === id); if (!r) return;
      const res = _ambRampResolve(cfg, r.target); if (!res) return;
      const p = 'ambient-ramp-' + id + '-';
      ['a', 'b'].forEach(k => { const e = _ambGet(E, p + k); if (e) { e.min = res.min; e.max = res.max; } });
      // Show the param's valid range + its current value so the user knows
      // what A/B to dial in.
      const rg = _ambGet(E, p + 'range');
      if (rg) rg.textContent = res.min + '–' + res.max + ' (now ' + Math.round(res.obj[res.key]) + ')';
    }
    function _ambWireRamp(E, r) {
      const id = r.id, p = 'ambient-ramp-' + id + '-';
      const getR = () => { const c = E.getCfg(); return (c && Array.isArray(c.ramps)) ? c.ramps.find(x => x.id === id) : null; };
      const persist = () => { if (typeof persistWorkspace === 'function') persistWorkspace(); };
      const el = (suf) => _ambGet(E, p + suf);
      const onB = el('on');
      if (onB) { onB.classList.toggle('on', !!r.on); onB.addEventListener('click', () => { _E = E; const R = getR(); if (!R) return; R.on = !R.on; onB.classList.toggle('on', R.on); persist(); }); }
      const tgt = el('target');
      if (tgt) tgt.addEventListener('change', () => {
        _E = E; const R = getR(); if (!R) return;
        R.target = tgt.value;
        // Reseed A/B to the new param's current value so switching targets
        // doesn't carry over an out-of-range / silencing value.
        const c = E.getCfg(); const res = _ambRampResolve(c, R.target);
        if (res) {
          const cur = Math.round(res.obj[res.key]);
          R.a = cur; R.b = cur;
          const ae = el('a'), be = el('b');
          if (ae) ae.value = String(cur);
          if (be) be.value = String(cur);
        }
        _ambRampSyncABRange(E, id);
        persist();
      });
      const a = el('a'); if (a) a.addEventListener('input', () => { _E = E; const R = getR(); if (!R) return; R.a = parseFloat(a.value) || 0; persist(); });
      const b = el('b'); if (b) b.addEventListener('input', () => { _E = E; const R = getR(); if (!R) return; R.b = parseFloat(b.value) || 0; persist(); });
      const per = el('period'); if (per) per.addEventListener('input', () => { _E = E; const R = getR(); if (!R) return; R.periodMs = Math.max(50, parseInt(per.value, 10) || 1000); persist(); });
      const wv = el('wave'); if (wv) wv.addEventListener('change', () => { _E = E; const R = getR(); if (!R) return; R.wave = wv.value || 'sine'; persist(); });
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
      const target = 'bed.level';
      const res = _ambRampResolve(cfg, target);
      // Default A and B to the param's CURRENT value so adding a ramp doesn't
      // immediately move (or, for Level, silence) the parameter — the user
      // then sets distinct A/B to define the sweep.
      const cur = res ? Math.round(res.obj[res.key]) : 0;
      cfg.ramps.push(_normalizeRamp({ id: newId, on: true, target, a: cur, b: cur, periodMs: 4000, wave: 'sine' }, newId));
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
      cfg[layer].present = false;
      _ambSyncControls(E);                                   // hides the card
      if (E.timer) { try { _ambSyncMods(); } catch (e) {} }  // tears down its chain
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Apply a distilled sequence "unit" to an engine's Seq layers.
    // mode: 'new' (new SeqN) | 'append' (grow first unit) | 'interleave' (add a unit).
    function _ambSendSeedToInstance(E, unit, mode, targetSeqId) {
      if (!_ambValidUnit(unit)) return false;
      const cfg = E.getCfg(); if (!cfg) return false;
      if (!Array.isArray(cfg.seqs)) cfg.seqs = [];
      let eff = mode;
      if ((mode === 'append' || mode === 'interleave') && !cfg.seqs.length) eff = 'new';
      if (eff === 'new') {
        const id = cfg.seqs.reduce((m, s) => Math.max(m, s.id | 0), 0) + 1;
        const seq = _defaultSeqLayer(id);
        seq.units = [unit];
        seq.scale = (unit.scale && typeof SCALES !== 'undefined' && SCALES[unit.scale]) ? unit.scale : '';
        cfg.seqs.push(seq);
      } else {
        const seq = cfg.seqs.find(s => s.id === targetSeqId) || cfg.seqs[cfg.seqs.length - 1];
        if (eff === 'append') {
          if (!seq.units.length) seq.units = [unit];
          else seq.units[0] = { ...seq.units[0], events: seq.units[0].events.concat(unit.events) };
        } else {
          seq.units.push(unit);
          if (seq.units.length > 1) seq.unitMode = 'interleave';
        }
        seq.on = true;
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
      ['free', 'sync'].forEach(t => { const el = document.getElementById(tr('ambient-timing-' + t)); if (el) el.classList.toggle('active', cfg.timing === t); });
      set('ambient-space', cfg.space);
      set('ambient-prog-rate', cfg.progRateMs); hint('ambient-prog-rate-v', _ambFmtMs(cfg.progRateMs));
      set('ambient-freeze-len', cfg.freezeLenMs); hint('ambient-freeze-len-v', _ambFmtMs(cfg.freezeLenMs));
      if (cfg.reverb) { set('ambient-reverb-size', cfg.reverb.size); set('ambient-reverb-damp', cfg.reverb.damp); }
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
      set('ambient-bed-when', cfg.bed.when);
      set('ambient-bed-motion', cfg.bed.motion);
      set('ambient-bed-strum', cfg.bed.strum);
      set('ambient-bed-strumfid', cfg.bed.strumFidelity);
      set('ambient-bed-level', cfg.bed.level);
      chk('ambient-motif-on', cfg.motif.on);
      set('ambient-motif-tone', cfg.motif.tone);
      { const _nb = document.getElementById(tr('ambient-motif-notes')); if (_nb) _nb.textContent = _ambNotesLabel(_ambNotesOf(cfg.motif)); }
      set('ambient-motif-register', cfg.motif.register);
      set('ambient-motif-range', cfg.motif.range);
      set('ambient-motif-interval', cfg.motif.intervalMs); hint('ambient-motif-interval-v', _ambFmtMs(cfg.motif.intervalMs));
      set('ambient-motif-length', cfg.motif.lengthMs);     hint('ambient-motif-length-v', _ambFmtMs(cfg.motif.lengthMs));
      set('ambient-motif-drift', cfg.motif.drift);
      set('ambient-motif-when', cfg.motif.when);
      set('ambient-motif-rest', cfg.motif.restProb);
      set('ambient-motif-twist', cfg.motif.twist);
      set('ambient-motif-level', cfg.motif.level);
      chk('ambient-texture-on', cfg.texture.on);
      set('ambient-texture-tone', cfg.texture.tone);
      { const _nb = document.getElementById(tr('ambient-texture-notes')); if (_nb) _nb.textContent = _ambNotesLabel(_ambNotesOf(cfg.texture)); }
      set('ambient-texture-register', cfg.texture.register);
      set('ambient-texture-fill', cfg.texture.fill);
      set('ambient-texture-interval', cfg.texture.intervalMs); hint('ambient-texture-interval-v', _ambFmtMs(cfg.texture.intervalMs));
      set('ambient-texture-length', cfg.texture.lengthMs);     hint('ambient-texture-length-v', _ambFmtMs(cfg.texture.lengthMs));
      set('ambient-texture-drift', cfg.texture.drift);
      set('ambient-texture-when', cfg.texture.when);
      set('ambient-texture-mutate', cfg.texture.mutateRate);
      set('ambient-texture-level', cfg.texture.level);
      chk('ambient-beat-on', cfg.beat.on);
      set('ambient-beat-kit', cfg.beat.kit);
      set('ambient-beat-interval', cfg.beat.intervalMs); hint('ambient-beat-interval-v', _ambFmtMs(cfg.beat.intervalMs));
      set('ambient-beat-length', cfg.beat.lengthMs);     hint('ambient-beat-length-v', _ambFmtMs(cfg.beat.lengthMs));
      set('ambient-beat-drift', cfg.beat.drift);
      set('ambient-beat-when', cfg.beat.when);
      set('ambient-beat-rest', cfg.beat.restProb);
      set('ambient-beat-level', cfg.beat.level);
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
      _ambRenderExtras(E);
      _ambRenderRamps(E);
      try { _ambFreezeSyncAll(E); } catch (e) {} // restore freeze-button states after re-render
      try { _ambSoloSyncAll(E); } catch (e) {}   // restore solo-button states after re-render
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        const m = cfg[layer] && cfg[layer].mod;
        if (!m) return;
        ['vca', 'vco', 'vcf'].forEach(t => {
          if (!m[t]) return;
          set('ambient-' + layer + '-mod-' + t + '-depth', m[t].depth);
          set('ambient-' + layer + '-mod-' + t + '-rate', m[t].rate);
          set('ambient-' + layer + '-mod-' + t + '-shape', m[t].shape);
        });
      });
      const seedEl = document.getElementById(E.seedId);
      if (seedEl) seedEl.textContent = '#' + (cfg.seed >>> 0);
      _ambRefreshPlayBtn(E);
    }
    function _ambientInit(E) {
      if (E.inited) { _ambSyncControls(E); _ambStartViz(E); return; }
      const host = document.getElementById(E.hostId);
      if (!host) return;
      // Build with the shared module-scope builders ('ambient-' id stems);
      // _ambNamespaceHtml rewrites the stems to E.idPrefix below.
      const sl = _ambSl, tm = _ambTm, head = _ambHead, shapeSel = _ambShapeSel,
            condCtrl = _ambCondCtrl, modTarget = _ambModTarget, modUi = _ambModUi, fxUi = _ambFxUi;
      let html =
        '<div class="ambient-title">Bloom — generative ambient' + (E.isLane ? '' : ' (master)') + '</div>' +
        '<canvas id="ambient-viz" class="ambient-viz"></canvas>' +
        '<div class="ambient-row">' +
          '<button type="button" id="ambient-play-btn" class="ambient-play">▶ Play</button>' +
          '<button type="button" id="ambient-regen-btn" class="ambient-regen" title="New random seed">✨ Regenerate</button>' +
          '<button type="button" id="ambient-reset-btn" class="ambient-regen" title="Reset this Bloom to defaults (one Bed, default settings)">↺ Reset</button>' +
          (E.isLane ? '<button type="button" id="ambient-freeze-btn" class="ambient-regen" title="Print the generated output to a new editable lane">❄ Freeze→lane</button>' : '') +
          '<button type="button" id="ambient-export-btn" class="ambient-regen" title="Record a fixed length of Bloom and save it to Google Drive">⤓ Export→Drive</button>' +
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
        sl('Space', 'ambient-space', 0, 100, 0, 'centre → wide') +
        tm('Chord rate', 'ambient-prog-rate', 500, 8000, 100, 4000) +
        tm('Freeze length', 'ambient-freeze-len', 1000, 30000, 500, 10000) +
        // Dedicated reverb (fed by each layer's "Reverb send").
        '<div class="ambient-reverb"><div class="ambient-mod-sub">Reverb</div>' +
          sl('Size', 'ambient-reverb-size', 0, 100, 80, 'small → large') +
          sl('Damp', 'ambient-reverb-damp', 0, 100, 45, 'bright → dark') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head('Bed', 'ambient-bed-on', 'ambient-bed-del', 'bed') +
          '<div class="ambient-ctrl"><label for="ambient-bed-tone">Tone</label><select id="ambient-bed-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          _ambNotesButtonHtml('ambient-bed') +
          sl('Density', 'ambient-bed-density', 1, 8, 4, 'voices') +
          sl('Register', 'ambient-bed-register', 2, 6, 4, 'octave') +
          sl('Spread', 'ambient-bed-spread', 0, 3, 2, '± oct') +
          tm('Interval', 'ambient-bed-interval', 200, 12000, 50, 4750) +
          tm('Length', 'ambient-bed-length', 300, 16000, 100, 6650) +
          sl('Drift', 'ambient-bed-drift', 0, 99, 0, 'phase offset') +
          condCtrl('bed') +
          sl('Motion', 'ambient-bed-motion', 0, 100, 30, 'detune') +
          sl('Strum', 'ambient-bed-strum', 0, 100, 0, 'chord → arp') +
          sl('Fidelity', 'ambient-bed-strumfid', 0, 100, 0, 'in order → random') +
          sl('Level', 'ambient-bed-level', 0, 100, 70, 'soft → boost') +
          modUi('bed') +
          fxUi('bed') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head('Motif', 'ambient-motif-on', 'ambient-motif-del', 'motif') +
          '<div class="ambient-ctrl"><label for="ambient-motif-tone">Tone</label><select id="ambient-motif-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          _ambNotesButtonHtml('ambient-motif') +
          sl('Register', 'ambient-motif-register', 2, 7, 5, 'octave') +
          sl('Range', 'ambient-motif-range', 1, 4, 2, '± oct') +
          tm('Interval', 'ambient-motif-interval', 100, 4000, 20, 1200) +
          tm('Length', 'ambient-motif-length', 80, 4000, 20, 1000) +
          sl('Drift', 'ambient-motif-drift', 0, 99, 0, 'phase offset') +
          condCtrl('motif') +
          sl('Rests', 'ambient-motif-rest', 0, 100, 30, '%') +
          sl('Twist', 'ambient-motif-twist', 0, 100, 0, 'steady → bursts') +
          sl('Level', 'ambient-motif-level', 0, 100, 70, 'soft → boost') +
          modUi('motif') +
          fxUi('motif') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head('Texture', 'ambient-texture-on', 'ambient-texture-del', 'texture') +
          '<div class="ambient-ctrl"><label for="ambient-texture-tone">Tone</label><select id="ambient-texture-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          _ambNotesButtonHtml('ambient-texture') +
          sl('Register', 'ambient-texture-register', 3, 7, 6, 'octave') +
          sl('Fill', 'ambient-texture-fill', 0, 100, 35, 'sparse→busy') +
          tm('Interval', 'ambient-texture-interval', 80, 2000, 10, 450) +
          tm('Length', 'ambient-texture-length', 60, 2000, 10, 300) +
          sl('Drift', 'ambient-texture-drift', 0, 99, 0, 'phase offset') +
          condCtrl('texture') +
          sl('Mutate', 'ambient-texture-mutate', 0, 100, 40, 'slow→fast') +
          sl('Level', 'ambient-texture-level', 0, 100, 70, 'soft → boost') +
          modUi('texture') +
          fxUi('texture') +
        '</div>' +
        '<div class="ambient-layer collapsed">' + head('Beat', 'ambient-beat-on', 'ambient-beat-del', 'beat') +
          '<div class="ambient-ctrl"><label for="ambient-beat-kit">Kit</label>' +
            '<select id="ambient-beat-kit" class="ambient-select"></select><span class="ambient-hint">drums</span></div>' +
          tm('Interval', 'ambient-beat-interval', 80, 2000, 10, 500) +
          tm('Length', 'ambient-beat-length', 60, 2000, 10, 200) +
          sl('Drift', 'ambient-beat-drift', 0, 99, 0, 'phase offset') +
          condCtrl('beat') +
          sl('Rests', 'ambient-beat-rest', 0, 100, 25, '%') +
          sl('Level', 'ambient-beat-level', 0, 100, 70, 'soft → boost') +
          modUi('beat') +
          fxUi('beat') +
        '</div>' +
        // Add-layer button — Bloom starts with just Bed; this adds the other
        // built-in layer types (Motif / Texture / Beat) on demand.
        '<div class="ambient-add-layer-row">' +
          '<button type="button" class="ambient-regen ambient-add-layer" id="ambient-add-layer" title="Add a layer">+ Add layer</button>' +
        '</div>' +
        '<div class="ambient-seq-layers" id="ambient-extra-layers"></div>' +
        '<div class="ambient-seq-layers" id="ambient-seq-layers"></div>' +
        '<div class="ambient-seq-layers" id="ambient-sample-layers"></div>' +
        // Parameter ramps — LFO automation of a layer param (A→B, period, wave).
        '<div class="ambient-ramps-section">' +
          '<div class="ambient-ramps-head"><span class="ambient-mod-sub">Ramps</span>' +
            '<button type="button" class="ambient-regen ambient-ramp-add" id="ambient-ramp-add" title="Add a parameter ramp">+ Add ramp</button></div>' +
          '<div class="ambient-ramps" id="ambient-ramps"></div>' +
        '</div>' +
        '<div class="ambient-note">' + (E.isLane ? 'Routes through this lane’s bus — dial in its Reverb send for the full wash.' : 'Plays through the master bus, independent of lanes.') + ' Follows the current Scale &amp; Key. Use “Send to Bloom” on a saved sequence' + (E.isLane ? ' or a lane' : '') + ' to add Seq layers.</div>';
      host.innerHTML = _ambNamespaceHtml(E, html);

      // Per-layer expand/collapse: the caret in each layer head folds that
      // layer's body away (the on/off toggle stays). UI-only state on the DOM —
      // the panel is built once, so it survives lane switches; not persisted.
      host.querySelectorAll('.ambient-collapse').forEach(btn => {
        btn.addEventListener('click', () => {
          const layer = btn.closest('.ambient-layer');
          if (layer) layer.classList.toggle('collapsed');
        });
      });
      // Per-layer Freeze button — one delegated handler (buttons get rebuilt as
      // dynamic layers re-render; data-fkey carries the layer key).
      host.addEventListener('click', (e) => {
        const sb = e.target && e.target.closest && e.target.closest('.ambient-solo-btn');
        if (sb) { e.stopPropagation(); try { _ambToggleSolo(E, sb.dataset.skey); } catch (err) { console.warn('Solo failed', err); } return; }
        const fb = e.target && e.target.closest && e.target.closest('.ambient-freeze-btn');
        if (!fb) return;
        e.stopPropagation();
        try { _ambFreezeCycle(E, fb.dataset.fkey); } catch (err) { console.warn('Freeze failed', err); }
      });
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
          (sel) => populateGroupedToneSelect(sel, _ambToneOptions(), { value: '', label: 'Grid voice' }));
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
          const shapeEl = G('ambient-' + layer + '-mod-' + target + '-shape');
          if (shapeEl) shapeEl.addEventListener('change', () => {
            _E = E; const cfg = cfg0(); if (!cfg) return;
            cfg[layer].mod[target].shape = shapeEl.value || 'sine';
            if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
            persist();
          });
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
      bind('ambient-space', null, 'space');
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
      bindTime('ambient-motif-interval', 'motif', 'intervalMs');
      bindTime('ambient-motif-length', 'motif', 'lengthMs');
      bind('ambient-motif-drift', 'motif', 'drift');
      bind('ambient-motif-rest', 'motif', 'restProb');
      bind('ambient-motif-twist', 'motif', 'twist');
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
      bind('ambient-beat-drift', 'beat', 'drift');
      bind('ambient-beat-rest', 'beat', 'restProb');
      bind('ambient-beat-level', 'beat', 'level');
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
        const sel = G('ambient-' + layer + '-when');
        if (!sel) return;
        sel.addEventListener('change', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg[layer].when = sel.value || 'always';
          persist();
        });
      };
      ['bed', 'motif', 'texture', 'beat'].forEach(bindCond);

      const toggle = (id, layer) => {
        const el = G(id);
        if (!el) return;
        el.addEventListener('click', () => {
          _E = E; const cfg = cfg0(); if (!cfg) return;
          cfg[layer].on = !cfg[layer].on;
          el.classList.toggle('on', cfg[layer].on);
          if (E.timer) { try { _ambSyncMods(); } catch (e) {} }
          persist();
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
      if (exportBtn) exportBtn.addEventListener('click', () => { _ambExportToDrive(E); });

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
