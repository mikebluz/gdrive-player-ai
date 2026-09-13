// ─────────────────────────────────────────────────────────────────────────────
// BLOOM LAYER MODEL v2 — slice 1: the spine
//
// THE MODEL (see docs/bloom-layer-v2.md):
//
//   A layer is an INSTRUMENT and a PART.
//   A part is LIVE (rules resolved at play time) or RECORDED (notes read back).
//   Both satisfy ONE interface:  given a window and a context, return notes.
//   Write is the door between them (not in this slice).
//
// There is no `type` here, and no `role`. A layer's identity is its NAME.
//
// ISOLATION: v2 layers live in `cfg.layers`, a NEW array beside `cfg.extras`.
// Absent → not one line of this file runs, so every existing project is
// byte-identical by construction. v1 is untouched; the two coexist in the same
// area, the same mix and the same transport.
//
// THE ONE SEAM: v2 emits through the SAME `playNote` with the same emit-scope
// conventions as v1 (a capture sink installed around the emit, which is what
// stamps `_ambEmitKey` inside playNote). Everything downstream — the per-layer
// chain, the mixer, FX, the playback gates, the WASM core, the master chain and
// the native broadcast — therefore works unchanged and is NOT reimplemented.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const A4 = () => (typeof masterFreqA === 'number' ? masterFreqA : 440);
  const midiToFreq = (m) => A4() * Math.pow(2, (m - 69) / 12);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Per-note staging for a v2 note. v1's emitters each stage their own LOW (a
  // motif at ×0.32 of the cell, a bass ×0.34, a run ×0.32) and the Level FADER
  // lifts the whole layer from there; v2 has one emitter, so one number, and it
  // matches the motif's so a v2 layer and a v1 layer at the same Level sit at
  // the same loudness. Staged high instead, v2 arrived roughly twice as loud as
  // everything else.
  const _AMB_V2_STAGE = 32;
  // v1's five gesture cells, verbatim: [relative onset, relative duration,
  // is-the-arrival]. Quick notes exist to reach long ones — that is the whole
  // idea, and why the arrival is both the longest and the loudest.
  const _V2_CELLS = [
    [[0, 0.92, 1]],                                                      // arrival — one long note
    [[0, 0.13, 0], [0.16, 0.13, 0], [0.32, 0.13, 0], [0.48, 0.48, 1]],   // run-up → arrival
    [[0, 0.42, 0], [0.48, 0.13, 0], [0.64, 0.32, 1]],                    // dotted figure
    [[0, 0.28, 0], [0.5, 0.44, 1]],                                      // short–LONG pair
    [[0.66, 0.1, 0], [0.8, 0.18, 1]],                                    // late pickup
  ];

  // The eight kit lanes, in v1's own order and semitone mapping (`_AMB_VDRUM`
  // / `_AMB_DRUM_NAMES`) so a v2 kit plays the SAME drums a v1 Beat does. Read
  // from v1 when it is there rather than duplicated, because two copies of a
  // drum map is exactly how the two come to disagree about which lane is a clap.
  const _V2_VDRUM = (typeof _AMB_VDRUM !== 'undefined' && Array.isArray(_AMB_VDRUM))
    ? _AMB_VDRUM.slice() : [0, 2, 4, 3, 5, 7, 9, 11];
  const _V2_LANES = _V2_VDRUM.length;
  const _V2_LANE_NAMES = _V2_VDRUM.map((pc) => {
    try { if (typeof _AMB_DRUM_NAMES !== 'undefined' && _AMB_DRUM_NAMES[pc]) return _AMB_DRUM_NAMES[pc]; } catch (x) {}
    return 'Lane ' + pc;
  });

  // AN EMPTY TONE IS NOT A VOICE. `instrument.tone: ''` means "whatever the grid
  // uses", and v1 resolves that through `_ambLayerType` before it ever reaches
  // playNote (a v1 motif with tone '' sends `type: 'sawtooth'`). v2 passed the
  // empty string straight through, and playNote has no voice for it: measured at
  // the master tap, tone '' = peak 0.0000 while 'sine' = 0.8428. THE DEFAULT WAS
  // SILENT — since slice 1 — and every check until now counted playNote calls or
  // inspected the note list rather than listening, so nothing caught it.
  function toneOf(L) {
    const t = (L.instrument && L.instrument.tone) || '';
    try { if (typeof _ambLayerType === 'function') return _ambLayerType(t); } catch (e) {}
    return t || 'sine';
  }

  // v1's SHARED PARAMS BUILDER wants everything flat on one object; v2 keeps the
  // envelope under `instrument`. This shim is the join — and it is what gives v2
  // humanize, velocity jitter, fine detune, glide and voiceTrim in ONE call,
  // with v1's exact semantics, instead of six reimplementations.
  //
  // CACHED, and NON-ENUMERABLE so `persistWorkspace` (which does serialise
  // underscore fields — the documented trap) never sees it. It must be STABLE
  // per layer: `_ambApplyAdsr` hangs `glideLayer` off it and playNote tracks the
  // previous frequency there, so a fresh object per note would silently disable
  // portamento.
  function adsrShim(L) {
    let sh = L.__v2shim;
    if (!sh) {
      sh = {};
      try { Object.defineProperty(L, '__v2shim', { value: sh, enumerable: false, writable: true, configurable: true }); }
      catch (e) { return Object.assign({}, L, L.instrument); }
    }
    const i = L.instrument || {};
    sh.humanize = L.humanize; sh.velVar = L.velVar; sh.fine = L.fine;
    sh.portamento = L.portamento; sh.voiceTrim = L.voiceTrim;
    sh.attack = i.attack; sh.decay = i.decay; sh.sustain = i.sustain; sh.release = i.release;
    return sh;
  }

  // EVERY v1 EMITTER STAMPS `_ambKeyTime = at` BEFORE RESOLVING A NOTE, and v2
  // did not. Two things depend on it, and both were quietly wrong:
  //   · `_ambVelJitter01` seeds off it, so Vel var never replayed for a take —
  //     with a constant stamp its internal sequence counter just keeps counting
  //     (measured: three runs of one take gave three different volume streams).
  //   · `_ambKeyRootPc` / `_ambPartKeyNow` / `_ambSectionKeyNow` resolve the key
  //     in force AT THAT NOTE from it, so without the stamp v2 read the key at
  //     the AUDIO CLOCK instead — wrong either side of a section or part key
  //     change, which is exactly where it matters.
  // It is a top-level `let` in 17, i.e. a global lexical binding: assign the
  // BARE name (`window._ambKeyTime` would set an unrelated property).
  // ISOLATED draws for the variance family — keyed on (layer, cycle, onset, salt)
  // and NEVER `_ambRand`'s shared stream, so a v2 layer can never shift a v1
  // layer's draws and the same take always replays.
  function vRnd(seed, salt) {
    const h = (((seed | 0) ^ ((salt | 0) * 2654435761)) >>> 0);
    try { if (typeof _ambSeededRand === 'function') return _ambSeededRand(h)(); } catch (e) {}
    return Math.random();
  }

  // v1's word emitter reads a FLAT layer (`L.tone`, `L.level`, `L.word`) and
  // hands it to `_ambApplyAdsr` and `_ambLayerPan`. `adsrShim` already flattens
  // the envelope and the Performance family, so the word shim is that plus the
  // three fields it adds. Cached and NON-ENUMERABLE for the same two reasons:
  // `_ambLayerPan` and playNote hang state off the object it is given, and
  // persistWorkspace serialises underscore fields.
  function wordShim(L) {
    let sh = L.__v2word;
    if (!sh) {
      sh = {};
      try { Object.defineProperty(L, '__v2word', { value: sh, enumerable: false, writable: true, configurable: true }); }
      catch (e) { sh = {}; }
    }
    Object.assign(sh, adsrShim(L));
    sh.id = L.id; sh.tone = (L.instrument && L.instrument.tone) || '';
    sh.level = L.level; sh.word = L.word;
    sh.space = L.space; sh.panMode = L.panMode;
    return sh;
  }

  function withKeyTime(at, fn) {
    let prev = null, had = false;
    try { prev = _ambKeyTime; had = true; } catch (e) {}
    try { if (had) _ambKeyTime = at; } catch (e) {}
    try { return fn(); }
    finally { try { if (had) _ambKeyTime = prev; } catch (e) {} }
  }

  // SPEECH. The lines are DERIVED from the text, never stored — one source of
  // truth, so an edit cannot leave a stale split behind.
  function speechLines(L) {
    const t = (L.instrument && L.instrument.text) || '';
    if (!t.trim()) return [];
    // `L`, not null — `_ambSpokenLines` reads the layer's `lineWords` (and its
    // paragraph/sentence chunking), so passing null threw the Line-length
    // control away before it existed.
    try { if (typeof _ambSpokenLines === 'function') return _ambSpokenLines(t, L).filter(x => x && x.trim()); } catch (e) {}
    return t.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  }
  // RENDERED AUDIO LIVES ON THE ENGINE, in a WeakMap. Not on the layer
  // (`persistWorkspace` serialises underscore fields, so AudioBuffers would land
  // in the saved project) and not in `seqState` (`_ambResetClocks` empties that
  // on EVERY play — the documented bug that made Sir Eel re-synthesise on the
  // very press it had prepared for). Keyed per LINE and per VOICE, so editing
  // one sentence re-renders one line.
  const _speechCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
  function speechBank(E) {
    if (!_speechCache) return null;
    let m = _speechCache.get(E);
    if (!m) { m = new Map(); _speechCache.set(E, m); }
    return m;
  }
  const speechKey = (L, line) => ((L.instrument.speechVoice || '') + '\u0000' + line);

  function barSec(cfg) {
    const bpm = (cfg && Number.isFinite(cfg.bpm) && cfg.bpm > 0) ? cfg.bpm
      : ((typeof _ambBpm === 'function') ? _ambBpm() : 120);
    return (60 / Math.max(20, bpm)) * 4;
  }

  // ── NORMALIZE ───────────────────────────────────────────────────────────
  // Lazy and total: every v2 layer is coerced on read, so a hand-written or
  // half-migrated layer can never reach the emitter in a shape it can't handle.
  // Unknown enum values fall back rather than throwing — the v1 doctrine.
  // ── STATIC CONTENT vs LIVE CONTENT ──────────────────────────────────────
  // "Written" and "Generated" are not two kinds of thing. Both make a fixed
  // set of notes — one by hand note by note, one by setting parameters and
  // pressing a button — and neither changes on iterations. That is STATIC
  // CONTENT, and generation is a way of AUTHORING it rather than a mode.
  //
  // MEASURED, six consecutive cycles of a euclid x walk part, counting distinct
  // note sets: a default generated part gives ONE (every cycle identical), and
  // so do rhythm Vary, Rests, Ghosts, Len vary, Pitch vary and the `chance`
  // rhythm — every one of them seeds off a FIXED take, so they shape the
  // content ONCE, deterministically. They are content knobs, not dice.
  // `part.vary` gives SIX. It is the only content-level live switch there is.
  //
  // So liveness is not a stored mode — it is a PROPERTY of the settings, which
  // is what "once played it can become live at the user's discretion" means.
  // You never set Live; you turn something stochastic on and it becomes live.
  // Two tiers reach here, and both genuinely differ pass to pass:
  //   CONTENT   `part.vary` (fresh dice per cycle) · salt (re-colours the
  //             changes per instance, so a following layer re-voices)
  //   PERFORM   Humanize (UNSEEDED by design — never replays) · Vel var
  //             (seeded on position-in-the-performance, so successive passes
  //             differ) · a chord/section mask at a probability, which is a
  //             per-instance draw
  // Everything else is static by measurement, and saying so is the point.
  function liveness(L, cfg) {
    const why = [];
    if (!L || !L.part) return { live: false, why };
    // `Number.isFinite`, NOT `num` — that helper is declared in the UI IIFE and
    // this is the engine one. The bare name threw straight into `liveTxt`'s
    // catch and every layer answered "Static", including one with the dice on:
    // the documented swallowed-catch trap, committed by adding the catch.
    const pos = (v) => Number.isFinite(v) && v > 0;
    if (L.part.vary) why.push('the dice are thrown every cycle');
    if (pos(L.humanize)) why.push('Humanize nudges every note');
    if (pos(L.velVar)) why.push('Vel var moves each note\u2019s level');
    // a mask STRICTLY between 0 and 100 is a probability — 0 and 100 are
    // decisions, and a decision is static
    const anyProb = (m) => !!(m && Array.isArray(m.steps) &&
      m.steps.some((v) => Number.isFinite(v) && v > 0 && v < 100));
    if (anyProb(L.chordMask) || anyProb(L.sectionMask)) why.push('a probability decides some passes');
    // ── THE CHANGES THEMSELVES CAN BE LIVE ──────────────────────────────
    // Salt was here alone, and it is one of FOUR area-level dice that make the
    // harmony differ pass to pass — a layer following them plays different
    // notes, which is the same fact wearing a different hat. Measured over six
    // full trips of a 4-chord cycle, against the floor a STATIC figure sets by
    // simply moving through the changes (4 distinct note sets):
    //   salt colours 17 · prog.vary 13 · chord alternates 6 (either mode)
    // …and these are NOT live, by the same measurement — they land exactly on
    // the floor, because each is seeded once per TAKE or per SLOT rather than
    // per pass: 🎲 take-reroll, 🌡 tension, the ↻ order grid.
    //
    // GATED ON THE LAYER ACTUALLY FOLLOWING. A generated part always resolves
    // its pitches against the sounding chord; a WRITTEN one plays stored
    // pitches unless `harmony` says otherwise, so the changes moving beneath
    // it changes nothing it plays.
    const follows = (L.part.kind !== 'recorded') ||
      L.harmony === 'diatonic' || L.harmony === 'chordlock';
    if (follows) try {
      const pg = cfg && cfg.prog;
      if (pg && pg.on) {
        if (typeof _ambAnySaltColors === 'function' && _ambAnySaltColors(cfg))
          why.push('Salt re-colours the changes');
        if (Number.isFinite(pg.vary) && pg.vary > 0)
          why.push('the changes drift each pass');
        if (Array.isArray(pg.chords) && pg.chords.some((c) =>
            c && Array.isArray(c.alts) && c.alts.length))
          why.push('a change has alternates');
      }
    } catch (e) {}
    return { live: why.length > 0, why };
  }

  // ── THE MATERIAL'S FORM ─────────────────────────────────────────────────
  // A layer's content is authored and shown one of two ways, and they are
  // genuinely different instruments rather than two pictures of one thing:
  //   roll  — notes with their own time, pitch and length (the piano roll)
  //   steps — a fixed grid of on/off cells (a sequencer: arps and drum kits)
  // ORTHOGONAL to written/generated: each form can be filled by hand or by the
  // rules, which is the 2x2 the card already implements without saying so.
  // ABSENT = 'roll', so every project made before this is byte-identical.
  //
  // WHAT THE FORM SCOPES IS SMALL, and that is the point: of the ~45 fields
  // that shape material, only the grid's own (steps/rotate/vary/rows, cells,
  // lanes) and the note list's own (notes, grid, transpose, harmony, when) are
  // form-specific. Every pitch rule, every shape and every variance knob means
  // the same thing in both, because both have onsets and pitches. The axes
  // that really scope this card are `kind` (generated vs written) and `voice`
  // (synth vs kit), and both already existed.
  const FORMS = new Set(['roll', 'steps']);
  const formOf = (L) => {
    const f = L && L.part && L.part.form;
    return FORMS.has(f) ? f : 'roll';
  };
  const RHYTHMS = new Set(['pulse', 'euclid', 'chance', 'drawn', 'ground']);
  const PITCHES = new Set(['chord', 'fixed', 'stack', 'walk', 'anchor', 'series', 'chance', 'drawn', 'mixed']);
  const KINDS = new Set(['live', 'recorded']);

  // Divisions per bar. Triplet values are in the list because a swung or
  // triplet figure cannot be placed on any power-of-two grid, and 1/64 because
  // that is the finest the drawing can still resolve at a phone's width.
  const GRIDS = [[4, '1/4'], [8, '1/8'], [12, '1/8 T'], [16, '1/16'],
                 [24, '1/16 T'], [32, '1/32'], [64, '1/64']];
  const GRID_DIVS = new Set(GRIDS.map((g) => g[0]));
  const gridPerBar = (L) => {
    const g = (L && L.part && L.part.grid) | 0;
    return GRID_DIVS.has(g) ? g : 16;
  };
  // …and over one CYCLE, which is what a note's `t`/`dur` are fractions of.
  const gridCells = (L) => Math.max(1, Math.round(Math.max(0.0625,
    (L && L.part && L.part.bars) || 1) * gridPerBar(L)));

  // ── A REGION OF THE CYCLE ───────────────────────────────────────────────
  // Selection, per-region takes and per-region rules were all keyed by BAR
  // INDEX, and a bar is the wrong unit the moment a change does not fill one:
  // reported as "clicking F♯m should only select the F♯m area" on a cadence
  // where F♯m runs from the middle of bar 3 to its end — selecting the whole
  // bar was the honest answer to the wrong question.
  //
  // A REGION is a half-open range `[a, b)` of 1/48-BAR SLOTS over the cycle.
  // That grid is this file's own (`_ambSnapBars`, the window start, the rubato
  // edges): quarters, eighths, triplets and 16ths all land on it exactly, so a
  // change's span is representable and a bar is simply the region
  // `[N·48, (N+1)·48)`. Keys are the string `a + ':' + b`, and a BARE INTEGER
  // key is read as the bar it used to mean — which is the whole migration,
  // performed at read time, so no stored project has to be rewritten.
  const SPB = 48;
  const regKey = (a, b) => (a | 0) + ':' + (b | 0);
  const regBarKey = (bar) => regKey((bar | 0) * SPB, ((bar | 0) + 1) * SPB);
  function regParse(k) {
    const s2 = String(k), i2 = s2.indexOf(':');
    if (i2 < 0) { const b0 = s2 | 0; return b0 >= 0 ? { a: b0 * SPB, b: (b0 + 1) * SPB } : null; }
    const a = s2.slice(0, i2) | 0, b = s2.slice(i2 + 1) | 0;
    return (a >= 0 && b > a) ? { a, b } : null;
  }
  // WHERE A NOTE SITS ON THAT GRID. Not rounded — a note anywhere inside a
  // slot belongs to it, so the test is a plain half-open containment.
  const slotAt = (t, barsF) => (t || 0) * Math.max(0.125, barsF || 1) * SPB;
  const regHas = (keys, slot) => keys.some((k) => {
    const r = regParse(k); return r && slot >= r.a - 1e-6 && slot < r.b - 1e-6; });
  // WHAT TO CALL ONE. A whole bar is "bar 3"; whole bars are "bars 3–4"; and a
  // change that does not fill bars is named in bars AND fractions ("bar 2½–3"),
  // because a selection you cannot describe is one you cannot check.
  const REG_FR = { 0.25: '\u00bc', 0.5: '\u00bd', 0.75: '\u00be', 0.333: '\u2153', 0.667: '\u2154' };
  function regLabel(k) {
    const r = regParse(k); if (!r) return '?';
    const b0 = r.a / SPB, b1 = r.b / SPB;
    const whole = Math.abs(b0 - Math.round(b0)) < 1e-6 && Math.abs(b1 - Math.round(b1)) < 1e-6;
    if (whole) return (Math.round(b1) - Math.round(b0) === 1)
      ? ('bar ' + (Math.round(b0) + 1))
      : ('bars ' + (Math.round(b0) + 1) + '\u2013' + Math.round(b1));
    const fmt = (x) => { const wv = Math.floor(x + 1e-9), f = Math.round((x - wv) * 1000) / 1000;
      return (wv + 1) + (REG_FR[f] || (f > 1e-6 ? String(Math.round(f * 100) / 100).replace(/^0/, '') : '')); };
    return 'bar ' + fmt(b0) + '\u2013' + fmt(b1);
  }
  // A STORE KEYED BY REGION — coerced, clipped to the cycle, legacy bar keys
  // converted. Shared by `takeb` and `ruleb` so the two can never disagree
  // about what a key means.
  function regMapNorm(src, barsF, val) {
    if (!src || typeof src !== 'object') return null;
    const top = Math.max(1, Math.round(Math.max(0.125, barsF || 1) * SPB));
    const out = {};
    Object.keys(src).forEach((k) => {
      const r = regParse(k); if (!r) return;
      const a = Math.max(0, Math.min(top - 1, r.a)), b = Math.max(a + 1, Math.min(top, r.b));
      const v = val(src[k]); if (v === undefined) return;
      out[regKey(a, b)] = v;
    });
    return Object.keys(out).length ? out : null;
  }

  // ── WHAT A SINGLE BAR MAY OVERRIDE ──────────────────────────────────────
  // The generated settings that shape MATERIAL, and nothing else: a bar is a
  // slice of one part, so its instrument, its FX and its schedule are the
  // part's by definition — only what the rules make is per-bar. A string field
  // lists its legal values (an unknown rhythm kind would render the select
  // BLANK and drift the rules, the documented Groundwork bug); everything else
  // is [min, max] and is rounded and clamped on the way in, so the overlay can
  // be merged onto the part's rules WITHOUT a second normalize pass.
  const BAR_RULE_F = {
    rhythm: { kind: ['pulse', 'euclid', 'chance', 'ground', 'drawn'],
              pulses: [1, 64], steps: [2, 64], rotate: [0, 63], n: [1, 32],
              chance: [0, 100], syncop: [0, 100] },
    pitch:  { kind: ['drawn', 'chord', 'stack', 'fixed', 'series', 'anchor', 'walk', 'chance', 'mixed'],
              dir: ['up', 'down', 'updown'],
              voices: [1, 9], mix: [0, 100], span: [1, 12], contour: [-100, 100],
              lines: [1, 6], stutter: [0, 100], octaves: [1, 4], randomness: [0, 100] },
    shape:  { lenRatio: [5, 100] },
  };
  // THE RULES ONE BAR GENERATES BY — the part's, with that bar's overlay on
  // top. ONE definition, because the popover that edits it and the emitter
  // that rolls it must agree about what a half-set overlay means.
  function barRulesOf(p, key) {
    const ov = (p && p.ruleb && p.ruleb[key]) || null;
    return { rhythm: Object.assign({}, (p && p.rhythm) || {}, (ov && ov.rhythm) || {}),
             pitch: Object.assign({}, (p && p.pitch) || {}, (ov && ov.pitch) || {}),
             shape: Object.assign({}, (p && p.shape) || {}, (ov && ov.shape) || {}),
             own: !!ov };
  }
  // …and the same overlay as a PART, for the roll. `Object.assign` per group so
  // an overlay that names one field leaves the rest of that group alone.
  function partWithRules(p, ov) {
    if (!ov) return p;
    const q = Object.assign({}, p);
    delete q.ruleb;                      // a bar's own rules are not themselves per-bar

    if (ov.rhythm) q.rhythm = Object.assign({}, p.rhythm || {}, ov.rhythm);
    if (ov.pitch) q.pitch = Object.assign({}, p.pitch || {}, ov.pitch);
    if (ov.shape) q.shape = Object.assign({}, p.shape || {}, ov.shape);
    return q;
  }
  function normLayer(L, i) {
    if (!L || typeof L !== 'object') return null;
    L.v = 2;
    L.id = (L.id | 0) || (i + 1);
    if (typeof L.name !== 'string' || !L.name) L.name = 'Layer ' + L.id;
    L.on = L.on !== false;
    L.present = L.present !== false;
    L.solo = !!L.solo;                                    // shared with v1's solo

    // ── TREATMENTS ────────────────────────────────────────────────────────
    // Level, FX, bus, stereo and the schedule gates are NOT constituents of the
    // part model — they apply to every layer whatever its pieces — so they are
    // the SAME fields v1 uses, at the top level, coerced by v1's own
    // normalizers. That is what lets one resolver (`_ambLayerByKey`) hand a v2
    // layer to the chain builder, the mixer, the scheduler, solo and the
    // area-depart sweep with no change in any of them.
    L.level = clamp(Number.isFinite(L.level) ? L.level : ((L.instrument && L.instrument.level) | 0) || 70, 0, 100);
    // VARIANCE — treatments, not constituents: they apply whatever the pieces
    // are, which is why they sit here and not in the part. Kept beside
    // `humanize`/`velVar` (which `_ambNormalizeSpread` already gives us) so the
    // whole Performance/Variance family lives in one place.
    L.restProb = clamp(Number.isFinite(L.restProb) ? L.restProb : 0, 0, 100);
    L.ghosts = clamp(Number.isFinite(L.ghosts) ? L.ghosts : 0, 0, 100);
    L.lenVary = clamp(Number.isFinite(L.lenVary) ? L.lenVary : 0, 0, 100);
    // PLACEMENT. Register is on the instrument and `walk.span` already IS v1's
    // Range; what was missing is PROXIMITY — how far consecutive notes are
    // allowed to move. A live-PITCH treatment: it shapes the relationship
    // between successive picks, whatever kind is making them, and it is
    // meaningless on a recorded part (those notes are already chosen), which is
    // the same reason v1 marks Placement inert on a phrase.
    L.proximity = clamp(Number.isFinite(L.proximity) ? L.proximity : 0, 0, 100);
    // GROOVE — v1's own fields, read by `_ambSwingSec` / `_ambAccentVol` /
    // `_ambTightOn`, which also fold in the AREA GROOVE macros. Absent or 0 is
    // neutral in all three (accent draws no RNG at 0), so they are stored only
    // once moved.
    // `speed` follows v1 exactly: absent or 1 means untouched, so it is stored
    // only when it is doing something.
    if (L.speed !== undefined) {
      // A <select> writes a STRING, and `_ambRateMult` tests `Number.isFinite`
      // — so storing the raw value would have deleted it on the next normalize
      // and the control would have been dead. (v1's own speed control parses
      // for the same reason.) `parseFloat` here accepts both shapes.
      const sv = parseFloat(L.speed);
      if (Number.isFinite(sv) && sv > 0 && sv !== 1) L.speed = clamp(sv, 0.125, 8);
      else delete L.speed;
    }
    // HARMONY — what a RECORDED part does when the chords move under it.
    // 'fixed' plays it as written (v2's behaviour until now), the others remap
    // through v1's `_ambLockHarmonizeFreq`. Absent = fixed.
    if (L.harmony !== 'diatonic' && L.harmony !== 'chordlock') delete L.harmony;
    // SCHEDULED TONE — v1's own coercion, verbatim: absent = off, and a step
    // tone of '' means the layer's default voice.
    if (L.toneSeq != null) {
      const q = L.toneSeq;
      if (typeof q !== 'object' || !Array.isArray(q.steps)) delete L.toneSeq;
      else {
        q.on = (q.on === true || q.on === 1) ? 1 : 0;
        q.steps = q.steps.slice(0, 8).map(t2 => ({
          tone: (typeof t2.tone === 'string') ? t2.tone : '',
          bars: clamp((t2.bars | 0) || 4, 1, 32),
        }));
        if (!q.steps.length) delete L.toneSeq;
      }
    }
    // STRUM — absent or 0 is a struck chord and spends no RNG draw, so an
    // untouched layer is byte-identical and stores neither field.
    if (L.strum !== undefined) {
      if (Number.isFinite(L.strum) && L.strum > 0) L.strum = clamp(L.strum, 0, 100); else delete L.strum;
    }
    if (L.strumFidelity !== undefined) {
      if (Number.isFinite(L.strumFidelity) && L.strumFidelity > 0) L.strumFidelity = clamp(L.strumFidelity, 0, 100);
      else delete L.strumFidelity;
    }
    ['swing', 'accent'].forEach((k) => {
      if (L[k] === undefined) return;
      if (Number.isFinite(L[k]) && L[k]) L[k] = clamp(L[k], 0, 100); else delete L[k];
    });
    if (L.tight) L.tight = 1; else delete L.tight;
    try { if (typeof _ambNormalizeFx === 'function') _ambNormalizeFx(L); } catch (e) {}
    try { if (typeof _ambNormalizeSpread === 'function') _ambNormalizeSpread(L); } catch (e) {}
    try { if (typeof _ambNormalizeUnitGate === 'function') _ambNormalizeUnitGate(L); } catch (e) {}
    try { if (typeof _ambNormalizeSpat === 'function') _ambNormalizeSpat(L); } catch (e) {}
    // `voiceTrim` deliberately has NO normalize entry in v1 — absent or 0 is
    // gated out of `_ambApplyAdsr`, so a missing value simply fails
    // `Number.isFinite`. v2 keeps that: coerce only when present.
    if (L.voiceTrim !== undefined) {
      if (Number.isFinite(L.voiceTrim) && L.voiceTrim) L.voiceTrim = clamp(L.voiceTrim, -24, 12);
      else delete L.voiceTrim;
    }
    // `reso`, `fine` and `areaFadeMs` follow the SAME absent-is-neutral rule
    // v1 gives them: 0 (or the 250ms default fade) is what the engine assumes
    // when the field is missing, so an untouched layer stores none of them and
    // a saved project is byte-identical to one made before these controls
    // existed. Coerce only when present.
    [['reso', 0, 100], ['fine', -100, 100], ['areaFadeMs', 0, 4000]].forEach(([k, lo, hi]) => {
      if (L[k] === undefined) return;
      if (Number.isFinite(L[k])) L[k] = clamp(L[k], lo, hi); else delete L[k];
    });
    // `keyOv` — a layer following its OWN key or progression. Coerced by v1's
    // own normalizer, and read by `_ambNotesOf`, so it already WORKS on a v2
    // layer; what it still lacks is a control of its own (v1 builds that one
    // inline in its schema renderer rather than as a reusable builder).
    // MOD — the per-layer LFO matrix (VCA · VCO · VCF). It ALREADY WORKED on a
    // v2 layer the moment the chain existed: `_ambSyncMods` walks `_ambWantSet`
    // and `_ambSyncTarget` reads `L.mod`, both of which v2 joined in slice 5.
    // Measured before any of this was written: setting `L.mod.cutoff` built a
    // live source on the v2 chain. What it lacked was a CONTROL — and the
    // targets shaped, so the wiring (which bails on a missing `L.mod[t]`) has
    // something to write into. Seeded from v1's own `_ambDefaultMod`, and
    // PRUNED back to absent when every depth is 0, so an untouched layer stores
    // nothing and a saved project is unchanged.
    if (L.mod && typeof L.mod === 'object') {
      const d = (typeof _ambDefaultMod === 'function') ? _ambDefaultMod() : null;
      if (d) {
        L.mod.sync = (L.mod.sync === 'sync') ? 'sync' : 'free';
        ['vca', 'vco', 'vcf'].forEach((t) => {
          const m = (L.mod[t] && typeof L.mod[t] === 'object') ? L.mod[t] : (L.mod[t] = {});
          m.depth = clamp(Number.isFinite(m.depth) ? m.depth : 0, 0, 100);
          m.rate = clamp(Number.isFinite(m.rate) ? m.rate : d[t].rate, 0, 100);
          if (typeof m.shape !== 'string' || !m.shape) m.shape = 'sine';
        });
        if (!['vca', 'vco', 'vcf'].some((t) => (L.mod[t].depth | 0) > 0)) delete L.mod;
      }
    }
    // SPEECH FX and the WORD translator, coerced by v1's own normalizers. The
    // FX already WORKED — `_ambLearnPlay` (which v2 has called since the speech
    // instrument landed) resolves them through `_ambSpeechOpt(L)` — so, as with
    // the mod matrix, this is a surface over live machinery.
    try { if (typeof _ambNormalizeSpeech === 'function') _ambNormalizeSpeech(L); } catch (e) {}
    try { if (typeof _ambNormalizeWord === 'function') _ambNormalizeWord(L); } catch (e) {}
    if (L.wordOut !== 'play' && L.wordOut !== 'both') delete L.wordOut;
    // Absent = 'auto' (server if available), v1's own default.
    if (L.voiceFrom !== 'device' && L.voiceFrom !== 'server') delete L.voiceFrom;
    // ARTICLE SOURCE — v1's own field names, so v1's `_ambAmount`,
    // `_ambLineWords` and `_ambSpokenLines` read them without a shim.
    if (typeof L.source !== 'string' || !L.source) delete L.source;
    if (typeof L.term !== 'string' || !L.term) delete L.term;
    if (typeof L.article !== 'string' || !L.article) delete L.article;
    if (['short', 'medium', 'long', 'max'].indexOf(L.amount) < 0) delete L.amount;
    if (Number.isFinite(L.lineWords) && L.lineWords > 0) L.lineWords = clamp(L.lineWords | 0, 4, 60);
    else delete L.lineWords;
    // Absent = a chord layer holds what it struck, which is every layer's
    // behaviour today — so this is stored only when switched on.
    if (L.followSalt) L.followSalt = 1; else delete L.followSalt;
    // ARTICULATION — absent or 0 spends no draw and emits nothing extra, so an
    // untouched layer is byte-identical and stores neither.
    ['slide', 'ornament', 'twist', 'motion', 'phrasing', 'startVary'].forEach((k) => {
      if (L[k] === undefined) return;
      if (Number.isFinite(L[k]) && L[k] > 0) L[k] = clamp(L[k], 0, 100); else delete L[k];
    });
    // SYNTH KIT — v1's own coercion shape: absent = generated on demand from a
    // seed, so it is stored only once a voice has been edited or rolled.
    if (L.synthKit != null) {
      if (typeof L.synthKit !== 'object' || !Array.isArray(L.synthKit.voices) || L.synthKit.voices.length !== 8) {
        if (!L.synthKit || typeof L.synthKit !== 'object' || !Number.isFinite(L.synthKit.seed)) delete L.synthKit;
      }
    }
    try { if (typeof _ambNormalizeKeyOv === 'function') _ambNormalizeKeyOv(L); } catch (e) {}
    try { if (typeof _ambNormalizeChordMask === 'function') _ambNormalizeChordMask(L); } catch (e) {}

    const ins = (L.instrument && typeof L.instrument === 'object') ? L.instrument : (L.instrument = {});
    // THE INSTRUMENT IS AN ENUM NOW. 'kit' is what makes a v2 layer a drum
    // machine — and it is the INSTRUMENT that brings the multi-lane grid, not
    // the rhythm: v1's drum lanes are 8 lanes of one kit, and v2 had one row
    // only because it had one instrument.
    ins.voice = (ins.voice === 'kit' || ins.voice === 'speech') ? ins.voice : 'synth';
    // SPEECH. `voice` is the INSTRUMENT here, so the TTS voice needs its own
    // field — v1's `_ambVoiceChoices` reads `L.voice` meaning the TTS one, and
    // handing it a v2 layer would offer 'synth'/'kit'/'speech' as if they were
    // voices. `text` is the words; lines are derived, never stored.
    if (typeof ins.speechVoice !== 'string') ins.speechVoice = '';
    if (typeof ins.text !== 'string') ins.text = '';
    if (typeof ins.kit !== 'string' || !ins.kit) ins.kit = 'synth';   // 'synth' = the generated kit
    if (typeof ins.tone !== 'string') ins.tone = '';
    delete ins.level;                                     // migrated to the shared treatment above
    ins.register = clamp((ins.register | 0) || 4, 1, 8);
    ins.attack = clamp(Number.isFinite(ins.attack) ? ins.attack : 400, 0, 8000);
    ins.decay = clamp(Number.isFinite(ins.decay) ? ins.decay : 200, 0, 4000);
    ins.sustain = clamp(Number.isFinite(ins.sustain) ? ins.sustain : 80, 0, 100);
    ins.release = clamp(Number.isFinite(ins.release) ? ins.release : 1200, 0, 12000);

    const p = (L.part && typeof L.part === 'object') ? L.part : (L.part = {});
    p.kind = KINDS.has(p.kind) ? p.kind : 'live';
    // THE FORM — roll or steps (see FORMS). Absent = 'roll' and PRUNED at it,
    // so an untouched project stores nothing and reads exactly as before.
    if (!FORMS.has(p.form) || p.form === 'roll') delete p.form;
    // CYCLE — how long one pass of the part is. Live states it; a recorded part
    // may state it too (the length it was recorded at).
    p.bars = clamp(Number.isFinite(p.bars) && p.bars > 0 ? p.bars : 2, 0.125, 64);
    // THE EDITING GRID — divisions per BAR, i.e. a note VALUE, so it means the
    // same thing whatever length the part is. It used to be `rhythm.steps`
    // spread across the WHOLE cycle, which on a 5-bar part put the grid at
    // 1.25 beats and made hand-editing land on nothing musical. Absent = 16
    // (1/16), pruned at that value so an untouched project stores nothing.
    if (!GRID_DIVS.has(p.grid | 0)) delete p.grid;
    if ((p.grid | 0) === 16) delete p.grid;
    // THE TAKE — WHICH ROLL of a live part the preview and the drawing use.
    // A live part's seeded draws key on the CYCLE INDEX, so before this every
    // Preview press landed on whatever cycle the clock happened to be at and
    // played something different — i.e. pressing Preview REWROTE the part, and
    // the take you liked was gone before you could keep it. The take pins that
    // index for the audition and the picture; `🎲 New take` is the only thing
    // that moves it. It does NOT pin PLAYBACK — a live part is live, and one
    // that repeated forever would be a recorded one. Absent = 0, so every
    // existing project and every gate config is byte-identical.
    p.take = clamp(p.take | 0, 0, 1e6);
    if (!p.take) delete p.take;
    // VARY — re-roll every cycle instead of playing the take. Absent = off, so
    // an untouched project plays exactly what its drawing shows.
    if (p.vary) p.vary = 1; else delete p.vary;

    // BOTH HALVES ARE ALWAYS COERCED, whichever is active. Write is a DOOR:
    // a captured layer keeps its live spec so it can be released back, and a
    // live layer keeps its notes so a release is not a one-way loss. Coercing
    // only the active branch (the first cut) silently dropped the other on the
    // next normalize, which would have made the door one-way.
    {
      const r = (p.rhythm && typeof p.rhythm === 'object') ? p.rhythm : (p.rhythm = {});
      r.kind = RHYTHMS.has(r.kind) ? r.kind : 'pulse';
      r.n = clamp((r.n | 0) || 1, 1, 64);                  // pulse: onsets per cycle
      // ONE GRID STANDARD, STATED PER BAR. `part.grid` is a note VALUE (1/16)
      // and the cycle is always a whole multiple of it, so the number means
      // the same thing on a 1-bar part and a 5-bar one. In ▦ STEPS the cell
      // count is DERIVED from it (`bars × grid`) and `r.steps` is a mirror
      // the emitter and the cells/lanes arrays keep reading unchanged — the
      // `unit` mirror idiom, so nothing downstream had to learn about it.
      // Without this the sequencer's own readout contradicted itself:
      // "5 of 16 · 2 bars · 1/16", and 2 bars at 1/16 is 32 cells.
      // ⌗ ROLL is deliberately LEFT ALONE: there `r.steps` is the euclid
      // generator's internal resolution rather than an editing grid, and
      // deriving it would re-fit every generated part ever made (a default
      // layer would go 8 steps → 32, i.e. 3-of-8 becoming a much sparser
      // 3-of-32). That migration is a separate, reviewed decision.
      r.steps = clamp((r.steps | 0) || 8, 1, 256);         // euclid grid / cell count
      // WHAT ▦ STEPS WOULD ASK FOR, whichever form is active right now. The
      // two forms are PARALLEL, and `cells`/`lanes`/`pitch.steps` are ONE array
      // each serving two different length authorities — `r.steps` (the roll's
      // euclid resolution knob) and this (the sequencer's grid). Sizing to
      // `r.steps` alone let the roll's knob TRUNCATE a drawn pattern: measured,
      // a 32-cell grid of 8 hits came back as 2 after a trip through ⌗ Roll
      // with Steps turned down. The arrays keep the LONGER of the two, and the
      // tail is inert — every reader (the emitter, both grids) iterates
      // `r.steps` and indexes directly, with no modulo over the array.
      const gcells = clamp(Math.round(Math.max(0.0625, p.bars) * gridPerBar(L)), 1, 256);
      if (p.form === 'steps') r.steps = gcells;
      // …but ONLY where there is something to protect. An untouched euclid roll
      // layer keeps exactly `r.steps` as it always did — otherwise every layer
      // would carry a zero-padded array as long as its bars × grid (80 entries
      // on a 5-bar part) for a pattern nobody drew.
      const anyLane = (r.lanes || []).some((row) => (row || []).some(Boolean));
      const keepN = (r.kind === 'drawn' || p.form === 'steps' || anyLane)
        ? Math.max(r.steps, gcells) : r.steps;
      r.pulses = clamp((r.pulses | 0) || 3, 1, r.steps);
      r.rotate = clamp((r.rotate | 0) || 0, 0, 63);
      // Absent or 0 = the pattern exactly as drawn, and no RNG draw at all.
      if (Number.isFinite(r.vary) && r.vary > 0) r.vary = clamp(r.vary, 0, 100); else delete r.vary;
      if (Number.isFinite(r.syncop) && r.syncop > 0) r.syncop = clamp(r.syncop, 0, 100); else delete r.syncop;
      // Absent or 1 = a single euclid row, which is what v2 has always played.
      if (Number.isFinite(r.voices) && r.voices > 1) r.voices = clamp(r.voices | 0, 1, 8); else delete r.voices;
      // RATE VAR — v1's steady → rushes, absent by default so nothing moves.
      if (Number.isFinite(r.rateVar) && r.rateVar > 0) r.rateVar = clamp(r.rateVar, 0, 100); else delete r.rateVar;
      r.chance = clamp(Number.isFinite(r.chance) ? r.chance : 40, 0, 100);   // chance: % per step
      // DRAWN — the cell grid. It is the euclid generator's output made
      // EDITABLE, exactly as v1's `euclidPattern` overrides its own formula, so
      // "euclid patterning" and "draw it by hand" are one control rather than
      // two. Sized to `keepN` (see above) so neither form's length authority can
      // truncate the other's pattern; the grid still DRAWS `r.steps` of it, so
      // it can never disagree with the number above it. Kept coerced whichever
      // rhythm is active — the both-halves rule that keeps every door two-way.
      if (!Array.isArray(r.cells)) r.cells = [];
      r.cells = r.cells.slice(0, keepN).map(c => (c ? 1 : 0));
      while (r.cells.length < keepN) r.cells.push(0);
      // KIT LANES — one drawn row per drum, same coercion as `cells` (sized to
      // `keepN`, drawn at `r.steps`, so a Steps edit can never leave a lane
      // disagreeing with the number above it OR truncate the other form's). Kept coerced whichever
      // instrument is active, so switching to a kit and back is not a loss.
      if (!Array.isArray(r.lanes)) r.lanes = [];
      r.lanes.length = _V2_LANES;
      for (let li = 0; li < _V2_LANES; li++) {
        const row = Array.isArray(r.lanes[li]) ? r.lanes[li] : [];
        const out2 = row.slice(0, keepN).map(c => (c ? 1 : 0));
        while (out2.length < r.steps) out2.push(0);
        r.lanes[li] = out2;
      }

      const t = (p.pitch && typeof p.pitch === 'object') ? p.pitch : (p.pitch = {});
      t.kind = PITCHES.has(t.kind) ? t.kind : 'chord';
      t.voices = clamp((t.voices | 0) || 3, 1, 9);         // how many notes per onset
      // MIXED's balance — how often an onset is a chord rather than one note.
      // Absent = an even split, and it is pruned there, so the field only
      // exists once it has been moved.
      if (t.kind === 'mixed' && Number.isFinite(t.mix) && (t.mix | 0) !== 50) {
        t.mix = clamp(t.mix | 0, 0, 100);
      } else { delete t.mix; }
      // LINES is absent-by-default and PRUNED at 1, so an untouched project
      // stores nothing and plays exactly as it did.
      if ((t.lines | 0) > 1) t.lines = clamp(t.lines | 0, 2, 6); else delete t.lines;
      // GROUNDWORK's per-change counts. Absent-by-default and pruned empty, so
      // a part that has never set one stores nothing; a count equal to the
      // layer's own `voices` is dropped too, since it says nothing extra.
      if (p.ground && typeof p.ground === 'object' && p.ground.per && typeof p.ground.per === 'object') {
        const per = {}, base = clamp((t.voices | 0) || 3, 1, 9);
        Object.keys(p.ground.per).forEach((k) => {
          const v = p.ground.per[k] | 0;
          if (!(+k >= 0) || !Number.isFinite(p.ground.per[k])) return;
          if (v === base) return;
          per[String(k | 0)] = clamp(v, 0, 9);
        });
        if (Object.keys(per).length) p.ground = { per: per }; else delete p.ground;
      } else if (p.ground) { delete p.ground; }
      t.degree = clamp((t.degree | 0) || 1, 1, 12);        // which source tone (fixed / stack start)
      t.span = clamp((t.span | 0) || 4, 1, 24);            // walk: how far it may wander, in source tones
      if (t.dir !== 'down' && t.dir !== 'updown') t.dir = 'up';   // series: sweep direction
      // Absent = v1's own defaults (2 octaves, no randomness), stored only when
      // moved off them so an untouched layer carries neither.
      // Absent = the unbounded sweep, so ANY stored value is meaningful — 2 is
      // v1's default but here it is also a real choice (bound the pool to two
      // octaves), which is why it is not pruned.
      if (Number.isFinite(t.octaves) && (t.octaves | 0) > 0) t.octaves = clamp(t.octaves | 0, 1, 4); else delete t.octaves;
      if (Number.isFinite(t.randomness) && t.randomness > 0) t.randomness = clamp(t.randomness, 0, 100); else delete t.randomness;
      // Absent or 0/neutral spends no extra draw and leaves the line unchanged.
      if (Number.isFinite(t.contour) && t.contour) t.contour = clamp(t.contour, -100, 100); else delete t.contour;
      // Absent = 'floor', which is what v2 has always done — so this is stored
      // only when moved off it.
      if (t.home !== 'center' && t.home !== 'ceiling') delete t.home;
      // VOICE CAP — a ceiling INCLUDING salt colour tones, separate from Voices.
      // Absent = Voices is the ceiling, which is v1's own default.
      if (Number.isFinite(t.voiceCap) && t.voiceCap > 0) t.voiceCap = clamp(t.voiceCap | 0, 1, 12);
      else delete t.voiceCap;
      ['stutter', 'roam', 'drift'].forEach((k2) => {
        if (Number.isFinite(t[k2]) && t[k2] > 0) t[k2] = clamp(t[k2], 0, 100); else delete t[k2];
      });
      // HARMONY PARTS — a list, so a line can carry a 3rd AND a 6th. Each entry
      // is an interval in SOURCE TONES (signed: negative harmonises below).
      // Absent is the default and an emptied list is DELETED, so "no harmony"
      // has one representation and an untouched layer stores nothing.
      if (Array.isArray(t.harm)) {
        t.harm = t.harm
          .map((h) => (h && Number.isFinite(+h.deg)) ? { deg: clamp(+h.deg | 0, -14, 14) } : null)
          .filter((h) => h && h.deg);
        if (!t.harm.length) delete t.harm;
      } else if (t.harm != null) delete t.harm;
      // CHORD VOICING — absent = the simple stack, so all four are stored only
      // once a mode is chosen and an untouched layer carries none of them.
      if (['chaos', 'chords', 'chordsplus', 'monk'].indexOf(t.chordMode) < 0) {
        delete t.chordMode; delete t.spread; delete t.variety; delete t.feel; delete t.subdiv;
        delete t.phraseLen; delete t.repeats;
      } else {
        t.spread = clamp((t.spread | 0), 0, 3);
        t.variety = clamp((t.variety | 0), 0, 100);
        t.subdiv = clamp((t.subdiv | 0) || 1, 1, 16);
        t.phraseLen = clamp((t.phraseLen | 0) || 4, 1, 16);
        t.repeats = clamp((t.repeats | 0) || 4, 1, 16);
        if (t.feel !== 'stochastic') delete t.feel;
      }
      // DRAWN PITCH — one source-tone DEGREE per step, which is what turns the
      // pattern grid into a melodic step sequencer. Degrees rather than absolute
      // notes so a drawn line still follows the changes and transposes with the
      // key; length tracks `steps` exactly as `cells` does, so the note row can
      // never disagree with the grid above it.
      // …and sized like `cells`, for the same reason: the note row is the other
      // half of the sequencer's material and must survive a trip through ⌗ Roll.
      if (!Array.isArray(t.steps)) t.steps = [];
      t.steps = t.steps.slice(0, keepN).map(v => clamp((v | 0) || 1, 1, 24));
      while (t.steps.length < keepN) t.steps.push(1);

      const s = (p.shape && typeof p.shape === 'object') ? p.shape : (p.shape = {});
      s.lenRatio = clamp(Number.isFinite(s.lenRatio) ? s.lenRatio : 90, 1, 400);   // % of the onset span
      // 0 = off, i.e. Length governs. Stored only when it is doing something.
      if (Number.isFinite(s.holdSteps) && s.holdSteps > 0) s.holdSteps = clamp(s.holdSteps | 0, 0, 16);
      else delete s.holdSteps;
      // MAX EVENTS — a hard ceiling on note-events per cycle, keeping the
      // EARLIEST (v1's rule). 0 = off.
      if (Number.isFinite(s.maxEvents) && s.maxEvents > 0) s.maxEvents = clamp(s.maxEvents | 0, 0, 64);
      else delete s.maxEvents;
      // SLIP — a stochastic strum, absent-by-default and pruned at 0 so a part
      // that never set one draws nothing and stores nothing.
      if (Number.isFinite(s.slip) && s.slip > 0) s.slip = clamp(s.slip | 0, 0, 100);
      else delete s.slip;
    }
    {
      // RECORDED — literal notes. `t` is a fraction of the cycle [0,1), `midi`
      // absolute, `dur` in beats-of-the-cycle so a tempo change scales it.
      if (!Array.isArray(p.notes)) p.notes = [];
      if (p.notes.length > 512) p.notes.length = 512;   // a cycle is not a song
      p.notes = p.notes.filter(n => n && Number.isFinite(n.t) && Number.isFinite(n.midi)).map(n => {
        const o = {
          t: clamp(n.t, 0, 0.99999),
          midi: clamp(n.midi | 0, 0, 127),
          dur: clamp(Number.isFinite(n.dur) && n.dur > 0 ? n.dur : 0.25, 0.001, 8),
        };
        // PER-NOTE OVERRIDES, every one ABSENT BY DEFAULT — absent means "the
        // layer decides", so a captured, composed or adopted part is byte-for-
        // byte what it was before this existed and only a note you actually
        // edited carries anything. `vel` is a PERCENTAGE OF THE LAYER'S LEVEL,
        // not an absolute: the mixer fader has to keep meaning what it says.
        if (Number.isFinite(n.vel)) o.vel = clamp(n.vel | 0, 0, 200);
        if (Number.isFinite(n.atk)) o.atk = clamp(n.atk | 0, 0, 8000);
        if (Number.isFinite(n.dec)) o.dec = clamp(n.dec | 0, 0, 8000);
        if (Number.isFinite(n.sus)) o.sus = clamp(n.sus | 0, 0, 100);
        if (Number.isFinite(n.rel)) o.rel = clamp(n.rel | 0, 0, 20000);
        if (Number.isFinite(n.glide) && n.glide > 0) o.glide = clamp(n.glide | 0, 1, 4000);
        // `hx` — HAND-PLACED, EXACTLY HERE. Set when a note is dragged or
        // keyboard-placed on a part whose harmony remaps (diatonic/chordlock):
        // the remap quantizes to chord tones, so without the pin a hand-placed
        // pitch would not sound (or sit) where it was dropped. Absent by
        // default like every per-note field.
        if (n.hx) o.hx = 1;
        return o;
      }).sort((a, b) => a.t - b.t);
      // A recorded part is fixed pitch material, but it still has to answer to a
      // key change — the engine transposes rather than re-resolving (the v1
      // frozen-loop rule). `transpose` is that offset, applied at read time.
      p.transpose = clamp((p.transpose | 0) || 0, -48, 48);
      // what was last DONE to these notes (absent on an untouched take)
      if (!TRANSFORMS[p.tf]) delete p.tf;
      // Absent = bars, so a project made before free cycles existed is
      // byte-identical and `part.ms` is stored only once it is chosen.
      if (p.clock !== 'free') { delete p.clock; delete p.ms; }
      // absent = 'stretch', which is what v2 has always done. `preserve` is the
      // third answer and only a CADENCE edit can apply it — it needs the old
      // per-change lengths, which no other length change has.
      if (p.barsMode !== 'fill' && p.barsMode !== 'preserve') delete p.barsMode;
      // LOOP = N PASSES OF A PART. v1 expresses the binding as `write.bars`,
      // which v2 has no concept of and deletes — so the binding was written by
      // `_ambLenSyncApplyAll` and wiped on the same normalize, and v2's cycle
      // came only from `part.bars`. In v2 the CYCLE *is* the loop length, so
      // the binding lands there directly (reconciled in `normalizeAll`, which
      // has the cfg the part length needs). Absent = unbound, as before.
      if (L.lenSync && Number.isFinite(+L.lenSync.passes)) {
        L.lenSync = { part: (L.lenSync.part | 0), passes: clamp(+L.lenSync.passes | 0, 1, 64) };
      } else if (L.lenSync != null) delete L.lenSync;
      else p.ms = clamp(Math.round(Number.isFinite(p.ms) ? p.ms : 2000), 200, 60000);
      // THE UNIT MIRROR. v1 indexes several things by a layer's `unit` — a bar
    // RATIO — and `unitGate` is one of them, so without this a v2 layer's unit
    // schedule was consulted and could never place a note (measured: 16
    // consulted, 0 skipped, with every slot switched off). `part.bars` IS that
    // length, so the mirror is derived here and rewritten on every normalize —
    // the same doctrine as the sections' bars mirror, and it can never go stale
    // because normalize runs on every getCfg. It also makes a v2 layer legible
    // to any other v1 code that reads `unit` — including the import, in reverse.
    {
      // FREE-RUNNING. A v2 layer was always bar-synced, which made a whole
      // class of v1 layer inexpressible (a pad on its own 7.3s interval, the
      // shape most ambient beds have) AND silently made Area fade inert, since
      // v1 hard-cuts a synced layer at an area boundary by design. `clock:'free'`
      // states the cycle in ms and writes v1's own free unit, so every consumer
      // that asks `unit.mode` — capturable, the area fade, Bar Lock, the
      // scheduler lane — reads it exactly as it reads a free v1 layer.
      if (p.clock === 'free') {
        L.unit = { mode: 'free', ref: 'bar', num: 1, den: 1 };
      } else {
        const n48 = Math.max(1, Math.round(p.bars * 48));
        let num = n48, den = 48;
        for (let g = Math.min(num, den); g > 1; g--) { if (num % g === 0 && den % g === 0) { num /= g; den /= g; break; } }
        L.unit = (num <= 64 && den <= 64)
          ? { mode: 'sync', ref: 'bar', num, den }
          : { mode: 'sync', ref: 'bar', num: clamp(Math.round(p.bars) || 1, 1, 64), den: 1 };
      }
    }
    // PROVENANCE, never behaviour. Where the notes came from is worth saying
      // on the card ("from riffA") and must change nothing about how they play —
      // a phrase you adopted and a cycle you captured are the same part.
      if (typeof p.from !== 'string' || !p.from) delete p.from;
      // WHERE THESE NOTES CAME FROM. Only 'take' (a locked roll of the layer's
      // own rules) may be replaced without asking — everything else is work
      // somebody did by hand. Absent = unknown, which takes the SAFE side.
      if (p.made !== 'take' && p.made !== 'compose' && p.made !== 'phrase') delete p.made;
      // WHICH MATERIAL IS IN FORCE, and what each one was left holding. Both
      // absent until a material button is pressed, so an untouched project
      // carries neither (and the gates stay byte-identical by construction).
      if (typeof p.mat !== 'string' || !p.mat) delete p.mat;
      if (p.mem && typeof p.mem === 'object') {
        const keep = {};
        Object.keys(p.mem).forEach((k) => {
          const b = p.mem[k];
          if (!b || typeof b !== 'object') return;
          const box = {};
          ['rhythm', 'pitch', 'shape'].forEach((f) => { if (b[f] && typeof b[f] === 'object') box[f] = b[f]; });
          if (Number.isFinite(b.bars)) box.bars = clamp(b.bars, 0.125, 64);
          if (Object.keys(box).length) keep[k] = box;
        });
        if (Object.keys(keep).length) p.mem = keep; else delete p.mem;
      } else delete p.mem;
      // WHICH BARS HAVE BEEN RETAKEN INDIVIDUALLY — bar index → take number,
      // the per-bar half of the audition/lock pin. Absent until a bar is
      // retaken; keys outside the current cycle are pruned so a shortened
      // part does not carry pins to bars it no longer has.
      const tb2 = regMapNorm(p.takeb, p.bars, (v) => {
        const t2 = v | 0; return t2 >= 0 ? (t2 % 1000000) : undefined; });
      if (tb2) p.takeb = tb2; else delete p.takeb;
      // WHICH BARS GENERATE BY THEIR OWN RULES — bar index → a SPARSE overlay
      // on the part's rhythm/pitch/shape, so a bar can be denser, or walk where
      // the rest arpeggiates, without becoming a second part. Absent means the
      // bar takes the part's rules, and a field absent INSIDE an overlay means
      // the same for that field — the house absent-is-inherit grammar, which is
      // what keeps this sparse and makes "back to the part's rules" a delete.
      // Coerced against a WHITELIST: this is a rule set the emitters read, and
      // a stray key from a future build must not survive a downgrade.
      const rb2 = regMapNorm(p.ruleb, p.bars, (src) => {
        if (!src || typeof src !== 'object') return undefined;
        const ov = {};
        Object.keys(BAR_RULE_F).forEach((grp) => {
          const sg = src[grp]; if (!sg || typeof sg !== 'object') return;
          const o2 = {};
          Object.keys(BAR_RULE_F[grp]).forEach((f) => {
            const spec = BAR_RULE_F[grp][f], v = sg[f];
            if (Array.isArray(spec) && typeof spec[0] === 'string') {
              if (typeof v === 'string' && spec.indexOf(v) >= 0) o2[f] = v;
            } else if (Number.isFinite(v)) o2[f] = clamp(Math.round(v), spec[0], spec[1]);
          });
          if (Object.keys(o2).length) ov[grp] = o2;
        });
        return Object.keys(ov).length ? ov : undefined;
      });
      if (rb2) p.ruleb = rb2; else delete p.ruleb;
      // THE REGISTER THESE NOTES WERE MADE AT. A recorded part is absolute
      // MIDI, so Register — which sets the octave a LIVE part is generated in —
      // did nothing to it at all: a control on screen that moved nothing (the
      // dead-control class). Stored here it becomes the BASELINE, and Register
      // shifts the part by whole octaves from it. Absent = no shift, so every
      // project made before this is byte-identical.
      if (Number.isFinite(p.reg)) p.reg = clamp(p.reg | 0, 1, 8); else delete p.reg;
      // The key a recorded part was written in — only meaningful for one.
      if (p.kind !== 'recorded' || !p.key || !Number.isFinite(p.key.root)) delete p.key;
      else p.key = { root: ((p.key.root | 0) % 12 + 12) % 12, scale: (typeof p.key.scale === 'string') ? p.key.scale : '' };
    }
    {
      // `_ambNormalizeFx` (which v2 calls for the shared FX treatments) also
      // backfills v1's WRITE store — and v2 has no such concept: Live/Recorded
      // IS its write model. Left in place it is a stored-but-ignored field that
      // reads as if the layer should freeze. Measured leaking in on import.
      delete L.write;
    }
    return L;
  }

  function layersOf(cfg) {
    if (!cfg || !Array.isArray(cfg.layers) || !cfg.layers.length) return [];
    const out = [];
    for (let i = 0; i < cfg.layers.length; i++) { const L = normLayer(cfg.layers[i], i); if (L) out.push(L); }
    return out;
  }

  // ── HARMONY ─────────────────────────────────────────────────────────────
  // v2 does NOT resolve harmony itself. It asks the engine for the SOUNDING
  // chord (`_ambProgSoundAt` — the resolver that has key transpose, section and
  // part offsets, alts, reroll and order-perm already applied), or falls back to
  // the area key's scale. Rendering pitch classes to frequencies without going
  // through a sounding-space resolver is the documented salt-plan trap.
  function toneSetAt(E, cfg, at, L) {
    // THE LAYER'S OWN SOURCE, through v1's resolver rather than a second one.
    // `_ambNotesOf` applies v1's precedence in full — the AREA PROGRESSION LOCK
    // first (an active area progression overrides every layer, which is why v2
    // was already at parity whenever one was on), then a per-layer `keyOv`,
    // then the layer's own `notes`. `_ambSrcRootPc` is the chokepoint that
    // applies key transpose and the section/part key offsets, so asking it is
    // what keeps a v2 layer in the same key as everything else. `_ambKeyTime`
    // is already stamped by `withKeyTime` around the caller.
    if (L) {
      const prev = (typeof _ambProgStepOverride !== 'undefined') ? _ambProgStepOverride : undefined;
      try {
        // v1's emitters set this before every pitch pick — a prog source
        // resolves the chord at THIS note's onset, not at tick time.
        try { _ambProgStepOverride = _ambProgStepAt(E, at); } catch (e) {}
        const src = _ambNotesOf(L);
        const root = _ambSrcRootPc(src);
        const ivs = _ambScaleIntervals(src);
        if (Number.isFinite(root) && Array.isArray(ivs) && ivs.length) {
          // IS EVERY TONE A CHORD TONE? A chord / wrap / progression source is
          // a POOL — its tones are already the harmony, so consecutive picks
          // are chord tones. A SCALE is not: consecutive picks are adjacent
          // steps, i.e. a cluster. v1 draws exactly this line (`chordPool` in
          // `_ambPickVoicing`) and it is the difference between "Chord"
          // playing C-E-G and playing C-D-E.
          let pool = false;
          try { const nt = _ambAsNotes(src); pool = !!nt && (nt.type === 'chord' ||
            nt.type === 'wrap' || nt.type === 'prog'); } catch (e) {}
          return { root: ((root % 12) + 12) % 12, ivs: ivs.slice(), pool };
        }
      } catch (e) {}
      finally { try { _ambProgStepOverride = prev; } catch (e) {} }
    }
    try {
      const prog = cfg && cfg.prog;
      if (prog && prog.on && Array.isArray(prog.chords) && prog.chords.length) {
        const step = _ambProgStepAt(E, at);
        const ch = _ambProgSoundAt(E, prog, step);
        if (ch && Number.isFinite(ch.root) && Array.isArray(ch.intervals) && ch.intervals.length) {
          return { root: ((ch.root % 12) + 12) % 12, ivs: ch.intervals.slice(), pool: true };
        }
      }
    } catch (e) {}
    // no progression → the area key
    let root = 0, ivs = [0, 2, 4, 5, 7, 9, 11];
    try { root = ((_ambKeyRootPc(cfg) % 12) + 12) % 12; } catch (e) {}
    try {
      const sc = (typeof SCALES !== 'undefined') ? SCALES[_ambKeyScaleName(cfg)] : null;
      if (Array.isArray(sc) && sc.length) ivs = sc.slice();
    } catch (e) {}
    return { root, ivs };
  }

  // WHICH PITCH CLASSES ARE IN THE SCALE, for the drawn keyboard — so the axis
  // says which keys belong rather than only which one each note sits on.
  // Returns a pitch-class map, or null when the question has no answer.
  //
  // TWO SOURCES, in the order that makes the axis honest. The LAYER's own tone
  // set first, through `toneSetAt` (v1's full precedence: the area progression
  // lock, then a per-layer `keyOv`, then the layer's `notes`) — but only when
  // it is NOT a `pool`. That flag is the line that matters here: a chord, wrap
  // or progression source is a HARMONY that moves through the cycle, and the
  // keyboard is one static axis down the side, so lighting the first chord's
  // tones would be a claim that is wrong for most of the drawing. A pool
  // therefore falls through to the KEY, which is what governs the whole cycle.
  //
  // NULL is a real answer, twice over: with no key and no source of its own
  // nothing is "in scale", and a 12-tone scale lights every key, which says
  // exactly as much as lighting none.
  // WHICH PITCH CLASSES THE SOUNDING CHORD HOLDS, at one moment. `scaleAt`
  // deliberately REFUSES a pool (a chord moves through the cycle and the
  // keyboard is one static axis, so lighting the first chord would be a claim
  // that is wrong for most of the drawing) — but a note being split happens at
  // ONE instant, where the chord is exactly the right answer. Null when there
  // is no chord to name, which is what makes "only usable if the part has
  // changes" a fact the UI can read rather than a rule it has to restate.
  function chordAt(E, cfg, at, L) {
    try {
      const set = withKeyTime(at, () => toneSetAt(E, cfg, at, L));
      if (!set || !set.pool) return null;
      if (!Number.isFinite(set.root) || !Array.isArray(set.ivs) || !set.ivs.length) return null;
      if (set.ivs.length >= 12) return null;          // twelve tones name nothing
      const pcs = {};
      set.ivs.forEach((iv) => { pcs[((((set.root + (iv | 0)) % 12) + 12) % 12)] = 1; });
      return pcs;
    } catch (e) { return null; }
  }

  function scaleAt(E, cfg, at, L) {
    const mk = (root, ivs) => {
      if (!Number.isFinite(root) || !Array.isArray(ivs) || ivs.length < 1 || ivs.length >= 12) return null;
      const pcs = {};
      ivs.forEach((iv) => { pcs[((((root + (iv | 0)) % 12) + 12) % 12)] = 1; });
      return pcs;
    };
    try {
      const set = withKeyTime(at, () => toneSetAt(E, cfg, at, L));
      if (set && !set.pool) { const p = mk(set.root, set.ivs); if (p) return p; }
    } catch (e) {}
    // `_ambKeyRootPc` answers "what key WOULD apply", NOT "is there a key" —
    // the documented trap — so without this a Free area lights up whatever key
    // it happens to have STORED. (The branch above needs no such guard, and a
    // first version that carried one was dead code: `_ambScaleIntervals`
    // already answers CHROMATIC for a keyless area, so `mk` returns null on
    // twelve tones and the question never reaches here. Verified by measuring
    // it, after the poison for that guard passed twice.)
    if (!(cfg && cfg.keyOn)) return null;
    try {
      return withKeyTime(at, () => mk(((_ambKeyRootPc(cfg) % 12) + 12) % 12,
        (typeof SCALES !== 'undefined') ? SCALES[_ambKeyScaleName(cfg)] : null));
    } catch (e) { return null; }
  }

  // ── PART: LIVE ──────────────────────────────────────────────────────────
  // The euclidean generator, borrowed from v1 (`euclideanPattern` in 09) rather
  // than reimplemented — it feeds BOTH the `euclid` rhythm and the seed for the
  // `drawn` one, so the two can never disagree about what a 3-in-8 looks like.
  // WHERE THE PATTERN'S FIRST HIT FALLS AT ROTATE 0. `euclideanPattern`'s
  // accumulator tests AFTER adding (`bucket += k; if (bucket >= n)`), so its
  // first hit lands at `ceil(steps/pulses) - 1`, never on step 0: 5 of 8 begins
  // on step 1, 2 of 8 on step 3, 1 of 8 on step 7. Push 0 therefore ALREADY
  // pushed, and the sparser the rhythm the further — reported exactly as "Push
  // is buggy, at 0 all notes are set forward 3 values" (which is 2 pulses of 8).
  // NORMALISED HERE, NOT IN v1's GENERATOR: that one is shared with every v1
  // euclid layer (bass, euclid beat, euclid arp) and re-phasing it would
  // silently re-rhythm every saved project. v2 asks the same generator for the
  // same pattern, `phase` rotations earlier — so Push 0 starts on the beat and
  // every step of Push moves it by exactly one.
  function euclidPhase(pulses, steps) {
    const st = Math.max(1, steps | 0), pu = clamp(pulses | 0, 0, st);
    if (pu <= 0 || pu >= st) return 0;          // silence or every step: no phase to fix
    try {
      if (typeof euclideanPattern !== 'function') return 0;
      const p = euclideanPattern(pu, st, 0);
      if (!p || !p.length) return 0;
      for (let i = 0; i < p.length; i++) if (p[i]) return i;
    } catch (e) {}
    return 0;
  }
  function euclidCells(pulses, steps, rotate) {
    const st = Math.max(1, steps | 0), pu = clamp(pulses | 0, 0, st);
    try {
      if (typeof euclideanPattern === 'function') {
        const p = euclideanPattern(pu, st, (rotate | 0) + euclidPhase(pu, st));
        if (p && p.length) return Array.from({ length: st }, (_, i) => (p[i] ? 1 : 0));
      }
    } catch (e) {}
    // fallback: even spread, so a missing v1 never yields an empty grid
    const out = new Array(st).fill(0);
    for (let i = 0; i < pu; i++) out[Math.floor(i * st / Math.max(1, pu))] = 1;
    return out;
  }
  // Overwrite the drawn grid from the euclid knobs. This is the seam the user
  // named: euclid patterning is how you START a drawn part, and tapping cells
  // is how you finish it. Matches v1's contract exactly — there, a Pulses or
  // Rotate change CLEARS a hand-drawn override — so the two behave alike.
  function seedCellsFn(L) {
    const r = L && L.part && L.part.rhythm; if (!r) return false;
    r.cells = euclidCells(r.pulses, r.steps, r.rotate);
    return true;
  }

  // Stage 1 — RHYTHM: where the onsets fall inside one cycle, as fractions.
  function onsetsOf(part, seed) {
    const r = part.rhythm;
    const out = [];
    if (r.kind === 'chance') {
      // ISOLATED draw — keyed on (layer, cycle, step), never `_ambRand`'s shared
      // stream, so a v2 layer cannot shift any v1 layer's draws.
      const st = Math.max(1, r.steps | 0);
      const rnd = (typeof _ambSeededRand === 'function')
        ? _ambSeededRand((((seed | 0) + 1) * 2654435761) >>> 0) : Math.random;
      // SYNCOPATE — v1's rule: weight the ODD slots so the fill lands off the
      // beat. The draw fires per slot at EVERY setting, so the stream never
      // shifts and 0 is byte-identical.
      const syn = clamp(r.syncop | 0, 0, 100) / 100;
      for (let i = 0; i < st; i++) {
        const w = syn ? (1 + syn * ((i & 1) ? 0.8 : -0.8)) : 1;
        if (rnd() * 100 < r.chance * w) out.push(i / st);
      }
      return out;
    }
    // RHYTHM VARY — v1's rule, verbatim from all four of its euclid renderers:
    // a seed hit is DROPPED with 0.40× the setting and a silent slot is ADDED
    // with 0.22×, per cycle. Asymmetric on purpose — it thins more than it
    // thickens, which is what keeps a varied pattern recognisable instead of
    // filling in. Absent or 0 spends no draw, so a pattern with no vary is
    // byte-identical to the grid as drawn.
    const rv = clamp(r.vary | 0, 0, 100);
    // Mixed with a different constant from the one that built `seed`, as v1's
    // own per-cycle seed is. (The reasoning that first prompted that change was
    // WRONG and is worth recording: a 2,5,2,5 alternation in four cycles' onset
    // COUNTS read as folded low bits, and measuring the POSITIONS over eight
    // cycles showed the original constant giving eight distinct patterns. Four
    // samples of a count is not evidence about a seed.)
    const vrnd = (rv > 0 && typeof _ambSeededRand === 'function')
      ? _ambSeededRand(((((seed | 0) ^ 0x9e3779b9) * 2654435761) >>> 0)) : null;
    const perturb = (hit) => {
      if (!vrnd) return hit;
      if (hit) return !(vrnd() * 100 < rv * 0.40);
      return (vrnd() * 100 < rv * 0.22);
    };
    if (r.kind === 'drawn') {
      const st = Math.max(1, r.steps | 0), cells = r.cells || [];
      for (let i = 0; i < st; i++) if (perturb(!!cells[i])) out.push(i / st);
      return out;                                        // an empty grid is a rest, and says so on the card
    }
    if (r.kind === 'euclid') {
      const pat = euclidCells(r.pulses, r.steps, r.rotate);
      if (pat) { for (let i = 0; i < r.steps; i++) if (perturb(!!pat[i])) out.push(i / r.steps); return out; }
    }
    const n = Math.max(1, r.n | 0);                       // pulse (and the euclid fallback)
    for (let i = 0; i < n; i++) out.push(i / n);
    return out;
  }

  // WHERE THE GROUND FALLS. One onset at the top of the cycle and one at every
  // CHANGE inside it — the shape that plays the harmony rather than a figure
  // over it. Returned as cycle FRACTIONS, like every other rhythm, so nothing
  // downstream needs to know where they came from. `_ambChordSpanAt` walks the
  // real clock (cadence, parts, salt lengths and all), so a half-bar chord gets
  // its own onset exactly where it sounds; with no progression the bar line is
  // the only boundary, which is the same rule with one chord.
  function groundOnsets(ctx, cs, cyc, p) {
    const out = [0];
    try {
      const E = ctx.E, cfg = ctx.cfg;
      const on = cfg && cfg.prog && cfg.prog.on && (cfg.prog.chords || []).length;
      if (on && typeof _ambChordSpanAt === 'function') {
        let t = cs, guard = 0;
        while (guard++ < 64) {
          const sp = _ambChordSpanAt(E, cfg, t);
          if (!sp || !(sp.end > t)) break;
          if (sp.end >= cs + cyc - 1e-6) break;
          out.push((sp.end - cs) / cyc);
          t = sp.end + 1e-4;
        }
      } else {
        // no changes: the BAR is the boundary
        const bars = Math.max(1, Math.round(+p.bars || 1));
        for (let b = 1; b < bars; b++) out.push(b / bars);
      }
    } catch (e) {}
    return out.filter((x, i, a) => x >= 0 && x < 1 && a.indexOf(x) === i).sort((a2, b2) => a2 - b2);
  }
  // HOW MANY TONES THIS CHANGE PLAYS. Keyed on the ABSOLUTE chord index, which
  // is what `_ambProgStepAt` answers and what the chord matrix already keys on.
  function groundVoicesAt(ctx, at, p) {
    const g = p.ground;
    if (!g || !g.per || typeof g.per !== 'object') return 0;
    try {
      const step = _ambProgStepAt(ctx.E, at);
      const chords = ((ctx.cfg || {}).prog || {}).chords || [];
      if (!chords.length) return 0;
      const idx = ((step % chords.length) + chords.length) % chords.length;
      const v = g.per[String(idx)];
      return Number.isFinite(v) ? clamp(v | 0, 0, 9) : 0;
    } catch (e) { return 0; }
  }
  // Pull `k` toward the previous degree by `prox`%. Rounded, so at high values a
  // wandering line becomes a stepwise one rather than freezing on a note.
  function _nearer(k, mem, prox) {
    if (!mem || !prox || !Number.isFinite(mem.prev)) return k;
    return Math.round(mem.prev + (k - mem.prev) * (1 - prox / 100));
  }

  // HARMONY PARTS — the line, plus one or more voices a stated interval above
  // (or below) it. `part.pitch.harm` is a list, so a run can carry a 3rd AND a
  // 6th; absent (the default) means nothing runs and every existing layer is
  // byte-identical. NOT called `harmony`: `L.harmony` already means how a
  // RECORDED part follows the changes (fixed/diatonic/chordlock), and one word
  // for two mechanisms is how a control gets misread (the naming rule).
  //
  // Intervals are in SOURCE TONES, not semitones, so a 3rd above stays a 3rd
  // IN THE KEY — the harmony bends with the scale the way a second player
  // would, instead of running parallel chromatically. The note's own degree is
  // recovered from the tone set, so this works for every pitch kind rather
  // than needing a branch inside each.
  function applyHarm(part, E, cfg, at, reg, out, L) {
    const hs = part.pitch && part.pitch.harm;
    if (!Array.isArray(hs) || !hs.length || !out.length) return out;
    const set = toneSetAt(E, cfg, at, L);
    const N = Math.max(1, set.ivs.length);
    const base = 12 * (reg + 1) + set.root;
    const add = [];
    for (let i = 0; i < out.length; i++) {
      const rel = out[i] - base;
      const oct = Math.floor(rel / 12);
      const pc = ((rel % 12) + 12) % 12;
      const d = set.ivs.indexOf(pc);
      for (let j = 0; j < hs.length; j++) {
        const h = hs[j]; if (!h) continue;
        const st = h.deg | 0;
        if (!st) continue;
        if (d < 0) { add.push(out[i] + st); continue; }   // off-set note: semitones
        const dd = d + st;
        const w = Math.floor(dd / N);
        add.push(base + 12 * (oct + w) + set.ivs[((dd % N) + N) % N]);
      }
    }
    for (let i = 0; i < add.length; i++) if (add[i] > 0) out.push(add[i]);
    return out;
  }
  // Stage 2 — PITCH: what one onset plays, as MIDI numbers. The harmony pass
  // rides on top of whatever the kind produced (declarations hoist, so the
  // wrapper may sit above the body it calls).
  function pitchesAt(part, E, cfg, at, reg, ctxSeed, idx, mem, L) {
    const out = pitchesBase(part, E, cfg, at, reg, ctxSeed, idx, mem, L);
    // PITCH VARY — v1's octave drift: with that chance the whole onset lifts or
    // drops an octave. LINE kinds only (a chord drifting apart is a voicing
    // change, not a drift); seeded on the onset so a take replays; 0 = no draw.
    const t2 = part.pitch || {}, drift = clamp(t2.drift | 0, 0, 100);
    if (drift > 0 && out.length &&
        (t2.kind === 'fixed' || t2.kind === 'series' || t2.kind === 'walk' || t2.kind === 'chance') &&
        vRnd(ctxSeed ^ 0x9e3779b1, 71) * 100 < drift * 0.6) {
      const up = vRnd(ctxSeed ^ 0xc2b2ae35, 73) < 0.55 ? 12 : -12;
      for (let i5 = 0; i5 < out.length; i5++) out[i5] = clamp(out[i5] + up, 12, 120);
    }
    try { return applyHarm(part, E, cfg, at, reg, out, L); } catch (e) { return out; }
  }
  function pitchesBase(part, E, cfg, at, reg, ctxSeed, idx, mem, L) {
    const t = part.pitch, set = toneSetAt(E, cfg, at, L);
    const N = Math.max(1, set.ivs.length);
    const base = 12 * (reg + 1) + set.root;               // register → MIDI octave
    const out = [];
    // PROXIMITY pulls a fresh pick toward the previous one: at 0 the pick stands
    // (v1's default and the old behaviour exactly), at 100 it barely moves. The
    // memory is PER CYCLE, so the line is deterministic and replays for a take.
    const prox = clamp((part._prox | 0), 0, 100);
    // THE RESOLVED DEGREE, stashed for the articulation helpers. v1's
    // `_ambSlideMs` and `_ambOrnamentFlicks` both work in DEGREES (a slide fires
    // on a leap of 3 or more source tones, an ornament flicks to the neighbour
    // degree), and this contract returns MIDI — so the degree has to come out
    // some other way. Set on the PART, which `_prox` already uses, and read
    // immediately by the caller.
    part._deg = null; part._oct = 0;
    if (t.kind === 'fixed') {
      let d = clamp((t.degree | 0) - 1, 0, N - 1);
      // ROAM — v1's `vary` ("how often the Note wanders", Stack / Fixed): with
      // that chance the degree steps to a neighbouring source tone, wrapping
      // the set. Seeded on the onset so a take replays; 0 draws nothing.
      const roam = clamp(t.roam | 0, 0, 100);
      if (roam > 0 && vRnd(ctxSeed ^ 0x1b873593, 61) * 100 < roam) {
        const mag = vRnd(ctxSeed ^ 0x85ebca6b, 67) < 0.7 ? 1 : 2;
        d = (((d + mag * (vRnd(ctxSeed ^ 0xcc9e2d51, 69) < 0.5 ? -1 : 1)) % N) + N) % N;
      }
      part._deg = d;
      out.push(base + set.ivs[d]);
      return out;
    }
    if (t.kind === 'stack') {
      // `voices` consecutive source tones from the Degree, octave on each wrap
      let from = clamp((t.degree | 0) - 1, 0, N - 1);
      // ROAM moves the whole stack's BASE degree — the voices stay a stack
      // (wandering them separately would be a voicing change, not a roam).
      const roam2 = clamp(t.roam | 0, 0, 100);
      if (roam2 > 0 && vRnd(ctxSeed ^ 0x1b873593, 61) * 100 < roam2) {
        from = (((from + (vRnd(ctxSeed ^ 0xcc9e2d51, 69) < 0.5 ? -1 : 1)) % N) + N) % N;
      }
      const want = clamp(t.voices | 0, 1, 9);
      for (let i = 0; i < want; i++) {
        const k = from + i, idx = k % N, oct = Math.floor(k / N);
        out.push(base + set.ivs[idx] + 12 * oct);
      }
      return out;
    }
    // MIXED — some onsets are a chord, the rest a single note. It does not
    // re-implement either: a seeded draw picks which of the two this onset is
    // and the existing branch does the work, so every knob that shapes a chord
    // or a walk keeps shaping it here. The draw is ISOLATED (its own
    // `_ambSeededRand` on the onset), so it shifts no other layer's stream and
    // replays identically for a take.
    if (t.kind === 'mixed') {
      const chance = clamp(Number.isFinite(t.mix) ? t.mix : 50, 0, 100);
      const rndM = (typeof _ambSeededRand === 'function')
        ? _ambSeededRand((((ctxSeed | 0) + 1) * 2654435761) >>> 0) : Math.random;
      const asChord = rndM() * 100 < chance;
      const shim = Object.assign({}, part, {
        pitch: Object.assign({}, t, { kind: asChord ? 'chord' : 'walk' }),
      });
      const got = pitchesBase(shim, E, cfg, at, reg, ctxSeed, idx, mem, L);
      // the articulation helpers read these off the PART, and the shim is a
      // copy — carry back what the delegate resolved
      part._deg = shim._deg; part._oct = shim._oct;
      return got;
    }
    if (t.kind === 'anchor') {
      // THE PEDAL POINT. One note held against the whole progression, scored by
      // v1's own `_ambAnchorPc` — the chord-tone / key-colour tally with the
      // tonic bias, which is what makes it the textbook I-pedal rather than
      // whichever note happens to fit the most chords. This is what keeps a
      // pedal point expressible now that Pedal is not a layer TYPE.
      let apc = null;
      try { if (typeof _ambAnchorPc === 'function') apc = _ambAnchorPc(E, cfg, at); } catch (e) {}
      if (!Number.isFinite(apc)) apc = set.root;          // no progression → the key root
      out.push(12 * (reg + 1) + (((apc % 12) + 12) % 12));
      return out;
    }
    if (t.kind === 'series') {
      // THE ARP SWEEP: consecutive source tones, one per onset, in a direction.
      // Deterministic in the ONSET INDEX rather than a seed — that is what makes
      // it a sweep rather than a scatter, and why `idx` had to be threaded in.
      const from0 = clamp((t.degree | 0) - 1, 0, N - 1);
      const i0 = Math.max(0, idx | 0);
      // THE POOL IS N TONES × OCTAVES, exactly as v1 sizes an arp's
      // (`len = N * octs`) — so the sweep climbs through the octaves and WRAPS
      // rather than walking away for ever, which is the difference between an
      // arpeggio and a scale run. Absent = 2, v1's own default.
      // OPT-IN. Wrapping the pool unconditionally broke `down`: descending from
      // the bottom degree wraps to the TOP by definition, so the sweep read
      // 60 · 79 · 76 · 72 instead of walking down below the base. Absent =
      // today's unbounded sweep, byte-identical; present = a bounded pool, which
      // is what an arpeggio is. (Caught by the gate, which pins the direction.)
      const bounded = Number.isFinite(t.octaves) && (t.octaves | 0) > 0;
      const octs = clamp((t.octaves | 0) || 2, 1, 4);
      const len = Math.max(1, N * octs);
      let k;
      if (t.dir === 'down') k = from0 - i0;
      else if (t.dir === 'updown') {
        const period = Math.max(1, 2 * ((bounded ? len : N) - 1));
        const ph = i0 % period;
        k = from0 + (ph < (bounded ? len : N) ? ph : period - ph);
      } else k = from0 + i0;
      if (bounded) k = ((k % len) + len) % len;
      // RANDOMNESS — v1's rule: with that probability a note jumps to a random
      // pool degree instead of following the direction. Seeded on the onset, so
      // a scattered sweep still replays for a take. Absent = 0 = no draw.
      const rnd0 = clamp(t.randomness | 0, 0, 100);
      if (rnd0 > 0 && vRnd(ctxSeed ^ (i0 * 2654435761), 53) * 100 < rnd0) {
        k = Math.floor(vRnd(ctxSeed ^ (i0 * 40503), 59) * len) % len;
      }
      const oct = Math.floor(k / N), i2 = ((k % N) + N) % N;
      part._deg = k; part._oct = oct;
      out.push(base + set.ivs[i2] + 12 * oct);
      return out;
    }
    if (t.kind === 'drawn') {
      // The degree DRAWN for this step, resolved against the sounding chord — so
      // the same drawn line reads as C-E-G over C and F-A-C over F.
      const st2 = t.steps || [];
      const k = clamp(((st2[Math.max(0, idx | 0)] | 0) || 1) - 1, 0, 23);
      const oct = Math.floor(k / N), i3 = ((k % N) + N) % N;
      out.push(base + set.ivs[i3] + 12 * oct);
      return out;
    }
    if (t.kind === 'chance') {
      // One tone drawn from the source per onset — an ISOLATED seeded stream, so
      // it never shifts a v1 layer's draws and replays identically per take.
      const rnd2 = (typeof _ambSeededRand === 'function')
        ? _ambSeededRand((((ctxSeed | 0) + 1) * 2246822519) >>> 0) : Math.random;
      let k2 = clamp(Math.floor(rnd2() * N), 0, N - 1);
      k2 = _nearer(k2, mem, prox);
      if (mem) mem.prev = k2;
      out.push(base + set.ivs[k2]);
      return out;
    }
    if (t.kind === 'walk') {
      // A LINE: one note, wandering by a seeded step within `span` source tones
      // of the Degree. Deterministic per (layer, onset) so a take replays.
      // HOME — where Register sits in the walk WINDOW. v1's own rule, in its
      // own shape: floor (v2's behaviour until now) walks UP from the register,
      // centre shifts the window down by half the span, ceiling by all of it.
      // Only the walk has a window, so it is the only kind this applies to.
      const home = (t.home === 'center' || t.home === 'ceiling') ? t.home : 'floor';
      const homeShift = (home === 'ceiling') ? -(t.span | 0)
                      : (home === 'center') ? -Math.floor((t.span | 0) / 2) : 0;
      const from0 = clamp((t.degree | 0) - 1, 0, N - 1) + homeShift;
      // LINES — how many notes a Roll plays AT ONCE. Each is a full walk with
      // its OWN seeded stream and its OWN memory, so they wander independently
      // — which is what makes this different from Harmony, where one line is
      // duplicated at a fixed interval and every voice moves in lockstep.
      // ABSENT = 1 = today's behaviour byte-for-byte, and it has to be a NEW
      // field rather than `pitch.voices`: normalize backfills that one to 3 on
      // every pitch object, so reading it here would silently thicken every
      // rolled part in every saved project.
      const lines = clamp((t.lines | 0) || 1, 1, 6);
      for (let vi = 0; vi < lines; vi++) {
      // voice 0 keeps TODAY'S seed exactly — `x ^ 0` is `x`, so a one-line
      // walk draws the identical stream it always has
      const from = from0 + vi * 2;          // a third apart, so they do not sit on one note
      const mem2 = (vi === 0) ? mem
        : (mem ? ((mem._ln = mem._ln || {}), (mem._ln[vi] = mem._ln[vi] || {})) : null);
      const rnd = (typeof _ambSeededRand === 'function')
        ? _ambSeededRand(((((ctxSeed | 0) + 1) * 40503) ^ (vi * 0x7f4a7c15)) >>> 0) : Math.random;
      // STUTTER — v1's rule: repeat the PREVIOUS degree instead of stepping,
      // which is what turns a walk into chord-tone phrasing. Consumes no
      // further pick, so the walk resumes from the same place.
      const stut = clamp(t.stutter | 0, 0, 100);
      if (stut > 0 && mem2 && Number.isFinite(mem2.prev) && rnd() * 100 < stut * 0.45) {
        const kS = mem2.prev;
        const iS = ((kS % N) + N) % N, oS = Math.floor(kS / N);
        if (vi === 0) { part._deg = kS; part._oct = oS; }
        out.push(base + set.ivs[iS] + 12 * oS);
        continue;                            // the NEXT line, not the next onset
      }
      // CONTOUR — v1's rule for the step's DIRECTION, -100 to +100. NOTE what
      // it does HERE: v2's walk scatters around a fixed centre rather than
      // accumulating from the previous note, so contour biases WHICH SIDE of
      // the centre a pick lands on — it raises or lowers the line's centre of
      // gravity, it does not make it climb. Measured as mean pitch: 59.1 plain,
      // 63.3 at +100, 57.1 at -100. (Counting up-vs-down TRANSITIONS shows
      // almost nothing, which is the wrong quantity for a scatter and briefly
      // read as the control not working.) At 0 the threshold is exactly 0.5.
      const cont = clamp(Number.isFinite(t.contour) ? t.contour : 0, -100, 100);
      const mag = Math.abs(Math.round((rnd() * 2 - 1) * t.span));
      const dir = (rnd() < (0.5 - cont / 100 * 0.35)) ? -1 : 1;
      const step = cont ? (mag * dir) : Math.round((rnd() * 2 - 1) * t.span);
      let k = _nearer(from + step, mem2, prox);
      // GRAVITY IS NOT PORTED, and that is a MODEL difference rather than an
      // omission: v1's motif walks a chromatic-ish space and gravity pulls a
      // stray note onto a chord tone, whereas v2 picks by INDEX into the
      // sounding tone set (`set.ivs[k % N]`) — so every pick is already a chord
      // tone and there is nothing to pull. Written, measured as a literal
      // no-op, and removed: a control that cannot do anything is worse than an
      // absent one.
      if (mem2) mem2.prev = k;
      const i4 = ((k % N) + N) % N, oct = Math.floor(k / N);
      // the articulation helpers (slide, ornament) read ONE degree — the lead
      // line's, exactly as before lines existed
      if (vi === 0) { part._deg = k; part._oct = oct; }
      out.push(base + set.ivs[i4] + 12 * oct);
      }
      return out;
    }
    // 'chord' — `voices` tones of the current harmony, stacking octaves on wrap.
    // WITH A CHORD MODE SET, hand the job to v1's own voicer instead: Chaos /
    // Chords / Chords+ / Monk, plus Spread and Variety, are its whole vocabulary
    // and re-deriving them here would be a second implementation of the most
    // musically-loaded code in the app. It reads a BED-shaped layer, so it gets a
    // shim (the `_ambApplyAdsr` pattern) — the field names differ, the meanings
    // do not. Absent `chordMode` = the simple stack below, byte-identical.
    // `_ambPickVoicing` is the SUPERSET of `_ambVoiceProgChord`: it delegates to
    // that one when the source is a progression, and otherwise runs v1's own
    // STRUCTURED voicer — a repeating phrase of `chordPhraseLen` chords repeated
    // `chordRepeats` times before a fresh one, which is what makes a chord layer
    // sound composed rather than chaotic when there is no progression to follow.
    // It resolves the source itself (`_ambNotesOf(bed)`), so the shim carries
    // `notes`/`keyOv` and the two agree on what this layer is playing.
    if (t.chordMode && typeof _ambPickVoicing === 'function') {
      try {
        const src = (typeof _ambNotesOf === 'function' && L) ? _ambNotesOf(L) : null;
        if (src) {
          const shim = {
            chordMode: t.chordMode,
            degree: clamp((t.degree | 0) || 1, 1, 12),
            density: clamp((t.voices | 0) || 3, 1, 9),
            register: clamp((reg | 0) || 4, 1, 8),
            spread: clamp((t.spread | 0), 0, 3),
            voiceVariety: clamp((t.variety | 0), 0, 100),
            progSubdiv: clamp((t.subdiv | 0) || 1, 1, 16),
            chordPhraseLen: clamp((t.phraseLen | 0) || 4, 1, 16),
            chordRepeats: clamp((t.repeats | 0) || 4, 1, 16),
            notes: L.notes, keyOv: L.keyOv, scale: L.scale,
          };
          // SUBDIVIDE — how many voicings the chord gets. `_ambProgSpanAt`
          // resolves BOTH the sub-slot and a chordStep that is unique per group
          // OCCURRENCE (not per written chord), which is what makes a
          // stochastic feel keep evolving instead of repeating each pass. It is
          // the same function v1's bed uses, reading `progSubdiv` off the shim.
          let step = 0, slot = Math.max(0, idx | 0);
          let psi = null;
          try { psi = _ambProgSpanAt(E, shim, cfg, at); } catch (e) {}
          if (psi) { step = psi.chordStep | 0; slot = psi.slot | 0; }
          else { try { step = _ambProgStepAt(E, at) | 0; } catch (e) {} }
          // `iter` is the CYCLE index — that is what walks the phrase, so a
          // structured voicing repeats for `chordRepeats` cycles and then moves
          // on. `key` only seeds it, per layer.
          const pv = { chordStep: step, slot: slot, feel: t.feel || '' };
          const isProg = (function () { try { return _ambAsNotes(src).type === 'prog'; } catch (e) { return false; } })();
          const fs = _ambPickVoicing(shim, part._cyc | 0, 'v2:' + (L.id | 0), isProg ? pv : null);
          if (Array.isArray(fs) && fs.length) {
            // The voicer returns FREQUENCIES; this contract is MIDI. The
            // conversion is exact and unrounded, so `midiToFreq` inverts it and
            // any microtonal offset the voicer applied survives.
            for (let i = 0; i < fs.length; i++) if (fs[i] > 0) out.push(69 + 12 * Math.log2(fs[i] / 440));
            if (out.length) return out;
          }
        }
      } catch (e) { out.length = 0; }
    }
    // A CHORD IS BUILT IN THIRDS, and which "third" means what depends on the
    // SET. Consecutive tones are right for a chord POOL (a chord, a wrap, a
    // progression — every tone is already a chord tone, so tone 0,1,2 IS the
    // triad) and wrong for a SCALE, where they are adjacent steps: measured
    // through the real control in C major, Pitch -> Chord played C4+D4+E4, a
    // cluster, and was byte-identical to Stack, so the two kinds could not be
    // told apart. Over a scale it steps by TWO degrees (root/3rd/5th/7th) —
    // v1's own `[0,2,4,6]` chord degrees. Over a CHROMATIC set there is no
    // scale to step through (every other semitone is a whole-tone cluster), so
    // it stacks thirds by INTERVAL, alternating 4 and 3 semitones, which is
    // what "chord" can mean when nothing has declared a key.
    const want = clamp(t.voices | 0, 1, 9);
    if (set.pool) {
      for (let i = 0; i < want; i++) {
        const idx = i % N, oct = Math.floor(i / N);
        out.push(base + set.ivs[idx] + 12 * oct);
      }
    } else if (N >= 12) {
      let off = 0;
      for (let i = 0; i < want; i++) {
        out.push(base + off);
        off += (i % 2 === 0) ? 4 : 3;
      }
    } else {
      for (let i = 0; i < want; i++) {
        const k = i * 2, idx = k % N, oct = Math.floor(k / N);
        out.push(base + set.ivs[idx] + 12 * oct);
      }
    }
    return out;
  }

  // THE PINNED TAKE, module state — never a field on the layer, and never
  // threaded through `notesFor`'s ctx: the emitter calls `notesFor` itself, so
  // a ctx field would have to be plumbed through every caller to reach it.
  // Set around the preview's own emit and around the drawing, restored in a
  // `finally`, so it can never leak into playback.
  let TAKE_PIN = null;
  const takeOf = (L) => ((L && L.part && L.part.take) | 0) || 0;
  // THE PIN FOR THIS LAYER — a bare take number, or, when bars have been
  // retaken individually, `{ base, bars: { '<bar>': take } }`. A LIVE part's
  // take is only the audition/lock pin (playback re-rolls every cycle), so a
  // per-bar retake is exactly a per-bar PIN: bar 2 shows take 7 while the
  // rest still shows take 4.
  // A BAR CAN ALSO CARRY ITS OWN RULES (`part.ruleb`), which is a second reason
  // for the composite to exist — that bar is rolled from a DIFFERENT spec, not
  // merely a different throw of the dice. `reroll` is the recorded part's
  // replace: the scalar take has already been bumped, so the per-bar TAKE pins
  // are superseded while the per-bar RULES are not (a rule is a setting, a pin
  // is history).
  function pinOf(L, reroll) {
    const p = (L && L.part) || {};
    const tb = (!reroll && p.takeb && typeof p.takeb === 'object' && Object.keys(p.takeb).length) ? p.takeb : null;
    const rb = (p.ruleb && typeof p.ruleb === 'object' && Object.keys(p.ruleb).length) ? p.ruleb : null;
    if (tb || rb) return { base: takeOf(L), bars: tb || {}, rules: rb || null };
    return takeOf(L);
  }
  function withTake(t, fn) {
    const sv = TAKE_PIN;
    TAKE_PIN = (t && typeof t === 'object') ? t : (t | 0);
    try { return fn(); } finally { TAKE_PIN = sv; }
  }
  const pinSig = (t) => (t && typeof t === 'object') ? JSON.stringify(t) : String(t | 0);

  // ── THE EDIT PIN — audition and draw the record ON THE CARD ─────────────
  // The per-part swap in `notesFor` belongs to PLAYBACK: the arrangement
  // decides which part is sounding, and the emitter asks for that part's
  // record. ▶ Preview, the drawing, 🔒 Lock and the compose seed are asking a
  // DIFFERENT question — "what does the thing I am editing do" — and with
  // per-part engaged the two had different answers, because the stopped clock
  // resolves to whichever part sits at the anchor (part 0, normally) while the
  // card is editing whichever part the strip selected. Measured: seeding a
  // layer whose selected part was 1 changed the stored rules every press
  // (euclid/fixed -> pulse/series -> pulse/chord) and left the preview
  // BYTE-IDENTICAL — 12 notes, the same pitches — which is exactly the
  // reported "the visualization changes but the preview stays the same".
  // A MODULE FLAG rather than a ctx argument, for the same reason TAKE_PIN is
  // one: `emit` calls `notesFor` itself, so the pin has to be in force AROUND
  // it. Restored in a `finally` so it can never leak into the tick.
  let EDIT_PIN = false;
  function withEdit(fn) {
    const sv = EDIT_PIN; EDIT_PIN = true;
    try { return fn(); } finally { EDIT_PIN = sv; }
  }

  // WHICH RECORD IS SOUNDING AT A GIVEN MOMENT — the per-part swap, as ONE
  // function. It was inline in `notesFor`, so anything else that needed to know
  // what a per-part layer is playing had to re-implement it or reach for
  // `L.part` — and `L.part` is the record being EDITED, which is a completely
  // different thing the moment another part is sounding. The chord choke did
  // exactly that: it decides line-vs-harmony from the record's own notes, read
  // the EDITED one, and so let whichever part you had selected decide whether
  // every OTHER part's notes were cut (measured: part 1 holding a single-note
  // LINE was choked 7200 ms → 1988 because part 0, selected for editing, held a
  // chord). That is the "what a part plays depends on which part is selected"
  // wart the ice model exists to remove, in a new place.
  // `pi` is the caller's ALREADY-RESOLVED part where it has one — `cycleWindowAt`
  // hands it out, and re-deriving it from a snapped window start answers the
  // previous part (see the note there).
  function partRecordAt(L, E, cfg, at, pi) {
    if (!L || !L.part) return null;
    if (!(Number.isFinite(L.partFor) && (L.parts || L.partAll))) return L.part;
    let p = Number.isFinite(pi) ? (pi | 0) : -1;
    try {
      if (p < 0 && typeof _ambPartChordAt === 'function' && E && cfg) {
        const w = _ambPartChordAt(E, cfg, at);
        if (w && Number.isFinite(w.pi)) p = w.pi | 0;
      }
    } catch (e) {}
    if (p < 0 || p === (L.partFor | 0)) return L.part;
    const alt = L.parts && L.parts[String(p)];
    if (alt && typeof alt === 'object') return alt;
    // the floor for a part with no record yet is the ICED Everywhere record —
    // never the bench, or what a part plays would depend on which part is
    // selected for editing
    return (L.partAll && typeof L.partAll === 'object') ? L.partAll : L.part;
  }

  // ── THE PART INTERFACE ──────────────────────────────────────────────────
  // notesFor(layer, ctx) → [{ at, freq, durMs }]
  // ONE contract, two implementations. Everything above is an implementation
  // detail of the live one; the emitter below knows only this signature.
  function notesFor(L, ctx) {
    // PER-PART CONTENT. `L.part` is always the record being EDITED; `L.partFor`
    // names which arrangement part it belongs to and `L.parts` files the
    // others (the `mem` swap pattern — one live record, everything on the card
    // keeps operating on `L.part`). At emit, resolve which part is SOUNDING at
    // this cycle's start and swap in its record; a part with no record of its
    // own falls back to the edited one, so per-part is opt-in bar by bar.
    // The CALLER's cycleSec stands — a recorded record's times are cycle
    // fractions and a live rhythm spans the cycle, so a record made for a
    // different length plays FITTED (stretch semantics) rather than clocked.
    // engages on the map OR the ice alone — an empty map (every record pruned)
    // must still fall to the Everywhere floor, never to the bench
    if (!EDIT_PIN && Number.isFinite(L.partFor) && (L.parts || L.partAll) && !ctx._ppDone) {
      // THE CALLER'S OWN ANSWER WINS. `cycleWindowAt` resolved which part this
      // window is at a moment INSIDE it and hands it over as `ctx.pi`; asking
      // again from `ctx.cycleStart` re-runs the resolver on a SNAPPED float
      // that can sit one ULP below its own boundary, which answers the
      // PREVIOUS part (see the note in `cycleWindowAt`). The fallback stays for
      // the callers that pass only a time.
      const eff = partRecordAt(L, ctx.E, ctx.cfg, ctx.cycleStart, ctx.pi);
      if (eff && eff !== L.part) {
        return notesFor(Object.assign({}, L, { part: eff }),
                        Object.assign({}, ctx, { _ppDone: 1 }));
      }
    }
    const p = L.part, out = [];
    const cyc = ctx.cycleSec, cs = ctx.cycleStart;
    // ⌗ ROLL AND ▦ STEPS ARE PARALLEL — each keeps its own material and
    // switching between them preserves both. `part.notes` and
    // `rhythm.cells`/`lanes` already coexist in the store (the both-halves rule
    // that keeps 🔒 Lock / 🔓 Unlock two-way), so the only thing coupling them
    // was `part.kind`: 'recorded' sends the emit down the NOTE-LIST branch, and
    // in ▦ Steps the material is the grid whatever the roll's kind happens to
    // be. The FORM decides which branch emits, so `kind` keeps meaning exactly
    // what it means for the roll and is simply not consulted here — no field to
    // save and restore, and no state to get out of step.
    if (p.kind === 'recorded' && formOf(L) !== 'steps') {
      // REGISTER MOVES A RECORDED PART BY WHOLE OCTAVES, from the register it
      // was made in — the same thing it means on a live part ("which octave
      // this plays in"), expressed the only way absolute notes can express it.
      // It composes with Transpose, which stays the semitone control.
      const regNow = clamp((L.instrument.register | 0) || 4, 1, 8);
      const tr = (p.transpose | 0) + (Number.isFinite(p.reg) ? (regNow - p.reg) * 12 : 0);
      // HARMONY — what a recorded part does when the chords move under it.
      // 'fixed' (the default, and v2's only behaviour until now) plays it as
      // written; the others remap each note through v1's own
      // `_ambLockHarmonizeFreq`, which is the same function v1 uses on a frozen
      // loop — so a composed phrase follows the changes identically either
      // side. Resolved per NOTE, at the note's own time, because the chord can
      // move inside one cycle.
      const hz = (L.harmony === 'diatonic' || L.harmony === 'chordlock');
      let kc = null;
      if (hz) {
        // The key the part was WRITTEN in — `_ambLockHarmonizeFreq` transposes
        // from it to the current one. A part recorded before this was stamped
        // has none, and falls back to the current key, which is a zero shift —
        // i.e. exactly the behaviour it had before, never a surprise re-key.
        if (p.key && Number.isFinite(p.key.root)) kc = { root: p.key.root | 0, scale: p.key.scale || '' };
        else { try { kc = { root: _ambKeyRootPc(ctx.cfg), scale: _ambKeyScaleName(ctx.cfg) }; } catch (e) { kc = null; } }
      }
      // A CHORD MUST NOT COLLAPSE INTO ITSELF. The chordlock remap indexes a
      // note's written-key degree into the sounding chord's tones (`deg % N`),
      // and a stacked voicing's degrees collide mod N — measured on a locked
      // 5-voice Mixed take: EVERY chord position remapped at least two voices
      // onto one pitch (60,64,67,71,72 over F7 → 65,60,65,72,77), heard as
      // "there's clearly a chord but it only plays one note". Each onset keeps
      // a set of the pitches already taken; a REMAPPED note that lands on one
      // is raised by octaves until free — same pitch classes, open voicing,
      // five voices stay five. Stored unisons and pinned notes are never moved.
      let _ot = null, _used = null;
      for (let i = 0; i < p.notes.length; i++) {
        const n = p.notes[i];
        if (_ot === null || Math.abs(n.t - _ot) > 1e-6) { _ot = n.t; _used = new Set(); }
        const at = cs + n.t * cyc;
        // a HAND-PLACED note (`hx`) sounds exactly its stored pitch — no
        // transpose, no harmony remap: it was put THERE, and "there" must
        // survive every rule that would move it (the remap turned a semitone
        // drag into stick-then-jump between chord tones — "still skipping")
        let f = midiToFreq(n.midi + (n.hx ? 0 : tr));
        // CHORDLOCK IS RESOLVED IN v2's OWN TERMS. It used to go through v1's
        // `_ambLockHarmonizeFreq`, which is built for a seq unit's captured
        // phrase and measurably mis-mapped here: over a 5-chord progression a
        // locked take scored 8 of 16 notes in the sounding chord and put a B
        // over an F major (pinning `_ambProgStepOverride` first, the usual
        // suspect, changed nothing). v2 already knows the SOUNDING chord —
        // `toneSetAt` is the same call the live path uses — so the note's
        // DEGREE in the key it was written in is re-indexed into that chord's
        // tones. Same trick `applyHarm` uses (`set.ivs.indexOf(pc)`), and it
        // is in-chord by construction rather than by a snap.
        if (!n.hx && hz && kc && L.harmony === 'chordlock') {
          try {
            // `ctx.E`, not `E` — `notesFor` takes (L, ctx) and has no engine of
            // its own; a bare `E` threw straight into the catch below and the
            // whole branch measured as a silent no-op identical to 'fixed'.
            const set2 = toneSetAt(ctx.E, ctx.cfg, at, L);
            const N2 = Math.max(1, set2.ivs.length);
            const wIv = ((typeof SCALES !== 'undefined' && SCALES && SCALES[kc.scale]) || null);
            const m0 = n.midi + tr;
            const pc0 = (((m0 - (kc.root | 0)) % 12) + 12) % 12;
            // which degree of the WRITTEN key this note was; a note outside
            // that scale takes the nearest degree rather than being dropped
            let deg = -1;
            if (wIv && wIv.length) {
              deg = wIv.indexOf(pc0);
              if (deg < 0) {
                let best = 0, bd = 99;
                for (let q = 0; q < wIv.length; q++) {
                  const d2 = Math.min(((pc0 - wIv[q]) + 12) % 12, ((wIv[q] - pc0) + 12) % 12);
                  if (d2 < bd) { bd = d2; best = q; }
                }
                deg = best;
              }
            }
            if (deg >= 0) {
              // keep it in the octave it was written in: rebuild from the
              // stored note's octave, then let the degree wrap upward
              const oct0 = Math.floor(m0 / 12);
              const idx2 = ((deg % N2) + N2) % N2, up = Math.floor(deg / N2);
              let m2 = oct0 * 12 + set2.root + set2.ivs[idx2] + 12 * up;
              while (m2 - m0 > 6) m2 -= 12;
              while (m0 - m2 > 6) m2 += 12;
              // collision with another voice of THIS onset → up an octave
              let gu = 0;
              while (_used && _used.has(m2) && m2 <= 115 && gu++ < 8) m2 += 12;
              if (m2 > 0) f = midiToFreq(m2);
            }
          } catch (e) {}
        } else if (!n.hx && hz && kc) {
          // 'diatonic' still follows the KEY, which is v1's own job and which
          // it does correctly — a section or part key change re-voices the take.
          try { f = withKeyTime(at, () => _ambLockHarmonizeFreq(L, kc, f, at)) || f; } catch (e) {}
        }
        // every voice of the onset claims its pitch — pinned and plain notes
        // included, so a remapped one can never land on top of them
        try { if (_used && f > 0) _used.add(Math.round(69 + 12 * Math.log2(f / 440))); } catch (e) {}
        const o = { at, freq: f, durMs: Math.round(n.dur * cyc * 1000), nidx: i };
        // The per-note overrides ride ALONG the interface rather than being
        // read from the store by the emitter — the emitter knows `notesFor`'s
        // signature and nothing else, which is what keeps a recorded part and
        // a live one interchangeable to it.
        if (Number.isFinite(n.vel)) o.vel = n.vel;
        if (Number.isFinite(n.atk)) o.atk = n.atk;
        if (Number.isFinite(n.dec)) o.dec = n.dec;
        if (Number.isFinite(n.sus)) o.sus = n.sus;
        if (Number.isFinite(n.rel)) o.rel = n.rel;
        if (Number.isFinite(n.glide)) o.glide = n.glide;
        out.push(o);
      }
      return out;
    }
    // A PINNED take answers "which roll", so the audition and the drawing agree
    // with each other by construction rather than by remembering an anchor.
    // A BAR-MAPPED PIN is composited from whole rolls: roll the base take,
    // roll each retaken take, and take each bar's notes from the take that
    // owns it. Recursion with a SCALAR pin keeps every part kind (pitched,
    // kit, speech) covered by one mechanism instead of a branch in each.
    // PER-BAR RULES ARE NOT AN AUDITION PIN — they are what the bar is MADE OF,
    // so playback has to honour them. A per-bar TAKE is the opposite (a live
    // part re-rolls every cycle, so pinning one bar's throw is meaningful only
    // while you are looking at it), which is why the pin path and this one
    // share the composite and differ in what they hand it: the pin names a
    // take per bar, playback names the CYCLE's take for every bar and lets the
    // rules do the work.
    const composite = (pin) => {
      const rb = pin.rules || {};
      // A ROLL IS (a take) × (a rule overlay). The overlay rides as a SHIM part
      // on a shim layer — the same idiom the per-part swap above uses — so the
      // whole emitter reads the merged rules with no branch of its own; and it
      // carries `_ppDone`, because by here `p` IS the resolved record and
      // letting the per-part block re-resolve would swap the shim straight back
      // out and silently lose the overlay.
      const roll = (t, ov) => { const sv = TAKE_PIN; TAKE_PIN = (t | 0);
        try {
          return ov ? notesFor(Object.assign({}, L, { part: partWithRules(p, ov) }),
                               Object.assign({}, ctx, { _ppDone: 1 }))
                    : notesFor(L, ctx);
        } finally { TAKE_PIN = sv; }
      };
      const barsF = Math.max(0.125, p.bars || 1);
      // WHERE A NOTE SITS ON THE 1/48-BAR GRID — the one test, so a region is a
      // change, a bar, or anything else that lands on that grid.
      const slotOf = (n) => slotAt((n.at - cs) / Math.max(0.001, cyc), barsF);
      const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
      const allK = {};
      Object.keys(pin.bars).forEach((k) => { allK[k] = 1; });
      Object.keys(rb).forEach((k) => { allK[k] = 1; });
      const keys = Object.keys(allK);
      const out2 = roll(pin.base).filter((n) => !regHas(keys, slotOf(n)));
      // ONE ROLL PER DISTINCT (take, rules) PAIR — regions that agree on both
      // share it, so two bars retaken together still cost one roll between them.
      const groups = {};
      keys.forEach((k) => {
        const t = has(pin.bars, k) ? (pin.bars[k] | 0) : (pin.base | 0);
        const ov = rb[k] || null;
        const sig = t + '|' + (ov ? JSON.stringify(ov) : '');
        const g2 = groups[sig] || (groups[sig] = { t, ov, keys: [] });
        g2.keys.push(k);
      });
      Object.keys(groups).forEach((sig) => {
        const g2 = groups[sig];
        roll(g2.t, g2.ov).forEach((n) => { if (regHas(g2.keys, slotOf(n))) out2.push(n); });
      });
      out2.sort((a2, b2) => a2.at - b2.at);
      return out2;
    };
    if (TAKE_PIN && typeof TAKE_PIN === 'object') return composite(TAKE_PIN);
    // THE TAKE YOU ROLLED IS WHAT PLAYS. This was the CYCLE INDEX, so the
    // drawing (pinned to the take) and playback (index 0, 1, 2 …) were two
    // different rolls — press play after rolling take 1 and you heard cycle 0,
    // which IS take 0: reported as "I created a new take, the visualizer
    // updated, but when it starts playing both playback and viz revert to the
    // prior take". A drawing that playback ignores is decoration.
    // Per-cycle dice are still available — as a CHOICE (`part.vary`), absent by
    // default — because "a live part that repeated forever is a recorded one"
    // was the argument for the old default and it is answered by the fact that
    // a live part still re-resolves its pitches against the changes every cycle.
    const cycIdx = Number.isFinite(TAKE_PIN) ? (TAKE_PIN | 0)
      : ((L.part && L.part.vary)
          ? (Math.round(ctx.cycleStart / Math.max(0.001, cyc)) + (takeOf(L) | 0))
          : (takeOf(L) | 0));
    // …and if any bar generates by its own rules, this cycle is a composite of
    // one roll per distinct rule set. Guarded on `TAKE_PIN == null` so the
    // composite's own recursion (which sets a SCALAR pin) cannot re-enter here
    // — and `partWithRules` strips `ruleb` from the shim for the same reason.
    if (TAKE_PIN == null && p.ruleb && typeof p.ruleb === 'object' && Object.keys(p.ruleb).length) {
      return composite({ base: cycIdx, bars: {}, rules: p.ruleb });
    }
    const seedBase = ((L.id | 0) * 9176) ^ (cycIdx * 2246822519);
    // A KIT IS EIGHT PARALLEL RHYTHMS WITH A FIXED PITCH EACH. That is the whole
    // difference, and it falls out of the model rather than being bolted on: the
    // RHYTHM stage gains a lane dimension, and the PITCH stage is answered by the
    // lane itself (a drum's note is its lane's semitone), so the pitch pieces
    // simply do not apply — which is why the card hides them.
    if (L.instrument.voice === 'speech') {
      // THE PART DECIDES WHEN A LINE STARTS. v1's spoken layers run a bespoke
      // clock ("speak, then gap"); here the RHYTHM does it, so a line can land on
      // a euclid pulse or once a cycle like anything else. Pitch is meaningless
      // — the words carry it — so an onset is just a line index.
      const lines = speechLines(L);
      if (!lines.length) return out;
      const ons2 = onsetsOf(p, seedBase);
      for (let i = 0; i < ons2.length; i++) {
        out.push({ at: cs + ons2[i] * cyc, freq: 1, durMs: 0,
                   line: (cycIdx * ons2.length + i) % lines.length });
      }
      return out;
    }
    if (L.instrument.voice === 'kit') {
      // RESTS through v1's own `_ambEffRest`, which ADDS the Area Groove
      // density macro on top of the layer's value — reading `L.restProb`
      // directly is why the groove panel's Density did nothing to a v2 layer.
      const rest = (typeof _ambEffRest === 'function') ? (_ambEffRest(L) | 0) : (L.restProb | 0);
      const ghost = L.ghosts | 0, lvar = L.lenVary | 0;
      const st = Math.max(1, p.rhythm.steps | 0);
      const lanes = p.rhythm.lanes || [];
      const slot = cyc / st;
      const durMs = Math.max(20, Math.round(slot * 1000 * (p.shape.lenRatio / 100)));
      for (let li = 0; li < _V2_LANES; li++) {
        const row = lanes[li] || [];
        for (let i = 0; i < st; i++) {
          if (!row[i]) continue;
          const sd = (L.id | 0) * 9176 ^ (cycIdx * 2246822519) ^ (li * 7919) ^ (i * 40503);
          if (rest > 0 && vRnd(sd, 11) * 100 < rest) continue;
          let dm = durMs;
          if (lvar > 0) dm = Math.max(20, Math.round(durMs * (1 + (vRnd(sd, 23) * 2 - 1) * (lvar / 100) * 0.6)));
          const at0 = cs + i * slot;
          out.push({ at: at0, freq: midiToFreq(36 + _V2_VDRUM[li]), durMs: dm, lane: li });
          if (ghost > 0 && vRnd(sd, 37) * 100 < ghost * 0.6) {
            const gAt = at0 + slot * 0.5;
            if (gAt < cs + cyc) out.push({ at: gAt, freq: midiToFreq(36 + _V2_VDRUM[li]), durMs: Math.max(20, Math.round(dm * 0.45)), lane: li, ghost: 1 });
          }
        }
      }
      out.sort((a2, b2) => a2.at - b2.at);
      return out;
    }
    // GROUNDWORK lands on the CHANGES, so its onsets are not a grid: one on
    // the 1 of the cycle and one on every chord boundary inside it. That needs
    // the clock, which `onsetsOf` has no access to (it sees the part and a
    // seed), so it is resolved here where `ctx` has the engine and the time.
    // With no progression it falls back to the BAR line, which is the same
    // rule with one chord.
    const ons = (p.rhythm.kind === 'ground')
      ? groundOnsets(ctx, cs, cyc, p) : onsetsOf(p, seedBase);
    // THE NOTE'S OWN SLOT, not the average of all of them. This was
    // `cyc / ons.length` — ONE length for every note — so on an uneven pattern
    // (a euclid 7-of-16 has gaps of 2,2,3,2,2,3,2 steps) every note came out
    // the same width whatever slot it sat in: the ones in a 3-step gap fell
    // short of it and the ones in a 2-step gap ran past. Reported as "note
    // event width isn't right" — measured, every note of a 7-of-16 was 2.06
    // steps long. The field is labelled "% of the onset span" and the comment
    // below has always claimed "Length stretches with the gaps"; it did not.
    // The last onset's slot runs to the top of the NEXT cycle, which is where
    // its own next hit would fall.
    const gapAt = (k) => {
      // AN EMPTY PATTERN IS A REST, and `durMs` below asks for gap 0 whatever
      // the onsets are — without this guard `ons[0]` is undefined, the gap is
      // NaN, and a NaN duration reaches playNote. Which is silence, everywhere.
      if (!ons.length) return 1;
      const a = ons[k] || 0;
      const b2 = (k + 1 < ons.length) ? ons[k + 1] : (ons[0] + 1);
      const d = b2 - a;
      return Number.isFinite(d) ? Math.max(1e-4, d) : 1;
    };
    const span = cyc / Math.max(1, ons.length);           // the AVERAGE — Hold and the fallbacks still use it
    // HOLD sizes the note off the STEP GRID instead — N steps long, whatever the
    // onset spacing happens to be. v1's own semantics (`holdSteps`, 0 = use the
    // length instead): the two answer different questions, and a sparse pattern
    // is exactly where they diverge — Length stretches with the gaps, Hold does
    // not. Absent or 0 keeps Length, so nothing moves by default.
    const holdN = clamp((p.shape.holdSteps | 0), 0, 16);
    const durAt = (holdN > 0)
      ? () => Math.max(20, Math.round((cyc / Math.max(1, p.rhythm.steps | 0)) * 1000 * holdN))
      : (k) => Math.max(20, Math.round(gapAt(k) * cyc * 1000 * (p.shape.lenRatio / 100)));
    const durMs = durAt(0);                               // the fallbacks below want a number
    // RESTS through v1's own `_ambEffRest`, which ADDS the Area Groove
      // density macro on top of the layer's value — reading `L.restProb`
      // directly is why the groove panel's Density did nothing to a v2 layer.
      const rest = (typeof _ambEffRest === 'function') ? (_ambEffRest(L) | 0) : (L.restProb | 0);
      const ghost = L.ghosts | 0, lvar = L.lenVary | 0;
      const rateV = clamp((p.rhythm && p.rhythm.rateVar) | 0, 0, 100);
    // ONE memory per cycle — that is what makes a proximity-shaped line
    // deterministic and replayable rather than dependent on tick boundaries.
    const mem = { prev: null };
    p._prox = L.proximity | 0;
    // The CYCLE INDEX, for the structured voicer — it is what walks the chord
    // phrase (repeat for `chordRepeats` cycles, then a fresh phrase). Stashed
    // on the part exactly as `_prox` is, because `pitchesAt` has no cycle.
    p._cyc = cycIdx | 0;
    // START — where this cycle's phrase BEGINS inside its cycle: on the 1, or at
    // a stochastic point anywhere it still fits. v1 has this twice under two
    // names (`startVary` on a bed, `phraseVary` on a motif) and says so — one
    // algorithm, two copies — so v2 keeps one field.
    //
    // The CASCADE is the prize: `_ambEffStart` falls back to the AREA's
    // `startVary`, which IS the Groove panel's Humanize macro, so a v2 layer
    // that sets nothing now follows it (and a groove bypass silences it).
    //
    // The offset itself is NOT `_ambStartOffset`, deliberately: that helper
    // draws from `_ambRand`, the SHARED stream, and every draw v2 makes is
    // isolated precisely so a v2 layer cannot shift a v1 layer's numbers. Same
    // rule, same slack, its own seed.
    let startOff = 0;
    try {
      const sv = (typeof _ambEffStart === 'function')
        ? _ambEffStart(Number.isFinite(L.startVary) ? L.startVary : undefined, ctx.cfg) : 0;
      if (sv > 0 && vRnd(seedBase ^ 0x5bf03635, 127) * 100 < sv) {
        const spanSec = cyc / Math.max(1, (p.rhythm && p.rhythm.steps) || 1);
        const slack = Math.max(0, Math.max(0.05, cyc) - Math.max(0, spanSec) - 0.02);
        if (slack > 0.02) startOff = vRnd(seedBase ^ 0x27d4eb2f, 131) * slack;
      }
    } catch (e) {}
    // POLYPHONIC EUCLID — v1's `euclidVoices`, and NOT the same thing as
    // `pitch.voices`: that stacks N notes on ONE onset (a chord), whereas this
    // gives each voice its OWN euclidean row, its own degree and its own
    // octave, so they INTERLOCK. `_ambEuclidVoicePat` is v1's own spread —
    // pulses offset by [0,2,-2,3,-3,1] and rotate by v x steps/V — so two
    // engines cannot disagree about what 3-voice euclid sounds like. The kit
    // already had this shape (8 lanes, own rows); this is its melodic twin.
    const evc = clamp((p.rhythm.voices | 0) || 1, 1, 8);
    if (p.rhythm.kind === 'euclid' && evc > 1 && typeof _ambEuclidVoicePat === 'function') {
      const stp = Math.max(1, p.rhythm.steps | 0);
      // The voices ARE the source stack — one tone each, octave on wrap — so the
      // pitch is asked for as a stack of `evc` and voice v takes entry v.
      const stackPart = { rhythm: p.rhythm, shape: p.shape,
                          pitch: { kind: 'stack', degree: (p.pitch.degree | 0) || 1, voices: evc },
                          _prox: 0, _deg: null, _oct: 0 };
      const slotSec = cyc / stp;
      const dmB = Math.max(20, Math.round(slotSec * 1000 * (p.shape.lenRatio / 100)));
      for (let v = 0; v < evc; v++) {
        let vpat = null;
        // the SAME phase normalisation as `euclidCells` — this branch never
        // touches it (it builds every voice, v=0 included, from v1's per-voice
        // pattern), so without this a polyrhythm would keep the old offset
        // while a single-voice part was fixed. Taken from the BASE pulses, so
        // voice 0 lands on the beat and the deliberate `v * steps/V` spread of
        // the others is preserved relative to it.
        try {
          vpat = _ambEuclidVoicePat(p.rhythm.pulses | 0,
            (p.rhythm.rotate | 0) + euclidPhase(p.rhythm.pulses | 0, stp), stp, evc, v, 0);
        } catch (e) {}
        if (!vpat || !vpat.length) continue;
        for (let i2 = 0; i2 < stp; i2++) {
          if (!vpat[i2 % vpat.length]) continue;
          const vAt = cs + (i2 / stp) * cyc;
          const vms = withKeyTime(vAt, () => pitchesAt(stackPart, ctx.E, ctx.cfg, vAt,
              L.instrument.register | 0,
              seedBase ^ ((i2 * 31 + v) * 2654435761), i2, mem, L));
          if (!vms.length) continue;
          const pick = vms[v % vms.length];
          out.push({ at: vAt, freq: midiToFreq(pick), durMs: dmB });
        }
      }
      out.sort((a3, b3) => a3.at - b3.at);
      if (startOff > 0) for (let z2 = 0; z2 < out.length; z2++) out[z2].at += startOff;
      const mxv = clamp((p.shape && p.shape.maxEvents) | 0, 0, 64);
      if (mxv > 0 && out.length > mxv) out.length = mxv;
      return out;
    }
    for (let i = 0; i < ons.length; i++) {
      // A REST drops the whole onset — checked before anything is resolved, so a
      // dropped onset costs nothing and consumes no other draw.
      if (rest > 0 && vRnd(seedBase ^ (i * 40503), 11) * 100 < rest) continue;
      let at = cs + ons[i] * cyc;
      // RATE VAR — v1's steady → rushes: a seeded push/pull of each onset
      // within its own span. Replays per take; 0 draws nothing.
      if (rateV > 0 && i > 0) {
        const rj = (vRnd(seedBase ^ (i * 15487469), 41) * 2 - 1) * (rateV / 100) * 0.4 * span;
        at = Math.min(cs + cyc - 0.01, Math.max(cs, at + rj));
      }
      // The step INDEX, not the onset ordinal: a drawn pitch belongs to the cell
      // it was drawn on, so with a sparse rhythm step 5 must keep step 5's note
      // even if it is only the second onset.
      const stepIdx = (p.rhythm.kind === 'euclid' || p.rhythm.kind === 'drawn' || p.rhythm.kind === 'chance')
        ? Math.round(ons[i] * Math.max(1, p.rhythm.steps | 0)) : i;
      // GROUNDWORK CAN PLAY A DIFFERENT NUMBER OF TONES ON EACH CHANGE — the
      // point of a part that fills the harmony is that some changes want three
      // notes and some want one. `part.ground.per` keys on the ABSOLUTE chord
      // index (what `_ambProgStepAt` answers, and what the chord matrix already
      // keys on), so it survives a part being added before this one; absent
      // falls back to `pitch.voices`, which is the one number for every change.
      let pAt = p;
      if (p.rhythm.kind === 'ground') {
        const nv = groundVoicesAt(ctx, at, p);
        if (nv > 0 && nv !== (p.pitch.voices | 0)) {
          pAt = Object.assign({}, p, { pitch: Object.assign({}, p.pitch, { voices: nv }) });
        }
      }
      const ms = withKeyTime(at, () => pitchesAt(pAt, ctx.E, ctx.cfg, at, L.instrument.register, seedBase ^ (i * 2654435761), stepIdx, mem, L));
      if (pAt !== p) { p._deg = pAt._deg; p._oct = pAt._oct; }
      // LEN VARY scales this onset's notes together — a chord must not come
      // apart into different lengths, which is why it is per ONSET not per note.
      const dm0 = durAt(i);
      let dm = dm0;
      if (lvar > 0) dm = Math.max(20, Math.round(dm0 * (1 + (vRnd(seedBase ^ (i * 40503), 23) * 2 - 1) * (lvar / 100) * 0.6)));
      // PHRASING — v1's GESTURE CELLS. With probability `phrasing` this onset
      // takes a shaped figure — relative onsets and durations with an ARRIVAL
      // note (agogic emphasis: long, and leaned on) — instead of a uniform
      // burst. With probability .35 the PREVIOUS gesture repeats, which is the
      // classical sequence device: same rhythm, new pitch level. The cells are
      // v1's five, verbatim. Held on the LAYER (non-enumerable, so it never
      // reaches a save) because a gesture persists ACROSS cycles, which `mem`
      // does not. Takes precedence over Twist, exactly as v1's plan overrides
      // its burst count.
      const phr = clamp(L.phrasing | 0, 0, 100);
      if (phr > 0 && vRnd(seedBase ^ (i * 2654435761), 107) * 100 < phr) {
        let gs = L.__v2gest;
        if (!gs) {
          gs = {};
          try { Object.defineProperty(L, '__v2gest', { value: gs, enumerable: false, writable: true, configurable: true }); }
          catch (e) { gs = {}; }
        }
        const reuse = gs.cell && vRnd(seedBase ^ (i * 40503), 109) < 0.35;
        const cell = reuse ? gs.cell : _V2_CELLS[Math.floor(vRnd(seedBase ^ (i * 7919), 113) * _V2_CELLS.length) % _V2_CELLS.length];
        gs.cell = cell;
        for (let q = 0; q < cell.length; q++) {
          const cAt = at + cell[q][0] * span;
          if (cAt >= cs + cyc) break;
          const cms = withKeyTime(cAt, () => pitchesAt(p, ctx.E, ctx.cfg, cAt, L.instrument.register,
              seedBase ^ ((i * 613 + q) * 2654435761), stepIdx, mem, L));
          const cd = Math.max(60, Math.round(cell[q][1] * span * 1000));
          for (let v = 0; v < cms.length; v++) {
            const cn = { at: cAt, freq: midiToFreq(cms[v]), durMs: cd };
            if (cell[q][2]) cn.arr = 1;          // the arrival: leaned on at emit
            if (v === 0 && p._deg != null) { cn.deg = p._deg; cn.oct = p._oct | 0; }
            out.push(cn);
          }
        }
        continue;
      }
      // TWIST — v1's rule: 0 is a single note per onset; as it rises the CHANCE
      // and the SIZE of a quick burst both grow (2..~7 notes), packed ≤120 ms
      // apart, so the line stutters into runs. Each extra note re-picks, which
      // is what makes it a flurry of walk-steps rather than a repeat — so it
      // sits here, after the first pick, and asks `pitchesAt` again.
      const tw = clamp(L.twist | 0, 0, 100) / 100;
      if (tw > 0 && vRnd(seedBase ^ (i * 2654435761), 91) < tw) {
        const cnt = 2 + Math.floor(vRnd(seedBase ^ (i * 40503), 97) * (1 + tw * 5));
        const gap = Math.min(0.12, (dm / 1000) / Math.max(1, cnt));
        for (let q = 0; q < cnt; q++) {
          const bAt = at + gap * q;
          if (bAt >= cs + cyc) break;
          const bms = (q === 0) ? ms
            : withKeyTime(bAt, () => pitchesAt(p, ctx.E, ctx.cfg, bAt, L.instrument.register,
                seedBase ^ ((i * 977 + q) * 2654435761), stepIdx, mem, L));
          const bd = Math.max(20, Math.round(Math.min(dm, gap * 1000 * 1.6)));
          for (let v = 0; v < bms.length; v++) {
            const nb = { at: bAt, freq: midiToFreq(bms[v]), durMs: bd };
            if (v === 0 && p._deg != null) { nb.deg = p._deg; nb.oct = p._oct | 0; }
            out.push(nb);
          }
        }
        continue;
      }
      // FOLLOW SALT — the "Keys" behaviour. Salt sub-divides ONE chord instance
      // into colour segments (C · C(no3) · Cmaj7), and a chord layer normally
      // samples its chord ONCE at the onset and holds — so those changes are
      // inaudible. `_ambBedSaltPlan` resolves the whole segment plan for this
      // onset and returns one note per TONE spanning the contiguous run of
      // segments it belongs to: a shared tone gets a single long note (no
      // retrigger, no envelope restart), a leaver simply ends, an arrival starts
      // at its boundary. v1's own planner, so the two cannot deal different
      // colours for the same instant. Returns null whenever there is nothing
      // segmented to do, so the plain path below is unchanged.
      if (L.followSalt && typeof _ambBedSaltPlan === 'function') {
        let plan = null;
        try {
          const src2 = (typeof _ambNotesOf === 'function') ? _ambNotesOf(L) : null;
          const vfreq = ms.map(m2 => midiToFreq(m2));
          // THE SHIM MUST CARRY THE CAP. `_ambBedSaltPlan` asks
          // `_ambVoiceCap(bed)`, which is `voiceCap` when set and DENSITY
          // otherwise — so a bare `{followSalt:1}` resolved to a cap of ONE and
          // every ARRIVING colour tone was trimmed straight back off. Measured:
          // 3 notes, 0 arrivals — leavers worked, arrivals never appeared, i.e.
          // half the feature, silently. (v1 documents this exact trap on its own
          // control: "without it the feature silently does nothing at common
          // settings, since Density 3 trims an arriving maj7 straight off".)
          plan = _ambBedSaltPlan({
            followSalt: 1,
            density: clamp((p.pitch.voices | 0) || 3, 1, 9),
            voiceCap: clamp((p.pitch.voiceCap | 0), 0, 12),
          }, src2, at, span, vfreq);
        } catch (e) { plan = null; }
        if (plan && plan.length) {
          for (let k = 0; k < plan.length; k++) {
            const nt = plan[k];
            if (nt && nt.f > 0) out.push({ at: at + (nt.offSec || 0), freq: nt.f, durMs: nt.durMs });
          }
          continue;
        }
      }
      // STRUM — spread this onset's notes over a fraction of the span instead
      // of striking them together: 0 is a pad, 100 an arpeggio across the whole
      // span. The PLAY ORDER comes from v1's own `_ambStrumOrder` (a partial
      // Fisher–Yates on the seeded stream, so Fidelity 0 is low→high every time
      // and higher wanders), which is what keeps a strummed v2 chord and a
      // strummed v1 bed sounding like the same instrument. Absent or 0 spends
      // no draw and emits exactly as before.
      const strumAmt = clamp((L.strum | 0), 0, 100);
      if (strumAmt > 0 && ms.length > 1) {
        const spanSec = (strumAmt / 100) * (cyc / Math.max(1, ons.length));
        let order = null;
        try { if (typeof _ambStrumOrder === 'function') order = _ambStrumOrder(ms.length, L.strumFidelity | 0); } catch (e) {}
        for (let k = 0; k < ms.length; k++) {
          const v = order ? order[k] : k;
          out.push({ at: at + (spanSec * k) / Math.max(1, ms.length - 1), freq: midiToFreq(ms[v]), durMs: dm });
        }
      } else {
        // SLIP — a STOCHASTIC strum: each note of the onset is nudged a little
        // later by its own seeded draw, so a block chord arrives as a hand
        // would play it rather than as a machine. Distinct from v1's Strum,
        // which is a DETERMINISTIC spread in a fixed order — slip has no order
        // and no fixed spacing, and the two compose. Seeded on (onset, voice)
        // so a take replays; 0 draws nothing and is byte-identical.
        const slipAmt = clamp((p.shape && p.shape.slip) | 0, 0, 100);
        const slipMax = slipAmt > 0 ? (slipAmt / 100) * Math.min(0.18, span * 0.5) : 0;
        for (let v = 0; v < ms.length; v++) {
          const off = slipMax > 0 ? vRnd(seedBase ^ ((i * 31 + v) * 2246822519), 137) * slipMax : 0;
          const nt2 = { at: at + off, freq: midiToFreq(ms[v]), durMs: dm };
          // Only the FIRST voice of an onset carries the degree — a slide and an
          // ornament are gestures on the LINE, not on each note of a chord.
          if (v === 0 && p._deg != null) { nt2.deg = p._deg; nt2.oct = p._oct | 0; }
          out.push(nt2);
        }
      }
      // A GHOST is a quieter repeat just after the onset — the thing that makes
      // a stiff pattern breathe. Placed at a third of the span so it reads as a
      // flam rather than a second onset, and marked so the emitter can drop its
      // level (a ghost at full volume is just a doubled note).
      if (ghost > 0 && ons.length > 1 && vRnd(seedBase ^ (i * 40503), 37) * 100 < ghost * 0.6) {
        const gAt = at + span * 0.33;
        if (gAt < cs + cyc) out.push({ at: gAt, freq: midiToFreq(ms[0]), durMs: Math.max(20, Math.round(dm * 0.45)), ghost: 1 });
      }
    }
    // The phrase's START shifts the WHOLE cycle, so it is applied once here
    // rather than at each push — and BEFORE Max events, so the cap still keeps
    // the earliest of what actually sounds.
    if (startOff > 0) for (let z = 0; z < out.length; z++) out[z].at += startOff;
    // MAX EVENTS — v1's rule: cap the note-events in a cycle, keeping the
    // EARLIEST. Applied last, after every onset, voice and ghost, so it is a
    // ceiling on the whole cycle rather than on one stage of it. 0 = off.
    const mx = clamp((p.shape && p.shape.maxEvents) | 0, 0, 64);
    if (mx > 0 && out.length > mx) {
      out.sort((a2, b2) => a2.at - b2.at);
      out.length = mx;
    }
    return out;
  }

  // ── WRITE — THE DOOR ────────────────────────────────────────────────────
  // In v1, Write/Evolve is a feature with its own clock, freeze store, thaw
  // rules and a per-type gate deciding whether it should engage at all. In this
  // model it is not a feature: it is the LIVE → RECORDED transition, and the
  // part interface makes it almost nothing. Capture = ask the live part what it
  // plays for one cycle, and keep the answer. Release = play the rules again.
  //
  // Because a live part is a pure function of (cycle index, context), capturing
  // is deterministic and needs no engine involvement — no rolling buffer, no
  // freeze gate, no thaw handoff, and none of the seam bugs that machinery has.
  const freqToMidi = (f) => Math.round(69 + 12 * Math.log2(f / A4()));

  // Which cycle is sounding right now — so Capture keeps WHAT YOU JUST HEARD,
  // not an unrelated realization. Stopped, cycle 0 is the honest answer.
  function currentCycle(E, L, cfg) {
    const cyc = Math.max(0.05, L.part.bars * barSec(cfg));
    const st = E._v2Phase && E._v2Phase['v2:' + L.id];
    const anchor = (st && Number.isFinite(st.startAt)) ? st.startAt
      : (Number.isFinite(E._barGridAnchor) ? E._barGridAnchor : 0);
    let now = anchor;
    try { if (E.timer && typeof Tone !== 'undefined' && Tone.now) now = Tone.now(); } catch (e) {}
    const idx = Math.max(0, Math.floor((now - anchor) / cyc));
    return { cycleStart: anchor + idx * cyc, cycleSec: cyc };
  }

  // THE KEY A RECORDED PART WAS WRITTEN IN. `_ambLockHarmonizeFreq` transposes
  // from the CAPTURED key to the current one, so without this a 'Follow the
  // key' part had nothing to move FROM and the setting did nothing (measured:
  // identical pitches in C and in A minor). Stamped by all three doors —
  // capture, compose, adopt — through one helper so they cannot disagree.
  function stampPartKey(L, cfg) {
    try {
      L.part.key = { root: (_ambKeyRootPc(cfg) % 12 + 12) % 12, scale: _ambKeyScaleName(cfg) || '' };
    } catch (e) { delete L.part.key; }
  }
  // A TAKE THAT WAS FOLLOWING THE CHANGES KEEPS FOLLOWING THEM. A live part
  // resolves every note against the chord sounding at its own onset; freezing
  // it stores absolute pitches, and with the default 'fixed' it then plays the
  // chords it was CAPTURED over for the rest of the piece — reported as "the
  // part just repeats the first 2 chords, even over part 2". Measured on a
  // 5+3-chord progression: live 20/20 notes in the sounding chord, locked
  // 8/20. So a capture made while a progression is running defaults to
  // following it, which is what you just heard; the Content ▸ Follows changes
  // control sets it back to Fixed if the frozen pitches were the point.
  // Only when the layer has no opinion yet — never overriding a stored choice.
  function stampFollowsChanges(L, cfg) {
    try {
      if (L.harmony === 'fixed' || L.harmony === 'diatonic' || L.harmony === 'chordlock') return;
      const pr = cfg && cfg.prog;
      if (pr && pr.on && Array.isArray(pr.chords) && pr.chords.length > 1) L.harmony = 'chordlock';
    } catch (e) {}
  }

  // opts.at — the cycle start to read at. Locking must freeze THE TAKE THAT IS
  // SHOWING, and under a progression the pitches depend on the chord sounding
  // at that instant, so the drawing hands its own anchor in rather than letting
  // this re-read "now" and capture a different chord than the one you heard.
  // opts.reroll — bump the take before rolling. A REPLACE has to: the pinned
  // take exists so that LOCKING freezes what is drawn, but a recorded part
  // captured take N and a "replace" that rolls take N again returns the
  // identical notes — the button did nothing, and the earlier verification
  // compared `made`, never the notes. A lock still must NOT bump.
  // opts.bars — replace only these bar indices: keep every stored note outside
  // them, take the fresh roll inside them. That is per-bar re-rolling.
  // ── TRANSFORMS — commands that rework the notes you already have ────────
  // A REGISTRY, because the set is meant to grow: one entry is a label, a
  // past-tense word for the hint, and a function over the scoped notes.
  // Everything works in CYCLE FRACTIONS (`t` and `dur` both are), so a
  // transform is exact and tempo-independent.
  // Rolled with `Math.random` at UI time, NEVER the seeded `_ambRand` stream —
  // the documented split that keeps generation byte-identical.
  const TRANSFORMS = {
    reverse: {
      label: '\u21c4 Reverse', word: 'reversed', hint: 'the notes play backwards',
      fn: (list, w0, w1) => list.map(n => {
        const t = w0 + w1 - (n.t + n.dur);
        return Object.assign({}, n, { t: clamp(t, w0, Math.max(w0, w1 - 1e-6)) });
      }),
    },
    shuffle: {
      label: '\ud83d\udd00 Shuffle', word: 'shuffled', hint: 'same rhythm, the notes re-ordered',
      // The RHYTHM is the part's identity, so shuffling moves the PITCHES
      // between the onsets it already has rather than moving the onsets.
      fn: (list) => {
        const pit = list.map(n => n.midi);
        for (let i = pit.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = pit[i]; pit[i] = pit[j]; pit[j] = t;
        }
        return list.map((n, i) => Object.assign({}, n, { midi: pit[i] }));
      },
    },
  };
  // regions → the window of the cycle they cover, as fractions. A transform
  // reworks a CONTIGUOUS span (reverse is a retrograde of a window), so
  // several regions give their outer bounds rather than a set.
  function tfWindow(L, bars) {
    const barsF = Math.max(0.125, L.part.bars || 1);
    if (!Array.isArray(bars) || !bars.length) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    bars.forEach((k) => { const r = regParse(k); if (!r) return;
      lo = Math.min(lo, r.a); hi = Math.max(hi, r.b); });
    if (!(hi > lo)) return [0, 1];
    const span = barsF * SPB;
    return [clamp(lo / span, 0, 1), clamp(hi / span, 0, 1)];
  }
  function transformFn(E, L, op, bars) {
    const T = TRANSFORMS[op];
    if (!T || !L || !L.part || L.part.kind !== 'recorded') return 0;
    const all = (L.part.notes || []);
    if (!all.length) return 0;
    const [w0, w1] = tfWindow(L, bars);
    const inScope = (n) => n.t >= w0 - 1e-9 && n.t < w1 - 1e-9;
    const scoped = all.filter(inScope);
    if (!scoped.length) return 0;
    const done = T.fn(scoped, w0, w1) || scoped;
    L.part.notes = all.filter(n => !inScope(n)).concat(done).sort((a, b) => a.t - b.t);
    // THE PART CARRIES WHAT WAS DONE TO IT: the hint says so, and
    // `replaceOK` counts a transformed take as WORK (a plain roll may be
    // replaced silently — this one may not).
    L.part.tf = op;
    try { E.getCfg(); } catch (e) {}
    return done.length;
  }

  // THE TAKE THE PICTURE IS SHOWING, AS STORED NOTES — and nothing else.
  // TWO callers want exactly this and want it to AGREE: 🔒 Lock keeps it on the
  // part, 💾 Save puts a copy in the bank. Two walks of one thing is how the
  // saved take and the locked one come to differ, so there is one.
  // PINNED — the take the drawing shows, never a fresh roll. That is the whole
  // of "lock what Live came up with": without the pin, locking rolled the dice
  // once more and froze a take nobody had heard.
  function takeAsNotes(E, L, cfg, ctx, reroll) {
    // Read through the LIVE spec whichever kind is active — that spec is always
    // retained, so this is meaningful on an already-recorded part too (re-take
    // it), and a part switched to Written with nothing in it has a way to
    // become non-empty.
    const asLive = Object.assign({}, L, { part: Object.assign({}, L.part, { kind: 'live' }) });
    let notes = [];
    // `pinOf(L, reroll)` — a REROLL supersedes the per-bar take pins (the scalar
    // has already been bumped) and KEEPS the per-bar rules, so re-rolling a bar
    // that generates by its own rules rolls those rules again rather than
    // silently falling back to the part's.
    try { notes = withEdit(() => withTake(pinOf(L, reroll), () => notesFor(asLive, { E, cfg, key: 'v2:' + L.id, cycleStart: ctx.cycleStart, cycleSec: ctx.cycleSec }))); }
    catch (e) { return null; }
    if (!notes.length) return null;
    return notes.map(n => ({
      t: clamp((n.at - ctx.cycleStart) / ctx.cycleSec, 0, 0.99999),
      midi: clamp(freqToMidi(n.freq), 0, 127),
      dur: clamp((n.durMs / 1000) / ctx.cycleSec, 0.001, 8),
    })).sort((a, b) => a.t - b.t);
  }

  function captureFn(E, L, opts) {
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg || !L) return false;
    const ctx = currentCycle(E, L, cfg);
    if (opts && Number.isFinite(opts.at)) ctx.cycleStart = opts.at;
    if (opts && opts.reroll) L.part.take = (takeOf(L) + 1) % 1000000;
    let fresh = takeAsNotes(E, L, cfg, ctx, !!(opts && opts.reroll));
    if (!fresh) return false;                           // nothing to freeze
    const barSel = (opts && Array.isArray(opts.bars) && opts.bars.length &&
                    L.part.kind === 'recorded' && (L.part.notes || []).length)
      ? opts.bars.map(String) : null;
    if (barSel) {
      // A SPLICE, not a replace: stored notes outside the chosen bars stay —
      // per-note edits included — and the fresh roll fills only those bars.
      const p0 = L.part, barsF = Math.max(0.125, p0.bars || 1);
      // BY REGION, not by bar — a change that fills half a bar is spliced into
      // exactly its half (reported as "clicking F♯m should only select the F♯m
      // area"). A whole-bar region is `[N·48, (N+1)·48)`, so bar selection is
      // this with nothing special about it.
      const inSel = (n) => regHas(barSel, slotAt(n.t, barsF));
      // The stored notes carry the register the part was MADE at (`p.reg`) and
      // the read shifts them by (register − reg)·12 — fresh notes roll at the
      // CURRENT register, so they are re-based onto the stored baseline or the
      // read-time shift would move them twice.
      const rb = Number.isFinite(p0.reg)
        ? (clamp((L.instrument.register | 0) || 4, 1, 8) - p0.reg) * 12 : 0;
      const kept = (p0.notes || []).filter(n => !inSel(n));
      fresh = kept.concat(fresh.filter(inSel)
        .map(n => ({ t: n.t, midi: clamp(n.midi - rb, 0, 127), dur: n.dur })));
      // an empty selected bar is a legitimate roll (the rules can rest there);
      // `made` and `reg` are NOT restamped — the unchosen bars are still
      // whatever they were, and absent-means-ask stays the safe side
      L.part.notes = fresh.sort((a, b) => a.t - b.t);
      L.part.transpose = L.part.transpose | 0;
      try { E.getCfg(); } catch (e) {}
      try { if (E._v2Phase) delete E._v2Phase['v2:' + L.id]; } catch (e) {}
      return true;
    }
    L.part.notes = fresh.sort((a, b) => a.t - b.t);
    L.part.kind = 'recorded';
    delete L.part.takeb;         // the composite is baked in — the map's job is done
    L.part.made = 'take';        // a roll of the live rules — re-rolling loses nothing
    L.part.reg = clamp((L.instrument.register | 0) || 4, 1, 8);   // the octave it was made in
    L.part.transpose = L.part.transpose | 0;
    stampPartKey(L, (function () { try { return E.getCfg(); } catch (e) { return null; } })());
    stampFollowsChanges(L, (function () { try { return E.getCfg(); } catch (e) { return null; } })());
    try { E.getCfg(); } catch (e) {}
    try { if (E._v2Phase) delete E._v2Phase['v2:' + L.id]; } catch (e) {}   // re-anchor cleanly
    return true;
  }

  // ── THE OTHER DOOR: A BANKED PHRASE ─────────────────────────────────────
  // Capture is one way to fill a recorded part; the compose grid is the other,
  // and it ALREADY EXISTS — you draw a phrase in a layer's ✎ Grid, save it, and
  // it lands in `savedSequences` as `{name, kind:'phrase', steps, bpm, sub}`.
  // v2 does not need an editor of its own to use that; it needs a reader.
  //
  // A phrase step advances `subdivision × duration` BEATS (`_ambGridStepAdv`'s
  // rule), which is what makes the conversion exact rather than a guess: walk
  // the steps accumulating beats, and every note's position is its own beat
  // offset over the total. `t` and `dur` are then fractions of the cycle, so
  // the phrase keeps its rhythm at any tempo.
  //
  // A REST is `freq: null` — it contributes time and no note, which is how a
  // phrase's silences survive the trip. A CHORD step carries `chord: [{freq}]`
  // instead of a single `freq`; missing that would silently import a chord as
  // nothing at all.
  function phraseToNotes(entry) {
    const steps = (entry && entry.steps) || [];
    if (!steps.length) return null;
    const gsub = Number.isFinite(entry.subdivision) ? entry.subdivision : 1;
    let total = 0;
    const walk = steps.map((st) => {
      const adv = ((st && st.subdivision != null) ? st.subdivision : gsub) * ((st && st.duration) || 1);
      const at = total; total += (adv > 0 ? adv : 0);
      return { at, adv: (adv > 0 ? adv : 0), st };
    });
    if (!(total > 0)) return null;
    const notes = [];
    walk.forEach((w) => {
      const st = w.st; if (!st) return;
      const fs = (Array.isArray(st.chord) && st.chord.length)
        ? st.chord.map(c => c && c.freq).filter(f => f > 0)
        : ((st.freq > 0) ? [st.freq] : []);
      fs.forEach(f => notes.push({
        t: clamp(w.at / total, 0, 0.99999),
        midi: clamp(freqToMidi(f), 0, 127),
        dur: clamp(w.adv / total, 0.001, 8),
      }));
    });
    return notes.length ? { notes, beats: total } : null;
  }

  // The bank, described rather than raw — the picker needs a length to show and
  // a reason to disable an entry it cannot use.
  function phrasesFn() {
    let bank = null;
    try { bank = (typeof savedSequences !== 'undefined' && Array.isArray(savedSequences)) ? savedSequences : null; } catch (e) {}
    if (!bank) return [];
    const out = [];
    for (let i = 0; i < bank.length; i++) {
      const e = bank[i]; if (!e || !e.name) continue;
      const got = phraseToNotes(e);
      out.push({ name: e.name, index: i, notes: got ? got.notes.length : 0,
                 bars: got ? Math.round((got.beats / 4) * 100) / 100 : 0 });
    }
    return out;
  }

  function adoptPhraseFn(E, L, name) {
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg || !L) return false;
    let entry = null;
    try { entry = (typeof _ambBankByName === 'function') ? _ambBankByName(name) : null; } catch (e) {}
    if (!entry) {
      try { entry = (typeof savedSequences !== 'undefined' ? savedSequences : []).find(x => x && x.name === name) || null; } catch (e) {}
    }
    const got = entry && phraseToNotes(entry);
    if (!got) return false;
    // The phrase states its own length, so the CYCLE takes it. Snapped to the
    // 1/48-bar grid the rest of the app uses, so quarters, eighths, triplets and
    // 16ths stay exact instead of accumulating float noise (the documented
    // fractional-cadence rule — an inexact length walks off the changes).
    let bars = got.beats / 4;
    try { if (typeof _ambSnapBars === 'function') bars = _ambSnapBars(bars); }
    catch (e) { bars = Math.round(bars * 48) / 48; }
    L.part.bars = clamp(bars > 0 ? bars : 1, 0.125, 64);
    L.part.notes = got.notes.slice().sort((a, b) => a.t - b.t);
    stampPartKey(L, (function () { try { return E.getCfg(); } catch (e) { return null; } })());
    L.part.kind = 'recorded';
    L.part.transpose = L.part.transpose | 0;
    L.part.from = String(name || '');            // provenance, for the readout — never behaviour
    L.part.made = 'phrase';                      // a phrase you chose — never replaced silently
    L.part.reg = clamp((L.instrument.register | 0) || 4, 1, 8);
    try { E.getCfg(); } catch (e) {}
    try { if (E._v2Phase) delete E._v2Phase['v2:' + L.id]; } catch (e) {}
    return true;
  }

  // ── THE THIRD DOOR: THE COMPOSE GRID, DOCKED IN THE CARD ────────────────
  // v1's ✎ Grid session is built on the freeze/lock machinery — `_ambFreezeState`,
  // `_ambStepsToLock`, `lockState.seedEdit` — none of which v2 has or wants (the
  // whole point of the Live/Recorded axis is that Write needs no engine state).
  // But that machinery is only at the session's two ENDS: seeding the canvas and
  // committing it. The middle — the scratch lane, the docked strip, the step
  // editor, ⤸ Bar, ✎ Place — is plain v1 grid infrastructure that takes a lane.
  //
  // So v2 borrows the middle and supplies its own ends: seed the lane from the
  // part's notes, and on ✓ Done convert the lane's steps straight back into
  // notes with `phraseToNotes` — the SAME reader the phrase bank uses, so a
  // phrase you compose here and one you adopt cannot land differently.
  //
  // Cross-file note: `lanes`, `_bloomGridEdit`, `_laneExpanderOpen` and
  // `activeLaneIdx` are top-level LEXICAL bindings, not window properties —
  // assigning `window._bloomGridEdit` sets an unrelated property and the session
  // never opens (documented). They are assigned by BARE NAME here.
  function partEvents(E, L, cfg) {
    const p = L.part;
    const cyc = Math.max(0.05, p.bars * barSec(cfg));
    if (p.kind === 'recorded' && p.notes.length) {
      const tr = p.transpose | 0;
      return { loopLen: cyc, events: p.notes.map(n => ({
        t: n.t * cyc, freq: midiToFreq(n.midi + tr), dur: n.dur * cyc * 1000 })) };
    }
    // LIVE — seed from what it actually plays, so the canvas opens on the music
    // rather than blank (v1 learned the same thing: an empty canvas made the
    // layer fall silent on the click and showed nothing to edit).
    const asLive = Object.assign({}, L, { part: Object.assign({}, p, { kind: 'live' }) });
    let notes = [];
    try { notes = withEdit(() => notesFor(asLive, { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc })); } catch (e) {}
    return { loopLen: cyc, events: notes.map(n => ({ t: n.at, freq: n.freq, dur: n.durMs })) };
  }

  function composeFn(E, L) {
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg || !L) return false;
    if (typeof lanes === 'undefined' || typeof _makeLane !== 'function') return false;
    const key = 'v2:' + L.id;
    // Opening a session elsewhere must not silently commit an open one.
    try {
      if (_bloomGridEdit) {
        if (_bloomGridEdit.key === key) return true;                  // already open here
        if (typeof _ambGridEditStop === 'function') _ambGridEditStop(false);
      }
    } catch (e) {}
    let steps = [];
    try { steps = _ambLockToSteps(partEvents(E, L, cfg)); } catch (e) { return false; }
    if (!steps || !steps.length) return false;

    const lane = _makeLane(lanes.length, steps);
    lane._bloomScratch = true; lane.muted = true; lane.name = '✎' + key;
    // The grid must play the LAYER'S instrument — auditioning a step in a voice
    // the layer will never use is the one v1 explicitly fixed here.
    try {
      const t = L.instrument && L.instrument.tone;
      if (t) lane.voice = t; else if (typeof _defaultVoice === 'function') lane.voice = _defaultVoice();
    } catch (e) {}
    lanes.push(lane);
    const sig0 = (typeof _ambGridEditSig === 'function') ? _ambGridEditSig(lane.steps) : '';
    _bloomGridEdit = {
      E, key, lane, seqName: '', v2: L,                 // `v2` is what _ambGridEditStop branches on
      prevActive: (typeof activeLaneIdx !== 'undefined') ? activeLaneIdx : 0,
      prevOpen: (typeof _laneExpanderOpen !== 'undefined') ? _laneExpanderOpen : false,
      snapshot: { ev: [], loopLen: 0 }, sig: sig0, startSig: sig0, timer: null,
    };
    window._bloomGridKey = key;                          // _placeLaneExpander resolves the dock by this
    // COVER THE PASS, exactly as v1 does at its own session start. Without it a
    // phrase shorter than the pass leaves the later chord blocks with NO steps
    // to edit — the chord ruler draws them and they are dead. Padding with
    // rests is what makes "compose per change" work, and it is the same call
    // v1 makes; it only ever ADDS, so a phrase longer than the pass is left be.
    // …but the PAD half only. `_ambGridPadAndCommit` also COMMITS — it calls
    // `_ambStepsToLock` and sets `frozen`/`_lock` on the key, and a freeze on a
    // v2 key outranks the live pipeline (`_ambFreezeGate` returns handled), so
    // the layer goes silent for good. Caught by test:ui: 21 v2 emission checks
    // dropped to n=0, the same signature as the compose-flush regression.
    // v2 commits through `composeCommit`, so it needs the padding and nothing
    // else. Re-render so the freshly padded steps are what the strip mirrors.
    try {
      if (typeof _ambGridPadLaneToPass === 'function') _ambGridPadLaneToPass(E, _bloomGridEdit);
      if (typeof _aliasSequenceToActiveLane === 'function') _aliasSequenceToActiveLane();
      if (typeof renderSequence === 'function') renderSequence();
    } catch (e) {}
    const idx = lanes.length - 1;
    try { if (typeof activateLane === 'function') activateLane(idx); else activeLaneIdx = idx; } catch (e) { activeLaneIdx = idx; }
    try { _laneExpanderOpen = true; } catch (e) {}
    try { if (typeof _syncFluidGridToActiveLane === 'function') _syncFluidGridToActiveLane(); } catch (e) {}
    try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
    try { if (typeof _placeLaneExpander === 'function') _placeLaneExpander(); } catch (e) {}
    return true;
  }

  // Called from `_ambGridEditStop`'s v2 branch. Steps in, notes out — through
  // the same reader the bank uses, so the two doors cannot diverge.
  function composeCommitFn(ge) {
    if (!ge || !ge.v2) return false;
    const L = ge.v2;
    let sub = 1; try { if (typeof stepSubdivision === 'number') sub = stepSubdivision; } catch (e) {}
    const got = phraseToNotes({ steps: (ge.lane && ge.lane.steps) || [], subdivision: sub });
    if (!got) { L.part.notes = []; L.part.kind = 'recorded'; L.part.made = 'compose'; return true; }   // drew nothing = a rest, honoured
    let bars = got.beats / 4;
    try { if (typeof _ambSnapBars === 'function') bars = _ambSnapBars(bars); }
    catch (e) { bars = Math.round(bars * 48) / 48; }
    L.part.bars = clamp(bars > 0 ? bars : 1, 0.125, 64);
    L.part.notes = got.notes.slice().sort((a, b) => a.t - b.t);
    stampPartKey(L, (function () { try { return ge.E.getCfg(); } catch (e) { return null; } })());
    L.part.kind = 'recorded';
    L.part.made = 'compose';                             // drawn by hand — never replaced silently
    L.part.reg = clamp((L.instrument.register | 0) || 4, 1, 8);
    delete L.part.from;                                  // composed here, not adopted
    try { if (ge.E && ge.E._v2Phase) delete ge.E._v2Phase['v2:' + L.id]; } catch (e) {}
    return true;
  }

  // ── IMPORT: READ A v1 LAYER AS PIECES ───────────────────────────────────
  // The question v2 has to answer before v1 could ever retire. It is two jobs,
  // and only one of them is interesting:
  //
  //   TREATMENTS are copied 1:1 — they are already the SAME fields (level, fx,
  //   bus, stereo, gates), which is the payoff of deciding treatments are not
  //   constituents. Copied by an explicit LIST, never a blind spread: a spread
  //   would drag v1's generation fields (density, restProb, holdSteps…) onto a
  //   v2 layer where they mean nothing and normalize would keep them forever.
  //
  //   PIECES are DERIVED, per type — the actual translation, and the test of
  //   whether the six-piece spine really covers what v1 does.
  const _V2_TREATMENTS = ['level', 'panMode', 'space', 'areaFadeMs', 'cutoff', 'reso',
    'revSend', 'wetOnly', 'delay', 'dist', 'chorus', 'phaser', 'autopan', 'glitch',
    'tg', 'spat', 'bus', 'when', 'chordMask', 'sectionMask', 'unitGate', 'iterGate', 'solo',
    // The Performance / Variance family. These became v2 treatments in slices 13
    // and 14, so the import now CARRIES them instead of leaving them behind —
    // which is most of what separated an imported layer from a clone.
    'humanize', 'velVar', 'fine', 'portamento', 'voiceTrim',
    'restProb', 'ghosts', 'lenVary',
    // The PITCH SOURCE and the per-layer key override. Both are read by
    // `_ambNotesOf`, which v2 now asks, so carrying them makes an imported
    // layer keep the harmony it had rather than snapping to the area's.
    'notes', 'keyOv'];

  // How long one pass is, in bars. v1 says this several ways depending on type.
  function v1Bars(L1, type) {
    // `L1.unit` IS the answer and every v1 layer has one: a bar RATIO
    // (`{mode:'sync', ref:'bar', num, den}`) — bed 2/1, motif 2/3, arp 3/1. It is
    // exactly v2's `part.bars`, so no conversion and no clock needed.
    // (`_ambNaturalUnitSec` is NOT `(L, type)` — called that way it returns 0.05
    // or throws, which collapsed every imported cycle to the 0.125 floor.)
    const u = L1.unit;
    if (u && u.mode === 'sync' && u.ref === 'bar' && (u.num | 0) > 0 && (u.den | 0) > 0) {
      return clamp(Math.round(((u.num | 0) / (u.den | 0)) * 48) / 48, 0.125, 64);
    }
    if (Number.isFinite(L1.bars) && L1.bars > 0) return clamp(L1.bars, 0.125, 64);
    if (Number.isFinite(L1.intervalMs) && L1.intervalMs > 0) {
      let bpm = 120; try { bpm = _ambBpm(); } catch (e) {}
      const bar = (60 / Math.max(20, bpm)) * 4;
      return clamp(Math.round(((L1.intervalMs / 1000) / bar) * 48) / 48, 0.125, 64);
    }
    return 2;
  }

  // `opts.l1` supplies the v1 layer instead of looking one up, and
  // `opts.specOnly` returns the spec rather than adding a layer — which is what
  // lets "seed this part like a v1 Bass" run the SAME mapping as importing a
  // real Bass, instead of a second copy of it that drifts.
  function fromV1Fn(E, key, opts) {
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg) return null;
    let L1 = (opts && opts.l1) || null;
    if (!L1) { try { L1 = _ambLayerByKey(E, key); } catch (e) {} }
    if (!L1) return null;
    const type = (key.indexOf(':') < 0) ? key : key.slice(0, key.indexOf(':'));
    const eff = (typeof _ambEffType === 'function') ? _ambEffType(L1, type) : type;
    const bars = v1Bars(L1, eff);
    const reg = clamp((L1.register | 0) || 4, 1, 8);
    const spec = { name: (typeof _ambLayerLabel === 'function' ? _ambLayerLabel(L1, eff) : eff),
                   instrument: { voice: 'synth', tone: (typeof L1.tone === 'string' ? L1.tone : ''), register: reg,
                                 attack: L1.attack, decay: L1.decay, sustain: L1.sustain, release: L1.release },
                   part: { kind: 'live', bars } };
    const P = spec.part;
    const euclid = () => ({ kind: 'euclid', steps: clamp((L1.steps | 0) || 8, 1, 64),
                            pulses: clamp((L1.pulses | 0) || 3, 1, 64), rotate: clamp((L1.rotate | 0) || 0, 0, 63) });

    if (eff === 'beat') {
      // A BEAT IS THE ONE THAT CHANGES INSTRUMENT — drum lanes become a v2 kit,
      // and a drawn kit grid carries straight over because both are 8 rows of
      // 0/1 in v1's own lane order.
      spec.instrument.voice = 'kit';
      spec.instrument.kit = (typeof L1.kit === 'string' && L1.kit) ? L1.kit : 'synth';
      P.rhythm = euclid();
      P.pitch = { kind: 'chord', voices: 1 };
      // A v1 Beat that is NOT in drum-lanes mode plays ONE drum on a euclidean
      // pattern, so it has no lanes to carry — importing it left an empty kit
      // that emitted nothing. Its pattern goes on the kick lane instead, which
      // is the same rhythm on a named drum rather than silence.
      if (!L1.euclidKit) {
        let pat0 = null;
        try { pat0 = euclidCells(P.rhythm.pulses, P.rhythm.steps, P.rhythm.rotate); } catch (e) {}
        if (pat0) P.rhythm.lanes = Array.from({ length: _V2_LANES }, (_, li) => (li === 0 ? pat0.slice() : new Array(P.rhythm.steps).fill(0)));
      }
      if (L1.euclidKit) {
        let pat = null;
        try { pat = (typeof _ambEuclidViewPat === 'function') ? _ambEuclidViewPat(L1) : null; } catch (e) {}
        if (!pat && Array.isArray(L1.euclidPattern)) pat = L1.euclidPattern;
        if (Array.isArray(pat)) {
          const st = P.rhythm.steps;
          P.rhythm.lanes = Array.from({ length: _V2_LANES }, (_, li) => {
            const row = Array.isArray(pat[li]) ? pat[li] : [];
            return Array.from({ length: st }, (_, i) => (row[i % Math.max(1, row.length)] ? 1 : 0));
          });
        }
      }
    } else if (eff === 'bass') {
      P.rhythm = euclid();
      P.pitch = { kind: 'fixed', degree: 1 };
    } else if (eff === 'arp') {
      // A series arp sweeps the chord — that IS `series`, and v1 even states the
      // direction the same way.
      P.rhythm = { kind: 'pulse', n: clamp((Array.isArray(L1.steps) ? L1.steps.length : (L1.steps | 0)) || 4, 1, 64) };
      P.pitch = { kind: 'series', degree: 1, dir: (L1.dir === 'down' || L1.dir === 'updown') ? L1.dir : 'up' };
    } else if (eff === 'bed' || eff === 'drone') {
      P.rhythm = { kind: 'pulse', n: 1 };
      P.pitch = { kind: 'chord', voices: clamp((L1.density | 0) || 3, 1, 9) };
    } else if (eff === 'pedal') {
      P.rhythm = { kind: 'pulse', n: 1 };
      P.pitch = { kind: 'anchor' };
    } else if (eff === 'texture') {
      P.rhythm = { kind: 'chance', steps: 16, chance: clamp((L1.fill | 0) || 40, 0, 100) };
      P.pitch = { kind: 'chord', voices: 1 };
    } else {
      // motif / run / riff — a melodic LINE that wanders round a register.
      P.rhythm = { kind: 'pulse', n: clamp((L1.density | 0) || 4, 1, 64) };
      P.pitch = { kind: 'walk', degree: 1, span: clamp((L1.range | 0) || 4, 1, 24) };
    }
    P.shape = { lenRatio: 90 };
    if (Number.isFinite(L1.lengthMs) && L1.lengthMs > 0) {
      let bpm = 120; try { bpm = _ambBpm(); } catch (e) {}
      const onsets = (P.rhythm.kind === 'euclid') ? Math.max(1, P.rhythm.pulses) : Math.max(1, P.rhythm.n || 1);
      const spanMs = (bars * (60 / Math.max(20, bpm)) * 4 * 1000) / onsets;
      if (spanMs > 0) P.shape.lenRatio = clamp(Math.round((L1.lengthMs / spanMs) * 100), 1, 400);
    }
    if (opts && opts.specOnly) return spec;
    const L2 = addLayer(cfg, spec);
    if (!L2) return null;
    _V2_TREATMENTS.forEach((k) => {
      if (L1[k] === undefined) return;
      try { L2[k] = (L1[k] && typeof L1[k] === 'object') ? JSON.parse(JSON.stringify(L1[k])) : L1[k]; } catch (e) {}
    });
    L2.from = key;                                     // provenance, display only
    try { E.getCfg(); } catch (e) {}
    return L2;
  }

  // Extracted from the API object so model-half code (the v1 import) can call it
  // — an object METHOD is not reachable from a sibling function.
  function addLayer(cfg, spec) {
    if (!cfg) return null;
    if (!Array.isArray(cfg.layers)) cfg.layers = [];
    const id = cfg.layers.reduce((m, x) => Math.max(m, (x && x.id) | 0), 0) + 1;
    const L = normLayer(Object.assign({ id }, spec || {}), cfg.layers.length);
    cfg.layers.push(L);
    return L;
  }

  // Render every line that is not already in the bank. Awaited by the caller so
  // it can report progress; RENDERING HAPPENS WHILE STOPPED by convention — the
  // card's button is the only caller and it says so.
  // ── ARTICLE FETCHING ────────────────────────────────────────────────────
  // The LAST v1 capability v2 lacked. `_ambLearnFetch(sourceId, term, corpus,
  // wantChars)` is not layer-shaped — plain arguments in, `{title, text, url}`
  // out — so v2 calls it directly and stores the result as its own `text`. The
  // source list and the Amount table are v1's, read by id, so the two can never
  // offer different sources or different budgets.
  async function fetchArticleFn(E, L) {
    if (!L || typeof _ambLearnFetch !== 'function') return null;
    const src = (typeof L.source === 'string' && L.source) ? L.source : 'wiki-random';
    if (src === 'paste') return null;                    // no network at all
    let want = 6000;
    try { if (typeof _ambAmount === 'function') want = _ambAmount(L)[2] || 6000; } catch (e) {}
    let got = null;
    try { got = await _ambLearnFetch(src, L.term || '', L.corpus || '', want); } catch (e) { got = null; }
    if (!got || !got.text) return null;
    L.instrument.text = String(got.text || '');
    L.article = String(got.title || '');
    // The rendered bank is keyed on voice+TEXT, so old lines simply stop being
    // asked for — nothing to invalidate, and re-fetching the same article costs
    // no re-synthesis.
    try { E.getCfg(); } catch (e) {}
    return { title: L.article, chars: L.instrument.text.length, lines: speechLines(L).length };
  }

  async function speechWriteFn(E, L, onProgress) {
    const lines = speechLines(L);
    const bank = speechBank(E);
    if (!bank || !lines.length) return 0;
    // VOICE FROM — device / server / auto. `_ambLearnSynth(text, voice)` takes
    // no layer, so the routing does NOT live there: it is in `_ambLearnWarmUp`,
    // which reads `_ambVoiceFrom(L)` and decides whether to probe the server at
    // all before any model is downloaded. Calling it first is what makes the
    // setting mean anything here; awaiting its probe is what stops the first
    // line racing ahead of the decision (v1's own documented trap — the pump
    // asked for line 0 within a second and beat the ping).
    try {
      if (typeof _ambLearnWarmUp === 'function') {
        _ambLearnWarmUp(E, { voiceFrom: L.voiceFrom, id: L.id, instrument: L.instrument });
        if (typeof _ambServerProbe !== 'undefined' && _ambServerProbe && typeof _ambServerProbe.then === 'function') {
          await _ambServerProbe.catch(() => {});
        }
      }
    } catch (e) {}
    let done = 0;
    for (let i = 0; i < lines.length; i++) {
      const k = speechKey(L, lines[i]);
      if (bank.has(k)) { done++; if (onProgress) onProgress(done, lines.length); continue; }
      let buf = null;
      try { buf = await _ambLearnSynth(lines[i], L.instrument.speechVoice || undefined); } catch (e) {}
      if (buf) bank.set(k, buf);
      done++;
      if (onProgress) onProgress(done, lines.length);
    }
    return done;
  }
  // How many of this layer's lines are ready — what the card reports, and the
  // only honest thing to say before a render.
  function speechStatFn(E, L) {
    const lines = speechLines(L), bank = speechBank(E);
    let have = 0;
    if (bank) lines.forEach(x => { if (bank.has(speechKey(L, x))) have++; });
    return { lines: lines.length, ready: have };
  }

  function releaseFn(E, L) {
    if (!L || L.part.kind !== 'recorded') return false;
    L.part.kind = 'live';                                // the live spec was never discarded
    try { E.getCfg(); } catch (e) {}
    try { if (E._v2Phase) delete E._v2Phase['v2:' + L.id]; } catch (e) {}
    return true;
  }

  // ONE definition of a cycle's length — the emitter and the preview both ask
  // this, and two copies of the calc is how the two would come to disagree.
  // SPEED is v1's own rate MULTIPLIER (`_ambRateMult` — absent or 1 is an
  // exact FP identity); it scales the cycle rather than the note rate, which
  // is what "play this part half as fast" means when the part IS the cycle.
  function cycSecOf(L, cfg) {
    let mult = 1;
    try { if (typeof _ambRateMult === 'function') mult = _ambRateMult(L) || 1; } catch (e) {}
    return ((L.part.clock === 'free') ? Math.max(0.05, (L.part.ms || 2000) / 1000)
                                      : Math.max(0.05, L.part.bars * barSec(cfg))) / mult;
  }

  // ── THE EMITTER ─────────────────────────────────────────────────────────
  // Window in, notes out — the same contract as every v1 emitter, so all the
  // machinery downstream of playNote applies untouched.
  function emit(E, L, key, now, horizon, lead, space, cfg) {
    // A FREEZE OUTRANKS THE LIVE PIPELINE — v1's own precedence ("Recorded
    // takes precedence over Live by definition"). The only thing that installs
    // a freeze on a v2 key is the ▦ Passes phrase mapping (`_ambPartSeqSync`
    // sweeps cfg.layers now); v2's own Recorded parts are `part.kind`, not a
    // freeze, so an unmapped layer never takes this branch. `_ambFreezeGate`
    // replays the installed phrase and returns true = handled.
    try {
      if (typeof _ambFreezeGate === 'function' && _ambFreezeGate(E, key, now, horizon)) return;
    } catch (e) {}
    // FREE means the layer keeps its OWN interval and does not follow the bar
    // grid — which is the whole point, so it must not be snapped to it below.
    const free = L.part.clock === 'free';
    // SPEED is v1's own rate MULTIPLIER (`_ambRateMult` — absent or 1 is an
    // exact FP identity, so an untouched layer is byte-identical). It scales
    // the cycle rather than the note rate, which is what "play this part half
    // as fast" means when the part IS the cycle.
    const cyc = cycSecOf(L, cfg);
    if (!E._v2Phase) E._v2Phase = {};
    let st = E._v2Phase[key];
    if (!st) {
      // anchor on the SHARED grid every synced layer uses, never a private lead
      let s0 = Number.isFinite(E._barGridAnchor) ? E._barGridAnchor : lead;
      // A FREE layer anchors where it starts and runs on its own clock; snapping
      // it to the shared grid would make it synced by another name.
      if (!free) { try { if (typeof _ambUnitGridSnap === 'function') s0 = _ambUnitGridSnap(E, key, L, cfg, s0); } catch (e) {} }
      st = E._v2Phase[key] = { startAt: s0, lastAt: null };
    }
    const from = Math.max(now, (st.lastAt != null) ? st.lastAt : st.startAt);
    const to = horizon;
    if (to <= from) return;

    const dest = (typeof _ambLayerDest === 'function') ? _ambLayerDest(key) : undefined;
    // STAGING, not the fader. Level is a CONTINUOUS gain on the chain
    // (`e.levelGain`, written by `_ambUpdateMod`), so it sweeps the whole layer
    // including notes already sounding; a per-note volume only affects NEW
    // notes and could never do that (the documented reason v1 stopped applying
    // level per note). The note carries the layer's staging instead.
    const lvl = _AMB_V2_STAGE;
    let c = Math.floor((from - st.startAt) / cyc);
    if (!Number.isFinite(c)) return;
    // THE CYCLE GRID. Uniform for an ordinary layer (`startAt + c * cyc`,
    // exactly as before); the PART PASSES for a per-part one, whose record is
    // that part's length. Walking windows rather than indices is what lets the
    // second kind have cycles of different lengths at all.
    let cur = cycleWindowAt(L, E, cfg, Math.max(from, st.startAt), st);
    for (let guard = 0; guard < 64; guard++) {
      const cs = cur.cs, cw = cur.cyc, ci = cur.idx, cpi = cur.pi;
      const next = () => {
        const nx = cycleWindowAt(L, E, cfg, cs + cw + 1e-3, st);
        // never stand still: a window that does not advance would spin the loop
        cur = (nx && nx.cs > cs + 1e-6) ? nx : { cs: cs + cw, cyc: cw, idx: ci + 1, part: cur.part };
      };
      if (cs >= to) break;
      if (cs + cw <= from - 1e-6) { next(); continue; }
      // WHEN — which ITERATIONS this layer plays. Emitter-side in v1
      // (`_ambCondFires`), so v2 has to ask; it is not one of the playNote-hook
      // gates. The cycle index is what it wants — the lattice index for an
      // ordinary layer, the PASS number for a per-part one (which is what "this
      // iteration" means once the part is the cycle).
      let fires = true;
      try { if (typeof _ambCondFires === 'function') fires = _ambCondFires(L.when, ci, cs); } catch (e) {}
      if (!fires) { next(); continue; }
      let notes = [];
      try { notes = notesFor(L, { E, cfg, key, cycleStart: cs, cycleSec: cw, pi: cpi }); } catch (e) { break; }
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (!(n.at >= from - 1e-6 && n.at < to)) continue;
        if (!(n.freq > 0)) continue;
        // CHORD MASK — how often this layer plays THIS chord. Also emitter-side
        // in v1, and per NOTE rather than per cycle because a cycle can span
        // several chords.
        try { if (typeof _ambChordGateOK === 'function' && !_ambChordGateOK(E, L, n.at, cfg, null)) continue; } catch (e) {}
        // SECTION MASK — the ⇶ Blocks rows. The matrices have listed v2 layers
        // since the campaign, so this store was EDITABLE and unread — the
        // documented stored-but-ignored failure, closed from the read side.
        try { if (typeof _ambSectionGateOK === 'function' && !_ambSectionGateOK(E, L, n.at, cfg, null)) continue; } catch (e) {}
        // A KIT HAS TWO REALIZATIONS and they take DIFFERENT PLAYERS — the
        // documented "audit the whole family" rule: a synth kit is a recipe
        // played by `_ambPlaySynthDrum` (which builds its own params and takes a
        // LANE INDEX), a sample kit is an ordinary note on `sample:<id>`. Fixing
        // one arm and leaving the other is how a v1 hang burst went silent.
        // SPEECH — play the rendered line, or NOTHING. Never synthesise here:
        // rendering is seconds of inference and the tick is 150 ms, so a layer
        // that rendered on demand would stall playback (v1's documented
        // "nothing loads during playback" rule). An unrendered line is silent
        // and the card says how many are still to write.
        if (L.instrument.voice === 'speech' && Number.isFinite(n.line)) {
          const bank = speechBank(E), lines = speechLines(L);
          const txt = lines[n.line];
          // WORDS AS NOTES — the alphabet translator, through v1's own
          // `_ambEmitWordPassage`. 'speak' (absent) is unchanged; 'play' makes
          // the layer purely instrumental and needs NO rendered audio at all,
          // which is also what makes a speech layer usable with no voice
          // available; 'both' does the two at the same instant.
          const wo = L.wordOut;
          if ((wo === 'play' || wo === 'both') && txt && typeof _ambEmitWordPassage === 'function') {
            try { withKeyTime(n.at, () => _ambEmitWordPassage(E, key, wordShim(L), txt, n.at)); } catch (e) {}
          }
          if (wo !== 'play') {
            const buf = bank && bank.get(speechKey(L, txt));
            if (buf) { try { _ambLearnPlay(E, key, L, buf, n.at, n.line); } catch (e) {} }
          }
          continue;
        }
        // GROOVE, via v1's own helpers — which is the point: `_ambSwingSec` and
        // `_ambAccentVol` each FOLD IN the Area Groove macro on top of the
        // layer's value, so wiring these does not just add three knobs, it
        // connects v2 to the area groove for the first time (a v2 layer felt no
        // swing and no accent at all, however the Groove panel was set).
        // Swing delays every ODD slot of the layer's own grid, which is what
        // makes it shuffle rather than merely shift.
        let at = n.at;
        try {
          if (typeof _ambSwingSec === 'function') {
            const steps = Math.max(1, (L.part.rhythm && L.part.rhythm.steps) || 16);
            const slotSec = cyc / steps;
            const slot = Math.round((n.at - cs) / slotSec);
            if (slot % 2 === 1) at += _ambSwingSec(L, slotSec);
          }
        } catch (e) {}
        let vol = n.ghost ? Math.max(1, Math.round(lvl * 0.42)) : lvl;
        // A HAND-EDITED NOTE'S OWN VOLUME, as a percentage of the layer's level
        // — applied BEFORE accent and velVar so those still shape it, exactly
        // as they shape every other note.
        if (Number.isFinite(n.vel)) vol = Math.max(1, Math.round(vol * (n.vel | 0) / 100));
        // The ARRIVAL of a gesture is leaned on — v1's agogic emphasis, x1.15.
        if (n.arr) vol = Math.min(127, Math.round(vol * 1.15));
        // ACCENT draws from the SHARED seeded stream exactly as v1 does, and
        // only when non-zero — so a layer with no accent and a neutral groove
        // consumes no draw and shifts nothing downstream.
        try {
          if (typeof _ambAccentVol === 'function') vol = _ambAccentVol(vol, (L.accent | 0) || 0);
        } catch (e) {}
        if (L.instrument.voice === 'kit' && Number.isFinite(n.lane)) {
          if (L.instrument.kit === 'synth') {
            try { _ambPlaySynthDrum(E, dest, L, n.lane, at, vol, null, 0, 0); } catch (e) {}
          } else {
            try {
              playNote(n.freq, { type: 'sample:' + L.instrument.kit, volume: vol },
                n.durMs, at, dest, undefined, E.laneIdx ? E.laneIdx() : undefined);
            } catch (e) {}
          }
          continue;
        }
        // A SCHEDULED TONE is resolved per NOTE, at the note's own time — the
        // whole point is that it changes mid-layer, so a tone read once per tick
        // would land on bar boundaries a lookahead early.
        let ty = toneOf(L);
        if (L.toneSeq && L.toneSeq.on && typeof _ambToneAt === 'function') {
          try {
            const t2 = _ambToneAt({ toneSeq: L.toneSeq, tone: L.instrument.tone }, at);
            if (typeof t2 === 'string' && t2) ty = t2;
            else if (t2 === '') ty = toneOf(L);
          } catch (e) {}
        }
        let params = { type: ty, volume: vol };
        // ONE call for the whole Performance/Variance family. The envelope is
        // applied here too (from the shim), so v2 does not set it twice.
        try { if (typeof _ambApplyAdsr === 'function') params = withKeyTime(at, () => _ambApplyAdsr(params, adsrShim(L))) || params; }
        catch (e) {
          params.attack = L.instrument.attack; params.decay = L.instrument.decay;
          params.sustain = L.instrument.sustain; params.release = L.instrument.release;
        }
        // SLIDE — v1's own rule: a glide only on a LEAP (3 or more source
        // tones), and only some of the time. Needs the previous degree, which
        // is why the note carries one. Absent or 0 spends no draw.
        if ((L.slide | 0) > 0 && Number.isFinite(n.deg) && typeof _ambSlideMs === 'function') {
          try {
            const prev = st._slideDeg;
            if (Number.isFinite(prev)) {
              const sms = _ambSlideMs({ slide: L.slide | 0 }, prev, n.deg,
                () => vRnd((L.id | 0) ^ Math.round(at * 1000), 71));
              if (sms) { params.glideMs = Math.max(params.glideMs || 0, sms); params.glideLayer = adsrShim(L); }
            }
            st._slideDeg = n.deg;
          } catch (e) {}
        } else if (Number.isFinite(n.deg)) { st._slideDeg = n.deg; }
        // MOTION — v1's rule: a seeded detune offset of up to ±18 cents × the
        // amount, ADDED to whatever `fine` already put there (v1's own warning:
        // both write `params.detune`, so this must add rather than replace).
        if ((L.motion | 0) > 0) {
          const m3 = clamp(L.motion | 0, 0, 100) / 100;
          const d3 = Math.round((vRnd((L.id | 0) ^ Math.round(at * 1000), 103) * 2 - 1) * 18 * m3);
          params.detune = (Number.isFinite(params.detune) ? params.detune : 0) + d3;
        }
        // A HAND-EDITED NOTE'S OWN ENVELOPE AND GLIDE. After `_ambApplyAdsr`,
        // because the point is to override what the layer would have done for
        // THIS note; each field is independent, so a note can state only its
        // release and inherit the rest. Glide takes the LARGER of its own value
        // and whatever Slide asked for, so the two cannot silently cancel.
        if (Number.isFinite(n.atk)) params.attack = n.atk | 0;
        if (Number.isFinite(n.dec)) params.decay = n.dec | 0;
        if (Number.isFinite(n.sus)) params.sustain = n.sus | 0;
        if (Number.isFinite(n.rel)) params.release = n.rel | 0;
        if (Number.isFinite(n.glide) && n.glide > 0) {
          params.glideMs = Math.max(params.glideMs || 0, n.glide | 0);
          params.glideLayer = adsrShim(L);
        }
        // TIGHT clamps the release so a note stops out of the way of the next
        // one — v1's own `_ambTightChoke`, applied AFTER the envelope is built.
        try { if (typeof _ambTightOn === 'function' && _ambTightOn(L) && typeof _ambTightChoke === 'function') params = _ambTightChoke(params) || params; } catch (e) {}
        // ORNAMENT — grace-note flicks to the neighbour degrees, emitted by
        // v1's own `_ambOrnamentFlicks` (which plays them itself, so it needs
        // the dest and the built params). Seeded per onset, so the figure
        // replays for a take rather than fluttering differently every pass.
        if ((L.ornament | 0) > 0 && Number.isFinite(n.deg) && typeof _ambOrnamentFlicks === 'function') {
          try {
            const src3 = (typeof _ambNotesOf === 'function') ? _ambNotesOf(L) : null;
            if (src3) {
              withKeyTime(at, () => _ambOrnamentFlicks(
                { ornament: L.ornament | 0 }, src3, n.deg, n.oct | 0, at, params, n.durMs, dest,
                E.laneIdx ? E.laneIdx() : undefined,
                () => vRnd((L.id | 0) ^ Math.round(at * 1000), 83)));
            }
          } catch (e) {}
        }
        try { playNote(n.freq, params, n.durMs, at, dest, undefined, E.laneIdx ? E.laneIdx() : undefined); }
        catch (e) {}
      }
      next();   // …to the window after this one
    }
    st.lastAt = to;
  }

  // ── TICK ────────────────────────────────────────────────────────────────
  // Called from _ambTick once per tick. Installs the SAME capture sink the v1
  // window branch does — that is what stamps `_ambEmitKey` inside playNote, so
  // the gates, Write capture and per-layer routing all see a v2 note exactly as
  // they see a v1 one.
  // WHICH WINDOW IS ONE CYCLE, at a given moment. For an ordinary layer that is
  // the uniform lattice off its phase anchor. For a PER-PART layer it is the
  // PART PASS: its record is reconciled to that part's length on every
  // normalize, so laying it over the EDITED record's cycle stretched it —
  // measured, part B (4 bars) played over 5 bars because part A was selected,
  // which is the "what a part plays depends on which part is selected" wart the
  // ice model exists to remove. Reported as "the visualization is not resized
  // by part". ONE definition, three consumers: the tick, the drawing and the
  // playhead — two walks of one grid is how they come to disagree.
  function cycleWindowAt(L, E, cfg, at, st) {
    const cyc0 = Math.max(0.05, cycSecOf(L, cfg));
    const perPart = !!(L && Number.isFinite(L.partFor) && (L.parts || L.partAll));
    if (perPart && typeof _ambPassSpanAt === 'function' && cfg && cfg.prog && cfg.prog.on) {
      try {
        const sp = _ambPassSpanAt(E, cfg, at);
        if (sp && sp.to > sp.from + 0.02) {
          let idx = 0, pi = -1;
          try {
            const w = _ambPartChordAt(E, cfg, at);
            // …AND WHICH PART, CARRIED OUT. `at` is a real moment INSIDE this
            // window, so this is the honest answer; re-deriving it later from
            // the returned `cs` is not, because that value is SNAPPED and the
            // snap can land ONE ULP BELOW the boundary it reconstructs
            // (measured: cs 4.06 against a boundary at 4.06 + 4.4e-16, whether
            // it bites depending on the cold-start anchor). Every consumer
            // that asked `_ambPartChordAt(cs)` then got the PREVIOUS part for
            // the whole pass — the drawing showed the other part's record, in
            // the other part's colour, so notes drawn into part 1 appeared
            // under part 2 and were missing when part 1 came round again.
            // Reported as "the events I drew were gone". One resolver, one
            // answer, handed back: two walks of one grid is how they disagree.
            if (w) { idx = (w.pass | 0); if (Number.isFinite(w.pi)) pi = w.pi | 0; }
          } catch (e) {}
          // THE SPAN IS BISECTED AND CARRIES FLOAT NOISE PER QUERY (the
          // documented _ambChordSpanAt property): two calls ~16ms apart came
          // back with starts ~10ms apart, so the rAF's once-per-cycle redraw
          // check and the drawing's own anchor disagreed EVERY frame — the
          // canvas redrew 30-57x/s ("notes are flashing"). Snap both edges to
          // the 1/48-bar grid on the chord clock's own anchor (the
          // _ambSnapBars idiom, in absolute time) so every consumer of this
          // window computes the SAME cs whatever instant it asked at.
          const aA = Number.isFinite(E && E._progAnchor) ? E._progAnchor
            : (Number.isFinite(E && E._playStartAt) ? E._playStartAt : 0);
          const gS = barSec(cfg) / 48;
          const s2 = aA + Math.round((sp.from - aA) / gS) * gS;
          const e2 = aA + Math.round((sp.to - aA) / gS) * gS;
          // …AND HOW MANY BARS IT IS. A pass IS a bar span of the arrangement,
          // and the DRAWING has to say so — it lives in the other IIFE, where
          // `barSec` is not defined (the two-IIFE trap: a bare call there
          // throws into the caller's catch and the ruler silently keeps the
          // edited record's length, which is the bug this fixes).
          const bsec = barSec(cfg);
          if (e2 > s2 + 0.02) return { cs: s2, cyc: e2 - s2, idx: idx, pi: pi, part: true, bars: (e2 - s2) / bsec };
          return { cs: sp.from, cyc: sp.to - sp.from, idx: idx, pi: pi, part: true, bars: (sp.to - sp.from) / bsec };
        }
      } catch (e) {}
    }
    const s0 = (st && Number.isFinite(st.startAt)) ? st.startAt : 0;
    const c = Math.floor((at - s0) / cyc0);
    return { cs: s0 + c * cyc0, cyc: cyc0, idx: c, pi: -1, part: false };
  }
  window._v2Tick = function (E, now, horizon, lead, space, cfg) {
    const list = layersOf(cfg);
    if (!list.length) return;
    let anySolo = false;
    try { if (typeof _ambComputeAnySolo === 'function') anySolo = _ambComputeAnySolo(cfg); } catch (x) {}
    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      if (L.present === false || L.on === false) continue;
      const key = 'v2:' + L.id;
      // THE GRID OWNS WHAT A COMPOSING LAYER PLAYS — "what you draw is what you
      // hear". Without this the part keeps emitting underneath the scratch lane
      // and you audition two things at once.
      try { if (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit && _bloomGridEdit.key === key) continue; } catch (e) {}
      // SOLO is answered by v1's `_ambComputeAnySolo`, which now counts v2
      // layers too — so one solo state governs the whole mix rather than each
      // model having its own idea of who is playing.
      if (anySolo && !L.solo) continue;
      try {
        if (typeof _ambCapSink === 'function') window._ambCaptureSink = _ambCapSink(E, key);
        emit(E, L, key, now, horizon, lead, space, cfg);
      } catch (e) {
        try { console.warn('[v2] emit failed', e && e.message); } catch (x) {}
      } finally {
        window._ambCaptureSink = null;
        try { if (typeof _ambPruneCap === 'function') _ambPruneCap(E, key, now); } catch (x) {}
      }
    }
  };

  // ── PREVIEW ─────────────────────────────────────────────────────────────
  // One cycle of the layer, through the REAL emitter and the layer's own
  // chain — so tone, envelope, groove, chain FX, EQ and level all speak (the
  // hang-audition rule: an audition must run the exact emit path). Two
  // deliberate differences from a tick: NO capture sink is installed, so
  // nothing is baked into a Write loop and `_ambEmitKey` stays null — which is
  // also what keeps the playback gates and the chord choke (both scoped on the
  // emit key) away from notes scheduled against STOPPED clocks, the documented
  // audition trap. Pitch echo and Spatialize live in that sink, so a preview
  // does not carry them; everything on the chain does.
  const PV_MAX_SEC = 8;
  // KILL a layer's preview audio, click-free: dip the chain gate (a raw voice
  // stop can click — rule 3), cancel everything not yet sounding, stop
  // everything that is, reopen the gate a beat later. Called on an explicit
  // stop AND unconditionally before every start — which is what makes
  // stacking impossible by construction: a re-press (the natural reaction to
  // a slow first press) replaces the preview instead of piling on it.
  // WHAT IS SOUNDING, tracked rather than guessed — see `previewing()`.
  let PV = null;
  // WHICH CYCLE THE PREVIEW PLAYED. A LIVE part re-rolls every cycle (the seeded
  // draws key on the cycle), so "draw the part" has no single answer — and the
  // drawing showed cycle 0 while the preview played whichever cycle the clock
  // landed on, so every press sounded different against a picture that never
  // moved. Reported exactly that way. The picture follows the SOUND now: the
  // preview records the cycle start it used and the drawing renders that one.
  // Module state, never a field on the layer — `persistWorkspace` serialises
  // underscore fields, so a `_viz` on the layer would be saved (the documented
  // `_soloLane` trap).
  let PV_VIZ = null;
  // A COMPACT part signature: enough to know the part MOVED, cheap enough to
  // take on every draw. If it changed, the remembered cycle is stale and the
  // drawing falls back to a representative one.
  function partSigFn(L) {
    const p = L && L.part; if (!p) return '';
    const r = p.rhythm || {}, t = p.pitch || {}, sh = p.shape || {};
    return [p.kind, p.bars, p.clock || '', p.ms || 0,
            r.kind, r.steps, r.pulses, r.rotate, r.n, r.chance, r.vary,
            t.kind, t.degree, t.span, t.voices, t.dir, t.octaves,
            (t.harm || []).map(h => h && h.deg).join('/'),
            sh.lenRatio, sh.holdSteps, (p.notes || []).length].join(',');
  }
  // KILL a layer's preview audio, click-free: dip the chain gate (a raw voice
  // stop can click — rule 3), cancel everything not yet sounding, stop
  // everything that is. Called on an explicit stop AND unconditionally before
  // every start, which is what makes stacking impossible by construction.
  function previewKill(E, L) {
    return previewKillKey(E, 'v2:' + L.id);
  }
  function previewKillKey(E, key) {
    const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    if (PV && PV.key === key) PV = null;
    const e = E.mod && E.mod[key];
    // BACK TO THE SIMPLE DIP, deliberately. This grew a remembered pre-dip
    // value, a clearing timer and a reopen time computed from the preview's
    // own length (up to 12 s) — chasing a stop that measured 87 ms down to
    // 66 ms. That is not worth a gate that can be left shut: every one of
    // those pieces is a way for the layer to end up muted with nothing to
    // reopen it, which is what "preview stopped playing after 2 or 3 presses"
    // is. What actually silences a stop is the cancel and the voice stop
    // below; the dip only covers the click. Two scheduled events, no state
    // that can outlive them, and the layer is always audible again 85 ms later.
    try {
      const g = e && e.gate && e.gate.gain;
      if (g) {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, 0.006);
        g.setTargetAtTime(1, now + 0.07, 0.015);
      }
    } catch (x) {}
    try { if (typeof cancelBloomFutureVoices === 'function') cancelBloomFutureVoices(key, now); } catch (x) {}
    try { if (typeof stopBloomVoicesBefore === 'function') stopBloomVoicesBefore(key, now + 30); } catch (x) {}
  }
  let PV_RESUME = false;   // one pending resume-then-play, never a queue of them
  function previewLayer(E, L) {
    const key = 'v2:' + L.id;
    const cfg = E.getCfg(); if (!cfg) return 0;
    // A SUSPENDED context freezes the clock, so notes scheduled before the
    // resume settles anchor in the past and drop (the documented cold-start
    // trap). Resume first, schedule after.
    try {
      if (typeof Tone !== 'undefined' && Tone.getContext().rawContext.state !== 'running') {
        // pressing again while the resume is pending must not QUEUE another
        // schedule — that was one of the ways presses stacked
        if (!PV_RESUME) {
          PV_RESUME = true;
          Tone.start().then(() => { PV_RESUME = false; try { previewLayer(E, L); } catch (e) {} },
                            () => { PV_RESUME = false; });
        }
        return 0;
      }
    } catch (e) {}
    // ANOTHER LAYER'S preview is still sounding — kill it too, or previewing a
    // second layer leaves the first one running underneath (the old code reset
    // its LABEL and never touched its audio).
    if (PV && PV.key !== key) { try { previewKillKey(E, PV.key); } catch (e) {} }
    previewKill(E, L);
    // The chain must exist for `_ambLayerDest` to route into — but ONLY build
    // it when it is missing. `_ambSyncMods` walks every layer (21.5 ms
    // measured) and rebuilds chains, and rebuilding a chain whose tail is
    // still ringing pops (the documented shared-chain rule) — which a
    // re-press does every time.
    // UNCONDITIONALLY. Making this conditional on a missing chain saved 21 ms
    // and risked silence for it: the first preview after adding a layer measured
    // PEAK 0, because "the chain exists" is not the same as "the chain is
    // current" — a bus change, an FX change or a teardown elsewhere leaves a
    // stale one. Rebuilding here is also safe by construction rather than by
    // luck: `previewKill` above has just dipped this layer's gate, so this is
    // mute → change the graph → unmute, which is exactly the protocol
    // `_ambReconfigSharedQuiet` exists to describe.
    try { if (typeof _ambSyncMods === 'function') _ambSyncMods(); } catch (e) {}
    const t0 = ((typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0) + 0.12;
    const sec = Math.min(cycSecOf(L, cfg), PV_MAX_SEC);
    // THE FIRST NOTE LANDS ON THE PRESS, not the cycle's first pulse. Anchoring
    // the CYCLE at t0 means a part whose pattern starts on step 2 of 8 opens
    // with two empty steps — measured 1193 ms of silence after the press on a
    // default euclid layer, which is the reported lag. `notesFor` is the part
    // INTERFACE, so asking it where the first note falls costs one pure call
    // and works for every part kind (live, recorded, drawn, speech). The
    // offset is anchor-INDEPENDENT (verified: identical at five different
    // cycle starts), so one probe places it exactly.
    let off = 0;
    try {
      const probe = withEdit(() => withTake(pinOf(L), () => notesFor(L, { E, cfg, key, cycleStart: t0, cycleSec: sec })));
      let m = Infinity;
      for (let i = 0; i < probe.length; i++) {
        const n = probe[i];
        if (n && n.freq > 0 && n.at < m) m = n.at;
      }
      if (Number.isFinite(m) && m > t0) off = Math.min(m - t0, sec);
    } catch (e) {}
    PV_VIZ = { id: L.id | 0, at: t0 - off, sig: partSigFn(L), take: pinSig(pinOf(L)) };
    if (!E._v2Phase) E._v2Phase = {};
    const saved = E._v2Phase[key];
    // a pre-made phase state pins the anchor to NOW and skips the grid snap —
    // a stale `_barGridAnchor` from the last play would land the notes in the
    // past (the frozen-restore lesson, one store over)
    E._v2Phase[key] = { startAt: t0 - off, lastAt: null };
    // A MAPPED-PHRASE FREEZE is parked for the preview's duration: replaying
    // it here would advance its `scheduledUpto` against preview time and
    // desync the next real play — the state-leak class this function exists
    // to avoid. The preview plays the LIVE pipeline; the mapping still owns
    // playback.
    const savedFs = E.freeze && E.freeze[key];
    if (savedFs) delete E.freeze[key];
    let n = 0, endAt = 0;
    const orig = (typeof playNote === 'function') ? playNote : null;
    // THE MARKER SINK — the first build installed NO sink, and the preview was
    // SILENT with core strips on: a v2 note's emit key is stamped BY the
    // capture sink, and an unkeyed core post lands in no strip slot (the
    // documented worklet-keying trap — measured: 9 playNote calls, master tap
    // 0.000, while the "verified audible" reading had exactly equalled its own
    // positive control, the tell). This sink stamps the key and captures
    // NOTHING — no bake, no pecho, no spat, which stays the stated caveat.
    const sv = {
      sink: window._ambCaptureSink, ek: window._ambEmitKey, ea: window._ambEmitAt,
      he: window._ambHangEmitting, cut: window._ambEmitCutoff,
      pa: E._progAnchor, ps: E._playStartAt, bg: E._barGridAnchor,
    };
    try {
      // count what actually reaches playNote — the return value is the gate's
      // evidence, and "fired" from the emitter's own bookkeeping is not it
      if (orig) window.playNote = function (f, params, dur, at) {
        n++;
        // WHEN THE AUDIO REALLY ENDS. The button used to reset itself on a
        // GUESS (cycleSec + 600 ms), which expired 741 ms before the last note
        // finished — so the "stop" press landed on a button that had already
        // flipped back to Preview and RESTARTED instead (the reported "it keeps
        // playing after stop"). A note's own end is not a guess.
        const a = +at || 0, d = (+dur || 0) / 1000;
        if (a + d > endAt) endAt = a + d;
        return orig.apply(this, arguments);
      };
      window._ambCaptureSink = function (freq, params, dur, at) {
        window._ambEmitKey = key; window._ambEmitAt = at;
      };
      // KEYED notes now meet the playNote gates, which resolve against the
      // engine clocks — NULL while stopped, which is the hang-audition trap
      // (the choke clamps every note to a stub against a stopped clock). Pin
      // the clocks to preview time so the gates and the choke behave exactly
      // as they would in playback; a stale cutoff from the last play would
      // silently drop everything, so it is parked too. The hang gate is stood
      // down for the burst-flag reason: preview notes are an audition, not
      // arrangement content.
      // PIN THE CHANGES TO THE PRESS while the transport is stopped. It used
      // to pin only when there was no bar grid at all, so after any play the
      // STALE anchor stood and each press resolved a different point in the
      // progression — for a part whose content IS the changes (Groundwork, or
      // any chord rule) that redraws the whole picture every press, reported
      // as "Preview keeps making a new part". Pinned, a preview always plays
      // the changes from the top, which is repeatable and is what the drawing
      // then shows. Restored in the `finally` like every other clock here.
      if (!E.timer || !Number.isFinite(E._barGridAnchor)) {
        E._progAnchor = t0; E._playStartAt = t0; E._barGridAnchor = t0;
      }
      window._ambEmitCutoff = null;
      window._ambHangEmitting = true;
      // PINNED FOR THE WHOLE EMIT — `emit` calls `notesFor` itself, so the pin
      // has to be in force around it rather than passed as an argument. This is
      // what makes a second press play what the first one played.
      TAKE_PIN = pinOf(L);
      EDIT_PIN = true;
      emit(E, L, key, t0 - 0.05, t0 + sec + 0.01, 0.12, 0, cfg);
    } catch (e) {
    } finally {
      TAKE_PIN = null;
      EDIT_PIN = false;
      if (orig) window.playNote = orig;
      window._ambCaptureSink = sv.sink; window._ambEmitKey = sv.ek; window._ambEmitAt = sv.ea;
      window._ambHangEmitting = sv.he; window._ambEmitCutoff = sv.cut;
      E._progAnchor = sv.pa; E._playStartAt = sv.ps; E._barGridAnchor = sv.bg;
      if (saved) E._v2Phase[key] = saved; else delete E._v2Phase[key];
      if (savedFs) { if (!E.freeze) E.freeze = {}; E.freeze[key] = savedFs; }
    }
    // PV_TAIL covers what a note's `dur` does not: the voice's own release and
    // the reverb, which taps PRE-gate and rings on. Overshooting is harmless
    // (a press just stops something already quiet); undershooting is the bug
    // this replaced, so it is deliberately generous.
    if (n) PV = { id: L.id | 0, key, until: (endAt > 0 ? endAt : t0 + sec) + PV_TAIL };
    return n;
  }
  // HOW LONG A PRESS STILL MEANS "STOP". `endAt` is already the last note's own
  // end, so this is only the slack between scheduling and hearing — NOT a
  // guess at the release tail. It was 1.2 s on top of endAt, which on a 4-bar
  // part left a press meaning STOP for 11.7 s against 8 s of sound: for
  // seconds after it had finished, pressing Preview silently stopped instead
  // of playing, reported as "preview stopped playing after 2 or 3 presses".
  // Overshoot is not free after all — it just moves the dead press from one
  // edge to the other. The original bug (a press RESTARTING while notes were
  // still scheduled) stays fixed because `until` is still >= the last note.
  const PV_TAIL = 0.15;
  // IS THIS LAYER'S PREVIEW STILL SOUNDING? The button asks this instead of
  // running its own timer, so what the label says and what a press DOES can
  // never disagree.
  function previewing(L) {
    if (!PV || !L || PV.id !== (L.id | 0)) return false;
    const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    if (now >= PV.until) { PV = null; return false; }
    return true;
  }
  function previewLeftSec(L) {
    if (!previewing(L)) return 0;
    const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    return Math.max(0, PV.until - now);
  }

  // ── 🎲 ROLL A RUN — v1's Riff, in v2's vocabulary ────────────────────────
  // v1's Riff is a LIVE generator whose line comes out of a seeded roll; you
  // re-roll it with New take. v2 can already express exactly that shape — the
  // v1 importer maps run/riff to `rhythm: pulse|euclid` + `pitch: walk` — but
  // there was no one press that PRODUCES one, so a v2 layer could only be
  // dialled in knob by knob. This rolls the whole shape at once and leaves it
  // LIVE, so Preview auditions it and New take keeps re-realising it.
  //
  // Rolled with `Math.random` at UI time, NEVER the seeded `_ambRand` stream —
  // the documented split that keeps the invariant harness byte-identical
  // (a draw taken from the shared stream shifts every downstream draw).
  // THE PART ARCHETYPES. v2 answers "what kind of part is this?" with two
  // independent selects (Rhythm kind × Pitch kind) — powerful, but only if you
  // already know which combinations make a pad and which make an arpeggio.
  // These are the doors: one press sets the whole shape, and the components
  // underneath stay exactly as they were for tuning afterwards.
  // EACH MATERIAL REMEMBERS ITS OWN SETTINGS. Pressing a material button used
  // to overwrite the live spec outright, so tuning an Arpeggio, trying a
  // Sustained and coming back handed you the FACTORY arpeggio again and your
  // work was gone. `part.mem` keeps one spec per material and `part.mat` says
  // which one is in force: leaving a material files what you had, returning
  // restores it. Absent by default (nothing is stored until you switch), so an
  // untouched project is byte-identical.
  const MAT_KEYS = ['rhythm', 'pitch', 'shape', 'bars'];
  function matSave(L) {
    const p = L && L.part; if (!p || !p.mat) return;
    const box = {};
    MAT_KEYS.forEach((k) => { if (p[k] != null) box[k] = JSON.parse(JSON.stringify(p[k])); });
    p.mem = p.mem || {};
    p.mem[p.mat] = box;
  }
  // A SHAPE'S STAMP AND ITS RULES CAN DISAGREE — the stamp survives edits, so a
  // Groundwork part whose Rhythm type was later set to Pulse still says
  // `mat: 'ground'` while playing one sustained chord. That drifted state made
  // \u26f0 a permanent no-op (adopt keys on the stamp) and, filed into `mem`,
  // poisoned every later restore — reported as "Groundwork is broken, it just
  // creates one sustained chord instead of one chord for each change".
  // `matShapeOk` is the defining axis per shape; `matRepair` re-asserts it on a
  // RESTORED spec, keeping everything else the user tuned. Roll is exempt on
  // purpose: its repeat-press adopt deliberately never rebuilds.
  function matShapeOk(p, which) {
    const r = (p && p.rhythm) || {}, pk = ((p && p.pitch) || {}).kind || '';
    if (which === 'ground') return r.kind === 'ground';
    if (which === 'sustain') return r.kind === 'pulse' && (r.n | 0) <= 1 && /chord|stack/.test(pk);
    if (which === 'arp') return pk === 'series';
    if (which === 'mixed') return pk === 'mixed';
    return true;
  }
  function matRepair(p, which) {
    if (!p || matShapeOk(p, which)) return;
    if (which === 'ground') p.rhythm = Object.assign({ steps: 8, n: 1 }, p.rhythm, { kind: 'ground' });
    else if (which === 'sustain') {
      p.rhythm = Object.assign({ steps: 8 }, p.rhythm, { kind: 'pulse', n: 1 });
      if (!/chord|stack/.test(((p.pitch || {}).kind) || ''))
        p.pitch = Object.assign({ voices: 3, degree: 1 }, p.pitch, { kind: 'chord' });
    } else if (which === 'arp')
      p.pitch = Object.assign({ dir: 'up', octaves: 2, degree: 1 }, p.pitch, { kind: 'series' });
    else if (which === 'mixed')
      p.pitch = Object.assign({ voices: 3, degree: 1 }, p.pitch, { kind: 'mixed' });
  }
  // Returns true when it restored — the caller then skips its factory defaults,
  // which is the whole point: coming BACK to a material is not making a new one.
  function matLoad(L, mat) {
    const p = L && L.part; if (!p) return false;
    const box = p.mem && p.mem[mat];
    p.mat = mat;
    if (!box) return false;
    MAT_KEYS.forEach((k) => { if (box[k] != null) p[k] = JSON.parse(JSON.stringify(box[k])); });
    matRepair(p, mat);   // a filed spec can carry the drift that poisoned it
    return true;
  }
  // Called by every material door BEFORE it writes: file the outgoing one, then
  // try to restore the incoming one.
  function matSwitch(L, mat) {
    const p = L && L.part; if (!p) return false;
    if (p.mat && p.mat !== mat) matSave(L);
    return matLoad(L, mat);
  }
  const _ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const _pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  // SUSTAINED — one onset per cycle, held. Poly by default because that is the
  // pad case; Voices 1 makes it the mono one, which is why there is one door
  // and not two (the Voices control already says which).
  function makeSustainFn(E, L, poly) {
    if (!L || !L.part) return null;
    const p = L.part;
    p.kind = 'live';
    // COMING BACK to a material restores what you had; arriving for the first
    // time builds the archetype.
    if (matSwitch(L, 'sustain')) { try { E.getCfg(); } catch (e) {} return { voices: (p.pitch || {}).voices, bars: p.bars, kept: true }; }
    p.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    p.pitch = { kind: 'chord', voices: poly === false ? 1 : 3, degree: 1 };
    // 100% = the note fills its whole onset span, i.e. it holds until the next
    // one. `holdSteps` stays 0 so Length is what governs it (v2's own rule).
    p.shape = Object.assign({}, p.shape, { lenRatio: 100, holdSteps: 0 });
    try { E.getCfg(); } catch (e) {}
    return { voices: p.pitch.voices, bars: p.bars };
  }
  // ARPEGGIO — `series` sweeps the chord one tone per onset, which is what an
  // arpeggiator is; the rhythm grid decides the speed and the pattern.
  function makeArpFn(E, L) {
    if (!L || !L.part) return null;
    const p = L.part;
    p.kind = 'live';
    if (matSwitch(L, 'arp')) { try { E.getCfg(); } catch (e) {} return { onsets: (p.rhythm || {}).n, octaves: (p.pitch || {}).octaves, kept: true }; }
    p.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    p.pitch = { kind: 'series', dir: 'up', octaves: 2, degree: 1 };
    p.shape = Object.assign({}, p.shape, { lenRatio: 70, holdSteps: 0 });
    try { E.getCfg(); } catch (e) {}
    return { onsets: p.rhythm.n, octaves: p.pitch.octaves };
  }
  // GROUNDWORK — the part that PLAYS THE CHANGES rather than a figure over
  // them: notes on the 1 and on every change, holding until the next one. The
  // other four shapes all answer "what figure goes on top"; none of them can
  // simply state the harmony, which is what a bed, a pad or a comp does.
  function makeGroundFn(E, L) {
    if (!L || !L.part) return null;
    const p = L.part;
    p.kind = 'live';
    if (matSwitch(L, 'ground')) { try { E.getCfg(); } catch (e) {} return { kept: true }; }
    p.bars = partBarsFor(E, L) || p.bars || 2;
    p.rhythm = { kind: 'ground', steps: 8, n: 1 };
    p.pitch = { kind: 'chord', voices: 3, degree: 1 };
    // HOLD THROUGH THE CHANGE by default — that is what "fills" means, and a
    // short note here would make it a stab instead. Slip is off until asked.
    p.shape = Object.assign({}, p.shape, { lenRatio: 100, holdSteps: 0 });
    try { E.getCfg(); } catch (e) {}
    return { voices: p.pitch.voices, bars: p.bars };
  }
  // ⌫ START EMPTY — an empty WRITTEN part, so the roll can be drawn into from
  // nothing (the Written popover's third option: "working with an empty
  // visualization"). The generated RULES are kept — ⚙ Generated brings them
  // back — and the stamps are captureFn's own, so a drawn note behaves exactly
  // like a locked one: register shift, written key, follows-the-changes
  // default (with the pencil's pin on top, so it sounds where it is placed).
  // ENGINE-side, because `stampPartKey`/`stampFollowsChanges` live here and
  // the click delegation is the OTHER IIFE (the documented two-IIFE trap).
  function clearPartFn(E, L) {
    if (!L || !L.part) return false;
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg) return false;
    const p = L.part;
    p.kind = 'recorded';
    p.notes = [];
    p.made = 'compose';
    delete p.tf; delete p.takeb; delete p.ruleb;
    p.reg = clamp((L.instrument.register | 0) || 4, 1, 8);
    stampPartKey(L, cfg);
    stampFollowsChanges(L, cfg);
    try { E.getCfg(); } catch (e) {}
    return true;
  }
  // MIXED — chords AND single notes from one part, which none of the other
  // three doors can express: Sustained is always a chord, Arpeggio and Roll
  // always one note at a time. A euclid rhythm so the placement is musical,
  // and the balance left at its default even split.
  function makeMixedFn(E, L) {
    if (!L || !L.part) return null;
    const p = L.part;
    p.kind = 'live';
    if (matSwitch(L, 'mixed')) { try { E.getCfg(); } catch (e) {} return { kept: true }; }
    p.bars = partBarsFor(E, L) || p.bars || 2;
    p.rhythm = { kind: 'euclid', steps: 8, pulses: 5, rotate: 0 };
    p.pitch = { kind: 'mixed', voices: 3, degree: 1, span: 3 };
    p.shape = Object.assign({}, p.shape, { lenRatio: 70 });
    try { E.getCfg(); } catch (e) {}
    return { onsets: p.rhythm.pulses, bars: p.bars };
  }
  // HOW LONG THE PART THIS RECORD PLAYS UNDER IS. A maker that rolls its own
  // length throws away the fit: a record filed under a 5-bar part came back
  // 1 bar and then repeated five times under it (reported). Live generation
  // already resolves each note against the chord sounding at its own onset, so
  // once the cycle IS the part, one pass covers that part's chords in their
  // own harmonic character — the length is the only thing that has to be told.
  // Returns 0 when there is no part to mirror, and the makers keep their roll.
  function partBarsFor(E, L) {
    try {
      const cfg = E && E.getCfg && E.getCfg(); if (!cfg) return 0;
      const pr = cfg.prog; if (!pr || !pr.on) return 0;
      const rgs = (typeof _ambGridRanges === 'function') ? (_ambGridRanges(cfg) || []) : [];
      const pi = Number.isFinite(L.partFor) ? (L.partFor | 0)
        : ((typeof _ambCurPartNow === 'function' && rgs.length) ? _ambCurPartNow(E, cfg, rgs) : -1);
      if (!(pi >= 0) || typeof _ambLenPartBars !== 'function') return 0;
      const b = +_ambLenPartBars(cfg, pi);
      return (b > 0 && b <= 64) ? b : 0;
    } catch (e) { return 0; }
  }
  function rollRunFn(E, L) {
    if (!L || !L.part) return null;
    const p = L.part;
    // A roll makes a LIVE part — that is what a Riff is. A recorded one would
    // freeze a single realisation and New take could never move it.
    p.kind = 'live';
    // A ROLL IS A RE-ROLL BY DEFINITION: it files the outgoing material so that
    // one comes back intact, but never restores its own — pressing 🎲 has to
    // roll, or the button stops meaning anything.
    if (p.mat && p.mat !== 'roll') matSave(L);
    p.mat = 'roll';
    // MIRROR THE PART's length when there is one — see `partBarsFor`.
    p.bars = partBarsFor(E, L) || _pick([1, 1, 2, 2, 4]);
    // …AND A GRID THE BARS DIVIDE. `rhythm.steps` spans the whole CYCLE, so
    // 16 steps over a 5-bar part is 3.2 per bar and the onsets can NEVER
    // land on a bar or beat line (measured: every note up to an eighth off —
    // "the note events are not squaring up with the bar grid"). The roll
    // picks whole steps per bar now: the densest of 8/4/2/1 per bar that
    // fits the 32-step ceiling, so a 5-bar part rolls at 20 (4/bar).
    const barsInt = Math.max(1, Math.round(+p.bars || 1));
    const perBar = [8, 4, 2, 1].find((pb) => pb * barsInt <= 32) || 1;
    const steps = Math.max(2, Math.min(32, perBar * barsInt));
    // EUCLID, not an even pulse: the syncopation is most of what makes a riff
    // a riff, and it leaves a Pattern grid the user can edit afterwards.
    const pulses = Math.max(2, Math.min(steps - 1, Math.round(steps * (0.3 + Math.random() * 0.35))));
    p.rhythm = { kind: 'euclid', steps, pulses, rotate: _ri(0, steps - 1), n: 1 };
    const keepLines = (p.pitch && (p.pitch.lines | 0) > 1) ? (p.pitch.lines | 0) : 0;
    const keepHarm = (p.pitch && Array.isArray(p.pitch.harm) && p.pitch.harm.length)
      ? p.pitch.harm.slice() : null;
    p.pitch = {
      kind: 'walk',
      degree: _pick([1, 1, 1, 2, 3]),
      span: _ri(3, 8),
      home: _pick(['floor', 'floor', 'center']),
      stutter: _pick([0, 0, 10, 25, 40]),
      dir: 'up',
    };
    // HOW MANY NOTES AT ONCE IS NOT PART OF THE SHAPE — it is a standing choice
    // about texture, like the instrument, which a roll also leaves alone. The
    // pitch object is REPLACED wholesale above, so without carrying these two
    // across, setting Lines 3 and pressing 🎲 again put it back to one line
    // (measured) — the only way to keep polyphony was to never re-roll.
    if (keepLines) p.pitch.lines = keepLines;
    if (keepHarm) p.pitch.harm = keepHarm;
    p.shape = Object.assign({}, p.shape, { lenRatio: _ri(45, 95) });
    try { E.getCfg(); } catch (e) {}   // normalize coerces/prunes what we wrote
    return { steps, pulses, bars: p.bars, span: p.pitch.span };
  }

  // ── WHAT HAPPENS WHEN THE LENGTH CHANGES ────────────────────────────────
  // Onset counts are PER CYCLE, so doubling Bars spreads the same notes over
  // twice the time — the part STRETCHES. That is often what you want and it is
  // what v2 has always done, so it stays the default and absent means it.
  // The other answer is to keep the density and KEEP WRITING: twice the bars,
  // twice the notes, same feel. That is `fill`.
  //
  // Applied at the EDIT, not in normalize — normalize cannot know the previous
  // length, and the ratio is the whole point.
  // ── PRESERVE — EACH NOTE RE-FITTED TO ITS OWN CHANGE ────────────────────
  // The third answer, and the only one a CADENCE edit can give: Stretch scales
  // the whole cycle by one ratio and Fill ignores the chords entirely, but a
  // cadence edit did not scale the part — it moved the CHANGES, each by its own
  // amount. So map every note through the change boundaries: a note keeps its
  // place WITHIN the change it was in, and its length is truncated or extended
  // to that change's new span. A note spanning several changes maps its start
  // and its end separately, so it stretches piecewise and can never run past
  // the cycle. This needs the OLD per-change lengths, which is exactly what no
  // other length change has — hence cadence-only.
  function barMapper(oldLens, newLens) {
    if (!Array.isArray(oldLens) || !Array.isArray(newLens)) return null;
    const n = Math.min(oldLens.length, newLens.length);
    if (n < 1) return null;
    const oe = [0], ne = [0];
    for (let i = 0; i < n; i++) {
      oe.push(oe[i] + Math.max(1e-6, +oldLens[i] || 0));
      ne.push(ne[i] + Math.max(1e-6, +newLens[i] || 0));
    }
    const oT = oe[n], nT = ne[n];
    if (!(oT > 0) || !(nT > 0)) return null;
    // piecewise-linear through the change edges; outside the written span it
    // rides the overall ratio, so a note past the end still lands somewhere sane
    return (ob) => {
      if (!(ob > 0)) return 0;
      if (ob >= oT) return nT + (ob - oT) * (nT / oT);
      for (let i = 0; i < n; i++) {
        if (ob < oe[i + 1] - 1e-9) {
          const f = (ob - oe[i]) / Math.max(1e-9, oe[i + 1] - oe[i]);
          return ne[i] + f * (ne[i + 1] - ne[i]);
        }
      }
      return nT;
    };
  }

  // `lens` is `{ old: [...bars per change...], now: [...] }` — supplied only by
  // the cadence edit, which is the only caller that knows both.
  function applyBarsModeFn(L, prevBars, lens) {
    const p = L && L.part; if (!p) return null;
    const mode = p.barsMode || 'stretch';
    if (mode !== 'fill' && mode !== 'preserve') return null;
    const nb = +p.bars || 0;
    if (!(prevBars > 0) || !(nb > 0) || Math.abs(nb - prevBars) < 1e-9) return null;
    const k = nb / prevBars;
    const rec = p.kind === 'recorded' && Array.isArray(p.notes) && p.notes.length;

    if (mode === 'preserve') {
      // The RULES are untouched: a generated part re-resolves its pitches
      // against whatever chord is sounding at each onset, so it already
      // follows a cadence edit and there is nothing to re-fit.
      if (!rec) return { mode: 'preserve', rhythm: (p.rhythm || {}).kind };
      const map = barMapper(lens && lens.old, lens && lens.now);
      // WITHOUT THE OLD CADENCE THERE IS NOTHING TO PRESERVE — say so rather
      // than silently doing a stretch under another name.
      if (!map) return { mode: 'preserve', notes: p.notes.length, mapped: false };
      // The reconciler has ALREADY stretched these notes (times are cycle
      // fractions and `bars` moved), so each note's OLD absolute position is
      // `t × prevBars` — that is the space the map is defined in.
      const out = [];
      for (let i = 0; i < p.notes.length; i++) {
        const n = p.notes[i];
        const ob = clamp(n.t, 0, 1) * prevBars;
        const oe = Math.min(prevBars, ob + Math.max(1e-6, n.dur) * prevBars);
        const a = map(ob), b2 = map(oe);
        const t = clamp(a / nb, 0, 0.99999);
        const dur = clamp(Math.max(b2 - a, 1e-4) / nb, 0.001, 8);
        // COPY the note and override the two fields that move — a hand-set
        // velocity, envelope, glide or `hx` pin is somebody's edit, and the
        // rebuild-from-three-fields the fill branch does would drop every one
        // of them. Absent stays absent (no invented `undefined`s to prune).
        out.push(Object.assign({}, n, { t, dur: Math.min(dur, 1 - t) }));
      }
      p.notes = out.sort((x, y) => x.t - y.t);
      return { mode: 'preserve', notes: p.notes.length, mapped: true };
    }

    let notes = null;
    if (rec) {
      // A recorded part's times are FRACTIONS of the cycle, so growing the
      // cycle would slow the phrase down. Keep it at its own tempo and repeat
      // it to cover the new length — "continue writing" for notes that already
      // exist. Shrinking just truncates, which is the honest inverse.
      const src = p.notes.map(n => ({ t: n.t / k, midi: n.midi, dur: n.dur / k }));
      const out = [];
      for (let rep = 0; rep < Math.ceil(k) && out.length < 512; rep++) {
        const off = rep / k;
        for (let i = 0; i < src.length; i++) {
          const t = src[i].t + off;
          if (t >= 1 - 1e-9) break;
          out.push({ t, midi: src[i].midi, dur: Math.min(src[i].dur, 1 - t) });
        }
      }
      if (out.length) p.notes = out;
      notes = p.notes.length;
    }
    // …AND THE RULES GROW WITH THEM, on a recorded part too. They were grown
    // only for a GENERATED one, so Fill lived in the notes and nowhere else —
    // and 🎲 Replace with a new take reads the retained LIVE spec, which still
    // described the OLD length. Measured: a part filled to 2 onsets came back
    // from a re-roll with 1, the pre-cadence density stretched thinner, and the
    // Fill you had just chosen was gone with no way to tell. The rules ARE the
    // part's density; a mode that means "same density, more bars" has to move
    // them or it only holds until the next roll.
    const r = p.rhythm || {};
    const grow = (v, lo, hi) => clamp(Math.max(lo, Math.round((v || lo) * k)), lo, hi);
    // THE FILLED NOTES ARE THE ANSWER, when there are any. Scaling the KNOB
    // rounds, and rounding DOWN is the one thing "same density" may never do:
    // a ▬ Sustained part is one onset per cycle, so 5 → 6 bars is `round(1.2)`
    // = 1 and the re-roll came back a single held chord over five changes —
    // the report verbatim. The fill has already written the notes it means, so
    // the rules simply describe THAT: same onset count, re-placed.
    const onsN = notes
      ? new Set((p.notes || []).map(n => Math.round(n.t * 1e6))).size : 0;
    if (r.kind === 'pulse') r.n = onsN ? clamp(onsN, 1, 64) : grow(r.n, 1, 64);
    else if (r.kind === 'euclid' || r.kind === 'drawn') {
      const pu = r.pulses | 0;
      r.steps = grow(r.steps, 1, 64);
      r.pulses = onsN ? clamp(onsN, 1, r.steps) : clamp(Math.max(1, Math.round(pu * k)), 1, r.steps);
      // a drawn grid cannot be stretched by arithmetic — its cells are the
      // pattern, so growing the step count re-seeds from the knobs rather than
      // leaving a half-empty row (the same contract the knobs already have)
      if (r.kind === 'drawn') r.kind = 'euclid';
    } else if (r.kind === 'chance') r.steps = grow(r.steps, 1, 64);
    return { mode: 'fill', notes: notes, rhythm: r.kind };
  }

  // ── SEED THIS PART LIKE A v1 LAYER ──────────────────────────────────────
  // One button per v1 layer type: press it and the part is seeded exactly the
  // way adding that layer in v1 seeds one. Not a table of hand-copied numbers —
  // it builds a real v1 layer from `_ambDefaultLayer` (the same function v1's
  // own Add uses, so the defaults cannot drift), applies v1's ADD-TIME
  // stochastic seeding where that type has any, and runs the result through the
  // SAME `fromV1Fn` mapping that imports an existing v1 layer.
  //
  // The INSTRUMENT is deliberately left alone — you are seeding the PART, and
  // replacing a voice you chose would be a surprise. The one exception is the
  // Beat, whose part IS a drum kit: without the kit voice its lanes play nothing.
  const V1_SEEDS = [['bed', 'Bed'], ['motif', 'Motif'], ['texture', 'Texture'],
                    ['beat', 'Beat'], ['bass', 'Bass'], ['run', 'Riff'], ['arp', 'Arp']];
  function seedLikeV1Fn(E, L, type) {
    if (!L || !L.part || typeof _ambDefaultLayer !== 'function') return null;
    let L1 = null;
    try { L1 = _ambDefaultLayer(type, 1); } catch (e) { return null; }
    if (!L1) return null;
    // v1 seeds a euclid layer's pattern AT ADD TIME, with Math.random — not from
    // the seeded stream (the documented split that keeps the harness stable).
    // Without this every Bass/Beat would come out on the same fixed 5/8.
    try { if (typeof _ambEuclidStochasticInit === 'function') _ambEuclidStochasticInit(L1); } catch (e) {}
    try { if (typeof _ambSeedRandomPattern === 'function') _ambSeedRandomPattern(L1, type); } catch (e) {}
    // PROVENANCE, like the other material doors — file the outgoing material's
    // tuning, stamp this one. Like a roll it never RESTORES its own: a seed
    // press means "seed fresh like X", or the button stops meaning anything.
    try { if (L.part.mat && L.part.mat !== 'v1:' + type) matSave(L); } catch (e) {}
    L.part.mat = 'v1:' + type;
    // …AND ITS UNIT, which is where the LENGTH comes from. `_ambDefaultLayer`
    // does not set `unit` — v1 pins it at ADD time — so without this `v1Bars`
    // fell through to the ms interval and produced lengths no v1 layer has
    // (measured: an Arp at 0.125 bars, a Texture at 0.229). `_ambDefaultUnit`
    // is v1's own add-time rule: the nearest bar RATIO of that type's natural
    // length, which is exactly what `v1Bars` wants.
    try {
      if (typeof _ambDefaultUnit === 'function') _ambDefaultUnit(E, E.getCfg(), type, L1);
    } catch (e) {}
    let spec = null;
    try { spec = fromV1Fn(E, type, { l1: L1, specOnly: true }); } catch (e) { spec = null; }
    if (!spec || !spec.part) return null;
    const P = spec.part;
    L.part.kind = 'live';
    L.part.bars = P.bars;
    L.part.rhythm = P.rhythm;
    L.part.pitch = P.pitch;
    if (P.shape) L.part.shape = Object.assign({}, L.part.shape, P.shape);
    if (L.part.clock === 'free') { delete L.part.clock; delete L.part.ms; }
    // A Beat's part is its kit, so that one instrument field has to come along.
    // And the converse, which is not optional: a KIT cannot play a pitched
    // part, so seeding a Bass or a Riff onto a layer left on a kit by a
    // previous Beat press produced a part that emitted NOTHING (measured: 0
    // notes for bass/run/arp straight after beat). Only that case is touched —
    // any pitched voice the user chose is left alone.
    if (type === 'beat') {
      L.instrument.voice = 'kit';
      if (spec.instrument && spec.instrument.kit) L.instrument.kit = spec.instrument.kit;
    } else if (L.instrument.voice === 'kit') {
      L.instrument.voice = 'synth';
    }
    try { E.getCfg(); } catch (e) {}
    const q = L.part;
    return { type, bars: q.bars, rhythm: q.rhythm.kind, pitch: q.pitch.kind };
  }

  // ── TEST / CONSOLE API ──────────────────────────────────────────────────
  window._v2 = {
    preview: previewLayer,
    rollRun: rollRunFn,
    seedLikeV1: seedLikeV1Fn,
    withEdit: withEdit,
    applyBarsMode: applyBarsModeFn,
    v1Seeds: V1_SEEDS,
    makeSustain: makeSustainFn,
    makeMixed: makeMixedFn,
    makeGround: makeGroundFn,
    matShapeOk: matShapeOk,
    clearPart: clearPartFn,        // ⌫ Start empty — an empty written part to draw into
    makeArp: makeArpFn,
    previewKill: previewKill,
    previewing: previewing,
    previewCycle: () => PV_VIZ,
    partSig: partSigFn,
    // THE TAKE, across the IIFE boundary — the card lives in the second one, so
    // everything it needs has to come through here (the documented rule).
    takeOf: takeOf,
    withTake: withTake,
    newTake: (L, bars) => {
      if (!L || !L.part) return 0;
      const p2 = L.part;
      // never reuse a number any region is already pinned to — a retake that
      // resolves to material you are already looking at is a dead press
      let mx = takeOf(L);
      try { Object.keys(p2.takeb || {}).forEach((k) => { if ((p2.takeb[k] | 0) > mx) mx = p2.takeb[k] | 0; }); } catch (e) {}
      const nx = (mx + 1) % 1000000;
      if (Array.isArray(bars) && bars.length) {
        p2.takeb = p2.takeb || {};
        bars.forEach((k2) => { p2.takeb[String(k2)] = nx; });
      } else {
        // a WHOLE new take supersedes the per-bar history — keeping it would
        // pin old bars over the take you just asked for
        p2.take = nx; delete p2.takeb;
      }
      return nx;
    },
    // PER-BAR RULES. The card is in the OTHER IIFE, so the store's whole
    // vocabulary comes through here (the documented two-IIFE rule).
    barFields: BAR_RULE_F,
    barRules: barRulesOf,
    regBarKey: regBarKey,
    regKey: regKey,
    // …in the CALLER's terms — a note's cycle fraction and the part's length —
    // so nothing outside has to know the grid exists.
    regHas: (keys, t, barsF) => regHas(keys || [], slotAt(t, barsF)),
    regParse: regParse,
    regLabel: regLabel,
    regSlots: SPB,
    // WRITE ONE FIELD FOR A SET OF BARS, and store only what DIFFERS from the
    // part's own — absent is the one representation of "this bar takes the
    // part's rule", so a value set back to it is a DELETE, and an emptied
    // overlay takes its bar (and then the map) with it. Returns whether
    // anything moved, so a no-op press costs no re-render.
    setBarRule: (L, bars, grp, f, v) => {
      if (!L || !L.part || !Array.isArray(bars) || !bars.length) return false;
      const spec = (BAR_RULE_F[grp] || {})[f]; if (!spec) return false;
      const p2 = L.part, base = (p2[grp] || {})[f];
      let val = v;
      if (Array.isArray(spec) && typeof spec[0] === 'string') {
        if (typeof val !== 'string' || spec.indexOf(val) < 0) return false;
      } else {
        if (!Number.isFinite(val)) return false;
        val = clamp(Math.round(val), spec[0], spec[1]);
      }
      let moved = false;
      bars.forEach((b0) => {
        const key = String(b0);
        const rb = p2.ruleb || {};
        const ov = rb[key] || null;
        const cur = ov && ov[grp] ? ov[grp][f] : undefined;
        const same = (val === base) || (Number.isFinite(val) && Number.isFinite(base) && val === base);
        if (same) {
          if (cur === undefined) return;
          delete ov[grp][f];
          if (!Object.keys(ov[grp]).length) delete ov[grp];
          if (!Object.keys(ov).length) delete p2.ruleb[key];
          if (p2.ruleb && !Object.keys(p2.ruleb).length) delete p2.ruleb;
          moved = true; return;
        }
        if (cur === val) return;
        p2.ruleb = p2.ruleb || {};
        const o2 = p2.ruleb[key] || (p2.ruleb[key] = {});
        (o2[grp] || (o2[grp] = {}))[f] = val;
        moved = true;
      });
      return moved;
    },
    // …and the way back: this bar generates by the part's rules again.
    clearBarRules: (L, bars) => {
      if (!L || !L.part || !L.part.ruleb || !Array.isArray(bars)) return false;
      let moved = false;
      bars.forEach((b0) => { const k = String(b0);
        if (Object.prototype.hasOwnProperty.call(L.part.ruleb, k)) { delete L.part.ruleb[k]; moved = true; } });
      if (!Object.keys(L.part.ruleb).length) delete L.part.ruleb;
      return moved;
    },
    cycleWindowAt: cycleWindowAt,
    recordAt: partRecordAt,
    pinOf: pinOf,
    pinSig: pinSig,
    previewLeftSec: previewLeftSec,
    cycleSec: cycSecOf,
    fetchArticle: fetchArticleFn,
    normalize: normLayer,
    // Called from `_normalizeAmbientCfg`, the ONE migration chokepoint every
    // load path funnels through. In place rather than `layersOf`'s copy, so the
    // stored objects themselves are coerced — including the `unit` mirror, which
    // several v1 sweeps read directly.
    normalizeAll: (cfg) => {
      if (!cfg || !Array.isArray(cfg.layers)) return;
      for (let i = 0; i < cfg.layers.length; i++) normLayer(cfg.layers[i], i);
      // PER-PART RECORDS ride the same normalizer — a second copy of the part
      // coercion is how the two would drift. Swap each filed record in, run
      // `normLayer` (idempotent), restore, then run once more so the derived
      // mirrors (unit, bars) reflect the EDITED record, not the last filed one.
      for (let i = 0; i < cfg.layers.length; i++) {
        const L = cfg.layers[i]; if (!L) continue;
        if (!Number.isFinite(L.partFor)) { delete L.partFor; if (L.parts) delete L.parts; if (L.partAll) delete L.partAll; continue; }
        L.partFor = L.partFor | 0;
        // the ICED Everywhere record — a per-part save from before the ice
        // model backfills from the bench, which at that instant is identical
        if (!L.partAll || typeof L.partAll !== 'object') L.partAll = JSON.parse(JSON.stringify(L.part));
        if (!L.parts || typeof L.parts !== 'object') L.parts = {};
        const keep = L.part;
        L.part = L.partAll; try { normLayer(L, i); } catch (e) {} L.partAll = L.part;
        Object.keys(L.parts).forEach((k) => {
          const rec = L.parts[k];
          if (!(+k >= 0) || !rec || typeof rec !== 'object' || (+k | 0) === (L.partFor | 0)) { delete L.parts[k]; return; }
          L.part = rec; try { normLayer(L, i); } catch (e) {}
          L.parts[k] = L.part;
        });
        L.part = keep;
        try { normLayer(L, i); } catch (e) {}
        // RECONCILE against the arrangement (the lenSync doctrine — a reconciler
        // on every normalize, never an event): every part has a record. A part
        // with none — added a minute ago or a year ago — gets a COPY OF THE
        // EVERYWHERE RECORD fitted to its length (stretch: recorded times are
        // cycle fractions, a live rhythm spans the cycle; harmony re-resolves
        // per note at emit, so pitch fitting rides the existing machinery).
        try {
          const rgs = (typeof _ambGridRanges === 'function') ? (_ambGridRanges(cfg) || []) : [];
          if (rgs.length) {
            const pis = {};
            const fitTo = (rec, pi) => {
              let b = 0; try { b = +_ambLenPartBars(cfg, pi); } catch (e) {}
              if (!(b > 0)) return;
              const want = clamp((typeof _ambSnapBars === 'function')
                ? _ambSnapBars(b) : Math.round(b * 48) / 48, 0.125, 64);
              if (Math.abs((+rec.bars || 0) - want) > 1e-6) rec.bars = want;
            };
            rgs.forEach((rg) => {
              const pi = (rg && Number.isFinite(rg.pi)) ? (rg.pi | 0) : 0;
              pis[String(pi)] = 1;
              // A RECORD FILED UNDER A PART IS THAT PART'S LENGTH, ALWAYS.
              // Fitting only at materialisation left the EDITED record at
              // whatever length it had when per-part was engaged — a 1-bar
              // cycle under a 5-bar part, repeating five times, with the ruler
              // showing one bar (reported twice). Saying "⇄ Sync to fit it"
              // was answering a question the app should not have been asking:
              // choosing Per part IS the statement that this content is for
              // that part. Reconciled on every normalize, like every other
              // arrangement-derived length here, so growing the changes moves
              // it with no invalidation and no event.
              if (pi === (L.partFor | 0)) { fitTo(L.part, pi); return; }
              if (L.parts[String(pi)]) { fitTo(L.parts[String(pi)], pi); return; }
              const rec = JSON.parse(JSON.stringify(L.partAll));
              fitTo(rec, pi);
              L.parts[String(pi)] = rec;
            });
            Object.keys(L.parts).forEach((k) => { if (!pis[k]) delete L.parts[k]; });
          }
        } catch (e) {}
        if (!Object.keys(L.parts).length) delete L.parts;
      }
      // THE LOOP BINDING IS A RECONCILER, not a second clock — v1's own
      // doctrine (the sections' unit→bars mirror). It writes the plain field
      // the engine already reads, on every normalize, so editing the cadence
      // or the part's chords moves every bound layer with no invalidation.
      for (let i = 0; i < cfg.layers.length; i++) {
        const L = cfg.layers[i]; if (!L || !L.lenSync || !L.part) continue;
        try {
          const per = (typeof _ambLenPartBars === 'function') ? _ambLenPartBars(cfg, L.lenSync.part | 0) : 0;
          if (!(per > 0)) continue;
          let bars = (L.lenSync.passes | 0) * per;
          try { if (typeof _ambSnapBars === 'function') bars = _ambSnapBars(bars); }
          catch (e) { bars = Math.round(bars * 48) / 48; }
          if (!(bars > 0)) continue;
          L.part.bars = clamp(bars, 0.125, 64);
          // A BOUND CYCLE CANNOT BE FREE-RUNNING: a free part keeps its own ms
          // interval, which is the one thing a binding to the changes forbids.
          if (L.part.clock === 'free') { delete L.part.clock; delete L.part.ms; }
        } catch (e) {}
      }
    },
    layers: layersOf,
    GRIDS, gridPerBar, gridCells,  // the editing grid: a note value, per bar
    // THE MATERIAL'S FORM. Declared in the ENGINE IIFE beside the other part
    // vocabulary and published because every consumer is in the UI one — the
    // file is two IIFEs sharing only `window._v2`, and a bare `formOf` there
    // throws (it did, on the first render).
    formOf,
    // STATIC vs LIVE — a computed property of the settings, not a stored mode.
    // Published because every consumer is in the UI IIFE.
    liveness,
    scaleAt,                       // which pitch classes the keyboard should light
    chordAt,                       // …and which the SOUNDING CHORD holds, at one moment
    notesFor,                      // the interface, callable directly
    onsetsOf,
    transform: transformFn,        // commands over the notes you already have
    transformList: () => Object.keys(TRANSFORMS).map(k => ({ op: k, label: TRANSFORMS[k].label, hint: TRANSFORMS[k].hint })),
    transformWord: (op) => (TRANSFORMS[op] && TRANSFORMS[op].word) || '',
    capture: captureFn,            // door 1 into a recorded part: freeze the live one
    // The take as stored notes, WITHOUT freezing it — 💾 Save (UI IIFE) needs
    // exactly what 🔒 Lock writes, and the two must not be two walks.
    takeNotesNow: (E, L) => {
      const c = E && E.getCfg && E.getCfg(); if (!c || !L) return null;
      return takeAsNotes(E, L, c, currentCycle(E, L, c), false);
    },
    compose: composeFn,            // door 2: draw it in the grid, docked in the card
    composeCommit: composeCommitFn,
    adopt: adoptPhraseFn,          // door 3: a phrase already saved to the bank
    phrases: phrasesFn,            // what the bank holds, with lengths
    release: releaseFn,            //           recorded → live
    speechLines,                   // derived, never stored
    speechWrite: speechWriteFn,    // render the lines (while stopped)
    speechStat: speechStatFn,      // how many are ready
    fromV1: fromV1Fn,              // read a v1 layer as pieces
    seedCells: seedCellsFn,        // euclid patterning → the drawn grid
    euclidCells,
    // The lane table crosses to the CARD's IIFE, which cannot see the model's
    // consts — the same scope trap that broke `captureFn` twice. Exported, not
    // duplicated: two copies of a drum map is how the two halves come to
    // disagree about which lane is a clap.
    LANES: _V2_LANES, VDRUM: _V2_VDRUM, LANE_NAMES: _V2_LANE_NAMES,
    // ── PER-PART SELECT — file the edited record and take up the target's ──
    // Choosing a part ADOPTS the current content when that part has none of
    // its own, so switching is never destructive and syncing/editing is what
    // makes a part diverge. `null` switches per-part OFF: the edited record
    // becomes the one content and the filed ones are DROPPED (the caller
    // confirms — that is the only destructive branch).
    // THE EVERYWHERE RECORD IS ICED, NOT RELABELLED (user: "one content for
    // Everywhere, then if editing Per part the everywhere content is put on
    // ice"): engaging per-part keeps it in `L.partAll`, every part starts from
    // a FITTED COPY of it (the normalize reconciler materialises them — new
    // parts included), and disengaging brings it BACK. Un-diverged parts play
    // their own copy, so what a part plays never depends on which one is
    // selected for editing.
    partSelect: (E, L, pi) => {
      if (!L || !L.part) return false;
      const clone2 = (o) => JSON.parse(JSON.stringify(o));
      if (pi == null) {
        if (!Number.isFinite(L.partFor)) return false;
        if (L.partAll && typeof L.partAll === 'object') L.part = L.partAll;
        delete L.partAll; delete L.parts; delete L.partFor;
        try { E.getCfg(); } catch (e) {} return true;
      }
      pi = pi | 0;
      const cur = Number.isFinite(L.partFor) ? (L.partFor | 0) : null;
      if (cur === pi) return false;
      if (cur == null) {
        L.partAll = clone2(L.part);               // ← the ice
        L.partFor = pi;
        // the bench copy fits its part's length (stretch — times are fractions)
        try {
          const b = +_ambLenPartBars(E.getCfg(), pi);
          if (b > 0) L.part.bars = clamp((typeof _ambSnapBars === 'function')
            ? _ambSnapBars(b) : Math.round(b * 48) / 48, 0.125, 64);
        } catch (e) {}
        try { E.getCfg(); } catch (e) {} return true;
      }
      if (!L.parts || typeof L.parts !== 'object') L.parts = {};
      L.parts[String(cur)] = L.part;
      const nx = L.parts[String(pi)];
      L.part = (nx && typeof nx === 'object') ? nx
        : clone2((L.partAll && typeof L.partAll === 'object') ? L.partAll : L.part);
      delete L.parts[String(pi)];
      L.partFor = pi;
      try { E.getCfg(); } catch (e) {}
      return true;
    },
    add: addLayer,
    clear(cfg) { if (cfg) cfg.layers = []; },
  };

  // ── bloomPartWatch — WHY IS THIS PART'S LENGTH NOT WHAT I THINK IT IS? ──
  // A part's length is answered TWICE and the two can legitimately differ:
  //   `_ambLenPartBars(cfg, pi)` — the part's own chords, which is what the
  //      normalize RECONCILER fits every per-part record to (`rec.bars`);
  //   `_ambPassSpanAt(E, cfg, at)` — the PASS actually sounding, which is what
  //      `cycleWindowAt` hands the emitter as one cycle.
  // When they disagree the record is STRETCHED or JAMMED into the window
  // (`notesFor` takes the caller's `cycleSec` — the documented fit semantics),
  // which reads as "the 4-bar part is jammed into 3 bars". Measured, the honest
  // causes are a ▦ Passes SUBSET (a pass that plays 3 of 4 chords IS 3 bars), a
  // CADENCE (a ½-bar chord means four chords are not four bars) and a HANG
  // (trimmed off the pass, so the pass is shorter than the slot). Run it
  // STOPPED or playing — it walks the clock itself.
  //   bloomPartWatch()      → every part, every pass of one super-cycle
  // NOTE FOR THE NEXT PERSON: a synthetic multi-shape sweep of this on ONE page
  // reported hang disagreements that DO NOT EXIST — the shapes leaked into each
  // other (the one-page-one-state trap). Isolated, only the subset case
  // disagrees. Measure this in the user's runtime, not in a rig.
  window.bloomPartWatch = function () {
    const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
    if (!E) { console.log('[partwatch] no engine'); return; }
    const cfg = E.getCfg();
    const lines = [];
    const say = (t) => { lines.push(t); console.log('[partwatch] ' + t); };
    const prog = cfg && cfg.prog;
    if (!prog || !prog.on || !(prog.chords || []).length) { say('no progression — every layer runs its own cycle'); return; }
    const bs = barSec(cfg);
    const rgs = (typeof _ambGridRanges === 'function') ? (_ambGridRanges(cfg) || []) : [];
    const nm = (pi) => { try { return _ambPartLabel(cfg, pi); } catch (e) { return 'Part ' + (pi + 1); } };
    say('bpm ' + (cfg.bpm || 120) + ' · bar ' + (Math.round(bs * 1000) / 1000) + 's · ' +
        rgs.length + ' part' + (rgs.length === 1 ? '' : 's'));
    rgs.forEach((rg) => {
      const pi = rg.pi | 0;
      let b = 0; try { b = +_ambLenPartBars(cfg, pi); } catch (e) {}
      const pt = (prog.parts || [])[pi] || {};
      const bits = [];
      if (pt.plays > 1) bits.push('plays ' + pt.plays);
      if (pt.head) bits.push('head hang ' + pt.head.bars + 'b');
      if (pt.tail) bits.push('tail hang ' + pt.tail.bars + 'b');
      if (pt.grid && pt.grid.seq && Object.keys(pt.grid.seq).length) bits.push('▦ Passes subset');
      const cadence = (prog.chords || []).slice(rg.from, rg.from + rg.len)
        .map((c) => (c && Number.isFinite(c.bars)) ? c.bars : 1);
      if (cadence.some((x) => Math.abs(x - 1) > 1e-6)) bits.push('cadence ' + cadence.join('·'));
      // no leading bullet: every part label now LEADS with its own number, and
      // "· 3 · Changes" reads as two separators for one thing
      say('  ' + nm(pi) + ' — ' + rg.len + ' chord' + (rg.len === 1 ? '' : 's') + ' = ' +
          (Math.round(b * 100) / 100) + ' bars' + (bits.length ? ' · ' + bits.join(' · ') : ''));
    });
    // WALK ONE SUPER-CYCLE and report each pass's own span against the length
    // its record was reconciled to. Anchored where the chord clock is anchored,
    // or at 0 when stopped — the walk is the same either way.
    const aA = Number.isFinite(E._progAnchor) ? E._progAnchor
      : (Number.isFinite(E._playStartAt) ? E._playStartAt : 0);
    const seen = {}, rows = [];
    for (let k = 0; k < 400; k++) {
      const at = aA + k * bs * 0.25;
      let w = null, sp = null;
      try { w = _ambPartChordAt(E, cfg, at); } catch (e) {}
      try { sp = _ambPassSpanAt(E, cfg, at); } catch (e) {}
      if (!w || !(w.pi >= 0) || !sp) continue;
      const kk = w.pi + '/' + w.pass;
      if (seen[kk]) continue; seen[kk] = 1;
      let b = 0; try { b = +_ambLenPartBars(cfg, w.pi); } catch (e) {}
      rows.push({ pi: w.pi | 0, pass: w.pass | 0, rec: b, win: (sp.to - sp.from) / bs,
                  at: (sp.from - aA) / bs });
      if (rows.length > 24) break;
    }
    say('');
    say('PASS          record   window   ');
    let bad = 0;
    rows.forEach((r) => {
      const off = Math.abs(r.rec - r.win) > 0.01;
      if (off) bad++;
      say('  ' + (nm(r.pi) + ' pass ' + (r.pass + 1)).padEnd(22) +
          (Math.round(r.rec * 100) / 100 + 'b').padEnd(8) +
          (Math.round(r.win * 100) / 100 + 'b').padEnd(8) +
          (off ? (r.win < r.rec ? '⚠ JAMMED into ' : '⚠ STRETCHED to ') +
                 (Math.round((r.win / Math.max(0.001, r.rec)) * 100)) + '%' : 'ok') +
          '   @ bar ' + (Math.round(r.at * 100) / 100));
    });
    say('');
    // …AND WHAT EACH v2 LAYER HAS FILED, since that is what gets fitted.
    // WITH ITS CONTENT'S OWN SPAN, which is the other half of "jammed": a
    // record's note times are FRACTIONS of its cycle, so the reconciler moving
    // `bars` keeps the SHAPE and scales it — a record whose notes only ever
    // covered 4 of its 5 bars still covers 80% after it is fitted to 4, i.e.
    // 3.2 bars with the last 0.8 empty. That is not the window being wrong and
    // no amount of window fixing touches it; the content itself is short.
    let shortRec = 0;
    const spanOf = (rec) => {
      if (!rec || rec.kind !== 'recorded' || !Array.isArray(rec.notes) || !rec.notes.length) return null;
      let mx = 0;
      rec.notes.forEach((n) => { const e = (+n.t || 0) + Math.max(0, +n.dur || 0); if (e > mx) mx = e; });
      return Math.min(1, mx);
    };
    const recTxt = (rec, label) => {
      const b = Math.round((+rec.bars || 0) * 100) / 100;
      const sp = spanOf(rec);
      let tail = '';
      if (sp != null) {
        const pct = Math.round(sp * 100);
        tail = ' · ' + (rec.notes || []).length + ' notes covering ' + pct + '% (' +
               (Math.round(sp * b * 100) / 100) + ' of ' + b + ' bars)';
        if (pct < 92) { tail += ' ⚠ CONTENT SHORT'; shortRec++; }
      } else if (rec.kind === 'recorded') { tail = ' · EMPTY'; }
      if (rec.barsMode === 'fill') tail += ' · fill';
      return label + ' ' + b + 'b' + tail;
    };
    layersOf(cfg).forEach((L) => {
      if (!Number.isFinite(L.partFor)) {
        say('layer "' + (L.name || L.id) + '" — ▭ Everywhere: ONE cycle for every part · ' +
            recTxt(L.part || {}, ''));
        say('    (◫ Per part is the door to per-part lengths)');
        return;
      }
      say('layer "' + (L.name || L.id) + '" — ◫ Per part, editing ' + nm(L.partFor | 0));
      say('    ' + recTxt(L.part || {}, 'editing ' + nm(L.partFor | 0) + ':'));
      Object.keys(L.parts || {}).forEach((k) => say('    ' + recTxt(L.parts[k], nm(+k) + ':')));
      if (L.partAll) say('    ' + recTxt(L.partAll, '(iced Everywhere):'));
    });
    say('');
    if (shortRec) {
      say('⚠ ' + shortRec + ' record' + (shortRec === 1 ? '\u2019s' : 's\u2019') +
          ' notes do not fill the record\u2019s OWN cycle. Note times are FRACTIONS of that ' +
          'cycle, so fitting a short record to a shorter part keeps the gap IN PROPORTION \u2014 ' +
          'a 5-bar record covering 72% becomes 2.88 of 4 bars, which reads as "crammed into 3 ' +
          'bars". The window is not the problem; the content is short. \u21c4 Sync \u2192 Length: ' +
          'Fill repeats it at its own tempo to cover the part; Stretch spreads it.');
    }
    say(bad ? ('VERDICT: ' + bad + ' pass' + (bad === 1 ? '' : 'es') +
               ' play a record of a different length — the record is fitted to the window, ' +
               'so its notes compress or spread. The cause is in the part line above ' +
               '(a ▦ Passes subset shortens a pass; a cadence means chords ≠ bars; a hang is ' +
               'trimmed off the pass).')
             : 'VERDICT: every pass plays a record of its own length — lengths agree.');
    try { navigator.clipboard.writeText(lines.join('\n')).then(() => {}, () => {}); } catch (e) {}
    console.log('[partwatch] report copied to the clipboard.');
    return lines.join('\n');
  };

  // ── bloomContentWatch — WHY IS THIS LAYER'S CONTENT NOT (ALL) SOUNDING? ──
  // The in-situ instrument for "content chords not being played"-class reports
  // (the bloomSilenceWatch pattern): a synthetic probe cannot see the USER'S
  // state, and the answer is almost always a stateful stage — a freeze or a
  // ▦ Passes mapping outranking the part, a chord/section/unit/iteration gate,
  // a muted layer, notes shorter than the attack. Run it in the console WHILE
  // PLAYING: `bloomContentWatch()` (first v2 layer) or `bloomContentWatch(id)`.
  // It prints the layer's gate-relevant state, what notesFor says one cycle
  // holds, what actually reached playNote per onset, every playback-gate skip
  // and choke clamp for this key, and a VERDICT — then copies the report.
  window.bloomContentWatch = function (idOrName, secs) {
    const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
    if (!E) { console.log('[contentwatch] no engine'); return; }
    const cfg = E.getCfg();
    const list = layersOf(cfg);
    let L = null;
    if (idOrName == null) L = list[0];
    else L = list.find((x) => (x.id | 0) === (idOrName | 0)) ||
             list.find((x) => String(x.name || '').toLowerCase().indexOf(String(idOrName).toLowerCase()) >= 0);
    if (!L) { console.log('[contentwatch] no v2 layer matched', idOrName); return; }
    const key = 'v2:' + (L.id | 0);
    const lines = [];
    const say = (t) => { lines.push(t); console.log('[contentwatch] ' + t); };
    const p = L.part || {};
    // ── the stateful stages that outrank or gate the content ──
    const fz = E.freeze && E.freeze[key];
    const mask = (L.chordMask && Array.isArray(L.chordMask.steps))
      ? L.chordMask.steps.map((v, i) => v < 100 ? (i + ':' + v) : null).filter(Boolean) : [];
    say('layer ' + key + ' "' + (L.name || '') + '" · on:' + !!L.on + ' present:' + !!L.present +
        ' level:' + (L.level == null ? '(default)' : L.level) + ' solo-elsewhere:' +
        (typeof _ambComputeAnySolo === 'function' ? (!!_ambComputeAnySolo(cfg) && !L.solo) : '?'));
    say('part kind:' + p.kind + ' rhythm:' + ((p.rhythm || {}).kind || '?') +
        ' pitch:' + ((p.pitch || {}).kind || '?') + ' harmony:' + (L.harmony || '(fixed)') +
        ' mat:' + (p.mat || '-') + ' vary:' + !!p.vary + ' take:' + ((p.take | 0) || 0) +
        ' notes:' + ((p.notes || []).length));
    if (fz) say('⚠ a FREEZE sits on this key' + (fz._partSeqName ? ' (▦ Passes phrase "' + fz._partSeqName + '")' : '') +
        ' — it OUTRANKS the part: the content you edit is not what plays');
    if (L.partSeqs) say('⚠ partSeqs mapping present: ' + JSON.stringify(L.partSeqs).slice(0, 120));
    if (L.when) say('⚠ when-gate: "' + L.when + '" — some ITERATIONS are silent by design');
    if (mask.length) say('⚠ chord mask below 100%: [' + mask.join(' ') + '] — those chords sit out (rolled per pass)');
    if (L.sectionMask) say('⚠ section mask present');
    if (L.unitGate) say('⚠ ⏱ unit schedule present — slices of each unit are gated');
    if (L.iterGate) say('⚠ iteration gate present');
    if (Number.isFinite(L.partFor)) {
      say('per-part content: editing the record for part ' + (L.partFor + 1) +
        ' — while OTHER parts sound, their own records play. The records:');
      const recSay = (label, rec) => {
        if (!rec || typeof rec !== 'object') return;
        const ns = rec.notes || [];
        const by = {};
        ns.forEach((n) => { const k = Math.round((n.t || 0) * 1e4); by[k] = (by[k] || 0) + 1; });
        const ch = Object.keys(by).filter((k) => by[k] > 1).length;
        say('  ' + label + ': ' + (rec.kind === 'recorded'
          ? ('WRITTEN — ' + ns.length + ' notes over ' + (rec.bars || '?') + ' bars, ' +
             ch + ' chord onset' + (ch === 1 ? '' : 's'))
          : ('GENERATED — ' + ((rec.rhythm || {}).kind || '?') + ' × ' + ((rec.pitch || {}).kind || '?') +
             (/chord|stack|mixed/.test((rec.pitch || {}).kind || '') ? '' :
              ' — ONE NOTE AT A TIME: chords drawn on another part do NOT play here'))));
      };
      recSay('part ' + (L.partFor + 1) + ' (the one on screen)', L.part);
      Object.keys(L.parts || {}).forEach((k) => recSay('part ' + ((+k) + 1), L.parts[k]));
      recSay('Everywhere (iced)', L.partAll);
    }
    // ── what one cycle SHOULD hold ──
    const cyc = cycSecOf(L, cfg);
    let exp = [];
    try { exp = notesFor(L, { E, cfg, key, cycleStart: 0, cycleSec: cyc }) || []; } catch (e) {}
    const fold = (arr, get) => {
      const by = {};
      arr.forEach((n) => { const at = get(n); if (at == null) return;
        const k = (Math.round(at * 100) / 100).toFixed(2); (by[k] = by[k] || []).push(n); });
      return by;
    };
    const expBy = fold(exp.filter((n) => n.freq > 0), (n) => n.at);
    const expTxt = Object.keys(expBy).sort((a, b) => a - b)
      .map((k) => k + 's×' + expBy[k].length).join(' ');
    say('one cycle (' + (Math.round(cyc * 100) / 100) + 's) holds: ' + (expTxt || 'NOTHING — notesFor returned no notes'));
    const chordOnsets = Object.keys(expBy).filter((k) => expBy[k].length > 1);
    say(chordOnsets.length + ' chord onset' + (chordOnsets.length === 1 ? '' : 's') + ' expected per cycle');
    // notes vs the attack — a note shorter than the attack never reaches full level
    try {
      const atk = (L.instrument.attack | 0) || 0;
      const shorter = exp.filter((n) => (n.durMs || 0) > 0 && n.durMs < atk).length;
      if (atk > 0 && shorter > 0) say('⚠ ' + shorter + ' of ' + exp.length + ' notes are SHORTER than the ' + atk +
          'ms Attack — they peak at a fraction of full level and can read as "not played". ' +
          'Lengthen them, or shorten Instrument ▸ Attack.');
    } catch (e) {}
    if (!E.timer) {
      say('transport NOT running — press ▶ and call bloomContentWatch() again to compare what actually plays.');
      try { navigator.clipboard.writeText(lines.join('\n')).then(() => {}, () => {}); } catch (e) {}
      return;
    }
    // ── watch what actually reaches playNote for this key ──
    const dur = Math.max(3, Math.min(30, (secs | 0) || 8));
    say('watching ' + dur + 's of playback…');
    const got = [], gateSkips = [], chokes = [];
    const oP = window.playNote;
    window.playNote = function (freq, params, durMs, at) {
      const r = oP.apply(this, arguments);
      try { if (window._ambEmitKey === key) got.push({ at: +at || 0, f: Math.round(freq), d: Math.round(durMs || 0) }); } catch (e) {}
      return r;
    };
    const oG = window._ambUnitGateSkip;
    if (typeof oG === 'function') window._ambUnitGateSkip = function (k2, at) {
      const v = oG.apply(this, arguments);
      try { if (k2 === key && v) gateSkips.push(Math.round(at * 100) / 100); } catch (e) {}
      return v;
    };
    const oC = window._ambNoteChoke;
    if (typeof oC === 'function') window._ambNoteChoke = function (k2, at, dms) {
      const v = oC.apply(this, arguments);
      try { if (k2 === key && v > 0 && v < dms) chokes.push(dms + '→' + v); } catch (e) {}
      return v;
    };
    setTimeout(() => {
      window.playNote = oP;
      if (typeof oG === 'function') window._ambUnitGateSkip = oG;
      if (typeof oC === 'function') window._ambNoteChoke = oC;
      const st = E._v2Phase && E._v2Phase[key];
      const anchor = (st && Number.isFinite(st.startAt)) ? st.startAt : 0;
      const gotBy = fold(got, (n) => (((n.at - anchor) % cyc) + cyc) % cyc);
      const gotTxt = Object.keys(gotBy).sort((a, b) => a - b)
        .map((k) => k + 's×' + gotBy[k].length).join(' ');
      say('scheduled (folded into the cycle): ' + (gotTxt || 'NOTHING'));
      // the verdicts
      if (!got.length && exp.length) say('✗ VERDICT: notes exist but NONE were scheduled — the layer is gated, ' +
        'frozen, muted or not reached (see the ⚠ lines above; if none, send a bloomDump()).');
      else {
        const thin = chordOnsets.filter((k) => {
          const g2 = gotBy[k]; return !g2 || g2.length < expBy[k].length;
        });
        if (thin.length) say('✗ VERDICT: chord onsets scheduled THINNER than drawn at ' + thin.join(', ') +
          ' — send a bloomDump() so the exact mechanism can be pinned.');
        else if (exp.length) say('✓ every drawn onset was scheduled at full width' +
          (chokes.length ? ' — but the CHORD CHOKE clamped ' + chokes.length + ' (' + chokes.slice(0, 5).join(' ') +
            '): notes ringing over a change are cut; the opt-out is Pitch ▸ Ring out' : '') +
          (gateSkips.length ? ' — and the ⏱ gate silenced ' + gateSkips.length + ' at ' + gateSkips.slice(0, 8).join(',') : '') + '.');
      }
      try { navigator.clipboard.writeText(lines.join('\n')).then(() => {}, () => {}); } catch (e) {}
      console.log('[contentwatch] report copied to the clipboard.');
    }, dur * 1000);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 2 — THE CARD
//
// Gating is the design claim made concrete: NOTHING here asks "what kind of
// layer is this". Every control declares the PIECE VALUES it belongs to
// (`data-v2when="rhythm:euclid,chance"`) and one pass shows or hides it. That is
// why there is no type — a control's relevance is computed, not listed per type.
//
// Class-delegated throughout: no element ids, so none of the master/lane id-prefix
// traps apply, and a re-render can never orphan a listener.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';
  const V2 = window._v2; if (!V2) return;
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  // THE REGION VOCABULARY, across the IIFE boundary. It is declared in the
  // ENGINE half (normalize needs it) and every surface that draws or selects a
  // region is in THIS half — the documented two-IIFE trap, which this cost a
  // round to: `SPB is not defined` threw straight into the tap handler's own
  // catch, so every chord press silently did nothing.
  const SPB = V2.regSlots, regKey = V2.regKey, regBarKey = V2.regBarKey,
        regParse = V2.regParse, regLabel = V2.regLabel;

  // `drawn` IS NOT A CHOICE HERE — it is what `euclid` BECOMES the moment you
  // tap a cell, exactly as v1's `euclidPattern` override supersedes its own
  // formula. Shipping it as a fourth dropdown entry made the grid invisible
  // until you found that entry, which is the same "no door" failure as before:
  // a default card and a Euclid card both showed no grid at all. Now Pattern is
  // the euclid option's own surface and the override is internal state.
  // LABEL ≠ KEY, per the house rule: the stored value stays 'euclid'.
  // The intervals worth one press. Named the way a musician asks for them, and
  // stored as signed SOURCE TONES (a 3rd is two tones up the set, whatever the
  // set is) so the harmony bends with the scale instead of running parallel.
  const HARM_OPTS = [[-5, '−6th'], [-2, '−3rd'], [2, '3rd'], [3, '4th'], [4, '5th'], [5, '6th']];
  function harmRowHtml(L, t) {
    const on = new Set((Array.isArray(t.harm) ? t.harm : []).map((h) => h && (h.deg | 0)).filter(Boolean));
    return '<div data-v2tab="Harmony" class="ambient-ctrl" data-v2when="kind:live;voice:synth">' +
      '<label>Harmony</label><span class="ambient-seg-row">' +
      HARM_OPTS.map(([d, lab]) =>
        '<button type="button" class="ambient-seg v2-harm' + (on.has(d) ? ' on' : '') +
        '" data-harm="' + d + '">' + lab + '</button>').join('') +
      '</span><span class="ambient-hint">' +
      (on.size ? on.size + ' harmony part' + (on.size === 1 ? '' : 's') + ' — in key'
               : 'add a voice a stated interval from the line') +
      '</span></div>';
  }
  // ── THE PART, DRAWN ─────────────────────────────────────────────────────
  // A part menu that only lists knobs makes you press a button and then guess.
  // This is one cycle of what the part actually plays — time across, pitch up —
  // asked of `notesFor`, the part INTERFACE, so it is the same answer the
  // emitter gets and works for every kind: live or recorded, pitched or kit,
  // seeded or composed. It is NOT an `.ambient-ctrl`, which is what keeps it
  // out of `popTabbables` and therefore visible under EVERY tab of the sheet
  // rather than belonging to one of them.
  // WHAT THE LOCK BUTTON SAYS — THREE states, not two, and one definition of
  // them. A part with no notes has nothing to "replace"; a live part freezes
  // the take DRAWN ABOVE, which is a more specific promise than a fixed one
  // can make. Read on every draw as well as at build time, because
  // `V2.render`'s signature does not include the note count — so removing the
  // last note rebuilds nothing and the button would go on offering to replace
  // notes that are not there.
  // WHICH BARS A RE-ROLL TOUCHES. Tap a bar in the drawing to pick it; with
  // none picked, Replace re-rolls everything (the old behaviour is the
  // default). Module state, transient by construction (`_soloLane` rule), and
  // it SURVIVES a replace on purpose — press again, same bars, another roll:
  // that repeat-until-you-like-it loop is the point of selecting.
  let BSEL = null;
  // (DRAW was a Set of layer ids here. It is one value of `modeOf` now — the
  //  two switches were one axis; see MODES.)
  // A DRAG IN PROGRESS. Held here rather than on the element so a card rebuild
  // mid-gesture cannot strand it; cleared on pointerup and on any commit.
  let DRAG = null;
  // THE STICKY PITCH WINDOW, per layer id — survives card rebuilds (a locked
  // drag rebuilds at release) so the canvas cannot resize across one.
  // Transient by construction; a reload re-derives.
  const WINHOLD = new Map();
  // THE SCROLLER IS NOT ALWAYS THE DOCUMENT. `#mix-view` carries
  // `overflow-y: auto`, so depending on flex state the Bloom panel scrolls
  // INSIDE it rather than with the page — and every scroll this file does
  // (the render's save/restore, the drag's absorbing scroll, the editor
  // reveal) was hardwired to `document.scrollingElement`. In the inner-scroll
  // regime a card rebuild reset the CONTAINER's scrollTop with nobody
  // restoring it — the screen jumped on every lock and every commit — and
  // the drag's absorb scrolled the wrong element, so the note never came
  // back under the finger. Resolve the NEAREST scrollable ancestor, and
  // resolve it while the content is still tall (an emptied host collapses
  // the container and the test below stops recognising it).
  function scrollerOf(el) {
    try {
      for (let a = el && el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(auto|scroll)/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1) return a;
      }
    } catch (e) {}
    return document.scrollingElement || document.documentElement;
  }
  const bselSig = (L) => [L.part.kind, L.part.bars, L.part.clock || ''].join(',');
  function bselOf(L) {
    if (!BSEL || !L || BSEL.id !== (L.id | 0)) return null;
    if (BSEL.sig !== bselSig(L)) { BSEL = null; return null; }
    return BSEL.bars.size ? BSEL : null;
  }
  // `BSEL.bars` IS A MAP of region key → its NAME. The name is what you
  // pressed — "F♯m" for a change, "bar 3" for a bar — because a selection
  // described as "bar 2½–3" when you pressed a chord is the app answering a
  // question you did not ask. `regLabel` is the fallback for a region nobody
  // named (one restored from the store).
  const bselKeys = (sel) => [...sel.bars.keys()];
  const bselLabel = (sel) => {
    const ks = bselKeys(sel).slice().sort((x, y) => {
      const A = regParse(x), B = regParse(y); return (A ? A.a : 0) - (B ? B.a : 0); });
    const names = ks.map((k) => sel.bars.get(k) || regLabel(k));
    return names.length === 1 ? names[0] : names.join(' + ');
  };
  // A STORE'S KEYS, IN ORDER, NAMED — for the card readouts, which must say
  // which regions carry a pin or their own rules (state that can sit in a
  // closed panel has to be readable from the card).
  const regListTxt = (map) => Object.keys(map || {})
    .sort((x, y) => { const A = regParse(x), B = regParse(y); return (A ? A.a : 0) - (B ? B.a : 0); })
    .map(regLabel).join(' + ');
  // ONE BUTTON, TWO STATES (user: "lock/unlock take should be a single
  // button"). It used to carry three faces and one of them REPLACED your
  // notes — a lock that sometimes destroys work is two actions in one
  // control. Making material is 🎲's job in both states now; this only
  // freezes the take or lets the rules take over again.
  function capFace(L) {
    const p = (L && L.part) || {};
    const rec = p.kind === 'recorded';
    // ONE PAIR OF WORDS for the axis — GENERATED or WRITTEN — and this button
    // is the transition between them. It names the DESTINATION, and on notes
    // you drew yourself it says so: "Unlock" on a composed part reads as
    // unlocking something that was never locked.
    if (rec) {
      const hand = (p.made === 'compose' || p.made === 'phrase');
      return { txt: hand ? '\u2699 Generate instead' : '\ud83d\udd13 Unlock',
        title: hand
          ? 'Hand this part back to the rules \u2014 it GENERATES again, fresh every cycle. Your notes are kept, so \ud83d\udd12 Lock brings them back until you roll a new take.'
          : 'Back to GENERATED \u2014 the rules make the part again and re-roll every cycle. These notes are kept, so locking again brings them back until you roll a new take.' };
    }
    return { txt: '\ud83d\udd12 Lock this take',
      title: 'WRITE THIS TAKE DOWN \u2014 exactly the notes drawn above become the part, editable note by note. The rules are kept, so you can hand it back to them or roll another take later.' };
  }
  // WATCH IT, OR WORK ON IT. The drawing has always shown the record being
  // EDITED — right when you are editing, and wrong when you want to follow the
  // arrangement, because with per-part content the part that SOUNDS is not the
  // one you have selected. VIEW follows what is playing (the emitter's own
  // per-part swap, resolved by time); EDIT holds the record you are editing
  // while the parts cycle underneath. Transient by construction: it is a view
  // preference, and a field on the layer would be serialised by
  // `persistWorkspace` (the documented `_soloLane` trap).
  // THE DEFAULT IS VIEW (2026-09-09): with per-part content, the Edit default
  // meant the picture showed one part's chords while another part's record
  // sounded — reported as "one part only plays one of each chord in the
  // visualization" when the sounding part's record was a one-note-at-a-time
  // take. A drawing that playback ignores is decoration (the take-pin rule);
  // \u270e Edit is now the explicit pin for working while the parts cycle.
  // ── THE DRAWING'S MODE ──────────────────────────────────────────────────
  // ONE axis, four states, in one control. It was TWO buttons — 👁 View/✎ Edit
  // (which RECORD is drawn) beside ✎ Draw (what a TAP does) — and they read as
  // two independent switches when three of the four combinations mean the same
  // thing: drawing and multi-select both imply you are working on the record
  // you are editing, not watching whatever plays. So the axis is:
  //   view  — follow what PLAYS; a tap selects a bar
  //   edit  — hold the record you are editing; a tap opens a note
  //   draw  — hold; a tap on empty space ADDS a note (the pencil)
  //   multi — hold; tap notes to gather them, then move or resize them TOGETHER
  // `vizMode` keeps answering the two-state question every existing consumer
  // asks (the record pin: `vizFollows`, the take pin, `cv._vmOther`) — draw and
  // multi are edit modes — so nothing downstream had to learn the new states.
  // Transient by construction (a Map keyed on layer id): a field would be
  // serialised by `persistWorkspace` and a project would reload in a mode you
  // cannot see (the `_soloLane` rule).
  // (SPLIT was a fifth value here, and it was a mode for one gesture: you had
  // to switch to it, tap a note, and switch back. A tap on a note ALREADY
  // opens that note — so the divider is a BUTTON in the note editor now, one
  // press instead of three, and the mode axis is back to the four states that
  // genuinely change what a tap means. `✂ Split…` is in `.v2-nebtns`.)
  const MODES = ['view', 'edit', 'draw', 'multi'];
  const VIEWM = new Map();      // layer id -> one of MODES  (absent = view)
  const modeOf = (L) => {
    const m = VIEWM.get(L && (L.id | 0));
    return MODES.indexOf(m) >= 0 ? m : 'view';
  };
  const setMode = (L, m) => {
    if (!L) return;
    VIEWM.set(L.id | 0, MODES.indexOf(m) >= 0 ? m : 'view');
    if (m !== 'multi') MSEL.delete(L.id | 0);   // leaving multi drops the gathering
  };
  const vizMode = (L) => (modeOf(L) === 'view') ? 'view' : 'edit';
  // ── THE MULTI SELECTION ─────────────────────────────────────────────────
  // layer id -> Set of note indices. Transient for the same reason the mode is,
  // and re-found by IDENTITY after every write: normalize REPLACES every note
  // object and re-sorts, so an index is only good until the next `getCfg`.
  const MSEL = new Map();
  // ── THE VIEWPORT ────────────────────────────────────────────────────────
  // The drawing used to be the WHOLE part squeezed into one width and the
  // notes' own pitch range squeezed into one height: nothing outside either
  // could be reached, and on a long part a bar was a few pixels. It is a
  // WINDOW now — pan and resize in pitch, pan in time — with buttons, because
  // a drag on this canvas already means three other things.
  // Transient for the same reason the mode is (a field would be serialised and
  // the project would reload looking at a corner of itself, the `_soloLane`
  // rule).
  const VNAV = new Map();          // layer id -> {dy, rows, bar0}
  const vnavOf = (L) => VNAV.get(L && (L.id | 0)) || { dy: 0, rows: 0, bar0: 0 };
  const vnavSet = (L, v) => {
    if (!L) return;
    const cur = vnavOf(L), nx = Object.assign({}, cur, v);
    if (!nx.dy && !nx.rows && !nx.bar0) VNAV.delete(L.id | 0);   // 0 is neutral, negative is a zoom
    else VNAV.set(L.id | 0, nx);
  };
  // HOW MUCH OF A PART IS ON SCREEN AT ONCE. Four bars to a phone's width is
  // the stated floor — below that a bar is too narrow to place a note in —
  // and a wider screen simply shows more of the part rather than the same
  // four blown up.
  const viewBarsMax = () => (window.innerWidth <= 540) ? 4 : 8;
  const mselOf = (L) => MSEL.get(L && (L.id | 0)) || null;
  const mselSet = (L, set) => {
    if (!L) return;
    if (set && set.size) MSEL.set(L.id | 0, set); else MSEL.delete(L.id | 0);
  };
  // DOES THE PICTURE FOLLOW WHAT PLAYS? The record DRAWN and the window it is
  // drawn OVER have to be the same length, and only one of the two modes gets
  // that for free. VIEW follows the sounding part, so the sounding window is
  // right by construction. EDIT pins the EDITED record — and when another part
  // is sounding, that part's pass is a different length: the picture laid a
  // 5-bar record across a 4-bar window (measured: ruler 4, 27 notes of a 5-bar
  // record) and re-drew itself every time the arrangement moved, reported as
  // "the visualization was totally different when it cycled back and playback
  // wasn't lining up with it". Held at its OWN cycle instead, with no playhead
  // — nothing is playing that record, so a sweep across it would be a claim
  // that is false. ONE definition, two consumers (the draw and the sweep):
  // two answers to this is how they come to disagree.
  // `pi` — the part the caller ALREADY resolved (`cycleWindowAt` hands it out).
  // Preferred over re-deriving from `at`, which for a window's snapped `cs` can
  // answer the previous part (see the note in `cycleWindowAt`).
  const vizFollows = (L, E, cfg, at, pi) => {
    if (vizMode(L) === 'view') return true;
    if (!(Number.isFinite(L && L.partFor) && (L.parts || L.partAll))) return true;
    if (Number.isFinite(pi) && pi >= 0) return (pi | 0) === (L.partFor | 0);
    try {
      const w = (typeof _ambPartChordAt === 'function') ? _ambPartChordAt(E, cfg, at) : null;
      if (w && Number.isFinite(w.pi)) return (w.pi | 0) === (L.partFor | 0);
    } catch (e) {}
    return true;
  };
  // FOLLOWING PLAYBACK, THE PICTURE MAY BE ANOTHER PART'S RECORD (cv._vmOther,
  // stamped by drawPartViz). An edit gesture there must refuse AND name the
  // way in — the hit boxes index into the DRAWN record, not the edited one.
  function vmRefuse(cv) {
    if (!cv || cv._vmOther == null) return false;
    let nm = 'Part ' + ((cv._vmOther | 0) + 1);
    try {
      if (typeof _ambPartLabel === 'function' && typeof _masterEng !== 'undefined')
        nm = _ambPartLabel(_masterEng.getCfg(), cv._vmOther | 0) || nm;
    } catch (e) {}
    try {
      if (typeof showToast === 'function') showToast(
        'Following playback \u2014 this drawing is \u201c' + nm + '\u201d\u2019s record. ' +
        'Press \u270e Edit to hold the part you are editing, or pick \u201c' + nm +
        '\u201d in the part strip to edit this one.');
    } catch (e) {}
    return true;
  }
  // THE FORM SWITCH — a segmented pair, both names visible, on the surface's
  // own footer in BOTH forms so it is found from either side. Destructive in
  // both directions (see the handler), which is why it is buttons rather than a
  // <select>: a picker that has to be put back when a confirm is declined is a
  // control fighting its own dialog.
  function formSegHtml(L) {
    const f = V2.formOf(L);
    return '<span class="ambient-seg-row v2-formseg">' +
      [['roll', '\u2317 Roll', 'Notes with their own time, pitch and length \u2014 a piano roll.'],
       ['steps', '\u25a6 Steps', 'A grid of on/off steps \u2014 arps and drum programming.']]
        .map(([v, lab, why]) => '<button type="button" class="ambient-seg v2-formbtn' +
          (f === v ? ' on' : '') + '" data-form="' + v + '" title="' + esc(why) +
          '" aria-pressed="' + (f === v ? 'true' : 'false') + '">' + lab + '</button>').join('') +
      '</span>';
  }
  // ▦ IN BLOCKS OF 16, CELLS AND THEIR NOTE LABELS INTERLEAVED. The cell grid
  // and the note row are two `--eucols` grids that WRAP independently (16 per
  // row — no sideways scroll, UI rule 1), so on a 32-step part the labels for
  // steps 1-16 rendered UNDER the cells for 17-32 and every name sat beside the
  // wrong step. v1's "the same `--eucols` so a label sits under its step" only
  // holds while there is ONE row. Chunking keeps the pairing at any length.
  // `data-ci` STAYS ABSOLUTE — the delegated handlers index the store by it —
  // so only the markup is sliced, exactly the chord-matrix doctrine.
  function stepBlocksHtml(L) {
    const r = L.part.rhythm || {}, st = Math.max(1, r.steps | 0);
    const cells = viewCells(L);
    const pitched = !!(L.part.pitch && L.part.pitch.kind === 'drawn');
    const PER = 16;
    let h = '';
    for (let b0 = 0; b0 < st; b0 += PER) {
      const n = Math.min(PER, st - b0);
      h += '<div class="v2-stepblock">' +
        '<div class="ambient-slice-grid ambient-euclid-cells v2-cells" style="--eucols:' + n + '">' +
          Array.from({ length: n }, (_, k) => { const i = b0 + k;
            return '<button type="button" class="ambient-slice-cell ambient-euclid-cell v2-cell' +
              (cells[i] ? ' on' : '') + '" data-ci="' + i + '" aria-pressed="' +
              (cells[i] ? 'true' : 'false') + '" title="Step ' + (i + 1) + ' of ' + st + '">' +
              (i + 1) + '</button>'; }).join('') +
        '</div>' +
        (pitched
          ? '<div class="ambient-euclid-notes v2-notes" style="--eucols:' + n + '">' +
              Array.from({ length: n }, (_, k) => { const i = b0 + k; const on = !!cells[i];
                // A SILENT step's label is DISABLED — editing the note of a step
                // that does not sound stores a value with no audible effect.
                return '<button type="button"' + (on ? '' : ' disabled') +
                  ' class="ambient-euclid-notelbl v2-note' + (on ? ' set' : ' off') +
                  '" data-ci="' + i + '" title="Step ' + (i + 1) +
                  (on ? ' \u2014 tap to change the note' : ' (silent \u2014 turn the step on above)') +
                  '">' + (on ? esc(degLabel(L, i)) : '\u00b7') + '</button>'; }).join('') +
            '</div>'
          : '') +
      '</div>';
    }
    return h;
  }
  // ▦ THE SEQUENCER SURFACE. The kit's eight lanes or the single pitched row,
  // decided by the VOICE exactly as the Pattern tab decides it — a drum kit has
  // no pitch rule to speak of, so its lanes ARE its pitches.
  function stepsFormHtml(L) {
    const kit = ((L.instrument && L.instrument.voice) || 'synth') === 'kit';
    // …WEARING THE PART IT IS FOR. The roll's note events carry their part's
    // hue; a step IS this form's note event, so it carries the same one — "a
    // part reads as the same part wherever it appears". Stamped on the WRAPPER
    // rather than per cell: one attribute, and the palette stays a single
    // definition in the stylesheet (`--pt1`…`--pt8`) with no JS copy.
    // NOT followed to whatever is playing — this form has no View mode, so the
    // grid is always the record you are editing, and `L.partFor` is the honest
    // answer. A layer that is not per-part has no part identity for its
    // content, so it keeps the grid's own default rather than borrowing a hue
    // that would assert something false.
    const pAttr = (Number.isFinite(L.partFor) && typeof _ambPartAttr === 'function')
      ? _ambPartAttr(L.partFor | 0) : '';
    return '<div class="v2-partviz v2-partsteps">' +
      (kit
        ? '<div class="v2-stepsgrid v2-stepslanes"' + pAttr + '>' + lanesHtml(L) + '</div>'
        : '<div class="v2-stepsgrid"' + pAttr + '>' + stepBlocksHtml(L) + '</div>') +
      '<span class="v2-vizfoot">' +
        '<span class="v2-vizlab v2-stepslab ambient-hint"></span>' +
        // ↻ BACK TO THE GENERATED PATTERN. The roll's take bar (🎲/🔒/💾) is
        // deliberately NOT here — those write a take down as NOTES, which is
        // the other form's material, and 🔒 would fight the form outright. But
        // ↻ is the only way back from a hand-drawn grid, so it has to come
        // across: without it, drawing one cell was one-way. Same class and the
        // same delegated handler as the Pattern tab's, and `applyGate` shows it
        // only once there is an edit to undo.
        '<button type="button" class="ambient-regen v2-regen" ' +
          'title="Back to the generated pattern \u2014 clears your edits">\u21bb</button>' +
        formSegHtml(L) +
        // THE SAME GRID CONTROL AS THE ROLL, and the same field: one standard,
        // stated per BAR, so the number means the same thing on a 1-bar part
        // and a 5-bar one and the cycle is always a whole multiple of it.
        '<label class="v2-gridsel"><span>Grid</span><select class="ambient-select v2-gridpick" ' +
          'title="How finely this bar is divided \u2014 the cell count is this times the part\u2019s bars.">' +
          V2.GRIDS.map(([v, lab]) => '<option value="' + v + '"' +
            (v === V2.gridPerBar(L) ? ' selected' : '') + '>' + lab + '</option>').join('') +
        '</select></label>' +
      '</span>' +
    '</div>';
  }
  // …AND WHAT THE SEQUENCER'S READOUT SAYS. The roll's line names the record
  // and how to edit it; this names the grid the same way. An EMPTY grid is
  // silence, and silence is indistinguishable from a broken control unless it
  // says so — the Pattern tab's hint learned that and this inherits it.
  // THE FIRST TOKEN OF EVERY CONTENT READOUT. `Static` or `Live`, with the
  // reasons spelled out — the reason is the useful half, and a tooltip is not
  // where it belongs (the documented "a `title` a phone NEVER SHOWS" rule).
  function liveTxt(L, cfg) {
    let lv = { live: false, why: [] };
    // NOT a silent catch: a throw here reads as "everything is Static", which
    // is a plausible-looking answer and therefore the worst kind of failure.
    try { lv = V2.liveness(L, cfg) || lv; }
    catch (e) { try { console.warn('[v2] liveness failed', e && e.message); } catch (x) {} }
    return lv.live ? ('Live \u2014 ' + lv.why.join(' \u00b7 ')) : 'Static';
  }
  function stepsSync(host, L) {
    const lab = host.querySelector('.v2-stepslab'); if (!lab) return;
    const p = L.part, r = p.rhythm || {};
    const kit = ((L.instrument && L.instrument.voice) || 'synth') === 'kit';
    const st = Math.max(1, r.steps | 0);
    const bars = +p.bars || 1;
    const gname = (V2.GRIDS.find((g) => g[0] === V2.gridPerBar(L)) || [0, '?'])[1];
    let on = 0;
    if (kit) on = (r.lanes || []).reduce((a, row) => a + (row || []).filter(Boolean).length, 0);
    else on = viewCells(L).reduce((a, c) => a + (c ? 1 : 0), 0);
    const edited = kit ? (r.lanes || []).some((row) => (row || []).some(Boolean)) : (r.kind === 'drawn');
    lab.style.color = on ? '' : '#f6ad55';
    let cfgS = null; try { cfgS = _cfgOf(); } catch (e) {}
    lab.textContent = !on
      ? 'empty \u2014 this layer is silent. ' + (kit ? 'Tap a lane\u2019s steps.' : 'Raise How many, or tap steps.')
      : (liveTxt(L, cfgS) + ' \u00b7 ' +
         on + (kit ? ' hits' : ' of ' + st) + ' \u00b7 ' + (Math.round(bars * 100) / 100) +
         ' bar' + (bars === 1 ? '' : 's') + ' \u00b7 ' + gname +
         (edited ? ' \u00b7 yours' : ' \u00b7 from the rules') +
         ' \u00b7 tap a step to toggle it');
  }
  function partVizHtml(L) {
    const cf = capFace(L);
    // THE TAKE BAR lives INSIDE the viz block, not in an `.ambient-ctrl` — the
    // same reason the canvas does: it must be visible under every tab of the
    // sheet, because it acts on the picture rather than on one setting. It is
    // also why New take and Lock are HERE and nowhere else: two surfaces for
    // one action is the duplication this file keeps paying for.
    // THE PLAYHEAD IS ITS OWN CANVAS. Redrawing the roll every frame would
    // mean a `notesFor` call per frame per card — the drawing is generated, not
    // stored — so the sweep and the lit notes go on a transparent overlay that
    // costs a clear, a line and a few rects.
    const vm = vizMode(L), vm2 = modeOf(L);
    // ▦ STEPS — the sequencer takes the line instead of the roll. Deliberately
    // NOT both: a roll under the grid would be a second picture of one thing,
    // and the grid IS the material in this form (the roll's equivalent view is
    // one press away by switching form). The cells, the note row and the drum
    // lanes are the SAME builders the Pattern tab uses and the SAME delegated
    // handlers — moving markup, not writing a second editor — and the Pattern
    // tab's copies are gated off (`form:roll`) so they can never both show.
    if (V2.formOf(L) === 'steps') return stepsFormHtml(L);
    return '<div class="v2-partviz"><canvas class="v2-vizcv" height="84"></canvas>' +
      '<canvas class="v2-vizph" aria-hidden="true"></canvas>' +
      // THE NOTE EDITOR OPENS HERE — directly under the drawing it edits, so
      // the picture stays visible while you move the note (a dialog over the
      // top hid the one thing you are editing against).
      neHtml() +
      // ── NAVIGATING THE WINDOW ───────────────────────────────────────────
      // BUTTONS, not a drag: every drag on this canvas already means
      // something (move a note, resize it, draw one, gather them), so the one
      // gesture left is a press. The pitch pair PANS, the ± pair RESIZES, and
      // ◀ ▶ walk a long part — each one press, which is also what makes them
      // usable on a phone, where a two-finger gesture would fight the page's
      // own scroll.
      '<span class="v2-vnav">' +
        '<button type="button" class="ambient-seg v2-nav" data-nav="up" title="Look higher \u2014 pan the pitch window up">\u25b2</button>' +
        '<button type="button" class="ambient-seg v2-nav" data-nav="dn" title="Look lower \u2014 pan the pitch window down">\u25bc</button>' +
        '<button type="button" class="ambient-seg v2-nav" data-nav="grow" title="Taller \u2014 show more pitches at once">\uff0b</button>' +
        '<button type="button" class="ambient-seg v2-nav" data-nav="shrink" title="Shorter \u2014 show fewer pitches">\u2212</button>' +
        '<button type="button" class="ambient-seg v2-nav v2-navx" data-nav="left" title="Earlier bars">\u25c0</button>' +
        '<button type="button" class="ambient-seg v2-nav v2-navx" data-nav="right" title="Later bars">\u25b6</button>' +
        '<button type="button" class="ambient-seg v2-nav v2-navfit" data-nav="fit" title="Fit the window back to the notes">\u2302</button>' +
        '<span class="ambient-hint v2-navlab"></span>' +
      '</span>' +
      // THE READOUT AND THE MODE SHARE A LINE — both are about the drawing, and
      // a two-state preference does not earn a row of its own.
      '<span class="v2-vizfoot">' +
        '<span class="v2-vizlab ambient-hint"></span>' +
        // ONE CONTROL FOR ONE AXIS. Two buttons stated two switches for what
        // is really four states of the same question — and three of the four
        // combinations they offered meant the same thing, since drawing and
        // gathering both imply you are working on the record you are editing.
        // A <select> is safe HERE: a mode change redraws the CANVAS and never
        // rebuilds the card, so the picker cannot be replaced under an open
        // list (the documented trap that made the euclid page bar use buttons).
        '<label class="v2-modesel"><span>Mode</span>' +
          '<select class="ambient-select v2-modepick" title="What the drawing is showing, and what a tap does.">' +
            [['view', '\ud83d\udc41 View', 'follow what plays \u2014 a tap selects a bar'],
             ['edit', '\u270e Edit', 'hold the part you are editing \u2014 a tap opens a note'],
             ['draw', '\u270e Draw', 'a tap on empty space adds a note'],
             ['multi', '\u2b1a Multi', 'tap notes to gather, then move or resize them together']]
              .map(([v, lab, why]) => '<option value="' + v + '"' + (vm2 === v ? ' selected' : '') +
                ' title="' + esc(why) + '">' + lab + '</option>').join('') +
          '</select></label>' +
        // THE GRID EVERY HAND EDIT SNAPS TO — a note VALUE, so it reads the
        // same on a 1-bar part and a 5-bar one. It sits on the drawing's own
        // line because it is a property of EDITING the picture, not of the
        // part: nothing about what plays changes when you move it.
        '<label class="v2-gridsel"><span>Grid</span><select class="ambient-select v2-gridpick" ' +
          'title="What the drag, the resize, the add and the editor\u2019s Position and Length all snap to.">' +
          V2.GRIDS.map(([v, lab]) => '<option value="' + v + '"' +
            (v === V2.gridPerBar(L) ? ' selected' : '') + '>' + lab + '</option>').join('') +
        '</select></label>' +
        formSegHtml(L) +
      '</span>' +
      // ⬚ MULTI — what is gathered, and the transforms that apply to ALL of it.
      // Rendered only in multi mode and only once something is gathered: a row
      // of steppers over an empty selection is a control that cannot act.
      // BUTTONS AS WELL AS THE DRAG, deliberately — the drag is the gesture the
      // request asked for, and a stepper is what makes it exact on a phone and
      // what a probe can drive; both go through the ONE writer (`multiApply`).
      '<span class="v2-multibar" hidden>' +
        '<span class="ambient-hint v2-multin"></span>' +
        '<button type="button" class="ambient-seg v2-mact" data-ma="t-1" title="Move all earlier by one grid cell">\u2190</button>' +
        '<button type="button" class="ambient-seg v2-mact" data-ma="t+1" title="Move all later by one grid cell">\u2192</button>' +
        '<button type="button" class="ambient-seg v2-mact" data-ma="m+1" title="Move all up a half-step">\u2191</button>' +
        '<button type="button" class="ambient-seg v2-mact" data-ma="m-1" title="Move all down a half-step">\u2193</button>' +
        '<button type="button" class="ambient-seg v2-mact" data-ma="d-1" title="Shorten all by one grid cell">\u21e4</button>' +
        '<button type="button" class="ambient-seg v2-mact" data-ma="d+1" title="Lengthen all by one grid cell">\u21e5</button>' +
        '<button type="button" class="ambient-seg v2-mact v2-mclear" data-ma="clear" title="Gather nothing">\u2715</button>' +
      '</span>' +
      '<span class="ambient-seg-row v2-takebar">' +
        '<button type="button" class="ambient-seg v2-newtake"' +
          ' title="Roll this part again. Preview never re-rolls on its own, so the take you are hearing stays until you press this.">🎲 New take</button>' +
        // TWO STATES, TWO SENTENCES. It read "❄ Re-take live" on a fixed part,
        // which sounds like the way BACK to Generated — it is not (that is the
        // Source select); it discards these notes and locks a fresh roll. And
        // both states shared ONE title, so a fixed part showed the live
        // state's explanation. Say what the press will do, in each state.
        '<button type="button" class="ambient-seg v2-capture" title="' + esc(cf.title) + '">' +
          cf.txt + '</button>' +
        // A TAKE YOU LIKE IS WORTH KEEPING, and the next press of ⟳ replaces
        // it — so the way to keep it sits right beside the thing that would
        // destroy it. BOTH STATES: it used to render only on a written part, so
        // a generated take could reach the bank only by locking it first — i.e.
        // the one thing you might not want to do to a take you want to keep.
        (((L.part.kind === 'recorded' && (L.part.notes || []).length) || L.part.kind === 'live')
          ? '<button type="button" class="ambient-seg v2-savetake" title="Keep the take shown above in the bank, under a name — mappable to any part or chord, on this layer or another. The part itself is left as it is: a generated one keeps generating.">\ud83d\udcbe Save this take</button>'
          : '') +
        // COMMANDS OVER THE NOTES YOU HAVE. A menu, not a row: the set is
        // meant to grow, and the take bar is already four buttons wide. It is
        // always PRESENT (a control you cannot find is a control you do not
        // have) and refuses with an explanation on a live part, the same
        // pattern the no-op rhythm tabs use.
        '<button type="button" class="ambient-seg v2-tform" title="Rework the notes you already have — reverse, shuffle, and more. Tap bars in the drawing first to rework just those.">\u2728 Transform\u2026</button>' +
      '</span></div>';
  }
  // ── WHICH CHORD IS WHERE ──────────────────────────────────────────────
  // The ruler counted BARS and said nothing about the harmony those bars sit
  // over — and with a CADENCE a chord is not a bar: \u00bd \u00b7 1 \u00b7 \u00bd \u00b7 2 is four
  // chords across four bars and not one of them starts where a bar count
  // implies. Walked with `_ambChordSpanAt`, the chord clock's OWN span
  // function, and NEVER a second walk of the chord lengths: that clock has
  // four branches (section-bound parts, part repeats, salted lengths, the
  // passes grid) and re-deriving edges beside it is exactly how the Scheduler
  // lane once came to lie about the harmony.
  function chordMarks(E, cfg, t0, cyc) {
    if (typeof _ambChordSpanAt !== 'function' || !(cyc > 0)) return null;
    if (!cfg || !cfg.prog || !cfg.prog.on) return null;
    const out = [];
    let t = t0 + 1e-4;
    const stop = t0 + cyc - 1e-3;
    for (let i = 0; i < 64 && t < stop; i++) {
      let sp = null;
      try { sp = _ambChordSpanAt(E, cfg, t); } catch (e) { break; }
      if (!sp || !(sp.end > sp.start)) break;
      // A HANG SHARES ITS NEIGHBOUR CHORD'S SPAN so the choke can hold one
      // chord across it. That merge is for the CHOKE and never for a picture
      // — the progress bars trim it for the same reason.
      let vis = sp;
      try { if (typeof _ambSpanTrimHang === 'function') vis = _ambSpanTrimHang(E, cfg, sp) || sp; } catch (e) {}
      let nm = '';
      // THE SOUNDING chord, not the written one: order-perm, alts, take-reroll
      // and the key transpose all resolve at READ time, so `prog.chords[i]`
      // names a chord the ear is not hearing (measured elsewhere: the header
      // read "F" while the engine played D).
      try { nm = _ambChordShort(_ambProgSoundAt(E, cfg.prog, sp.step, (sp.start + sp.end) / 2)) || ''; } catch (e) {}
      if (vis.end > t0 && vis.start < t0 + cyc) out.push({
        f0: Math.max(0, (vis.start - t0) / cyc),
        f1: Math.min(1, (vis.end - t0) / cyc),
        nm: nm
      });
      t = sp.end + 1e-4;
    }
    return out.length ? out : null;
  }
  // WHERE THAT WALK STARTS. Playing, the drawn window IS the sounding one and
  // its own start is the answer. Stopped there is no clock, so the walk is
  // measured from the progression's own origin — and for a PER-PART layer
  // that origin names the WRONG PART: with part 2 selected, walking from the
  // top draws part 1's chords under part 2's notes. The part's first pass is
  // found by asking the ONE resolver (`_ambPartChordAt`) span by span rather
  // than by summing chord lengths, so a cadence, a chain, a hold and a passes
  // grid all come along for free.
  let _cAnchorMemo = null;
  function chordAnchor(E, cfg, L, playing, cs) {
    if (playing) return cs;
    // THE CHORD CLOCK'S OWN ORIGIN, spelled exactly as `_ambChordSpanAt`
    // spells it. Taking `_progAnchor ?? 0` while the walk below runs on
    // `_progAnchor ?? _playStartAt ?? 0` puts the two in DIFFERENT clocks the
    // moment the transport has been stopped — `_progAnchor` is cleared there
    // and `_playStartAt` is not — and the picture then jumps after a stop
    // (measured: the same anchor resolved to the Verse's chords instead of the
    // Chorus's). One spelling, or they disagree exactly when nothing looks
    // wrong.
    const org = Number.isFinite(E && E._progAnchor) ? E._progAnchor
      : (Number.isFinite(E && E._playStartAt) ? E._playStartAt : 0);
    const pi = Number.isFinite(L && L.partFor) ? (L.partFor | 0) : -1;
    if (pi < 0 || typeof _ambPartChordAt !== 'function') return org;
    // MEMOISED, because the walk below is O(chords before this part) and every
    // expanded card asks it on every draw — measured 63ms PER CARD on a
    // 16-chord arrangement with the layer on the eighth part, which would land
    // on the rAF sweep as well as on an edit. The answer only moves when the
    // progression's shape or the clock's origin does, and both are in the key.
    const p9 = (cfg && cfg.prog) || {};
    const sig = pi + '|' + org + '|' + ((cfg && cfg.bpm) || 0) + '|' +
      (p9.chords || []).map(c => (c && c.bars) || 0).join(',') + '|' +
      (p9.parts || []).map(x => (x && x.len) | 0).join(',') + '|' +
      (E && E._barGridAnchor || 0) + '|' + (E && E._playStartAt || 0);
    if (_cAnchorMemo && _cAnchorMemo.sig === sig) return _cAnchorMemo.at;
    let t = org + 1e-4;
    for (let i = 0; i < 96; i++) {
      let sp = null;
      try { sp = _ambChordSpanAt(E, cfg, t); } catch (e) { break; }
      if (!sp || !(sp.end > sp.start)) break;
      let w = null;
      try { w = _ambPartChordAt(E, cfg, (sp.start + sp.end) / 2); } catch (e) {}
      if (w && (w.pi | 0) === pi) { _cAnchorMemo = { sig: sig, at: sp.start }; return sp.start; }
      t = sp.end + 1e-4;
    }
    _cAnchorMemo = { sig: sig, at: org };
    return org;
  }
  function drawPartViz(card, L, E) {
    const host = card && card.querySelector('.v2-partviz'); if (!host) return;
    // ▦ STEPS has no canvas — the same entry point paints its readout instead,
    // so every caller that repaints the Content line keeps working unchanged
    // (there are a dozen, and a second entry point is how two surfaces drift).
    if (V2.formOf(L) === 'steps') { try { stepsSync(host, L); } catch (e) {} return; }
    const cv = host.querySelector('.v2-vizcv'), lab = host.querySelector('.v2-vizlab');
    if (!cv || !cv.getContext) return;
    const w = Math.max(80, Math.round(cv.clientWidth || host.clientWidth || 300));
    const dpr = Math.min(3, (window.devicePixelRatio || 1));
    const phone = window.innerWidth <= 540;
    let cfg = null; try { cfg = E.getCfg(); } catch (e) {}
    if (!cfg) return;
    // HOW MANY BARS THE DRAWN WINDOW IS, when the window is a bar span of the
    // arrangement rather than this record's own cycle. Null = ask the record
    // (`L.part.bars`), which is what every non-per-part case wants and what
    // keeps the RATE multiplier meaning what it says: `cycleSec` divides by it,
    // so deriving bars from seconds would redraw the ruler on a sped-up layer.
    let cyc = 2, cycBars = null, notes = [];
    try { cyc = Math.max(0.05, V2.cycleSec(L, cfg)); } catch (e) {}
    // DRAW THE CYCLE THE PREVIEW PLAYED, not cycle 0. A live part re-rolls per
    // cycle, so a fixed drawing disagrees with every press. The remembered
    // cycle is used only while the part still matches the one it was taken
    // from — change a knob and it falls back to a representative cycle, which
    // is honest rather than stale.
    let cs = 0, fromPv = false, csPv = false;
    try {
      const pv = V2.previewCycle && V2.previewCycle();
      if (pv && pv.id === (L.id | 0) && pv.sig === V2.partSig(L) && Number.isFinite(pv.at)) {
        // The anchor is still the right one to draw against (it is what decides
        // WHICH CHORD the take was rolled over), but the badge may not be: a
        // take rolled since that preview has not been previewed, and saying it
        // was is exactly the kind of stale readout this file keeps paying for.
        cs = pv.at; csPv = true; fromPv = (pv.take === V2.pinSig(V2.pinOf(L)));
      }
    } catch (e) {}
    // A PART WHOSE CONTENT IS THE CHANGES IS DRAWN FROM THE FIRST CHANGE.
    // Every preview anchors at the press, so for Groundwork the picture landed
    // on a different point of the progression each time and the note events
    // were redrawn — reported as "Preview keeps making a new part". Its
    // content is not a roll to be remembered, it is the changes, so the honest
    // anchor is where they START: the chord clock's own origin.
    if (L.part.kind === 'live' && (L.part.rhythm || {}).kind === 'ground') {
      cs = Number.isFinite(E._progAnchor) ? E._progAnchor : 0;
      fromPv = false;
    }
    // WHILE PLAYING, DRAW WHAT IS SOUNDING. A live part re-rolls every cycle,
    // so the remembered preview take is NOT what you are hearing — lighting its
    // notes as the playhead passed them would light the wrong ones. The emit's
    // own cycle math (`startAt + c * cyc`), so the picture and the ear are the
    // same cycle by construction.
    let playing = false, wpi = -1;   // …and WHICH PART that sounding window is
    try {
      const stp = E.timer && E._v2Phase && E._v2Phase['v2:' + (L.id | 0)];
      // THE CYCLE BEING HEARD, not the one being scheduled — on the shell's
      // broadcast those are most of a second apart, so the roll would flip to
      // the next cycle well before you heard it. Asked of the TICK'S OWN grid
      // (`cycleWindowAt`), so a per-part layer draws its PART PASS — its own
      // length — rather than the edited record's cycle: reported as "the
      // visualization is not resized by part".
      const nowT = audibleNow();
      if (stp && Number.isFinite(stp.startAt) && nowT >= stp.startAt) {
        const wnd = V2.cycleWindowAt(L, E, cfg, nowT, stp);
        // …ONLY IF THIS PICTURE IS THE ONE SOUNDING (see `vizFollows`). When it
        // is not, every value below is left exactly as the stopped path set it
        // — the edited record over its OWN cycle, take pinned, no choke, no
        // sweep — which is the honest picture of a record nothing is playing.
        if (vizFollows(L, E, cfg, wnd.cs, wnd.pi)) {
        cs = wnd.cs; cyc = wnd.cyc; wpi = Number.isFinite(wnd.pi) ? (wnd.pi | 0) : -1;
        // A PART PASS IS A BAR SPAN, so the ruler can be told how many bars it
        // is showing. Without this the ruler, the readout and the bar-tap
        // geometry all read `L.part.bars` — the record being EDITED — while
        // the NOTES were drawn across the window actually sounding: with a
        // 5-bar part A selected and a 4-bar part B playing, the drawing put
        // four bars of music under a five-bar ruler and the readout said
        // "5 bars · 8s", which is 4 bars at 120bpm — the line contradicting
        // itself. Reported as "part 2 renders as 5 bars".
        if (wnd.part && wnd.bars > 0) cycBars = wnd.bars;
        fromPv = false; playing = true;
        }
      }
    } catch (e) {}
    // ── STOPPED, DRAW THE RECORD OVER THE CHORDS IT WILL PLAY OVER ────────
    // A remapped pitch is a function of the chord AT THE NOTE'S OWN ONSET, and
    // the onset is `cs + n.at` — so with `cs` at zero a per-part record was
    // resolved against the FIRST chord of the whole progression instead of
    // against its own part's, and every note sat on a different row from the
    // one it takes when that part comes round. Reported as "the note is in a
    // different place on playback and when stopped", and on a chordlocked part
    // it is many semitones, not one.
    //
    // It is also the picture contradicting itself: the ruler's chord band is
    // drawn from `chordAnchor` — the part's own first pass — so the chords
    // NAMED above the notes were not the chords the notes were resolved
    // against. One anchor for both is what makes the drawing coherent, and it
    // is the same answer playback gives.
    if (!playing && !csPv) {
      try { cs = chordAnchor(E, cfg, L, false, cs); } catch (e) {}
    }
    // THE ANCHOR THE PICTURE WAS DRAWN AT, recorded on the canvas. A drawing
    // is only honest about a part built on the changes if it starts where the
    // changes do, and the note COUNT cannot show that — rotating a progression
    // keeps the total identical (measured).
    cv._cs = cs;
    // WHOSE RECORD IS DRAWN. Following playback, the picture can be ANOTHER
    // part's record — mark it on the canvas, because an edit gesture must then
    // REFUSE: the hit boxes index into the DRAWN record, and writing those
    // indices into the EDITED one is corruption wearing an edit's clothes.
    // …AND WHICH PART IT BELONGS TO, so the NOTE EVENTS can be drawn in that
    // part's own colour. This is the picture's half of "a part reads as the
    // same part wherever it appears": with the roll following playback, the
    // notes changing hue IS the answer to "why does this look different now".
    // A layer that is not per-part has no part identity for its content — one
    // content everywhere — so it keeps the default purple rather than
    // borrowing a hue that would mean nothing.
    cv._drawnPi = -1;
    try {
      if (Number.isFinite(L.partFor) && (L.parts || L.partAll)) {
        // `wpi` — the window's OWN answer, not `_ambPartChordAt(cs)`: `cs` is
        // snapped and can land one ULP short of the boundary it names, which
        // painted the notes in the PREVIOUS part's hue for a whole pass.
        cv._drawnPi = (playing && vizMode(L) === 'view' && wpi >= 0)
          ? wpi
          : (L.partFor | 0);
        if (!(cv._drawnPi >= 0)) cv._drawnPi = -1;
      }
    } catch (e) { cv._drawnPi = -1; }
    const ptCol = (cv._drawnPi >= 0 && typeof _ambPartColor === 'function')
      ? _ambPartColor(cv._drawnPi) : '';
    // The palette is HEX (one definition, in the stylesheet), and a note wants
    // a translucent fill under a solid edge — so it is converted here rather
    // than kept as a second set of rgba() literals that could drift from it.
    const _hexA = (hx, a) => {
      const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hx || '').trim());
      if (!m) return '';
      const n = parseInt(m[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    };
    const NOTE_FILL = _hexA(ptCol, 0.5) || 'rgba(159,122,234,0.55)';
    const NOTE_EDGE = ptCol || '#d6bcfa';
    // ⬚ WHAT IS GATHERED, for this draw. Only in multi mode: the set survives a
    // mode change only as far as `setMode`, which drops it, so this is belt.
    const MGRP = (modeOf(L) === 'multi') ? mselOf(L) : null;
    cv._vmOther = null;
    try {
      if (playing && vizMode(L) === 'view' && Number.isFinite(L.partFor) &&
          (L.parts || L.partAll)) {
        const pi2 = wpi;
        if (pi2 >= 0 && pi2 !== (L.partFor | 0) &&
            ((L.parts && L.parts[String(pi2)]) || L.partAll)) cv._vmOther = pi2;
      }
    } catch (e) {}
    try {
      // …and WITHOUT the take pin while playing: the emitter draws from the
      // cycle index, so pinning here would draw a take nobody is hearing.
      // VIEW MODE DROPS THE EDIT PIN: `notesFor` then resolves which arrangement
      // part is sounding at this cycle and plays ITS record — the emitter's own
      // rule. EDIT keeps the pin, which is what lets you work on one part while
      // another one plays.
      const ask = () => (playing
        ? V2.notesFor(L, { E, cfg, key: 'v2:' + (L.id | 0), cycleStart: cs, cycleSec: cyc, pi: wpi })
        : V2.withTake(V2.pinOf(L), () =>
            V2.notesFor(L, { E, cfg, key: 'v2:' + (L.id | 0), cycleStart: cs, cycleSec: cyc })));
      notes = ((playing && vizMode(L) === 'view') ? ask() : V2.withEdit(ask)) || [];
    } catch (e) { notes = []; }
    // `notesFor` returns ABSOLUTE times (cycleStart + offset), so a remembered
    // cycle start has to be subtracted back off before drawing.
    notes = notes.map(n => (n && Number.isFinite(n.at))
      ? { at: n.at - cs, freq: n.freq, durMs: n.durMs, nidx: n.nidx } : n);
    // THE PICTURE MUST AGREE WITH THE EAR. A note is released by the next
    // change unless the layer rings, so drawing its full length while the
    // choke cuts it is exactly the disagreement that reads as "notes are
    // getting cut off". Asked of the CHOKE ITSELF — a second copy of that rule
    // is how the two would drift — and only while playing, because it resolves
    // the boundary off the CLOCK and a stopped one is stale (the documented
    // audition-stub trap).
    if (playing && typeof window._ambNoteChoke === 'function') {
      notes = notes.map((n) => {
        if (!n || !(n.durMs > 0)) return n;
        try {
          const ms = window._ambNoteChoke('v2:' + (L.id | 0), cs + n.at, n.durMs, {});
          return (ms > 0 && ms < n.durMs) ? { at: n.at, freq: n.freq, durMs: ms, nidx: n.nidx } : n;
        } catch (e) { return n; }
      });
    }
    const played = notes.filter(n => n && n.freq > 0 && n.at >= -1e-6 && n.at < cyc);
    // QUANTIZED to 1/1024 semitone: these come out of log2(freq) and an
    // integer pitch lands at 71.00000000000001 as often as not — floor/ceil
    // then bump a row and the sticky window's fits-test flips, which was the
    // "grid resizes slightly after releasing a dragged note" (whether it
    // fired depended on WHICH note happened to be the extreme).
    const mids = played.map(n => Math.round((69 + 12 * Math.log2(n.freq / 440)) * 1024) / 1024);

    // ── THE PITCH AXIS IS A KEYBOARD ────────────────────────────────────────
    // It was a continuous squeeze of whatever range the take happened to span,
    // with no scale at all: you could see that one note was higher than
    // another and not WHICH note either of them was. The axis is SEMITONE
    // ROWS now, with a piano drawn down the left — the reading a piano roll
    // gives for free — so every event names its own pitch by where it sits.
    // THE CHORD BAND, when there is harmony to name. It takes a row of its
    // own ABOVE the bar numbers rather than sharing the gutter: a chord that
    // starts on a bar line — which is most of them — would otherwise print
    // its name straight over that bar's number. TOP is the ONE definition of
    // where the plot begins (`_pitchGeo.top`, `_plotGeo.top`, the playhead and
    // the ruler-tap test all read it), so growing it moves everything that
    // depends on it with no second number to keep in step.
    const cAt = (L.part && L.part.clock === 'free') ? 0 : chordAnchor(E, cfg, L, playing, cs);
    const cmarks = (L.part && L.part.clock === 'free') ? null : chordMarks(E, cfg, cAt, cyc);
    const CHT = cmarks ? 13 : 0;          // the chord band
    const TOP = 15 + CHT;                 // the ruler gutter
    const GUT = phone ? 24 : 28;          // the keyboard gutter — wide enough for "C4"
    const PC_BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
    let loM = 60, hiM = 71;
    if (mids.length) {
      loM = Math.floor(Math.min.apply(null, mids)) - 1;
      hiM = Math.ceil(Math.max.apply(null, mids)) + 1;
    }
    // AT LEAST AN OCTAVE of context: a two-note part squeezed to its own range
    // draws two enormous rows and says nothing about where they sit.
    if (hiM - loM < 11) { const c2 = (hiM + loM) / 2; loM = Math.round(c2 - 5.5); hiM = loM + 11; }
    // THE WINDOW IS STICKY — held EXACTLY while the same material's notes
    // still fit inside it, widened (never re-tightened) when one lands
    // outside, re-derived fresh only for NEW material (a kind flip, another
    // take). Without this, releasing a drag re-derived the range and the
    // canvas resized the moment a note landed on the old padding row
    // (measured 97 → 103px at release) — "the grid resizes after
    // interaction", the exact contract violation. The cost is cosmetic: a
    // note sitting on the held window's edge row has no empty row beyond it.
    try {
      const wsig = (L.part.kind || '') + ':' + ((L.part.take | 0) || 0);
      const held = WINHOLD.get(L.id | 0);
      // ── WHILE IT IS PLAYING, THE GRID DOES NOT MOVE ────────────────────
      // Stated as the contract: "the grid should never flinch". In 👁 View the
      // picture FOLLOWS playback and swaps to another part's record, so a
      // window derived from whatever is on screen grew the instant a part with
      // a wider span came round — measured mid-play, the canvas went 92px →
      // 127px and every row slid under the eye. Held verbatim while the
      // transport runs (and while a gesture is in flight, below): what does
      // not fit is CLIPPED, which the readout names, and ▲▼ ＋ − are there to
      // open the window when you want it open.
      if (held && E.timer) { loM = held.loM; hiM = held.hiM; }
      else if (held && held.sig === wsig) {
        const rawLo = mids.length ? Math.floor(Math.min.apply(null, mids)) : held.loM;
        const rawHi = mids.length ? Math.ceil(Math.max.apply(null, mids)) : held.hiM;
        if (rawLo >= held.loM && rawHi <= held.hiM) { loM = held.loM; hiM = held.hiM; }
        else if (rawHi - rawLo <= held.hiM - held.loM) {
          // A note past the window's edge SCROLLS the axis, it does not grow
          // it: while the material still fits the held row count, the window
          // SHIFTS by the overflow and the canvas height is byte-identical.
          // Growing here resized the drawing one row per ± Note press with a
          // note at the edge — the editor walking down the page under the
          // finger ("the +/- buttons should not resize"). Only material that
          // genuinely no longer fits the held size may widen it.
          if (rawHi > held.hiM) { hiM = rawHi; loM = rawHi - (held.hiM - held.loM); }
          else { loM = rawLo; hiM = rawLo + (held.hiM - held.loM); }
        }
        else { loM = Math.min(held.loM, loM); hiM = Math.max(held.hiM, hiM); }
      }
    } catch (e) {}
    // A DRAG MUST NOT RE-SCALE THE AXIS UNDER THE FINGER. The window follows
    // the notes' OWN range, so dragging one moves the very thing that defines
    // it: measured on a C4–C6 part, dragging the lowest note up walked `loM`
    // 59 → 71 and collapsed the canvas 181px → 109px, so every row slid under
    // the finger while the note's VALUE tracked it perfectly. Frozen for the
    // gesture, exactly as drawn, released on pointerup.
    if (DRAG && DRAG.id === (L.id | 0) && DRAG.win) { loM = DRAG.win.loM; hiM = DRAG.win.hiM; }
    // …and the sticky store records the EFFECTIVE window — after the freeze,
    // so a locked grab (whose kind flip changes the sig mid-gesture) files
    // the frozen window rather than a mid-drag re-derivation, and the
    // release draw finds exactly what was on screen.
    try {
      WINHOLD.set(L.id | 0, {
        sig: (L.part.kind || '') + ':' + ((L.part.take | 0) || 0),
        loM: loM, hiM: hiM });
    } catch (e) {}
    let rows = Math.max(1, hiM - loM + 1);   // `let` — the viewport below re-derives it
    // THE DRAWING GROWS WITH ITS RANGE rather than squeezing the rows to
    // nothing — the editor is in the page flow now, so height is a scroll
    // rather than a fold. Floors stay what they were (60 on a phone, 84
    // otherwise); a wide part is allowed up to ~2.5x that.
    // A ROW HAS TO BE TALL ENOUGH TO BE A KEY. Below ~7px the keyboard is a
    // smear of stripes and the C labels have nowhere to go, which is the
    // reading the axis exists for — so the row is the floor and the height
    // follows it, up to a cap past which a very wide part goes back to
    // squeezing (a 4-octave line is a picture of a shape, not of pitches).
    // WHICH KEY THE SELECTED NOTE IS ON. A tap on the gutter moves that note,
    // so the keyboard has to say where it currently sits — aiming at an
    // unmarked strip is guessing — and the SIZING reads it too (below).
    // …resolved from the DRAWN note itself (`nidx`), never from the stored
    // midi: the gutter rows are SOUNDING pitches and the store is not —
    // transpose, register and the harmony remap all sit between them, and a
    // stored-midi mark sat rows away from the block it claimed to name
    // ("not aligned to the highlighted note", with a screenshot). While a
    // note is DRAGGED the mark follows THAT note; otherwise the editor's.
    let selM = null;
    let selIdx = null;
    if (DRAG && DRAG.id === (L.id | 0) && DRAG.win) selIdx = DRAG.idx;
    else if (NE && NE.id === (L.id | 0) && L.part && L.part.kind === 'recorded' &&
             Array.isArray(L.part.notes) && L.part.notes[NE.idx]) selIdx = NE.idx;
    if (selIdx != null) {
      const dn = played.find((nn) => nn && nn.nidx === selIdx);
      if (dn && dn.freq > 0) selM = Math.round(69 + 12 * Math.log2(dn.freq / 440));
      else if (L.part && Array.isArray(L.part.notes) && L.part.notes[selIdx]) {
        selM = L.part.notes[selIdx].midi | 0;   // choked / outside the window
      }
    }
    // IN-SCALE KEYS ARE MARKED. The keyboard named every pitch and said
    // nothing about which of them BELONG — and it is a control now, so the
    // question "will this note fit" is asked at exactly the moment you aim.
    // Resolved at the drawing's own anchor, so a part or section key change
    // moves it. Null = no key and no source of its own, or a 12-tone scale:
    // lighting every key says as much as lighting none.
    let SPC = null;
    try { SPC = V2.scaleAt(E, cfg, cs, L); } catch (e) { SPC = null; }
    const base = phone ? 60 : 84;
    // ONE GEOMETRY, ALWAYS (2026-09-08, stated as the contract: "the grid
    // should never resize/jitter/shift before, during or after the user
    // interacts with it"). The rows used to GROW for editing — once when a
    // note was selected and again when one was grabbed — with an absorbing
    // scroll to hold the grabbed note under the finger, and every piece of
    // that dance was reported as the defect: the resize on click, every
    // other block shifting at the grab, the bearings lost mid-gesture. The
    // drawing's size now follows only its CONTENT (the note range); no
    // selection, grab or drag changes a pixel of it. The cost is stated and
    // accepted: a reading-size row (5/6px) is the drag resolution on a
    // mouse, and the gutter keys are small tap targets — the editor's ± Note
    // stepper remains the precision path.
    // …AND THEN THE USER'S OWN WINDOW ON TOP. The derivation above answers
    // "where is the material"; this answers "what do I want to look at", and
    // they are different questions — a note an octave above everything else
    // was unreachable, and there was no way to give a dense part more room.
    // Deliberately NOT the interaction-driven resize this file retired: an
    // explicit button is an act, not a side effect of touching a note.
    const nv = vnavOf(L);
    if (nv.rows) {
      const up = Math.ceil(nv.rows / 2), dn = nv.rows - up;
      hiM += up; loM -= dn;
    }
    if (nv.dy) { hiM += nv.dy; loM += nv.dy; }
    loM = clamp(Math.round(loM), 0, 124);
    hiM = clamp(Math.round(hiM), loM + 3, 127);
    rows = hiM - loM + 1;
    const rowT = phone ? 5 : 6;
    // THE CEILING MOVES WITH THE ASK. Growing the window under a fixed cap
    // would only make the rows thinner, which is the opposite of "show me
    // more" — so a window the user has expanded is allowed the height it
    // needs, and an untouched one keeps exactly the cap it had.
    const capH = nv.rows > 0 ? (phone ? 420 : 560) : (phone ? 190 : 240);
    const h = Math.max(base, Math.min(capH, Math.round(TOP + rows * rowT + 4)));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = '100%'; cv.style.height = h + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // THE PLAYHEAD OVERLAY IS CLEARED WHEN THE TRANSPORT IS NOT RUNNING. The
    // viz rAF stops re-arming on stop (by design), so its last frame would
    // otherwise sit there claiming a note is sounding.
    try {
      const ph0 = host.querySelector('.v2-vizph');
      if (ph0 && ph0.getContext && !playing && ph0._on) {
        const c0 = ph0.getContext('2d');
        c0.setTransform(1, 0, 0, 1, 0, 0);
        c0.clearRect(0, 0, ph0.width, ph0.height);
        ph0._on = false;
      }
    } catch (e) {}
    const rowH = (h - TOP) / rows;
    const yOf = (m) => TOP + (hiM - m) * rowH;          // the TOP of that row
    cv._pitchGeo = { loM: loM, hiM: hiM, rowH: rowH, top: TOP };
    const PLOT = w - GUT;                                // the notes' own width
    const free = L.part && L.part.clock === 'free';
    let latN = 0;   // the lattice the ruler DRAWS — published below, so a reader
                    // asks the picture what it drew rather than re-deriving it
    // THE WINDOW BEING DRAWN, not the record being EDITED — see `cycBars`.
    const barsF = Math.max(0.0625, cycBars || (L.part && L.part.bars) || 1);
    // ── THE VIEWPORT, IN TIME ───────────────────────────────────────────────
    // A long part squeezed into one width gives a bar a few pixels — too
    // narrow to place a note in, let alone read. At most `viewBarsMax()` bars
    // are on screen (four to a phone's width, more on a wider screen) and the
    // rest is reached with the ◀ ▶ buttons. A part that FITS is drawn exactly
    // as before: `VSC` is 1 and `F0` is 0, so every mapping below is the
    // identity it was and nothing about a short part moves.
    //
    // NOTE this is a deliberate carve-out from UI rule 1 (no horizontal
    // scrolling): the rule is about CONTROLS overflowing their row, and the
    // answer here is not a scrollbar — the canvas keeps its width and the
    // drawing pans INSIDE it, so the keyboard gutter stays pinned where a
    // scrolled canvas would have carried it off screen.
    const VB = free ? barsF : Math.min(barsF, Math.max(1, viewBarsMax()));
    const B0 = free ? 0 : clamp(nv.bar0 || 0, 0, Math.max(0, barsF - VB));
    const VSC = barsF > 0 ? (VB / barsF) : 1;            // cycle fraction per screen
    const F0 = barsF > 0 ? (B0 / barsF) : 0;             // the fraction at the left edge
    // ONE MAPPING, both ways — every x in this function goes through it, so a
    // note, its hit box, the ruler and the playhead cannot disagree about
    // where a moment sits.
    const xF = (f) => GUT + ((f - F0) / VSC) * PLOT;
    const fX = (x) => F0 + ((x - GUT) / Math.max(1, PLOT)) * VSC;
    // …and the plot's own box, so the playhead overlay reads one geometry
    // rather than re-deriving it. AFTER `PLOT` is declared: reading a `const`
    // above its declaration is a TDZ ReferenceError, and this function's
    // callers all swallow it — the drawing simply stopped, with `cv._cs = 0`
    // and no hit boxes as the only tell.
    cv._plotGeo = { x0: GUT, w: PLOT, top: TOP, h: h, cyc: cyc, playing: playing,
                    vsc: VSC, f0: F0, barsF: barsF, vbars: VB, bar0: B0 };
    // the keys, and their lines across the plot — the black rows are what make
    // a piano roll readable at a glance
    // WHITE KEYS ARE THE GROUND and the black ones sit ON them, narrower —
    // which is what makes a column of bands read as a keyboard rather than as
    // a barcode. Separators only between white keys, because a real one has no
    // line where a black key sits between them.
    g.fillStyle = '#e8e4f2';
    g.fillRect(0, TOP, GUT, h - TOP);
    for (let m = loM; m <= hiM; m++) {
      const y = yOf(m), pc = ((m % 12) + 12) % 12, blk = !!PC_BLACK[pc];
      const inSc = SPC ? !!SPC[pc] : null;
      // IT HAS TO BE A REAL SIGNAL IN BOTH DIRECTIONS. A wash over a near-white
      // ground stays near-white however much of it you add (the first cut was
      // a 0.22 purple over #e8e4f2 and measured 16 points away from the plain
      // key — reported, correctly, as barely visible). So the in-scale key is
      // TINTED and the out-of-scale one is GREYED, which is what puts a large
      // delta between them rather than between one of them and the ground.
      // FOUR key colours plus the two plain ones, all distinct, because with
      // no key at all nothing is in or out and both must still read as keys.
      if (blk) {
        // A BLACK KEY IS LIFTED, never washed — it is already near the ground
        // colour, so a tint on it is invisible.
        g.fillStyle = inSc === true ? '#5b4a86' : inSc === false ? '#0e0e15' : '#15151f';
        g.fillRect(0, y + 0.5, Math.round(GUT * 0.62), Math.max(1, rowH - 1));
        // …and its row is tinted across the plot: the black rows are what let
        // you count intervals off the picture
        g.fillStyle = 'rgba(159,122,234,0.055)';
        g.fillRect(GUT, y, PLOT, Math.max(1, rowH));
      } else if (inSc !== null) {
        g.fillStyle = inSc ? '#c4a9f0' : '#8e8b9e';
        g.fillRect(0, y + 0.5, GUT, Math.max(1, rowH - 1));
      }
      if (inSc === false) {
        // …and the row it owns is knocked back across the plot, so a note that
        // sits outside the key reads as outside it in the picture too.
        g.fillStyle = 'rgba(8,8,14,0.38)';
        g.fillRect(GUT, y, PLOT, Math.max(1, rowH));
      }
      if (!blk && !PC_BLACK[((m + 1) % 12 + 12) % 12]) {
        // a white key with a white key above it (B|C and E|F) — the only
        // places a keyboard shows a line
        g.strokeStyle = 'rgba(20,20,35,0.45)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(GUT, Math.round(y) + 0.5); g.stroke();
      }
      // A LINE PER SEMITONE, ACROSS THE PLOT. The black rows were the only
      // horizontal reference, so between two of them a note's row was a guess
      // — and a guess is exactly what the selection marker was being read
      // against ("this note looks a half-step below the one to its left").
      // Faint, because there is one every 5-6px; the octave line is stronger,
      // so the C's the gutter names are findable out in the plot too.
      g.strokeStyle = (pc === 0) ? 'rgba(159,122,234,0.20)' : 'rgba(159,122,234,0.07)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(GUT, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); g.stroke();
      if (selM != null && m === selM) {
        g.fillStyle = '#7b4fd6';
        g.fillRect(0, y + 0.5, GUT, Math.max(1, rowH - 1));
        g.strokeStyle = '#fff'; g.lineWidth = 1;
        g.strokeRect(0.5, y + 1, GUT - 1, Math.max(1, rowH - 2));
        // …AND THE ROW ITSELF, all the way across. The selected note's own
        // marker used to be a box inflated 4px above and below it — most of a
        // row at this size — so against a plot with no horizontal lines it
        // read as sitting a row off. The row band answers "which row is it
        // on" outright, and cannot displace what it marks.
        g.fillStyle = 'rgba(123,79,214,0.22)';
        g.fillRect(GUT, y, PLOT, Math.max(1, rowH));
      }
      // NAME THE C's — the one landmark that makes the rest countable.
      if (pc === 0 && rowH >= 5) {
        const fs = rowH >= 8 ? 8 : 7;
        g.fillStyle = (selM != null && m === selM) ? '#fff' : '#42425e';
        g.font = fs + 'px -apple-system, Segoe UI, sans-serif';
        g.fillText('C' + (Math.floor(m / 12) - 1), 1.5, y + Math.min(rowH - 1, fs));
      }
    }
    g.strokeStyle = 'rgba(159,122,234,0.30)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(GUT + 0.5, TOP); g.lineTo(GUT + 0.5, h); g.stroke();

    // THE RULER — beats, bars and bar NUMBERS, in a gutter of their own. Bar
    // lines alone gave the drawing a scale but no reading: you could see that
    // something was wide without knowing whether it was a beat or a bar.
    // Fractional cycles are drawn honestly (a ⅔-bar motif shows two thirds of a
    // bar, not a rounded one), and a FREE part has no bar grid at all.
    // `free` and `barsF` are hoisted to the viewport block above — the x
    // mapping needs them, and two derivations of one number is how they drift.

    // ONE spelling of the length for the readout: whole bars read as "2 bars",
    // a fraction keeps its value rather than rounding to a bar it does not have.
    const barTxt = free ? 'free'
      : ((Math.abs(barsF - Math.round(barsF)) < 1e-6)
          ? (Math.round(barsF) + ' bar' + (Math.round(barsF) === 1 ? '' : 's'))
          : (Math.round(barsF * 100) / 100) + ' bars');
    g.strokeStyle = 'rgba(159,122,234,0.10)'; g.lineWidth = 1;
    g.fillStyle = '#6b6b8a';
    g.font = '9px -apple-system, Segoe UI, sans-serif';
    if (free) {
      g.fillText('free · ' + Math.round((L.part && L.part.ms) || 0) + 'ms', GUT + 3, 10);
      g.beginPath(); g.moveTo(GUT, TOP + 0.5); g.lineTo(w, TOP + 0.5); g.stroke();
    } else {
      // ── THE LATTICE THE MATERIAL IS ON ─────────────────────────────────
      // These were fixed QUARTER notes, and the notes are on neither: a
      // generated part sits on `rhythm.steps` per CYCLE and a written one
      // snaps to the editing grid (`bars × grid`). On a 4.5-bar part at 16
      // steps those are 0.0625 and 0.0556 of the cycle — so every onset
      // landed between lines and every note measured 2.32 "cells" wide,
      // which is "note events are not filling the slot commensurate with
      // the size they are" exactly. Draw the grid the notes actually use and
      // they fill it by construction.
      latN = (() => {
        if (L.part.kind === 'recorded') {
          try { const c2 = V2.gridCells(L) | 0; if (c2 > 0) return c2; } catch (e) {}
        } else {
          const st = (L.part.rhythm || {}).steps | 0;
          if (st > 0) return st;
        }
        return Math.max(1, Math.round(barsF * 4));
      })();
      // …skipped when it would be denser than the eye can use — the bar lines
      // still give the reading
      if ((PLOT / Math.max(1, latN)) / VSC >= 4) {
        g.strokeStyle = 'rgba(159,122,234,0.10)'; g.lineWidth = 1;
        for (let i = 0; i <= latN; i++) {
          const x = Math.round(xF(i / latN)) + 0.5;
          if (x < GUT - 1) continue;
          if (x > w) break;
          g.beginPath(); g.moveTo(x, TOP - 4); g.lineTo(x, h); g.stroke();
        }
      }
      // BAR LINES AND THEIR NUMBERS on top — the musical reference, exact
      // whatever the lattice is (and a fractional part keeps its part-bar).
      const nbars = Math.ceil(barsF - 1e-6);
      for (let b3 = 0; b3 <= nbars; b3++) {
        const x = Math.round(xF(b3 / barsF)) + 0.5;
        if (x < GUT - 1) continue;
        if (x > w) break;
        g.strokeStyle = 'rgba(159,122,234,0.30)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, CHT + 2); g.lineTo(x, h); g.stroke();
        if (b3 < nbars) {
          g.fillStyle = '#7a7a9c';
          g.fillText(String(b3 + 1), Math.min(w - 8, x + 3), CHT + 10);
        }
      }
      // the gutter's floor, so the numbers read as a ruler rather than as
      // labels floating over the notes
      g.strokeStyle = 'rgba(159,122,234,0.18)';
      g.beginPath(); g.moveTo(GUT, TOP + 0.5); g.lineTo(w, TOP + 0.5); g.stroke();
    }
    // THE CHORD BAND. Each change gets the width it actually occupies, so a
    // cadence reads as a cadence: a \u00bd-bar chord is half as wide as the bar
    // beside it. A boundary is marked down the WHOLE plot, harder than a bar
    // line, because that is where the harmony moves and it is the line the
    // notes are read against. The name is clipped to its own segment rather
    // than ellipsed — a chord narrower than its name still shows what it can,
    // and the boundary lines say where it ends whatever fits.
    if (cmarks) {
      g.save();
      for (let i = 0; i < cmarks.length; i++) {
        const m2 = cmarks[i];
        const x0 = Math.max(GUT, xF(m2.f0)), x1 = Math.min(w, xF(m2.f1));
        if (!(x1 > x0)) continue;
        g.fillStyle = (i % 2) ? 'rgba(159,122,234,0.10)' : 'rgba(159,122,234,0.05)';
        g.fillRect(x0, 0, x1 - x0, CHT);
        if (m2.f0 > 1e-4) {                       // the change itself, full height
          const xb = Math.round(x0) + 0.5;
          g.strokeStyle = 'rgba(159,122,234,0.45)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(xb, 0); g.lineTo(xb, h); g.stroke();
        }
        if (m2.nm) {
          g.save();
          g.beginPath(); g.rect(x0, 0, Math.max(0, x1 - x0 - 1), CHT); g.clip();
          g.fillStyle = '#9f8fd0';
          g.font = '9px -apple-system, Segoe UI, sans-serif';
          g.fillText(m2.nm, x0 + 3, 10);
          g.restore();
        }
      }
      g.strokeStyle = 'rgba(159,122,234,0.18)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(GUT, CHT + 0.5); g.lineTo(w, CHT + 0.5); g.stroke();
      g.restore();
    }
    // THE SELECTED BARS, tinted full-height so "which bars will re-roll" is on
    // the picture, not in a caption. Geometry recorded for the tap handler —
    // including the gutter, which is NOT part of the bar grid.
    cv._barsGeo = free ? null : { barsF: barsF, w: PLOT, x0: GUT,
                                  vsc: VSC, f0: F0, vbars: VB, bar0: B0, latN: latN };
    // WHAT THE WINDOW IS SHOWING, said outright — a panned window that does
    // not say where it is looking is the state-you-cannot-see trap, and the
    // ◀ ▶ pair is hidden when the whole part is already on screen (a control
    // that cannot act).
    // A FUNCTION, because the count of notes outside the window is only known
    // AFTER they have been drawn — painting the label up here read one draw
    // stale, which is the two-passes-over-one-fact bug in miniature.
    const navSync = () => { try {
      const nb = host.querySelector('.v2-vnav');
      if (nb) {
        const scroll = !free && barsF > VB + 1e-6;
        nb.querySelectorAll('.v2-navx').forEach((b3) => { b3.style.display = scroll ? '' : 'none'; });
        const fit = nb.querySelector('.v2-navfit');
        if (fit) fit.style.display = (nv.dy || nv.rows || nv.bar0) ? '' : 'none';
        const lab = nb.querySelector('.v2-navlab');
        if (lab) lab.textContent = noteName(loM) + '\u2013' + noteName(hiM) +
          (cv._hidden ? ' \u00b7 ' + cv._hidden + ' outside' : '') +
          (scroll ? (' \u00b7 bar ' + (Math.round(B0 * 10) / 10 + 1) + '\u2013' +
                     (Math.round((B0 + VB) * 10) / 10)) : '');
      }
    } catch (e) {} };
    navSync();
    // WHAT THE CHORD BAND DREW, recorded like every other geometry here. A
    // reader — the gate included — must ask the picture's own claim: a probe
    // that re-walks the clock beside it proves only that the walk is
    // self-consistent, and will eventually disagree with what was drawn.
    cv._chordGeo = cmarks ? { at: cAt, top: CHT, marks: cmarks } : null;
    try { multiSync(card, L); } catch (e) {}
    const sel0 = free ? null : bselOf(L);
    const selKeys = sel0 ? bselKeys(sel0) : null;
    if (sel0) {
      // TINTED BY REGION, so a half-bar change is tinted for half a bar — the
      // picture has to show exactly what will re-roll or the selection is a
      // claim you cannot check.
      g.fillStyle = 'rgba(159,122,234,0.13)';
      selKeys.forEach((k2) => {
        const r2 = regParse(k2); if (!r2) return;
        const x0 = Math.max(GUT, xF(r2.a / (barsF * SPB)));
        const x1 = Math.min(w, xF(r2.b / (barsF * SPB)));
        if (x1 <= x0) return;
        g.fillRect(x0, TOP, x1 - x0, h - TOP);
      });
    }
    cv._hidden = 0; navSync();
    cv._hits = []; cv._sel = -1;   // no notes drawn = nothing to hit-test against
    if (!played.length) {
      try { vizChrome(card, L, E); } catch (e) {}
      g.fillStyle = '#6b6b8a'; g.font = '12px -apple-system, Segoe UI, sans-serif';
      g.fillText('silent for this cycle', GUT + 8, TOP + (h - TOP) / 2 + 4);
      if (lab) lab.textContent = liveTxt(L, cfg) + ' · ' + barTxt +
        ((cv._drawnPi >= 0 && Number.isFinite(L.partFor) && (cv._drawnPi | 0) !== (L.partFor | 0))
          ? ' \u2014 \ud83d\udc41 showing another part' : '');
      return;
    }
    // WHOSE RECORD YOU ARE LOOKING AT, said outright. In 👁 View the picture
    // FOLLOWS PLAYBACK, so as the arrangement moves it swaps to another part's
    // record — different notes, and (since parts are colour-coded) a different
    // colour. Nothing said so, and it was reported as content being lost:
    // "I drew some events on one part, then they appeared on the next part,
    // then when it cycled back the events I drew were gone, and the colour is
    // wrong". MEASURED: nothing is lost — the edited record kept all 20 notes
    // through the whole cycle — the PICTURE had moved and the card did not say
    // it had. A swap you can see but cannot name is the drum-solo bug in a
    // third costume.
    let otherTxt = '';
    try {
      if (cv._drawnPi >= 0 && Number.isFinite(L.partFor) && (cv._drawnPi | 0) !== (L.partFor | 0)) {
        const cfg9 = _cfgOf();
        const who = (cfg9 && typeof _ambPartLabel === 'function')
          ? _ambPartLabel(cfg9, cv._drawnPi | 0) : ('part ' + ((cv._drawnPi | 0) + 1));
        const mine = (cfg9 && typeof _ambPartLabel === 'function')
          ? _ambPartLabel(cfg9, L.partFor | 0) : ('part ' + ((L.partFor | 0) + 1));
        otherTxt = ' \u2014 \ud83d\udc41 showing ' + who + ', which is playing; your ' + mine +
                   ' content is safe \u2014 \u270e Edit holds it';
      }
    } catch (e) {}
    // A NOTE FILLS ITS ROW. This was capped at 8px, which is most of a
    // reading-size row and a THIRD of an expanded one — so once the window
    // could be made taller the notes stayed thin ribbons in tall lanes
    // ("note events are not filling the slot commensurate with the size they
    // are"). Proportional instead: 80% of the row, which is what the old
    // formula happened to give at the reading size (4.2 of 5.2) and what it
    // now goes on giving at any size.
    const nh = Math.max(3, rowH * 0.8);
    let hidden = 0;   // notes outside the held window — named in the readout
    for (let i = 0; i < played.length; i++) {
      const n = played[i];
      const x = xF(n.at / cyc);
      const dw = Math.max(3, ((Math.max(20, n.durMs || 0) / 1000) / cyc / VSC) * PLOT);
      // ON ITS OWN ROW: the note sits in the semitone it plays, so the keyboard
      // beside it names the pitch. (It was a continuous squeeze of the range,
      // which could put a C and a C♯ at the same height on a wide part.)
      // OUTSIDE THE WINDOW IS OFF THE PICTURE. Without this a note above
      // `hiM` was drawn over the RULER (and hit-tested there), which only
      // became reachable once the window stopped growing to swallow it.
      const mrow = Math.round(mids[i]);
      if (mrow < loM || mrow > hiM) { hidden++; continue; }
      const y = yOf(mrow) + (rowH - nh) / 2;
      g.fillStyle = NOTE_FILL;
      g.strokeStyle = NOTE_EDGE; g.lineWidth = 1;
      // CLIPPED TO THE VIEWPORT. With only part of the cycle on screen a note
      // can start before the left edge or run past the right one — it is drawn
      // as the part of itself that is visible, and one entirely outside is
      // skipped so it cannot be hit-tested either (a hit box off screen is a
      // tap target nobody can see).
      if (x + dw <= GUT || x >= w) continue;
      const xv = Math.max(GUT, x);
      const ww = Math.min(dw - (xv - x), w - xv);
      if (!(ww > 0)) continue;
      // THE NOTE BEING EDITED IS MARKED. With the editor inline the drawing
      // stays visible while you work, which is the point of it — but "Note 2 of
      // 4" names a position in a list, not a mark on the picture.
      const isSel = NE && NE.id === (L.id | 0) && Number.isFinite(n.nidx) && NE.idx === n.nidx;
      // ⬚ GATHERED. A brighter fill and a ring — the same language the open
      // note uses, because it is the same fact (this one is being worked on)
      // and a gathering you cannot see is the drum-solo bug.
      const isGrp = MGRP && Number.isFinite(n.nidx) && MGRP.has(n.nidx);
      // WHICH NOTES A RE-ROLL WILL REPLACE. A note belongs to the region its
      // ONSET falls in and its LENGTH is never clipped, so a note that starts
      // before the selection and rings through it survives untouched, while one
      // that starts inside and rings past the end goes — and in the picture
      // both simply straddle the tint, which says nothing about which is which.
      // Asked outright ("how does partial re-rolling work if a note passes
      // through the piece being edited"), and a selection whose EFFECT you
      // cannot see is the drum-solo bug in a new costume: the doomed ones wear
      // the selection's own accent on their edge.
      const willGo = !!(selKeys && selKeys.length) &&
        V2.regHas(selKeys, n.at / cyc, barsF);
      if (selKeys && willGo && !isSel && !isGrp) {
        g.strokeStyle = 'rgba(190,150,255,0.95)'; g.lineWidth = 1.5;
      }
      if (isSel) {
        g.fillStyle = 'rgba(214,188,250,0.95)';
        g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      }
      // RIGHT-ANGLE CORNERS, deliberately (2026-09-09, user: "so it's easier
      // to see visually how they line up on the grid"): a rounded end pulls
      // the visible edge inboard of the note's true start, so a note ON a
      // grid line read as slightly off it — the corner IS the onset.
      if (isGrp && !isSel) {
        g.fillStyle = _hexA(NOTE_EDGE, 0.85) || 'rgba(214,188,250,0.85)';
        g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      }
      g.beginPath();
      g.rect(xv, y, ww, nh);
      g.fill(); g.stroke();
      if (selKeys && willGo && !isSel && !isGrp) {
        g.strokeStyle = NOTE_EDGE; g.lineWidth = 1;
      }
      if (isGrp && !isSel) {
        g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1;
        g.beginPath();
        g.rect(xv - 3, y - 4, ww + 6, nh + 8);
        g.stroke();
        g.fillStyle = NOTE_FILL;
        g.strokeStyle = NOTE_EDGE; g.lineWidth = 1;
      }
      if (isSel) {
        // MARKED WITHOUT BEING MOVED. This was a box inset by 3px and 4px —
        // and 4px is most of a 5-6px row, so the selected note read as sitting
        // a row away from where it is (reported as "it jumps when selected").
        // The row band above says which row, so the note itself only needs a
        // bright edge ON its own rect: nothing about the selection changes a
        // pixel of where the note is drawn.
        g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1;
        g.beginPath();
        g.rect(xv - 0.5, y - 0.5, ww + 1, nh + 1);
        g.stroke();
        cv._sel = n.nidx;
        g.fillStyle = NOTE_FILL;
        g.strokeStyle = NOTE_EDGE; g.lineWidth = 1;
      }
      // WHERE EACH NOTE IS, so a tap can find it. `t`/`midi` ride along as
      // well as the index: locking a live take re-sorts the notes, so the note
      // you tapped is re-found by WHAT IT IS rather than by where it sat in an
      // array that no longer exists.
      // …and WHETHER A RE-ROLL WOULD REPLACE IT. Published beside the geometry
      // like everything else here, so a reader — the gate included — asks the
      // picture's own claim rather than re-deriving the ownership rule beside
      // it and eventually disagreeing with what was drawn.
      cv._hits.push({ x: xv, y, w: ww, h: nh, i: (Number.isFinite(n.nidx) ? n.nidx : i),
                      t: n.at / cyc, midi: mids[i], go: !!willGo });
    }
    // …and NOW the count of what fell outside is known
    cv._hidden = hidden; navSync();
    if (lab) {
      const rec2 = L.part && L.part.kind === 'recorded';
      // THE DRAWING IS ONE CYCLE, and the ruler counts BARS — so a 1-bar cycle
      // is one label and four beat lines however long the part is. Asked as
      // "why does the ruler just say 1 when the part is 5 chords": nothing said
      // that the cycle is SHORTER than the part it plays under, so the picture
      // looked like it was failing to show the changes. It repeats, and now it
      // says so — and names ⇄ Sync, which is what re-fits it (a part's bars are
      // its own; nothing re-lengths them when the changes grow).
      let overTxt = '';
      try {
        // `cfg`, the function's own local — `drawPartViz(card, L, E)` has no
        // ctx, and a bare reference would throw into the catch and read as a
        // silent no-op (the mistake this file has now made twice).
        const cfg2 = cfg;
        const rgs2 = (typeof _ambGridRanges === 'function') ? (_ambGridRanges(cfg2) || []) : [];
        const pi2 = Number.isFinite(L.partFor) ? (L.partFor | 0)
          : ((typeof _ambCurPartNow === 'function' && rgs2.length) ? _ambCurPartNow(E, cfg2, rgs2) : -1);
        const pb = (pi2 >= 0 && typeof _ambLenPartBars === 'function')
          ? +_ambLenPartBars(cfg2, pi2) : 0;
        const cb = +(L.part && L.part.bars) || 0;
        if (pb > 0 && cb > 0 && pb > cb + 1e-6) {
          const times = pb / cb;
          const nice = Math.abs(times - Math.round(times)) < 1e-6 ? String(Math.round(times))
                                                                 : (Math.round(times * 10) / 10);
          overTxt = ' · repeats ' + nice + '× over the ' + (Math.round(pb * 100) / 100) +
                    '-bar part — ⇄ Sync to fit it';
        }
      } catch (e) {}
      // STATIC or LIVE leads the line. It used to say 'recorded' or 'live',
      // which named where the material CAME FROM and said it in the vocabulary
      // of liveness — and measurably wrong: a 'live' part plays the identical
      // notes every cycle unless something stochastic is on. The first token
      // now answers "does this change on iterations", and NAMES what makes it
      // live rather than hiding the reason in a title a phone never shows.
      lab.textContent = liveTxt(L, cfg) + ' · ' +
        played.length + ' note' + (played.length === 1 ? '' : 's') + ' · ' + barTxt +
        ' · ' + (Math.round(cyc * 10) / 10) + 's' +
        // NAME THE TAKE. "one take of many" was true and unhelpful — you could
        // not tell whether the picture had moved. A number you can watch change
        // is what makes "Preview did not re-roll that" verifiable by eye.
        // A DOOR NOBODY CAN SEE IS NOT A DOOR. The ruler is two rows and they
        // now answer two questions, so the hint names BOTH — nothing on a
        // canvas can carry a tooltip, and the chord band looks like a label
        // until something says it is a handle.
        (rec2 ? (bselOf(L) ? ' · re-rolling ' + bselLabel(bselOf(L)) + ' — tap a bar' + (cmarks ? ' or a chord' : '') + ' to change which'
                            : ' · tap a note to edit · tap a bar' + (cmarks ? ' or a chord' : '') + ' to re-roll just it')
              : ' · take ' + (V2.takeOf(L) + 1) +
                (L.part.takeb ? ' · retaken: ' + regListTxt(L.part.takeb) : '') +
                // A BAR GENERATING BY ITS OWN RULES IS STATE, and state that can
                // sit in a closed panel has to be readable from the card (the
                // drum-solo rule) — otherwise "why is bar 3 different" has no
                // answer anywhere on screen.
                (L.part.ruleb ? ' · own rules: ' + regListTxt(L.part.ruleb) : '') +
                (bselOf(L) ? ' · retaking ' + bselLabel(bselOf(L))
                           : ' · tap a bar' + (cmarks ? ' or a chord' : '') + ' to retake just it') +
                (fromPv ? ' · as previewed' : '')) + overTxt + otherTxt;
    }
    try { vizChrome(card, L, E); } catch (e) {}
  }
  // The viz block's live chrome — the note editor, and what the lock button
  // says. Both are state the BUILD cannot settle: the editor is opened after
  // the card exists, and `V2.render`'s signature does not include the note
  // count, so an emptied part rebuilds nothing.
  // WHERE THE CONTENT CAME FROM, and WHAT RULES ARE SHAPING IT. Both stores
  // existed (`part.made` on a recorded part, `part.mat` on a live one) and
  // neither showed anywhere — five Material doors and no way to tell which one
  // produced what you are looking at. The active door lights up (the house
  // `.ambient-seg.on`), and the hint names the provenance AND the live rules
  // (rhythm kind × pitch kind × the take that seeds the draws), because "what
  // rules made this" should be readable off the card, not deduced from three
  // sheets.
  // WHAT THE RULES WILL PRODUCE, IN WORDS. The hint used to read
  // `euclid 5 of 8 · walk · take 15` — every term correct and none of it an
  // answer to "what is this going to generate", which was reported as the
  // whole thing being opaque. Same facts, said as a sentence: how many notes
  // and where, what the line does with pitch, over how long, and — the part
  // people cannot see from a single drawing — whether it is re-rolled every
  // cycle or plays exactly what is shown.
  // WHAT KIND OF CONTENT THIS IS, in one phrase. The model is two orthogonal
  // axes — RHYTHM decides WHEN notes happen, PITCH decides WHAT each onset
  // plays — and nothing said so, so "I select Roll; is that a run of notes? a
  // sustained chord? several chords?" had no answer anywhere on the card. The
  // shape falls straight out of the two: onsets per cycle × notes per onset.
  function shapeOf(L) {
    const p = L.part, r = p.rhythm || {}, t = p.pitch || {};
    const n = (x) => (x | 0);
    if (p.kind === 'recorded') return 'the notes below';
    if (t.kind === 'drawn' || r.kind === 'drawn') return 'the pattern you drew';
    // how many notes land together on one onset
    const stacked = (t.kind === 'chord' || t.kind === 'stack') ? Math.max(1, n(t.voices)) : 1;
    const lines = Math.max(1, n(t.lines) || 1);
    const harm = (t.harm || []).length;
    const per = stacked * lines + harm * lines;
    // how many onsets there are in a cycle
    const onsets = (r.kind === 'euclid') ? n(r.pulses)
      : (r.kind === 'chance') ? Math.max(1, Math.round(n(r.steps) * n(r.chance) / 100))
      : Math.max(1, n(r.n));
    if (t.kind === 'series') {
      return onsets <= 1 ? 'one chord tone per cycle'
      // NOT "an arpeggio": the door above already says Arpeggio, so the line
      // read "⟳ Arpeggio — an arpeggio — …".
                         : 'the chord, one note at a time';
    }
    if (r.kind === 'ground') {
      const per = (p.ground && p.ground.per) ? Object.keys(p.ground.per).length : 0;
      const v0 = Math.max(1, n(t.voices));
      return (v0 === 1 ? 'one note' : v0 + ' notes') + ' on every change' +
        (per ? ', ' + per + ' of them set by hand' : '');
    }
    if (t.kind === 'mixed') {
      const mixc = Number.isFinite(t.mix) ? (t.mix | 0) : 50;
      return 'chords and single notes, about ' + mixc + '% chords';
    }
    if (t.kind === 'anchor') return 'one note held under the changes';
    if (onsets <= 1) {
      return per > 1 ? ('one held chord of ' + per + ' notes') : 'one held note';
    }
    if (per > 1) {
      return lines > 1 ? (lines + ' lines moving independently')
                       : ('a chord of ' + per + ' notes on every onset');
    }
    return 'a run of single notes';
  }
  function rulesText(L) {
    const p = L.part, r = p.rhythm || {}, t = p.pitch || {};
    const n = (x) => (x | 0);
    const plural = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
    let rh;
    if (r.kind === 'euclid') {
      rh = plural(n(r.pulses), 'hit') + ' spread evenly over ' + n(r.steps) + ' steps';
      if (n(r.rotate)) rh += ', shifted ' + n(r.rotate);
      if (n(r.voices) > 1) rh += ', ' + n(r.voices) + ' voices';
    } else if (r.kind === 'ground') {
      rh = 'one onset on the 1 and one on every change';
    } else if (r.kind === 'drawn') {
      rh = 'the pattern you drew';
    } else if (r.kind === 'chance') {
      rh = 'each of ' + n(r.steps) + ' steps has a ' + n(r.chance) + '% chance of sounding';
    } else {
      const k = Math.max(1, n(r.n));
      rh = k === 1 ? 'one onset, held' : (plural(k, 'onset') + ', spread evenly');
    }
    const lines = Math.max(1, n(t.lines) || 1);
    const harm = (t.harm || []).length;
    let pt;
    if (t.kind === 'walk') {
      pt = (lines > 1 ? lines + ' lines each wandering' : 'a line wandering') +
           ' up to ' + Math.max(1, n(t.span)) + ' notes of the scale';
      if (n(t.stutter)) pt += ', repeating a note ' + n(t.stutter) + '% of the time';
    } else if (t.kind === 'chord') {
      pt = plural(Math.max(1, n(t.voices)), 'note') + ' of the chord';
    } else if (t.kind === 'stack') {
      pt = plural(Math.max(1, n(t.voices)), 'tone') + ' stacked from note ' + Math.max(1, n(t.degree));
    } else if (t.kind === 'series') {
      pt = 'sweeping the chord ' + (t.dir === 'down' ? 'down' : t.dir === 'updown' ? 'up and down' : 'up') +
           ' over ' + Math.max(1, n(t.span) || 1) + ' octaves';
    } else if (t.kind === 'fixed') {
      pt = 'one note — number ' + Math.max(1, n(t.degree)) + ' of the source';
    } else if (t.kind === 'anchor') {
      pt = 'one note held under the whole progression';
    } else if (t.kind === 'drawn') {
      pt = 'the notes you drew';
    } else if (t.kind === 'mixed') {
      pt = 'each onset either a ' + Math.max(1, n(t.voices)) + '-note chord or one walked note';
    } else if (t.kind === 'chance') {
      pt = 'a note picked at random from the source';
    } else {
      pt = String(t.kind || 'chord');
    }
    if (harm) pt += ', plus ' + plural(harm, 'harmony part');
    const bars = +p.bars || 1;
    const len = 'over ' + (Math.round(bars * 100) / 100) + ' bar' + (bars === 1 ? '' : 's');
    // NO TAIL. This line used to end by saying whether the drawing is what
    // plays or one take of many — a fact that now lives on the Every cycle
    // toggle directly beneath it, whose FACE says which mode is in force, and
    // on the drawing's own readout, which names the take. Three surfaces for
    // one fact is how they come to disagree; a WRITTEN part states its own
    // contract in `LOCKED` below instead.
    // LEAD WITH THE SHAPE. The parameters answer "how", and only after you
    // already know WHAT is being made.
    return shapeOf(L) + ' \u2014 ' + rh + ', ' + pt + ', ' + len;
  }
  function matProv(L) {
    const p = L.part, r = p.rhythm || {}, t = p.pitch || {};
    const rulesBare = rulesText(L);
    const M = { sustain: '\u25ac Sustained', arp: '\u27f3 Arpeggio', roll: '\ud83c\udfb2 Roll',
                mixed: '\u2687 Mixed', ground: '\u26f0 Groundwork' };
    const v1 = (p.mat && p.mat.indexOf('v1:') === 0) ? p.mat.slice(3) : null;
    // NO STAMP IS NOT NO MATERIAL. A part made before provenance existed — or
    // assembled by hand on the knobs — still IS one of these materials, and
    // the rules say which: `series` is what an arpeggiator does, one pulse
    // holding a chord is a sustain, a walked line is the run. The stamp wins
    // when present (it records the actual press); the shape answers otherwise,
    // which is what keeps "what Material are we using" answerable on every
    // part rather than only the ones made since yesterday.
    const guess = (r.kind === 'ground') ? 'ground'
      : (t.kind === 'mixed') ? 'mixed'
      : (t.kind === 'series') ? 'arp'
      : ((r.kind === 'pulse' || !r.kind) && (r.n | 0) <= 1 && (t.kind === 'chord' || t.kind === 'stack')) ? 'sustain'
      : (t.kind === 'walk') ? 'roll' : null;
    const mat = M[p.mat] ? p.mat : (v1 ? null : guess);
    if (p.kind === 'recorded') {
      const n = (p.notes || []).length;
      const nn = n + ' note' + (n === 1 ? '' : 's');
      if (p.made === 'compose') return { key: 'compose', txt: '\u270e Composed \u00b7 WRITTEN \u2014 ' + nn + ' you drew' };
      if (p.made === 'phrase') return { key: 'adopt', txt: '\u266a From the Bank' + (p.from ? ' \u201c' + p.from + '\u201d' : '') + ' \u00b7 WRITTEN \u2014 ' + nn };
      if (p.made === 'take') {
        // LEAD with the material — burying it mid-sentence is why "still not
        // clear what Material we're using" was a fair report of the first cut
        const LOCKED = ' \u00b7 WRITTEN DOWN \u2014 plays these notes, not the rules \u00b7 ';
        if (v1) return { key: p.mat, txt: 'v1 ' + v1 + ' seed' + LOCKED + nn };
        if (mat) return { key: mat, txt: M[mat] + LOCKED + rulesBare + ' \u00b7 ' + nn };
        return { key: null, txt: 'a take' + LOCKED + rulesBare + ' \u00b7 ' + nn };
      }
      return { key: null, txt: 'WRITTEN \u2014 ' + nn + ', played as they are' };
    }
    if (v1) return { key: p.mat, txt: 'seeded like a v1 ' + v1 + ' \u00b7 GENERATED \u2014 ' + rulesBare };
    if (mat) return { key: mat, txt: M[mat] + ' \u00b7 GENERATED \u2014 ' + rulesBare };
    return { key: null, txt: 'GENERATED \u2014 ' + rulesBare };
  }
  // THE GENERATED DOOR AND ITS PANEL, kept current. The door's own face names
  // the shape in force, so the row still answers "what is this" without being
  // opened — consolidating four buttons into one must not cost that.
  function genSync(card, L) {
    const pv = matProv(L);
    const M = { sustain: '\u25ac Sustained', arp: '\u27f3 Arpeggio',
                roll: '\ud83c\udfb2 Roll', mixed: '\u2687 Mixed',
                ground: '\u26f0 Groundwork' };
    const face = card.querySelector('.v2-genface');
    if (face) {
      const txt = M[pv.key] || (L.part.kind === 'recorded' ? 'written \u2014 not generated'
                                                          : 'choose & tune');
      if (face.textContent !== txt) face.textContent = txt;
    }
    try { gwPerSync(card, L); } catch (e) {}
    const says = card.querySelector('.v2-gensays');
    if (says) {
      // WHICH PART THIS GENERATES FOR, WITH THE ARITHMETIC (stated as the
      // contract, 2026-09-08: "it should say WHICH part you're generating
      // for… it should be evident if how many notes you're choosing lines up
      // with the part length"). The panel tuned "How many: 9" with nothing
      // saying nine of what, over what.
      let forTxt = '', mathTxt = '';
      try {
        const E3 = (typeof _masterEng !== 'undefined') ? _masterEng : null;
        const cfg3 = E3 && E3.getCfg && E3.getCfg();
        const rgs3 = (cfg3 && typeof _ambGridRanges === 'function') ? (_ambGridRanges(cfg3) || []) : [];
        const pi3 = Number.isFinite(L.partFor) ? (L.partFor | 0)
          : ((typeof _ambCurPartNow === 'function' && rgs3.length) ? _ambCurPartNow(E3, cfg3, rgs3) : -1);
        if (pi3 >= 0 && typeof _ambPartLabel === 'function') {
          const pb3 = (typeof _ambLenPartBars === 'function') ? +_ambLenPartBars(cfg3, pi3) : 0;
          forTxt = ' For ' + _ambPartLabel(cfg3, pi3) +
                   (pb3 > 0 ? ' (' + (Math.round(pb3 * 100) / 100) + ' bars)' : '') + '.';
          const cb0 = +(L.part.bars || 1);
          if (pb3 > 0 && Math.abs(pb3 - cb0) > 1e-6) {
            forTxt += ' This cycle is ' + cb0 + ' of its ' + (Math.round(pb3 * 100) / 100) +
                      ' bars \u2014 \u21c4 Sync fits it.';
          }
        }
      } catch (e) {}
      try {
        const rh3 = L.part.rhythm || {};
        const cb3 = Math.max(0.125, +(L.part.bars || 1));
        let on3 = 0;
        if (rh3.kind === 'euclid' || rh3.kind === 'drawn') on3 = (rh3.pulses | 0) || 0;
        else if (rh3.kind === 'pulse') on3 = (rh3.n | 0) || 0;
        if (on3 > 0 && L.part.kind !== 'recorded') {
          const per = Math.round((on3 / cb3) * 10) / 10;
          mathTxt = ' How many ' + on3 + ' over ' + (Math.round(cb3 * 100) / 100) +
                    ' bar' + (cb3 === 1 ? '' : 's') + ' \u2248 ' + per + ' notes/bar.';
          // the GRID must divide the bars or nothing can land on a bar line
          const st3 = (rh3.steps | 0) || 0;
          const bi3 = Math.max(1, Math.round(cb3));
          if (st3 > 0 && Math.abs(cb3 - bi3) < 1e-6 && st3 % bi3 !== 0) {
            const fix3 = Math.max(bi3, Math.min(32, bi3 * Math.max(1, Math.round(st3 / bi3))));
            mathTxt += ' \u26a0 Grid ' + st3 + ' over ' + bi3 + ' bars = ' +
                       (Math.round((st3 / bi3) * 100) / 100) +
                       ' steps/bar \u2014 notes cannot land on bar lines; try ' + fix3 + '.';
          }
        }
      } catch (e) {}
      const txt = (L.part.kind === 'recorded')
        ? 'This part is WRITTEN \u2014 choosing a shape hands it back to the rules.'
        : shapeOf(L) + ' \u2014 ' + (L.part.bars || 1) + ' bar' + ((L.part.bars || 1) === 1 ? '' : 's') +
          ', re-rolled every cycle.' + forTxt + mathTxt;
      if (says.textContent !== txt) says.textContent = txt;
    }
  }
  // ONE CELL PER CHANGE. Built here rather than in the markup because the
  // chords change under the card and the panel must follow without a rebuild;
  // the cells carry the ABSOLUTE chord index, which is what the lookup uses.
  function gwPerSync(card, L) {
    const host = card.querySelector('.v2-gwpergrid'); if (!host) return;
    let cfg = null; try { cfg = _cfgOf(); } catch (e) {}
    const prog = cfg && cfg.prog;
    const chords = (prog && prog.on && Array.isArray(prog.chords)) ? prog.chords : [];
    const base = clamp((L.part.pitch.voices | 0) || 3, 1, 9);
    const per = (L.part.ground && L.part.ground.per) || {};
    // REBUILD ONLY WHEN THE SET OF CHANGES CHANGES. The values must NOT be in
    // the signature: a commit calls `applyGate` → `matSync` → here, so keying
    // on the values rewrote the grid on every press and destroyed the ± button
    // under the finger — two taps of + moved the number by ONE (measured).
    // That is the documented re-render-under-the-finger trap, in the panel's
    // own sync. Values are written in place below.
    const sig = chords.length + '|' + base;
    if (host._sig === sig) {
      chords.forEach((ch, i) => {
        const cell = host.children[i]; if (!cell) return;
        const inp = cell.querySelector('.ambient-step-inp');
        const own = Number.isFinite(per[String(i)]);
        const v = own ? (per[String(i)] | 0) : base;
        if (inp && String(inp.value) !== String(v)) inp.value = v;
        cell.classList.toggle('own', own);
        cell.classList.toggle('silent', v === 0);
      });
      return;
    }
    host._sig = sig;
    if (!chords.length) {
      host.innerHTML = '<span class="ambient-hint">no changes here \u2014 every bar plays the ' +
        'number above</span>';
      return;
    }
    host.innerHTML = chords.map((ch, i) => {
      const v = Number.isFinite(per[String(i)]) ? (per[String(i)] | 0) : base;
      const own = Number.isFinite(per[String(i)]);
      let nm = '';
      try { nm = (typeof _ambChordShort === 'function') ? _ambChordShort(ch) : ''; } catch (e) {}
      return '<span class="v2-gwcell' + (own ? ' own' : '') + (v === 0 ? ' silent' : '') + '">' +
        '<span class="v2-gwcn">' + esc(nm || String(i + 1)) + '</span>' +
        mini(L, 'part.ground.per.' + i, nm || String(i + 1), v, 0, 9, 1) + '</span>';
    }).join('');
  }
  // ── THE PLAYHEAD ────────────────────────────────────────────────────────
  // "The layer viz should light up as play happens, current bar and note, so
  // the user can see where notes are." Driven from the viz rAF (which only
  // re-arms while playing — the documented rule), and drawn on the OVERLAY
  // canvas: redrawing the roll per frame would mean a `notesFor` call per frame
  // per card, since the drawing is generated rather than stored.
  // currentTime − output latency − the shell's broadcast lag. Same helper the
  // Shape wheel and v1's layer bars use, so every playhead in the app answers
  // to one clock.
  const audibleNow = () => {
    try { if (typeof _shapeAudibleNow === 'function') return _shapeAudibleNow(); } catch (e) {}
    return (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
  };
  function vizFrame(E) {
    if (!E) return;
    const host = document.getElementById('bloom-v2-layers'); if (!host) return;
    // STOPPED CLEARS. The rAF runs ONE more frame after the transport stops
    // (the frame was already requested) and then does not re-arm — so this is
    // where the sweep is wiped; without it the last frame sits there claiming
    // a note is sounding.
    if (!E.timer) {
      host.querySelectorAll('.v2-vizph').forEach((ph0) => {
        if (!ph0._on || !ph0.getContext) return;
        const c0 = ph0.getContext('2d');
        c0.setTransform(1, 0, 0, 1, 0, 0);
        c0.clearRect(0, 0, ph0.width, ph0.height);
        ph0._on = false;
      });
      return;
    }
    let cfg = null; try { cfg = E.getCfg(); } catch (e) {}
    const list = (cfg && cfg.layers) || []; if (!list.length) return;
    // …+ ONE SCREEN FRAME: the position is right for the audible clock, but the
    // browser paints it a frame after this callback, so it would land slightly
    // behind the sound (v1's bars carry the same nudge, for the same reason).
    const now = audibleNow() + 0.016;
    host.querySelectorAll('.v2-layer:not(.collapsed)').forEach((card) => {
      const id = card.getAttribute('data-v2id') | 0;
      const L = list.find((x) => x && (x.id | 0) === id); if (!L) return;
      // NOT WHILE A NOTE IS BEING DRAGGED. This frame redraws the roll once per
      // cycle, and a LIVE part rolls fresh notes each cycle — so the blocks
      // genuinely move under the finger while you hold one. Reported as the
      // note "jumping around like crazy"; the gesture owns the picture until
      // it is finished.
      if (DRAG && DRAG.id === id) return;
      const cv = card.querySelector('.v2-vizcv');
      const ph = card.querySelector('.v2-vizph');
      if (!cv || !ph || !ph.getContext) return;
      const geo = cv._plotGeo;
      const st = E._v2Phase && E._v2Phase['v2:' + id];
      const cyc = (geo && geo.cyc) || 0;
      const clear = () => {
        if (ph._on) {
          const c0 = ph.getContext('2d');
          c0.setTransform(1, 0, 0, 1, 0, 0);
          c0.clearRect(0, 0, ph.width, ph.height);
          ph._on = false;
        }
      };
      if (!geo || !st || !Number.isFinite(st.startAt) || !(cyc > 0) || now < st.startAt) { clear(); return; }
      // the same window the tick walks and the drawing drew
      let cs = 0, cycNow = cyc;
      try {
        const wnd = V2.cycleWindowAt(L, E.getCfg ? E : E, cfg, now, st);
        cs = wnd.cs; cycNow = wnd.cyc;
        // THE SWEEP AND THE DRAWING MUST MAKE THE SAME CALL. In EDIT mode with
        // another part sounding the picture HOLDS the edited record (see
        // `vizFollows`) — nothing is playing it, so there is no position to
        // mark, and comparing this window's `cs` against the held drawing's
        // would re-trigger `drawPartViz` every frame (the flashing bug).
        if (!vizFollows(L, E, cfg, wnd.cs, wnd.pi)) { clear(); return; }
      } catch (e) { cs = st.startAt + Math.floor((now - st.startAt) / cyc) * cyc; }
      const frac = (now - cs) / cycNow;
      if (!(frac >= 0 && frac <= 1)) { clear(); return; }
      // THE CYCLE MOVED — redraw the roll, at most once per cycle. A live part
      // re-rolls, so the picture has to follow or the lit notes are last
      // cycle's. `drawPartViz` picks the sounding cycle itself while playing.
      // The tolerance is 20ms, NOT 1e-4: the drawing samples its own clock a
      // hair apart from this frame's, and a sub-frame disagreement must read
      // as "same cycle" — at 1e-4 any residual jitter re-triggered the redraw
      // every frame (the flashing bug's other half). A real cycle move is at
      // least a chord span, orders of magnitude above 20ms.
      if (!Number.isFinite(cv._cs) || Math.abs(cv._cs - cs) > 0.02) {
        try { drawPartViz(card, L, E); } catch (e) {}
      }
      const dpr = Math.min(3, (window.devicePixelRatio || 1));
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!(w > 0 && h > 0)) { clear(); return; }
      if (ph.width !== Math.round(w * dpr) || ph.height !== Math.round(h * dpr)) {
        ph.width = Math.round(w * dpr); ph.height = Math.round(h * dpr);
      }
      // the overlay tracks the roll's own box, whatever the padding is
      if (ph._px !== cv.offsetLeft || ph._py !== cv.offsetTop || ph._pw !== w || ph._phh !== h) {
        ph.style.left = cv.offsetLeft + 'px'; ph.style.top = cv.offsetTop + 'px';
        ph.style.width = w + 'px'; ph.style.height = h + 'px';
        ph._px = cv.offsetLeft; ph._py = cv.offsetTop; ph._pw = w; ph._phh = h;
      }
      const g = ph.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      ph._on = true;
      const x0 = geo.x0, PLOT = geo.w, TOP = geo.top;
      // THE SAME VIEWPORT THE DRAW USED, read from its own published geometry
      // — re-deriving it here is how the sweep and the notes would come to
      // disagree about where a moment is (and with only part of the cycle on
      // screen the sweep has somewhere to be that is off it).
      const VSC = (geo.vsc > 0) ? geo.vsc : 1, F0 = geo.f0 || 0;
      const xF = (f) => x0 + ((f - F0) / VSC) * PLOT;
      const x = xF(frac);
      const onScreen = (x >= x0 - 0.5 && x <= x0 + PLOT + 0.5);
      // THE CURRENT BAR, tinted — "current bar and note". A bar is what the
      // ruler above counts, so it is the unit to mark — READ FROM THE RULER
      // (`cv._barsGeo`, published by the draw) rather than re-derived from
      // `L.part.bars`: with a per-part layer following another part those are
      // different numbers, and the tint would mark a bar the ruler never drew.
      const bg0 = cv._barsGeo;
      const barsF = Math.max(0.0625,
        (bg0 && bg0.barsF > 0 ? bg0.barsF : ((L.part && L.part.bars) || 1)));
      if (!(L.part && L.part.clock === 'free')) {
        const b = Math.floor(frac * barsF);
        const bx0 = Math.max(x0, xF(b / barsF)), bx1 = Math.min(x0 + PLOT, xF((b + 1) / barsF));
        if (bx1 > bx0) {
          g.fillStyle = 'rgba(72,187,120,0.07)';
          g.fillRect(bx0, TOP, bx1 - bx0, h - TOP);
        }
      }
      // …AND THE NOTES UNDER IT. Green, because green means "sounding"
      // everywhere else in this app — the one hue the palette reserves.
      const hits = cv._hits || [];
      for (let i = 0; i < hits.length; i++) {
        const b2 = hits[i];
        if (x < b2.x - 0.5 || x > b2.x + b2.w + 0.5) continue;
        g.fillStyle = 'rgba(72,187,120,0.85)';
        g.strokeStyle = '#c6f6d5'; g.lineWidth = 1;
        g.beginPath();
        // square, matching the note geometry exactly — the lit copy must sit
        // byte-on-top of the note it lights
        g.rect(b2.x, b2.y, b2.w, b2.h);
        g.fill(); g.stroke();
      }
      g.strokeStyle = 'rgba(198,246,213,0.9)'; g.lineWidth = 1.5;
      // …only when the moment it marks is actually in view: a sweep pinned to
      // the edge of a panned window would claim a position it is not at.
      if (onScreen) { g.beginPath(); g.moveTo(x, TOP); g.lineTo(x, h); g.stroke(); }
      // THE TIME THE SWEEP WAS DRAWN FOR — so "is this the audible clock or the
      // schedule one" is answerable by measurement rather than by reading the
      // code (it was the schedule clock, and on the shell's broadcast that is
      // most of a second early).
      ph._at = now;
      // …beside the SCHEDULE clock read in the same frame, so the two can be
      // compared without wall time between them contaminating the answer (a
      // check that read `Tone.now()` afterwards passed with the poison in).
      try { ph._sched = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0; } catch (e) {}
    });
  }
  // Beside `window._v2Tick` and for the same reason: the viz rAF lives in 17
  // and this is the UI IIFE, and the two share nothing but the window.
  window._v2VizFrame = vizFrame;
  // EVERY v2 DRAWING, REPAINTED. An AREA control — salt, the changes, the key —
  // decides what a layer plays just as much as the layer's own controls do, but
  // only the layer's own commit repainted its picture, so an area edit left
  // every drawing stale until something else happened to redraw it. `V2.render`
  // is `_sig`-cached on identity, so it cannot serve for this.
  window._v2RepaintViz = function (E) {
    try {
      const host = document.getElementById('bloom-v2-layers'); if (!host) return;
      let list = [];
      try { list = (E.getCfg().layers || []); } catch (e) { return; }
      host.querySelectorAll('.v2-layer:not(.collapsed)').forEach((card) => {
        const id = card.getAttribute('data-v2id') | 0;
        const L = list.find((x) => x && (x.id | 0) === id); if (!L) return;
        try { drawPartViz(card, L, E); } catch (e) {}
      });
    } catch (e) {}
  };
  // the mode is module state, so the engine side needs a setter for it
  try { V2.vizMode = (L, m) => setMode(L, m); } catch (e) {}
  try { V2.modeOf = (L) => modeOf(L); } catch (e) {}
  try { V2.multiSel = (L) => [...(mselOf(L) || [])]; } catch (e) {}
  try { V2.vizModeOf = (L) => vizMode(L); } catch (e) {}
  // A MATERIAL PRESS DOES ONE OF THREE THINGS, and the card never said which:
  // ADOPT (already in that mode — nothing changes), RESTORE (a material you
  // have used before comes back with the settings you left it at), or BUILD
  // FRESH (new rules, new notes). Reported as "it feels nondeterministic as to
  // when a new take is rolled and why". The first is silent; the other two
  // REPLACE what you are looking at, so they ask first and NAME the outcome.
  const MAT_LABEL = { ground: '\u26f0 Groundwork',
    sustain: '\u25ac Sustained', arp: '\u27f3 Arpeggio',
                      roll: '\ud83c\udfb2 Roll', mixed: '\u2687 Mixed',
                      ground: '\u26f0 Groundwork' };
  function matWillDo(L, which) {
    const p = (L && L.part) || {};
    // ADOPT needs the stamp AND the rules: a stamp survives edits, so a
    // 'ground' part whose rhythm was later set to Pulse must REBUILD on the
    // next \u26f0 press, not silently keep playing one sustained chord.
    if (p.kind !== 'recorded' && matProv(L).key === which &&
        (!V2.matShapeOk || V2.matShapeOk(p, which))) return 'adopt';
    return (p.mem && p.mem[which]) ? 'restore' : 'build';
  }
  function matSwitchOK(L, which) {
    const p = (L && L.part) || {};
    const what = matWillDo(L, which);
    if (what === 'adopt') return true;                 // nothing changes
    const lab = MAT_LABEL[which] || 'This material';
    const n = (p.notes || []).length;
    if (p.kind === 'recorded') {
      if (!n) return true;                             // nothing to lose
      // WRITTEN notes are somebody's work — say what they are before replacing
      // them (the same rule `replaceOK` follows for a take).
      const made = (p.made === 'compose') ? 'the notes you drew'
        : (p.made === 'phrase') ? ('the phrase' + (p.from ? ' \u201c' + p.from + '\u201d' : ''))
        : 'these ' + n + ' written note' + (n === 1 ? '' : 's');
      return confirm(lab + ' makes this part GENERATED again.\n\n' + made +
        ' will be replaced by notes made from its rules' +
        ((p.mem && p.mem[which]) ? ' \u2014 your saved ' + lab + ' settings come back.' : '.') +
        '\n\nThis cannot be undone.');
    }
    return confirm(lab + ' re-makes this part\u2019s notes.\n\n' +
      ((what === 'restore')
        ? ('Your saved ' + lab + ' settings come back, and the take you have now is replaced.')
        : ('It is built fresh, and the take you have now is replaced.')) +
      '\n\nCancel keeps what you have. \ud83c\udfb2 New take rolls another of the same shape.');
  }
  function matSync(card, L) {
    const pv2 = matProv(L);
    // ✓ = this material is generating · 🔒 = it MADE these notes and the take
    // was locked. Reported as "I thought using Rolled WAS generating parts?"
    // — a lit chip alone cannot tell those apart.
    const lk = L.part.kind === 'recorded';
    // `adopt` is deliberately absent: a take taken from the Bank has no door
    // in this row to light. Its provenance is stated in the hint line below,
    // which is where a fact that is not a mode belongs.
    const map = { compose: '.v2-compose',
      sustain: '.v2-mkpart[data-mk="sustain"]', arp: '.v2-mkpart[data-mk="arp"]',
      mixed: '.v2-mkpart[data-mk="mixed"]', ground: '.v2-mkpart[data-mk="ground"]',
      roll: '.v2-rollrun' };
    Object.keys(map).forEach((k) => {
      const b2 = card.querySelector(map[k]);
      if (b2) { b2.classList.toggle('on', pv2.key === k); b2.classList.toggle('v2-matlock', lk); }
    });
    // THE ROW'S OWN DOORS: ⚙ Shape owns the four generated shapes, ⛰ Groundwork
    // owns itself. Without these the row lit nothing at all for a generated
    // part — the four buttons the map names live inside the Shape PANEL now.
    const SHAPES = { sustain: 1, arp: 1, roll: 1, mixed: 1, ground: 1 };
    const genLit = SHAPES[pv2.key] ? true
      : (pv2.key === 'compose' || pv2.key === 'adopt') ? false
      : L.part.kind === 'live';        // a hand-built shape is still behind this door
    [['.v2-genbtn', genLit]].forEach(([sel, on]) => {
      const b2 = card.querySelector(sel);
      if (b2) { b2.classList.toggle('on', !!on); b2.classList.toggle('v2-matlock', lk && !!on); }
    });
    card.querySelectorAll('.v2-seedv1').forEach((b2) => {
      b2.classList.toggle('on', pv2.key === 'v1:' + b2.getAttribute('data-v1'));
      b2.classList.toggle('v2-matlock', lk);
    });
    const nc = card.querySelector('.v2-notecount');
    if (nc && nc.textContent !== pv2.txt) nc.textContent = pv2.txt;
    try { genSync(card, L); } catch (e) {}
  }
  function vizChrome(card, L, E) {
    try { matSync(card, L); } catch (e) {}
    try { neSync(card, L, E); } catch (e) {}
    try {
      const cb = card.querySelector('.v2-capture'), cf2 = capFace(L);
      if (cb && cb.textContent !== cf2.txt) { cb.textContent = cf2.txt; cb.title = cf2.title; }
    } catch (e) {}
    // 🎲's face follows the selection on a LIVE part, exactly as 🔒's does on
    // a recorded one — the button says what THIS press will do.
    try {
      const nb = card.querySelector('.v2-newtake');
      if (nb) {
        // ONE BUTTON, FOUR SENTENCES — it always makes material, and says
        // exactly what THIS press will make: a whole take or the tapped bars,
        // and on a LOCKED part it re-freezes (a take pin changes nothing
        // there — the notes are already fixed).
        const rec4 = L.part.kind === 'recorded';
        const sel4 = bselOf(L);
        const empty4 = rec4 && !((L.part.notes || []).length);
        // AN ELLIPSIS MEANS IT OPENS A DIALOG (⊕ Expand…, ✂ Split…, ⇄ Sync) —
        // with bars tapped this press shows the settings that bar generates by
        // rather than throwing the dice behind your back.
        const txt = sel4 ? ((rec4 ? '\ud83c\udfb2 Re-roll ' : '\ud83c\udfb2 Retake ') + bselLabel(sel4) + '\u2026')
          : (empty4 ? '\ud83c\udfb2 Roll a take'
          : (rec4 ? '\ud83c\udfb2 Replace with a new take' : '\ud83c\udfb2 New take'));
        if (nb.textContent !== txt) {
          nb.textContent = txt;
          nb.title = sel4
            ? ('Open the settings ' + bselLabel(sel4) + ' generates by — edit them for this alone, or roll again. The rest of the drawing holds still; tap a bar or a chord in the drawing to change which.')
            : (empty4
              ? 'Roll a take of this layer’s rules and freeze it here — there is nothing in this part yet.'
              : rec4
              ? 'Replace these notes with a fresh roll of this layer’s rules, still locked. Tap a bar in the drawing first to re-roll only that bar.'
              : 'Roll this part again. Preview never re-rolls on its own, so the take you are hearing stays until you press this. Tap a bar in the drawing first to retake only that bar.');
        }
      }
    } catch (e) {}
  }


  // ── SAVING A TAKE ───────────────────────────────────────────────────────
  // A take you like is worth keeping, and the place to keep it is the bank the
  // rest of the app already maps to CHANGES (`L.partSeqs` resolves a banked
  // phrase by NAME onto a part/pass/chord slot). So a saved take is not a
  // private list on this layer — it is a phrase, immediately mappable, and
  // deletable through the one path that prunes those mappings.
  //
  // `phraseToNotes` reads a phrase SEQUENTIALLY (each step advances the cursor
  // by `subdivision × duration` beats), so a note can never overlap the next
  // one: a sustain is clipped at the following onset. Onsets are exact.
  function notesToSteps(L) {
    const p = L.part, list = (p.notes || []).slice().sort((a, b) => a.t - b.t);
    if (!list.length) return null;
    const bars = Math.max(0.125, p.bars || 1);
    const gridN = clamp(((p.rhythm && p.rhythm.steps) | 0) || 16, 1, 64);
    const cellBeats = (bars * 4) / gridN;
    const cells = [];
    list.forEach((n) => {
      const i = Math.min(gridN - 1, Math.max(0, Math.round(n.t * gridN)));
      (cells[i] = cells[i] || []).push(n);
    });
    const mf = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const out = [];
    let i = 0;
    while (i < gridN) {
      if (!cells[i]) {
        let k = i; while (k < gridN && !cells[k]) k++;
        out.push({ freq: null, label: '\u2014', cellIndex: null, duration: (k - i), subdivision: cellBeats });
        i = k; continue;
      }
      let nx = i + 1; while (nx < gridN && !cells[nx]) nx++;
      const want = Math.max(1, Math.round(Math.max.apply(null, cells[i].map((n) => n.dur)) * gridN));
      const span = Math.max(1, Math.min(want, nx - i));
      const tr = p.transpose | 0;
      const freqs = cells[i].map((n) => mf(n.midi + tr));
      const st = { duration: span, subdivision: cellBeats, cellIndex: null,
                   label: noteName(cells[i][0].midi + tr) };
      if (freqs.length > 1) { st.freq = freqs[0]; st.chord = freqs.map((f) => ({ freq: f })); st.label = 'chord'; }
      else st.freq = freqs[0];
      out.push(st);
      i += span;
    }
    return out;
  }
  function saveTakeFn(E, L) {
    // A GENERATED PART CAN BE BANKED WITHOUT BEING FROZEN. The bank takes a
    // take whatever made it — that is why it is not filed under WRITTEN — and
    // requiring 🔒 Lock first made "save this one" also mean "and stop
    // generating", which is a different decision. The notes come from the SAME
    // helper 🔒 uses, so the banked copy is what Lock would have written, and
    // `L.part` is not touched: a shim carries them to `notesToSteps`.
    let src = L;
    if (L.part.kind !== 'recorded') {
      const notes = V2.takeNotesNow(E, L);
      if (!notes) return null;
      src = Object.assign({}, L, { part: Object.assign({}, L.part, {
        kind: 'recorded', notes: notes, transpose: L.part.transpose | 0 }) });
    }
    const steps = notesToSteps(src);
    if (!steps) return null;
    let dflt = (L.name || 'take');
    try { if (typeof uniqueSeqName === 'function') dflt = uniqueSeqName(dflt); } catch (e) {}
    let nm = null;
    try { nm = window.prompt('Save this take as:', dflt); } catch (e) {}
    if (nm == null) return null;
    nm = String(nm).trim() || dflt;
    // A NAME ALREADY IN THE BANK would SHADOW the other entry — a mapping
    // resolves the first match, so the older one becomes unreachable while
    // still visible. Ask, exactly as the phrase saver does.
    let at = -1;
    try { at = savedSequences.findIndex((x) => x && x.name === nm); } catch (e) {}
    if (at >= 0 && !window.confirm('\u201c' + nm + '\u201d already exists. Replace it?\n\n' +
      'Anything mapped to that name will play this take instead.')) return null;
    let bpm = 120;
    try { bpm = parseInt(document.getElementById('tempo-input').value, 10) || 120; } catch (e) {}
    const ent = { name: nm, kind: 'phrase', steps: steps, bpm: bpm, subdivision: 1 };
    try {
      if (at >= 0) savedSequences[at] = ent; else savedSequences.push(ent);
      if (typeof persistSaved === 'function') persistSaved();
    } catch (e) { return null; }
    return nm;
  }
  // WHAT THE BANK HOLDS, for the Saved tab. Metadata only — reading a phrase's
  // notes is `phraseToNotes`' job and costs a walk per entry.
  function bankList() {
    try {
      if (typeof savedSequences === 'undefined' || !Array.isArray(savedSequences)) return [];
      return savedSequences.map((s2, i) => ({ i: i, name: (s2 && s2.name) || ('#' + (i + 1)),
        n: ((s2 && s2.steps) || []).filter((x) => x && (x.freq != null || x.chord)).length }));
    } catch (e) { return []; }
  }

  // ── ONE NOTE, BY HAND ───────────────────────────────────────────────────
  // Tap a note in the drawing and change what it does. A LIVE part has no notes
  // to edit — its notes are a consequence of rules — so tapping one LOCKS the
  // take first and says so; that is the same act as pressing 🔒, reached from
  // the thing you were already pointing at.
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  // LOCK WHAT IS DRAWN. The remembered preview anchor is passed through so that
  // under a progression the capture freezes the chord you heard rather than
  // whichever one is sounding at the instant you pressed.
  // REPLACING WORK IS CONFIRMED. Re-rolling a locked ROLL loses nothing (it
  // was a roll of these same rules), but notes that were composed, adopted or
  // hand-edited are somebody's work — and `made` is absent on anything older
  // or unrecognised, which takes the safe side. THE SELECTION SCOPES IT: an
  // edit in bar 1 is not endangered by re-rolling bar 3.
  function replaceOK(L, selBars) {
    const cp = L.part;
    if (cp.kind !== 'recorded' || !(cp.notes || []).length) return true;
    const barsF = Math.max(0.125, cp.bars || 1);
    const inScope = (n2) => !selBars || V2.regHas(selBars, n2.t, barsF);
    const scoped = (cp.notes || []).filter(inScope);
    const edited = scoped.some(n2 => Number.isFinite(n2.vel) || Number.isFinite(n2.atk) ||
      Number.isFinite(n2.dec) || Number.isFinite(n2.sus) || Number.isFinite(n2.rel) || Number.isFinite(n2.glide));
    // a TRANSFORMED take is work too — a plain roll may be replaced silently,
    // one you reversed or shuffled may not
    if (cp.made === 'take' && !edited && !cp.tf) return true;
    const whereTxt = (selBars && selBars.length)
      ? (' in ' + selBars.map((k2) => V2.regLabel(k2)).join(' + ')) : '';
    const what = cp.made === 'compose' ? 'the phrase you composed'
      : (cp.made === 'phrase' ? ('\u201c' + (cp.from || 'the phrase you chose') + '\u201d')
      : (edited ? 'your edits to these notes' : 'these notes'));
    try {
      return !!window.confirm('Replace ' + what + whereTxt + ' with a fresh roll of this layer\u2019s rules?\n\n' +
        scoped.length + ' note' + (scoped.length === 1 ? '' : 's') + ' will be discarded. This cannot be undone.');
    } catch (e) { return true; }
  }
  function captureShown(E, L, bars) {
    let at = null;
    try {
      const pv = V2.previewCycle && V2.previewCycle();
      if (pv && pv.id === (L.id | 0) && pv.sig === V2.partSig(L) && Number.isFinite(pv.at)) at = pv.at;
    } catch (e) {}
    const o = {};
    if (at != null) o.at = at;
    if (Array.isArray(bars) && bars.length) o.bars = bars;
    // a REPLACE rolls fresh; a first LOCK freezes exactly the take drawn
    if (L.part.kind === 'recorded' && (L.part.notes || []).length) o.reroll = true;
    return V2.capture(E, L, o);
  }
  // Normalize REPLACES every note object (it maps and re-sorts), so an index is
  // only good until the next `getCfg`. Notes are re-found by WHAT THEY ARE.
  function nearestNote(notes, t, midi) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const d = Math.abs(n.t - t) + Math.abs(n.midi - midi) / 128;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // ── WHAT A NUMBER MEANS ─────────────────────────────────────────────────
  // `_ambSl` folds its `hint` into a TITLE attribute, which is invisible on a
  // phone — so a row of raw sliders reads "Position 1 · Length 2 · Attack 400"
  // and names none of its units. Reported exactly that way. These build the
  // readout text instead, and the modal paints it itself (nothing else writes
  // `.ambient-sl-v`: the delegated drag handler sets `.value` and dispatches
  // events, it does not touch the readout).
  const FRAC = { 0.25: '¼', 0.5: '½', 0.75: '¾', 0.33: '⅓', 0.67: '⅔' };
  // A count of beats, spelled the way a musician says it — "1½ beats", not 1.5.
  function beatTxt(b) {
    if (!(b > 0)) return '0';
    const whole = Math.floor(b + 1e-6), rest = Math.round((b - whole) * 100) / 100;
    const f = FRAC[rest] || (rest ? String(rest).replace(/^0/, '') : '');
    const n = (whole ? String(whole) : '') + f || String(Math.round(b * 100) / 100);
    // singular for anything up to one — "½ beat", never "½ beats"
    return n + ' beat' + (b <= 1 + 1e-6 ? '' : 's');
  }
  // WHERE in the cycle, in bars and beats — the units the ruler above is drawn
  // in, so the number and the picture describe the same thing.
  function posTxt(step, gridN, bars) {
    const perBar = Math.max(1, gridN / Math.max(0.0625, bars));
    const bar = Math.floor(step / perBar) + 1;
    const beat = ((step % perBar) / (perBar / 4)) + 1;
    const bt = Math.round(beat * 100) / 100;
    return (bars > 1 ? 'bar ' + bar + ' · ' : '') + 'beat ' + bt;
  }
  function lenTxt(steps, gridN, bars) {
    return beatTxt(steps * (4 * bars / Math.max(1, gridN)));
  }
  // A ± PRESS SNAPS AN OFF-GRID NOTE ONTO THE GRID, instead of stepping from
  // the field's ROUNDED copy of it. The shared stepper delegation parses with
  // parseInt, so the field can only carry a whole number — on a 2.7-cell note
  // it shows 3, and a press of ＋ would write 4, past the 3 the hand was
  // reaching for. `cur` is the note's TRUE value, and a press is always exactly
  // `round(cur) ± 1`, which is what tells it apart from a TYPED value (taken
  // verbatim). A note already on the grid takes the first branch, so every
  // hand-written note behaves exactly as it did.
  function neCells(cur, v, g) {
    const c = (cur || 0) * g.gridN;
    if (Math.abs(c - Math.round(c)) < 1e-6) return v;
    const shown = Math.max(0, Math.round(c));
    if (v === shown + 1) return Math.floor(c + 1e-6) + 1;
    if (v === shown - 1) return Math.ceil(c - 1e-6) - 1;
    return v;
  }
  const msTxt = (v) => (v >= 1000 ? (Math.round(v / 100) / 10) + ' s' : (v | 0) + ' ms');
  // WHICH NOTE IS OPEN, module state — transient by construction (a field on the
  // layer would be serialised by `persistWorkspace`, the documented `_soloLane`
  // trap) and cleared whenever the note it names stops existing.
  let NE = null;
  // IS THE ENVELOPE FOLD OPEN — a view preference, transient like `NE` itself
  // (a field on the layer would be serialised by `persistWorkspace`, the
  // documented `_soloLane` trap). Shut on every fresh session, and it holds
  // across notes once opened, because "show me the envelopes" is a way of
  // working rather than a property of one note.
  let NEENV = false;
  // THE EDITOR IS PART OF THE CARD, NOT A DIALOG OVER IT. It was a body-attached
  // `.sm-overlay`, which covered the drawing you were editing against — you
  // could not see the note move. It renders INSIDE `.v2-partviz`, directly under
  // the canvas, so the picture stays visible and the editor travels with it when
  // the sheet lifts the viz block above its tabs.
  function neHtml() { return '<div class="v2-neinline" hidden></div>'; }
  function neClear() { NE = null; }
  function neOpen(E, L, idx, card) {
    NE = { id: L.id | 0, idx: idx | 0 };
    try { drawPartViz(card, L, E); } catch (e) {}
    // bring its HEAD into view — it opens below the fold on a phone when the
    // card is scrolled to the top of the drawing. NOT `scrollIntoView`: the
    // editor is TALLER than a phone viewport, so `nearest` aligns its top and
    // scrolls the DRAWING clean off the screen (measured 503px for one tap —
    // "the screen jumps") — which defeats the inline editor's whole reason to
    // exist, seeing the note while you edit it. Reveal the least that shows
    // the editor has opened; the note you tapped stays where your eye is.
    try {
      const host = card && card.querySelector('.v2-neinline');
      if (host) {
        const r = host.getBoundingClientRect();
        const vh = window.innerHeight || 780;
        // the visible band is the SCROLLER's, not the viewport's: when the
        // panel scrolls inside `#mix-view`, an editor below the container's
        // bottom edge is clipped however much of the viewport remains
        const sc = scrollerOf(host);
        let limit = vh;
        try {
          const sr = sc.getBoundingClientRect ? sc.getBoundingClientRect() : null;
          if (sr && sr.bottom > 0) limit = Math.min(vh, sr.bottom);
        } catch (e) {}
        const over = r.top - (limit - 200);
        if (over > 0) {
          // the nearest scroller first, any clamped remainder to the document
          const was = sc.scrollTop;
          sc.scrollTop = was + over;
          const rest = over - (sc.scrollTop - was);
          if (rest > 1) {
            const d2 = document.scrollingElement || document.documentElement;
            if (d2 && d2 !== sc) d2.scrollTop += rest;
          }
        }
      }
    } catch (e) {}
  }
  // THE FALLBACK a field takes when the note states nothing — shown so the
  // sliders open where the note actually sounds rather than at zero.
  function neFallback(L) {
    const inst = L.instrument || {};
    return { atk: num(inst.attack, 10), dec: num(inst.decay, 200),
             sus: num(inst.sustain, 70), rel: num(inst.release, 600) };
  }
  // ONE GRID for everything that places a note by hand — the editor's Position
  // and Length sliders, the drag, the resize and the add. Two notions of "the
  // grid" is how a dragged note and a typed one come to land on different
  // beats.
  function neGrid(L) {
    return { gridN: V2.gridCells(L), perBar: V2.gridPerBar(L),
             bars: Math.max(0.0625, L.part.bars || 1) };
  }
  // THE PITCH THE EDITOR SHOWS. On a harmony-remapping part (diatonic /
  // chordlock) the stored midi is NOT what sounds — the remap sits between
  // them, and it is non-monotonic (the octave-hugging clamp), so a ± stepper
  // over the STORED value moved the drawn block "around like crazy" (field
  // report). The Note control therefore shows and edits the SOUNDING pitch,
  // read off the drawn note itself (hit boxes carry it); the first edit PINS
  // the note (`hx`), after which stored IS sounding and ± is linear.
  function neShownMidi(host, L, idx) {
    const n = L.part && Array.isArray(L.part.notes) && L.part.notes[idx];
    if (!n) return 0;
    if (!n.hx && (L.harmony === 'diatonic' || L.harmony === 'chordlock')) {
      try {
        const card = host.closest('.v2-layer');
        const cv = card && card.querySelector('.v2-vizcv');
        const hb = cv && (cv._hits || []).find((x) => x.i === idx);
        if (hb && Number.isFinite(hb.midi)) return Math.round(hb.midi);
      } catch (e) {}
    }
    return n.midi | 0;
  }
  // ── \u2295 EXPAND — chords that CONTAIN the open note ───────────────────
  // "Build a harmony/chord on top of that selected note by selecting a chord
  // the note could possibly be in — as the tonic or the flat 5th or 9th or
  // whatever." Every (root × quality) whose pitch classes hold the note's
  // SOUNDING pitch class is offered, labelled with the note's role in it.
  // REAL BUTTONS, not a native select: the in-key/out-of-key split is COLOR
  // (green = in the key, orange = borrowed) and option styling is not
  // dependable across platforms (the documented rule). The key comes from
  // `V2.scaleAt` at the drawing's own anchor — the same call that lights the
  // keyboard's in-scale keys, so the two can never disagree.
  const NEX_QUALS = [
    ['maj', [0, 4, 7]], ['m', [0, 3, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]],
    ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]],
    ['m7', [0, 3, 7, 10]], ['m7\u266d5', [0, 3, 6, 10]], ['dim7', [0, 3, 6, 9]],
    ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['9', [0, 2, 4, 7, 10]],
    ['maj9', [0, 2, 4, 7, 11]], ['m9', [0, 2, 3, 7, 10]], ['add9', [0, 2, 4, 7]]];
  const NEX_ROLE = { 0: 'root', 1: '\u266d9', 2: '9th', 3: '\u266d3', 4: '3rd', 5: '11th',
    6: '\u266d5', 7: '5th', 8: '\u266f5', 9: '6th', 10: '\u266d7', 11: 'maj7' };
  const NEX_PCN = ['C', 'C\u266f', 'D', 'D\u266f', 'E', 'F', 'F\u266f', 'G', 'G\u266f', 'A', 'A\u266f', 'B'];
  function nexBuild(E, host, L, idx) {
    const nx = host.querySelector('.v2-nex'); if (!nx) return;
    const m = neShownMidi(host, L, idx);
    const pc = ((m % 12) + 12) % 12;
    let keyPcs = null;
    try {
      const card = host.closest('.v2-layer');
      const cv = card && card.querySelector('.v2-vizcv');
      keyPcs = V2.scaleAt(E, E.getCfg(), (cv && cv._cs) || 0, L);
    } catch (e) { keyPcs = null; }
    const opts = [];
    for (let r = 0; r < 12; r++) {
      NEX_QUALS.forEach(([qn, ivs]) => {
        const iv = ((pc - r) + 12) % 12;
        if (ivs.indexOf(iv) < 0) return;
        const inKey = keyPcs ? ivs.every((k) => keyPcs[(r + k) % 12]) : null;
        opts.push({ r, qn, ivs, iv, inKey });
      });
    }
    // the note's ROLE orders the list — the chords it is the root of first,
    // then as the 3rd, the 5th, the colours last
    opts.sort((a, b) => (a.iv - b.iv) || (a.r - b.r) || (a.ivs.length - b.ivs.length));
    const pcn = (r) => (typeof _pcName === 'function') ? _pcName(r) : NEX_PCN[r];
    const nameOf = (o) => pcn(o.r) + (o.qn === 'maj' ? '' : o.qn);
    const btn = (o) => '<button type="button" class="v2-nexbtn' +
      (o.inKey === false ? ' v2-nex-out' : (o.inKey ? ' v2-nex-in' : '')) + '" data-na="nexpick"' +
      ' data-root="' + o.r + '" data-iv="' + o.iv + '" data-ivs="' + o.ivs.join(',') + '"' +
      ' title="Add the other tones of ' + esc(nameOf(o)) + ' at this note\u2019s position.">' +
      esc(nameOf(o)) + ' <span class="v2-nexrole">\u00b7 ' + (NEX_ROLE[o.iv] || o.iv) + '</span></button>';
    const ins = opts.filter((o) => o.inKey), outs = opts.filter((o) => o.inKey === false);
    const neut = opts.filter((o) => o.inKey == null);
    nx.innerHTML =
      '<div class="v2-nesec">\u2295 Expand \u2014 chords holding ' + esc(noteName(m)) + '</div>' +
      (ins.length ? '<div class="v2-nexgrp v2-nexgrp-in">In the key</div><div class="v2-nexrow">' + ins.map(btn).join('') + '</div>' : '') +
      (outs.length ? '<div class="v2-nexgrp v2-nexgrp-out">Outside the key</div><div class="v2-nexrow">' + outs.map(btn).join('') + '</div>' : '') +
      (neut.length ? '<div class="v2-nexrow">' + neut.map(btn).join('') + '</div>' : '');
    nx.hidden = false;
  }
  function neBuild(host, L, idx) {
    const p = L.part, n = p.notes[idx], g = neGrid(L), fb = neFallback(L);
    const shownM = neShownMidi(host, L, idx);
    const stepPos = Math.round(n.t * g.gridN), stepLen = Math.max(1, Math.round(n.dur * g.gridN));
    // how many envelope fields this note OWNS \u2014 the shut fold's summary
    const envOwn = ['atk', 'dec', 'sus', 'rel', 'glide'].filter((k) => Number.isFinite(n[k])).length;
    const sfSl = (sf, label, min, max, val, hint) => {
      const h = (typeof _ambSl === 'function') ? _ambSl(label, 'v2-ne-' + (L.id | 0) + '-' + sf, min, max, val, hint) : '';
      return h.replace('class="ambient-sl"', 'class="ambient-sl" data-sf="' + sf + '"');
    };
    // THE FIELD NAMES THE VALUE; THE NUMBER RIDES IN `data-sv`. Note 57,
    // Position 12 and Length 12 are indices into things the user thinks in
    // — a pitch, a bar and beat, a count of beats — and the editor already
    // KNEW all three: it printed them in a readout column beside the field
    // while the field itself carried the index. Reported as "the numerical
    // values are meaningless". So the name moves INTO the field, the shared
    // ± delegation steps `data-sv` (its opt-in), and the readout column
    // carries the description it always had in an invisible `title`.
    // READONLY because the field is text now: `parseInt('A3')` is NaN, so a
    // typed value could only ever be a number pretending to be a name. Every
    // other way in is untouched — ±, the piano keys, ⇧/⌥ + arrows, the drag.
    const sfStep = (sf, label, min, max, val, face, hint) => {
      if (typeof _ambStep !== 'function') return sfSl(sf, label, min, max, val, hint);
      return _ambStep(label, 'v2-ne-' + (L.id | 0) + '-' + sf, min, max, val, hint)
        .replace('type="number" inputmode="numeric" class="ambient-step-inp"',
                 'type="text" readonly class="ambient-step-inp v2-nefield" data-sf="' + sf +
                 '" data-sv="' + (val | 0) + '"')
        .replace(' step="1" value="' + (val | 0) + '" />', ' value="' + esc(face) + '" />');
    };
    host.innerHTML =
      '<div class="v2-nehead">' +
        '<span class="v2-netitle">Note ' + (idx + 1) + ' of ' + p.notes.length + ' \u00b7 ' + esc(noteName(shownM)) + '</span>' +
        // Remove sits in the head, left of the close (user-placed, 2026-09-05)
        // — still the house destructive red, never beside the benign pair.
        '<button type="button" class="ambient-seg v2-nerm" data-na="rm">\u2715 Remove note</button>' +
        '<button type="button" class="v2-neclose" data-na="done" aria-label="Close">\u2715</button>' +
      '</div>' +
      // POSITION AND LENGTH ARE ± STEPPERS, not sliders (stated 2026-09-08:
      // "large +/- button sets for easy use on mobile") — the Note row's own
      // pattern, so the document-level ± delegation and the `data-sf` commit
      // serve them with no wiring of their own. One press = one grid cell.
      sfStep('midi', 'Note', 0, 127, shownM, noteName(shownM), 'the pitch it plays') +
      sfStep('pos', 'Position', 0, Math.max(1, g.gridN - 1), stepPos,
             posTxt(n.t * g.gridN, g.gridN, g.bars), 'where in the cycle it starts') +
      sfStep('len', 'Length', 1, g.gridN * 2, stepLen,
             lenTxt(n.dur * g.gridN, g.gridN, g.bars), 'how long it sounds') +
      sfSl('vel', 'Volume', 0, 200, num(n.vel, 100), 'against the layer\u2019s own level') +
      // THE ENVELOPE FOLDS, AND IT IS SHUT BY DEFAULT. Five rows that almost
      // always read `\u00b7 layer` are the tallest thing in the editor and the
      // least often touched, and they pushed the four ACTIONS below the fold
      // on a phone. A shut fold must still say what it is holding, or it is
      // the documented drum-solo bug in a costume \u2014 so the head counts the
      // values this note actually owns and goes amber when there are any.
      '<button type="button" class="v2-nesec v2-nefold' + (NEENV ? ' open' : '') +
        (envOwn ? ' v2-nefold-own' : '') + '" data-na="envfold" aria-expanded="' +
        (NEENV ? 'true' : 'false') + '">' +
        '<span class="v2-nefcar">' + (NEENV ? '\u25be' : '\u25b8') + '</span> Envelope \u00b7 ' +
        (envOwn ? (envOwn + ' set on this note') : 'all from the layer') + '</button>' +
      '<div class="v2-neenv"' + (NEENV ? '' : ' hidden') + '>' +
        sfSl('atk', 'Attack', 0, 4000, num(n.atk, fb.atk), 'time to reach full volume') +
        sfSl('dec', 'Decay', 0, 4000, num(n.dec, fb.dec), 'time to fall to the sustain level') +
        sfSl('sus', 'Sustain', 0, 100, num(n.sus, fb.sus), 'level it holds at') +
        sfSl('rel', 'Release', 0, 8000, num(n.rel, fb.rel), 'time to fade after it ends') +
        sfSl('glide', 'Portamento', 0, 2000, num(n.glide, 0), 'slide in from the note before') +
      '</div>' +
      '<div class="v2-nebtns">' +
        '<button type="button" class="ambient-seg" data-na="expand" title="Build a chord on top of this note \u2014 pick one of the chords that CONTAIN it, and the other tones are added at its position.">\u2295 Expand\u2026</button>' +
        // \u2702 SPLIT sits beside \u2295 Expand because they are the same kind of act
        // on the open note \u2014 one DIVIDES it in time, the other BUILDS on it in
        // pitch \u2014 and both open a dialog that does the arithmetic. It was a
        // MODE, which meant switching the picker, tapping the note and switching
        // back for something the tap had already done.
        '<button type="button" class="ambient-seg" data-na="split" title="Divide this note into several \u2014 the pieces fill exactly its own length.">\u2702 Split\u2026</button>' +
        '<button type="button" class="ambient-seg" data-na="env">\u21ba Layer envelope</button>' +
        '<button type="button" class="ambient-seg" data-na="hear">\u25b6 Hear it</button>' +
      '</div>' +
      '<div class="v2-nex" hidden></div>' +
      '<div class="v2-nehint">\ud83c\udfb9 Tap a key on the piano to move this note. ' +
        '\u21e7 + arrows move it on the grid, \u2325 + \u2190/\u2192 resize it. ' +
        'Volume and the envelope are this note\u2019s own \u2014 everything else on the card still applies. ' +
        'A value marked <b>layer</b> is inherited; move it and this note keeps its own.</div>';
    host._idx = idx;
    host._lid = L.id | 0;
  }
  // THE READOUT IS THE CONTROL'S ONLY LABEL ON A PHONE, so it carries the unit
  // AND, for an inherited field, the fact that it is inherited — "400 ms ·
  // layer" answers "is this note different?" without opening anything.
  function nePaint(host, L, idx) {
    const p = L.part, n = p.notes[idx]; if (!n) return;
    const g = neGrid(L);
    const put = (sf, txt) => {
      const el = host.querySelector('[data-sf="' + sf + '"]');
      const row = el && el.closest('.ambient-ctrl');
      const rd = row && (row.querySelector('.ambient-sl-v') || row.querySelector('.ambient-hint'));
      if (rd) rd.textContent = txt;
    };
    // A NAMED FIELD: the face goes in the field and the number back into
    // `data-sv`, so the next ± press steps from what is on screen. Both,
    // always — a face repainted without its number is a control that reads
    // right and steps from a stale value.
    const putField = (sf, n0, txt) => {
      const el = host.querySelector('.v2-nefield[data-sf="' + sf + '"]');
      if (!el) return false;
      if (el.getAttribute('data-sv') !== String(n0 | 0)) el.setAttribute('data-sv', String(n0 | 0));
      if (el.value !== txt) el.value = txt;
      return true;
    };
    const v = (sf) => { const el = host.querySelector('[data-sf="' + sf + '"]'); return el ? (parseInt(el.value, 10) | 0) : 0; };
    const shown = neShownMidi(host, L, idx);
    if (!putField('midi', shown, noteName(shown))) put('midi', noteName(shown));
    // THE NOTE'S OWN LENGTH, NOT THE FIELD'S ROUNDED COPY. A generated take's
    // notes are a PERCENTAGE of their slot (Length 90%), so a 3-cell slot
    // stores 2.7 cells — and the stepper, which can only carry a whole number,
    // rounded that to 3 and the row read "3 · 3 beats" beside a drawing that
    // honestly showed 2.7. Reported as "a note 1 bar long should fit the bar":
    // it was never a bar, the editor said it was. The picture was right all
    // along, so the READOUT is what had to give.
    const posTx = posTxt(n.t * g.gridN, g.gridN, g.bars);
    const lenTx = lenTxt(n.dur * g.gridN, g.gridN, g.bars);
    if (!putField('pos', Math.round(n.t * g.gridN), posTx)) put('pos', posTx);
    if (!putField('len', Math.max(1, Math.round(n.dur * g.gridN)), lenTx)) put('len', lenTx);
    // 100% IS "as the layer plays it", so "100% · layer" states the same fact
    // twice and reads as a unit nobody asked about. Name the relationship.
    const vv = v('vel');
    put('vel', vv === 0 ? 'silent' : (vv === 100 ? 'as the layer' : vv + '% of the layer'));
    put('atk', msTxt(v('atk')) + (Number.isFinite(n.atk) ? '' : ' \u00b7 layer'));
    put('dec', msTxt(v('dec')) + (Number.isFinite(n.dec) ? '' : ' \u00b7 layer'));
    put('sus', v('sus') + '%' + (Number.isFinite(n.sus) ? '' : ' \u00b7 layer'));
    put('rel', msTxt(v('rel')) + (Number.isFinite(n.rel) ? '' : ' \u00b7 layer'));
    put('glide', v('glide') > 0 ? msTxt(v('glide')) : 'off');
    // the SHUT fold must never hide state (the drum-solo rule), so its head
    // repaints with the count as the sliders inside it are moved
    const fold = host.querySelector('.v2-nefold');
    if (fold) {
      const own = ['atk', 'dec', 'sus', 'rel', 'glide'].filter((k) => Number.isFinite(n[k])).length;
      const car = fold.querySelector('.v2-nefcar');
      const txt = ' Envelope \u00b7 ' + (own ? (own + ' set on this note') : 'all from the layer');
      if (fold.lastChild && fold.lastChild.nodeType === 3) {
        if (fold.lastChild.nodeValue !== txt) fold.lastChild.nodeValue = txt;
      }
      fold.classList.toggle('v2-nefold-own', !!own);
      if (car) car.textContent = NEENV ? '\u25be' : '\u25b8';
    }
    const t2 = host.querySelector('.v2-netitle');
    if (t2) t2.textContent = 'Note ' + (idx + 1) + ' of ' + p.notes.length + ' \u00b7 ' + noteName(shown);
  }
  // Called at the end of every draw. REBUILDS ONLY WHEN THE NOTE CHANGES — the
  // drawing is repainted on every edit, and rewriting the markup would destroy
  // the slider under the finger mid-drag (the documented repaint trap).
  function neSync(card, L, E) {
    const host = card && card.querySelector('.v2-neinline'); if (!host) return;
    const p = L.part;
    const live = NE && NE.id === (L.id | 0) && p && p.kind === 'recorded' &&
                 Array.isArray(p.notes) && p.notes[NE.idx];
    if (!live) {
      if (NE && NE.id === (L.id | 0)) NE = null;
      if (!host.hidden) { host.hidden = true; host.innerHTML = ''; host._idx = -1; }
      return;
    }
    if (host.hidden || host._idx !== NE.idx || host._lid !== (L.id | 0)) {
      neBuild(host, L, NE.idx);
      host.hidden = false;
    }
    nePaint(host, L, NE.idx);
  }
  // ONE input branch, delegated on the panel host so it survives every card
  // rebuild — the documented rule for a control on a re-rendered surface.
  function neInput(E, el) {
    const host = el.closest('.v2-neinline'); if (!host || !NE) return false;
    // `data-sv` is the numeric truth wherever the FIELD shows a name (Note,
    // Position, Length) — reading `.value` there parses 'A3' as NaN.
    const sv = el.getAttribute && el.getAttribute('data-sv');
    const v = parseInt(sv !== null && sv !== undefined ? sv : el.value, 10);
    if (!Number.isFinite(v)) return true;
    return neApply(E, host, el.getAttribute('data-sf'), v);
  }
  // …and the shared tail. `rebuild` is false for a slider (it is under a
  // finger and replacing it mid-drag kills the drag — the documented bug) and
  // true when the value came from somewhere else, so the editor's own readouts
  // follow a pitch set on the keyboard.
  // ── ⬚ MULTI: ONE WRITER FOR EVERY GATHERED NOTE ─────────────────────────
  // A DELTA, applied uniformly — which is the whole point of the mode: the
  // notes keep their relationship to each other, so the shape moves rather
  // than being re-laid. The delta is CLAMPED ONCE against the whole set (not
  // per note) — clamping each independently would let the leading note stop
  // while the rest carried on, which is the opposite of uniform. Same rules as
  // the single-note path: the grid, the `hx` pin on a remapping part (the hand
  // wins), and a re-find by IDENTITY after normalize, which replaces every note
  // object and re-sorts.
  function multiApply(E, L, what, steps) {
    if (!L || !L.part || L.part.kind !== 'recorded') return false;
    const sel = mselOf(L); if (!sel || !sel.size) return false;
    const p = L.part, g = neGrid(L), cell = 1 / Math.max(1, g.gridN);
    const idxs = [...sel].filter((i) => p.notes[i]).sort((a, b) => a - b);
    if (!idxs.length) return false;
    const ns = idxs.map((i) => p.notes[i]);
    let d = steps | 0; if (!d) return false;
    if (what === 'midi') {
      // the HAND WINS on a remapping part, exactly as the drag and the editor
      // do — otherwise the remap re-voices the note and the move is undone
      if (L.harmony === 'diatonic' || L.harmony === 'chordlock') ns.forEach((n) => { n.hx = 1; });
      const lo = Math.min(...ns.map((n) => n.midi | 0)), hi = Math.max(...ns.map((n) => n.midi | 0));
      d = clamp(d, -lo, 127 - hi);
      if (!d) return false;
      ns.forEach((n) => { n.midi = clamp((n.midi | 0) + d, 0, 127); });
    } else if (what === 't') {
      // …and a time move must not re-voice them either (the `pos` rule)
      if (L.harmony === 'diatonic' || L.harmony === 'chordlock') ns.forEach((n) => { n.hx = 1; });
      const lo = Math.min(...ns.map((n) => n.t)), hi = Math.max(...ns.map((n) => n.t));
      const loK = Math.round(lo / cell), hiK = Math.round(hi / cell);
      const maxK = Math.max(0, Math.round((1 - cell / 2) / cell));
      d = clamp(d, -loK, maxK - hiK);
      if (!d) return false;
      ns.forEach((n) => { n.t = clamp(Math.round(n.t / cell) * cell + d * cell, 0, 0.99999); });
    } else if (what === 'dur') {
      // never shorter than a cell, never past the end of the cycle
      const minK = Math.min(...ns.map((n) => Math.round(n.dur / cell)));
      const room = Math.min(...ns.map((n) => Math.floor((1 - n.t) / cell) - Math.round(n.dur / cell)));
      d = clamp(d, 1 - minK, Math.max(0, room));
      if (!d) return false;
      ns.forEach((n) => {
        n.dur = Math.max(cell, Math.min(1 - n.t, Math.round(n.dur / cell) * cell + d * cell));
      });
    } else return false;
    // IDENTITY, not index — the array is rebuilt and re-sorted by normalize
    const ids = ns.map((n) => ({ t: n.t, midi: n.midi }));
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    try { E.getCfg(); } catch (e) {}
    const next = new Set();
    ids.forEach((q) => { const j = nearestNote(p.notes, q.t, q.midi); if (j >= 0) next.add(j); });
    mselSet(L, next);
    return true;
  }
  // WHAT IS GATHERED, said on the card. A gathering that can vanish while its
  // widget keeps state is the documented drum-solo bug, so the count is on
  // screen whenever there is one — and the row is absent when there is not,
  // because a stepper over an empty selection cannot act.
  function multiSync(card, L) {
    const bar = card && card.querySelector('.v2-multibar'); if (!bar) return;
    const sel = (modeOf(L) === 'multi') ? mselOf(L) : null;
    const n = (sel && sel.size) || 0;
    bar.hidden = !n;
    if (!n) return;
    const lab = bar.querySelector('.v2-multin');
    const txt = '\u2b1a ' + n + ' note' + (n === 1 ? '' : 's') + ' gathered';
    if (lab && lab.textContent !== txt) lab.textContent = txt;
  }
  function neApply(E, host, sf, v, rebuild) {
    if (!host || !NE) return false;
    const L = _ambLayerByKey && _ambLayerByKey(E, 'v2:' + NE.id);
    if (!L || !L.part || L.part.kind !== 'recorded') return false;
    const p = L.part, n = p.notes[NE.idx]; if (!n) return false;
    const g = neGrid(L);
    if (sf === 'midi') {
      // an explicit pitch is a placement. On a remapping part the Note field
      // SHOWS the sounding pitch, so `v` arrives in sounding space: PIN the
      // note and write it verbatim — stored IS sounding once pinned, ± is
      // linear, and the keyboard's absolute key lands exactly.
      if (L.harmony === 'diatonic' || L.harmony === 'chordlock') n.hx = 1;
      n.midi = clamp(v, 0, 127);
    }
    else if (sf === 'pos') {
      // MOVING A NOTE IN TIME MUST NOT MOVE IT IN PITCH. On a remapping part
      // (diatonic/chordlock) the drawn pitch is a function of the chord AT THE
      // NOTE'S OWN ONSET, so stepping Position across a change re-voiced the
      // note toward the new chord's tones — "moving past a bar boundary shifts
      // it up or down toward the nearest note". The hand wins (the drag's own
      // rule): pin at the pitch currently DRAWN, then move it — time and pitch
      // stay independent axes.
      if (!n.hx && (L.harmony === 'diatonic' || L.harmony === 'chordlock')) {
        n.midi = clamp(neShownMidi(host, L, NE.idx), 0, 127);
        n.hx = 1;
      }
      n.t = clamp(neCells(n.t, v, g) / g.gridN, 0, 0.99999);
    }
    else if (sf === 'len') n.dur = Math.max(0.001, neCells(n.dur, v, g) / g.gridN);
    // A field set back to what the layer would have done is DELETED — absent is
    // the one representation of "the layer decides", so a note never carries a
    // value that merely agrees with its layer.
    else if (sf === 'vel') { if (v === 100) delete n.vel; else n.vel = v; }
    else if (sf === 'glide') { if (v <= 0) delete n.glide; else n.glide = v; }
    else if (sf === 'atk' || sf === 'dec' || sf === 'sus' || sf === 'rel') n[sf] = v;
    else return false;
    const t = n.t, midi = n.midi;
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    try { E.getCfg(); } catch (e) {}          // normalize: coerce, prune, RE-SORT
    // The array is new and re-sorted, so the note is re-found by WHAT IT IS.
    NE.idx = nearestNote(p.notes, t, midi);
    host._idx = NE.idx;                        // no rebuild: the slider is under a finger
    const card = host.closest('.v2-layer');
    if (rebuild) { neBuild(host, L, NE.idx); host.hidden = false; }
    try { drawPartViz(card, L, E); } catch (e) {}
    nePaint(host, L, NE.idx);
    return true;
  }
  function neAct(E, b) {
    const host = b.closest('.v2-neinline'); if (!host || !NE) return false;
    const L = _ambLayerByKey && _ambLayerByKey(E, 'v2:' + NE.id);
    if (!L || !L.part) return false;
    const p = L.part, act = b.getAttribute('data-na'), n = p.notes[NE.idx];
    const card = host.closest('.v2-layer');
    const redraw = () => { try { drawPartViz(card, L, E); } catch (e) {} };
    if (act === 'done') { NE = null; redraw(); return true; }
    if (act === 'rm') {
      if (n) {
        p.notes.splice(NE.idx, 1);
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
        try { E.getCfg(); } catch (e) {}
        try { if (typeof showToast === 'function') showToast('Note removed \u2014 ' + p.notes.length + ' left.', { ms: 3000 }); } catch (e) {}
      }
      NE = null; redraw(); return true;
    }
    if (act === 'env' && n) {
      delete n.atk; delete n.dec; delete n.sus; delete n.rel;
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      try { E.getCfg(); } catch (e) {}
      host._idx = -1;                          // a deliberate rebuild: nothing is being dragged
      neSync(card, L, E); redraw(); return true;
    }
    if (act === 'envfold') {
      NEENV = !NEENV;
      const box = host.querySelector('.v2-neenv');
      if (box) box.hidden = !NEENV;
      b.classList.toggle('open', NEENV);
      b.setAttribute('aria-expanded', NEENV ? 'true' : 'false');
      const car = b.querySelector('.v2-nefcar');
      if (car) car.textContent = NEENV ? '\u25be' : '\u25b8';
      return true;
    }
    if (act === 'hear') { try { V2.preview(E, L); } catch (e) {} return true; }
    if (act === 'split' && n) {
      // THE INDEX FIRST — closing the editor clears `NE`, and the divider needs
      // to know which note it is dividing. The editor closes because the two
      // are different surfaces over one note and leaving it open behind the
      // dialog would show a note the split is about to replace.
      const i0 = NE.idx | 0;
      NE = null; redraw();
      try { splitModal(E, card, L, i0); } catch (e) {}
      return true;
    }
    if (act === 'expand' && n) {
      const nx = host.querySelector('.v2-nex'); if (!nx) return true;
      if (!nx.hidden) { nx.hidden = true; nx.innerHTML = ''; return true; }
      try { nexBuild(E, host, L, NE.idx); } catch (e) {}
      return true;
    }
    if (act === 'nexpick' && n) {
      const r0 = parseInt(b.getAttribute('data-root'), 10) | 0;
      const iv0 = parseInt(b.getAttribute('data-iv'), 10) | 0;
      const ivs0 = String(b.getAttribute('data-ivs') || '').split(',').map((x) => parseInt(x, 10) | 0);
      const m = neShownMidi(host, L, NE.idx);
      const rootM = m - iv0;
      // sounding \u2192 stored: pinned exact on a remapping part, shift-corrected
      // under transpose/register otherwise \u2014 the pencil's own two rules, so
      // the chord SOUNDS exactly as picked whatever the part's shifts are.
      const hz2 = (L.harmony === 'diatonic' || L.harmony === 'chordlock');
      const regNow = clamp((L.instrument.register | 0) || 4, 1, 8);
      const tr2 = (p.transpose | 0) + (Number.isFinite(p.reg) ? (regNow - p.reg) * 12 : 0);
      let added = 0;
      ivs0.forEach((k) => {
        if (k === iv0) return;                      // the open note IS this tone
        const tgt = rootM + k;
        if (!(tgt >= 0 && tgt <= 127)) return;
        const storeV = clamp(hz2 ? tgt : tgt - tr2, 0, 127);
        if (p.notes.some((x) => Math.abs(x.t - n.t) < 1e-6 && (x.midi | 0) === storeV)) return;
        const nn = { t: n.t, midi: storeV, dur: n.dur };
        if (hz2) nn.hx = 1;
        p.notes.push(nn); added++;
      });
      const t0 = n.t, m0 = n.midi;
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      try { E.getCfg(); } catch (e) {}               // coerce, prune, RE-SORT
      NE.idx = nearestNote(p.notes, t0, m0);
      const nx2 = host.querySelector('.v2-nex');
      if (nx2) { nx2.hidden = true; nx2.innerHTML = ''; }
      host._idx = -1;                                // deliberate rebuild
      neSync(card, L, E); redraw();
      try { if (typeof showToast === 'function') showToast('\u2295 ' + added + ' note' + (added === 1 ? '' : 's') + ' added at this position.', { ms: 3500 }); } catch (e) {}
      return true;
    }
    return false;
  }

  // 'ground' IS an option: without it a Groundwork part's select rendered
  // BLANK (value matches no option), which read as broken and invited the pick
  // that drifted the rules to Pulse — one sustained chord, forever.
  const RHYTHM_OPTS = [['pulse', 'Pulse — evenly'], ['euclid', 'Pattern — a grid you edit'],
                       ['chance', 'Chance — scattered'], ['ground', 'Groundwork — on every change']];
  // What the select should SHOW for a given kind. A `<select>` whose value
  // matches no option renders BLANK (documented trap), and 'drawn' has no
  // option — so it reads as its generator.
  const rhythmShown = (k) => (k === 'drawn' ? 'euclid' : k);

  // THE PATTERN GRID. Reuses v1's euclid-grid chrome exactly — container
  // `.ambient-slice-grid.ambient-euclid-cells` with `--eucols`, cells
  // `.ambient-slice-cell.ambient-euclid-cell[.on]` — so it is visually
  // indistinguishable from the pattern editor on a Bass or a Beat, which is the
  // point: it IS that editor, in the v2 vocabulary. Cells beyond 16 wrap onto a
  // second row rather than shrinking (no horizontal scroll, UI rule 1).
  //
  // Under `euclid` the cells are GENERATED live from Pulses/Steps/Rotate and
  // nothing is stored; under `drawn` they are the stored override. One view,
  // either way — so the knobs and the grid are never two pictures of one thing.
  function viewCells(L) {
    const r = (L.part && L.part.rhythm) || {};
    return (r.kind === 'drawn') ? (r.cells || []) : V2.euclidCells(r.pulses, r.steps, r.rotate);
  }
  // THE MULTI-LANE GRID — v1's drum-lanes chrome exactly: a `.ambient-euclid-row`
  // per lane, the lane NAME as a `.ambient-euclid-drumlbl` label, and the same
  // cell classes. Eight lanes at 390px is why v1's kit cells sit at 22px rather
  // than the 30px touch floor; matched here for the same reason.
  function lanesHtml(L) {
    const r = L.part.rhythm || {}, st = Math.max(1, r.steps | 0), lanes = r.lanes || [];
    let h = '<div class="ambient-euclid-grid v2-lanes">';
    for (let li = 0; li < V2.LANES; li++) {
      const row = lanes[li] || [];
      h += '<div class="ambient-euclid-row ambient-euclid-kitrow">' +
'<span class="ambient-euclid-drumlbl" title="' + esc(V2.LANE_NAMES[li]) + '">' + esc(V2.LANE_NAMES[li]) + '</span>' +
        '<div class="ambient-slice-grid ambient-euclid-cells v2-lanecells" data-lane="' + li + '" style="--eucols:' + Math.min(st, 16) + '">' +
          Array.from({ length: st }, (_, i) =>
            '<button type="button" class="ambient-slice-cell ambient-euclid-cell v2-lanecell' + (row[i] ? ' on' : '') +
            '" data-lane="' + li + '" data-ci="' + i + '" aria-pressed="' + (row[i] ? 'true' : 'false') +
            '" title="' + esc(V2.LANE_NAMES[li]) + ' — step ' + (i + 1) + '"></button>').join('') +
        '</div>' +
      '</div>';
    }
    return h + '</div>';
  }

  // THE TRANCE-GATE PATTERN. Its own class and store — the same chrome as the
  // rhythm grid but a different question (which steps SOUND, not which steps
  // have a note), so sharing a cell class would make one tap ambiguous.
  function tgCellsHtml(L) {
    const tg = (L.tg && typeof L.tg === 'object') ? L.tg : {};
    const st = clamp((tg.steps | 0) || 16, 1, 32), pat = tg.pattern || [];
    let h = '<div class="ambient-slice-grid ambient-euclid-cells v2-tgcells" style="--eucols:' + Math.min(st, 16) + '">';
    for (let i = 0; i < st; i++) {
      h += '<button type="button" class="ambient-slice-cell ambient-euclid-cell v2-tgcell' +
        (pat[i] ? ' on' : '') + '" data-ci="' + i + '" aria-pressed="' + (pat[i] ? 'true' : 'false') +
        '" title="Step ' + (i + 1) + ' — ' + (pat[i] ? 'sounds' : 'cut') + '"></button>';
    }
    return h + '</div>';
  }

  // THE NOTE ROW. v1's melodic-euclid strip exactly (`.ambient-euclid-notes` /
  // `.ambient-euclid-notelbl`, the same `--eucols` so a label sits under its
  // step). Each label is a BUTTON: tap to raise the degree, wrapping at the top.
  // Only steps that SOUND get a name — a label under a silent step would name a
  // note nobody hears.
  function noteRowHtml(L) {
    const r = L.part.rhythm || {};
    const st = Math.max(1, r.steps | 0), cells = viewCells(L);
    let h = '<div class="ambient-euclid-notes v2-notes" style="--eucols:' + Math.min(st, 16) + '">';
    for (let i = 0; i < st; i++) {
      const on = !!cells[i];
      // A SILENT step's label is DISABLED — editing the note of a step that does
      // not sound stores a value with no audible effect, which reads as a dead
      // control. The cell above is what turns the step on.
      h += '<button type="button"' + (on ? '' : ' disabled') +
        ' class="ambient-euclid-notelbl v2-note' + (on ? ' set' : ' off') +
        '" data-ci="' + i + '" title="Step ' + (i + 1) + (on ? ' — tap to change the note' : ' (silent — turn the step on above)') + '">' +
        (on ? esc(degLabel(L, i)) : '\u00b7') + '</button>';
    }
    return h + '</div>';
  }
  // What degree `i` actually SOUNDS as, asked of the emitter itself — so a label
  // can never promise a note the engine will not play.
  function degLabel(L, i) {
    try {
      const notes = V2.withEdit(() => V2.notesFor(
        Object.assign({}, L, { part: Object.assign({}, L.part, { kind: 'live' }) }),
        { E: _engOf(), cfg: _cfgOf(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 2 }));
      const st = Math.max(1, (L.part.rhythm.steps | 0));
      const n = notes.find(x => Math.round((x.at / 2) * st) === i);
      if (n && typeof _ambFreqLabel === 'function') return _ambFreqLabel(n.freq);
    } catch (e) {}
    return String(((L.part.pitch.steps || [])[i] | 0) || 1);
  }

  function cellsHtml(L) {
    const r = L.part.rhythm || {}, st = Math.max(1, r.steps | 0), cells = viewCells(L);
    let h = '<div class="ambient-slice-grid ambient-euclid-cells v2-cells" style="--eucols:' + Math.min(st, 16) + '">';
    for (let i = 0; i < st; i++) {
      h += '<button type="button" class="ambient-slice-cell ambient-euclid-cell v2-cell' +
        (cells[i] ? ' on' : '') + '" data-ci="' + i + '" aria-pressed="' + (cells[i] ? 'true' : 'false') +
        '" title="Step ' + (i + 1) + ' of ' + st + '">' + (i + 1) + '</button>';
    }
    return h + '</div>';
  }
  const PITCH_OPTS = [['drawn', 'Drawn — a note per step'], ['chord', 'Chord — the harmony'], ['stack', 'Stack — from a note'],
                      ['fixed', 'One note — the same degree every time'], ['series', 'Series — sweep the chord'],
                      ['anchor', 'Anchor — a pedal point'], ['walk', 'Walk — a line'],
                      ['chance', 'Chance — any tone'],
                      ['mixed', 'Mixed — chords and single notes']];

  // v1's FULL voice list — every built-in, every SAMPLE, every ensemble and every
  // Design patch. `_ambToneOptions()` returns an ARRAY of `{value,label}`, and
  // the first cut tested `typeof opts === 'string'` before using it — so the
  // check never passed and it fell silently through to the eight-item fallback
  // below. A v2 layer could therefore only ever be a basic waveform: measured 8
  // options against v1's 283, with no sample among them. (The extra argument it
  // also passed was harmless — JS ignores it — so the ARRAY-AS-STRING test is
  // the whole bug, and the poison that proves this check has teeth.) That was
  // the entire "sample instrument": it needed a picker, not an engine.
  function toneOptions(cur) {
    try {
      if (typeof _ambToneOptions === 'function') {
        const list = _ambToneOptions();
        if (Array.isArray(list) && list.length) {
          return list.map(o => '<option value="' + esc(o.value) + '"' +
            (cur === o.value ? ' selected' : '') + '>' + esc(o.label || o.value) + '</option>').join('');
        }
      }
    } catch (e) {}
    return ['', 'sine', 'triangle', 'square', 'sawtooth', 'fm', 'am', 'pad']
      .map(t => '<option value="' + t + '"' + (cur === t ? ' selected' : '') + '>' + (t || 'Default') + '</option>').join('');
  }
  // Build with V1's OWN builders and tag the resulting input — imitating their
  // markup shipped a visibly broken card (a stepper stacked vertically because
  // `.ambient-ctrl-step` was missing, sliders with no `.ambient-sl-v` readout).
  // The class names were right; the STRUCTURE they need was not. Reuse the
  // function, and v2 follows v1's chrome forever with no second copy to drift.
  const tag = (html, cls, field, when) => {
    let h = html.replace('class="' + cls + '"', 'class="' + cls + ' v2-f" data-f="' + field + '"');
    if (when) h = h.replace('<div class="ambient-ctrl', '<div data-v2when="' + when + '" class="ambient-ctrl');
    return h;
  };
  const uid = (L, field) => 'v2-' + L.id + '-' + field.replace(/\./g, '-');
  // ── WHAT THE NUMBER IS A PERCENTAGE OF ──────────────────────────────────
  // `_ambSlReadout` renders `90%` and `_ambSl` folds the hint ("% of the onset
  // span") into a TITLE, which a phone never shows — so the one control that
  // decides whether a note reaches the next grid line read as a bare 90 beside
  // a picture of notes stopping just short of every line. Reported as "a note
  // 1 bar long should fit the bar": the note was 90% of its slot and the
  // drawing was honest, and nothing on the card said what the 90 was OF.
  // Documented rule, in the one place it most matters — 100 is exactly the
  // value whose meaning is a RELATIONSHIP rather than a quantity.
  const V2_READOUT = {
    'part.shape.lenRatio': (v) => {
      const n = Math.round(Number(v) || 0);
      return n === 100 ? 'fills the slot' : (n + '% of the slot');
    },
  };
  const v2Read = (field, v) => {
    const f = V2_READOUT[field];
    if (!f) return null;
    try { return f(v); } catch (e) { return null; }
  };
  // Swap the readout span's text in the markup v1's builder just produced. The
  // text it wrote is deterministic (`val + _ambSlUnit(id)`), so the substring
  // is exact — no regex over an id.
  const reRead = (h, id, field, v) => {
    const rd = v2Read(field, v);
    if (rd == null || typeof _ambSlReadout !== 'function') return h;
    const was = 'id="' + id + '-v">' + _ambSlReadout(id, v) + '</span>';
    return (h.indexOf(was) >= 0) ? h.replace(was, 'id="' + id + '-v">' + esc(rd) + '</span>') : h;
  };
  const sl = (L, field, label, v, min, max, hint, when) => {
    if (typeof _ambSl !== 'function') return '';
    let h = tag(_ambSl(label, uid(L, field), min, max, v, hint), 'ambient-sl', field, when);
    h = reRead(h, uid(L, field), field, v);
    // The unit line rides on the ROW so the knob (which replaces the slider in
    // the sheet) can say what its number means — _ambSl folds `hint` into a
    // title attribute, which a knob face cannot show.
    if (hint) h = h.replace('<div ', '<div data-v2u="' + esc(String(hint)) + '" ');
    return h;
  };
  // THE SAME ROW, FOR THE GENERATED POPOVER. A second control over one field
  // needs its own element id — `uid(L, field)` is shared, and two nodes with
  // one id breaks the label's `for` and every id-based lookup. The COMMIT
  // mirrors the value into the other copy, so the two can never drift (the
  // rule Level already follows with the mixer fader).
  const gsl = (L, field, label, v, min, max, hint, when, sfx) => {
    if (typeof _ambSl !== 'function') return '';
    const id = uid(L, field) + '-gen' + (sfx || '');
    let h = tag(_ambSl(label, id, min, max, v, hint), 'ambient-sl', field, when);
    h = reRead(h, id, field, v);
    if (hint) h = h.replace('<div ', '<div data-v2u="' + esc(String(hint)) + '" ');
    return h;
  };
  // …AND THE STEPPER FORM, for the panel's DISCRETE knobs (Grid, Push, Notes
  // at once, Range, Lines, Octaves). A 1..9 value on a full-width slider is a
  // thumb where most pixels mean nothing, and the Grid slider was WORSE than
  // clumsy: its commit re-renders the card (the lane grid is built from
  // `steps`), which replaced the slider under the finger on the FIRST input
  // event — the drag died at whatever value that event carried and the rest
  // of the gesture wrote nothing ("changing Grid does nothing"). A stepper is
  // one commit per press, which a rebuild cannot interrupt — the same call
  // the Pattern tab already made for these exact fields.
  const gst = (L, field, label, v, min, max, hint, when, sfx) =>
    (typeof _ambStep === 'function')
      ? tag(_ambStep(label, uid(L, field) + '-gen' + (sfx || ''), min, max, v, hint), 'ambient-step-inp', field, when)
      : '';
  // …AND THE SELECT FORM, for the panel's two AXES. Same rule as `gsl`: a
  // second control over one field needs its own element id, or the label's
  // `for` and every id-based lookup break. The hint is stated here rather than
  // left empty (the sheet's `sel` writes a blank one) because these two rows
  // ARE the model — they replaced the static paragraph that used to say it.
  const gsel = (L, field, label, cur, opts, hint, when) => {
    const id = uid(L, field) + '-gen';
    return '<div class="ambient-ctrl"' + (when ? ' data-v2when="' + when + '"' : '') +
      '><label for="' + id + '">' + esc(label) + '</label>' +
      '<select id="' + id + '" class="ambient-select v2-f" data-f="' + field + '">' +
      opts.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
      '</select><span class="ambient-hint">' + esc(hint || '') + '</span></div>';
  };
  const st = (L, field, label, v, min, max, hint, when) =>
    (typeof _ambStep === 'function')
      ? tag(_ambStep(label, uid(L, field), min, max, v, hint), 'ambient-step-inp', field, when)
      : '';
  // Generic on/off over any field path. A BUTTON, never a select — a select
  // writes a STRING and '0' is truthy (the documented trance-gate trap), so an
  // "Off" pick would switch the thing ON.
  const ftog = (L, field, label, onTxt, offTxt, hint, when) => {
    const v = !!getPath(L, field);
    return '<div class="ambient-ctrl"' + (when ? ' data-v2when="' + when + '"' : '') + '><label>' + esc(label) + '</label>' +
      '<button type="button" class="ambient-seg v2-ftog' + (v ? ' on' : '') + '" data-f="' + field + '"' +
        ' data-on="' + esc(onTxt) + '" data-off="' + esc(offTxt) + '">' + esc(v ? onTxt : offTxt) + '</button>' +
      '<span class="ambient-hint">' + esc(hint || '') + '</span></div>';
  };
  // Per-FX Dry kill — v1's contract: forces the stage fully wet and ENGAGES it
  // even at mix 0 (that is the point of it), which is why `applyGate` counts it.
  const fdk = (L, fxk, when) =>
    ftog(L, fxk + '.dryKill', 'Dry kill', 'On — wet only', 'Off', 'remove this stage\u2019s dry signal', when);
  const sel = (L, field, label, cur, opts, when) =>
    '<div class="ambient-ctrl"' + (when ? ' data-v2when="' + when + '"' : '') + '><label for="' + uid(L, field) + '">' + esc(label) + '</label>' +
    '<select id="' + uid(L, field) + '" class="ambient-select v2-f" data-f="' + field + '">' +
    opts.map(o => '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select><span class="ambient-hint"></span></div>';

  // Kits from the sample bank, read from METADATA only — touching `.sampler`
  // would build every one of them (the documented `__sampleStats` trap).
  function kitOptions(cur) {
    const out = [['synth', 'Synth kit — generated']];
    try {
      if (typeof sampleSamplers !== 'undefined' && sampleSamplers && sampleSamplers.forEach) {
        sampleSamplers.forEach((meta, id) => { if (meta && meta.drumKit) out.push([id, meta.name || id]); });
      }
    } catch (e) {}
    // A saved kit the bank no longer lists must still show, or the select
    // renders blank and the layer looks broken (the documented select trap).
    if (cur && !out.some((o) => o[0] === cur)) out.push([cur, cur]);
    return out;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // The card half has no engine in scope when it builds html; the render sets
  // this so the note row can resolve what a degree SOUNDS as.
  let _cardE = null;
  const _engOf = () => _cardE;
  const _cfgOf = () => { try { return _cardE && _cardE.getCfg(); } catch (e) { return null; } };
  // v1's voice list, asked with a SHIM: it reads `L.voice` meaning the TTS voice,
  // and a v2 layer's `voice` is the instrument enum.
  function speechVoiceOpts(cur) {
    try {
      if (typeof _ambVoiceChoices === 'function') {
        const l = _ambVoiceChoices({ voice: cur });
        if (Array.isArray(l) && l.length) return l.map(x => [x[0], x[1] || x[0]]);
      }
    } catch (e) {}
    return [['', 'Default voice']];
  }
  const wetOn = (L) => !!(L.wetOnly);
  // Mirrored from v1's own list (id + label; the third entry is its description)
  // so the two can never offer different modes.
  const GLITCH_OPTS = (typeof _AMB_GLITCH_MODES !== 'undefined' && Array.isArray(_AMB_GLITCH_MODES))
    ? _AMB_GLITCH_MODES.map(m => [m[0], m[1]])
    : [['grain', 'Grain'], ['repeat', 'Repeat'], ['tapestop', 'Tape stop'], ['reverse', 'Reverse']];
  const coreStrips = () => { try { return !!(typeof _coreVoices !== 'undefined' && _coreVoices.stripsEnabled()); } catch (e) { return false; } };
  // Mirrored from v1's own lists so the two can never offer different options.
  // `_AMB_DELAY_SYNCS` / `_AMB_DIST_FLAVORS` are IIFE-scoped consts in 17 and
  // NOT reachable by bare name here — hence the literal fallbacks.
  const DELAY_SYNCS = ['1/4', '1/4T', '1/8.', '1/8', '1/8T', '1/16.', '1/16', '1/16T'];
  const DIST_OPTS = [['', 'Classic'], ['overdrive', 'Overdrive'], ['fuzz', 'Fuzz'],
                     ['fold', 'Wavefold'], ['crush', 'Crush']];
  const PECHO_SYNCS = [['', 'free (ms)'], ['1/4', '1/4'], ['1/8', '1/8'], ['1/8T', '1/8T'],
                       ['1/16', '1/16'], ['1/16T', '1/16T']];
  const spatOn = (L) => !!(L.spat && L.spat.on);
  // Mirrored from v1's own list so the two can never offer different modes.
  const SPAT_OPTS = (typeof _AMB_SPAT_MODES !== 'undefined' && Array.isArray(_AMB_SPAT_MODES))
    ? _AMB_SPAT_MODES.map(m => [m[0], m[1]])
    : [['fan', 'Fan out'], ['alt', 'Alternate'], ['sine', 'Sine'], ['sweep', 'Sweep'], ['random', 'Random']];
  const tgOn = (L) => !!(L.tg && L.tg.on);
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const fx = (L, k) => (L && L[k] && typeof L[k] === 'object') ? L[k] : {};

  // ── GROUPS ──────────────────────────────────────────────────────────────
  // The card grew to 45 rows in one 4-group wall (measured 2873px on a 780px
  // viewport, with an 18-row "Mix & FX" mixing routing, filtering, time FX,
  // gating and movement). The spec warned about exactly this — treatments were
  // kept OUT of the part assembly "which is what keeps the card from becoming
  // the wall of pickers that killed bloom-composable-layers.md" — and it became
  // one anyway, by accretion. The groups now follow the MODEL's own story:
  // instrument → part → rhythm → pitch, then the treatments. `def` marks a
  // group open when the card is expanded; the rest fold to one line each and
  // carry a summary of what is engaged, so a fold never hides live state.
  // EVERY GROUP STARTS CLOSED. Expanding a card shows its group HEADS and
  // nothing else — each carrying a summary of what is engaged inside it — so
  // the card opens as a contents page and you unfold exactly what you came
  // for. (`def` is kept in the signature because it still records which groups
  // are the musical core, but it no longer opens them.)
  // THE TWELVE GROUPS, in pipeline order. The card body is a GRID OF BUTTONS
  // built from this list; the groups themselves render as hidden storage and a
  // button opens that group's rows in a bottom SHEET (popOpen). The gate audits
  // this list against the rendered groups in BOTH directions — a group with no
  // button is unreachable, a button with no group opens nothing (the Overview
  // popover-family precedent, §5i).
  // "Content", not "Part" — "Part" already means the ARRANGEMENT's parts
  // (Verse/Chorus: the ⇶ Parts view, the part tabs, and the ⟲ N × part badge
  // on this very card), and one word for two mechanisms is how a control gets
  // misread. The DATA keys stay `part.*` for save-compat (the naming rule).
  const GRPS = ['Instrument', 'Content', 'Pitch', 'Shape', 'Mix', 'FX'];
  // TAB CLUSTER — rows sharing a `data-v2tab` become ONE tab in the sheet.
  // Used only where a "parameter" is genuinely plural (an FX stage and its own
  // params, the speech source, the Notes door) or where bare labels collide.
  // Tags every <div in the fragment; only top-level pane children are ever
  // consulted, so the nested ones are inert.
  const tb = (name, html) => html.split('<div ').join('<div data-v2tab="' + name + '" ');
  // A MICRO STEPPER — label over a compact − value + , for a row of several.
  // Deliberately the sheet head's Register markup: the document-level ±
  // delegation drives it and the card's `.v2-f` handler commits it, so there
  // is no new wiring and no second copy of either rule.
  const mini = (L, path, lab, val, lo, hi, nudge, when) =>
    '<span class="v2-mini"' + (when ? ' data-v2when="' + when + '"' : '') + '>' +
      '<span class="v2-mini-lab">' + esc(lab) + '</span>' +
      '<span class="ambient-stepper">' +
        '<button type="button" class="ambient-step-btn ambient-step-dn" tabindex="-1" aria-label="Less">\u2212</button>' +
        '<input type="number" inputmode="numeric" class="ambient-step-inp v2-f" data-f="' + path + '"' +
          ' min="' + lo + '" max="' + hi + '" step="1"' + ((nudge | 0) > 1 ? ' data-nudge="' + (nudge | 0) + '"' : '') +
          ' value="' + (val | 0) + '" aria-label="' + esc(lab) + '">' +
        '<button type="button" class="ambient-step-btn ambient-step-up" tabindex="-1" aria-label="More">+</button>' +
      '</span></span>';
  // A SUBSECTION INSIDE A TAB. `sub()` tags every row it wraps so the card's
  // `v2-so-<id>` class reveals them; `disc()` is the row that does the
  // revealing. Rows stay FLAT children of the group body — a wrapper div would
  // fall out of `popTabbables` (not an `.ambient-ctrl`) and then show under
  // EVERY tab, which is what keeps the drawing visible and would be exactly
  // wrong here.
  const subrows = (id, html) => html.split('class="ambient-ctrl').join('class="ambient-ctrl v2-sub v2-sub-' + id);
  const disc = (id, label, hint, when) =>
    '<div class="ambient-ctrl v2-disc"' + (when ? ' data-v2when="' + when + '"' : '') + '>' +
      '<label>' + esc(label) + '</label>' +
      '<button type="button" class="ambient-seg v2-discbtn" data-disc="' + id + '">\u25b8 Show</button>' +
      '<span class="ambient-hint">' + esc(hint) + '</span></div>';
  const grpOpen = (title, def, body) =>
    '<div class="ambient-grp" data-v2grp="' + esc(title) + '"' +
      (def ? ' data-v2def="1"' : '') + '>' +
      '<div class="ambient-grp-head">' + esc(title) +
        '<span class="ambient-hint v2-grpsum" data-grp="' + esc(title) + '"></span></div>' +
      '<div class="ambient-grp-body">' + body + '</div></div>';

  function cardHtml(L) {
    const i = L.instrument, p = L.part, r = p.rhythm || {}, t = p.pitch || {}, sh = p.shape || {};
    // HEAD = v1's shape exactly: the name lives inside the on/off toggle, a
    // readout span sits beside it, per-layer actions live behind ⋯, and the
    // collapse control is `.ambient-collapse` (there is no `.ambient-caret` in
    // the stylesheet at all — using it rendered an unstyled sliver).
    return '<div class="ambient-layer v2-layer collapsed" data-v2id="' + L.id + '">' +
      '<div class="ambient-layer-head">' +
        '<button type="button" class="ambient-toggle v2-on' + (L.on ? ' on' : '') + '" title="Play / silence this layer">' +
          '<span class="ambient-layer-name">' + esc(L.name) + '</span></button>' +
        // `data-phkey` is how `_ambSyncLevelUI` locates the card to mirror the
        // Level value into — Level has TWO controls (this card's slider and the
        // mixer fader) over ONE field, and without this the two drift apart
        // (measured: mixer moved to 42, card still read 65). Deliberately NOT
        // `.ambient-ph`, so the playhead sweep does not pick it up.
        '<span class="ambient-layer-unit v2-summary" data-phkey="v2:' + L.id + '" title="What this layer is"></span>' +
        '<button type="button" class="ambient-layer-menu-btn v2-menu" title="Layer menu — rename, remove" aria-label="Layer menu">\u22ef</button>' +
        '<button type="button" class="ambient-collapse v2-caret" title="Collapse / expand layer" aria-label="Collapse or expand this layer"></button>' +
      '</div>' +
      '<div class="ambient-layer-body">' +
        // THE GROUP GRID — the card's whole body at rest. Each button names a
        // group, carries its live summary (applyGate writes every `.v2-grpsum`
        // in the card, buttons included), and opens that group's rows in a
        // bottom sheet. The groups below it are the STORAGE those sheets
        // borrow rows from — hidden by `.v2-layer .ambient-grp { display:none }`.
        // ── FIND A CONTROL ────────────────────────────────────────────
        // 132 controls across six sheets and ~50 tabs. Each lives with the
        // thing it modifies, which is the right filing and a poor index: the
        // variance controls alone are spread over Content ▸ Feel, Content ▸
        // Pattern, Shape ▸ Variance and Pitch ▸ Voicing, and "where are all
        // the variance controls" was asked twice. This NAVIGATES — it never
        // renders a second copy of a control, because two surfaces for one
        // field is the duplication this file keeps paying for. 16px or iOS
        // zooms the page on focus and never zooms back.
        '<div class="v2-find">' +
          '<input type="search" class="v2-findin" placeholder="\ud83d\udd0d Find a control\u2026" ' +
            'aria-label="Find a control" autocomplete="off" autocorrect="off" spellcheck="false">' +
          '<div class="v2-findres"></div>' +
        '</div>' +
            // ── THE GENERATED POPOVER ────────────────────────────────────
        // INSIDE THE CARD, never body-attached: every control in here is
        // an ordinary `.v2-f` row, and the whole delegation resolves its
        // layer with `closest('.v2-layer')` — the same reason the section
        // sheet is a child of the card. Body-attached, not one knob would
        // have committed.
        // Always in the DOM and revealed by a class, so `applyGate` sweeps
        // its `data-v2when` rows like any other and a commit does not have
        // to rebuild anything.
        // Groundwork's separate panel was FOLDED IN here (2026-09-09) — it is
        // the fifth shape, and its knobs are ordinary gated rows below.
        // ── ONE BAR'S OWN RULES ──────────────────────────────────────
        // 🎲 Re-roll bar N opens THIS, not a throw of the dice: "it should
        // open a popover showing the current generated settings, and user
        // should be able to edit and apply to just that bar". Rolling again is
        // one button inside it, so the dice is still one press away — what the
        // press buys is the chance to change WHAT is being rolled first.
        // Rows are built in JS (`barpopSync`) rather than written out here
        // because the visible set follows the bar's OWN rhythm/pitch kinds,
        // which are the very things this panel edits.
        '<div class="v2-barwrap">' +
          '<div class="v2-barscrim"></div>' +
          // ITS OWN CLASS NAMES, NOT the Generated panel's. It is visually that
          // panel and the stylesheet says so by NAMING both — but a shared
          // class means `querySelector` finds whichever comes first in the
          // DOM, and this block sits ABOVE the Generated one: sharing
          // `.v2-genclose` made the gate's own "the shape panel closed"
          // press land on THIS button instead (the documented duplicate-class
          // trap, on the surface whose comment warns about it).
          '<div class="v2-barpop" role="dialog" aria-label="Rules for this stretch">' +
            '<div class="v2-barhead"><span class="v2-bartitle">Bar</span>' +
              '<button type="button" class="v2-barclose" aria-label="Close">\u2715</button></div>' +
            '<span class="ambient-hint v2-barsays"></span>' +
            '<div class="v2-barrows"></div>' +
            '<div class="v2-baracts">' +
              '<button type="button" class="ambient-seg v2-barroll" title="Throw the dice again here — the same rules, a different roll. Press as often as you like.">\ud83c\udfb2 Roll again</button>' +
              '<button type="button" class="ambient-seg v2-barreset" title="Drop these settings — this stretch generates by the part\u2019s rules again.">\u21ba Part\u2019s rules</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="v2-genwrap">' +
          '<div class="v2-genscrim"></div>' +
          '<div class="v2-genpop v2-shapepop" role="dialog" aria-label="Generated shape">' +
            '<div class="v2-genhead"><span class="v2-gentitle">Generated</span>' +
              '<button type="button" class="v2-genclose" aria-label="Close">\u2715</button></div>' +
            // THE MODEL USED TO BE A PARAGRAPH HERE and is two CONTROLS now
            // (Rhythm and Pitch, the first two rows below). It was 44px of a
            // 617px panel, static — so after one read it is noise on every
            // later visit, forever — and the file's own rule is that the
            // control for a fact beats a sentence about it. `.v2-gensays`
            // below still says, live, what THIS shape produces.
            '<span class="ambient-seg-row v2-genshapes">' +
              '<button type="button" class="ambient-seg v2-mkpart" data-mk="sustain" title="A held note or chord, one per cycle — the pad shape.">\u25ac Sustained<span class="v2-matsub">one held chord</span></button>' +
              '<button type="button" class="ambient-seg v2-mkpart" data-mk="arp" title="Sweep the chord one tone per onset — an arpeggio.">\u27f3 Arpeggio<span class="v2-matsub">the chord, one note at a time</span></button>' +
              '<button type="button" class="ambient-seg v2-rollrun" title="A rolled, syncopated line. 🎲 New take rolls another.">\ud83c\udfb2 Roll<span class="v2-matsub">a run of single notes</span></button>' +
              '<button type="button" class="ambient-seg v2-mkpart" data-mk="mixed" title="Some onsets a chord, the rest a single note.">\u2687 Mixed<span class="v2-matsub">chords and single notes</span></button>' +
              '<button type="button" class="ambient-seg v2-mkpart" data-mk="ground" title="Play the changes — notes on the 1 and on every change, holding until the next.">\u26f0 Groundwork<span class="v2-matsub">play the changes</span></button>' +
            '</span>' +
            '<span class="ambient-hint v2-gensays"></span>' +
            // THE KNOBS THAT DECIDE WHAT THE SHAPE PRODUCES, gated to the
            // shape that reads each one — so the panel shows the handful
            // that apply rather than a wall that mostly does not.
            '<div class="v2-genrows">' +
              // ── THE TWO AXES, DIRECTLY ──────────────────────────────────
              // The panel stated its own model in prose ("a RHYTHM \u00d7 a PITCH
              // RULE") and then let you touch NEITHER: five preset shapes were
              // the whole door, and the two selects that actually name the
              // axes sat three tabs away in Content and Pitch. With both here
              // the panel offers every combination rather than five of them,
              // and the chips above become named SHORTCUTS that light by
              // inference (`matProv`/`matGuess` already read the rules a part
              // HAS) \u2014 a hand-built pair lights none of them and `.v2-gensays`
              // describes it, exactly as the Material row already behaves.
              // `rhythmShown` because 'drawn' is internal state and has no
              // option: a select whose value matches nothing renders BLANK,
              // which is the drift bug that turned Groundwork into one
              // sustained chord. applyGate re-syncs BOTH copies every pass.
              gsel(L, 'part.rhythm.kind', 'Rhythm', rhythmShown(r.kind), RHYTHM_OPTS,
                   'when notes happen', 'kind:live;voice:synth') +
              gsel(L, 'part.pitch.kind', 'Pitch', t.kind, PITCH_OPTS,
                   'what each onset plays', 'kind:live;voice:synth') +
              // RANGES ARE BOUND TO THE CURRENT GRID, never the theoretical
              // ceiling: normalize clamps pulses to `steps` and the pattern
              // indexes rotate mod `steps`, so a 1..32 pulses slider under an
              // 8-step grid had 24 values that silently did NOTHING (measured
              // \u2014 every write past 8 read back 8). A Grid press re-renders the
              // card, which rebuilds these rows with the new bounds.
              (function (rr0) {
                const gN = Math.min(32, Math.max(2, (rr0.steps | 0) || 16));
                return gsl(L, 'part.rhythm.pulses', 'How many', rr0.pulses, 1, gN,
                    'onsets in the cycle \u2014 up to the Grid', 'kind:live;rhythm:euclid,drawn') +
                  // "Steps", NOT "Grid": `part.grid` is a note VALUE per BAR
                  // and is the one thing called Grid now — two controls over
                  // two different quantities sharing one name is the naming
                  // rule's own mistake (this is per CYCLE). Gated `form:roll`
                  // because in ▦ Steps it is derived from Grid × Bars.
                  gst(L, 'part.rhythm.steps', 'Steps', rr0.steps, 2, 64,
                      'how many steps the cycle is cut into', 'kind:live;rhythm:euclid,drawn;form:roll') +
                  gst(L, 'part.rhythm.rotate', 'Push', rr0.rotate, 0, gN - 1,
                      'shift the pattern along, in steps \u2014 0 starts on the beat', 'kind:live;rhythm:euclid,drawn') +
                  gsl(L, 'part.rhythm.n', 'How many', rr0.n, 1, 32,
                      'onsets in the cycle', 'kind:live;rhythm:pulse') +
                  gsl(L, 'part.rhythm.chance', 'Chance', rr0.chance, 0, 100,
                      'how often a step sounds', 'kind:live;rhythm:chance');
              })(L.part.rhythm || {}) +
              // SYNCOPATE is read ONLY by the chance walk (it weights the odd
              // slots), so it is gated exactly as its sheet copy is \u2014 offering
              // it on a euclid part would be a knob that does nothing.
              gsl(L, 'part.rhythm.syncop', 'Syncopate', num((L.part.rhythm || {}).syncop, 0), 0, 100,
                  'straight \u2192 offbeat', 'kind:live;voice:synth;rhythm:chance') +
              gst(L, 'part.pitch.voices', 'Notes at once', (L.part.pitch || {}).voices, 1, 9,
                  'how many notes each chord holds', 'kind:live;voice:synth;pitch:chord,stack,mixed') +
              gsl(L, 'part.pitch.mix', 'Chords vs notes',
                  (Number.isFinite((L.part.pitch || {}).mix) ? L.part.pitch.mix : 50), 0, 100,
                  'all single notes \u2192 all chords', 'kind:live;voice:synth;pitch:mixed') +
              gst(L, 'part.pitch.span', 'Range', (L.part.pitch || {}).span, 1, 12,
                  'how far the line wanders, in source tones', 'kind:live;voice:synth;pitch:walk,mixed') +
              gsl(L, 'part.pitch.contour', 'Contour', num((L.part.pitch || {}).contour, 0), -100, 100,
                  'fall \u2192 rise', 'kind:live;voice:synth;pitch:walk') +
              gst(L, 'part.pitch.lines', 'Lines', ((L.part.pitch || {}).lines | 0) || 1, 1, 6,
                  'how many independent melodies at once', 'kind:live;voice:synth;pitch:walk,chance') +
              gsl(L, 'part.pitch.stutter', 'Repeat', (L.part.pitch || {}).stutter, 0, 100,
                  'how often it repeats a note', 'kind:live;voice:synth;pitch:walk') +
              // DIRECTION \u2014 the arpeggio's most obvious parameter, and the
              // panel offered \u27f3 Arpeggio as one of its five shapes while
              // leaving it three tabs away in Pitch.
              gsel(L, 'part.pitch.dir', 'Direction', (L.part.pitch || {}).dir || 'up',
                   [['up', 'Up'], ['down', 'Down'], ['updown', 'Up & down']],
                   'which way the sweep runs', 'kind:live;voice:synth;pitch:series') +
              gst(L, 'part.pitch.octaves', 'Octaves', (L.part.pitch || {}).octaves, 1, 4,
                  'how many octaves the sweep climbs', 'kind:live;voice:synth;pitch:series') +
              gsl(L, 'part.pitch.randomness', 'Scatter', num((L.part.pitch || {}).randomness, 0), 0, 100,
                  'ordered \u2192 jumps about', 'kind:live;voice:synth;pitch:series') +
              // HARMONY \u2014 a SET, not a choice (a line can carry a 3rd and a
              // 6th at once), and the biggest expressive axis per pixel the
              // panel was missing. Its buttons are class-delegated with no id,
              // so a second copy on the card is safe, and its handler
              // re-renders \u2014 both copies are rebuilt from state.
              ((typeof harmRowHtml === 'function') ? harmRowHtml(L, L.part.pitch || {}) : '') +
              gsl(L, 'part.shape.lenRatio', 'Note length', (L.part.shape || {}).lenRatio, 5, 100,
                  '% of the space each note fills', 'kind:live;rhythm:pulse,euclid,drawn,chance') +
              // GROUNDWORK'S OWN KNOBS (its former panel folded in here,
              // 2026-09-09). "Notes at once" already serves it \u2014 ground's
              // pitch kind is chord \u2014 so only Slip, Hold (which ranges to
              // 200: past 100 the note rings INTO the next change) and the
              // per-change grid are its own. Hold carries a distinct id
              // suffix: it shares `part.shape.lenRatio` with Note length
              // above, and two nodes with one id break every id lookup.
              gsl(L, 'part.shape.slip', 'Slip', ((L.part.shape || {}).slip | 0), 0, 100,
                  'nudge each note late by a random hair \u2014 a strum', 'kind:live;rhythm:ground') +
              gsl(L, 'part.shape.lenRatio', 'Hold', (L.part.shape || {}).lenRatio, 5, 200,
                  '% of the change each note fills', 'kind:live;rhythm:ground', '-gw') +
              '<div class="ambient-ctrl v2-gwper" data-v2when="kind:live;rhythm:ground"><label>Per change</label>' +
                '<span class="v2-gwpergrid"></span>' +
                '<span class="ambient-hint">0 sits a change out \u00b7 purple = set by hand, the rest follow Notes at once</span></div>' +
              // ── HOW A CHORD IS LAID OUT ─────────────────────────────────
              // v1's rich voicer, and the panel said nothing about it \u2014 which
              // for \u25ac Sustained and \u26f0 Groundwork (both chord parts) is most
              // of what decides how they sound.
              gsel(L, 'part.pitch.chordMode', 'Voicing', (L.part.pitch || {}).chordMode || '',
                   [['', 'Simple \u2014 stack the tones'], ['chaos', 'Chaos'], ['chords', 'Chords'],
                    ['chordsplus', 'Chords+'], ['monk', 'Monk']],
                   'how the tones are arranged', 'kind:live;voice:synth;pitch:chord') +
              gst(L, 'part.pitch.spread', 'Spread', num((L.part.pitch || {}).spread, 0), 0, 3,
                  '\u00b1 octaves', 'kind:live;voice:synth;pitch:chord') +
              gsl(L, 'part.pitch.variety', 'Variety', num((L.part.pitch || {}).variety, 0), 0, 100,
                  'plain \u2192 colourful', 'kind:live;voice:synth;pitch:chord') +
              // ── \u25b8 MORE ────────────────────────────────────────────────
              // The second tier: real controls that shape the generator and
              // are not what you reach for first. A fold rather than a tab,
              // and a CLASS on the card rather than inline display \u2014 inline
              // display belongs to `applyGate`, which writes '' to SHOW a row,
              // so `.v2-sub`'s `display: none` still wins while the fold is
              // shut and a gated-out row stays hidden when it is open. Gated
              // `kind:live` so a written part shows no header over nothing.
              disc('gmore', 'More', 'variance, voicing detail and ceilings', 'kind:live') +
              subrows('gmore',
                gsl(L, 'part.rhythm.vary', 'Vary', num((L.part.rhythm || {}).vary, 0), 0, 100,
                    'how much the pattern re-rolls each cycle', 'kind:live;rhythm:euclid,drawn') +
                gsl(L, 'part.rhythm.rateVar', 'Rate var', num((L.part.rhythm || {}).rateVar, 0), 0, 100,
                    'steady \u2192 rushes \u2014 replays per take', 'kind:live;voice:synth') +
                gst(L, 'part.rhythm.voices', 'Rows', num((L.part.rhythm || {}).voices, 1), 1, 8,
                    'euclid rows at once \u2014 a polyrhythm', 'kind:live;voice:synth;rhythm:euclid') +
                gst(L, 'part.pitch.degree', 'Note', (L.part.pitch || {}).degree, 1, 12,
                    'which source tone it starts on',
                    'kind:live;voice:synth;pitch:fixed,stack,walk,series') +
                gsl(L, 'part.pitch.roam', 'Roam', num((L.part.pitch || {}).roam, 0), 0, 100,
                    'how often that Note wanders', 'kind:live;voice:synth;pitch:fixed,stack') +
                gsel(L, 'part.pitch.home', 'Home', (L.part.pitch || {}).home || 'floor',
                     [['floor', 'Floor \u2014 walk up from Register'],
                      ['center', 'Centre \u2014 Register in the middle'],
                      ['ceiling', 'Ceiling \u2014 walk down from Register']],
                     'where Register sits in the range', 'kind:live;voice:synth;pitch:walk') +
                gsl(L, 'part.pitch.drift', 'Pitch vary', num((L.part.pitch || {}).drift, 0), 0, 100,
                    'octave drift \u2014 replays per take',
                    'kind:live;voice:synth;pitch:fixed,series,walk,chance') +
                gst(L, 'part.pitch.subdiv', 'Subdivide', num((L.part.pitch || {}).subdiv, 1), 1, 16,
                    'voicings per chord', 'kind:live;voice:synth;pitch:chord') +
                gst(L, 'part.pitch.phraseLen', 'Phrase', num((L.part.pitch || {}).phraseLen, 4), 1, 16,
                    'chords before it repeats', 'kind:live;voice:synth;pitch:chord') +
                gst(L, 'part.pitch.repeats', 'Repeats', num((L.part.pitch || {}).repeats, 4), 1, 16,
                    'times before a fresh phrase', 'kind:live;voice:synth;pitch:chord') +
                gsel(L, 'part.pitch.feel', 'Feel', (L.part.pitch || {}).feel || '',
                     [['', 'In order \u2014 walk the variants'], ['stochastic', 'Stochastic \u2014 pick per slot']],
                     'how it moves between voicings', 'kind:live;voice:synth;pitch:chord') +
                gst(L, 'part.pitch.voiceCap', 'Voice cap', num((L.part.pitch || {}).voiceCap, 0), 0, 12,
                    'ceiling incl. colour tones (0 = Notes at once)',
                    'kind:live;voice:synth;pitch:chord') +
                gst(L, 'part.shape.holdSteps', 'Hold steps', num((L.part.shape || {}).holdSteps, 0), 0, 16,
                    'steps a note is held (0 = use Note length)', 'kind:live') +
                gst(L, 'part.shape.maxEvents', 'Max events', num((L.part.shape || {}).maxEvents, 0), 0, 64,
                    'ceiling on notes per cycle (0 = off)', 'kind:live')) +
            '</div>' +
            '<div class="v2-genacts">' +
              // DISTINCT CLASSES. Reusing `.v2-newtake` put a SECOND element with
              // that class on the card, hidden inside the closed panel and
              // EARLIER in the DOM — so `querySelector` found the hidden one
              // and every probe aimed at the wrong node. The exact trap the
              // Material row's own comment warns about. The handler takes both.
              '<button type="button" class="ambient-seg v2-genroll" title="Roll this shape again — same rules, new notes.">\ud83c\udfb2 New take</button>' +
              '<button type="button" class="ambient-seg v2-genprev" title="Hear one cycle with these settings.">\u25b6 Preview</button>' +
              '<button type="button" class="ambient-seg v2-genclose">\u2713 Done</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // ── INSTRUMENT — what makes the sound ─────────────────────────────
        grpOpen('Instrument', true,
          // "Tone type", not "Voice" — it names the KIND of sound, and the row
          // below it is the sound itself, whose options this narrows. Called
          // "Voice" it read as a peer of "Tone" rather than its parent, and it
          // also collided with the TTS voice, which is a different thing again
          // (`instrument.speechVoice`).
          // "Live" — the voice it is playing right NOW, as against the Tone set
          // below, which schedules voices on the bar clock. The TYPE lives in
          // this tab too: it is the question above "which tone", not a peer of
          // it, and as its own tab it was a tab you had to visit to find out
          // what the next one would offer.
          tb('Live',
          sel(L, 'instrument.voice', 'Tone type', i.voice,
              [['synth', 'Synth — pitched'], ['kit', 'Drum kit — lanes'], ['speech', 'Speech — words']])) +
          // ONE "Tone" ROW, CONSTRAINED BY THE TYPE ABOVE IT. It used to be
          // three separate rows — Tone (synth), Kit (drums), Spoken by (speech)
          // — one per type, so the list WAS constrained and nothing said so:
          // in a tabbed sheet you saw a "Tone" tab that had nothing to do with
          // the kit you had chosen. One question, one control, options that
          // change. The FIELD still differs per type (`instrument.tone` /
          // `.kit` / `.speechVoice`) — `instrument.voice` forces a full
          // re-render, so the row is always built for the current type.
          // (The TTS voice is `instrument.speechVoice`, NOT `voice`: that one
          // is the instrument. `_ambVoiceChoices` reads `L.voice` meaning the
          // TTS one, so it gets a shim.)
          (function () {
            const t3 = (i.voice === 'kit')
              ? { f: 'instrument.kit', opts: kitOptions(i.kit), cur: i.kit, hint: 'which kit the lanes play' }
              : ((i.voice === 'speech')
                ? { f: 'instrument.speechVoice', opts: speechVoiceOpts(i.speechVoice || ''), cur: i.speechVoice || '', hint: 'who says the words' }
                : { f: 'instrument.tone', opts: null, cur: i.tone, hint: 'the voice it plays with' });
            const body = t3.opts
              ? t3.opts.map(o => '<option value="' + esc(o[0]) + '"' + (t3.cur === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('')
              : toneOptions(i.tone);
            return '<div data-v2tab="Live" class="ambient-ctrl"><label for="' + uid(L, t3.f) + '">Tone</label>' +
              '<select id="' + uid(L, t3.f) + '" class="ambient-select v2-f" data-f="' + t3.f + '">' + body + '</select>' +
              '<span class="ambient-hint">' + esc(t3.hint) + '</span></div>';
          })() +
          // WHERE THE WORDS COME FROM. The source list is v1's own
          // `_AMB_LEARN_SOURCES`, read by id, so the two can never offer
          // different sources; `paste` is the no-network case and is what the
          // Words box below has always been.
          tb('Words', sel(L, 'source', 'Words from', L.source || 'paste',
              ((typeof _AMB_LEARN_SOURCES !== 'undefined' && Array.isArray(_AMB_LEARN_SOURCES))
                ? _AMB_LEARN_SOURCES.map(x => [x.id, x.label])
                : [['paste', 'Pasted text']]), 'voice:speech') +
          '<div class="ambient-ctrl" data-v2when="voice:speech;src:net"><label>About</label>' +
            '<input type="text" class="ambient-select v2-term" placeholder="a subject, or leave blank" ' +
              'value="' + esc(L.term || '') + '">' +
            '<span class="ambient-hint">what to look for</span></div>' +
          sel(L, 'amount', 'How much', L.amount || 'long',
              ((typeof _AMB_AMOUNTS !== 'undefined' && Array.isArray(_AMB_AMOUNTS))
                ? _AMB_AMOUNTS.map(x => [x[0], x[1]])
                : [['long', 'A page']]), 'voice:speech;src:net') +
          st(L, 'lineWords', 'Line length', num(L.lineWords, 14), 4, 60, 'words per spoken line', 'voice:speech') +
          '<div class="ambient-ctrl" data-v2when="voice:speech;src:net"><label>Article</label>' +
            '<span class="ambient-seg-row">' +
              '<button type="button" class="ambient-seg v2-fetch">\u21bb Fetch</button>' +
            '</span><span class="ambient-hint v2-article">' + esc(L.article || 'nothing loaded yet') + '</span></div>' +
          '<div class="ambient-ctrl v2-textrow" data-v2when="voice:speech"><label>Words</label>' +
            '<textarea class="ambient-select v2-text" rows="3" ' +
              'placeholder="Type or paste what it should say — one sentence per line, roughly.">' +
              esc(i.text || '') + '</textarea>' +
            '<span class="ambient-hint v2-speechhint"></span></div>') +
          sel(L, 'voiceFrom', 'Voice from', L.voiceFrom || 'auto',
              [['auto', 'Auto — server if available'], ['device', 'This device'], ['server', 'The voice server']],
              'voice:speech') +
          sel(L, 'wordOut', 'Words as', L.wordOut || 'speak',
              [['speak', 'Speech — say them'], ['play', 'Notes — play the letters'], ['both', 'Both at once']],
              'voice:speech') +
          '<div data-v2tab="Words" class="ambient-ctrl" data-v2when="voice:speech"><label>Lines</label>' +
            '<span class="ambient-seg-row">' +
              '<button type="button" class="ambient-seg v2-speechwrite">✍ Write</button>' +
              '<button type="button" class="ambient-seg v2-speechgen">🎲 Make some up</button>' +
            '</span><span class="ambient-hint v2-speechcount"></span></div>' +
          // THE SYNTH-KIT EDITOR — role tabs, per-voice params, roll one drum,
          // hear it. v1's own `_ambSynthKitUi`, and its handlers resolve the
          // layer through `_ambCardKey` → `_ambLayerByKey`, both of which have
          // answered for a v2 card since slice 5 — so, like the Key override and
          // the tone cycle, it needs no wiring here. Its own markup carries
          // `display:none` (v1 reveals it from the Beat's gen visibility), so
          // that is stripped and the row is gated on the kit being the SYNTH
          // one instead.
          ((typeof _ambSynthKitUi === 'function')
            ? ('<div data-v2tab="Synth kit" class="ambient-ctrl v2-skrow" data-v2when="voice:kit;kit:synth">' +
                 _ambSynthKitUi(L).replace(' style="display:none"', '') + '</div>')
            : '') +
          // REGISTER IS IN THE SHEET HEADER — see `popOpen`. It is the one
          // control you reach for while listening to something else on the
          // card, so it sits where it is always to hand rather than behind a
          // tab. (A move is a delete plus an add: it is gone from here.)
          // SCHEDULED TONE — cycle the voice on the BAR clock (4 bars saw, then
          // 4 bars sine, repeat). v1's own builder, and its handler is delegated
          // on the panel host resolving the layer through `_ambCardKey`, which
          // falls back to `[data-phkey]` — a v2 card has carried that since
          // slice 5, so this works with no wiring here either.
          ((typeof _ambToneSeqBoxHtml === 'function')
            ? ('<div class="ambient-ctrl ambient-toneseq-ctrl" data-v2when="voice:synth"><label>Tone set</label>' +
                 '<div class="ambient-toneseq-box">' + _ambToneSeqBoxHtml(L) + '</div>' +
                 '<span class="ambient-hint">bar-clocked voice changes</span></div>')
            : '') +
          // THE ENVELOPE IS PART OF THE INSTRUMENT — how the voice responds
          // is not a peer of the voice itself. It was 4 rows pretending to be
          // a top-level group beside FX's 47.
          // TWO SUBSECTIONS INSIDE LIVE, both folded. They were tabs of their
          // own, which put nine rows one press away from a sheet whose first
          // question is "which tone" — and the envelope is not a peer of the
          // voice, it is how that voice behaves.
          tb('Live',
            disc('env', 'Envelope', 'attack, decay, sustain, release') +
            subrows('env',
              sl(L, 'instrument.attack', 'Attack', i.attack, 0, 8000, 'ms') +
              sl(L, 'instrument.decay', 'Decay', num(i.decay, 200), 0, 8000, 'ms') +
              sl(L, 'instrument.sustain', 'Sustain', num(i.sustain, 70), 0, 100, '%') +
              sl(L, 'instrument.release', 'Release', i.release, 0, 12000, 'ms')) +
            // FILTER, RESONANCE, FINE, GLIDE AND TRIM ARE THE VOICE, not the mix.
            // They sat in Mix, which is why that group held nine rows of two
            // different questions: how this layer SOUNDS and where it SITS.
            disc('vox', 'Voice detail', 'filter, tuning, glide, trim') +
            subrows('vox',
              sl(L, 'cutoff', 'Filter', num(L.cutoff, 100), 0, 100, 'cutoff — 100 is fully open') +
              sl(L, 'reso', 'Resonance', num(L.reso, 0), 0, 100, 'filter peak') +
              sl(L, 'fine', 'Fine', num(L.fine, 0), -100, 100, 'cents — detune the voice') +
              sl(L, 'portamento', 'Glide', num(L.portamento, 0), 0, 2000, 'ms between notes') +
              sl(L, 'voiceTrim', 'Voice trim', num(L.voiceTrim, 0), -24, 12, 'dB — tame a hot voice')))
        ) +
        // ── ENVELOPE — the instrument's shape over time ───────────────────
        // Split out when the scheduled-tone row landed: Instrument was 456px of
        // the card's 1406 and half of that was the ADSR, which is a group in its
        // own right on any synth. (`decay` and `sustain` were stored and
        // threaded to `_ambApplyAdsr` from slice 13 with no control at all —
        // the reachability rule broken quietly for eight slices.)
        // ── PART — live or recorded, and how long a pass is ───────────────
        grpOpen('Content', true,
          // FIRST, so pressing a seed button and seeing the result is one glance
          // rather than a toast and a guess.
          partVizHtml(L) +
          // MATERIAL FIRST. It is the question the rest of the group qualifies —
          // what this part is MADE OF — and it was eighth in the tab strip,
          // behind Cycle, Bars, Plays and Transpose, which are all answers
          // ABOUT a part you have already made.
          // ONE row, not one per kind. Two elements sharing a class where only
          // one is ever visible is a trap for every future querySelector — the
          // first probe to touch it grabbed the hidden one and reported the
          // button as unreachable.
          '<div data-v2tab="Material" class="ambient-ctrl v2-notesrow"><label>Material</label>' +
            '<span class="ambient-seg-row v2-matrow">' +
              // THE MODEL, ONCE. Everything a generated part does is these two
              // axes; without saying so, the doors below look like five
              // unrelated buttons and the knobs behind them like a pile.
              // TWO STATES, ONE PAIR OF WORDS. The card said the same axis
              // three ways — `kind: live/recorded` inside, "Generated / Fixed"
              // in a Source select, and "Written / Generated" over these two
              // clusters — so "Generated" named both a cluster and a state, and
              // "Fixed" and "Written" named one state twice.
              // …AND BOTH DOORS MAKE THE SAME THING. The sentence used to set
              // them against each other — "GENERATED, re-made every cycle" vs
              // "WRITTEN, a fixed list" — and the first half was measurably
              // untrue: six consecutive cycles of a generated part give the
              // IDENTICAL notes unless the dice are on. They are two ways of
              // AUTHORING one thing, STATIC CONTENT, and the readout under the
              // drawing says whether it has been made live.
              '<span class="ambient-hint v2-matmodel">Two ways to make <b>STATIC CONTENT</b> \u2014 ' +
                'notes that do not change on iterations. \u270e by hand, note by note; ' +
                '\u2699 by setting rules and pressing a button (\ud83d\udd12 Lock writes a take down). ' +
                'It becomes <b>LIVE</b> only when you turn on the dice, Humanize, Vel var or Salt.</span>' +
              '<span class="v2-matgrp"><span class="v2-matlab" title="You choose the notes, one at a time. Static content — it plays exactly those notes every cycle.">By hand</span>' +
              '<button type="button" class="ambient-seg v2-compose" title="Notes you choose — draw them in the piano roll, compose them in the step grid, or start empty. The part becomes WRITTEN and plays exactly those notes.">\u270e Written<span class="v2-matsub">draw · grid · clear</span></button>' +
              // NO PHRASE DOOR HERE. It was a SIGNPOST to the bank tab — one
              // list wearing two words, asked about twice ("do we need both
              // Phrases and Phrase") — and, worse, it filed the bank under
              // WRITTEN. The bank takes a take whatever made it: a GENERATED
              // roll saves into it as readily as a phrase you drew, so it is
              // not one of this row's MATERIALS at all. It is the Bank tab.
              // ONE GENERATED DOOR. Four shape buttons in the row put every
              // choice on screen and left nowhere for the knobs that decide
              // what each shape actually produces — they were scattered across
              // Rhythm, Pattern and Pitch, three tabs away from the decision.
              // The door opens a popover holding the shapes AND their
              // parameters, so choosing and tuning are one place.
              '</span><span class="v2-matgrp"><span class="v2-matlab" title="You set some parameters and press a button; the app works the notes out. Static content too — the same take every cycle, until you turn the dice on. 🔒 Lock writes it down as notes.">By rule</span>' +
              '<button type="button" class="ambient-seg v2-genbtn" title="Choose a shape and tune what it generates — Sustained, Arpeggio, Roll, Mixed or Groundwork.">\u2699 Generated<span class="v2-matsub v2-genface">choose &amp; tune</span></button>' +
              // GROUNDWORK IS A SHAPE IN THE PANEL NOW (2026-09-09, user:
              // "move Groundwork into the Generated menu") — the row is two
              // doors, WRITTEN and GENERATED, which is the whole model.
              '</span>' +
            '</span>' +
            '<span class="ambient-hint v2-notecount"></span>' +
'</div>' +
          // THE DICE MOVED TO Shape ▸ Every pass (2026-09-12, asked as "what is
          // stochastic about live layers, and where are those controls — they
          // should be in one place"). Measured first, six consecutive cycles
          // counting DISTINCT note sets: `part.vary` gives 6, and EVERY other
          // knob named vary / var / scatter / chance gives 1, because each
          // seeds off a fixed take. So there are exactly three switches that
          // make a layer differ pass to pass, and two of them already lived
          // together — this one was a whole group away. A SIGNPOST is left
          // here, never a second copy: two surfaces for one control is the
          // duplication this file keeps paying for.
          '<div data-v2tab="Material" class="ambient-ctrl" data-v2when="kind:live"><label>Every cycle</label>' +
            '<span class="ambient-hint v2-varysign">take ' + ((L.part.take | 0) + 1) +
              ' is what plays. Whether it re-rolls lives with the other two dice \u2014 ' +
              '<b>Shape \u25b8 Every pass</b>.</span></div>' +
          // SEED LIKE A v1 LAYER — one button per type. Its own row rather than
          // more buttons on the one above: that row answers "recorded from
          // where", these answer "what shape is the live part", and seven more
          // chips in there would have made a wall of thirteen.
          // THE BANK, ON THE CARD. Saving a take is only half of it: the point
          // is to come back to one, and to put the ones you want in an order.
          // This is the SAME bank the compose grid saves to and `partSeqs`
          // maps to changes by name — one list, not a private copy.
          '<div data-v2tab="Bank" class="ambient-ctrl v2-bankrow"><label>Bank</label>' +
            '<span class="v2-bank">' +
              (bankList().length
                ? bankList().map((b2) =>
                    '<span class="v2-bankit" data-bi="' + b2.i + '">' +
                      '<button type="button" class="v2-bkload" data-bi="' + b2.i + '" title="Use this phrase as this part \u2014 the part becomes WRITTEN and plays exactly these notes.">' +
                        esc(b2.name) + '<span class="v2-bkn">' + b2.n + '</span></button>' +
                      '<button type="button" class="v2-bkup" data-bi="' + b2.i + '" aria-label="Move up" title="Move up">\u25b4</button>' +
                      '<button type="button" class="v2-bkdn" data-bi="' + b2.i + '" aria-label="Move down" title="Move down">\u25be</button>' +
                      '<button type="button" class="v2-bkdel" data-bi="' + b2.i + '" aria-label="Delete" title="Delete from the bank">\u2715</button>' +
                    '</span>').join('')
                : '<span class="ambient-hint">Nothing saved yet \u2014 press \ud83d\udcbe Save this take above the drawing, or compose a phrase. Anything you save lands here, generated or written.</span>') +
            '</span>' +
            '<span class="ambient-hint">tap one to make it this part \u2014 it plays exactly those notes \u2014 or map any of them to a part or a chord in \u25a6 Passes</span></div>' +
          '<div data-v2tab="Seed like" class="ambient-ctrl"><label>Seed like</label>' +
            '<span class="ambient-seg-row">' +
            ((V2 && V2.v1Seeds) || []).map(([ty, lab]) =>
              '<button type="button" class="ambient-seg v2-seedv1" data-v1="' + ty + '"' +
              ' title="Seed this part the way adding a v1 ' + lab + ' seeds one — its rhythm, its pitch shape and its length. Your instrument is left alone.">' +
              lab + '</button>').join('') +
            '</span>' +
            '<span class="ambient-hint">the content only — the voice you chose stays</span></div>' +
          // "Source", not "Part type" — and the buttons that FILL the part sit
          // directly under it as "Material". They were a separate row called
          // "Notes from", which named a place rather than a thing and left the
          // card asking the same question twice: the kind select said where the
          // notes come from in the abstract, and the button row said it again
          // concretely. One question now — what is this part made of — asked as
          // a source and answered by a material.
          // ── RHYTHM — when the notes happen. FOLDED INTO CONTENT (user:
          // "rhythm params should be in Content since it's editing/defining
          // content") — the group became three TABS of this sheet, the same
          // fold that took twelve groups to seven. The knob rows cluster under
          // ONE Rhythm tab (the kind gates keep the visible set small), the two
          // grids under Pattern, and Feel keeps its own.
          tb('Rhythm',
          '<div class="ambient-ctrl" data-v2when="kind:recorded"><label>Rhythm</label>' +
            '<span class="ambient-hint">These shape a <b>GENERATED</b> part, so they are greyed \u2014 this one is WRITTEN, its notes already placed. ' +
            'Press \ud83d\udd13 Unlock under the drawing to hand it back to the rules, or edit the notes in the drawing.</span></div>' +

          // `rhythmShown`, not `r.kind` — 'drawn' matches no option, and a
          // <select> with no matching option does not render empty, it silently
          // falls back to the FIRST one ("Pulse"). `applyGate` corrects it a
          // moment later, but the markup should be right on its own rather than
          // relying on a later pass to repair it.
          // "Rhythm type", matching "Tone type" — bare "Rhythm" also named the
          // tab it sits in, one word for two things.
          sel(L, 'part.rhythm.kind', 'Rhythm type', rhythmShown(r.kind), RHYTHM_OPTS, 'kind:live;voice:synth') +
          st(L, 'part.rhythm.n', 'Onsets', r.n, 1, 64, 'per cycle', 'kind:live;voice:synth;rhythm:pulse') +
          sl(L, 'part.rhythm.chance', 'Chance', r.chance, 0, 100, '% per step', 'kind:live;voice:synth;rhythm:chance') +
          sl(L, 'part.rhythm.syncop', 'Syncopate', num(r.syncop, 0), 0, 100, 'straight → offbeat',
             'kind:live;voice:synth;rhythm:chance')
          ) +
          // The knobs that DESCRIBE the grid live BESIDE it — with Rhythm type
          // set to Pattern, the pattern's own params were a tab away.
          // THE GRID LEADS ITS OWN TAB — it is the thing you edit, and it sat
          // under five knob rows ("the actual pattern should be at the top").
          // The knobs that describe it follow, condensed into ONE row of
          // MICRO STEPPERS: five full-size rows were ~500px of a sheet whose
          // whole pane is ~170px on a phone.
          tb('Pattern',
          // The grid spans the whole row: at 390px a 16-step grid inside the
          // 3-column `.ambient-ctrl` label gutter gives each cell ~14px.
          // NOT an inline `display:block` — `applyGate` clears the inline style
          // to SHOW a row, which would wipe it. The block layout is a class rule
          // (`.ambient-ctrl.v2-cellrow`), so hiding sets inline `none` and
          // showing falls back to the class. Inline styles and a gate that owns
          // `display` do not mix.
          // `form:roll` — in ▦ Steps the grid IS the Content line, and rendering
          // it here too would be two surfaces for one thing (the duplication
          // this file keeps paying for), with two live copies of one store.
          '<div class="ambient-ctrl v2-cellrow" data-v2when="kind:live;voice:synth;rhythm:euclid,drawn;form:roll">' +
            '<label>Pattern<button type="button" class="ambient-regen v2-regen" ' +
              'title="Back to the generated pattern — clears your edits">↻</button></label>' +
            cellsHtml(L) +
            ((L.part.pitch && L.part.pitch.kind === 'drawn') ? noteRowHtml(L) : '') +
            '<span class="ambient-hint v2-cellhint"></span></div>' +
          '<div class="ambient-ctrl v2-cellrow v2-lanerow" data-v2when="kind:live;voice:kit;form:roll">' +
            '<label>Drums</label>' + lanesHtml(L) +
            '<span class="ambient-hint v2-lanehint"></span></div>' +
          // ONE ROW, five micro steppers. The markup is the SHEET HEAD's proven
          // Register pattern (document-level ± delegation + the card's own
          // `.v2-f` commit), so it needs no wiring of its own; each cell
          // carries its OWN `data-v2when`, and `applyGate`'s grey-not-hide
          // branch was widened to `.v2-mini` so a Fixed part dims them
          // instead of leaving a blank row. `data-nudge` is an opt-in step
          // for the shared delegation (absent = 1) — Vary is 0-100 and ±1
          // would be unusable; the input is still tap-to-type at 16px.
          '<div class="ambient-ctrl v2-microrow" data-v2when="kind:live">' +
            // `form:roll` — in ▦ Steps this is DERIVED from Grid × Bars, and a
            // control that silently loses to a reconciler is the documented
            // dead-control class. The readout on the grid's own line says what
            // it came out as.
            mini(L, 'part.rhythm.steps', 'Steps', r.steps, 1, 256, 1, 'kind:live;form:roll') +
            mini(L, 'part.rhythm.pulses', 'Pulses', r.pulses, 1, 64, 1, 'kind:live;voice:synth;rhythm:euclid,drawn') +
            mini(L, 'part.rhythm.rotate', 'Rotate', r.rotate, 0, 63, 1, 'kind:live;voice:synth;rhythm:euclid,drawn') +
            mini(L, 'part.rhythm.voices', 'Voices', num(r.voices, 1), 1, 8, 1, 'kind:live;voice:synth;rhythm:euclid') +
            // Re-rolls the pattern every cycle instead of repeating it — v1's
            // own asymmetric rule, so a varied v2 pattern and a varied v1 one
            // wander the same way.
            mini(L, 'part.rhythm.vary', 'Vary', num(r.vary, 0), 0, 100, 5, 'kind:live;rhythm:euclid,drawn') +
          '</div>'
          ) +
          // THE TIMING HALF OF THE OLD 'Motion' — swing, accent, tightness and
          // humanize are all about WHEN a note lands, which is this group's
          // question. The other half went to Shape.
          tb('Feel',
            sl(L, 'swing', 'Swing', num(L.swing, 0), 0, 100, 'straight → shuffle', 'kind:live') +
          sl(L, 'part.rhythm.rateVar', 'Rate var', num((L.part.rhythm || {}).rateVar, 0), 0, 100,
             'steady → rushes — replays per take', 'kind:live;voice:synth') +
          sl(L, 'accent', 'Accent', num(L.accent, 0), 0, 100, 'flat → dynamic') +
          '<div class="ambient-ctrl"><label>Tight</label>' +
            '<button type="button" class="ambient-seg v2-tighttoggle' + (L.tight ? ' on' : '') + '">' +
              (L.tight ? 'On — clipped' : 'Off') + '</button>' +
            '<span class="ambient-hint">cut each note short of the next</span></div>') +
          // (THE SOURCE SELECT IS GONE. It was a THIRD door to `part.kind`,
          // three tabs from the drawing, and the destructive one: picking
          // "Fixed" wrote the field and captured nothing, so a generating part
          // became an EMPTY written one and the empty-state hint had to explain
          // it. 🔒 Lock / 🔓 Unlock on the take bar is the same transition made
          // properly — it freezes exactly the take you are looking at — and it
          // sits under the drawing, where the state it changes is visible.)
          sel(L, 'part.clock', 'Cycle', p.clock === 'free' ? 'free' : 'bars',
              [['bars', 'Bars — follows the grid'], ['free', 'Free — its own clock']]) +
          (L.lenSync
            // A BOUND CYCLE IS RECONCILED ON EVERY NORMALIZE, so the stepper
            // would silently lose to it on the next getCfg — the documented
            // dead-control class. State the binding instead, the way v1's
            // Scheduler replaces its bars/plays inputs with a chip.
            ? '<div data-v2tab="Bars" class="ambient-ctrl" data-v2when="clock:bars"><label>Bars</label>' +
              '<span class="ambient-loop-badge">\u27f2 ' + (L.lenSync.passes | 0) + ' \u00d7 part</span>' +
              '<span class="ambient-hint">' + esc(String(p.bars)) + ' bars \u2014 set by the loop binding (\u22ef menu)</span></div>'
            // …and PER-PART is the same situation: a record filed under a part
            // IS that part's length, reconciled on every normalize, so the
            // stepper would lose to it exactly the same way.
            : Number.isFinite(L.partFor)
            ? '<div data-v2tab="Bars" class="ambient-ctrl" data-v2when="clock:bars"><label>Bars</label>' +
              '<span class="ambient-loop-badge">\u25eb ' + esc(String(p.bars)) + ' \u00d7 part</span>' +
              '<span class="ambient-hint">this content is for one part, so its length is that ' +
              'part\u2019s \u2014 switch to \u25ad Everywhere to set it yourself</span></div>'
            : st(L, 'part.bars', 'Bars', p.bars, 1, 32, 'per cycle', 'clock:bars')) +
          // WHAT CHANGING BARS DOES. Onsets are per CYCLE, so more bars spreads
          // the same notes further apart — good for a pad, wrong for a riff you
          // wanted twice as long. Tagged into the Bars tab because it is the
          // same question, not a new one.
          '<div data-v2tab="Bars" class="ambient-ctrl" data-v2when="clock:bars">' +
            '<label for="' + uid(L, 'part.barsMode') + '">More bars</label>' +
            '<select id="' + uid(L, 'part.barsMode') + '" class="ambient-select v2-f" data-f="part.barsMode">' +
              '<option value="stretch"' + ((p.barsMode || 'stretch') === 'stretch' ? ' selected' : '') + '>Stretch — the same notes, spread out</option>' +
              '<option value="fill"' + (p.barsMode === 'fill' ? ' selected' : '') + '>Fill — keep writing, same density</option>' +
            '</select><span class="ambient-hint"></span></div>' +
          sl(L, 'part.ms', 'Every', num(p.ms, 2000), 200, 20000, 'ms — ignores the bar grid', 'clock:free') +
          // WHEN — which ITERATIONS of the cycle this layer plays. v1 edits this
          // in the Scheduler's Advanced block, which renders per-type controls
          // v2 has no part in, so it gets its own control here. The values are
          // `_ambCondFires`' own vocabulary: 'always', '1st', or a binary string
          // of any length (one char per cycle, repeating).
          sel(L, 'when', 'Plays', (typeof L.when === 'string' && L.when) ? L.when : 'always',
              [['always', 'Every cycle'], ['10', 'Every other'], ['100', 'Every 3rd'],
               ['1000', 'Every 4th'], ['1100', '2 on, 2 off'], ['1st', 'First time only']]) +
          st(L, 'part.transpose', 'Transpose', p.transpose || 0, -24, 24, 'semitones', 'kind:recorded') +
          // What a RECORDED part does when the chords move under it. Inert on a
          // live part, which re-resolves its pitches every cycle by definition —
          // the same reason v1 marks it inert while a layer is generating.
          // "Follows changes", not "Harmony": `L.harmony` is how a RECORDED part
          // tracks the chords, while `part.pitch.harm` is interval doubling —
          // two mechanisms, and they were both called Harmony on the same card.
          sel(L, 'harmony', 'Follows changes', L.harmony || 'fixed',
              [['fixed', 'Keep the written pitches'], ['diatonic', 'Follow the key'], ['chordlock', 'Lock to the chord']],
              'kind:recorded') +
          sel(L, 'speed', 'Speed', String(num(L.speed, 1)),
              [['0.25', '¼ — four times slower'], ['0.5', '½ — half speed'], ['1', '1× — as written'],
               ['2', '2× — double speed'], ['4', '4× — four times faster']]) +
          // THE DOOR, ON THE CARD. Selecting "Recorded" from the dropdown used to
          // be a dead end: nothing authors notes, so the part was silent with no
          // way forward and no explanation. (rule 6: name the door.)
          // THE COMPOSE DOCK. v1 resolves it live by key
          // (`.ambient-seedgrid-slot[data-sgkey] .ambient-seedgrid-dockhost`) —
          // a panel rebuild recreates the card, so a stored node goes stale.
          // Same markup, so `_placeLaneExpander` finds it with no change there.
          '<div class="ambient-seedgrid-slot v2-dock" data-sgkey="v2:' + L.id + '" hidden>' +
            '<div class="ambient-seedgrid-dockhost"></div>' +
            '<div class="ambient-seedgrid-prib" hidden></div>' +
            '<div class="ambient-seedgrid-chords" hidden></div>' +
            '<div class="ambient-seedgrid-striphost"></div>' +
            // STEP GRANULARITY + JOIN, and SAVE TO THE BANK. Both are v1 chrome
            // keyed on the SESSION (`_ambGridGranBar` gates on
            // `ge.E === E && h.dataset.sgk === ge.key`; the bank button is
            // delegated on the panel host, which contains the v2 card host) —
            // so the markup IS the wiring, exactly as the Key override was.
            // Without the gran bar a v2 compose had no way to choose how fine
            // the grid is; without the bank button a v2 phrase could be adopted
            // FROM the bank but never added TO it, so the bank could only ever
            // be filled from a v1 layer.
            '<span class="ambient-seedgrid-gran" data-sgk="v2:' + L.id + '" hidden></span>' +
            '<div class="ambient-ctrl v2-gacts"><label></label><span class="ambient-seg-row">' +
              '<button type="button" class="ambient-seg v2-gdone">✓ Done</button>' +
              '<button type="button" class="ambient-seg ambient-seedgrid-bank" data-sgk="v2:' + L.id + '"' +
                ' title="Save this phrase to the sequence bank under a name, so it can be reused — on another layer, in another area, or bound to a part.">⬇ To bank…</button>' +
              '<button type="button" class="ambient-seg v2-gcancel">✕ Cancel</button>' +
            '</span><span class="ambient-hint">what you draw is what it plays</span></div>' +
          '</div>' +
          ((p.kind === 'recorded' && !(p.notes || []).length)
            ? '<div data-v2tab="Material" class="ambient-ctrl" data-v2when="kind:recorded"><label></label>' +
              '<span class="ambient-hint" style="color:#f6ad55">Nothing here yet — press 🎲 Roll a take above the drawing, compose a phrase, or 🔓 Unlock to go back to the rules.</span></div>'
            : '')
        ) +
        // ── PITCH — what the notes are, and how long they ring ────────────
        grpOpen('Pitch', true,
          // NOTES — the layer's own pitch SOURCE (a scale, a chord, a wrap, its
          // own progression). v1's builder and v1's menu, so the vocabulary and
          // the precedence cannot drift; `_ambNotesOf` already applies the AREA
          // PROGRESSION LOCK, which is why the button greys while one is on.
          // KEY — the layer's own harmonic frame (its own key, its own chord
          // changes, or yoked to another layer's sounding notes). v1's markup,
          // extracted into `_ambKeyOvHtml` so there is one copy: everything in
          // it is keyed on `data-kokey` and v1's wiring is DELEGATED on the
          // panel host by that key, so a v2 card inside the host gets working
          // controls with no wiring of its own. `keyOv` was already coerced and
          // already READ (it rides `_ambNotesOf`) — this is the door.
          ((typeof _ambKeyOvHtml === 'function')
            ? tb('Key', _ambKeyOvHtml('v2:' + L.id, L))
            : '') +
          ((typeof _ambNotesButtonHtml === 'function')
            ? _ambNotesButtonHtml('v2-' + L.id).replace('<div class="ambient-ctrl"',
                '<div class="ambient-ctrl" data-v2when="kind:live;voice:synth"')
            : '') +
          sel(L, 'part.pitch.kind', 'Pitch', t.kind, PITCH_OPTS, 'kind:live;voice:synth') +
          st(L, 'part.pitch.voices', 'Voices', t.voices, 1, 9, 'notes per onset', 'kind:live;voice:synth;pitch:chord,stack,mixed') +
          // THE BALANCE for Mixed — how often an onset is a chord rather than
          // a single note. Its own tab so it is findable, gated to the one
          // kind that reads it.
          sl(L, 'part.pitch.mix', 'Mix', (Number.isFinite(t.mix) ? t.mix : 50), 0, 100,
             'all single notes \u2192 all chords', 'kind:live;voice:synth;pitch:mixed') +
          // LINES, not "Voices" — divergent behaviour, divergent label. Voices
          // are notes of ONE chord struck together; lines are separate melodies
          // that wander independently, which is the only way a Roll plays more
          // than one note at a time under its own steam (Harmony duplicates the
          // one line at a fixed interval — parallel, never independent). Its own
          // FIELD too: `pitch.voices` is backfilled to 3 on every pitch object,
          // so reading that here would thicken every rolled part ever saved.
          st(L, 'part.pitch.lines', 'Lines', (t.lines | 0) || 1, 1, 6,
             'independent melodies at once — 1 is a single line',
             'kind:live;voice:synth;pitch:walk,chance') +

          st(L, 'part.pitch.degree', 'Note', t.degree, 1, 12, 'source tone', 'kind:live;voice:synth;pitch:fixed,stack,walk,series') +
          sl(L, 'part.pitch.roam', 'Roam', num(t.roam, 0), 0, 100, 'how often the Note wanders — replays per take',
             'kind:live;voice:synth;pitch:fixed,stack') +
          sel(L, 'part.pitch.dir', 'Direction', t.dir || 'up',
              [['up', 'Up'], ['down', 'Down'], ['updown', 'Up & down']], 'kind:live;voice:synth;pitch:series') +
          st(L, 'part.pitch.span', 'Span', t.span, 1, 24, 'how far it wanders', 'kind:live;voice:synth;pitch:walk') +
          sel(L, 'part.pitch.home', 'Home', t.home || 'floor',
              [['floor', 'Floor — walk up from Register'], ['center', 'Centre — Register in the middle'],
               ['ceiling', 'Ceiling — walk down from Register']], 'kind:live;voice:synth;pitch:walk') +
          sl(L, 'part.pitch.contour', 'Contour', num(t.contour, 0), -100, 100, 'fall → rise',
             'kind:live;voice:synth;pitch:walk') +
          sl(L, 'part.pitch.stutter', 'Stutter', num(t.stutter, 0), 0, 100, 'walk → repeats',
             'kind:live;voice:synth;pitch:walk') +
          sl(L, 'part.pitch.drift', 'Pitch vary', num(t.drift, 0), 0, 100, 'octave drift — replays per take',
             'kind:live;voice:synth;pitch:fixed,series,walk,chance') +
          // HARMONY PARTS — chips, because it is a SET, not a choice: a line can
          // carry a 3rd and a 6th at once, which is what "multiple-part
          // harmonies" means. Intervals are SOURCE TONES, so they stay in the
          // key (verified: thirds across C major come out 4,3,3,4,4,3,3
          // semitones — major on I/IV/V, minor on the rest). Applies to every
          // live pitch kind, so it is gated on kind:live only.
          harmRowHtml(L, t) +

          st(L, 'part.pitch.octaves', 'Octaves', num(t.octaves, 2), 1, 4, 'how far the sweep climbs',
             'kind:live;voice:synth;pitch:series') +
          sl(L, 'part.pitch.randomness', 'Scatter', num(t.randomness, 0), 0, 100, 'ordered → jumps about',
             'kind:live;voice:synth;pitch:series') +
          sl(L, 'part.shape.lenRatio', 'Length', sh.lenRatio, 1, 400, '% of the onset span', 'kind:live') +
          '<div data-v2tab="Length" class="ambient-ctrl"><label>Ring out</label>' +
            '<button type="button" class="ambient-seg v2-ringtoggle' + (L.ring ? ' on' : '') + '">' +
              (L.ring ? 'On \u2014 through the changes' : 'Off \u2014 released by the next change') + '</button>' +
            '<span class="ambient-hint">a note is cut short so it does not ring over the next change \u2014 ' +
              'turn this on to let it play its full length</span></div>' +
          // VOICING IS A SUB-QUESTION OF PITCH — how the chosen notes are
          // stacked and spread. And Proximity moved here from Motion: it
          // pulls each pick toward the previous one, which is a PITCH rule.
          tb('Voicing',
            sl(L, 'proximity', 'Proximity', num(L.proximity, 0), 0, 100, 'how close notes stay', 'kind:live') +
          sel(L, 'part.pitch.chordMode', 'Voicing', t.chordMode || '',
              [['', 'Simple — stack the tones'], ['chaos', 'Chaos'], ['chords', 'Chords'],
               ['chordsplus', 'Chords+'], ['monk', 'Monk']], 'kind:live;voice:synth;pitch:chord') +
          st(L, 'part.pitch.spread', 'Spread', num(t.spread, 0), 0, 3, '± octaves',
             'kind:live;voice:synth;pitch:chord') +
          sl(L, 'part.pitch.variety', 'Variety', num(t.variety, 0), 0, 100, 'plain → colourful',
             'kind:live;voice:synth;pitch:chord') +
          st(L, 'part.pitch.subdiv', 'Subdivide', num(t.subdiv, 1), 1, 16, 'voicings per chord',
             'kind:live;voice:synth;pitch:chord') +
          st(L, 'part.pitch.phraseLen', 'Phrase', num(t.phraseLen, 4), 1, 16, 'chords before it repeats',
             'kind:live;voice:synth;pitch:chord') +
          st(L, 'part.pitch.repeats', 'Repeats', num(t.repeats, 4), 1, 16, 'times before a fresh phrase',
             'kind:live;voice:synth;pitch:chord') +
          sel(L, 'part.pitch.feel', 'Feel', t.feel || '',
              [['', 'In order — walk the variants'], ['stochastic', 'Stochastic — pick per slot']],
              'kind:live;voice:synth;pitch:chord') +
          st(L, 'part.pitch.voiceCap', 'Voice cap', num(t.voiceCap, 0), 0, 12, 'ceiling incl. colour tones (0 = Voices)',
             'kind:live;voice:synth;pitch:chord') +
          '<div class="ambient-ctrl" data-v2when="kind:live;voice:synth;pitch:chord"><label>Salt re-voice</label>' +
            '<button type="button" class="ambient-seg v2-salttoggle' + (L.followSalt ? ' on' : '') + '">' +
              (L.followSalt ? 'On — follows the colours' : 'Off — holds the chord') + '</button>' +
            '<span class="ambient-hint v2-salthint"></span></div>')
        ) +
        // ── VOICING — how a CHORD is laid out, once its notes are known ────
        // Split out of Pitch when Salt re-voice landed and the card measured
        // 1422px: Pitch had become two questions (which notes, and how they are
        // arranged), and the accretion check refused the sum for the third time
        // in this campaign.
        // ── SHAPE — how each onset is PLAYED, once the notes are chosen ────
        // Split out of Pitch when strum landed: Pitch answers "which notes",
        // Shape answers "how they are struck", and the card measured 1467px
        // with both in one group — the accretion check refusing it for the
        // second time in this campaign, which is exactly its job. The model's
        // own name for this is `part.shape`.
        grpOpen('Shape', false,
          st(L, 'part.shape.holdSteps', 'Hold', num(sh.holdSteps, 0), 0, 16, 'steps (0 = use Length)', 'kind:live') +
          st(L, 'part.shape.maxEvents', 'Max events', num(sh.maxEvents, 0), 0, 64, 'per cycle (0 = off)', 'kind:live') +
          // Only means something where an onset carries MORE THAN ONE note.
          sl(L, 'strum', 'Strum', num(L.strum, 0), 0, 100, 'struck → arpeggiated',
             'kind:live;voice:synth;pitch:chord,stack') +
          sl(L, 'strumFidelity', 'Strum order', num(L.strumFidelity, 0), 0, 100, 'low→high → wandering',
             'kind:live;voice:synth;pitch:chord,stack') +
          sl(L, 'slide', 'Slide', num(L.slide, 0), 0, 100, 'glide across a leap', 'kind:live;voice:synth') +
          sl(L, 'ornament', 'Ornament', num(L.ornament, 0), 0, 100, 'grace-note flicks', 'kind:live;voice:synth') +
          sl(L, 'phrasing', 'Phrasing', num(L.phrasing, 0), 0, 100, 'even → shaped figures', 'kind:live;voice:synth') +
          sl(L, 'startVary', 'Start', num(L.startVary, 0), 0, 100, 'on the 1 → anywhere', 'kind:live') +
          sl(L, 'twist', 'Twist', num(L.twist, 0), 0, 100, 'steady → bursts', 'kind:live;voice:synth') +
          // "Wobble", not "Motion": this is a detune wobble, and 'Motion' was
          // also a top-level group — one word over two unrelated things.
          sl(L, 'motion', 'Wobble', num(L.motion, 0), 0, 100, 'detune wobble', 'kind:live;voice:synth') +
          // SHAPING — these change WHAT each note is, ONCE. The tab was called
          // "Variance", which is measurably the wrong word: six consecutive
          // cycles of a part with Rests, Ghosts or Len vary up give the
          // IDENTICAL note set every time, because they seed off a fixed take.
          // They shape the static content; they do not animate it. Filing them
          // as variance put three deterministic knobs under a heading that
          // promised the opposite.
          tb('Shaping',
            sl(L, 'restProb', 'Rests', num(L.restProb, 0), 0, 100, '% of onsets dropped — the same ones every cycle') +
            sl(L, 'ghosts', 'Ghosts', num(L.ghosts, 0), 0, 100, 'quiet extra hits — the same ones every cycle') +
            sl(L, 'lenVary', 'Len vary', num(L.lenVary, 0), 0, 100, 'note-length scatter — fixed per take')) +
          // EVERY PASS — every switch that makes THIS layer differ pass to
          // pass, in one place, which is what was asked for. Measured rather
          // than assumed: the CONTENT tier is `part.vary` and nothing else (6
          // distinct note sets in 6 cycles, against a floor of 1 that every
          // other variance knob also scores), and the PERFORMANCE tier is
          // Humanize (unseeded — 6 distinct offsets, never replays) and Vel var
          // (seeded on position-in-the-performance, so passes differ while one
          // take replays). Both come from `_ambApplyAdsr`, so the semantics are
          // v1's rather than a second implementation — which is also why a
          // `notesFor` sweep is structurally blind to them and they have to be
          // measured where they are applied.
          //   The tab is NOT called "Live": Instrument already has a tab by
          // that name, and one word for two things is the naming rule's own
          // mistake. "Every pass" names the axis instead.
          //   Two more things can make a layer live and are NOT its own to set
          // — a mask left at a PROBABILITY, and the changes themselves moving
          // underneath it. The line below NAMES them when they apply, from
          // `liveness()` — the same predicate the drawing's readout uses, so
          // the two can never disagree — and points at where they live.
          tb('Every pass',
            '<div class="ambient-ctrl" data-v2when="kind:live"><label>Re-roll</label>' +
              '<button type="button" class="ambient-seg v2-varytoggle' + (L.part.vary ? ' on' : '') + '">' +
                (L.part.vary ? '\ud83c\udfb2 Re-roll every cycle' : '\u2713 Play this take') + '</button>' +
              '<span class="ambient-hint v2-varyhint">' + (L.part.vary
                ? 'a fresh roll each cycle \u2014 the drawing is take ' + ((L.part.take | 0) + 1) + ', one of many'
                : 'take ' + ((L.part.take | 0) + 1) + ' is what plays, every cycle') + '</span></div>' +
            sl(L, 'humanize', 'Humanize', num(L.humanize, 0), 0, 100, 'timing jitter — never replays') +
            sl(L, 'velVar', 'Vel var', num(L.velVar, 0), 0, 100, 'level scatter — differs pass to pass') +
            '<div class="ambient-ctrl"><label></label><span class="ambient-hint v2-liveline"></span></div>')
        ) +
        // ── MIX — level, filtering, routing and stereo placement ──────────
        // These are the TREATMENTS: shared v1 fields the chain already reads, so
        // this group is a surface over machinery that exists rather than new
        // plumbing. It was unreachable until slice 5 built the chain — every one
        // of these was inert because the notes bypassed it.
        grpOpen('Mix', false,
          sl(L, 'level', 'Level', L.level, 0, 100, 'in the mix') +
          // "Filter", not "Tone" — `instrument.tone` is the VOICE and this is the
          // filter cutoff. Two rows on one card labelled the same thing is the
          // naming rule's own failure mode; the audit flagged it as a duplicate.
          tb('EQ', sl(L, 'eq.low', 'EQ low', num((L.eq || {}).low, 0), -24, 24, 'dB') +
            sl(L, 'eq.mid', 'EQ mid', num((L.eq || {}).mid, 0), -24, 24, 'dB') +
            sl(L, 'eq.high', 'EQ high', num((L.eq || {}).high, 0), -24, 24, 'dB')) +
          // SPACE AND MOD FOLD IN HERE. Mix is now one question — what happens
          // to the layer after it is played: how loud, where it sits, where it
          // is sent, and what moves. Space was split OUT of Mix when the voice
          // rows landed here; with those gone to Instrument it fits again.
          tb('Space',
            sl(L, 'revSend', 'Reverb', num(L.revSend, 0), 0, 100, 'send to the shared reverb') +
          sel(L, 'bus', 'Bus', L.bus || 'a',
              [['a', 'A — the main path'], ['b', 'B'], ['c', 'C'], ['d', 'D']]) +
          sl(L, 'space', 'Width', num(L.space, 0), -100, 100, 'spread, or position in Pan mode') +
          sel(L, 'panMode', 'Stereo', L.panMode || 'spread',
              [['spread', 'Spread — widen'], ['pan', 'Pan — place it']]) +
          // SPATIALIZE — a per-note pan SEQUENCE, distinct from Width (a static
          // spread). Applied inside `_ambCapSink`, which v2 already installs per
          // layer, so like the trance gate it worked already and needed only a
          // surface.
          '<div class="ambient-ctrl"><label>Move</label>' +
            '<button type="button" class="ambient-seg v2-spattoggle' + (spatOn(L) ? ' on' : '') + '">' +
              (spatOn(L) ? 'On — moving' : 'Off') + '</button>' +
            '<span class="ambient-hint">pan note by note</span></div>' +
          sel(L, 'spat.mode', 'Move as', (L.spat || {}).mode || 'fan', SPAT_OPTS, 'spat:on') +
          sl(L, 'spat.width', 'Move width', num((L.spat || {}).width, 60), 0, 100, 'how far', 'spat:on') +
          st(L, 'spat.steps', 'Positions', num((L.spat || {}).steps, 5), 2, 16, 'per cycle', 'spat:on') +
          // AREA FADE — how long this layer takes to fall silent when the area
          // sequence moves on. Read by `_ambAreaFadeMap`; carried by the v1
          // import since slice 12 and, until now, unreachable.
          st(L, 'areaFadeMs', 'Area fade', num(L.areaFadeMs, 250), 0, 4000, 'ms leaving an area')) +
          // MOD IS ITS OWN QUESTION — what MOVES. Inside the Space cluster it
          // read as placement, which it is not.
          tb('Mod',
            ((typeof _ambModTarget === 'function')
            ? ('<div class="ambient-ctrl"><label for="ambient-v2-' + L.id + '-mod-sync">Rate timing</label>' +
                 '<select id="ambient-v2-' + L.id + '-mod-sync" class="ambient-select">' +
                   '<option value="free"' + (((L.mod || {}).sync !== 'sync') ? ' selected' : '') + '>Free (Hz)</option>' +
                   '<option value="sync"' + (((L.mod || {}).sync === 'sync') ? ' selected' : '') + '>Sync (tempo)</option>' +
                 '</select><span class="ambient-hint">free / sync</span></div>' +
               _ambModTarget('v2-' + L.id, 'vca', 'VCA \u00b7 amplitude', 'tremolo', 30) +
               _ambModTarget('v2-' + L.id, 'vco', 'VCO \u00b7 pitch', 'vibrato', 20) +
               _ambModTarget('v2-' + L.id, 'vcf', 'VCF \u00b7 cutoff', 'sweep', 15))
            : ''))
        ) +
        // ── FX — the effect stages ────────────────────────────────────────
        // An effect's own parameters are gated on the effect being ENGAGED
        // (`on:delay`), which is what keeps this group from being the 18-row
        // dump it was: 8 rows at rest, growing only around what you turn up.
        grpOpen('FX', false,
          tb('Delay', sl(L, 'delay.mix', 'Delay', num(fx(L, 'delay').mix, 0), 0, 100, 'wet amount') +
            sl(L, 'delay.timeMs', 'Delay time', num(fx(L, 'delay').timeMs, 300), 20, 1500, 'ms — Sync overrides', 'on:delay') +
            sel(L, 'delay.sync', 'Delay sync', fx(L, 'delay').sync || '',
                [['', 'free (ms)']].concat(DELAY_SYNCS.map(d2 => [d2, d2])), 'on:delay') +
            sl(L, 'delay.feedback', 'Delay fb', num(fx(L, 'delay').feedback, 35), 0, 95, 'repeats', 'on:delay') +
            ftog(L, 'delay.ping', 'Ping-pong', 'On — bounce L/R', 'Off', 'echoes alternate sides', 'on:delay') +
            sl(L, 'delay.spread', 'Delay width', num(fx(L, 'delay').spread, 0), 0, 100, 'mono → wide', 'on:delay') +
            fdk(L, 'delay', 'on:delay')) +
          tb('Drive', sl(L, 'dist.mix', 'Drive', num(fx(L, 'dist').mix, 0), 0, 100, 'wet amount') +
            sel(L, 'dist.flavor', 'Drive type', fx(L, 'dist').flavor || '', DIST_OPTS, 'on:dist') +
            sl(L, 'dist.amount', 'Drive amt', num(fx(L, 'dist').amount, 40), 0, 100, 'how hard', 'on:dist') +
            sl(L, 'dist.focus', 'Focus', num(fx(L, 'dist').focus, 0), 0, 100, 'full range → highs only', 'on:dist') +
            sl(L, 'dist.tone', 'Drive tone', num(fx(L, 'dist').tone, 50), 0, 100, 'dark ← flat → bright', 'on:dist') +
            fdk(L, 'dist', 'on:dist')) +
          tb('Chorus', sl(L, 'chorus.mix', 'Chorus', num(fx(L, 'chorus').mix, 0), 0, 100, 'wet amount') +
            sl(L, 'chorus.depth', 'Chorus depth', num(fx(L, 'chorus').depth, 50), 0, 100, 'subtle → deep', 'on:chorus') +
            sl(L, 'chorus.rate', 'Chorus rate', num(fx(L, 'chorus').rate, 30), 0, 100, 'slow → fast', 'on:chorus') +
            fdk(L, 'chorus', 'on:chorus')) +
          tb('Phaser', sl(L, 'phaser.mix', 'Phaser', num(fx(L, 'phaser').mix, 0), 0, 100, 'wet amount') +
            sl(L, 'phaser.depth', 'Phaser depth', num(fx(L, 'phaser').depth, 50), 0, 100, 'narrow → wide', 'on:phaser') +
            sl(L, 'phaser.rate', 'Phaser rate', num(fx(L, 'phaser').rate, 30), 0, 100, 'slow → fast', 'on:phaser') +
            fdk(L, 'phaser', 'on:phaser')) +
          tb('Auto-pan', sl(L, 'autopan.mix', 'Auto-pan', num(fx(L, 'autopan').mix, 0), 0, 100, 'wet amount') +
            sl(L, 'autopan.depth', 'Pan depth', num(fx(L, 'autopan').depth, 100), 0, 100, 'centre → full L↔R', 'on:autopan') +
            sl(L, 'autopan.rate', 'Pan rate', num(fx(L, 'autopan').rate, 30), 0, 100, 'slow → fast', 'on:autopan') +
            fdk(L, 'autopan', 'on:autopan')) +
          // GLITCH is CORE-ONLY — a granulator has no sane Web Audio node build,
          // so with core strips off the stage simply is not there. v1 says so on
          // its own card rather than failing silently; so does this.
          tb('Glitch', sl(L, 'glitch.mix', 'Glitch', num(fx(L, 'glitch').mix, 0), 0, 100,
             coreStrips() ? 'wet amount' : 'needs the core engine') +
            sel(L, 'glitch.mode', 'Glitch as', fx(L, 'glitch').mode || 'grain', GLITCH_OPTS, 'on:glitch') +
            sl(L, 'glitch.sizeMs', 'Glitch size', num(fx(L, 'glitch').sizeMs, 80), 5, 900, 'ms per grain/slice', 'on:glitch') +
            sl(L, 'glitch.rate', 'Glitch rate', num(fx(L, 'glitch').rate, 25), 1, 100, 'meaning depends on the type', 'on:glitch') +
            sl(L, 'glitch.jitter', 'Scatter', num(fx(L, 'glitch').jitter, 40), 0, 100, 'how far back grains reach', 'on:glitch') +
            sl(L, 'glitch.pitch', 'Glitch pitch', num(fx(L, 'glitch').pitch, 0), 0, 24, '± semitones per grain', 'on:glitch') +
            fdk(L, 'glitch', 'on:glitch')) +
          // PITCH ECHO — spawns pitched repeats of each note, in key. Lives in
          // the capture tee (`_ambCapSink` → `_ambSchedulePitchEcho`), which v2
          // installs per layer and which resolves through `_ambLayerByKey` — so
          // it worked for a v2 layer already and lacked only this surface.
          tb('Pitch echo', ftog(L, 'pecho.on', 'Pitch echo', 'On — echoing', 'Off', 'pitched repeats of each note') +
            sl(L, 'pecho.timeMs', 'Echo time', num((L.pecho || {}).timeMs, 300), 20, 4000, 'ms — Sync overrides', 'on:pecho') +
            sel(L, 'pecho.sync', 'Echo sync', (L.pecho || {}).sync || '', PECHO_SYNCS, 'on:pecho') +
            st(L, 'pecho.repeats', 'Repeats', num((L.pecho || {}).repeats, 3), 1, 12, 'echoes per note', 'on:pecho') +
            st(L, 'pecho.step', 'Echo step', num((L.pecho || {}).step, 2), -7, 7, 'scale degrees per echo', 'on:pecho') +
            '<div class="ambient-ctrl" data-v2when="on:pecho"><label>Echo arp</label>' +
              '<input type="text" class="ambient-select v2-f" data-f="pecho.pattern" placeholder="e.g. 0,4,7" ' +
                'value="' + esc(String((L.pecho || {}).pattern || '')) + '">' +
              '<span class="ambient-hint">degree offsets the echoes cycle</span></div>' +
            sl(L, 'pecho.feedback', 'Echo decay', num((L.pecho || {}).feedback, 65), 0, 100, 'each echo vs the last', 'on:pecho') +
            sl(L, 'pecho.spread', 'Echo width', num((L.pecho || {}).spread, 0), 0, 100, 'echoes alternate sides', 'on:pecho') +
            fdk(L, 'pecho', 'on:pecho')) +
          // TRANCE GATE — a bar-synced step pattern that chops the layer. The
          // engine already drove this for v2 the moment the chain existed
          // (`_ambScheduleStochastic` walks `_E.mod`, `_ambScheduleTg` resolves
          // through `_ambLayerByKey`), so this is a surface over working
          // machinery: measured quiet frames at 0.00000 against 0.288 loud.
          // Labelled "Chop", not "Gate" — this card's other gates are the
          // SCHEDULE gates (Plays, and the chord/section/unit matrices), and one
          // word for two unrelated mechanisms is how a control gets misread.
          tb('Chop', '<div class="ambient-ctrl"><label>Chop</label>' +
            '<button type="button" class="ambient-seg v2-tgtoggle' + (tgOn(L) ? ' on' : '') + '">' +
              (tgOn(L) ? 'On — chopping' : 'Off') + '</button>' +
            '<span class="ambient-hint">bar-synced gate</span></div>' +
          st(L, 'tg.steps', 'Chop steps', num((L.tg || {}).steps, 16), 1, 32, 'per bar', 'tg:on') +
          sl(L, 'tg.depth', 'Chop depth', num((L.tg || {}).depth, 100), 0, 100, '% cut', 'tg:on') +
          sl(L, 'tg.edge', 'Chop edge', num((L.tg || {}).edge, 6), 0, 60, 'ms softening', 'tg:on') +
          '<div class="ambient-ctrl v2-cellrow" data-v2when="tg:on"><label>Chop pattern</label>' +
            tgCellsHtml(L) + '<span class="ambient-hint v2-tghint"></span></div>') +
          // WET ONLY mutes the layer's DRY output so only the reverb wash and wet
          // FX tails sound. A BUTTON, not a select — the trance gate's lesson:
          // a select writes a STRING and '0' is truthy, so "Off" would switch it on.
          '<div class="ambient-ctrl"><label>Wet only</label>' +
            '<button type="button" class="ambient-seg v2-wettoggle' + (wetOn(L) ? ' on' : '') + '">' +
              (wetOn(L) ? 'On — tails only' : 'Off') + '</button>' +
            '<span class="ambient-hint">mute the dry signal</span></div>'
        ) +
      '</div></div>';
  }

  // ── THE GATE ────────────────────────────────────────────────────────────
  // One pass, driven ONLY by piece values. `data-v2when` is a semicolon list of
  // `piece:value,value` clauses; every clause must match for the row to show.
  function applyGate(card, L) {
    const p = L.part;
    const now = {
      // ▦ STEPS IS ALWAYS GENERATED-SHAPED. `kind` says where the ROLL's
      // material comes from, and in this form the grid is the material
      // whatever the roll happens to hold — which is exactly what `notesFor`
      // decides, so the gate has to agree or the card contradicts the engine.
      // It did: on a layer whose roll was recorded, EVERY pattern control was
      // greyed and the tab announced "this one is Fixed" while the grid beside
      // it was plainly playing. The four `kind:recorded` rows it hides here
      // (Transpose, Follows changes, and two hints) are all note-list
      // questions, so hiding them is right; `Plays` carries no gate and stays.
      kind: (V2.formOf(L) === 'steps') ? 'live' : p.kind,
      voice: (L.instrument && L.instrument.voice) || 'synth',
      tg: (L.tg && L.tg.on) ? 'on' : 'off',   // the gate's own rows follow it
      spat: (L.spat && L.spat.on) ? 'on' : 'off',
      rhythm: (p.rhythm && p.rhythm.kind) || '',
      // THE MATERIAL'S FORM. What it scopes is deliberately small — the grid's
      // own rows and the note list's own — because every pitch rule, shape and
      // variance knob means the same thing in both.
      form: V2.formOf(L),
      pitch: (p.pitch && p.pitch.kind) || '',
      clock: (p.clock === 'free') ? 'free' : 'bars',
      // The KIT KIND — the synth-kit editor applies to the generated kit only.
      kit: ((L.instrument && L.instrument.kit) === 'synth') ? 'synth' : 'sample',
      // A NETWORK source has a subject, a budget and a Fetch; pasted text has
      // none of those — the Words box IS the source.
      src: (L.source && L.source !== 'paste') ? 'net' : 'paste',
      // `on:delay` — an effect's OWN parameters are meaningless while the
      // effect is at mix 0, and eleven such rows are what made this card's FX
      // group a wall. Multi-valued so one clause covers a family:
      // `on:delay,dist` shows for either. Note `dryKill` engages a stage at
      // mix 0 deliberately (the documented Dry-kill contract), so it counts.
      on: '',
    };
    now.on = ['delay', 'dist', 'chorus', 'phaser', 'autopan', 'glitch']
      .filter(k => { const f = fx(L, k); return num(f.mix, 0) > 0 || !!f.dryKill; });
    // Pitch echo engages on its own switch, not a mix — it spawns notes rather
    // than processing a signal.
    if (L.pecho && L.pecho.on) now.on.push('pecho');
    // The select has no 'drawn' option (it is internal state, not a choice), and
    // a select whose value matches no option renders BLANK — so point it at the
    // generator. Re-picking that same entry then fires no `input`, which is what
    // keeps it from silently wiping an edited pattern.
    // querySelectorAll, not querySelector: the Generated panel carries a
    // SECOND copy of this select now, and syncing only the first would leave
    // the panel's blank on a drawn part \u2014 which is the exact state that
    // invites the pick that drifts the rules.
    card.querySelectorAll('[data-f="part.rhythm.kind"]').forEach((rsel) => {
      const want = rhythmShown(now.rhythm); if (rsel.value !== want) rsel.value = want;
    });
    card.querySelectorAll('[data-v2when]').forEach(row => {
      // Clauses are judged SEPARATELY now, because two kinds of gating hide
      // for two different reasons: an ALTERNATIVE (rhythm:euclid on a pulse
      // part, voice:synth on a kit) is simply not this layer's control and
      // hides; but a row whose ONLY failing clause is `kind:live` on a Fixed
      // part is a control that WOULD apply if the part were Generated — hiding
      // it read as "where did the rhythm params go" (twice), so it GREYS
      // instead: visible, inert (`.v2-rowna`), teaching what it is for.
      let kindOk = true, othersOk = true, wantsLive = false;
      String(row.getAttribute('data-v2when')).split(';').forEach(cl => {
        const [piece, vals] = cl.split(':');
        const want = String(vals || '').split(',');
        const have = now[piece];
        // A piece may hold ONE value (kind, voice, rhythm…) or a SET of them
        // (`on`, the engaged FX). One clause form, both shapes.
        const pass = Array.isArray(have) ? have.some(v => want.indexOf(v) >= 0)
                                         : want.indexOf(have) >= 0;
        if (piece === 'kind') { kindOk = pass; wantsLive = want.indexOf('live') >= 0; }
        else if (!pass) othersOk = false;
      });
      // ONLY PARAMETER ROWS grey — a gated BUTTON (the take bar's 🎲 New
      // take, kind:live) must still HIDE: greying leaked it onto recorded
      // parts beside "Replace with a new take", two dice for one action
      // (reported), and the dim styling is scoped to .ambient-ctrl anyway.
      const na = othersOk && !kindOk && wantsLive && now.kind === 'recorded' &&
        (row.classList.contains('ambient-ctrl') || row.classList.contains('v2-mini'));
      row.style.display = (othersOk && kindOk) || na ? '' : 'none';
      row.classList.toggle('v2-rowna', na);
    });
    // A SOLOED LAYER MUST LOOK SOLOED. Monitoring state that can vanish while
    // its widget keeps state is the documented drum-solo bug; here solo lives in
    // the ⋯ menu, so the card itself has to say so.
    card.classList.toggle('v2-soloed', !!L.solo);
    // COMPOSING = the docked Grid editor is open on THIS layer. On a phone the
    // sheet goes full-screen for it and pins ✓ Done / ⬇ To bank / ✕ Cancel to
    // the bottom, so the editor fits and its actions are never scrolled away.
    let composing = false;
    try {
      composing = (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit &&
        _bloomGridEdit.key === 'v2:' + (L.id | 0));
    } catch (e) {}
    card.classList.toggle('v2-composing', !!composing);
    // WHY THIS LAYER IS LIVE, said where its switches are. From `liveness()`,
    // the same predicate the drawing's readout uses, so the two can never
    // disagree — and it names the two reasons the LAYER does not own (a mask
    // left at a probability, and the changes moving underneath it) with where
    // to change them, rather than growing a second copy of an area control.
    try {
      const ll = card.querySelector('.v2-liveline');
      if (ll) {
        let cfgL = null; try { cfgL = _cfgOf(); } catch (e) {}
        let lv = { live: false, why: [] };
        try { lv = V2.liveness(L, cfgL) || lv; }
        catch (e) { try { console.warn('[v2] liveness failed', e && e.message); } catch (x) {} }
        const txt = lv.live
          ? ('LIVE \u2014 ' + lv.why.join(' \u00b7 ') + '.' +
             ((/probability/.test(lv.why.join(' ')) || /changes|Salt|alternates/.test(lv.why.join(' ')))
               ? ' The reasons above that are not switches here belong to the arrangement \u2014 \u25a6 Passes for a probability, \ud83e\uddc2 Salt and the changes for the rest.'
               : ''))
          : 'STATIC \u2014 every pass is identical. Nothing else on this card changes that: ' +
            'Rests, Ghosts, Len vary, Rhythm var and Scatter all shape the material ONCE, ' +
            'off the take, and give the same result every cycle.';
        if (ll.textContent !== txt) ll.textContent = txt;
      }
    } catch (e) {}
    const sum = card.querySelector('.v2-summary');
    if (sum) {
      sum.textContent = p.kind === 'recorded'
        ? ('\u2744 ' + (p.notes || []).length + ' notes \u00b7 ' + p.bars + ' bars')
        : ((now.rhythm === 'drawn' ? 'pattern\u270e' : now.rhythm) + ' \u00b7 ' + now.pitch + ' \u00b7 ' + p.bars + ' bars');
    }
    // GROUP SUMMARIES. A folded group is one line, so that line has to say
    // what is engaged inside it — the drum-solo lesson: state that can vanish
    // while its widget keeps state gets reported as a bug. Written on every
    // gate pass, so an edit inside a group updates the head above it.
    const eng = now.on;
    // SEVEN BUTTONS MUST SAY WHAT TWELVE DID. Folding groups costs summaries —
    // the card's heads are a dashboard, and five of them just went away — so
    // the survivors absorb what their new rows carry.
    const onOf = (pairs) => pairs.filter(f2 => num(L[f2[0]], 0) > 0).map(f2 => f2[1]);
    const sums = {
      Instrument: (() => {
        const i2 = L.instrument || {};
        // NAME THE KIT, don't print its id — the generated kit's id is literally
        // 'synth', so a drum layer summarised as "synth · A 400" and read as a
        // synth layer. The label is taken up to its em dash ("Synth kit —
        // generated" → "Synth kit"), which is what the picker calls it.
        const kitName = (id) => {
          try {
            const hit = kitOptions(id).find(o => o[0] === id);
            return hit ? String(hit[1]).split('\u2014')[0].trim() : (id || 'kit');
          } catch (e) { return id || 'kit'; }
        };
        const head = i2.voice === 'kit' ? kitName(i2.kit)
                   : i2.voice === 'speech' ? 'speech'
                   : (i2.tone || 'default');
        const bits = ['A ' + (i2.attack | 0) + ' \u00b7 R ' + (i2.release | 0)];
        if (num(L.cutoff, 100) < 100) bits.push('filter ' + num(L.cutoff, 100));
        if (num(L.portamento, 0) > 0) bits.push('glide');
        if (num(L.voiceTrim, 0) !== 0) bits.push('trim ' + num(L.voiceTrim, 0) + 'dB');
        return head + ' \u00b7 ' + bits.join(' \u00b7 ');
      })(),
      // Rhythm folded into Content, so its summary did too — the head keeps
      // carrying what its rows now hold (the dashboard rule).
      Content: (() => {
        const head = (p.kind === 'recorded' ? (p.notes || []).length + ' notes' : 'live') +
          ' \u00b7 ' + (p.clock === 'free' ? (p.ms || 2000) + 'ms free' : p.bars + ' bars');
        const rh = (now.voice === 'kit')
          ? ((p.rhythm.lanes || []).reduce((a4, row) => a4 + (row || []).reduce((x, c3) => x + (c3 ? 1 : 0), 0), 0) + ' hits')
          : (p.kind === 'recorded' ? '' : (now.rhythm === 'drawn' ? 'drawn' : now.rhythm) + ' \u00b7 ' + p.rhythm.steps + ' steps');
        const feel = onOf([['swing', 'swing'], ['accent', 'accent'], ['humanize', 'humanize']]);
        if (L.tight) feel.push('tight');
        return head + (rh ? ' \u00b7 ' + rh : '') + (feel.length ? ' \u00b7 ' + feel.join(' \u00b7 ') : '') +
          ((typeof L.when === 'string' && L.when && L.when !== 'always') ? ' \u00b7 not every cycle' : '');
      })(),
      Pitch: now.pitch +
             ((L.part.pitch.chordMode) ? ' \u00b7 ' + L.part.pitch.chordMode : '') +
             (((L.part.pitch.harm || []).length) ? ' \u00b7 +' + L.part.pitch.harm.length + ' harmony' : '') +
             (num(L.proximity, 0) > 0 ? ' \u00b7 close' : ''),
      Shape: (() => {
        const bits = [];
        if ((L.strum | 0) > 0) bits.push('strum ' + (L.strum | 0));
        if (p.shape && p.shape.lenRatio !== 100) bits.push('len ' + p.shape.lenRatio + '%');
        bits.push(...onOf([['restProb', 'rests'], ['ghosts', 'ghosts'],
                           ['lenVary', 'len vary'], ['velVar', 'vel var']]));
        return bits.length ? bits.join(' \u00b7 ') : 'struck';
      })(),
      Mix: (() => {
        const bits = ['level ' + num(L.level, 70)];
        if (num(L.revSend, 0) > 0) bits.push('reverb ' + num(L.revSend, 0));
        if (L.bus && L.bus !== 'a') bits.push('bus ' + String(L.bus).toUpperCase());
        if (num(L.space, 0) !== 0) bits.push('width ' + num(L.space, 0));
        if (now.spat === 'on') bits.push('moving');
        const m = L.mod || {};
        const mods = ['vca', 'vco', 'vcf'].filter(t => ((m[t] || {}).depth | 0) > 0);
        if (mods.length) bits.push(mods.join('+'));
        return bits.join(' \u00b7 ');
      })(),
      FX: (eng.length ? eng.join(' \u00b7 ') : '') +
          (now.tg === 'on' ? (eng.length ? ' \u00b7 ' : '') + 'chop' : '') +
          (L.wetOnly ? ((eng.length || now.tg === 'on') ? ' \u00b7 ' : '') + 'wet only' : '') ||
          'none',
    };
    card.querySelectorAll('.v2-grpsum').forEach(el => {
      const g = el.getAttribute('data-grp');
      const txt = sums[g] || '';
      // Only while FOLDED — inside an open group the controls say it themselves,
      // and a head repeating them is noise.
      const open = !!(el.closest('.ambient-grp') || {}).classList
        && el.closest('.ambient-grp').classList.contains('open');
      const want2 = open ? '' : txt;
      if (el.textContent !== want2) el.textContent = want2;
    });
    // READOUTS. These change on a VALUE edit, which deliberately does not
    // rebuild the card (an innerHTML rewrite kills the control under the
    // finger), so they are written here rather than baked into the markup.
    // The Notes button is a live READOUT of the resolved source — under an
    // area progression it says so and greys, which is the only honest thing a
    // per-layer source control can do while the area is overriding it.
    // The mod sliders are v1's, built by id and NOT `.v2-f`, so the gate has to
    // put stored values back into them — otherwise a rebuild shows a matrix at
    // zero while the engine is modulating.
    {
      const m = L.mod || {};
      ['vca', 'vco', 'vcf'].forEach((t) => {
        const mt = m[t] || {};
        ['depth', 'rate'].forEach((k) => {
          const e2 = document.getElementById('ambient-v2-' + L.id + '-mod-' + t + '-' + k);
          if (!e2) return;
          const v = (k === 'depth') ? (mt.depth | 0) : (Number.isFinite(mt.rate) ? mt.rate : e2.value);
          if (String(e2.value) !== String(v)) {
            e2.value = v;
            const rd = e2.parentElement && e2.parentElement.querySelector('.ambient-sl-v');
            if (rd) rd.textContent = v;
          }
        });
        const sh = document.getElementById('ambient-v2-' + L.id + '-mod-' + t + '-shape');
        if (sh && mt.shape && sh.value !== mt.shape) sh.value = mt.shape;
      });
      const sy2 = document.getElementById('ambient-v2-' + L.id + '-mod-sync');
      if (sy2) sy2.value = (m.sync === 'sync') ? 'sync' : 'free';
    }
    const nb = card.querySelector('.ambient-notes-btn');
    if (nb) {
      let locked = false;
      try { locked = !!_ambGlobalProg(); } catch (e) {}
      try { nb.textContent = _ambNotesLabel(_ambNotesOf(L)); } catch (e) {}
      nb.classList.toggle('ambient-src-locked', locked);
      nb.title = locked
        ? 'The area progression is on, so every layer follows it. Turn Progression off to choose a source per layer.'
        : 'Where this layer takes its notes from';
    }
    // the Material hint is owned by `matSync` (one writer — provenance + the
    // live rules), called here so a gate pass repaints it like every summary
    try { matSync(card, L); } catch (e) {}
    const ch = card.querySelector('.v2-cellhint');
    if (ch) {
      const edited = now.rhythm === 'drawn';
      const on = viewCells(L).reduce((a, c) => a + (c ? 1 : 0), 0);
      // An empty grid is silence, and silence is indistinguishable from a broken
      // control unless it says so.
      ch.textContent = !on ? 'empty \u2014 this layer is silent. Raise Pulses, or tap cells.'
        : edited ? (on + ' of ' + p.rhythm.steps + ' \u00b7 edited \u2014 Pulses/Steps/Rotate redraw it, \u21bb restores it')
                 : (on + ' of ' + p.rhythm.steps + ' from Pulses/Rotate \u2014 tap a cell to edit it');
      ch.style.color = on ? '' : '#f6ad55';
    }
    // \u21bb only means something once there is an edit to undo.
    const lh = card.querySelector('.v2-lanehint');
    if (lh) {
      const lanes = (p.rhythm.lanes || []);
      const hits = lanes.reduce((a2, row) => a2 + (row || []).reduce((x, c2) => x + (c2 ? 1 : 0), 0), 0);
      lh.textContent = hits ? (hits + ' hits across ' + V2.LANES + ' lanes — tap to edit')
                            : 'empty — no drums yet. Tap a cell.';
      lh.style.color = hits ? '' : '#f6ad55';
    }
    const th = card.querySelector('.v2-tghint');
    if (th) {
      const tg = L.tg || {}, pat = tg.pattern || [];
      const on2 = pat.reduce((a2, x) => a2 + (x ? 1 : 0), 0);
      th.textContent = on2 ? (on2 + ' of ' + (tg.steps | 0) + ' sound — tap to edit')
                           : 'every step cut — the layer is silent';
      th.style.color = on2 ? '' : '#f6ad55';
    }
    const sc = card.querySelector('.v2-speechcount');
    if (sc && now.voice === 'speech') {
      let st3 = { lines: 0, ready: 0 };
      try { st3 = V2.speechStat(_engOf(), L); } catch (e) {}
      // An unrendered line is SILENT, so the count is the only honest thing to
      // say before a render — "nothing written yet" is a state, not an error.
      sc.textContent = !st3.lines ? 'no words yet — type some above'
        : (st3.ready >= st3.lines ? ('\u2713 all ' + st3.lines + ' written — press play')
                                  : (st3.ready + ' of ' + st3.lines + ' written; the rest stay silent'));
      sc.style.color = (st3.lines && st3.ready < st3.lines) ? '#f6ad55' : '';
    }
    const rg = card.querySelector('.v2-regen');
    if (rg) rg.style.display = (now.rhythm === 'drawn') ? '' : 'none';
    // THE COMPOSE DOCK is shown only while THIS layer has the session. The slot
    // sets `display:block` from a class, which outranks the UA's `[hidden]` rule
    // (the documented trap \u2014 `el.hidden = true` alone hid nothing until
    // `.ambient-seedgrid-slot[hidden]` was added), so `hidden` is honoured.
    // THE PART DRAWING repaints here because `applyGate` is the one pass that
    // runs after every render AND every control change — the two moments the
    // part can have moved. Cheap: one `notesFor` call over a single cycle.
    try { drawPartViz(card, L, _cardE); } catch (e) {}
    const dock = card.querySelector('.v2-dock');
    if (dock) {
      let open = false;
      try { open = (typeof _bloomGridEdit !== 'undefined') && !!_bloomGridEdit && _bloomGridEdit.key === ('v2:' + L.id); } catch (e) {}
      dock.hidden = !open;
      const cb = card.querySelector('.v2-compose');
      // NOT `.on` — that class means "this material made the notes", and a
      // session is a MODE. Two writers of one class is why ✎ Composed stayed
      // lit on a part Groundwork had made.
      if (cb) cb.classList.toggle('v2-sess', open);
    }
    // GROUP BUTTONS: an ACCENT on any treatment group whose summary is not its
    // neutral (the folded card then says at a glance which groups this layer
    // actually uses). The core groups are always in use, so they stay plain.
    // the accent marks a group whose summary is NOT its neutral, so the folded
    // card says at a glance which groups this layer actually uses
    // …and it lands on the SECTION TABS now that the button grid is gone, so
    // "which groups does this layer actually use" survives the move; each tab
    // also carries its section's summary as its tooltip.
    const NEUT = { FX: 'none', Shape: 'struck' };
    card.querySelectorAll('.v2-gototab').forEach(b2 => {
      const g2 = b2.getAttribute('data-goto');
      if (g2 in NEUT) b2.classList.toggle('v2-live', (sums[g2] || '') !== NEUT[g2]);
      const sm = sums[g2] || '';
      if (b2.getAttribute('title') !== (g2 + (sm ? ' \u2014 ' + sm : ''))) {
        b2.setAttribute('title', g2 + (sm ? ' \u2014 ' + sm : ''));
      }
    });
    // The editor re-syncs its tabs on every gate pass — the gate can hide the
    // active tab's rows from under it (switch Voice with Tone open).
    if (popWrapOf(card)) {
      try { popSync(card, L); } catch (e) {}
    }
  }

  // Rewrite ONLY the cell container. The whole card must not be rebuilt on a
  // value edit (that destroys the control under the finger — the documented
  // trap), and a cell tap must not rebuild it either, or the next tap in a
  // sequence of taps lands on a detached node.
  function redrawCells(card, L) {
    const host = card.querySelector('.v2-cells'); if (!host) return;
    const r = L.part.rhythm || {}, st = Math.max(1, r.steps | 0), cells = viewCells(L);
    if (host.children.length !== st) {
      const tmp = document.createElement('div');
      tmp.innerHTML = cellsHtml(L);
      host.replaceWith(tmp.firstChild);
      return;
    }
    for (let i = 0; i < st; i++) {
      const c = host.children[i]; if (!c) continue;
      c.classList.toggle('on', !!cells[i]);
      c.setAttribute('aria-pressed', cells[i] ? 'true' : 'false');
    }
  }

  // ── THE GROUP SHEET ─────────────────────────────────────────────────────
  // A group button opens its rows in a bottom sheet. The sheet is a CHILD OF
  // THE CARD, deliberately: `closest('.v2-layer')` delegation, applyGate's
  // card-scoped queries, and v1's panel-host-delegated controls (key override,
  // tone cycle, synth kit — all resolved through `_ambCardKey`/`data-kokey`)
  // all keep working with zero rewiring, where a body-attached overlay would
  // orphan every one of them (the documented Home-row lesson). The rows are
  // MOVED in and moved back on close, never re-created — re-rendering would
  // mint duplicate ids and detach the id-bound mod wiring.
  // ONE EDITOR PER CARD, EMBEDDED IN THE LAYER BODY. It was a centred sheet
  // opened from a grid of six group buttons — and once the sheet's own head
  // carried those same six sections as a full row, the grid was a second
  // navigator for one thing. The sheet moved into the body and the buttons
  // came down with it. So the state is PER LAYER now, not the one-at-a-time
  // singleton a modal could get away with: two expanded cards each show their
  // own editor, and a global would have shut one to open the other.
  const POPS = new Map();          // layer id -> { grp, tab }
  const popIdOf = (card) => card ? (card.getAttribute('data-v2id') | 0) : -1;
  const popStOf = (card) => POPS.get(popIdOf(card)) || null;
  const POP_DEF = 'Content';       // the section a card opens on — it holds the drawing
  // WHICH LAYER HAS THE GENERATED POPOVER OPEN. Beside `POP` and for the same
  // reason: `V2.render` rebuilds the card and would drop the class, so the
  // rebuild re-applies it — a knob inside must not slam the panel shut. In the
  // UI IIFE, because that is where `render` and the click delegation are; the
  // file is TWO IIFEs and they share nothing but `window._v2`.
  let GENPOP = null;
  // WHICH BARS' RULES ARE OPEN — `{ id, bars: [..] }`, transient like every
  // other view state here (a field on the layer would be serialised by
  // `persistWorkspace`, the `_soloLane` trap).
  let BARPOP = null;
  // WHAT IS SOUNDING FOR THIS LAYER IS NOW THE OLD TAKE. One definition, because
  // three presses supersede audio the same way (🎲 New take, 🎲 Roll again, and
  // dropping a bar's own rules) and three copies is how they come to differ.
  function v2TakeHeard(E, L) {
    const k2 = 'v2:' + (L.id | 0);
    try {
      if (E.timer && typeof cancelBloomFutureVoices === 'function' && typeof Tone !== 'undefined') {
        cancelBloomFutureVoices(k2, Tone.now());
      }
    } catch (e) {}
    try { if (E._v2Phase) delete E._v2Phase[k2]; } catch (e) {}   // re-anchor next tick
    // A RUNNING PREVIEW is the take you are listening to, so it follows the
    // press. This does not START audio (the documented rule) — it replaces
    // audio the press just superseded.
    try { if (V2.previewing(L)) { V2.previewKill(E, L); V2.preview(E, L); } } catch (e) {}
  }

  // ── THE ROWS ONE BAR'S RULES OFFER ──────────────────────────────────────
  // The generated settings that shape MATERIAL, each with the rhythm/pitch
  // kinds it applies to — the ⚙ Generated panel's own gating, expressed as a
  // predicate rather than a `data-v2when` string because this panel is built
  // fresh per open and is NOT swept by `applyGate` (which syncs from the
  // LAYER's values and would stomp a bar's own the moment it ran).
  const BARROWS = [
    { g: 'rhythm', f: 'kind', lab: 'Rhythm', sel: () => RHYTHM_OPTS, hint: 'when notes happen' },
    { g: 'rhythm', f: 'pulses', lab: 'How many', sl: 1, hi: (r) => Math.min(64, Math.max(2, (r.rhythm.steps | 0) || 16)),
      when: (r) => r.rhythm.kind === 'euclid' || r.rhythm.kind === 'drawn', hint: 'onsets in the bar' },
    { g: 'rhythm', f: 'steps', lab: 'Steps', st: [2, 64],
      when: (r) => r.rhythm.kind === 'euclid' || r.rhythm.kind === 'drawn', hint: 'how many steps the cycle is cut into' },
    { g: 'rhythm', f: 'rotate', lab: 'Push', st: [0, 63],
      when: (r) => r.rhythm.kind === 'euclid' || r.rhythm.kind === 'drawn', hint: 'shift the pattern along' },
    { g: 'rhythm', f: 'n', lab: 'How many', sl: 1, hi: () => 32,
      when: (r) => r.rhythm.kind === 'pulse', hint: 'onsets in the cycle' },
    { g: 'rhythm', f: 'chance', lab: 'Chance', sl: 0, hi: () => 100,
      when: (r) => r.rhythm.kind === 'chance', hint: 'how often a step sounds' },
    { g: 'rhythm', f: 'syncop', lab: 'Syncopate', sl: 0, hi: () => 100,
      when: (r) => r.rhythm.kind === 'chance', hint: 'straight \u2192 offbeat' },
    { g: 'pitch', f: 'kind', lab: 'Pitch', sel: () => PITCH_OPTS, hint: 'what each onset plays' },
    { g: 'pitch', f: 'voices', lab: 'Notes at once', st: [1, 9],
      when: (r) => /^(chord|stack|mixed)$/.test(r.pitch.kind), hint: 'how many notes each chord holds' },
    { g: 'pitch', f: 'mix', lab: 'Chords vs notes', sl: 0, hi: () => 100,
      when: (r) => r.pitch.kind === 'mixed', hint: 'all single notes \u2192 all chords' },
    { g: 'pitch', f: 'span', lab: 'Range', st: [1, 12],
      when: (r) => /^(walk|mixed)$/.test(r.pitch.kind), hint: 'how far the line wanders' },
    { g: 'pitch', f: 'contour', lab: 'Contour', sl: -100, hi: () => 100,
      when: (r) => r.pitch.kind === 'walk', hint: 'fall \u2192 rise' },
    { g: 'pitch', f: 'lines', lab: 'Lines', st: [1, 6],
      when: (r) => /^(walk|chance)$/.test(r.pitch.kind), hint: 'independent melodies at once' },
    { g: 'pitch', f: 'stutter', lab: 'Repeat', sl: 0, hi: () => 100,
      when: (r) => r.pitch.kind === 'walk', hint: 'how often it repeats a note' },
    { g: 'pitch', f: 'dir', lab: 'Direction',
      sel: () => [['up', 'Up'], ['down', 'Down'], ['updown', 'Up & down']],
      when: (r) => r.pitch.kind === 'series', hint: 'which way the sweep runs' },
    { g: 'pitch', f: 'octaves', lab: 'Octaves', st: [1, 4],
      when: (r) => r.pitch.kind === 'series', hint: 'how many octaves it climbs' },
    { g: 'pitch', f: 'randomness', lab: 'Scatter', sl: 0, hi: () => 100,
      when: (r) => r.pitch.kind === 'series', hint: 'ordered \u2192 jumps about' },
    { g: 'shape', f: 'lenRatio', lab: 'Note length', sl: 5, hi: () => 100, hint: 'of the slot' },
  ];
  // The DEFAULT a field falls back to when neither the bar nor the part states
  // one — the same numbers the ⚙ Generated panel opens at, so the two surfaces
  // never disagree about what "unset" sounds like.
  const BARDEF = { pulses: 5, steps: 16, rotate: 0, n: 4, chance: 50, syncop: 0,
                   voices: 3, mix: 50, span: 3, contour: 0, lines: 1, stutter: 0,
                   octaves: 1, randomness: 0, lenRatio: 90 };
  // BUILD the open bar's rows. Rebuilt only when the VISIBLE SET changes (a
  // kind moved) — rewriting the markup on every slider input would destroy the
  // control under the finger, the documented repaint trap; a slider commit
  // repaints its own readout and nothing else.
  function barRowsHtml(L, bars, rules) {
    const id = L.id | 0;
    const shown = BARROWS.filter((row) => !row.when || row.when(rules));
    return shown.map((row) => {
      const path = row.g + '.' + row.f;
      const eid = 'v2-bar-' + id + '-' + row.g + '-' + row.f;
      const v = barVal(rules, row);
      // OWN vs the part's — a value this bar states must not look like one it
      // inherits (the absent-is-inherit rule the mask cells follow)
      const own = !!(L.part.ruleb && bars.some((k2) => {
        const o = L.part.ruleb[k2]; return o && o[row.g] && o[row.g][row.f] !== undefined; }));
      const mark = own ? ' v2-barown' : '';
      let h;
      if (row.sel) {
        h = '<div class="ambient-ctrl v2-barrow' + mark + '"><label for="' + eid + '">' + esc(row.lab) + '</label>' +
          '<select class="ambient-select v2-bf" id="' + eid + '" data-bf="' + path + '">' +
          row.sel().map(([val, lab]) =>
            '<option value="' + esc(val) + '"' + (val === v ? ' selected' : '') + '>' + esc(lab) + '</option>').join('') +
          '</select><span class="ambient-hint">' + esc(own ? 'set here' : row.hint) + '</span></div>';
      } else if (row.st) {
        h = (typeof _ambStep === 'function')
          ? _ambStep(row.lab, eid, row.st[0], row.st[1], v, own ? 'set here' : row.hint)
              .replace('class="ambient-step-inp"', 'class="ambient-step-inp v2-bf" data-bf="' + path + '"')
              .replace('class="ambient-ctrl ambient-ctrl-step"', 'class="ambient-ctrl ambient-ctrl-step v2-barrow' + mark + '"')
          : '';
      } else {
        h = (typeof _ambSl === 'function')
          ? _ambSl(row.lab, eid, row.sl, row.hi(rules), v, own ? 'set here' : row.hint)
              .replace('class="ambient-sl"', 'class="ambient-sl v2-bf" data-bf="' + path + '"')
              .replace('class="ambient-ctrl"', 'class="ambient-ctrl v2-barrow' + mark + '"')
          : '';
      }
      return h;
    }).join('');
  }
  // THE VISIBLE SET, as a signature — what decides whether a commit needs a
  // rebuild or just a readout repaint.
  const barShownSig = (rules) =>
    BARROWS.filter((row) => !row.when || row.when(rules)).map((row) => row.g + '.' + row.f).join(',') +
    '|' + rules.rhythm.steps;
  function barpopSync(card, L) {
    if (!BARPOP || BARPOP.id !== (L.id | 0)) { card.classList.remove('v2-baropen'); return; }
    const bars = BARPOP.bars.slice().sort((a, b) => { const A = V2.regParse(a), B = V2.regParse(b); return (A ? A.a : 0) - (B ? B.a : 0); });
    const rows = card.querySelector('.v2-barrows'); if (!rows) return;
    // ONE REGION'S rules are shown; with several selected the FIRST is the
    // face and every edit writes to all of them (which is what the title says).
    const rules = V2.barRules(L.part, bars[0]);
    const sig = barShownSig(rules);
    if (rows._sig !== sig || rows._bars !== bars.join(',')) {
      rows.innerHTML = barRowsHtml(L, bars, rules);
      rows._sig = sig; rows._bars = bars.join(',');
    } else {
      // NO REBUILD — but the row must still say whether the value is this
      // bar's OWN or the part's, because that flips on the very commit a
      // rebuild would have shown it on (a setting you just made that still
      // reads "inherited" is state you cannot see — the drum-solo rule).
      rows.querySelectorAll('.v2-bf').forEach((el) => {
        const row = el.closest('.ambient-ctrl'); if (!row) return;
        const path = String(el.getAttribute('data-bf') || '').split('.');
        const own = path.length === 2 && !!(L.part.ruleb && bars.some((k2) => {
          const o = L.part.ruleb[k2]; return o && o[path[0]] && o[path[0]][path[1]] !== undefined; }));
        row.classList.toggle('v2-barown', own);
        const rd = row.querySelector('.ambient-sl-v');
        if (rd && typeof _ambSlReadout === 'function') rd.textContent = _ambSlReadout(el.id, el.value);
        // the hint column is the row's own "inherited / this bar's" line, and
        // `.ambient-sl-v` IS an `.ambient-hint` — so never overwrite that one
        const hs = [...row.querySelectorAll('.ambient-hint')].filter((x) => x !== rd);
        const hint = hs[hs.length - 1];
        if (hint) {
          const spec = BARROWS.find((r2) => r2.g === path[0] && r2.f === path[1]);
          const txt = own ? 'set here' : ((spec && spec.hint) || '');
          if (hint.textContent !== txt) hint.textContent = txt;
        }
      });
    }
    const ttl = card.querySelector('.v2-bartitle');
    // NAME WHAT WAS PRESSED. `BARPOP.nm` carries the selection's own label
    // ("F♯m"), so the panel says the change rather than the bars underneath it.
    const lab = BARPOP.nm || bars.map((k2) => V2.regLabel(k2)).join(' + ');
    if (ttl && ttl.textContent !== lab) ttl.textContent = lab;
    const says = card.querySelector('.v2-barsays');
    if (says) {
      const own = bars.some((k2) => L.part.ruleb && L.part.ruleb[k2]);
      const t2 = own
        ? (lab + ' generates by its OWN settings \u2014 everything else in the part keeps the part\u2019s. ' +
           'A value set back to the part\u2019s is dropped, so only what differs is stored.')
        : (lab + ' takes the part\u2019s settings. Change one and it becomes this stretch\u2019s own \u2014 the rest of the part is untouched.');
      if (says.textContent !== t2) says.textContent = t2;
    }
    card.classList.add('v2-baropen');
  }
  // ONE FIELD OF ONE BAR'S RULES. Live, like every other control on this card
  // — and live here means AUDIBLE IMMEDIATELY, because the bar's material is
  // re-derived from these rules rather than stored: changing Pitch redraws the
  // bar without any roll at all. Only what DIFFERS from the part is stored
  // (`setBarRule` deletes a value set back), so "the part's rules" needs no
  // second representation.
  function barInput(E, el) {
    if (!BARPOP) return false;
    const card = el.closest('.v2-layer'); if (!card) return false;
    const L = _ambLayerByKey && _ambLayerByKey(E, 'v2:' + BARPOP.id);
    if (!L || !L.part || (L.id | 0) !== BARPOP.id) return false;
    const path = String(el.getAttribute('data-bf') || '').split('.');
    if (path.length !== 2) return false;
    const isSel = el.tagName === 'SELECT';
    const v = isSel ? el.value : parseInt(el.value, 10);
    if (!V2.setBarRule(L, BARPOP.bars, path[0], path[1], v)) return true;
    try { E.getCfg(); } catch (e) {}
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    try { drawPartViz(card, L, E); } catch (e) {}
    // A KIND changes which rows apply, so the panel is rebuilt — and ONLY
    // then: rewriting the markup on a slider's every input event destroys the
    // control under the finger (the documented repaint trap).
    try { barpopSync(card, L); } catch (e) {}
    try { v2TakeHeard(E, L); } catch (e) {}
    return true;
  }
  const barVal = (rules, row) => {
    const v = (rules[row.g] || {})[row.f];
    if (row.sel) return typeof v === 'string' && v ? v : (row.sel()[0] || [''])[0];
    return Number.isFinite(v) ? v : num(BARDEF[row.f], 0);
  };
  function popWrapOf(card) { return card.querySelector('.v2-pop-wrap'); }
  function popClose(card) {
    const wrap = card && popWrapOf(card);
    const st0 = popStOf(card);
    if (wrap) {
      const body = wrap.querySelector('.ambient-grp-body');
      // put the lifted drawing back at the top of the body FIRST, so it travels
      // home with it — otherwise it is removed with the wrap and the card's own
      // copy of the group is left without one.
      try {
        const viz = wrap.querySelector(':scope > .v2-pop > .v2-partviz');
        if (viz && body) body.insertBefore(viz, body.firstChild);
      } catch (e) {}
      const g = st0 && card.querySelector('.ambient-grp[data-v2grp="' + st0.grp + '"]');
      if (body && g) g.appendChild(body);
      wrap.remove();
    }
    POPS.delete(popIdOf(card));
  }
  // The arrangement's parts, as selector options. `_ambGridRanges` is the same
  // enumerator the Passes grid draws from (a part-less progression is one
  // range), so the selector and the clock cannot disagree about what exists.
  // The stored value is ALWAYS among the options — a <select> whose value
  // matches no option silently shows the first one (the documented trap).
  function partRangesOf(E) {
    let out = [];
    try {
      const cfg = E.getCfg();
      const rgs = (typeof _ambGridRanges === 'function') ? (_ambGridRanges(cfg) || []) : [];
      out = rgs.map((rg) => {
        const pi = (rg && Number.isFinite(rg.pi)) ? (rg.pi | 0) : 0;
        let bars = 0;
        try { bars = (typeof _ambLenPartBars === 'function') ? +_ambLenPartBars(cfg, pi) : 0; } catch (e) {}
        let nm = 'Part ' + (pi + 1);
        try { if (typeof _ambPartLabel === 'function') nm = _ambPartLabel(cfg, pi); } catch (e) {}
        return { pi, bars, nm };
      });
    } catch (e) {}
    return out;
  }
  // (`partChoiceOpts` lived here and built the head's part <select>. That
  // chooser is GONE — the ⇶ Part strip above the layers is the one place a
  // part is made current — and the builder went with it rather than being left
  // as machinery nothing calls, which is how a retired surface comes back.)

  // ── SYNC TO PART — match the layer's cycle to one pass of the changes ────
  // "I created a 5-chord part and Content did not update": a part's bars are
  // its own, and nothing ever re-lengths them when the changes grow. This is
  // the explicit door — a small confirm with the two real questions: how do
  // the BARS come along (stretch the notes, or keep their tempo and fill), and
  // what happens to the NOTES (keep them as-is, or follow the changes as they
  // play). Both answers are EXISTING machinery — `applyBarsMode` and
  // `L.harmony` — so the dialog decides, it does not implement.
  function syncPartModal(E, card, L, onApply) {
    const cfg = E.getCfg(); const p = L.part;
    // THE TARGET IS THE PART THIS RECORD IS FOR (`L.partFor`), which the ⇶ Part
    // strip keeps equal to the part you are editing — so Sync does not ask
    // WHICH, it STATES it. With the per-part mode off the target is the played
    // changes themselves. There is no chooser beside this button any more, so
    // the dialog naming its target is the only thing that says where the
    // length is coming from: it leads with the part, in that part's own hue.
    let tgt = null;
    const rgs = partRangesOf(E).filter((x) => x.bars > 0);
    if (Number.isFinite(L.partFor)) tgt = rgs.find((x) => x.pi === (L.partFor | 0)) || null;
    if (!tgt && rgs.length === 1) tgt = rgs[0];
    if (!tgt) {
      let bars = 0;
      try { bars = (typeof _ambLenPartBars === 'function') ? +_ambLenPartBars(cfg, -1) : 0; } catch (e) {}
      if (!(bars > 0)) { try { showToast('No changes to sync to yet \u2014 add a progression first.', { ms: 3500 }); } catch (e) {} return; }
      tgt = { pi: -1, bars, nm: 'the changes' };
    }
    const bound = !!L.lenSync;
    const isRec = p.kind === 'recorded';
    const isFollow = (L.harmony === 'diatonic' || L.harmony === 'chordlock');
    const st = { len: (p.barsMode === 'fill') ? 'fill' : 'stretch',
                 notes: isFollow ? 'follow' : 'keep' };
    const fmt = (b2) => (Math.round(b2 * 100) / 100) + ' bar' + (b2 === 1 ? '' : 's');
    const ov = document.createElement('div');
    ov.className = 'sm-overlay';
    ov.style.setProperty('display', 'flex', 'important');   // body-attached — the view-mode hide rules
    const segs = (name, opts, cur) => '<span class="ambient-seg-row">' + opts.map(([v, lab, tip]) =>
      '<button type="button" class="ambient-seg v2-syncopt" data-q="' + name + '" data-v="' + v + '"' +
      (tip ? ' title="' + tip + '"' : '') + '>' + lab + '</button>').join('') + '</span>';
    const tgtAttr = (tgt.pi >= 0 && typeof _ambPartAttr === 'function') ? _ambPartAttr(tgt.pi) : '';
    ov.innerHTML = '<div class="sm-modal v2-sync-modal">' +
      '<div class="sm-title">\u21c4 Sync</div>' +
      // WHICH PART, said outright and in its own colour — the card no longer
      // carries a selector to read it off, so a dialog that only implied its
      // target would be asking you to take it on trust.
      '<div class="v2-sync-tgt"' + tgtAttr + '>' +
        (tgt.pi >= 0 ? 'Syncing this layer to <b>' + esc(tgt.nm) + '</b>'
                     : 'Syncing this layer to <b>the changes</b>') +
      '</div>' +
      (tgt.pi >= 0
        ? '<div class="ambient-hint v2-sync-which">That is the current part \u2014 pick another in the ' +
          '\u21f6 Part strip above the layers, then press \u21c4 Sync again.</div>'
        : '') +
      '<div class="ambient-hint v2-sync-now"></div>' +
      (bound
        ? '<div class="ambient-hint v2-sync-bound">\u27f2 This layer is already bound to the arrangement \u2014 its length follows the part by itself, so only the notes question applies.</div>'
        : '<div class="v2-sync-row"><label>Length</label>' +
            segs('len', [['stretch', 'Stretch', 'The same notes, spread across the new length'],
                         ['fill', 'Fill', 'Keep the notes at their own tempo \u2014 repeat or trim to the new length']], st.len) +
          '</div>') +
      (isRec
        ? '<div class="v2-sync-row"><label>Notes</label>' +
            segs('notes', [['keep', 'Keep as-is', 'The pitches stay exactly what they are'],
                           ['follow', 'Follow the changes', 'Re-harmonised over each chord as it plays']], st.notes) +
          '</div>'
        : '<div class="ambient-hint">A Generated part already follows the changes \u2014 only the length is asked.</div>') +
      '<div class="v2-sync-actions">' +
        '<button type="button" class="ambient-regen v2-syncgo">\u21c4 Sync</button>' +
        '<button type="button" class="ambient-regen v2-synccancel">Cancel</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    const paint = () => {
      const now = ov.querySelector('.v2-sync-now');
      if (now) now.textContent = 'One pass of ' + tgt.nm + ' is ' + fmt(tgt.bars) +
        ' \u2014 this layer is ' + fmt(+p.bars || 1) + '.';
      ov.querySelectorAll('.v2-syncopt').forEach((b2) => {
        b2.classList.toggle('on', st[b2.getAttribute('data-q')] === b2.getAttribute('data-v'));
      });
    };
    paint();
    const close = () => { try { ov.remove(); } catch (e) {} };
    ov.addEventListener('click', (ev) => {
      if (ev.target === ov || ev.target.closest('.v2-synccancel')) { close(); return; }
      const opt = ev.target.closest('.v2-syncopt');
      if (opt) { st[opt.getAttribute('data-q')] = opt.getAttribute('data-v'); paint(); return; }
      if (ev.target.closest('.v2-syncgo')) {
        const prev = +p.bars || 1;
        if (!bound) {
          if (p.clock === 'free') { delete p.clock; delete p.ms; }   // syncing to bars IS the bar clock
          p.bars = clamp(tgt.bars, 0.125, 64);
          if (st.len === 'fill') {
            const sv = p.barsMode; p.barsMode = 'fill';
            try { V2.applyBarsMode(L, prev); } catch (e) {}
            // PUT BACK WHATEVER WAS THERE — Sync borrows the mode to do one
            // fill and must not silently retire a `preserve` the cadence edit
            // chose (it would read as Preserve turning itself off).
            if (sv === 'fill' || sv === 'preserve') p.barsMode = sv; else delete p.barsMode;
          }
        }
        if (isRec) {
          // only MOVE the setting when the answer changed — 'follow' must not
          // downgrade an explicit chordlock to diatonic
          if (st.notes === 'follow' && !isFollow) L.harmony = 'diatonic';
          if (st.notes === 'keep' && isFollow) delete L.harmony;
        }
        try { E.getCfg(); } catch (e) {}
        try { if (E._v2Phase) delete E._v2Phase['v2:' + L.id]; } catch (e) {}
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
        close();
        try { if (onApply) onApply(); } catch (e) {}
        try { showToast('\u21c4 Synced \u2014 ' + fmt(+L.part.bars || 1) +
          (isRec ? (st.notes === 'follow' ? ' \u00b7 following the changes' : ' \u00b7 notes kept as-is') : ''), { ms: 3000 }); } catch (e) {}
        return;
      }
    });
  }

  // ── A CADENCE CHANGE MOVES THE CONTENT WITH IT ──────────────────────────
  // A per-part record IS its part's length — the reconciler refits `part.bars`
  // on every normalize — so lengthening a chord ALREADY stretched every record
  // filed against that part: note times are cycle FRACTIONS, so the same notes
  // simply spread over the new length. That is one of two honest answers and
  // it was being taken silently. `part.barsMode` is where the other one lives
  // (`fill` — keep the notes at their own tempo and repeat or trim), and the
  // edit now ASKS which, then applies it through the SAME `applyBarsMode` the
  // ⇄ Sync dialog uses. The dialog decides; it does not implement.
  //
  // THE RECORD FOR THAT PART IS NOT ALWAYS `L.part`: a layer editing part 2
  // keeps part 1's record filed in `L.parts`, and the reconciler refits that
  // one too — so a cascade that only looked at the bench would miss every
  // layer whose selection happens to be elsewhere.
  function partRecOf(L, pi) {
    if (!L || !Number.isFinite(L.partFor)) return null;
    if ((L.partFor | 0) === (pi | 0)) return L.part || null;
    const m = L.parts && L.parts[String(pi | 0)];
    return (m && typeof m === 'object') ? m : null;
  }
  // WHO IS AFFECTED, and who merely LOOKS affected. `bound` is content that
  // just moved; `loose` is the ▭ Everywhere layers, which are NOT bound to any
  // part by definition — cascading to them would override the statement the
  // mode makes — so they are NAMED and pointed at their own door rather than
  // resized behind the user's back.
  function cascadeScanFn(E, pi) {
    const out = { bound: [], loose: [] };
    let cfg = null; try { cfg = E.getCfg(); } catch (e) { return out; }
    (cfg.layers || []).forEach((L) => {
      if (!L) return;
      const rec = partRecOf(L, pi);
      if (rec) out.bound.push({ id: L.id | 0, name: L.name || 'Layer',
        kind: rec.kind === 'recorded' ? 'written' : 'generated',
        notes: (rec.notes || []).length, bars: +rec.bars || 0 });
      else if (!Number.isFinite(L.partFor)) out.loose.push({ id: L.id | 0, name: L.name || 'Layer', bars: +((L.part || {}).bars) || 0 });
    });
    return out;
  }
  // APPLY THE ANSWER. `stretch` is what already happened, so it only records
  // the preference; `fill` re-writes against the length the record had BEFORE
  // the reconciler moved it, which is the one number normalize cannot know.
  function cascadeBarsFn(E, pi, prevBars, mode, lens) {
    let cfg = null; try { cfg = E.getCfg(); } catch (e) { return 0; }
    let n = 0;
    (cfg.layers || []).forEach((L) => {
      const rec = partRecOf(L, pi); if (!rec) return;
      if (mode === 'fill' || mode === 'preserve') rec.barsMode = mode; else delete rec.barsMode;
      if (mode !== 'stretch' && prevBars > 0) {
        // SWAP-RUN-RESTORE, the idiom normalize itself uses to run one record
        // coercion over every filed record — `applyBarsMode` reads `L.part`.
        const keep = L.part; L.part = rec;
        // `V2.applyBarsMode`, NOT the bare name — this half of the file is the
        // OTHER IIFE and the maker lives in the engine one (the documented trap).
        try { if (V2.applyBarsMode(L, prevBars, lens)) n++; } catch (e) {} finally { L.part = keep; }
      } else n++;
      // APPLY NOW, not when the schedule runs dry — the same cancel + drop-phase
      // pair every other live edit here does.
      try {
        if (E.timer && typeof cancelBloomFutureVoices === 'function' && typeof Tone !== 'undefined')
          cancelBloomFutureVoices('v2:' + (L.id | 0), Tone.now());
      } catch (e) {}
      try { if (E._v2Phase) delete E._v2Phase['v2:' + (L.id | 0)]; } catch (e) {}
    });
    try { E.getCfg(); } catch (e) {}
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    return n;
  }
  // THE WARNING, asked ONCE at the end of the edit rather than on every ±
  // press — a question per press is unusable, and the length that matters is
  // the one you finished on.
  function cascadeModalFn(E, pi, prevBars, newBars, onDone, lens) {
    const scan = cascadeScanFn(E, pi);
    const fin = () => { try { if (onDone) onDone(); } catch (e) {} };
    if (!scan.bound.length) { fin(); return false; }
    let nm = 'this part';
    try { if (typeof _ambPartLabel === 'function') nm = _ambPartLabel(E.getCfg(), pi) || nm; } catch (e) {}
    const fmt = (b2) => (Math.round(b2 * 100) / 100) + ' bar' + (Math.abs(b2 - 1) < 1e-9 ? '' : 's');
    // OPEN ON THE ANSWER ALREADY GIVEN. The mode is stored on the record, so a
    // second cadence edit should not silently revert to Stretch the choice the
    // first one made.
    let st0 = 'stretch';
    try {
      const cfg0 = E.getCfg();
      const r0 = (cfg0.layers || []).map((L) => partRecOf(L, pi)).filter(Boolean)[0];
      if (r0 && (r0.barsMode === 'fill' || r0.barsMode === 'preserve')) st0 = r0.barsMode;
    } catch (e) {}
    // …and Preserve needs the old cadence to map through; without it the button
    // would be a control that cannot act (the dead-control class), so it is
    // offered only when the caller supplied both shapes.
    const canPreserve = !!(lens && Array.isArray(lens.old) && Array.isArray(lens.now) &&
                           lens.old.length && lens.now.length);
    if (st0 === 'preserve' && !canPreserve) st0 = 'stretch';
    const st = { len: st0 };
    const ov = document.createElement('div');
    ov.className = 'sm-overlay';
    ov.style.setProperty('display', 'flex', 'important');   // body-attached — the view-mode hide rules
    const attr = (typeof _ambPartAttr === 'function') ? _ambPartAttr(pi) : '';
    const list = scan.bound.map((x) => '<li>' + esc(x.name) + ' · ' + x.kind +
      (x.kind === 'written' ? ' · ' + x.notes + ' note' + (x.notes === 1 ? '' : 's') : '') + '</li>').join('');
    ov.innerHTML = '<div class="sm-modal v2-sync-modal v2-casc-modal">' +
      '<div class="sm-title">The cadence moved</div>' +
      '<div class="v2-sync-tgt"' + attr + '><b>' + esc(nm) + '</b> is ' + fmt(newBars) +
        ' now — it was ' + fmt(prevBars) + '.</div>' +
      '<div class="ambient-hint v2-casc-who">' + scan.bound.length +
        (scan.bound.length === 1 ? ' layer writes' : ' layers write') + ' content for it:' +
        '<ul class="v2-casc-list">' + list + '</ul></div>' +
      '<div class="v2-sync-row"><label>Content</label>' +
        '<span class="ambient-seg-row">' +
          '<button type="button" class="ambient-seg v2-cascopt" data-v="stretch" ' +
            'title="The same notes, spread across the new length">Stretch</button>' +
          '<button type="button" class="ambient-seg v2-cascopt" data-v="fill" ' +
            'title="Keep the notes at their own tempo — repeat or trim them to the new length">Fill</button>' +
          (canPreserve
            ? '<button type="button" class="ambient-seg v2-cascopt" data-v="preserve" ' +
              'title="Each note stays in the change it was in — truncated or extended to that change\'s new length">Preserve</button>'
            : '') +
        '</span></div>' +
      (canPreserve
        ? '<div class="ambient-hint v2-casc-why">Stretch scales the whole part by one ratio · ' +
          'Fill keeps the tempo and repeats · Preserve moves each note with ITS OWN change, ' +
          'truncating or extending it to fit the new length.</div>'
        : '') +
      (scan.loose.length
        ? '<div class="ambient-hint v2-casc-loose">' + scan.loose.length + ' ▭ Everywhere layer' +
          (scan.loose.length === 1 ? '' : 's') + ' keep' + (scan.loose.length === 1 ? 's' : '') +
          ' its own length — that content is not for one part. ⇄ Sync fits one to a part.</div>'
        : '') +
      '<div class="v2-sync-actions">' +
        '<button type="button" class="ambient-regen v2-cascgo">Apply</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    const paint = () => ov.querySelectorAll('.v2-cascopt').forEach((b2) =>
      b2.classList.toggle('on', st.len === b2.getAttribute('data-v')));
    paint();
    const close = () => { try { ov.remove(); } catch (e) {} };
    ov.addEventListener('click', (ev) => {
      const opt = ev.target.closest && ev.target.closest('.v2-cascopt');
      if (opt) { st.len = opt.getAttribute('data-v'); paint(); return; }
      // THE SCRIM IS NOT A CANCEL HERE. The length has already moved and the
      // records with it — there is nothing to cancel, only a choice about how
      // they follow — so dismissing means "the default, stretch", which is
      // exactly the state the dialog opened on.
      if (ev.target === ov || (ev.target.closest && ev.target.closest('.v2-cascgo'))) {
        const n = cascadeBarsFn(E, pi, prevBars, st.len, lens);
        close(); fin();
        try {
          const word = st.len === 'fill'
            ? '⇥ Filled — ' + n + ' layer' + (n === 1 ? '' : 's') + ' kept their tempo over ' + fmt(newBars)
            : (st.len === 'preserve'
              ? '⊞ Preserved — ' + n + ' layer' + (n === 1 ? '' : 's') + ' re-fitted to each change'
              : '↔ Stretched — ' + n + ' layer' + (n === 1 ? '' : 's') + ' spread across ' + fmt(newBars));
          showToast(word, { ms: 3200 });
        } catch (e) {}
      }
    });
    return true;
  }

  // ── ✂ SPLIT — ONE NOTE BECOMES SEVERAL, IN ITS OWN SPAN ─────────────────
  // The total length is the invariant: whatever you ask for, the pieces cover
  // exactly `[t, t+dur)` and nothing after this note moves. That is what makes
  // it a division rather than an edit — you can split a note without re-timing
  // the phrase around it.
  //
  // Three ways to say the proportions, and they are the three real answers:
  // EQUAL (the common one), CUSTOM (you state the relative sizes and the app
  // does the arithmetic), RANDOM (a spread from even to dramatic). All three
  // reduce to a list of WEIGHTS, so there is one divider and the pattern only
  // decides where the weights come from — a second implementation per mode is
  // how the "same total length" promise would come to be true of only two.
  const SPLIT_MIN = 1 / 64;        // of the note — no piece may vanish
  function splitWeights(kind, count, custom, spread, roll) {
    const n = Math.max(2, count | 0);
    let w = [];
    if (kind === 'custom') {
      for (let i = 0; i < n; i++) {
        const v = +(custom || [])[i];
        w.push(Number.isFinite(v) && v > 0 ? v : 1);
      }
    } else if (kind === 'random') {
      // MULTIPLICATIVE, so a weight can never go negative and 0 spread is
      // exactly 1 for every piece — the slider's own left end IS equal
      // division, which is what "from equally sized to dramatic" means.
      // 2.6, not 1.8: the exponent spans ±k/2, but a handful of uniform draws
      // rarely reaches both ends — measured, four pieces at the top of the
      // slider came out only 1.7× apart, which is not "dramatic". At 2.6 the
      // typical longest:shortest is ~5:1, which reads as a dotted note against
      // a short one, and the floor below keeps the short one audible.
      const k = Math.max(0, Math.min(100, spread | 0)) / 100 * 2.6;
      for (let i = 0; i < n; i++) {
        // seeded on the piece, the shape and the press count: the same
        // settings redraw the same division (a preview you cannot trust is
        // not a preview), and 🎲 asks for another one
        let r = 0.5;
        try { r = _ambSeededRand(((roll | 0) * 7919) ^ (n * 131) ^ (i * 2654435761)) (); } catch (e) { r = ((i * 37 + (roll | 0) * 91) % 100) / 100; }
        w.push(Math.exp(k * (r - 0.5)));
      }
    } else {
      for (let i = 0; i < n; i++) w.push(1);
    }
    // NORMALISE, THEN FLOOR, THEN NORMALISE AGAIN. A floor applied to shares
    // that already sum to 1 breaks the sum, so the second pass is what keeps
    // the promise; the floor itself is what stops a dramatic spread producing
    // a piece too short to hear.
    let tot = w.reduce((a, v) => a + v, 0) || 1;
    w = w.map((v) => Math.max(SPLIT_MIN, v / tot));
    tot = w.reduce((a, v) => a + v, 0) || 1;
    return w.map((v) => v / tot);
  }
  // ── …AND IN PITCH ───────────────────────────────────────────────────────
  // A division in time alone makes a repeated note; the second axis is what
  // turns it into a figure. Same shape as the sizes: three ways to say it, one
  // list of MIDI numbers out, so `splitNote` stays one function.
  //
  // STEPS walks the SOUNDING SCALE, not semitones — that is the difference
  // between an arpeggio and a chromatic run, and the scale is already resolved
  // for the keyboard's in-key marks (`V2.scaleAt`). With no key in force the
  // ladder is chromatic, which is the honest answer rather than inventing one.
  function scaleLadder(pcs) {
    const a = [];
    for (let i = 0; i < 12; i++) if (pcs && pcs[i]) a.push(i);
    return a;
  }
  function stepScale(midi, n, pcs) {
    const list = scaleLadder(pcs);
    const m = Math.round(midi);
    if (!list.length) return clamp(m + n, 0, 127);
    // every member of the scale for four octaves either side, ascending — a
    // ladder to index into, which is exact and needs no modular arithmetic
    const lad = [];
    for (let x = m - 48; x <= m + 48; x++) if (list.indexOf(((x % 12) + 12) % 12) >= 0) lad.push(x);
    if (!lad.length) return clamp(m + n, 0, 127);
    // the member at or below the note — a note OUTSIDE the scale steps from
    // the one under it rather than refusing
    let i = 0;
    for (let k = 0; k < lad.length; k++) { if (lad[k] <= m) i = k; else break; }
    return clamp(lad[clamp(i + n, 0, lad.length - 1)], 0, 127);
  }
  function splitPitches(kind, count, midi0, opts) {
    const n = Math.max(2, count | 0), o = opts || {}, m0 = clamp(Math.round(midi0) | 0, 0, 127);
    const out = [];
    if (kind === 'steps') {
      const by = Math.round(o.step || 0);
      for (let i = 0; i < n; i++) out.push(stepScale(m0, by * i, o.pcs));
    } else if (kind === 'custom') {
      for (let i = 0; i < n; i++) {
        const v = +(o.custom || [])[i];
        out.push(clamp(m0 + (Number.isFinite(v) ? Math.round(v) : 0), 0, 127));
      }
    } else if (kind === 'random') {
      // WHICH LADDER IT SCATTERS ALONG — the second question Random has to
      // answer, and it was only ever answered one way. CHROMATIC is every
      // semitone, SCALE is the sounding scale (what this always did, so it
      // stays the default), CHORD is the tones of the chord under the note,
      // which turns a scatter into a broken chord instead of a run.
      //
      // ONE LADDER WALK serves all three — `stepScale` indexes whatever pitch
      // classes it is handed, so the pool only decides WHICH set.
      const pool = (o.pool === 'chromatic' || o.pool === 'chord') ? o.pool : 'scale';
      const pcs = (pool === 'chord') ? (o.chordPcs || o.pcs)
        : (pool === 'chromatic' ? null : o.pcs);
      // …AND SCATTER MEANS THE SAME DISTANCE IN ALL THREE. The span was a flat
      // 7 LADDER STEPS, which is about an octave on a 7-note scale and two and
      // a half on a triad — so the one slider would have covered a different
      // pitch range per pool. It is stated as an octave and converted by the
      // ladder's own density (a 12-tone ladder is 12 steps to the octave, a
      // triad 3). A 7-note scale is 7, i.e. BYTE-IDENTICAL to the old flat 7;
      // the one case that moves is Scale with NO key in force, where the ladder
      // already is chromatic — an octave there is 12 semitones, not 7, and
      // matching it is the point of stating the span in octaves.
      const per = (() => {
        if (pool === 'chromatic' || !pcs) return 12;
        let k = 0; for (let i = 0; i < 12; i++) if (pcs[i]) k++;
        return k > 0 ? k : 12;
      })();
      const span = Math.max(0, Math.min(100, o.scatter | 0)) / 100 * per;
      for (let i = 0; i < n; i++) {
        let r = 0.5;
        try { r = _ambSeededRand((((o.roll | 0) * 6151) ^ (n * 97) ^ (i * 40503)) >>> 0)(); } catch (e) { r = ((i * 53 + (o.roll | 0) * 31) % 100) / 100; }
        const k = Math.round((r - 0.5) * 2 * span);
        out.push(pool === 'chromatic' ? clamp(m0 + k, 0, 127) : stepScale(m0, k, pcs));
      }
    } else {
      for (let i = 0; i < n; i++) out.push(m0);
    }
    return out;
  }
  // The division itself. Kept separate from the dialog so the gate can ask the
  // arithmetic directly, and so the promise ("the pieces cover the original
  // span exactly") is one function's to keep.
  function splitNoteFn(L, idx, w, pitches) {
    const p = L && L.part; if (!p || p.kind !== 'recorded') return null;
    const ns = p.notes || []; const n0 = ns[idx]; if (!n0) return null;
    const T = +n0.t, D = +n0.dur;
    if (!(D > 0) || !w || w.length < 2) return null;
    // A CHANGED PITCH ON A REMAPPING PART MUST BE PINNED — chordlock/diatonic
    // quantize the sounding pitch into the chord, so a piece asked for a third
    // up would land wherever the chord put it. The hand wins, the same rule the
    // drag, the pencil and the note editor all follow.
    const pit = Array.isArray(pitches) ? pitches : null;
    const moved = !!(pit && pit.some((m) => (m | 0) !== (n0.midi | 0)));
    const pin = moved && (L.harmony === 'diatonic' || L.harmony === 'chordlock');
    const out = []; let acc = 0;
    for (let i = 0; i < w.length; i++) {
      const piece = { t: T + acc * D,
        midi: (pit && Number.isFinite(pit[i])) ? (pit[i] | 0) : n0.midi,
        dur: w[i] * D };
      // EVERYTHING THE NOTE WAS, carried. A split is a division of one note,
      // not a new one — so its level, envelope, glide and its pitch PIN come
      // along, or a split on a remapping part would re-voice every piece
      // (the `hx` rule, from the other side).
      ['vel', 'atk', 'dec', 'sus', 'rel', 'glide', 'hx'].forEach((k) => {
        if (n0[k] != null) piece[k] = n0[k];
      });
      if (pin) piece.hx = 1;
      out.push(piece); acc += w[i];
    }
    // The LAST piece is snapped to the original end rather than trusted to the
    // float sum — the invariant is stated in the dialog and must be exact.
    const last = out[out.length - 1];
    last.dur = Math.max(1e-6, (T + D) - last.t);
    p.notes = ns.slice(0, idx).concat(out, ns.slice(idx + 1));
    return out.length;
  }
  function splitModal(E, card, L, idx) {
    const p = L.part;
    if (p.kind !== 'recorded') return;
    const n0 = (p.notes || [])[idx]; if (!n0 || !(+n0.dur > 0)) return;
    const T = +n0.t, D = +n0.dur;
    const bars = Math.max(0.0625, +p.bars || 1);
    const st = { kind: 'equal', count: 3, spread: 40, roll: 1, custom: [],
                 pk: 'same', pstep: 1, pscatter: 40, pcustom: [], ppool: 'scale',
                 // A PIECE SET BY HAND, and which one is open. The pins survive
                 // a re-roll — the hand wins, the rule the drag, the pencil and
                 // the note editor all follow — and ↺ is the way back.
                 pfix: {}, sel: -1 };
    // THE SOUNDING SCALE at the drawing's own anchor — the same call that lights
    // the keyboard's in-key marks, so "a step" means the same thing in both.
    let PCS = null, CHORD = null;
    try {
      const cvz = card && card.querySelector('.v2-vizcv');
      const cs0 = (cvz && cvz._cs) || 0;
      PCS = V2.scaleAt(E, E.getCfg(), cs0, L);
      // …AND THE CHORD AT THE NOTE'S OWN ONSET, not at the cycle start. A
      // scale governs the whole cycle so the drawing's anchor is the right
      // question for it; a CHORD changes underneath, and the only chord this
      // dialog can honestly mean is the one sounding where the note is.
      let cyc = 0; try { cyc = V2.cycleSec(L, E.getCfg()) || 0; } catch (e2) {}
      CHORD = V2.chordAt(E, E.getCfg(), cs0 + T * cyc, L);
    } catch (e) { PCS = null; CHORD = null; }
    const ov = document.createElement('div');
    ov.className = 'sm-overlay';
    ov.style.setProperty('display', 'flex', 'important');   // body-attached — the view-mode hide rules
    // BEATS, because that is the unit the ruler above is drawn in and the one
    // the note editor's own Position and Length already speak.
    const beats = (frac) => Math.round(frac * bars * 4 * 1000) / 1000;
    const nm = () => {
      try { return _AMB_CHROM[(((n0.midi | 0) % 12) + 12) % 12] + (Math.floor((n0.midi | 0) / 12) - 1); }
      catch (e) { return 'note'; }
    };
    ov.innerHTML = '<div class="sm-modal v2-sync-modal v2-split-modal">' +
      '<div class="sm-title">✂ Split note</div>' +
      '<div class="v2-sync-tgt"><b>' + esc(nm()) + '</b> — ' + beats(D) +
        ' beat' + (Math.abs(beats(D) - 1) < 1e-9 ? '' : 's') + ' long. The pieces fill exactly that.</div>' +
      '<div class="v2-sync-row"><label>Into</label>' +
        '<span class="ambient-stepper v2-split-cnt">' +
          '<button type="button" class="ambient-seg v2-splitstep" data-d="-1">−</button>' +
          '<span class="v2-split-n">3</span>' +
          '<button type="button" class="ambient-seg v2-splitstep" data-d="1">＋</button>' +
        '</span><span class="ambient-hint">notes</span></div>' +
      '<div class="v2-sync-row"><label>Sizes</label>' +
        '<span class="ambient-seg-row">' +
          '<button type="button" class="ambient-seg v2-splitkind" data-v="equal" ' +
            'title="Every piece the same length">Equal</button>' +
          '<button type="button" class="ambient-seg v2-splitkind" data-v="custom" ' +
            'title="State the relative sizes — the app scales them to the note’s own length">Custom</button>' +
          '<button type="button" class="ambient-seg v2-splitkind" data-v="random" ' +
            'title="Rolled, from even to dramatically uneven — always within the note">Random</button>' +
        '</span></div>' +
      '<div class="v2-split-custom"><div class="ambient-hint">Relative sizes — any numbers; ' +
        'they are scaled to fit.</div><div class="v2-split-fields"></div></div>' +
      // ── PITCH, the second axis ────────────────────────────────────────
      // A division in time alone makes a repeated note; this is what turns it
      // into a figure. Same four-way shape as Sizes so the dialog reads as two
      // parallel questions rather than one question and an extra.
      '<div class="v2-sync-row"><label>Pitch</label>' +
        '<span class="ambient-seg-row">' +
          '<button type="button" class="ambient-seg v2-splitpk" data-v="same" ' +
            'title="Every piece keeps the note\u2019s own pitch">Same</button>' +
          '<button type="button" class="ambient-seg v2-splitpk" data-v="steps" ' +
            'title="Climb or fall by scale steps \u2014 an arpeggio out of one note">Steps</button>' +
          '<button type="button" class="ambient-seg v2-splitpk" data-v="custom" ' +
            'title="State each piece yourself, in semitones from the original">Custom</button>' +
          '<button type="button" class="ambient-seg v2-splitpk" data-v="random" ' +
            'title="Scattered around the original, and kept in key">Random</button>' +
        '</span></div>' +
      '<div class="v2-split-psteps"><div class="v2-sync-row"><label>By</label>' +
        '<span class="ambient-stepper v2-split-cnt">' +
          '<button type="button" class="ambient-seg v2-splitpstep" data-d="-1">\u2212</button>' +
          '<span class="v2-split-pn">+1</span>' +
          '<button type="button" class="ambient-seg v2-splitpstep" data-d="1">\uff0b</button>' +
        '</span><span class="ambient-hint v2-split-scalab"></span></div></div>' +
      '<div class="v2-split-pcustom"><div class="ambient-hint">Semitones from the ' +
        'original \u2014 0 keeps it.</div><div class="v2-split-pfields"></div></div>' +
      // WHICH LADDER RANDOM WALKS. Scatter alone said how FAR and never out of
      // WHAT — the same missing half the Length readout had, one control over.
      // Chord is offered whether or not it can act and REFUSES WITH A REASON on
      // a press (the house rule: a dead control that merely dims teaches
      // nothing, and hiding it means it can never be found).
      '<div class="v2-split-prand">' +
        '<div class="v2-sync-row"><label>From</label>' +
          '<span class="ambient-seg-row">' +
            '<button type="button" class="ambient-seg v2-splitpool" data-v="chromatic" ' +
              'title="Every semitone — in or out of the key">Chromatic</button>' +
            '<button type="button" class="ambient-seg v2-splitpool" data-v="scale" ' +
              'title="The scale sounding here — the scatter stays in key">Scale</button>' +
            '<button type="button" class="ambient-seg v2-splitpool" data-v="chord" ' +
              'title="The tones of the chord under this note — a broken chord rather than a run">Chord</button>' +
          '</span></div>' +
        '<div class="ambient-hint v2-split-poollab"></div>' +
        '<div class="ambient-ctrl">' +
        '<label>Scatter</label>' +
        '<input type="range" class="ambient-sl v2-split-pspread" min="0" max="100" step="1" value="40">' +
        '<span class="ambient-sl-v v2-split-pspreadv">40</span></div></div>' +
      '<div class="v2-split-rand"><div class="ambient-ctrl">' +
        '<label>Unevenness</label>' +
        '<input type="range" class="ambient-sl v2-split-spread" min="0" max="100" step="1" value="40">' +
        '<span class="ambient-sl-v v2-split-spreadv">40</span></div>' +
        '<div class="ambient-hint">even → dramatic</div></div>' +
      // ONE DICE, FOR WHATEVER IS ROLLED. It lived INSIDE the Sizes panel, so
      // with Sizes on Equal and Pitch on Random there was no way to roll at all
      // — the counter drives both and its only button was behind one of them.
      // Out here it shows whenever either axis is rolled, and says which.
      '<div class="v2-split-rerow">' +
        '<button type="button" class="ambient-regen v2-splitroll">🎲 Roll again</button>' +
        '<span class="ambient-hint v2-split-rolllab"></span></div>' +
      // THE PREVIEW IS THE POINT. Numbers alone do not read as proportions —
      // the cadence editor learned the same thing — and it is the one surface
      // that makes Custom's arithmetic visible before you commit to it.
      // …AND IT IS A CONTROL: a piece is tapped to set its note by hand.
      '<div class="v2-split-prev"></div>' +
      '<div class="ambient-hint v2-split-prevhint">Tap a piece to set its note.</div>' +
      // THE PIECE UNDER THE HAND. Note and OCTAVE are separate steppers because
      // they are separate questions — a ladder step can cross an octave and an
      // octave jump must not change which note it is.
      '<div class="v2-split-pick" hidden>' +
        '<div class="v2-sync-row"><label class="v2-split-picklab">Piece</label>' +
          '<span class="ambient-stepper v2-split-cnt">' +
            '<button type="button" class="ambient-seg v2-splitnstep" data-d="-1">−</button>' +
            '<span class="v2-split-nname">—</span>' +
            '<button type="button" class="ambient-seg v2-splitnstep" data-d="1">＋</button>' +
          '</span><span class="ambient-hint v2-split-nlab"></span></div>' +
        '<div class="v2-sync-row"><label>Octave</label>' +
          '<span class="ambient-stepper v2-split-cnt">' +
            '<button type="button" class="ambient-seg v2-splitostep" data-d="-1">−</button>' +
            '<span class="v2-split-oct">—</span>' +
            '<button type="button" class="ambient-seg v2-splitostep" data-d="1">＋</button>' +
          '</span>' +
          '<button type="button" class="ambient-regen v2-splitunpin">↺ Back to the roll</button>' +
        '</div></div>' +
      '<div class="v2-sync-actions">' +
        '<button type="button" class="ambient-regen v2-splitgo">Split</button>' +
        '<button type="button" class="ambient-regen v2-splitcancel">Cancel</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    const wNow = () => splitWeights(st.kind, st.count, st.custom, st.spread, st.roll);
    const pNow = () => {
      const out = splitPitches(st.pk, st.count, n0.midi | 0,
        { step: st.pstep, custom: st.pcustom, scatter: st.pscatter, roll: st.roll,
          pcs: PCS, pool: st.ppool, chordPcs: CHORD });
      // THE HAND LAST. A pin is a statement about ONE piece, so it outranks
      // whatever the pattern proposed and is untouched by a re-roll.
      for (let i = 0; i < out.length; i++) {
        const v = st.pfix[i];
        if (Number.isFinite(v)) out[i] = clamp(v | 0, 0, 127);
      }
      return out;
    };
    // THE LADDER THE ± WALKS — the same set the dialog is working in, so a
    // step means one thing on this surface: the pool's tones under Random,
    // otherwise the sounding scale, and semitones when there is neither.
    const pickLadder = () => {
      if (st.pk === 'random') {
        if (st.ppool === 'chromatic') return null;
        if (st.ppool === 'chord') return CHORD || PCS;
      }
      return PCS;
    };
    const pickLadderName = () => {
      const l = pickLadder();
      if (!l) return 'semitones';
      return (st.pk === 'random' && st.ppool === 'chord' && CHORD) ? 'chord tones' : 'scale steps';
    };
    const pname = (m) => { try { return _AMB_CHROM[(((m % 12) + 12) % 12)] + (Math.floor(m / 12) - 1); }
      catch (e) { return String(m); } };
    const paint = () => {
      const q = (s2) => ov.querySelector(s2);
      const nEl = q('.v2-split-n'); if (nEl) nEl.textContent = String(st.count);
      ov.querySelectorAll('.v2-splitkind').forEach((b2) =>
        b2.classList.toggle('on', b2.getAttribute('data-v') === st.kind));
      const cu = q('.v2-split-custom'), rd = q('.v2-split-rand');
      if (cu) cu.style.display = (st.kind === 'custom') ? '' : 'none';
      if (rd) rd.style.display = (st.kind === 'random') ? '' : 'none';
      ov.querySelectorAll('.v2-splitpk').forEach((b2) =>
        b2.classList.toggle('on', b2.getAttribute('data-v') === st.pk));
      const ps = q('.v2-split-psteps'), pc = q('.v2-split-pcustom'), pr = q('.v2-split-prand');
      if (ps) ps.style.display = (st.pk === 'steps') ? '' : 'none';
      if (pc) pc.style.display = (st.pk === 'custom') ? '' : 'none';
      if (pr) pr.style.display = (st.pk === 'random') ? '' : 'none';
      const pn = q('.v2-split-pn');
      if (pn) pn.textContent = (st.pstep > 0 ? '+' : '') + st.pstep;
      // SAY WHICH LADDER IT IS WALKING. With no key in force a "step" is a
      // semitone, and a control that means two things without saying which is
      // the trap this card keeps closing.
      const sc = q('.v2-split-scalab');
      if (sc) sc.textContent = PCS ? 'scale steps' : 'semitones — no key in force';
      ov.querySelectorAll('.v2-splitpool').forEach((b2) => {
        const v = b2.getAttribute('data-v');
        b2.classList.toggle('on', v === st.ppool);
        // n/a is MARKED, never hidden and never inert-and-silent
        const na = (v === 'chord' && !CHORD) || (v === 'scale' && !PCS);
        b2.classList.toggle('is-na', na);
        if (na) b2.setAttribute('aria-disabled', 'true'); else b2.removeAttribute('aria-disabled');
      });
      const pl = q('.v2-split-poollab');
      if (pl) {
        pl.textContent = st.ppool === 'chromatic'
          ? 'every semitone · ±1 octave at full scatter'
          : (st.ppool === 'chord'
            ? (CHORD ? 'the chord under this note · ±1 octave at full scatter'
                     : 'this part has no changes — add a progression, or use Scale')
            : (PCS ? 'the sounding scale · ±1 octave at full scatter'
                   : 'no key in force, so this is every semitone'));
      }
      const pbox = q('.v2-split-pfields');
      if (pbox && pbox.children.length !== st.count) {
        pbox.innerHTML = '';
        for (let i = 0; i < st.count; i++) {
          const inp = document.createElement('input');
          inp.type = 'number'; inp.className = 'ambient-step-inp v2-split-pw';
          inp.step = '1';
          inp.value = String(st.pcustom[i] != null ? st.pcustom[i] : 0);
          pbox.appendChild(inp);
        }
      }
      // the custom fields are REBUILT only when the count changes — rewriting
      // them on every keystroke would take the caret with them
      const box = q('.v2-split-fields');
      if (box && box.children.length !== st.count) {
        box.innerHTML = '';
        for (let i = 0; i < st.count; i++) {
          const inp = document.createElement('input');
          inp.type = 'number'; inp.className = 'ambient-step-inp v2-split-w';
          inp.min = '0.1'; inp.step = '0.1';
          inp.value = String(st.custom[i] != null ? st.custom[i] : 1);
          box.appendChild(inp);
        }
      }
      // ONE DICE FOR BOTH AXES — shown whenever either is rolled, and it says
      // what a press will move rather than leaving you to infer it.
      const rr = q('.v2-split-rerow');
      const rolls = (st.kind === 'random' ? 1 : 0) + (st.pk === 'random' ? 2 : 0);
      if (rr) rr.style.display = rolls ? '' : 'none';
      const rl = q('.v2-split-rolllab');
      if (rl) rl.textContent = rolls === 3 ? 'new sizes and new notes'
        : (rolls === 2 ? 'new notes' : (rolls === 1 ? 'new sizes' : ''));
      const w = wNow();
      const pv = q('.v2-split-prev');
      // `beats(v * D)`, NOT `beats(v)`: a weight is a fraction of THIS NOTE and
      // `beats` converts a fraction of the CYCLE — so the pieces read as the
      // whole cycle's beats and summed to twice the note's own length, which
      // is the one promise this dialog makes.
      const mids = pNow();
      if (pv) pv.innerHTML = segHtml(w, mids);
      // THE PIECE UNDER THE HAND. Absent selection = the row is not there at
      // all; there is nothing to say about no piece.
      const pk = q('.v2-split-pick');
      const has = st.sel >= 0 && st.sel < st.count;
      if (pk) pk.hidden = !has;
      if (pk && has) {
        const m = mids[st.sel] | 0;
        const lb = q('.v2-split-picklab');
        if (lb) lb.textContent = 'Piece ' + (st.sel + 1);
        const nn2 = q('.v2-split-nname'); if (nn2) nn2.textContent = pname(m);
        const oc = q('.v2-split-oct');
        if (oc) oc.textContent = String(Math.floor(m / 12) - 1);
        const nl = q('.v2-split-nlab'); if (nl) nl.textContent = pickLadderName();
        const un = q('.v2-splitunpin');
        // ↺ is only a way BACK — with nothing pinned there is nothing to undo
        if (un) un.style.display = Number.isFinite(st.pfix[st.sel]) ? '' : 'none';
      }
      const ph = q('.v2-split-prevhint');
      if (ph) ph.textContent = has ? 'Tap the piece again to close it.' : 'Tap a piece to set its note.';
    };
    // THE PREVIEW NAMES THE PIECES once pitch varies — the beats stay in the
    // tooltip, because a segment is ~42px at eight pieces and the pitch is the
    // thing you cannot work out in your head.
    const segHtml = (w, mid) => {
      const varies = mid.some((m) => (m | 0) !== (n0.midi | 0));
      return w.map((v, i) => {
        const b2 = Math.round(beats(v * D) * 100) / 100;
        // THE NAME CARRIES THE OCTAVE (`pname` is note + octave, C4 not C) —
        // which is the whole point once a piece can be moved an octave by hand:
        // six pieces reading the same letter and different octaves must not
        // read as six of the same note.
        const face = varies ? pname(mid[i]) : String(b2);
        const pinned = Number.isFinite(st.pfix[i]);
        return '<i class="v2-split-seg' + (pinned ? ' is-pin' : '') +
          (st.sel === i ? ' on' : '') + '" data-i="' + i + '" ' +
          'style="width:' + (v * 100).toFixed(3) + '%" ' +
          'title="' + esc(pname(mid[i]) + ' \u00b7 ' + b2 + ' beats' +
            (pinned ? ' \u00b7 set by hand' : '') + ' \u2014 tap to set this piece') + '"><b>' +
          esc(face) + '</b></i>';
      }).join('');
    };
    paint();
    const close = () => { try { ov.remove(); } catch (e) {} };
    ov.addEventListener('input', (ev) => {
      const sp = ev.target.closest && ev.target.closest('.v2-split-spread');
      if (sp) { st.spread = +sp.value | 0;
        const v = ov.querySelector('.v2-split-spreadv'); if (v) v.textContent = String(st.spread);
        paint(); return; }
      const psp = ev.target.closest && ev.target.closest('.v2-split-pspread');
      if (psp) { st.pscatter = +psp.value | 0;
        const v2 = ov.querySelector('.v2-split-pspreadv'); if (v2) v2.textContent = String(st.pscatter);
        paint(); return; }
      const pwf = ev.target.closest && ev.target.closest('.v2-split-pw');
      if (pwf) {
        st.pcustom = [...ov.querySelectorAll('.v2-split-pw')].map((x) => +x.value);
        // the preview ONLY — repainting the fields would take the caret
        const pv2 = ov.querySelector('.v2-split-prev');
        if (pv2) pv2.innerHTML = segHtml(wNow(), pNow());
        return;
      }
      const wf = ev.target.closest && ev.target.closest('.v2-split-w');
      if (wf) {
        st.custom = [...ov.querySelectorAll('.v2-split-w')].map((x) => +x.value);
        // NEVER repaint the fields from here — see `paint`; only the preview
        // is redrawn, so the caret survives.
        const pv = ov.querySelector('.v2-split-prev');
        if (pv) pv.innerHTML = segHtml(wNow(), pNow());
        return;
      }
    });
    ov.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t === ov || (t.closest && t.closest('.v2-splitcancel'))) { close(); return; }
      const stp = t.closest && t.closest('.v2-splitstep');
      if (stp) {
        st.count = clamp(st.count + ((stp.getAttribute('data-d') | 0) || 1), 2, 16);
        // A PIN NAMES A PIECE, and past the new count that piece is gone — the
        // ones that still exist keep theirs rather than the whole set being
        // thrown away for changing the number.
        Object.keys(st.pfix).forEach((k) => { if ((k | 0) >= st.count) delete st.pfix[k]; });
        if (st.sel >= st.count) st.sel = -1;
        paint(); return;
      }
      // ── A PIECE OF THE PREVIEW IS A CONTROL ──────────────────────────
      const seg = t.closest && t.closest('.v2-split-seg');
      if (seg) {
        const i = seg.getAttribute('data-i') | 0;
        st.sel = (st.sel === i) ? -1 : i;    // tapping the open one closes it
        paint(); return;
      }
      const nst = t.closest && t.closest('.v2-splitnstep');
      if (nst && st.sel >= 0) {
        // STEP THE LADDER THE DIALOG IS IN — chord tones under Chord, scale
        // steps under a key, semitones when there is neither. The value is
        // taken from what is DRAWN, so the first press moves from the note you
        // can see rather than from a base the pattern happened to start at.
        const cur = pNow()[st.sel] | 0;
        const d = (nst.getAttribute('data-d') | 0) || 1;
        const lad = pickLadder();
        st.pfix[st.sel] = lad ? stepScale(cur, d, lad) : clamp(cur + d, 0, 127);
        paint(); return;
      }
      const ost = t.closest && t.closest('.v2-splitostep');
      if (ost && st.sel >= 0) {
        const cur = pNow()[st.sel] | 0;
        st.pfix[st.sel] = clamp(cur + 12 * ((ost.getAttribute('data-d') | 0) || 1), 0, 127);
        paint(); return;
      }
      if (t.closest && t.closest('.v2-splitunpin')) {
        if (st.sel >= 0) delete st.pfix[st.sel];
        paint(); return;
      }
      const kd = t.closest && t.closest('.v2-splitkind');
      if (kd) { st.kind = kd.getAttribute('data-v'); paint(); return; }
      const pkd = t.closest && t.closest('.v2-splitpk');
      if (pkd) { st.pk = pkd.getAttribute('data-v'); paint(); return; }
      const pool = t.closest && t.closest('.v2-splitpool');
      if (pool) {
        const v = pool.getAttribute('data-v');
        // REFUSE AND EXPLAIN. A press that silently does nothing is
        // indistinguishable from a broken button; naming the condition is the
        // whole reason the option is rendered at all.
        if (v === 'chord' && !CHORD) {
          try { showToast('Chord needs changes to draw from — this part has none. ' +
            'Turn the Progression on (or give the layer a chord source), then Chord scatters ' +
            'through the chord under the note.', { ms: 4200 }); } catch (e2) {}
          return;
        }
        if (v === 'scale' && !PCS) {
          try { showToast('No key is in force, so Scale and Chromatic are the same ladder here. ' +
            'Turn Key on to scatter in key.', { ms: 4000 }); } catch (e2) {}
        }
        st.ppool = v; paint(); return;
      }
      const pst = t.closest && t.closest('.v2-splitpstep');
      if (pst) { st.pstep = clamp(st.pstep + ((pst.getAttribute('data-d') | 0) || 1), -7, 7); paint(); return; }
      if (t.closest && t.closest('.v2-splitroll')) { st.roll++; paint(); return; }
      if (t.closest && t.closest('.v2-splitgo')) {
        const made = splitNoteFn(L, idx, wNow(), pNow());
        close();
        if (!made) return;
        try { E.getCfg(); } catch (e) {}
        try {
          if (E.timer && typeof cancelBloomFutureVoices === 'function' && typeof Tone !== 'undefined')
            cancelBloomFutureVoices('v2:' + (L.id | 0), Tone.now());
        } catch (e) {}
        try { if (E._v2Phase) delete E._v2Phase['v2:' + (L.id | 0)]; } catch (e) {}
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
        try { drawPartViz(card, L, E); } catch (e) {}
        try {
          showToast('\u2702 Split into ' + made + ' notes \u2014 same total length' +
            (st.pk === 'random' ? (', scattered through the ' + st.ppool + '.')
              : (st.pk !== 'same' ? ', new pitches.' : '.')) +
            (Object.keys(st.pfix).length ? ' ' + Object.keys(st.pfix).length + ' set by hand.' : ''),
            { ms: 3000 });
        } catch (e) {}
        return;
      }
    });
  }

  function popOpen(card, L, grp, tab) {
    // ONLY THIS CARD. It used to close every other layer's sheet — right for a
    // modal over the panel, wrong for an editor that lives in each card's own
    // body.
    popClose(card);
    const g = card.querySelector('.ambient-grp[data-v2grp="' + grp + '"]');
    const body = g && g.querySelector('.ambient-grp-body'); if (!body) return;
    const wrap = document.createElement('div');
    wrap.className = 'v2-pop-wrap';
    wrap.innerHTML =
      '<div class="v2-pop" role="group" aria-label="' + esc(grp) + '">' +
        // THE TITLE IS THE NAVIGATOR. It named the open group and nothing more,
        // so moving between sections meant closing this sheet and finding the
        // next button — a round trip through a grid you had just left. It is a
        // <select> of the seven groups now, current one selected: the same fact
        // the title stated, plus somewhere to go. Safe as a select because the
        // head is built ONCE by popOpen and never rewritten (the documented
        // trap is a select REPLACED while open — popSync only touches the tabs
        // and the pane).
        '<div class="v2-pop-head">' +
          '<div class="v2-pop-title v2-pop-goto" role="tablist" aria-label="Go to a section">' +
            GRPS.map(g2 => '<button type="button" class="v2-gototab' +
              (g2 === grp ? ' on' : '') + '" data-goto="' + esc(g2) + '"' +
              (g2 === grp ? ' aria-current="true"' : '') + '>' + esc(g2) + '</button>').join('') +
          '</div>' +
          // REGISTER, IN THE HEAD. It is the control you reach for while
          // listening — move the whole part an octave — so it sits where it is
          // always to hand instead of behind a tab. It is the ordinary stepper
          // markup, so the DOCUMENT-level ± delegation drives it and the card's
          // own `.v2-f` input handler commits it: no new wiring, and no second
          // copy of either rule. Gated on the voice like any row, because the
          // head is inside the card and `applyGate` sweeps `[data-v2when]`.
          // CONTENT IS PER-PART: the toggle says whether each arrangement part
          // has its own content, and Sync matches the record to the part.
          // WHICH part is NOT asked here — the ⇶ Part strip above the layers
          // already answers it for the whole panel, and a second chooser on
          // every card was the same question asked twice (the duplication this
          // file keeps paying for). The toggle wears the current part's hue so
          // the card still SAYS which one it is on without a control for it.
          ((grp === 'Content')
            ? (() => {
                const pp2 = Number.isFinite(L.partFor);
                // `_masterEng`, NOT `E` — `popOpen(card, L, grp, tab)` has no
                // engine (the idiom `partRangesOf` uses). A bare `E` here
                // threw into the try below and the name silently never
                // appeared: the documented swallowed-catch trap, so the
                // lookup is guarded by `typeof` rather than by a catch.
                // THE SHORT label — the ordinal, and a name only if somebody
                // AUTHORED one. A derived name is the chord numerals, and the
                // ruler under this pill now draws those chords WHERE THEY
                // ARE, so spending the whole row on a list of them said the
                // same thing twice and worse.
                let pnm = '', pfull = '';
                if (pp2 && typeof _masterEng !== 'undefined' && _masterEng &&
                    typeof _ambPartLabel === 'function') {
                  try {
                    const c0 = _masterEng.getCfg();
                    pfull = _ambPartLabel(c0, L.partFor | 0) || '';
                    pnm = (typeof _ambPartLabelShort === 'function'
                      ? _ambPartLabelShort(c0, L.partFor | 0) : pfull) || pfull;
                  } catch (e) { pnm = ''; pfull = ''; }
                }
                return '<span class="v2-pop-pair">' +
                  '<button type="button" class="v2-pop-pp' + (pp2 ? ' on' : '') + '"' +
                    (pp2 && typeof _ambPartAttr === 'function' ? _ambPartAttr(L.partFor | 0) : '') + ' ' +
                    'title="' + (pp2
                      ? esc('Per part \u2014 each arrangement part has its own content for this layer. ' +
                          (pfull ? 'You are editing ' + pfull + ' \u2014 pick another in the Part strip above the layers. ' : '') +
                          'Tap to go back to one content everywhere (the filed parts are dropped, it asks first).')
                      : 'One content \u2014 this layer plays the same content in every part. Tap to give each part its own (nothing changes until a part diverges).') + '">' +
                    (pp2 ? '\u25eb Per part' + (pnm ? ' \u00b7 ' + esc(pnm) : '') : '\u25ad Everywhere') + '</button>' +
                  '<button type="button" class="v2-pop-sync" ' +
                    'title="Match this layer\u2019s length to one pass of ' + (pp2 ? esc(pfull || 'the current part') : 'the changes') +
                    ' \u2014 it says which part, and you choose how the notes and the bars come along">' +
                    '\u21c4 Sync</button>' +
                '</span>';
              })()
            : '') +
          ((grp === 'Instrument')
            ? '<span class="v2-pop-xtra" data-v2when="voice:synth">' +
                '<span class="v2-xtra-lab">Reg</span>' +
                '<span class="ambient-stepper">' +
                  '<button type="button" class="ambient-step-btn ambient-step-dn" tabindex="-1" aria-label="Lower">\u2212</button>' +
                  '<input type="number" inputmode="numeric" class="ambient-step-inp v2-f" ' +
                    'data-f="instrument.register" min="1" max="8" step="1" value="' +
                    (clamp((L.instrument.register | 0) || 4, 1, 8)) + '" aria-label="Register">' +
                  '<button type="button" class="ambient-step-btn ambient-step-up" tabindex="-1" aria-label="Raise">+</button>' +
                '</span></span>'
            : '') +
          // THE SUMMARY TAKES ITS OWN LINE. It was between the title and the
          // close, which left no room for anything else up there and squeezed
          // it to nothing on a phone the moment the head grew a control.
          '<span class="ambient-hint v2-grpsum" data-grp="' + esc(grp) + '"></span></div>' +
        '<div class="v2-pop-tabs"></div>' +
        '<div class="v2-compbanner">\u270e Composing this part \u2014 the tabs and the ' +
          'Material doors wait until you are done. \u2713 Done keeps it \u00b7 \u2715 Cancel ' +
          'discards \u00b7 both are under the grid below.</div>' +
        '<div class="v2-pop-pane"></div>' +
        '<div class="v2-pop-foot"><button type="button" class="v2-pop-preview" ' +
          'title="Hear one cycle of this layer with the current settings — through its own chain, so the FX and level speak too">' +
          '\u25b6 Preview</button></div>' +
      '</div>';
    (card.querySelector(':scope > .ambient-layer-body') || card).appendChild(wrap);
    wrap.querySelector('.v2-pop-pane').appendChild(body);
    // THE DRAWING SITS ABOVE THE TABS. It belongs to the whole sheet, not to
    // one tab, so putting the chooser under it says so: you read the part, then
    // pick what to change about it. It lives in the group BODY (that is what
    // keeps it on the card too), so the sheet lifts it out here and popClose
    // puts it back — a move, not a copy, or the card would show a stale one.
    try {
      const viz = body.querySelector(':scope > .v2-partviz');
      const tabs = wrap.querySelector('.v2-pop-tabs');
      if (viz && tabs && tabs.parentNode) tabs.parentNode.insertBefore(viz, tabs);
    } catch (e) {}
    POPS.set(L.id | 0, { grp: grp, tab: tab || null });
    applyGate(card, L);   // gates the rows and, via its tail, builds the tabs
  }
  // One tab per top-level row; rows sharing a `data-v2tab` (or a bare label)
  // merge into one. A tab is offered only while some row of it survives the
  // gate — the gate can hide the active tab's rows from under it (switch
  // Voice to speech with Tone open), so this re-runs on every applyGate.
  function popTabbables(pane) {
    // The pane holds the MOVED `.ambient-grp-body`; the rows are its children.
    const body = pane.querySelector(':scope > .ambient-grp-body') || pane;
    return [...body.children].filter(n => n.classList &&
      (n.classList.contains('ambient-ctrl') || n.classList.contains('ambient-mod-target')));
  }
  // WHICH GROUP A ROW BELONGS TO, kept ON the row. `popOpen` MOVES a group's
  // whole `.ambient-grp-body` into the sheet, so `row.closest('.ambient-grp')`
  // stops answering the moment a sheet is open — and the finder has to index
  // every row whether or not one is. Stamped once per render; the marks travel
  // with the rows when the body moves.
  function stampGroups(card) {
    card.querySelectorAll('.ambient-grp[data-v2grp]').forEach((g) => {
      const nm = g.getAttribute('data-v2grp');
      const body = g.querySelector(':scope > .ambient-grp-body'); if (!body) return;
      [...body.children].forEach((r) => { if (r.dataset) r.dataset.v2g = nm; });
    });
  }
  // EVERY CONTROL ON THE CARD, as { group, tab, label }. Micro steppers are
  // indexed one entry per CELL (they are five controls in one row) but
  // navigate to the row's tab, which is where they live.
  function findIndex(card) {
    const out = [];
    card.querySelectorAll('[data-v2g]').forEach((r) => {
      const grp = r.getAttribute('data-v2g') || '';
      const tab = popTabName(r);
      const minis = [...r.querySelectorAll('.v2-mini-lab')];
      if (minis.length) {
        minis.forEach((m) => out.push({ grp, tab, lab: (m.textContent || '').trim(), row: r }));
        return;
      }
      const lab = r.querySelector(':scope > label') || r.querySelector('.ambient-mod-sub');
      if (!lab) return;
      const nm = ((lab.childNodes[0] && lab.childNodes[0].textContent) || lab.textContent || '')
        .split('\u00b7')[0].trim();
      if (nm) out.push({ grp, tab, lab: nm, row: r });
    });
    return out;
  }
  const FIND_MAX = 20;   // the variance family alone is 17 — a cap that truncates the query the finder exists for is the wrong cap
  // The few words worth spelling out. Keys are matched WHOLE (a typed term
  // equal to the key), so ordinary substring search is untouched.
  const FIND_SYN = {
    variance: ['vary', 'var', 'roam', 'scatter', 'stutter', 'ghost', 'rest',
               'humanize', 'accent', 'swing', 'tight', 'variety', 'contour', 'chance'],
    random: ['vary', 'var', 'roam', 'scatter', 'stutter', 'ghost', 'chance', 'humanize'],
    timing: ['swing', 'accent', 'humanize', 'tight', 'rate var', 'speed', 'cycle', 'start'],
    harmony: ['key', 'notes', 'transpose', 'follows changes', 'voicing', 'harmony', 'pitch'],
    volume: ['level', 'accent', 'vel var', 'ghosts'],
  };
  function findRender(card, q) {
    const box = card.querySelector('.v2-findres'); if (!box) return;
    const term = String(q || '').trim().toLowerCase();
    if (!term) { box.classList.remove('on'); box.innerHTML = ''; return; }
    // A CATEGORY WORD FINDS THE WHOLE FAMILY. Every control is filed with the
    // thing it modifies, which scatters a category across sheets — the
    // variance controls sit in Content \u25b8 Feel, Content \u25b8 Pattern,
    // Pitch \u25b8 Voicing and Shape \u25b8 Variance — so the word people
    // actually type has to reach all of them. Deliberately a SHORT explicit
    // table, not fuzzy matching: a finder that guesses is worse than one that
    // misses, because you cannot tell a wrong hit from a missing control.
    const terms = (FIND_SYN[term] || [term]);
    const hits = findIndex(card).filter((x) => {
      const hay = (x.lab + ' ' + x.tab + ' ' + x.grp).toLowerCase();
      return terms.some((t) => hay.indexOf(t) >= 0);
    });
    box.classList.add('on');
    if (!hits.length) {
      box.innerHTML = '<div class="v2-findnone">Nothing matches \u201c' + esc(q) + '\u201d</div>';
      return;
    }
    box.innerHTML = hits.slice(0, FIND_MAX).map((x) =>
      '<button type="button" class="v2-findhit" data-fgrp="' + esc(x.grp) + '" data-ftab="' +
        esc(x.tab) + '" data-flab="' + esc(x.lab) + '">' +
        '<span class="v2-findlab">' + esc(x.lab) + '</span>' +
        '<span class="v2-findwhere">' + esc(x.grp) + ' \u25b8 ' + esc(x.tab) + '</span>' +
      '</button>').join('') +
      (hits.length > FIND_MAX ? '<div class="v2-findnone">\u2026and ' + (hits.length - FIND_MAX) +
        ' more \u2014 keep typing</div>' : '');
  }
  function popTabName(row) {
    const t = row.getAttribute('data-v2tab'); if (t) return t;
    const lab = row.querySelector(':scope > label') || row.querySelector('.ambient-mod-sub');
    if (!lab) return '…';
    // first TEXT node only — a label can carry a button (Pattern's ↻), and the
    // mod-sub reads "VCA · amplitude", whose tab is just "VCA".
    const s2 = ((lab.childNodes[0] && lab.childNodes[0].textContent) || lab.textContent || '').trim();
    return (s2.split('·')[0].trim()) || '…';
  }
  // ── TAB FAMILIES — a sheet with a dozen tabs is a wall unless the strip
  // says which tabs belong together. Each family is a labelled, tinted row;
  // a tab not in the map lands in a trailing unlabelled one, so a new tab can
  // never vanish. Hues avoid the state colours (green = sounding, amber =
  // inert-warning, red = delete).
  const TAB_FAMS = {
    // RHYTHM LIVES INSIDE MAKE — rhythm IS how the content is made, so it is
    // one family with a colour seam rather than a separate bar chip (the
    // rhythm tabs keep their teal via TAB_TINT). SAVED is its own chip at the
    // right end: it is the bank, not a step in making this part.
    Content: [
      ['make', ['Material', 'Seed like', 'Rhythm', 'Pattern', 'Feel'], 'fam-make'],
      ['time', ['Cycle', 'Bars', 'Plays', 'Speed'], 'fam-time'],
      ['pitch', ['Transpose', 'Follows changes'], 'fam-pitch'],
      ['saved', ['Bank'], 'fam-saved'],
    ],
  };
  // A tab that keeps its own hue inside a family, and the state that makes it
  // a NO-OP. Rhythm rules shape a GENERATED part; on a Fixed one every row
  // behind these tabs is greyed, so the tab says so too (dimmed — still
  // openable, because the greyed rows explain themselves and an unreachable
  // explanation is the trap this whole pass has been closing).
  const TAB_TINT = { Rhythm: 'fam-rhythm', Pattern: 'fam-rhythm', Feel: 'fam-rhythm' };
  // …and NOT in ▦ Steps, where the grid IS the material and its rules are live
  // by construction — the tab's refusal ("this one is Fixed") would be a
  // statement about the roll, made over a sequencer that is plainly playing.
  const tabNa = (nm, L) => !!TAB_TINT[nm] && L && L.part &&
    L.part.kind === 'recorded' && V2.formOf(L) !== 'steps';
  function popSync(card, L) {
    const wrap = popWrapOf(card); const POP = popStOf(card); if (!wrap || !POP) return;

    const pane = wrap.querySelector('.v2-pop-pane'), tabsEl = wrap.querySelector('.v2-pop-tabs');
    const rows = popTabbables(pane);
    const tabs = [], byName = {};
    rows.forEach(row => {
      const name = popTabName(row);
      let t = byName[name];
      if (!t) { t = byName[name] = { name: name, rows: [], vis: false }; tabs.push(t); }
      t.rows.push(row);
      if (row.style.display !== 'none') t.vis = true;
    });
    const visTabs = tabs.filter(t => t.vis);
    const act = visTabs.find(t => t.name === POP.tab) || visTabs[0] || null;
    POP.tab = act ? act.name : null;
    // TWO-LEVEL STRIP ("the scrollable section is way too small — condense
    // the families into tabs"): a FAMILY BAR of four chips, and only the
    // active family's tab row under it. Every tab stays in the DOM (hidden
    // families included) so programmatic navigation — the goto select, the
    // gate's tab clicks — works unchanged; picking a family jumps to its
    // first tab. Four stacked rows (~250px of a phone sheet) became two.
    const famOfTab = (nm) => {
      const fams0 = TAB_FAMS[POP.grp]; if (!fams0) return null;
      const hit = fams0.find(f2 => f2[1].indexOf(nm) >= 0);
      return hit ? hit[2] : '';
    };
    const actFam = act ? famOfTab(act.name) : null;
    const sig = (POP.grp || '') + '|' + (actFam == null ? '' : actFam) + '|' + visTabs.map(t => t.name).join('|');
    if (tabsEl._sig !== sig) {
      tabsEl._sig = sig;
      const btn = (t) => '<button type="button" class="v2-pop-tab' +
        (TAB_TINT[t.name] ? ' tint-' + TAB_TINT[t.name] : '') +
        (tabNa(t.name, L) ? ' v2-tabna' : '') +
        '" data-tab="' + esc(t.name) + '"' +
        (tabNa(t.name, L) ? ' aria-disabled="true"' +
          ' title="Rhythm shapes a GENERATED part — this one is WRITTEN, so these do nothing until you hand it back to the rules"' : '') +
        '>' + esc(t.name) + '</button>';
      const fams = TAB_FAMS[POP.grp];
      if (fams) {
        const left = visTabs.slice();
        let bar = '', rows = '';
        fams.forEach(([lab, names, cls]) => {
          const mine = left.filter(t => names.indexOf(t.name) >= 0);
          if (!mine.length) return;
          mine.forEach(t => left.splice(left.indexOf(t), 1));
          // A FAMILY THAT NAMES ONE TAB IS A LEVEL WITH NOTHING TO CHOOSE IN
          // IT. "Saved" sat above a single tab "Phrases" — two chips, two
          // words, one list, and the question it produced was "how are they
          // different". They are not: the chip IS the tab. It takes the TAB's
          // name and its `data-tab`, so the `.on` toggle, the goto select and
          // every `[data-tab]` reader find it exactly where they did, and no
          // second row is drawn under it.
          if (mine.length === 1) {
            const t1 = mine[0];
            bar += '<button type="button" class="v2-fambtn v2-pop-tab ' + cls +
              (TAB_TINT[t1.name] ? ' tint-' + TAB_TINT[t1.name] : '') +
              (tabNa(t1.name, L) ? ' v2-tabna' : '') + (cls === actFam ? ' on' : '') +
              '" data-tab="' + esc(t1.name) + '" data-first="' + esc(t1.name) + '"' +
              (tabNa(t1.name, L) ? ' aria-disabled="true"' +
                ' title="Rhythm shapes a GENERATED part \u2014 this one is WRITTEN, so these do nothing until you hand it back to the rules"' : '') +
              '>' + esc(t1.name) + '</button>';
            return;
          }
          bar += '<button type="button" class="v2-fambtn ' + cls + (cls === actFam ? ' on' : '') +
            '" data-first="' + esc(mine[0].name) + '">' + esc(lab) + '</button>';
          rows += '<div class="v2-tabfam ' + cls + (cls === actFam ? ' fam-on' : '') + '">' +
            mine.map(btn).join('') + '</div>';
        });
        if (left.length) {
          bar += '<button type="button" class="v2-fambtn' + (actFam === '' ? ' on' : '') +
            '" data-first="' + esc(left[0].name) + '">more</button>';
          rows += '<div class="v2-tabfam' + (actFam === '' ? ' fam-on' : '') + '">' + left.map(btn).join('') + '</div>';
        }
        tabsEl.innerHTML = '<div class="v2-fambar">' + bar + '</div>' + rows;
      } else {
        tabsEl.innerHTML = visTabs.map(btn).join('');
      }
    }
    tabsEl.querySelectorAll('.v2-pop-tab').forEach(b =>
      b.classList.toggle('on', !!act && b.getAttribute('data-tab') === act.name));
    // THE PANE WEARS THE ACTIVE TAB'S FAMILY — the row labels below take the
    // family hue, so "which family am I in" survives scrolling past the strip.
    {
      const fams2 = TAB_FAMS[POP.grp];
      let famCls = '';
      if (fams2 && act) {
        // a tinted tab (Rhythm/Pattern/Feel inside make) keeps ITS hue, so the
        // pane's row labels match the chip you pressed rather than its family
        if (TAB_TINT[act.name]) famCls = TAB_TINT[act.name];
        else { const hit = fams2.find(f2 => f2[1].indexOf(act.name) >= 0); if (hit) famCls = hit[2]; }
      }
      if (famCls) pane.setAttribute('data-fam', famCls); else pane.removeAttribute('data-fam');
    }
    tabs.forEach(t => t.rows.forEach(row => {
      row.classList.toggle('v2-rowoff', t !== act);
      // THE ROW LABEL IS REDUNDANT WHEN IT REPEATS THE ACTIVE TAB — the tab
      // chip above already names it ("Material" over a row labelled
      // "Material"). Hidden only when the label is PLAIN TEXT: a label can
      // carry a control (the Pattern row's ↻ regen button lives inside its
      // label — the documented trap), and hiding that would take the button
      // with it.
      let dup = false;
      try {
        const lb = row.querySelector(':scope > label');
        dup = !!lb && t === act && (lb.textContent || '').trim() === act.name &&
          !lb.querySelector('button, input, select, a');
      } catch (e) {}
      row.classList.toggle('v2-labdup', dup);
    }));
    knobifyAll(pane);
    pane.querySelectorAll('.v2-knob').forEach(knobFace);
  }
  // ── KNOBS ───────────────────────────────────────────────────────────────
  // A knob is a VISUAL WRAPPER over the row's real <input type=range> — the
  // input is never replaced (the wrap-don't-replace rule that made the touch
  // sliders one handler instead of 120 edits): the knob writes `.value` and
  // dispatches real input/change, so every binding, mirror and gate check
  // works unchanged. Built only inside a sheet; the storage rows keep their
  // sliders.
  function knobifyAll(pane) {
    pane.querySelectorAll('input.ambient-sl').forEach(inp => {
      const row = inp.closest('.ambient-ctrl');
      if (!row || row.classList.contains('v2-knobbed')) return;
      row.classList.add('v2-knobbed');
      const k = document.createElement('div');
      k.className = 'v2-knob';
      // The unit/hint text sits BESIDE the knob, not inside the face — at a
      // compact dial size a sentence inside the circle overflows it, and the
      // giant dial existed mostly to hold its own caption ("dials too large,
      // too much whitespace").
      k.innerHTML = '<div class="v2-knob-ring"></div>' +
        '<div class="v2-knob-face"><span class="v2-knob-val"></span></div>';
      inp.after(k);
      const u = row.getAttribute('data-v2u') || '';
      if (u) {
        const su = document.createElement('span');
        su.className = 'v2-knob-sub'; su.textContent = u;
        k.after(su);
      }
      knobFace(k);
    });
  }
  function knobInputOf(k) {
    const row = k.closest('.ambient-ctrl');
    return row && row.querySelector('input.ambient-sl');
  }
  function knobFace(k) {
    const inp = knobInputOf(k); if (!inp) return;
    const min = +inp.min || 0, max = Number.isFinite(+inp.max) ? +inp.max : 100;
    const v = +inp.value || 0;
    const f = Math.max(0, Math.min(1, (v - min) / ((max - min) || 1)));
    k.querySelector('.v2-knob-ring').style.setProperty('--v2ka', (f * 270) + 'deg');
    const val = k.querySelector('.v2-knob-val');
    if (val && val.textContent !== String(v)) val.textContent = String(v);
  }
  // Tap-with-no-drag opens numeric entry — a knob must never jump on a tap
  // (the mis-tap-wrecks-the-setting rule the sliders already follow).
  function knobEntry(k, inp) {
    if (k.querySelector('.v2-knob-num')) return;
    const n = document.createElement('input');
    n.type = 'number'; n.className = 'v2-knob-num';
    n.min = inp.min; n.max = inp.max; n.step = '1'; n.value = inp.value;
    k.querySelector('.v2-knob-face').appendChild(n);
    try { n.focus(); n.select(); } catch (e) {}
    const done = (commit) => {
      if (n._done) return; n._done = true;
      if (commit) {
        const lo = +inp.min || 0, hi = Number.isFinite(+inp.max) ? +inp.max : 100;
        const v = Math.max(lo, Math.min(hi, Math.round(parseFloat(n.value))));
        if (Number.isFinite(v) && String(v) !== String(inp.value)) {
          inp.value = v;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      n.remove(); knobFace(k);
    };
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    n.addEventListener('blur', () => done(true));
  }

    function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
  function setPath(o, path, v) {
    const ks = path.split('.'), last = ks.pop();
    const tgt = ks.reduce((a, k) => (a[k] = a[k] || {}), o);
    tgt[last] = v;
  }

  let HOST = null;
  function host(E) {
    let h = document.getElementById('bloom-v2-layers');
    if (h && h.isConnected) return h;
    const anchor = document.getElementById((E && E.idPrefix ? E.idPrefix : 'mix-bloom-') + 'extra-layers')
                || document.querySelector('[id$="extra-layers"]');
    if (!anchor || !anchor.parentNode) return null;
    h = document.createElement('div');
    h.id = 'bloom-v2-layers';
    anchor.parentNode.insertBefore(h, anchor.nextSibling);
    return h;
  }

  // Published for the CADENCE editor, which lives in 17 — the length moves
  // there and the content that follows it is v2's to know about.
  // \u2702 Split — published so the gate can ask the ARITHMETIC directly rather
  // than inferring it from the notes the dialog happened to write.
  V2.splitWeights = splitWeights;
  V2.splitPitches = splitPitches;
  V2.splitNote = splitNoteFn;
  V2.cascadeScan = cascadeScanFn;
  V2.cascadeBars = cascadeBarsFn;
  V2.cascadeAsk = cascadeModalFn;
  V2.render = function (E) {
    _cardE = E;
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg) return;
    const list = V2.layers(cfg);
    const h = host(E); if (!h) return;
    if (!list.length) { h.innerHTML = ''; h._sig = ''; POPS.clear(); return; }
    // STRUCTURE SIGNATURE — an innerHTML rewrite destroys the control under the
    // finger, which kills a slider drag after one pixel (the documented trap; it
    // cost a round on the Groove Humanize fader). Only rebuild when the set of
    // cards actually CHANGES; a value edit re-applies the gate in place instead.
    const sig = list.map(L => L.id + ':' + L.name + ':' + L.part.kind + ':' + (L.on ? 1 : 0)).join('|');
    if (h._sig === sig && h.querySelectorAll('.v2-layer').length === list.length) {
      h.querySelectorAll('.v2-layer').forEach(card => {
        const L = list.find(x => x.id === (card.getAttribute('data-v2id') | 0));
        if (L) applyGate(card, L);
      });
      return;
    }
    h._sig = sig;
    // A REBUILD MUST NOT THROW THE PAGE BACK TO THE TOP. Replacing this host's
    // innerHTML empties it for an instant, the document collapses to about a
    // viewport, and the browser CLAMPS the scroll to the new maximum — which
    // is ~0. Re-adding the cards does not put it back. Measured at 390px with
    // two expanded cards: toggling a layer on/off went 900 → 0, every time.
    // Restored at the END of the rebuild, when the cards, their open groups
    // and their sheets are all back and the height with them; the whole thing
    // is one synchronous pass, so nothing is painted in between.
    // …AND THE PAGE IS NOT ALWAYS THE SCROLLER. `#mix-view` is
    // `overflow-y: auto`, so in some states the panel scrolls INSIDE it and
    // the document never moves — the rebuild then clamps the CONTAINER's
    // scrollTop and restoring the document restores nothing (the jump this
    // guard exists for, back in a different scroller). Save BOTH: whichever
    // one is live is the one the collapse clamps.
    const _scroller = scrollerOf(h);
    const _scrollWas = _scroller ? _scroller.scrollTop : 0;
    const _docScroller = document.scrollingElement || document.documentElement;
    const _docScrollWas = (_docScroller && _docScroller !== _scroller) ? _docScroller.scrollTop : null;
    // preserve open/collapsed state across re-renders
    const openIds = new Set([...h.querySelectorAll('.v2-layer:not(.collapsed)')].map(c => c.getAttribute('data-v2id')));
    // ...and which GROUPS are open inside each. Without this a rebuild (any
    // structure change — a rename, a Live/Recorded switch) silently refolds
    // whatever the user had opened, which reads as the card resetting itself.
    const openGrps = new Map();
    h.querySelectorAll('.v2-layer').forEach(c => {
      openGrps.set(c.getAttribute('data-v2id'),
        // Keyed on `data-v2grp`, NOT the head's text — the head now carries a
        // summary that changes as you edit, so its textContent is not an id.
        new Set([...c.querySelectorAll('.ambient-grp.open')].map(g => g.getAttribute('data-v2grp'))));
    });
    // PARK THE DOCKED GRID EDITOR FIRST. `#lane-expander` lives INSIDE this host
    // while a compose session is open, so the rewrite below deletes it outright
    // — and `_placeLaneExpander` then finds nothing to re-dock, so the editor is
    // gone for good (`getElementById` returning null is the tell). This is the
    // documented `_ambRenderExtras` trap in a new host; the fix is the same one:
    // park in the stash, rewrite, re-place.
    let parked = false;
    try {
      const exp = document.getElementById('lane-expander');
      const stash = document.getElementById('lane-expander-stash');
      if (exp && stash && h.contains(exp)) { stash.appendChild(exp); parked = true; }
    } catch (e) {}
    h.innerHTML = list.map(cardHtml).join('');
    h.querySelectorAll('.v2-layer').forEach(card => {
      const id = card.getAttribute('data-v2id') | 0;
      const L = list.find(x => x.id === id); if (!L) return;
      if (openIds.has(String(id))) card.classList.remove('collapsed');
      if (GENPOP === id) card.classList.add('v2-genopen');
      // …and the bar's rules, for the same reason: a rebuild would otherwise
      // shut the panel you are working in. Its rows are BUILT rather than
      // written into the card markup, so the re-open has to rebuild them.
      if (BARPOP && BARPOP.id === id) {
        try {
          const rw = card.querySelector('.v2-barrows'); if (rw) rw._sig = '';
          barpopSync(card, L);
        } catch (e) {}
      }
      const og = openGrps.get(String(id));
      if (og) card.querySelectorAll('.ambient-grp').forEach(g => {
        g.classList.toggle('open', og.has(g.getAttribute('data-v2grp')));
      });
      applyGate(card, L);
      stampGroups(card);
    });
    // A REBUILD DESTROYS AN OPEN SHEET with the card that held it — reopen it
    // on the fresh card, same group, same tab, so a select flipped from inside
    // the sheet (instrument.voice, steps…) does not slam it shut in the hand.
    // (The documented repaint-via-the-sync-path lesson: anything a rebuild
    // throws away must be re-established AFTER the rebuild, by the rebuild.)
    // …and an EXPANDED card always carries one: the editor is the card's body
    // now, so a card with none would render empty. Same group and tab as
    // before the rebuild, else the section that holds the drawing.
    h.querySelectorAll('.v2-layer').forEach((card2) => {
      const id2 = card2.getAttribute('data-v2id') | 0;
      const L2 = list.find(x => (x.id | 0) === id2);
      if (!L2 || card2.classList.contains('collapsed')) return;
      const keep = POPS.get(id2);
      POPS.delete(id2);
      popOpen(card2, L2, (keep && keep.grp) || POP_DEF, keep ? keep.tab : null);
    });
    // Re-dock AFTER the cards exist — `_placeLaneExpander` resolves the target
    // live by key, so it must run against the rebuilt DOM, never before it.
    if (parked) {
      try { if (typeof _placeLaneExpander === 'function') _placeLaneExpander(); } catch (e) {}
      try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
    }
    // MOD WIRING. Per CARD, not delegated: v1's `_ambWireModTarget` binds by
    // ELEMENT (it takes an `el(suffix)` lookup), so it has to run against the
    // rebuilt DOM each time. Guarded by a per-element flag so a rebuild that
    // reuses a node cannot double-bind it (the documented double-handler trap).
    h.querySelectorAll('.v2-layer').forEach((card) => {
      if (card.__v2modWired) return;
      card.__v2modWired = true;
      const id = card.getAttribute('data-v2id') | 0;
      const el = (suf) => document.getElementById('ambient-v2-' + id + '-' + suf);
      const getL = () => { try { return (E.getCfg().layers || []).find(x => x && (x.id | 0) === id) || null; } catch (e) { return null; } };
      // The wiring bails on a missing `L.mod[t]`, so a first touch has to
      // MATERIALISE the matrix from v1's own defaults.
      const ensure = () => {
        const L = getL(); if (!L) return null;
        if (!L.mod || typeof L.mod !== 'object') {
          L.mod = (typeof _ambDefaultMod === 'function') ? _ambDefaultMod() : { sync: 'free' };
        }
        return L;
      };
      const resync = () => {
        try { E.getCfg(); } catch (e) {}
        try { if (typeof _ambSyncMods === 'function') _ambSyncMods(); } catch (e) {}
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      };
      ['vca', 'vco', 'vcf'].forEach((t) => {
        ['depth', 'rate'].forEach((k) => {
          const e2 = el('mod-' + t + '-' + k); if (!e2) return;
          e2.addEventListener('input', () => {
            const L = ensure(); if (!L) return;
            L.mod[t] = L.mod[t] || {};
            L.mod[t][k] = parseInt(e2.value, 10) || 0;
            resync();
          });
        });
        try { if (typeof _ambWireModTarget === 'function') _ambWireModTarget(E, el, ensure, t, resync); } catch (e) {}
      });
      const sy = el('mod-sync');
      if (sy) sy.addEventListener('change', () => { const L = ensure(); if (!L) return; L.mod.sync = sy.value; resync(); });
    });
    if (!h._wired) {
      h._wired = true;
      const layerOf = (el) => {
        const card = el.closest('.v2-layer'); if (!card) return null;
        const c2 = E.getCfg();
        const L = (c2.layers || []).find(x => x && (x.id | 0) === (card.getAttribute('data-v2id') | 0));
        return L ? { L, card } : null;
      };
      const commit = (ctx) => {
        try { E.getCfg(); } catch (e) {}
        applyGate(ctx.card, ctx.L);
        // APPLY NOW, NOT WHEN THE SCHEDULE RUNS DRY — v1's own re-anchor idiom
        // is CANCEL + drop phase, and this commit only had the second half:
        // while playing, notes scheduled with the OLD settings (a full
        // lookahead, and for a long cycle the whole cycle) kept sounding the
        // old instrument, and the re-anchored emit then DOUBLED the overlap.
        // Reported as "changing Instrument tone does not update the content".
        // Sounding notes ring out — only the un-started future is retracted.
        try {
          if (E.timer && typeof cancelBloomFutureVoices === 'function' && typeof Tone !== 'undefined') {
            cancelBloomFutureVoices('v2:' + ctx.L.id, Tone.now());
          }
        } catch (e) {}
        try { if (E._v2Phase) delete E._v2Phase['v2:' + ctx.L.id]; } catch (e) {}   // re-anchor on the next tick
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      };
      h.addEventListener('input', (ev) => {
        // FIND A CONTROL — filter only. This must NEVER call `V2.render`: a
        // re-render replaces the input under the finger and the caret goes
        // with it (the documented Humanize-drag failure, one control over).
        const fi = ev.target.closest && ev.target.closest('.v2-findin');
        if (fi) {
          const c9 = fi.closest('.v2-layer');
          if (c9) findRender(c9, fi.value);
          return;
        }
        // THE EDITING GRID. Display-and-editing only: nothing about what
        // plays changes, so it persists and redraws and does not re-anchor.
        // The note editor is REBUILT, because its Position and Length sliders
        // are ranged in grid cells and a stale range reads the wrong number.
        // ── THE DRAWING'S MODE. Canvas-only: a mode change redraws the
        // picture and never rebuilds the card, which is what makes a <select>
        // safe here (a rebuild mid-pick is the documented trap).
        const msel = ev.target.closest && ev.target.closest('.v2-modepick');
        if (msel) {
          const ctx = layerOf(msel); if (!ctx) return;
          setMode(ctx.L, msel.value);
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          try { multiSync(ctx.card, ctx.L); } catch (e) {}
          return;
        }
        const gsel = ev.target.closest && ev.target.closest('.v2-gridpick');
        if (gsel) {
          const ctx = layerOf(gsel); if (!ctx) return;
          const v = gsel.value | 0;
          if (v === 16) delete ctx.L.part.grid; else ctx.L.part.grid = v;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          try { E.getCfg(); } catch (e) {}
          // ▦ STEPS: the grid is a note VALUE and the CELL COUNT follows it
          // (`bars × grid`), so the surface has to be rebuilt — a repaint alone
          // left 32 cells on screen against a store that said 16, which is the
          // two-pictures-of-one-thing bug in miniature. In ⌗ Roll nothing
          // structural moves: the grid is only what a hand edit snaps to.
          if (V2.formOf(ctx.L) === 'steps') { h._sig = ''; V2.render(E); return; }
          const cG = document.querySelector('.v2-layer[data-v2id="' + (ctx.L.id | 0) + '"]') || ctx.card;
          const hostG = cG && cG.querySelector('.v2-neinline');
          if (hostG && !hostG.hidden) hostG._idx = -1;   // force the rebuild
          try { drawPartViz(cG, ctx.L, E); } catch (e) {}
          try { neSync(cG, ctx.L, E); } catch (e) {}
          return;
        }
        // GO TO ANOTHER SECTION without leaving the sheet. Before every other
        // branch, because it is not a field — it navigates.
        // (WHICH PART this content is for is not asked on the card: the ⇶ Part
        // strip above the layers owns that for the whole panel and sweeps every
        // per-part layer through `partSelect`. The selector that used to sit
        // here was the same question asked twice.)

        // THE NOTE EDITOR, delegated here rather than bound when it is built —
        // the card is rebuilt by `V2.render` on all sorts of edits, and a
        // per-build listener dies with it (the documented host-wiring rule).
        const nsf = ev.target.closest && ev.target.closest('.v2-neinline [data-sf]');
        if (nsf) { if (neInput(E, nsf)) return; }
        // ONE BAR'S OWN RULES. Delegated here for the same reason everything
        // else on this card is: `V2.render` rebuilds the card, and a listener
        // bound when the panel is built dies with it.
        const bfe = ev.target.closest && ev.target.closest('.v2-barpop .v2-bf');
        if (bfe) { if (barInput(E, bfe)) return; }
        const tm = ev.target.closest && ev.target.closest('.v2-term');
        if (tm) {
          const ctx = layerOf(tm); if (!ctx) return;
          ctx.L.term = tm.value;
          try { E.getCfg(); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          return;
        }
        const ta = ev.target.closest && ev.target.closest('.v2-text');
        if (ta) {
          const ctx = layerOf(ta); if (!ctx) return;
          // Written straight through, and the card is NOT rebuilt — a rebuild
          // would replace the textarea under the caret mid-typing.
          ctx.L.instrument.text = ta.value;
          try { E.getCfg(); } catch (e) {}
          applyGate(ctx.card, ctx.L);
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          return;
        }
        const f = ev.target.closest && ev.target.closest('.v2-f'); if (!f) return;
        const ctx = layerOf(f); if (!ctx) return;
        const path = f.getAttribute('data-f');
        const raw = f.value;
        // the PREVIOUS length, captured before the write — "fill" is a ratio and
        // normalize can never know it
        const prevBars = (path === 'part.bars') ? (+ctx.L.part.bars || 0) : 0;
        setPath(ctx.L, path, (f.tagName === 'SELECT' || f.type === 'text') ? raw : (parseFloat(raw) || 0));
        if (path === 'part.bars') { try { V2.applyBarsMode(ctx.L, prevBars); } catch (e) {} }
        // THE KNOBS REDRAW AN EDITED PATTERN — v1's own contract for a
        // hand-edited euclid grid, so the two editors behave alike. The hint
        // under the grid says so, because a silent wipe of drawn cells is
        // exactly the kind of thing that gets reported as data loss.
        const r = ctx.L.part.rhythm;
        if (r.kind === 'drawn' &&
            (path === 'part.rhythm.pulses' || path === 'part.rhythm.rotate' || path === 'part.rhythm.steps')) {
          try { E.getCfg(); } catch (e) {}          // let normalize resize cells to the new Steps first
          V2.seedCells(ctx.L);
          r.kind = 'euclid';                        // back to the formula the knobs just stated
        }
        // THE DRAGGED CONTROL'S OWN READOUT. Nothing else writes it: the
        // delegated slider drag sets `.value` and dispatches events, the
        // sheets' knobs paint their own faces, and the mirror below skips
        // `el2 === f` — so a RAW slider (the Generated and Groundwork panels)
        // moved while its right-gutter number sat on the old value, reported
        // as "some params don't update their readouts".
        try {
          if (f.classList.contains('ambient-sl')) {
            const row0 = f.closest('.ambient-ctrl');
            const rd0 = row0 && row0.querySelector('.ambient-sl-v');
            // …and a field whose number means a RELATIONSHIP says so (Length).
            if (rd0 && typeof _ambSlReadout === 'function') rd0.textContent = (v2Read(path, f.value) != null) ? v2Read(path, f.value) : _ambSlReadout(f.id, f.value);
          }
        } catch (e) {}
        // A FIELD CAN HAVE TWO CONTROLS on this card now (the Generated
        // popover repeats the knobs that shape a shape), and a commit does not
        // rebuild — so without this the copy you are not touching goes stale
        // and the two disagree, which is the documented two-copies-drift bug.
        try {
          ctx.card.querySelectorAll('.v2-f[data-f="' + path + '"]').forEach((el2) => {
            if (el2 === f || el2.value === f.value) return;
            el2.value = f.value;
            const rd = el2.parentElement && el2.parentElement.querySelector('.ambient-sl-v');
            if (rd && typeof _ambSlReadout === 'function') {
              try { const rv = v2Read(path, f.value); rd.textContent = (rv != null) ? rv : _ambSlReadout(el2.id, f.value); } catch (e) {}
            }
          });
        } catch (e) {}
        commit(ctx);
        // Level is a SHARED treatment with two controls; mirror it so the mixer
        // fader follows the card (and push it to the live gain, which is what
        // makes a sweep audible on notes already sounding).
        if (path === 'level') { try { _ambSyncLevelUI(E, 'v2:' + ctx.L.id, ctx.L.level | 0); } catch (e) {} }
        // TREATMENTS APPLY LIVE. These are node/strip params, not note material,
        // so they must be pushed rather than waiting for a re-anchor — that is
        // the whole point of a continuous chain (`_AMB_LIVE_NODE_PARAMS`'s rule
        // in v1: already live on the DSP chain → push, do nothing else).
        // A BUS CHANGE IS A REBUILD, not a push: the chain resolves its output
        // through `_E.busNode(L)` at BUILD time, so the layer has to be torn
        // down and rebuilt to actually move (the documented v1 rule).
        if (path === 'bus') {
          const k3 = 'v2:' + ctx.L.id;
          try { _ambTeardownMod(k3); } catch (e) {}
          try { _ambSyncMods(E); } catch (e) {}
        }
        if (/^(revSend|space|panMode|cutoff|reso|wetOnly)$/.test(path) ||
            /^(delay|dist|chorus|phaser|autopan|glitch|spat|eq)\./.test(path)) {
          const k2 = 'v2:' + ctx.L.id;
          try { _ambApplyLayerFx(k2, ctx.L); } catch (e) {}
          try { _ambApplyLayerPan(k2, ctx.L); } catch (e) {}
        }
        if (path.indexOf('part.rhythm.') === 0 || path === 'part.kind') redrawCells(ctx.card, ctx.L);
        // The lane grid is built from `steps`, and switching instrument changes
        // which grid is on screen — both need the row rebuilt, not just regated.
        if (path === 'instrument.voice' || path === 'part.rhythm.steps' || path === 'part.pitch.kind') { h._sig = ''; V2.render(E); }
        // The gate's pattern length IS its step count, and `_ambNormalizeFx`
        // ALREADY resizes it (pads with 1, truncates to `steps`) on the next
        // getCfg — so v2 must NOT keep a second copy of that rule; a duplicate
        // that pads differently is exactly how the two come to disagree. Only
        // the row needs rebuilding, so the grid follows the number above it.
        if (path === 'tg.steps') { h._sig = ''; V2.render(E); }
      });

      // KNOB DRAG — delegated once, so knobs are pure markup that any rebuild
      // can recreate with nothing to double-bind. Delta-based from the press
      // (a tap must never jump the value), vertical travel = coarse, and
      // horizontal DISTANCE slows it for fine work — the touch-slider rule,
      // rotated 90°. Cumulative travel arms the drag (the per-move-delta
      // mistake is documented: slow drags never cross a per-move threshold).
      h.addEventListener('pointerdown', (ev) => {
        const k = ev.target.closest && ev.target.closest('.v2-knob'); if (!k) return;
        if (ev.target.closest('.v2-knob-num')) return;   // typing in the entry
        const inp = knobInputOf(k); if (!inp) return;
        ev.preventDefault();
        try { k.setPointerCapture(ev.pointerId); } catch (e) {}
        const min = +inp.min || 0, max = Number.isFinite(+inp.max) ? +inp.max : 100;
        const span = (max - min) || 1;
        const sx = ev.clientX, sy = ev.clientY, sv = +inp.value || 0;
        let moved = 0;
        const mv = (e2) => {
          const dy = sy - e2.clientY, dx = e2.clientX - sx;
          moved = Math.max(moved, Math.hypot(dx, dy));
          const fine = 1 / (1 + Math.abs(dx) / 120);
          let v = Math.round(sv + dy * (span / 200) * fine);
          v = Math.max(min, Math.min(max, v));
          if (String(v) !== String(inp.value)) {
            inp.value = v;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            knobFace(k);
          }
        };
        const up = () => {
          k.removeEventListener('pointermove', mv);
          if (moved < 6) knobEntry(k, inp);
          else inp.dispatchEvent(new Event('change', { bubbles: true }));
        };
        k.addEventListener('pointermove', mv);
        k.addEventListener('pointerup', up, { once: true });
        k.addEventListener('pointercancel', up, { once: true });
      });

      // ✎ ADD A NOTE WHERE THE HAND SAYS — shared by the PENCIL (pointerdown,
      // press-drag-to-size) and the click path (synthetic clicks in probes),
      // so the two cannot drift. The pitch comes from the CLICKED ROW, which
      // is SOUNDING space: on a harmony-remapping part the note is PINNED
      // (`hx`) so it lands and STAYS exactly on that row; under a plain
      // transpose the stored value is corrected by the uniform shift after
      // one redraw (never a second copy of the transpose math — the drawn
      // note itself says where it landed). A generated part locks first,
      // data only — the caller decides when to rebuild.
      const penAdd = (E2, L, cvz, px, py) => {
        const pg = cvz._pitchGeo, pl = cvz._plotGeo;
        if (!pg || !pl || !pl.cyc) return null;
        if (px < pl.x0 || py < pg.top) return null;
        let locked = false;
        if (L.part.kind !== 'recorded') {
          if (!captureShown(E2, L)) {
            try { if (typeof showToast === 'function') showToast(
              'Nothing to draw into yet — press 🎲 New take first.', { ms: 3500 }); } catch (e) {}
            return null;
          }
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          try { if (typeof showToast === 'function') showToast(
            '🔒 Locked this take so notes can be drawn into it. 🔓 Unlock hands it back to the rules.',
            { ms: 4500 }); } catch (e) {}
          locked = true;
        }
        const g2 = neGrid(L), cell = 1 / Math.max(1, g2.gridN);
        // FLOOR, not round: the pencil fills the cell UNDER the hand
        // THROUGH THE VIEWPORT — `px` is where the finger is, and with only
        // part of the cycle on screen that is not the same fraction of the
        // cycle it used to be (an un-mapped press drew the note back at the
        // start of the part).
        const vsc = (pl.vsc > 0) ? pl.vsc : 1, f0 = pl.f0 || 0;
        const fr = f0 + ((px - pl.x0) / Math.max(1, pl.w)) * vsc;
        const t = clamp(Math.floor(fr / cell + 1e-6) * cell, 0, 1 - cell);
        const row = clamp(pg.hiM - Math.floor((py - pg.top) / Math.max(1, pg.rowH)), 0, 127);
        const nn = { t: t, midi: row, dur: cell };
        if (L.harmony === 'diatonic' || L.harmony === 'chordlock') nn.hx = 1;
        L.part.notes.push(nn);
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
        try { E2.getCfg(); } catch (e) {}              // coerce, prune, RE-SORT
        try { if (E2._v2Phase) delete E2._v2Phase['v2:' + (L.id | 0)]; } catch (e) {}
        let idx = nearestNote(L.part.notes, t, row);
        try {
          const cA = document.querySelector('.v2-layer[data-v2id="' + (L.id | 0) + '"]');
          if (cA) drawPartViz(cA, L, E2);
          const hb = (cvz._hits || []).find((x) => x.i === idx);
          const gotRow = hb ? Math.round(hb.midi) : row;
          if (gotRow !== row && idx >= 0 && L.part.notes[idx] && !L.part.notes[idx].hx) {
            const m2 = clamp((L.part.notes[idx].midi | 0) + (row - gotRow), 0, 127);
            L.part.notes[idx].midi = m2;
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            try { E2.getCfg(); } catch (e) {}
            idx = nearestNote(L.part.notes, t, m2);
            if (cA) drawPartViz(cA, L, E2);
          }
        } catch (e) {}
        const nf = idx >= 0 ? L.part.notes[idx] : null;
        return { idx: idx, t: nf ? nf.t : t, midi: nf ? nf.midi : row, locked: locked };
      };

      // ── DRAG A NOTE: MOVE IT, OR RESIZE IT ───────────────────────────────
      // The drawing stops being a picture you edit through sliders. What makes
      // it a drag rather than a tap is CUMULATIVE travel past a threshold (the
      // per-move-delta mistake is documented — a slow drag never crosses one),
      // and a gesture that never gets there behaves exactly like a tap.
      //
      // THE ORDER HERE IS LOAD-BEARING: hit-test FIRST, against the picture the
      // finger actually landed on, and only then lock. A live part is rebuilt
      // by the lock and its drawing re-sizes, so a hit test against the NEW
      // canvas at the OLD coordinates misses the note by ~27px and the drag
      // silently never arms — measured, and it is why "still jumping around"
      // survived the first attempt at this.
      h.addEventListener('pointerdown', (ev) => {
        let cvd = ev.target.closest && ev.target.closest('.v2-vizcv'); if (!cvd) return;
        // `layerOf`, not `layersOf` — the latter is ENGINE-side and this
        // handler is in the UI IIFE (the file is two of them, sharing only
        // `window._v2`). The bare name threw into the surrounding try.
        const ctxD = layerOf(cvd); if (!ctxD) return;
        let card = ctxD.card, L = ctxD.L;
        if (!L || !L.part) return;
        if (vmRefuse(cvd)) return;   // another part's record is drawn — read-only

        // 1 · WHAT IS UNDER THE FINGER, in the picture as it stands.
        const geo0 = cvd._plotGeo, pg0 = cvd._pitchGeo;
        if (!geo0 || !pg0 || !geo0.cyc) return;
        const r0 = cvd.getBoundingClientRect();
        const px = ev.clientX - r0.left, py = ev.clientY - r0.top;
        if (px < geo0.x0) return;                      // the keyboard is its own control
        let hit = null;
        const hits0 = cvd._hits || [];
        for (let i = 0; i < hits0.length; i++) {
          const b2 = hits0[i];
          // a generous box — a 6px note is under the touch floor, so the hit
          // area is padded rather than the drawing made clumsy
          if (px >= b2.x - 4 && px <= b2.x + b2.w + 4 &&
              py >= b2.y - 7 && py <= b2.y + b2.h + 7) { hit = b2; break; }
        }
        let mode, locked = false, idx = -1, pen = 0;
        if (!hit) {
          // ✎ THE PENCIL. In draw mode, a press on empty plot space PLACES a
          // note exactly on the clicked row and cell, dragging right SIZES
          // it, release commits — direct drawing, not tap-then-edit. Empty
          // space outside draw mode still belongs to the click handler
          // (bar select), and the ruler strip is nobody's target.
          if (modeOf(L) !== 'draw' || py < pg0.top) return;
          const made = penAdd(E, L, cvd, px, py);
          if (!made || made.idx < 0) return;
          mode = 'pen'; pen = 1; locked = made.locked; idx = made.idx;
        } else {
          // THE RESIZE ZONE IS RELATIVE TO THE NOTE, never a fixed width: a
          // 10px grip on a 12px note is the whole note (the lane-handle
          // lesson).
          const edge = Math.max(4, Math.min(10, hit.w * 0.35));
          mode = (px >= hit.x + hit.w - edge) ? 'len' : 'move';

          // 2 · A LIVE PART LOCKS ON THE GRAB — the same act a TAP on a note
          // already performs, brought forward so the gesture can do anything
          // at all. Before this a drag on a live part did NOTHING (there are
          // no stored notes to move) and the release then locked and rebuilt
          // the card, so the picture only moved once you let go.
          if (L.part.kind !== 'recorded') {
            if (!captureShown(E, L)) return;           // nothing rolled yet
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            try { if (typeof showToast === 'function') showToast(
              '🔒 Locked this take so its notes can be moved — ' +
              (L.part.notes || []).length + ' notes. 🔓 Unlock hands it back to the rules.',
              { ms: 4500 }); } catch (e) {}
            // The lock writes the DATA only — the card rebuild is DEFERRED to
            // pointerup. Rebuilding here replaces the canvas mid-gesture, and
            // TOUCH events stay bound to the element the finger landed on: a
            // detached canvas has no ancestors, so the host's touchmove guard
            // below never fires and the browser pans the page straight
            // through the drag (measured: the drag died after 2 rows and the
            // page scrolled away — "the note block skips around
            // vertically"). The drawn take IS the locked take, so the
            // picture needs no redraw yet.
            locked = true;
          }
          if (!Array.isArray(L.part.notes) || !L.part.notes.length) return;
          // THE HIT BOX KNOWS WHICH NOTE IT IS (`hit.i` = the note's own
          // index) — use it. `nearestNote` compares the hit's DRAWN pitch
          // against STORED midis, and under a harmony remap the nearest
          // stored note can be a NEIGHBOUR of the one grabbed — which was
          // then dragged and pitch-rebased instead: "dragging a note changes
          // notes it comes close to". Only a grab that just LOCKED (the
          // array was rebuilt by the capture) still re-finds by what it is.
          if (!locked && Number.isFinite(hit.i) && L.part.notes[hit.i]) idx = hit.i | 0;
          else { idx = nearestNote(L.part.notes, hit.t, hit.midi); if (idx < 0) return; }
        }
        const n0 = L.part.notes[idx]; if (!n0) return;

        // 3 · FREEZE THE AXIS, EXACTLY AS DRAWN, FROM THE PRESS. The window
        // follows the notes' own range, so dragging one would move the very
        // thing that defines where it is drawn (measured: `loM` walked
        // 59 → 71 mid-drag while the value tracked perfectly). Frozen with
        // NO widening and NO growth: the geometry the pointer landed on IS
        // the geometry the whole gesture works in — nothing resizes, nothing
        // shifts, nothing scrolls (the stated contract; the grow-and-absorb
        // dance this replaces was itself the reported bug, three times). The
        // cost is stated: a note cannot leave the drawn window in one
        // gesture — release and re-grab, and the window re-derives with the
        // note at its edge. The GAIN is the drawn row for a mouse (1:1 —
        // the block tracks the cursor exactly, one half-step per row) and is
        // floored at 9px for a finger, where a 5px row is below what a
        // fingertip can place — the block then moves slightly slower than
        // the finger, which is the price of precision without a resize.
        const pgA = cvd._pitchGeo || pg0;
        const gain = (ev.pointerType === 'touch')
          ? Math.max(pgA.rowH || 1, 9) : Math.max(pgA.rowH || 1, 1);
        // THE WINDOW IS IN SOUNDING-PITCH SPACE and `n.midi` is STORED pitch —
        // transpose and register sit between them (a hit box carries the DRAWN
        // midi, the documented float-after-transpose). Clamping the stored
        // value against the drawn window pinned a transposed layer's drag to
        // the wrong rows entirely (caught by the gate: a +2 shift left the
        // note stuck at "61" in a 61..87 window while the store said 60). The
        // offset is measured at the grab, where both spaces name one note.
        const off = Math.round(((hit && Number.isFinite(hit.midi)) ? hit.midi : n0.midi) - n0.midi);
        // ⬚ MULTI — a drag that STARTS on a gathered note moves or resizes the
        // WHOLE gathering, uniformly. Every note's origin is captured at the
        // press (an index is only good until the next `getCfg`, and the commit
        // waits for pointerup, so within the gesture indices are stable), and
        // the delta is clamped ONCE against the whole set — clamping each note
        // independently would let the leading one stop while the rest carried
        // on, which is the opposite of uniform. A drag that starts on a note
        // that is NOT gathered is an ordinary single-note drag.
        let group = null;
        if (modeOf(L) === 'multi' && !pen) {
          const sel = mselOf(L);
          if (sel && sel.has(idx) && sel.size > 1) {
            group = [...sel].filter((i) => L.part.notes[i]).map((i) => ({
              i: i, t0: L.part.notes[i].t, m0: L.part.notes[i].midi | 0, d0: L.part.notes[i].dur,
            }));
            if (group.length < 2) group = null;
          }
        }
        DRAG = { id: L.id | 0, idx: idx, mode: mode, locked: locked, pen: pen,
                 sx: ev.clientX, sy: ev.clientY,
                 t0: n0.t, m0: n0.midi, d0: n0.dur, moved: 0,
                 gain: gain, off: off, group: group,
                 win: { loM: pgA.loM, hiM: pgA.hiM } };
        cvd._dragGain = gain;                          // probes read the resolution here

        const g = neGrid(L), cell = 1 / Math.max(1, g.gridN);
        const geo = cvd._plotGeo || geo0;
        const mv = (e2) => {
          if (!DRAG) return;
          const dx = e2.clientX - DRAG.sx, dy = e2.clientY - DRAG.sy;
          DRAG.moved = Math.max(DRAG.moved, Math.hypot(dx, dy));
          if (DRAG.moved < 5) return;                  // still a tap
          if (e2.cancelable) e2.preventDefault();
          const n = L.part.notes[DRAG.idx]; if (!n) return;
          // ONE GESTURE, ONE AXIS. A move is horizontal OR vertical — decided
          // by the dominant travel at the arm, held for the whole gesture —
          // never both at once: with both axes live, a horizontal drag's hand
          // wobble flipped rows and a vertical one walked grid cells ("moving
          // vertically and horizontally should be totally independent"). A
          // diagonal intent is two gestures, each exact.
          if (DRAG.mode === 'move' && !DRAG.axis)
            DRAG.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          // ON A HARMONY-REMAPPED PART, THE HAND WINS: chordlock/diatonic
          // quantize the sounding pitch, so a semitone of drag moved the
          // drawn block not at all and then two rows — "still skipping
          // around", with the gutter mark rows away. The first armed move
          // PINS the note (`hx`): its stored midi is rebased to the pitch
          // DRAWN at the grab (so nothing jumps), and from there the drag is
          // exact — stored IS sounding, one row per detent, and the note
          // STAYS where it is dropped.
          if (!DRAG.pinned && DRAG.mode === 'move' &&
              (L.harmony === 'diatonic' || L.harmony === 'chordlock')) {
            DRAG.pinned = 1;
            if (DRAG.group) {
              // …for the WHOLE gathering. Pinning only the grabbed note would
              // leave the rest quantized back toward the chord, i.e. the shape
              // would not survive the move — which is the one thing multi is
              // for. Each is rebased to the pitch DRAWN for it, so nothing
              // jumps, and the origins are re-read from the pinned values.
              const byI = {};
              (cvd._hits || []).forEach((b3) => { if (Number.isFinite(b3.i)) byI[b3.i | 0] = b3; });
              DRAG.group.forEach((q) => {
                const n2 = L.part.notes[q.i]; if (!n2) return;
                const b3 = byI[q.i];
                n2.hx = 1;
                n2.midi = clamp(Math.round(b3 && Number.isFinite(b3.midi) ? b3.midi : n2.midi), 0, 127);
                q.m0 = n2.midi;
              });
              DRAG.off = 0;
            } else {
              n.hx = 1;
              n.midi = clamp(Math.round(Number.isFinite(hit.midi) ? hit.midi : n.midi), 0, 127);
              DRAG.m0 = n.midi; DRAG.off = 0;
            }
          }
          // px → cycle fraction, THROUGH THE VIEWPORT: with four bars of a
          // twelve-bar part on screen a pixel is a third of the time it was.
          const dt = (dx / Math.max(1, geo.w)) * ((geo.vsc > 0) ? geo.vsc : 1);
          // ⬚ MULTI — the SAME delta on every gathered note. Computed in whole
          // cells / whole rows so the gathering keeps its shape exactly, and
          // clamped once for the set (see the press).
          if (DRAG.group) {
            const G = DRAG.group;
            if (DRAG.mode === 'len') {
              let k = Math.round(dt / cell);
              const minK = Math.min(...G.map((q) => Math.round(q.d0 / cell)));
              const room = Math.min(...G.map((q) => Math.floor((1 - q.t0) / cell) - Math.round(q.d0 / cell)));
              k = clamp(k, 1 - minK, Math.max(0, room));
              G.forEach((q) => { const n2 = L.part.notes[q.i]; if (!n2) return;
                n2.dur = Math.max(cell, Math.min(1 - n2.t, Math.round(q.d0 / cell) * cell + k * cell)); });
            } else {
              if (DRAG.axis !== 'y') {
                let k = Math.round(dt / cell);
                const loK = Math.min(...G.map((q) => Math.round(q.t0 / cell)));
                const hiK = Math.max(...G.map((q) => Math.round(q.t0 / cell)));
                const maxK = Math.max(0, Math.round((1 - cell / 2) / cell));
                k = clamp(k, -loK, maxK - hiK);
                G.forEach((q) => { const n2 = L.part.notes[q.i]; if (!n2) return;
                  n2.t = clamp(Math.round(q.t0 / cell) * cell + k * cell, 0, 0.99999); });
              }
              if (DRAG.axis !== 'x') {
                // the SAME detent the single drag uses — a hand wobble at a
                // 6px row must not flicker the whole gathering
                const raw = -dy / DRAG.gain;
                let k = DRAG.k | 0;
                while (raw >= k + 0.85) k++;
                while (raw <= k - 0.85) k--;
                const loM = Math.min(...G.map((q) => q.m0)), hiM = Math.max(...G.map((q) => q.m0));
                k = clamp(k, Math.ceil(DRAG.win.loM - DRAG.off) - loM,
                             Math.floor(DRAG.win.hiM - DRAG.off) - hiM);
                DRAG.k = k;
                G.forEach((q) => { const n2 = L.part.notes[q.i]; if (!n2) return;
                  n2.midi = clamp(q.m0 + k, 0, 127); });
              }
            }
            try {
              const cNow2 = document.querySelector('.v2-layer[data-v2id="' + (L.id | 0) + '"]');
              if (cNow2) card = cNow2;
              drawPartViz(card, L, E);
            } catch (e) {}
            return;
          }
          if (DRAG.mode === 'len' || DRAG.mode === 'pen') {
            // never shorter than one cell, never past the end of the cycle
            const want = Math.round((DRAG.d0 + dt) / cell) * cell;
            n.dur = Math.max(cell, Math.min(1 - n.t, want));
          } else {
            if (DRAG.axis !== 'y')
              n.t = clamp(Math.round((DRAG.t0 + dt) / cell) * cell, 0, 1 - cell / 2);
            if (DRAG.axis !== 'x') {
              // TOTAL displacement from the press, through a DETENT: plain
              // round() flips at every half-row boundary, and a 1-2px hand
              // wobble at a 6px row made the note flicker between two rows —
              // "still skips around vertically". The row changes only 0.85 of
              // a row past the current one. THE NUMBER THAT MATTERS IS THE GAP
              // BETWEEN ADJACENT THRESHOLDS, 2·0.85−1 = 0.7 rows (~4.4px): a
              // first cut at 0.6 left a 0.2-row gap and ±2px of jitter parked
              // near a boundary still straddled both thresholds and flickered
              // (measured 71,70,71,70…). Holding still IS still now; one
              // deliberate row of travel is still one half-step. CLAMPED TO
              // THE FROZEN WINDOW (in stored space, via the drawn-pitch
              // offset), not 0..127 — the picture is not re-scaling, so a note
              // dragged past its edge would be drawn outside the plot.
              const raw = -dy / DRAG.gain;
              let k = DRAG.k | 0;
              while (raw >= k + 0.85) k++;
              while (raw <= k - 0.85) k--;
              DRAG.k = k;
              n.midi = clamp((DRAG.m0 | 0) + k,
                             Math.ceil(DRAG.win.loM - DRAG.off),
                             Math.floor(DRAG.win.hiM - DRAG.off));
            }
          }
          // REDRAW ONLY. `getCfg` normalizes, which REPLACES every note object
          // and re-sorts — mid-drag that invalidates the index under the
          // finger — so the commit waits for pointerup.
          try {
            const cNow = document.querySelector('.v2-layer[data-v2id="' + (L.id | 0) + '"]');
            if (cNow) card = cNow;
            drawPartViz(card, L, E);
          } catch (e) {}
        };
        const up = () => {
          document.removeEventListener('pointermove', mv);
          const d = DRAG; DRAG = null;
          // the lock's card rebuild, deferred out of the press so the
          // touch stream (and the finger's view of the page) survived it.
          const rerender = function () {
            if (!d || !d.locked) return;
            try { h._sig = ''; V2.render(E); } catch (e) {}
            try {
              const cNow = document.querySelector('.v2-layer[data-v2id="' + (L.id | 0) + '"]');
              if (cNow) card = cNow;
            } catch (e) {}
          };
          try {
            const cNow = document.querySelector('.v2-layer[data-v2id="' + (L.id | 0) + '"]');
            if (cNow) card = cNow;
          } catch (e) {}
          if (!d || d.moved < 5) {                     // a tap, not a drag
            // nothing grew and nothing scrolled — there is nothing to undo
            rerender();
            // …and if the grab LOCKED the part, no `click` follows a rebuild,
            // so the up-handler opens the editor itself. A tap on a note
            // means the same thing either way. A PENCIL tap already made its
            // note, so it opens too — and stamps the click suppressor, or
            // the click handler's own draw path would add a SECOND note.
            if (d && (d.locked || d.pen)) { try { neOpen(E, L, d.idx, card); } catch (e) {} }
            if (d && d.pen) cvd._dragged = Date.now();
            return;
          }
          cvd._dragged = Date.now();                   // …and it must not also click
          const n = L.part.notes[d.idx];
          const t = n ? n.t : 0, midi = n ? n.midi : 0;
          // THE GATHERING IS RE-FOUND BY IDENTITY too — the normalize below
          // replaces every note object and RE-SORTS, so a moved set's indices
          // are stale the instant it runs, and the gathering would silently
          // come to name different notes than the ones on screen.
          const gid = (d && d.group)
            ? d.group.map((q) => { const n2 = L.part.notes[q.i];
                return n2 ? { t: n2.t, midi: n2.midi } : null; }).filter(Boolean) : null;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          try { E.getCfg(); } catch (e) {}             // coerce, prune, RE-SORT
          if (gid) {
            const nx = new Set();
            gid.forEach((q) => { const j = nearestNote(L.part.notes, q.t, q.midi); if (j >= 0) nx.add(j); });
            mselSet(L, nx);
          }
          if (NE && NE.id === (L.id | 0)) NE.idx = nearestNote(L.part.notes, t, midi);
          try { if (E._v2Phase) delete E._v2Phase['v2:' + (L.id | 0)]; } catch (e) {}
          rerender();
          try { drawPartViz(card, L, E); } catch (e) {}
          try { neSync(card, L, E); } catch (e) {}
        };
        // ON THE DOCUMENT, not the canvas: the pointer leaves the canvas the
        // moment the drag scrolls or outruns it, and a card can still be
        // rebuilt under the gesture by something else — a document listener
        // survives both where one bound to the element would be bound to a
        // corpse.
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', up, { once: true });
        document.addEventListener('pointercancel', up, { once: true });
      });

      // NATIVE PAN MUST NOT FIGHT THE NOTE GESTURE. The canvas carries
      // `touch-action: manipulation`, which ALLOWS single-finger panning — so
      // on a phone a vertical note-drag also scrolled the page: ~2 rows in,
      // the browser committed to the pan, cancelled the pointer stream, and
      // the canvas slid away under the finger (measured midi deltas
      // -1,-1,0,0,0,0 with the scroll walking). `preventDefault` on
      // pointermove cannot stop a touch pan; only a NON-PASSIVE touchmove
      // can, and it must refuse from the FIRST move or the browser has
      // already taken the gesture. `DRAG` is set in pointerdown, which
      // precedes every touchmove, so the guard is exact: a gesture that
      // starts on a NOTE belongs to the note, and a swipe from empty canvas
      // (DRAG null) still scrolls the page. This is also why the lock above
      // must not rebuild the card mid-gesture — touch events stay bound to
      // the element the finger landed on, and a detached canvas has no
      // ancestors for this host listener to hear through.
      h.addEventListener('touchmove', (ev) => {
        if (DRAG && ev.cancelable) ev.preventDefault();
      }, { passive: false });

      // ── KEYBOARD: MOVE AND RESIZE THE OPEN NOTE ──────────────────────────
      // While the note editor is open: ⇧ + arrows MOVE the note (←/→ one
      // grid cell, ↑/↓ one half-step) and ⌥ + ←/→ RESIZE it by a cell.
      // ⇧ REPLACED ⌃ as the primary chord (user: "the arrow keys are not
      // working — make it shift+arrows"): ⌃←/→ is the macOS Spaces shortcut
      // by default, so on most Macs the browser never saw half the pairs and
      // the feature read as broken. ⌃ still works where the system lets it
      // through. Routed through `neApply`, so the pin, the sounding-space
      // pitch, the persist/re-find and the redraw are the SAME as every other
      // editor path — a hotkey is a fourth door to the same three fields,
      // never a fifth implementation. On the DOCUMENT with a window guard
      // (the wiring can run more than once, and a doubled key handler double-
      // steps); the engine is resolved at press time, never captured.
      if (!window.__v2NoteKeys) {
        window.__v2NoteKeys = 1;
        document.addEventListener('keydown', (ev) => {
          try {
            if (!NE) return;
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' &&
                ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
            // NEVER while typing: ⇧+arrow extends a text selection, and a
            // field or search box must keep that.
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
                       ae.tagName === 'SELECT' || ae.isContentEditable)) return;
            const wantMove = (ev.shiftKey || ev.ctrlKey) && !ev.altKey && !ev.metaKey;
            const wantSize = ev.altKey && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey &&
                             (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight');
            if (!wantMove && !wantSize) return;
            const E2 = (typeof _masterEng !== 'undefined') ? _masterEng : null;
            if (!E2) return;
            const card = document.querySelector('.v2-layer[data-v2id="' + (NE.id | 0) + '"]');
            const host = card && card.querySelector('.v2-neinline');
            if (!host || host.hidden) return;
            const L = _ambLayerByKey && _ambLayerByKey(E2, 'v2:' + NE.id);
            if (!L || !L.part || L.part.kind !== 'recorded') return;
            const n = L.part.notes[NE.idx]; if (!n) return;
            ev.preventDefault(); ev.stopPropagation();
            const g2 = neGrid(L);
            if (wantSize) {
              const cur = n.dur * g2.gridN;
              const len = Math.max(1, Math.round(cur));
              const nl = Math.max(1, Math.min(g2.gridN * 2,
                (ev.key === 'ArrowRight' ? Math.floor(cur + 1e-6) + 1
                                         : Math.ceil(cur - 1e-6) - 1)));
              if (nl !== len) neApply(E2, host, 'len', nl, true);
              return;
            }
            if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
              // SOUNDING space, exactly as the ± stepper — one press, one row
              const m = neShownMidi(host, L, NE.idx);
              const m2 = clamp(m + (ev.key === 'ArrowUp' ? 1 : -1), 0, 127);
              if (m2 !== m) neApply(E2, host, 'midi', m2, true);
              return;
            }
            const st = Math.round(n.t * g2.gridN);
            const ns = Math.max(0, Math.min(g2.gridN - 1,
              st + (ev.key === 'ArrowRight' ? 1 : -1)));
            if (ns !== st) neApply(E2, host, 'pos', ns, true);
          } catch (e) {}
        });
      }

      // A press inside a card that is composing, on anything that would
      // navigate away from the dock, refuses and says how to finish.
      const composeBlocks = (t) => {
        const c = t && t.closest && t.closest('.v2-layer.v2-composing');
        if (!c) return false;
        if (t.closest('.v2-compose')) return false;   // the way OUT of the mode
        if (!(t.closest('.v2-gototab') || t.closest('.v2-pop-tab') ||
              t.closest('.v2-fambtn') || t.closest('.v2-notesrow .ambient-seg'))) return false;
        try {
          showToast('\u270e You are composing this part \u2014 finish first: \u2713 Done keeps ' +
            'what you drew, \u2715 Cancel discards it. Both are under the grid.', { ms: 5000 });
        } catch (e) {}
        return true;
      };
      h.addEventListener('click', (ev) => {
        if (composeBlocks(ev.target)) { ev.stopPropagation(); return; }
        // SECTION TABS in the sheet head — six groups filling one row, so the
        // current section and every other one are visible at once. Was a
        // <select>, which showed only the section you were already in.
        const gt = ev.target.closest && ev.target.closest('.v2-gototab');
        if (gt) {
          const ctx = layerOf(gt); if (!ctx) return;
          const want = gt.getAttribute('data-goto');
          if (want && want !== (popStOf(ctx.card) || {}).grp) popOpen(ctx.card, ctx.L, want, null);
          return;
        }
        // A HIT NAVIGATES. `popOpen` is the same call the group buttons and the
        // sheet's own section navigator make, so the finder can never open a
        // surface the rest of the card cannot.
        const fh = ev.target.closest && ev.target.closest('.v2-findhit');
        if (fh) {
          const ctx = layerOf(fh); if (!ctx) return;
          const grp = fh.getAttribute('data-fgrp'), tab = fh.getAttribute('data-ftab');
          const lab = fh.getAttribute('data-flab') || '';
          popOpen(ctx.card, ctx.L, grp, tab);
          // MARK WHAT YOU CAME FOR. Landing on the right tab still leaves you
          // scanning it — a tab can hold ten rows — so the row flashes.
          setTimeout(() => {
            try {
              const pane = ctx.card.querySelector('.v2-pop-pane'); if (!pane) return;
              const rows = [...pane.querySelectorAll('[data-v2g]')];
              const hit = rows.find((r) => {
                if ([...r.querySelectorAll('.v2-mini-lab')].some(m => (m.textContent || '').trim() === lab)) return true;
                const lb = r.querySelector(':scope > label') || r.querySelector('.ambient-mod-sub');
                if (!lb) return false;
                const nm = ((lb.childNodes[0] && lb.childNodes[0].textContent) || lb.textContent || '')
                  .split('\u00b7')[0].trim();
                return nm === lab;
              });
              if (!hit) return;
              try { hit.scrollIntoView({ block: 'center' }); } catch (e) {}
              hit.classList.add('v2-findmark');
              setTimeout(() => hit.classList.remove('v2-findmark'), 1600);
            } catch (e) {}
          }, 60);
          const inp = ctx.card.querySelector('.v2-findin');
          const box = ctx.card.querySelector('.v2-findres');
          if (inp) inp.value = '';
          if (box) { box.classList.remove('on'); box.innerHTML = ''; }
          return;
        }
        const t = ev.target;
        // The editor's own chrome runs before every other branch so nothing
        // inside it can fall through to the header's collapse catch-all.
        const ptab = t.closest && t.closest('.v2-pop-tab');
        if (ptab) {
          const ctx = layerOf(ptab); const POP = popStOf(ctx && ctx.card);
          if (!ctx || !POP) return;
          // A NO-OP TAB REFUSES AND EXPLAINS. It used to open onto greyed rows
          // carrying the same sentence; a press that visibly does nothing is
          // worse than one that answers, so the explanation moved to the
          // press itself and the tab no longer navigates.
          if (ptab.classList.contains('v2-tabna')) {
            try {
              const m2 = (typeof matProv === 'function') ? matProv(ctx.L) : null;
              const made = (m2 && m2.key && /sustain|arp|roll/.test(m2.key))
                ? ({ sustain: '\u25ac Sustained', arp: '\u27f3 Arpeggio', roll: '\ud83c\udfb2 Roll' })[m2.key]
                : 'The material';
              showToast(made + ' MADE these notes, and \ud83d\udd12 Lock WROTE THEM DOWN \u2014 the part now plays ' +
                'the notes, not the rules. Rhythm \u00b7 Pattern \u00b7 Feel shape the rules, so they do ' +
                'nothing here: press \ud83c\udfb2 Replace with a new take to roll again, or ' +
                '\ud83d\udd13 Unlock under the drawing to keep rolling every cycle.', { ms: 7000 });
            } catch (e) {}
            return;
          }
          POP.tab = ptab.getAttribute('data-tab');
          popSync(ctx.card, ctx.L);
          return;
        }
        const fbn = t.closest && t.closest('.v2-fambtn');
        if (fbn) {
          const ctx = layerOf(fbn); const POP = popStOf(ctx && ctx.card);
          if (!ctx || !POP) return;
          POP.tab = fbn.getAttribute('data-first');
          popSync(ctx.card, ctx.L);
          return;
        }
        // ▭ Everywhere ⟷ ◫ Per part — the MODE, its own control. Enabling
        // adopts the current content for the strip's current part (nothing
        // sounds different until a part diverges); disabling is the one
        // destructive branch and confirms.
        const ppt = t.closest && t.closest('.v2-pop-pp');
        if (ppt) {
          const ctx = layerOf(ppt); if (!ctx) return;
          if (Number.isFinite(ctx.L.partFor)) {
            if (!confirm('Back to one content everywhere?\n\nThe per-part contents will be discarded \u2014 the Everywhere content, kept on ice since Per part went on, comes back.')) return;
            V2.partSelect(E, ctx.L, null);
          } else {
            let pi0 = Number.isFinite(E._curPart) ? (E._curPart | 0) : 0;
            const rgs = partRangesOf(E);
            if (!rgs.some(r => r.pi === pi0)) pi0 = rgs.length ? rgs[0].pi : 0;
            V2.partSelect(E, ctx.L, pi0);
          }
          commit(ctx); h._sig = ''; V2.render(E);
          return;
        }
        const sy2 = t.closest && t.closest('.v2-pop-sync');
        if (sy2) {
          const ctx = layerOf(sy2); if (!ctx) return;
          try { syncPartModal(E, ctx.card, ctx.L, () => { h._sig = ''; V2.render(E); }); } catch (e) {}
          return;
        }
        // BOTH previews, one handler — and a DISTINCT class for the panel's,
        // or `querySelector('.v2-pop-preview')` finds the hidden one first and
        // every sheet measures its Preview as missing (that trap, twice in one
        // change).
        const pv = t.closest && (t.closest('.v2-pop-preview') || t.closest('.v2-genprev'));
        if (pv) {
          const ctx = layerOf(pv); if (!ctx) return;
          // While the transport runs the layer is already sounding and every
          // edit lands live — a second copy on top would only smear it.
          if (E.timer) {
            try { showToast('Already playing — edits are heard live.', { ms: 2500 }); } catch (e) {}
            return;
          }
          // PRESS-AGAIN-TO-STOP. The first build's guard (ignore while the
          // 'playing' class was on) expired with the CYCLE while release tails
          // rang on, so a re-press stacked a second copy on the first's tail —
          // "it sounds like it's firing a few times on top of each other".
          // Stopping is a kill; starting KILLS FIRST unconditionally (inside
          // V2.preview), so overlap is impossible whichever state the button
          // believes it is in.
          const stopPv = () => {
            if (h._pv) { clearTimeout(h._pv.t); h._pv = null; }
            document.querySelectorAll('.v2-pop-preview, .v2-genprev').forEach(b3 => {
              b3.classList.remove('playing'); b3.textContent = '\u25b6 Preview';
            });
          };
          // IS IT SOUNDING? — asked of the module, which knows when the last
          // note ends, rather than of a local timer that GUESSED it as
          // cycleSec + 600 ms. That guess expired 741 ms early (measured), so a
          // stop press landed on a button already flipped back to Preview and
          // RESTARTED the layer — reported as "it keeps playing after stop".
          let sounding = false;
          try { sounding = !!(V2.previewing && V2.previewing(ctx.L)); } catch (e) {}
          if (sounding || (h._pv && h._pv.id === (ctx.L.id | 0))) {
            stopPv();
            try { V2.previewKill(E, ctx.L); } catch (e) {}
            return;
          }
          stopPv();                                      // another layer's → replace
          const played = V2.preview(E, ctx.L);
          // THE PICTURE FOLLOWS THE SOUND — repaint with the cycle that just
          // played, or the drawing keeps showing a different take from the one
          // you are hearing (reported: "each time I press preview something
          // different plays, but the visualization stays the same").
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          pv.classList.add('playing');
          pv.textContent = played ? '\u25a0 Stop' : pv.textContent;
          // the label follows the real end for the same reason the branch above
          // does — one source of truth for "is it still going"
          let leftMs = 2000;
          try { if (V2.previewLeftSec) leftMs = Math.round(V2.previewLeftSec(ctx.L) * 1000); } catch (e) {}
          h._pv = { id: ctx.L.id | 0, t: setTimeout(stopPv, Math.max(600, leftMs)) };
          return;
        }
        // GROUP FOLD — v1 binds every `.ambient-grp-head` in the PANEL HOST at
        // build time; v2 cards live in their own host, so they were never wired
        // and the Instrument/Part headings did nothing. Found by driving every
        // control rather than the one I had just changed.
        const gh = t.closest('.ambient-grp-head');
        const fb = t.closest('.v2-fetch');
        if (fb) {
          const ctx = layerOf(fb); if (!ctx) return;
          const hint = ctx.card.querySelector('.v2-article');
          if (hint) hint.textContent = 'fetching\u2026';
          fb.disabled = true;
          V2.fetchArticle(E, ctx.L).then((got) => {
            fb.disabled = false;
            if (hint) {
              hint.textContent = got
                ? (got.title || 'loaded') + ' \u00b7 ' + got.lines + ' lines'
                : 'nothing came back \u2014 try another source or subject';
            }
            try { E.getCfg(); } catch (e) {}
            applyGate(ctx.card, ctx.L);
            const ta = ctx.card.querySelector('.v2-text');
            if (ta && got) ta.value = ctx.L.instrument.text || '';
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          }, () => { fb.disabled = false; if (hint) hint.textContent = 'that did not work'; });
          return;
        }
        // GENERIC ON/OFF over a field path — ping-pong, dry kills, pecho.
        const ft = t.closest('.v2-ftog');
        if (ft) {
          const ctx = layerOf(ft); if (!ctx) return;
          const path = ft.getAttribute('data-f');
          // First touch of the pitch echo MATERIALISES the whole record with
          // v1's own defaults (`_pechoOf`'s shape) — a bare `{on:1}` would
          // leave the tee reading undefined repeats/feedback.
          if (path === 'pecho.on' && (!ctx.L.pecho || typeof ctx.L.pecho !== 'object')) {
            ctx.L.pecho = { on: 0, timeMs: 300, sync: '', repeats: 3, step: 2,
                            pattern: '', feedback: 65, spread: 0, dryKill: 0 };
          }
          const nv = getPath(ctx.L, path) ? 0 : 1;
          // v1's normalizer is strict about THIS one: `pe.on = pe.on === true`,
          // so the number 1 flattens back to false on the next getCfg.
          setPath(ctx.L, path, path === 'pecho.on' ? (nv === 1) : nv);
          ft.classList.toggle('on', !!nv);
          ft.textContent = nv ? ft.getAttribute('data-on') : ft.getAttribute('data-off');
          commit(ctx);
          // a dryKill flips the engaged set, which is a chain change
          if (/^(delay|dist|chorus|phaser|autopan|glitch)\./.test(path)) {
            try { _ambApplyLayerFx('v2:' + ctx.L.id, ctx.L); } catch (e) {}
          }
          return;
        }
        const sa = t.closest('.v2-salttoggle');
        if (sa) {
          const ctx = layerOf(sa); if (!ctx) return;
          if (ctx.L.followSalt) delete ctx.L.followSalt; else ctx.L.followSalt = 1;
          try { E.getCfg(); } catch (e) {}
          sa.classList.toggle('on', !!ctx.L.followSalt);
          sa.textContent = ctx.L.followSalt ? 'On — follows the colours' : 'Off — holds the chord';
          applyGate(ctx.card, ctx.L);
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          return;
        }

        const vry = t.closest('.v2-varytoggle');
        if (vry) {
          const ctx = layerOf(vry); if (!ctx) return;
          if (ctx.L.part.vary) delete ctx.L.part.vary; else ctx.L.part.vary = 1;
          try { E.getCfg(); } catch (e) {}
          vry.classList.toggle('on', !!ctx.L.part.vary);
          vry.textContent = ctx.L.part.vary ? '\ud83c\udfb2 Re-roll every cycle' : '\u2713 Play this take';
          try {
            const vh = ctx.card.querySelector('.v2-varyhint');
            const tk = ((ctx.L.part.take | 0) + 1);
            if (vh) vh.textContent = ctx.L.part.vary
              ? ('a fresh roll each cycle \u2014 the drawing is take ' + tk + ', one of many')
              : ('take ' + tk + ' is what plays, every cycle');
          } catch (e) {}
          // …and the line that says WHY this layer is live has just changed
          try { applyGate(ctx.card, ctx.L); } catch (e) {}
          // it changes what the NEXT cycles play, so the ones already scheduled
          // are superseded — the same pair every live edit on this card does
          try {
            if (E.timer && typeof cancelBloomFutureVoices === 'function' && typeof Tone !== 'undefined') {
              cancelBloomFutureVoices('v2:' + ctx.L.id, Tone.now());
            }
          } catch (e) {}
          try { if (E._v2Phase) delete E._v2Phase['v2:' + ctx.L.id]; } catch (e) {}
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          return;
        }
        const rgt = t.closest('.v2-ringtoggle');
        if (rgt) {
          const ctx = layerOf(rgt); if (!ctx) return;
          if (ctx.L.ring) delete ctx.L.ring; else ctx.L.ring = 1;
          try { E.getCfg(); } catch (e) {}
          rgt.classList.toggle('on', !!ctx.L.ring);
          rgt.textContent = ctx.L.ring ? 'On \u2014 through the changes' : 'Off \u2014 released by the next change';
          // it changes how long notes SOUND, so the ones already scheduled with
          // the old answer are superseded — the same pair every other live edit
          // on this card does.
          try {
            if (E.timer && typeof cancelBloomFutureVoices === 'function' && typeof Tone !== 'undefined') {
              cancelBloomFutureVoices('v2:' + ctx.L.id, Tone.now());
            }
          } catch (e) {}
          try { if (E._v2Phase) delete E._v2Phase['v2:' + ctx.L.id]; } catch (e) {}
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          return;
        }
        const tt = t.closest('.v2-tighttoggle');
        if (tt) {
          const ctx = layerOf(tt); if (!ctx) return;
          if (ctx.L.tight) delete ctx.L.tight; else ctx.L.tight = 1;
          try { E.getCfg(); } catch (e) {}
          tt.classList.toggle('on', !!ctx.L.tight);
          tt.textContent = ctx.L.tight ? 'On — clipped' : 'Off';
          applyGate(ctx.card, ctx.L);
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          return;
        }
        const nbtn = t.closest('.ambient-notes-btn');
        if (nbtn) {
          const ctx = layerOf(nbtn); if (!ctx) return;
          const r = nbtn.getBoundingClientRect();
          try {
            _ambOpenNotesMenu(E, () => ctx.L, r.left, r.bottom + 4, () => {
              try { E.getCfg(); } catch (e) {}
              applyGate(ctx.card, ctx.L);
              // A source change is a GENERATION change: re-anchor so the next
              // cycle is built from the new source rather than a cycle later.
              try { if (E._v2Phase) delete E._v2Phase['v2:' + ctx.L.id]; } catch (e) {}
              try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            });
          } catch (e) {}
          return;
        }
        if (gh) {
          const g = gh.closest('.ambient-grp');
          if (g) {
            g.classList.toggle('open');
            // The summary shows only while FOLDED, so the fold itself has to
            // repaint it — nothing else runs on a head tap.
            const ctx = layerOf(g);
            if (ctx) applyGate(ctx.card, ctx.L);
          }
          return;
        }
        // COLLAPSE — the caret, and ALSO any empty space in the header. A 38px
        // caret is a small target on a phone; the whole head row is forgiving,
        // and the controls inside it (toggle, ⋯) take their own clicks first.
        if (t.closest('.v2-caret') ||
            (t.closest('.ambient-layer-head') && !t.closest('button') && !t.closest('input') && !t.closest('select'))) {
          const c = t.closest('.v2-layer');
          if (c) {
            const nowCollapsed = c.classList.toggle('collapsed');
            // THE EDITOR IS THE BODY — a collapsed card gives its rows back to
            // the storage groups, an expanded one takes them up again.
            const cx0 = layerOf(c);
            if (nowCollapsed) popClose(c);
            else if (cx0 && !popWrapOf(c)) {
              const keep0 = POPS.get(popIdOf(c));
              POPS.delete(popIdOf(c));
              popOpen(c, cx0.L, (keep0 && keep0.grp) || POP_DEF, keep0 ? keep0.tab : null);
            }
            if (nowCollapsed) c.querySelectorAll('.ambient-grp.open').forEach(g => g.classList.remove('open'));
            // Expanding opens NOTHING — every subsection stays closed, so the
            // card is a contents page you unfold from. (It opened the four
            // `data-v2def` groups before; asked for on 2026-09-02.)
            else c.querySelectorAll('.ambient-grp.open').forEach(g => g.classList.remove('open'));
            // The caret CHANGES which groups are folded, and a summary shows
            // only while folded — so the collapse control has to repaint them
            // exactly as the group head does, or a group refolded by expanding
            // the card comes back with a blank head.
            const cx = layerOf(c);
            if (cx) applyGate(cx.card, cx.L);
          }
          return;
        }
        // ↻ REGENERATE — drop the override, back to the formula. The only way
        // out of an edit, which is why it is a visible control and not a mode.
        const rg = t.closest('.v2-regen');
        if (rg) {
          const ctx = layerOf(rg); if (!ctx) return;
          V2.seedCells(ctx.L);                       // keep cells coherent with what euclid draws
          ctx.L.part.rhythm.kind = 'euclid';
          commit(ctx); redrawCells(ctx.card, ctx.L);
          return;
        }
        // A PATTERN CELL — toggled in place, never through a re-render (a
        // rebuild mid-gesture detaches the cell under the finger, so the next
        // tap in a run of taps lands on nothing).
        // THE GATE ON/OFF. A BUTTON, not a select: a `<select>` writes a STRING,
        // and `'0'` is truthy — `_ambNormalizeFx` does `tg.on = tg.on ? 1 : 0`,
        // so an "Off" pick would have switched it ON.
        const sw = t.closest('.v2-speechwrite');
        if (sw) {
          const ctx = layerOf(sw); if (!ctx) return;
          // Rendering is SECONDS of inference per line and the tick is 150 ms —
          // v1's "nothing loads during playback" rule. Say so rather than
          // stalling the transport.
          if (E.timer) { try { showToast('Stop playback first — writing the lines takes a moment.', { warn: true, ms: 4000 }); } catch (e) {} return; }
          sw.textContent = '\u2026 writing';
          V2.speechWrite(E, ctx.L, (d2, n2) => { try { sw.textContent = '\u2026 ' + d2 + '/' + n2; } catch (e) {} })
            .then(() => { h._sig = ''; V2.render(E);
              try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {} })
            .catch(() => { h._sig = ''; V2.render(E); });
          return;
        }
        const sg = t.closest('.v2-speechgen');
        if (sg) {
          const ctx = layerOf(sg); if (!ctx) return;
          let txt = '';
          try { txt = _ambSeelText(6); } catch (e) {}
          if (!txt) return;
          ctx.L.instrument.text = txt;
          commit(ctx); h._sig = ''; V2.render(E);
          return;
        }
        const wt = t.closest('.v2-wettoggle');
        if (wt) {
          const ctx = layerOf(wt); if (!ctx) return;
          ctx.L.wetOnly = ctx.L.wetOnly ? 0 : 1;
          commit(ctx);
          try { _ambApplyLayerFx('v2:' + ctx.L.id, ctx.L); } catch (e) {}
          h._sig = ''; V2.render(E);
          return;
        }
        const spt = t.closest('.v2-spattoggle');
        if (spt) {
          const ctx = layerOf(spt); if (!ctx) return;
          // `_ambNormalizeSpat` OWNS the defaults (mode 'fan', width 60, steps 5)
          // and backfills them on the next getCfg, so v2 must not carry a second
          // copy — it only has to make the object exist. Note the coercer DELETES
          // `spat` unless it is an object, which is what keeps it absent by
          // default; `{}` is enough to opt in. (A poison that seeded `{on:0}`
          // alone still passed, which is how the duplication showed up.)
          if (!ctx.L.spat || typeof ctx.L.spat !== 'object') ctx.L.spat = {};
          ctx.L.spat.on = ctx.L.spat.on ? 0 : 1;
          commit(ctx); h._sig = ''; V2.render(E);
          return;
        }
        const tgt = t.closest('.v2-tgtoggle');
        if (tgt) {
          const ctx = layerOf(tgt); if (!ctx) return;
          if (!ctx.L.tg || typeof ctx.L.tg !== 'object') ctx.L.tg = {};
          ctx.L.tg.on = ctx.L.tg.on ? 0 : 1;
          commit(ctx); h._sig = ''; V2.render(E);
          return;
        }
        const tgc = t.closest('.v2-tgcell');
        if (tgc) {
          const ctx = layerOf(tgc); if (!ctx) return;
          const i = tgc.getAttribute('data-ci') | 0;
          const tg = ctx.L.tg || (ctx.L.tg = {});
          if (!Array.isArray(tg.pattern)) tg.pattern = [];
          tg.pattern[i] = tg.pattern[i] ? 0 : 1;
          tgc.classList.toggle('on', !!tg.pattern[i]);
          tgc.setAttribute('aria-pressed', tg.pattern[i] ? 'true' : 'false');
          commit(ctx);
          return;
        }
        // A KIT LANE CELL. Same in-place toggle as the melodic grid; there is no
        // generator behind a lane, so no snapshot step and no restore button —
        // what you draw IS the pattern.
        const lc = t.closest('.v2-lanecell');
        if (lc) {
          const ctx = layerOf(lc); if (!ctx) return;
          const li = lc.getAttribute('data-lane') | 0, ci = lc.getAttribute('data-ci') | 0;
          const r2 = ctx.L.part.rhythm;
          if (!Array.isArray(r2.lanes)) r2.lanes = [];
          if (!Array.isArray(r2.lanes[li])) r2.lanes[li] = [];
          r2.lanes[li][ci] = r2.lanes[li][ci] ? 0 : 1;
          lc.classList.toggle('on', !!r2.lanes[li][ci]);
          lc.setAttribute('aria-pressed', r2.lanes[li][ci] ? 'true' : 'false');
          commit(ctx);
          return;
        }
        // A NOTE LABEL — raise this step's degree, wrapping. Rebuilds the row
        // (not the card) so every label re-resolves against the harmony.
        const nl = t.closest('.v2-note');
        if (nl) {
          const ctx = layerOf(nl); if (!ctx) return;
          const i3 = nl.getAttribute('data-ci') | 0;
          const pt = ctx.L.part.pitch;
          if (!Array.isArray(pt.steps)) pt.steps = [];
          const cur = (pt.steps[i3] | 0) || 1;
          pt.steps[i3] = (cur % 8) + 1;          // 8 degrees is a scale — wrap there
          commit(ctx);
          const row = ctx.card.querySelector('.v2-notes');
          if (row) { const tmp = document.createElement('div'); tmp.innerHTML = noteRowHtml(ctx.L); row.replaceWith(tmp.firstChild); }
          return;
        }
        // ⌗ ROLL ⟷ ▦ STEPS — the material's FORM. THE TWO ARE PARALLEL: each
        // keeps its own material and switching preserves BOTH, so this writes
        // one field and destroys nothing. Nothing has to be saved and restored
        // either — `part.notes` and `rhythm.cells`/`lanes` already coexist in
        // the store (the both-halves rule), and `notesFor` asks the FORM rather
        // than `part.kind` which branch emits. It says what is being left
        // behind rather than what is being lost, because a form you cannot see
        // is still playing nothing, and that is worth naming.
        const fmb = t.closest && t.closest('.v2-formbtn');
        if (fmb) {
          const ctx = layerOf(fmb); if (!ctx) return;
          const want = fmb.getAttribute('data-form') === 'steps' ? 'steps' : 'roll';
          if (V2.formOf(ctx.L) === want) return;              // already there — a no-op
          const P = ctx.L.part;
          if (want === 'steps') P.form = 'steps'; else delete P.form;
          // …AND SAY WHAT IS WAITING IN THE OTHER ONE. Switching is silent
          // otherwise, and "where did my notes go" is the report that follows
          // (it already did once, when this switch discarded them).
          const kept = (want === 'steps')
            ? ((P.notes || []).length ? (P.notes || []).length + ' note' +
                ((P.notes || []).length === 1 ? '' : 's') : '')
            : (() => {
                const r2 = P.rhythm || {};
                const lc = (r2.lanes || []).reduce((a, row) => a + (row || []).filter(Boolean).length, 0);
                const cc = (r2.kind === 'drawn') ? (r2.cells || []).filter(Boolean).length : 0;
                return (lc || cc) ? ((lc || cc) + ' step' + ((lc || cc) === 1 ? '' : 's')) : '';
              })();
          try {
            if (typeof showToast === 'function') showToast(
              (want === 'steps' ? '\u25a6 Steps' : '\u2317 Roll') + ' \u2014 ' +
              (kept ? 'your ' + kept + ' in ' + (want === 'steps' ? '\u2317 Roll' : '\u25a6 Steps') +
                      ' are kept and come back when you switch back.'
                    : 'the other form keeps whatever is in it.'), { ms: 3800 });
          } catch (e) {}
          commit(ctx); h._sig = ''; V2.render(E);
          return;
        }
        const cell = t.closest('.v2-cell');
        if (cell) {
          const ctx = layerOf(cell); if (!ctx) return;
          const i = cell.getAttribute('data-ci') | 0;
          const r = ctx.L.part.rhythm;
          // THE FIRST EDIT SNAPSHOTS THE GENERATED PATTERN and becomes the
          // override — v1's exact idiom, and what makes `drawn` a state rather
          // than a mode anyone has to choose. Without the snapshot the tap would
          // start from an empty grid and appear to erase the pattern.
          if (r.kind !== 'drawn') { r.cells = V2.euclidCells(r.pulses, r.steps, r.rotate); r.kind = 'drawn'; }
          if (!Array.isArray(r.cells)) r.cells = [];
          r.cells[i] = r.cells[i] ? 0 : 1;
          cell.classList.toggle('on', !!r.cells[i]);
          cell.setAttribute('aria-pressed', r.cells[i] ? 'true' : 'false');
          commit(ctx);
          return;
        }
        // ✎ COMPOSE — open the grid editor docked in this card.
        const comp = t.closest('.v2-compose');
        if (comp) {
          const ctx = layerOf(comp); if (!ctx) return;
          // ── ✎ WRITTEN IS A CHOICE OF THREE (2026-09-09): draw in the ROLL
          // (the part becomes written and ✎ Draw switches on), compose in the
          // GRID (the session, exactly as before), or START EMPTY — clear to
          // an empty written part, "working with an empty visualization".
          // The shell is `_ambActionsPopover`, whose fns are deferred a tick
          // past its own dismiss (the documented dispatch-order rule).
          const openGrid = () => {
            if (!V2.compose(E, ctx.L)) {
              try { if (typeof showToast === 'function') showToast('Could not open the grid for this layer.', { warn: true, ms: 4000 }); } catch (e) {}
              return;
            }
            h._sig = ''; V2.render(E);
            // The dock is filled by `_placeLaneExpander`, which resolves it by key
            // — so it has to run AFTER the card is rebuilt, or it docks into a node
            // the rebuild is about to throw away (the documented re-dock order).
            try { if (typeof _placeLaneExpander === 'function') _placeLaneExpander(); } catch (e) {}
            try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
            // …AND REPAINT THE DOCK CHROME, for the same reason and in the same
            // order — the re-render recreates the chord ruler and the gran bar
            // EMPTY, and `_ambRefreshSeedModes` runs whether or not the
            // transport is going (composing happens stopped).
            try { if (typeof _ambRefreshSeedModes === 'function') _ambRefreshSeedModes(E); } catch (e) {}
          };
          const openRoll = () => {
            const L2 = ctx.L;
            if (L2.part.kind !== 'recorded') {
              if (!captureShown(E, L2)) {
                try { if (typeof showToast === 'function') showToast('Nothing to draw on yet \u2014 \ud83c\udfb2 roll a take first, or \u232b Start empty.', { warn: true, ms: 4500 }); } catch (e) {}
                return;
              }
              try { if (typeof showToast === 'function') showToast('\ud83d\udd12 Locked this take \u2014 the part is WRITTEN and \u270e Draw is on: tap the drawing to add a note, drag right to size it.', { ms: 5000 }); } catch (e) {}
            } else {
              try { if (typeof showToast === 'function') showToast('\u270e Draw is on \u2014 tap the drawing to add a note, drag right to size it.', { ms: 4000 }); } catch (e) {}
            }
            setMode(L2, 'draw');
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            h._sig = ''; V2.render(E);
          };
          const startEmpty = () => {
            const L2 = ctx.L, p2 = L2.part;
            const n2 = (p2.notes || []).length;
            const lose = (p2.kind === 'recorded')
              ? ((p2.made === 'compose') ? 'The notes you drew'
                : (p2.made === 'phrase') ? ('The phrase' + (p2.from ? ' \u201c' + p2.from + '\u201d' : ''))
                : ('These ' + n2 + ' written note' + (n2 === 1 ? '' : 's')))
              : 'The take you see';
            if ((p2.kind !== 'recorded' || n2 > 0) &&
                !confirm('Start empty?\n\n' + lose + ' will be cleared \u2014 the part becomes ' +
                  'WRITTEN with no notes, and \u270e Draw is switched on so a tap on the ' +
                  'drawing adds one.' +
                  (p2.kind !== 'recorded' ? '\n\nIts generated rules are kept \u2014 \u2699 Generated brings them back.' : '') +
                  '\n\nThis cannot be undone.')) return;
            if (!V2.clearPart(E, ctx.L)) return;
            setMode(ctx.L, 'draw');
            // the live-edit pair: anything already scheduled is stale now
            try { if (E.timer && typeof cancelBloomFutureVoices === 'function') cancelBloomFutureVoices('v2:' + (ctx.L.id | 0), Tone.now()); } catch (e) {}
            try { if (E._v2Phase) delete E._v2Phase['v2:' + (ctx.L.id | 0)]; } catch (e) {}
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            h._sig = ''; V2.render(E);
            try { if (typeof showToast === 'function') showToast('\u232b Empty \u2014 \u270e Draw is on: tap the drawing to add the first note.', { ms: 4500 }); } catch (e) {}
          };
          // Mid-session the press stays the way back into the open grid
          // (compose() is idempotent for the same layer); no popover shell →
          // the grid, today's behaviour.
          if (ctx.card.classList.contains('v2-composing') || typeof _ambActionsPopover !== 'function') {
            openGrid(); return;
          }
          _ambActionsPopover('\u270e Written \u2014 you choose the notes', [
            { label: '\ud83c\udfb9 Draw in the roll \u2014 add and move notes on the drawing itself', fn: openRoll },
            { label: '\u25a6 Compose in the grid \u2014 steps, chords and the keyboard', fn: openGrid },
            { label: '\u232b Start empty \u2014 clear this part and draw from nothing', fn: startEmpty, danger: true },
          ]);
          return;
        }
        const gdone = t.closest('.v2-gdone'), gcancel = t.closest('.v2-gcancel');
        if (gdone || gcancel) {
          try { if (typeof _ambGridEditStop === 'function') _ambGridEditStop(!!gcancel); } catch (e) {}
          h._sig = ''; V2.render(E);
          return;
        }
        // ADOPTING A SAVED TAKE happens in the Bank tab itself (`.v2-bkload`
        // below) — there is no door for it in the Material row. Two rounds of
        // that: first a PICKER over the same list the tab draws, then a
        // signpost that merely navigated to it. Both were one list wearing two
        // words, and both filed the bank under WRITTEN, which it is not — a
        // generated roll saves into it just as a drawn phrase does.
        // ✎ DRAW / ▦ BARS — what a tap on empty space means.
        // SAVE A TAKE, and the bank's own row: load, reorder, delete.
        const svt = t.closest && t.closest('.v2-savetake');
        if (svt) {
          const ctx = layerOf(svt); if (!ctx) return;
          const nm = saveTakeFn(E, ctx.L);
          if (!nm) return;
          try { if (typeof showToast === 'function') showToast('Saved \u201c' + nm + '\u201d \u2014 it is in the bank now, and can be mapped to any part or chord.', { ms: 5000 }); } catch (e) {}
          h._sig = ''; V2.render(E);
          return;
        }
        const bk = t.closest && t.closest('.v2-bkload, .v2-bkup, .v2-bkdn, .v2-bkdel');
        if (bk) {
          const ctx = layerOf(bk); if (!ctx) return;
          const bi = bk.getAttribute('data-bi') | 0;
          const ent = (typeof savedSequences !== 'undefined' && savedSequences[bi]) || null;
          if (!ent) return;
          if (bk.classList.contains('v2-bkload')) {
            if (!V2.adopt(E, ctx.L, ent.name)) {
              try { if (typeof showToast === 'function') showToast('Could not read \u201c' + ent.name + '\u201d \u2014 it has no pitched steps.', { warn: true, ms: 4500 }); } catch (e) {}
              return;
            }
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          } else if (bk.classList.contains('v2-bkdel')) {
            // THE ONE DELETE PATH — it confirms, names what it costs, and
            // prunes every mapping that pointed at the name (a second copy of
            // that logic here is how a mapping is left pointing at nothing).
            if (typeof deleteSavedSequence === 'function') deleteSavedSequence(bi);
            else return;
          } else {
            const to = bi + (bk.classList.contains('v2-bkup') ? -1 : 1);
            if (to < 0 || to >= savedSequences.length) return;
            const sp = savedSequences.splice(bi, 1)[0];
            savedSequences.splice(to, 0, sp);
            try { if (typeof persistSaved === 'function') persistSaved(); } catch (e) {}
          }
          h._sig = ''; V2.render(E);
          return;
        }
        // A SUBSECTION HEADER. Toggles a class on the CARD rather than setting
        // `style.display` on the rows — inline display belongs to `applyGate`,
        // and `.v2-rowoff` (which hides an inactive tab) is `!important` and
        // has to keep winning over whatever this does.
        const dsc = t.closest && t.closest('.v2-discbtn');
        if (dsc) {
          const ctx = layerOf(dsc); if (!ctx) return;
          const id = dsc.getAttribute('data-disc');
          const on = ctx.card.classList.toggle('v2-so-' + id);
          dsc.textContent = (on ? '\u25be Hide' : '\u25b8 Show');
          return;
        }
        // The note editor's own buttons — same delegation, same reason.
        const nact = t.closest && t.closest('.v2-neinline [data-na]');
        if (nact) { if (neAct(E, nact)) return; }
        // ⬚ MULTI's TRANSFORMS. Every one is a DELTA through `multiApply`, the
        // one writer — a stepper is a second door to what the drag does, never
        // a second implementation of it (the `neApply` rule).
        const mab = t.closest && t.closest('.v2-mact');
        if (mab) {
          const ctx = layerOf(mab); if (!ctx) return;
          const a = mab.getAttribute('data-ma');
          if (a === 'clear') mselSet(ctx.L, null);
          else {
            const what = a[0] === 't' ? 't' : (a[0] === 'm' ? 'midi' : 'dur');
            multiApply(E, ctx.L, what, parseInt(a.slice(1), 10) | 0);
          }
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          try { multiSync(ctx.card, ctx.L); } catch (e) {}
          return;
        }
        // A TAP ON A NOTE IN THE DRAWING. The picture stops being a readout and
        // becomes the editor: hit-test the boxes recorded by the last draw, and
        // open that note. A live part has no notes of its own, so tapping one
        // LOCKS the take first — the same act as pressing 🔒, reached from the
        // thing the finger was already on, and announced rather than silent.
        // ── THE WINDOW'S OWN BUTTONS ────────────────────────────────────
        // Before the canvas branch: they sit beside it, not on it, and a press
        // here must never fall through to a bar select.
        const nvb = t.closest && t.closest('.v2-nav');
        if (nvb) {
          const ctx = layerOf(nvb); if (!ctx) return;
          const L9 = ctx.L, a9 = nvb.getAttribute('data-nav');
          const cur = vnavOf(L9);
          const cvn = ctx.card.querySelector('.v2-vizcv');
          const bg = cvn && cvn._barsGeo;
          // PAN BY A THIRD OF WHAT IS ON SCREEN, not by a fixed number of
          // bars: on a four-bar window that is a bar and a bit, and it keeps
          // context either side rather than jumping to a stretch with nothing
          // in common with the one you were reading.
          const step = bg ? Math.max(0.25, (bg.vbars || 4) / 3) : 1;
          const maxB = bg ? Math.max(0, (bg.barsF || 1) - (bg.vbars || 1)) : 0;
          if (a9 === 'up') vnavSet(L9, { dy: clamp(cur.dy + 3, -96, 96) });
          else if (a9 === 'dn') vnavSet(L9, { dy: clamp(cur.dy - 3, -96, 96) });
          else if (a9 === 'grow') vnavSet(L9, { rows: clamp(cur.rows + 6, 0, 60) });
          // NEGATIVE IS ALLOWED — it was floored at 0, so − could only undo a
          // previous ＋ and never do what its own label promises ("show fewer
          // pitches"). Narrowing below the derived window is a pitch ZOOM: the
          // canvas has a floor height, so fewer rows means TALLER rows.
          else if (a9 === 'shrink') vnavSet(L9, { rows: clamp(cur.rows - 6, -40, 60) });
          else if (a9 === 'left') vnavSet(L9, { bar0: clamp(cur.bar0 - step, 0, maxB) });
          else if (a9 === 'right') vnavSet(L9, { bar0: clamp(cur.bar0 + step, 0, maxB) });
          else if (a9 === 'fit') vnavSet(L9, { dy: 0, rows: 0, bar0: 0 });
          try { drawPartViz(ctx.card, L9, E); } catch (e) {}
          return;
        }
        const cvz = t.closest('.v2-vizcv');
        if (cvz) {
          // A DRAG ENDS IN A CLICK. Without this, letting go after moving a
          // note would also open (or close) its editor — the gesture doing two
          // things, which is the tab-reorder lesson.
          if (cvz._dragged && Date.now() - cvz._dragged < 500) { cvz._dragged = 0; return; }
          const ctx = layerOf(cvz); if (!ctx) return;
          if (vmRefuse(cvz)) return;   // another part's record is drawn — read-only
          const r = cvz.getBoundingClientRect();
          const px = (ev.clientX != null ? ev.clientX : 0) - r.left;
          const py = (ev.clientY != null ? ev.clientY : 0) - r.top;
          // A TAP ON THE DRAWN PIANO MOVES THE SELECTED NOTE TO THAT KEY.
          // Pitch had one control — a ± stepper over 0..127 — which is the
          // tap-to-cycle mistake at 128 values, with a keyboard naming every
          // one of them sitting three pixels away. Tested BEFORE the note
          // boxes: those are padded 4px to clear the touch floor, so a note in
          // bar 1 reaches into the gutter and would win the hit test.
          const pg = cvz._pitchGeo, gxk = (cvz._plotGeo && cvz._plotGeo.x0) || 0;
          if (pg && px < gxk && py >= pg.top && pg.rowH > 0) {
            const Lk = ctx.L;
            const cardK = document.querySelector('.v2-layer[data-v2id="' + (Lk.id | 0) + '"]') || ctx.card;
            const nsel = NE && NE.id === (Lk.id | 0) && Lk.part.kind === 'recorded' &&
                         (Lk.part.notes || [])[NE.idx];
            // REFUSE AND EXPLAIN. The gutter used to be inert here on purpose
            // ("a tap on the keys is a tap on the axis"), and a control that
            // silently does nothing is the trap this card keeps closing.
            if (!nsel) {
              try { if (typeof showToast === 'function') showToast(
                'Tap a note in the drawing first \u2014 then a key on the piano moves it to that pitch.',
                { ms: 3800 }); } catch (e) {}
              return;
            }
            const m = clamp(pg.hiM - Math.floor((py - pg.top) / pg.rowH), pg.loM, pg.hiM);
            if (m === (nsel.midi | 0)) return;          // already there
            neApply(E, cardK.querySelector('.v2-neinline'), 'midi', m, true);
            return;
          }
          const hits = cvz._hits || [];
          let hit = null;
          for (let i = 0; i < hits.length; i++) {
            const b = hits[i];
            // a generous box — a 6px-tall note is under the touch floor, so the
            // hit area is padded rather than the drawing made clumsy
            if (px >= b.x - 4 && px <= b.x + b.w + 4 && py >= b.y - 7 && py <= b.y + b.h + 7) { hit = b; break; }
          }
          const L2 = ctx.L;
          if (!hit) {
            // EMPTY SPACE IS THE BAR'S OWN TAP TARGET — the 15px number gutter
            // alone is under the touch floor, and a miss on a 6px note used to
            // do nothing at all. Toggling is visible and one tap reverses it.
            // ✎ DRAW — empty space ADDS a note there. Its own mode because a
            // tap on empty space already means "select this bar", and one
            // gesture cannot mean both; the button on the drawing's line says
            // which it is, so the mode is never invisible.
            const pgA = cvz._pitchGeo, plA = cvz._plotGeo;
            if (modeOf(L2) === 'draw' && pgA && plA && plA.cyc &&
                px >= plA.x0 && py >= pgA.top) {
              // ONE ADD PATH — `penAdd`, shared with the pointerdown PENCIL
              // (which owns every real gesture and suppresses this click via
              // `_dragged`; this branch serves synthetic clicks and anything
              // that never sent a pointerdown). It locks a generated part,
              // places the note on the CLICKED ROW exactly (pinned on a
              // remapping part, shift-corrected under a transpose), and it
              // OPENS — the note you just made is the one you are editing.
              const made = penAdd(E, L2, cvz, px, py);
              if (!made) return;
              const cA = document.querySelector('.v2-layer[data-v2id="' + (L2.id | 0) + '"]') || ctx.card;
              if (made.idx >= 0) neOpen(E, L2, made.idx, cA);
              else { try { drawPartViz(cA, L2, E); } catch (e) {} }
              return;
            }
            if (modeOf(L2) === 'multi') {
              // …and in MULTI a miss means "gather nothing". Bar select is not
              // available in this mode on purpose: one gesture, one meaning.
              if ((mselOf(L2) || { size: 0 }).size) {
                mselSet(L2, null);
                const cM = document.querySelector('.v2-layer[data-v2id="' + (L2.id | 0) + '"]') || ctx.card;
                try { drawPartViz(cM, L2, E); } catch (e) {}
                try { multiSync(cM, L2); } catch (e) {}
              }
              return;
            }
            const geo = cvz._barsGeo;
            // a LIVE part selects bars too — for 🎲 New take, which retakes
            // just those bars (a per-bar pin); a recorded one for the splice
            if (!geo) return;
            // …AND ONLY FROM THE RULER STRIP (stated as the contract,
            // 2026-09-08: "selecting a change should only be possible by
            // pressing the bar ruler area, not the whole section"). A tap in
            // the open plot used to toggle bars, which made every stray tap
            // an edit to which bars re-roll.
            if (py > ((cvz._pitchGeo && cvz._pitchGeo.top) || 15)) return;
            if (L2.part.kind === 'recorded' && !(L2.part.notes || []).length) return;
            // THE KEYBOARD GUTTER IS NOT PART OF THE BAR GRID — a tap on the
            // keys is a tap on the axis, not on bar 1.
            const gx0 = geo.x0 || 0;
            if (px < gx0) return;
            const vsc9 = (geo.vsc > 0) ? geo.vsc : 1, f09 = geo.f0 || 0;
            // the tap, as a CYCLE FRACTION — one inverse of the draw's own
            // mapping, shared by the bar row and the chord band above it
            const fr9 = f09 + ((px - gx0) / Math.max(1, geo.w)) * vsc9;
            if (!BSEL || BSEL.id !== (L2.id | 0) || BSEL.sig !== bselSig(L2)) {
              BSEL = { id: L2.id | 0, sig: bselSig(L2), bars: new Map() };
            }
            const selToggle = (key, nm) => {
              if (BSEL.bars.has(key)) BSEL.bars.delete(key); else BSEL.bars.set(key, nm);
              const cS = document.querySelector('.v2-layer[data-v2id="' + (L2.id | 0) + '"]') || ctx.card;
              try { drawPartViz(cS, L2, E); } catch (e) {}
            };
            // ── THE CHORD BAND SELECTS A CHANGE ──────────────────────────
            // "should also be able to click the Chord headers to select all of
            // a chord (just like bar selection but by chord instead)". The
            // ruler is two rows and they now answer two questions: the top one
            // picks a CHANGE, the numbers below pick a BAR.
            //
            // THE SELECTION IS STILL IN BARS, and that is not a shortcut — it
            // is the granularity the re-roll HAS: the splice and the composite
            // both bucket notes with `floor(t * bars)`, and the per-bar stores
            // (`takeb`, `ruleb`) are keyed by bar index. So a chord tap picks
            // every bar the change OVERLAPS, and when the change does not fill
            // whole bars it says so rather than quietly selecting more than
            // its name (a control that does more than it says is the trap this
            // file keeps paying for).
            const cg9 = cvz._chordGeo;
            if (cg9 && py <= cg9.top && Array.isArray(cg9.marks) && cg9.marks.length) {
              const m9 = cg9.marks.find((x) => fr9 >= x.f0 - 1e-6 && fr9 < x.f1 - 1e-6);
              if (!m9) return;
              // THE CHANGE'S OWN SPAN, to the slot. Reported as "clicking F♯m
              // should only select the F♯m area" — it used to widen to whole
              // bars, which on a cadence where F♯m runs from the middle of a
              // bar to its end selected twice the change.
              // SNAP FIRST: `_ambChordSpanAt` BISECTS, so a change's edges carry
              // float noise (measured 1.00005 bars for a chord ending exactly on
              // bar 1). The 1/48-bar grid is where every real boundary sits, and
              // is the same snap the window start and the rubato edges use.
              const top9 = Math.max(1, Math.round(geo.barsF * SPB));
              const sa = Math.max(0, Math.min(top9 - 1, Math.round(m9.f0 * geo.barsF * SPB)));
              const sb = Math.max(sa + 1, Math.min(top9, Math.round(m9.f1 * geo.barsF * SPB)));
              selToggle(regKey(sa, sb), m9.nm || regLabel(regKey(sa, sb)));
              return;
            }
            const b2 = Math.max(0, Math.min(Math.ceil(geo.barsF) - 1, Math.floor(fr9 * geo.barsF)));
            selToggle(regBarKey(b2), 'bar ' + (b2 + 1));
            return;
          }
          const wasRec = L2.part.kind === 'recorded';
          if (L2.part.kind !== 'recorded') {
            if (!captureShown(E, L2)) {
              try { if (typeof showToast === 'function') showToast('Nothing to lock — this take is empty.', { ms: 3500 }); } catch (e) {}
              return;
            }
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            try { if (typeof showToast === 'function') showToast('Locked this take so it can be edited — ' + L2.part.notes.length + ' notes. ❄ Re-take live goes back.', { ms: 5000 }); } catch (e) {}
            h._sig = ''; V2.render(E);
          }
          // the hit's own index when the array was not just rebuilt by a lock —
          // `nearestNote` can resolve to a NEIGHBOUR under a harmony remap
          const idx = (wasRec && Number.isFinite(hit.i) &&
                       (L2.part.notes || [])[hit.i]) ? (hit.i | 0)
            : nearestNote(L2.part.notes || [], hit.t, hit.midi);
          if (idx < 0) return;
          const c3 = document.querySelector('.v2-layer[data-v2id="' + (L2.id | 0) + '"]') || ctx.card;
          // ⬚ MULTI — a tap GATHERS rather than opens. Toggling, so a mis-tap
          // costs one tap; the count on the bar below says what is held, and
          // the notes are ringed in the picture (a gathering you cannot see is
          // the drum-solo bug).
          if (modeOf(L2) === 'multi') {
            const cur = new Set(mselOf(L2) || []);
            if (cur.has(idx)) cur.delete(idx); else cur.add(idx);
            mselSet(L2, cur);
            NE = null;                        // the editor is a single-note surface
            try { drawPartViz(c3, L2, E); } catch (e) {}
            try { multiSync(c3, L2); } catch (e) {}
            return;
          }
          // TAPPING THE OPEN NOTE AGAIN CLOSES IT — the drawing is the toggle,
          // so a mis-tap costs one tap rather than a hunt for the ✕.
          if (NE && NE.id === (L2.id | 0) && NE.idx === idx) { NE = null; try { drawPartViz(c3, L2, E); } catch (e) {} return; }
          neOpen(E, L2, idx, c3);
          return;
        }
        // 🎲 NEW TAKE — the ONLY thing that re-rolls a live part. Preview used to
        // do it as a side effect, so the take you liked was gone the moment you
        // played it again; that is now a deliberate press.
        const nt = t.closest('.v2-newtake') || t.closest('.v2-genroll');
        if (nt) {
          const ctx = layerOf(nt); if (!ctx) return;
          // what is sounding for this layer is now the OLD take
          const takeHeard = () => v2TakeHeard(E, ctx.L);
          // SCOPED BY THE SELECTED BARS: with bars tapped, only they are
          // retaken (a per-bar pin — the rest of the drawing holds still);
          // with none, the whole take moves.
          const selN = bselOf(ctx.L);
          const selBarsN = selN ? bselKeys(selN) : null;
          // WITH BARS TAPPED THE PRESS OPENS THE RULES, it does not throw the
          // dice — "it should open a popover showing the current generated
          // settings, and user should be able to edit and apply to just that
          // bar". Rolling is 🎲 Roll again inside it, so the dice is still one
          // press away and you can see WHAT you are rolling first. With no
          // selection the press is the whole-take roll it always was.
          if (selBarsN && selBarsN.length) {
            // never two stacked panels: they are mutually unreachable today
            // (each one's scrim covers the other's door), and a second one
            // opening behind the first is the kind of state that only shows up
            // once somebody adds a third door
            GENPOP = null; ctx.card.classList.remove('v2-genopen');
            BARPOP = { id: ctx.L.id | 0, bars: selBarsN.slice(), nm: bselLabel(selN) };
            try { barpopSync(ctx.card, ctx.L); } catch (e) {}
            return;
          }
          // ON A LOCKED PART this is the REPLACE — the notes are fixed, so a
          // new take has to be rolled and re-frozen (a take pin would change
          // nothing). The confirm rides here with it: re-rolling a locked
          // roll loses nothing, but composed / adopted / hand-edited notes
          // are somebody's work, and `made` is absent on anything older or
          // unrecognised, which takes the safe side.
          if (ctx.L.part.kind === 'recorded') {
            if (!replaceOK(ctx.L, selBarsN)) return;
            if (!captureShown(E, ctx.L, selBarsN)) {
              try { showToast('Nothing to roll \u2014 this cycle is empty. Check the live Rhythm settings.', { ms: 4500 }); } catch (e) {}
              return;
            }
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            try {
              showToast(selBarsN
                ? ('Re-rolled ' + bselLabel(selN) + ' \u2014 the other bars kept what they had. Press again for another roll.')
                : ('Rolled a new take \u2014 ' + ctx.L.part.notes.length + ' notes, still locked. \ud83d\udd13 Unlock to let the rules take over again.'), { ms: 5000 });
            } catch (e) {}
            h._sig = ''; V2.render(E);
            takeHeard();
            return;
          }
          V2.newTake(ctx.L, selBarsN);
          try { E.getCfg(); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          // REWRITE, NEVER PLAY. This used to audition the new take, which on
          // the phone's ~1 s broadcast read as "it just played the current
          // content" — the press's outcome is the DRAWING; ▶ Preview is one
          // button away and stays the only thing that makes sound.
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          takeHeard();
          return;
        }
        const tf = t.closest('.v2-tform');
        if (tf) {
          const ctx = layerOf(tf); if (!ctx) return;
          const cp = ctx.L.part;
          if (cp.kind !== 'recorded' || !(cp.notes || []).length) {
            try {
              showToast('Transforms rework notes that are already there \u2014 this part is Generated, ' +
                'so its notes are made fresh every cycle. Press \ud83d\udd12 Lock this take first.', { ms: 6000 });
            } catch (e) {}
            return;
          }
          const selT = bselOf(ctx.L);
          const barsT = selT ? bselKeys(selT) : null;
          const where = selT ? (' \u2014 ' + bselLabel(selT)) : '';
          const r2 = tf.getBoundingClientRect();
          // deferred a tick: showCtxMenu arms its own dismiss listener, and
          // opening it inside this dispatch tears it down again (documented)
          setTimeout(() => {
            try {
              showCtxMenu(r2.left, r2.bottom + 4, (V2.transformList() || []).map(it => ({
                label: it.label + (where ? where : '') + ' \u2014 ' + it.hint,
                fn: () => setTimeout(() => {
                  const n2 = V2.transform(E, ctx.L, it.op, barsT);
                  if (!n2) {
                    try { showToast('Nothing to transform' + (selT ? ' in ' + bselLabel(selT) : '') + '.', { ms: 3500 }); } catch (e) {}
                    return;
                  }
                  try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                  try { showToast(n2 + ' note' + (n2 === 1 ? '' : 's') + ' ' + V2.transformWord(it.op) +
                    (selT ? (' in ' + bselLabel(selT)) : '') + '.', { ms: 3500 }); } catch (e) {}
                  h._sig = ''; V2.render(E);
                }, 0),
              })));
            } catch (e) {}
          }, 0);
          return;
        }
        const cap = t.closest('.v2-capture');
        if (cap) {
          const ctx = layerOf(cap); if (!ctx) return;
          // A PURE TOGGLE. Locked \u2192 let the rules take over again (the notes
          // are KEPT, so locking again brings them back); live \u2192 freeze
          // exactly the take drawn above. Replacing a locked take moved to
          // \ud83c\udfb2, which is the button that makes material in both states.
          if (ctx.L.part.kind === 'recorded') {
            if (!V2.release(E, ctx.L)) return;
            try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
            try { showToast('Unlocked \u2014 the rules make the part again, re-rolled every cycle. ' +
              'These notes are kept: \ud83d\udd12 Lock this take brings them back.', { ms: 5000 }); } catch (e) {}
            h._sig = ''; V2.render(E);
            return;
          }
          if (!captureShown(E, ctx.L, null)) {
            try { showToast('Nothing to lock \u2014 this cycle is empty. Check the live Rhythm settings.', { ms: 4500 }); } catch (e) {}
            return;
          }
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          try { showToast('Locked ' + ctx.L.part.notes.length + ' notes \u2014 it plays these now, and you can ' +
            'tap one to edit it. \ud83d\udd13 Unlock to go back to the rules.', { ms: 5000 }); } catch (e) {}
          h._sig = ''; V2.render(E);
          return;
        }
        const sv = t.closest('.v2-seedv1');
        if (sv) {
          const ctx = layerOf(sv); if (!ctx) return;
          const ty = sv.getAttribute('data-v1') || '';
          const info = V2.seedLikeV1(E, ctx.L, ty);
          if (!info) {
            try { if (typeof showToast === 'function') showToast('Could not seed from a v1 ' + ty + '.', { warn: true, ms: 4000 }); } catch (e) {}
            return;
          }
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          h._sig = ''; V2.render(E);
          setTimeout(() => {
            try { V2.preview(E, ctx.L); } catch (e) {}
            // the card was re-rendered above, so re-resolve it before drawing
            try {
              const c2 = document.querySelector('.v2-layer[data-v2id="' + (ctx.L.id | 0) + '"]');
              if (c2) drawPartViz(c2, ctx.L, E);
            } catch (e) {}
          }, 0);
          try {
            const lab = (V2.v1Seeds.find(x => x[0] === ty) || [ty, ty])[1];
            if (typeof showToast === 'function') {
              showToast('Seeded like a ' + lab + ' — ' + info.rhythm + ' rhythm, ' + info.pitch +
                ' pitch, ' + info.bars + ' bar' + (info.bars === 1 ? '' : 's') + '.', { ms: 4000 });
            }
          } catch (e) {}
          return;
        }
        // OPEN / CLOSE the Generated popover. A class on the card, not a
        // created node: the rows inside are ordinary gated `.ambient-ctrl`s
        // that `applyGate` already sweeps, and keeping them in the DOM is what
        // lets a commit leave the panel alone.
        const go = t.closest('.v2-genbtn');
        if (go) {
          const ctx = layerOf(go); if (!ctx) return;
          BARPOP = null; ctx.card.classList.remove('v2-baropen');
          GENPOP = ctx.L.id | 0;
          ctx.card.classList.add('v2-genopen');
          try { genSync(ctx.card, ctx.L); } catch (e) {}
          return;
        }
        // Groundwork's own door and draft-panel are GONE (2026-09-09): it is
        // the fifth shape in the Generated panel, entered through the same
        // adopt/restore/build flow as the other four.
        // THE BAR'S RULES — close, roll, reset. Tested BEFORE the Generated
        // popover's close, because `.v2-barclose` deliberately carries
        // `.v2-genclose` too (it IS that button, visually) and the generic
        // branch below would otherwise shut the wrong panel — the documented
        // duplicate-class trap, pre-armed.
        if (t.closest('.v2-barclose') || t.closest('.v2-barscrim')) {
          const ctx = layerOf(t); if (!ctx) return;
          BARPOP = null;
          ctx.card.classList.remove('v2-baropen');
          return;
        }
        const brl = t.closest('.v2-barroll');
        if (brl) {
          const ctx = layerOf(brl); if (!ctx) return;
          if (!BARPOP || BARPOP.id !== (ctx.L.id | 0)) return;
          const bs = BARPOP.bars.slice();
          const lab2 = BARPOP.nm || bs.map((k2) => V2.regLabel(k2)).join(' + ');
          if (ctx.L.part.kind === 'recorded') {
            if (!replaceOK(ctx.L, bs)) return;
            if (!captureShown(E, ctx.L, bs)) {
              try { showToast('Nothing to roll \u2014 these bars come out empty with these settings.', { ms: 4500 }); } catch (e) {}
              return;
            }
          } else {
            V2.newTake(ctx.L, bs);
          }
          try { E.getCfg(); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          try { showToast('Rolled ' + lab2 + ' again \u2014 the rest of the drawing held still.', { ms: 3500 }); } catch (e) {}
          // REDRAW, NEVER PLAY (the documented rule) — and never a card
          // rebuild, which would throw away the panel under the finger.
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          try { barpopSync(ctx.card, ctx.L); } catch (e) {}
          try { v2TakeHeard(E, ctx.L); } catch (e) {}
          return;
        }
        const brs = t.closest('.v2-barreset');
        if (brs) {
          const ctx = layerOf(brs); if (!ctx) return;
          if (!BARPOP || BARPOP.id !== (ctx.L.id | 0)) return;
          const bs = BARPOP.bars.slice();
          if (!V2.clearBarRules(ctx.L, bs)) {
            try { showToast('These bars already generate by the part\u2019s settings.', { ms: 3500 }); } catch (e) {}
            return;
          }
          try { E.getCfg(); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          const rows2 = ctx.card.querySelector('.v2-barrows'); if (rows2) rows2._sig = '';
          try { drawPartViz(ctx.card, ctx.L, E); } catch (e) {}
          try { barpopSync(ctx.card, ctx.L); } catch (e) {}
          try { v2TakeHeard(E, ctx.L); } catch (e) {}
          return;
        }
        if (t.closest('.v2-genclose') || t.closest('.v2-genscrim')) {
          const ctx = layerOf(t); if (!ctx) return;
          GENPOP = null;
          ctx.card.classList.remove('v2-genopen');
          return;
        }
        const mk = t.closest('.v2-mkpart');
        if (mk) {
          const ctx = layerOf(mk); if (!ctx) return;
          const which = mk.getAttribute('data-mk');
          // ALREADY IN THIS MODE = NOTHING TO BUILD. It used to key on the
          // STAMP alone so that an INFERRED lit chip (the rules already look
          // like that shape) would still build when pressed — but building is
          // exactly what must not happen there: it REPLACES the content you
          // have with a fresh one, which on a rolled part reset the length and
          // the notes (reported). A press on a lit chip ADOPTS the mode
          // instead — it stamps the provenance, so the state becomes explicit,
          // and leaves the content alone. Rebuilding is what the OTHER modes'
          // buttons are for, and re-rolling is 🎲 New take's.
          if (matWillDo(ctx.L, which) === 'adopt') {
            if (ctx.L.part.mat !== which) {
              ctx.L.part.mat = which;
              try { E.getCfg(); } catch (e) {}
              try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
              h._sig = ''; V2.render(E);
            }
            return;
          }
          // ASK BEFORE REPLACING. A mode press that silently re-made the
          // content is what read as a roll happening for no reason.
          const willDo = matWillDo(ctx.L, which);
          if (!matSwitchOK(ctx.L, which)) return;
          const info = (which === 'arp') ? V2.makeArp(E, ctx.L)
            : (which === 'mixed') ? V2.makeMixed(E, ctx.L)
            : (which === 'ground') ? V2.makeGround(E, ctx.L)
            : V2.makeSustain(E, ctx.L, true);
          if (!info) return;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          h._sig = ''; V2.render(E);
          // SILENT, like every other press that REWRITES rather than plays.
          // Choosing a mode used to audition, which while clicking through the
          // row reads as a stray note from nowhere; the outcome is the DRAWING
          // and ▶ Preview stays the only thing that makes sound.
          setTimeout(() => {
            try {
              const c2 = document.querySelector('.v2-layer[data-v2id="' + (ctx.L.id | 0) + '"]');
              if (c2) drawPartViz(c2, ctx.L, E);
            } catch (e) {}
          }, 0);
          try {
            if (typeof showToast === 'function') {
              // …AND WHICH OF THE THREE IT DID. "Built fresh" and "your saved
              // settings came back" are different events and looked identical.
              const how = (willDo === 'restore')
                ? ' \u00b7 your saved settings for it came back'
                : ' \u00b7 built fresh';
              showToast((which === 'arp'
                ? 'Arpeggio — sweeping the chord, ' + info.onsets + ' per cycle over ' + info.octaves + ' octaves.'
                : which === 'mixed'
                ? 'Mixed — some onsets play a chord, the rest a single note. Pitch \u25b8 Mix sets the balance.'
                : which === 'ground'
                ? 'Groundwork — plays the changes: notes on the 1 and on every change, held to the next.'
                : 'Sustained — ' + info.voices + ' voice' + (info.voices === 1 ? '' : 's') +
                  ' held for the cycle. Set Voices to 1 for a single note.') + how, { ms: 4500 });
            }
          } catch (e) {}
          return;
        }
        const hm = t.closest('.v2-harm');
        if (hm) {
          const ctx = layerOf(hm); if (!ctx) return;
          const d = hm.getAttribute('data-harm') | 0;
          const pt = ctx.L.part.pitch;
          const cur = Array.isArray(pt.harm) ? pt.harm.slice() : [];
          const at = cur.findIndex((x) => x && (x.deg | 0) === d);
          if (at >= 0) cur.splice(at, 1); else cur.push({ deg: d });
          pt.harm = cur;                       // normalize prunes an emptied list
          try { E.getCfg(); } catch (e) {}
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          h._sig = ''; V2.render(E);
          return;
        }
        const rr = t.closest('.v2-rollrun');
        if (rr) {
          const ctx = layerOf(rr); if (!ctx) return;
          // A REPEAT PRESS USED TO RE-ROLL — a mode button that silently
          // REPLACES your take when you press the one already lit. Rolling
          // another is 🎲 New take's job, above the drawing. It keyed on the
          // STAMP alone, so a chip lit by INFERENCE (a walked line IS a roll)
          // still rebuilt: the reported case, where a 5-bar per-part record
          // came back 1 bar. Lit is lit — adopt the mode, keep the content.
          if (matWillDo(ctx.L, 'roll') === 'adopt') {
            if (ctx.L.part.mat !== 'roll') {
              ctx.L.part.mat = 'roll';
              try { E.getCfg(); } catch (e) {}
              try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
              h._sig = ''; V2.render(E);
            }
            return;
          }
          // 🎲 Roll is a MODE press like the other three, and the one that
          // most looked like a roll out of nowhere — so it asks too. (🎲 New
          // take above the drawing does not: its name IS the intent, and
          // press-again-until-you-like-it is what it is for.)
          const willRoll = matWillDo(ctx.L, 'roll');
          if (!matSwitchOK(ctx.L, 'roll')) return;
          const info = V2.rollRun(E, ctx.L);
          if (!info) return;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          h._sig = ''; V2.render(E);
          // SILENT. The old rule here was "a roll you cannot hear is a dice
          // throw face-down" — but choosing a MODE is not throwing the dice
          // (🎲 above the drawing does that, and it is silent too), and while
          // clicking through the row the audition reads as a stray note.
          setTimeout(() => {
            try {
              const c2 = document.querySelector('.v2-layer[data-v2id="' + (ctx.L.id | 0) + '"]');
              if (c2) drawPartViz(c2, ctx.L, E);
            } catch (e) {}
          }, 0);
          try {
            if (typeof showToast === 'function') {
              // NOT "press again to re-roll" — a repeat press on the lit door
              // ADOPTS (it stops replacing your take, which is the whole point
              // of the lit-chip rule). 🎲 New take is what rolls another.
              showToast('Rolled a run \u2014 ' + info.pulses + ' of ' + info.steps +
                ' steps over ' + info.bars + ' bar' + (info.bars === 1 ? '' : 's') +
                (willRoll === 'restore' ? ' \u00b7 your saved Roll settings came back' : ' \u00b7 built fresh') +
                '. \ud83c\udfb2 New take rolls another; edit it in Rhythm and Pitch.', { ms: 4500 });
            }
          } catch (e) {}
          return;
        }
        const menu = t.closest('.v2-menu');
        if (menu) {
          const ctx = layerOf(menu); if (!ctx) return;
          const r = menu.getBoundingClientRect();
          // deferred a tick — showCtxMenu arms a document-level dismiss that
          // fires for THIS same event otherwise (the documented trap)
          setTimeout(() => {
            if (typeof showCtxMenu !== 'function') return;
            const isRec = ctx.L.part.kind === 'recorded';
            const _ls = ctx.L.lenSync;
            let _lsLab = '\u27f2 Loop \u2014 passes of a part\u2026';
            try {
              if (_ls && typeof _ambLenSyncLabel === 'function') {
                _lsLab = '\u27f2 Loop \u2014 ' + _ambLenSyncLabel(E.getCfg(), _ls);
              }
            } catch (e) {}
            showCtxMenu(r.left, r.bottom + 4, [
              // LOOP = N PASSES OF A PART. The modal is v1's own and already
              // resolves a `v2:` key through `_ambLayerByKey`, so this is the
              // door it never had rather than a second implementation. Deferred
              // a tick — this menu dismisses on the same dispatch otherwise.
              { label: _lsLab, fn: () => setTimeout(() => {
                  try { _ambLenSyncModal(E, { mode: 'edit', key: 'v2:' + (ctx.L.id | 0) }); } catch (e) {}
                }, 0) },
              'hr',
              isRec
                ? { label: '\u26a1 Release \u2014 back to live', fn: () => setTimeout(() => {
                    if (!V2.release(E, ctx.L)) return;
                    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                    try { if (typeof showToast === 'function') showToast('Live again \u2014 it makes its part as it plays.'); } catch (e) {}
                    h._sig = ''; V2.render(E);
                  }, 0) }
                : { label: '\u2744 Capture \u2014 keep what it plays', fn: () => setTimeout(() => {
                    if (!V2.capture(E, ctx.L)) {
                      try { if (typeof showToast === 'function') showToast('Nothing to capture yet \u2014 this cycle is empty.'); } catch (e) {}
                      return;
                    }
                    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                    try { if (typeof showToast === 'function') showToast('Captured ' + ctx.L.part.notes.length + ' notes \u2014 it now replays them. Release from this menu to go back.', { ms: 5000 }); } catch (e) {}
                    h._sig = ''; V2.render(E);
                  }, 0) },
              // SOLO is a v1 field and v1's `_ambComputeAnySolo` now counts v2
              // layers, so one solo state governs the whole mix. The label states
              // the current state rather than the action — a toggle that only
              // says the action leaves you guessing which way it is.
              { label: (ctx.L.solo ? '\u2713 S Solo (on)' : 'S Solo'), fn: () => setTimeout(() => {
                  ctx.L.solo = !ctx.L.solo;
                  try { E.getCfg(); } catch (e) {}
                  try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                  try { if (typeof _ambSoloSyncAll === 'function') _ambSoloSyncAll(E); } catch (e) {}
                  h._sig = ''; V2.render(E);
                }, 0) },
              { label: '\u270e Rename\u2026', fn: () => setTimeout(() => {
                  const v = (typeof prompt === 'function') ? prompt('Name this layer:', ctx.L.name) : null;
                  if (v == null) return;
                  ctx.L.name = String(v).trim() || ('Layer ' + ctx.L.id);
                  h._sig = '';
                  try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                  V2.render(E);
                }, 0) },
              { label: '\u2715 Remove layer', danger: true, fn: () => setTimeout(() => {
                  if (typeof confirm === 'function' && !confirm('Remove "' + ctx.L.name + '"?')) return;
                  const c2 = E.getCfg();
                  c2.layers = (c2.layers || []).filter(x => x !== ctx.L);
                  try { if (E._v2Phase) delete E._v2Phase['v2:' + ctx.L.id]; } catch (e) {}
                  try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                  h._sig = ''; V2.render(E);
                }, 0) },
            ]);
          }, 0);
          return;
        }
        const on = t.closest('.v2-on');
        if (on) { const ctx = layerOf(on); if (ctx) { ctx.L.on = !ctx.L.on; h._sig = ''; V2.render(E); } return; }
        // NO stepper handling here. `__ambStepperWired` in 17 already delegates
        // every `.ambient-step-btn` at DOCUMENT level — it nudges the sibling
        // `.ambient-step-inp` and dispatches 'input', which our own input
        // listener above then commits. Handling it here as well made every ± tap
        // count TWICE (measured 5 -> 7 on one click).
      });
    }
    // …and the page stays where it was. A rebuild that genuinely SHORTENS the
    // document (a layer deleted, a card collapsed) is clamped by the browser
    // exactly as it should be, so this restores a position rather than forcing
    // one; anything that legitimately wants to scroll — the note editor coming
    // into view, 🔍 Find flashing a row — runs after this and still wins.
    try {
      if (_scroller && _scrollWas && _scroller.scrollTop !== _scrollWas) {
        _scroller.scrollTop = _scrollWas;
      }
      if (_docScrollWas != null && _docScroller.scrollTop !== _docScrollWas) {
        _docScroller.scrollTop = _docScrollWas;
      }
    } catch (e) {}
  };

  // A NEW LAYER OPENS ON THE PATTERN GRID. It defaulted to `pulse`, which has no
  // grid — so adding a layer and expanding it showed no compose surface at all
  // unless you happened to open the Rhythm dropdown and pick the right entry.
  // Reported twice. The grid is the thing people come here for; a pad is one
  // dropdown away, and that is the right way round.
  V2.addDefault = function (E) {
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg) return null;
    const L = V2.add(cfg, { name: 'Layer', instrument: { tone: '', register: 4, level: 65 },
      part: { kind: 'live', bars: 2, rhythm: { kind: 'euclid', steps: 8, pulses: 3, rotate: 0 },
              pitch: { kind: 'chord', voices: 3 }, shape: { lenRatio: 90 } } });
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    V2.render(E);
    return L;
  };
})();
