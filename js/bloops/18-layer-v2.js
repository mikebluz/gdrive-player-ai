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
  const RHYTHMS = new Set(['pulse', 'euclid', 'chance', 'drawn']);
  const PITCHES = new Set(['chord', 'fixed', 'stack', 'walk', 'anchor', 'series', 'chance', 'drawn']);
  const KINDS = new Set(['live', 'recorded']);

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
    // CYCLE — how long one pass of the part is. Live states it; a recorded part
    // may state it too (the length it was recorded at).
    p.bars = clamp(Number.isFinite(p.bars) && p.bars > 0 ? p.bars : 2, 0.125, 64);

    // BOTH HALVES ARE ALWAYS COERCED, whichever is active. Write is a DOOR:
    // a captured layer keeps its live spec so it can be released back, and a
    // live layer keeps its notes so a release is not a one-way loss. Coercing
    // only the active branch (the first cut) silently dropped the other on the
    // next normalize, which would have made the door one-way.
    {
      const r = (p.rhythm && typeof p.rhythm === 'object') ? p.rhythm : (p.rhythm = {});
      r.kind = RHYTHMS.has(r.kind) ? r.kind : 'pulse';
      r.n = clamp((r.n | 0) || 1, 1, 64);                  // pulse: onsets per cycle
      r.steps = clamp((r.steps | 0) || 8, 1, 64);          // euclid grid
      r.pulses = clamp((r.pulses | 0) || 3, 1, r.steps);
      r.rotate = clamp((r.rotate | 0) || 0, 0, 63);
      // Absent or 0 = the pattern exactly as drawn, and no RNG draw at all.
      if (Number.isFinite(r.vary) && r.vary > 0) r.vary = clamp(r.vary, 0, 100); else delete r.vary;
      if (Number.isFinite(r.syncop) && r.syncop > 0) r.syncop = clamp(r.syncop, 0, 100); else delete r.syncop;
      // Absent or 1 = a single euclid row, which is what v2 has always played.
      if (Number.isFinite(r.voices) && r.voices > 1) r.voices = clamp(r.voices | 0, 1, 8); else delete r.voices;
      r.chance = clamp(Number.isFinite(r.chance) ? r.chance : 40, 0, 100);   // chance: % per step
      // DRAWN — the cell grid. It is the euclid generator's output made
      // EDITABLE, exactly as v1's `euclidPattern` overrides its own formula, so
      // "euclid patterning" and "draw it by hand" are one control rather than
      // two. Length always tracks `steps`: grow pads with rests, shrink
      // truncates, so a Steps edit can never leave the grid disagreeing with
      // the number above it. Kept coerced whichever rhythm is active — the
      // both-halves rule that keeps every door two-way.
      if (!Array.isArray(r.cells)) r.cells = [];
      r.cells = r.cells.slice(0, r.steps).map(c => (c ? 1 : 0));
      while (r.cells.length < r.steps) r.cells.push(0);
      // KIT LANES — one drawn row per drum, same coercion as `cells` (length
      // always tracks `steps`, so a Steps edit can never leave a lane
      // disagreeing with the number above it). Kept coerced whichever
      // instrument is active, so switching to a kit and back is not a loss.
      if (!Array.isArray(r.lanes)) r.lanes = [];
      r.lanes.length = _V2_LANES;
      for (let li = 0; li < _V2_LANES; li++) {
        const row = Array.isArray(r.lanes[li]) ? r.lanes[li] : [];
        const out2 = row.slice(0, r.steps).map(c => (c ? 1 : 0));
        while (out2.length < r.steps) out2.push(0);
        r.lanes[li] = out2;
      }

      const t = (p.pitch && typeof p.pitch === 'object') ? p.pitch : (p.pitch = {});
      t.kind = PITCHES.has(t.kind) ? t.kind : 'chord';
      t.voices = clamp((t.voices | 0) || 3, 1, 9);         // how many notes per onset
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
      ['stutter'].forEach((k2) => {
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
      if (!Array.isArray(t.steps)) t.steps = [];
      t.steps = t.steps.slice(0, r.steps).map(v => clamp((v | 0) || 1, 1, 24));
      while (t.steps.length < r.steps) t.steps.push(1);

      const s = (p.shape && typeof p.shape === 'object') ? p.shape : (p.shape = {});
      s.lenRatio = clamp(Number.isFinite(s.lenRatio) ? s.lenRatio : 90, 1, 400);   // % of the onset span
      // 0 = off, i.e. Length governs. Stored only when it is doing something.
      if (Number.isFinite(s.holdSteps) && s.holdSteps > 0) s.holdSteps = clamp(s.holdSteps | 0, 0, 16);
      else delete s.holdSteps;
      // MAX EVENTS — a hard ceiling on note-events per cycle, keeping the
      // EARLIEST (v1's rule). 0 = off.
      if (Number.isFinite(s.maxEvents) && s.maxEvents > 0) s.maxEvents = clamp(s.maxEvents | 0, 0, 64);
      else delete s.maxEvents;
    }
    {
      // RECORDED — literal notes. `t` is a fraction of the cycle [0,1), `midi`
      // absolute, `dur` in beats-of-the-cycle so a tempo change scales it.
      if (!Array.isArray(p.notes)) p.notes = [];
      if (p.notes.length > 512) p.notes.length = 512;   // a cycle is not a song
      p.notes = p.notes.filter(n => n && Number.isFinite(n.t) && Number.isFinite(n.midi)).map(n => ({
        t: clamp(n.t, 0, 0.99999),
        midi: clamp(n.midi | 0, 0, 127),
        dur: clamp(Number.isFinite(n.dur) && n.dur > 0 ? n.dur : 0.25, 0.001, 8),
      })).sort((a, b) => a.t - b.t);
      // A recorded part is fixed pitch material, but it still has to answer to a
      // key change — the engine transposes rather than re-resolving (the v1
      // frozen-loop rule). `transpose` is that offset, applied at read time.
      p.transpose = clamp((p.transpose | 0) || 0, -48, 48);
      // Absent = bars, so a project made before free cycles existed is
      // byte-identical and `part.ms` is stored only once it is chosen.
      if (p.clock !== 'free') { delete p.clock; delete p.ms; }
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
          return { root: ((root % 12) + 12) % 12, ivs: ivs.slice() };
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
          return { root: ((ch.root % 12) + 12) % 12, ivs: ch.intervals.slice() };
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

  // ── PART: LIVE ──────────────────────────────────────────────────────────
  // The euclidean generator, borrowed from v1 (`euclideanPattern` in 09) rather
  // than reimplemented — it feeds BOTH the `euclid` rhythm and the seed for the
  // `drawn` one, so the two can never disagree about what a 3-in-8 looks like.
  function euclidCells(pulses, steps, rotate) {
    const st = Math.max(1, steps | 0), pu = clamp(pulses | 0, 0, st);
    try {
      if (typeof euclideanPattern === 'function') {
        const p = euclideanPattern(pu, st, rotate | 0);
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
      const d = clamp((t.degree | 0) - 1, 0, N - 1);
      part._deg = d;
      out.push(base + set.ivs[d]);
      return out;
    }
    if (t.kind === 'stack') {
      // `voices` consecutive source tones from the Degree, octave on each wrap
      const from = clamp((t.degree | 0) - 1, 0, N - 1);
      const want = clamp(t.voices | 0, 1, 9);
      for (let i = 0; i < want; i++) {
        const k = from + i, idx = k % N, oct = Math.floor(k / N);
        out.push(base + set.ivs[idx] + 12 * oct);
      }
      return out;
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
      const from = clamp((t.degree | 0) - 1, 0, N - 1) + homeShift;
      const rnd = (typeof _ambSeededRand === 'function')
        ? _ambSeededRand((((ctxSeed | 0) + 1) * 40503) >>> 0) : Math.random;
      // STUTTER — v1's rule: repeat the PREVIOUS degree instead of stepping,
      // which is what turns a walk into chord-tone phrasing. Consumes no
      // further pick, so the walk resumes from the same place.
      const stut = clamp(t.stutter | 0, 0, 100);
      if (stut > 0 && mem && Number.isFinite(mem.prev) && rnd() * 100 < stut * 0.45) {
        const kS = mem.prev;
        const iS = ((kS % N) + N) % N, oS = Math.floor(kS / N);
        part._deg = kS; part._oct = oS;
        out.push(base + set.ivs[iS] + 12 * oS);
        return out;
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
      let k = _nearer(from + step, mem, prox);
      // GRAVITY IS NOT PORTED, and that is a MODEL difference rather than an
      // omission: v1's motif walks a chromatic-ish space and gravity pulls a
      // stray note onto a chord tone, whereas v2 picks by INDEX into the
      // sounding tone set (`set.ivs[k % N]`) — so every pick is already a chord
      // tone and there is nothing to pull. Written, measured as a literal
      // no-op, and removed: a control that cannot do anything is worse than an
      // absent one.
      if (mem) mem.prev = k;
      const i4 = ((k % N) + N) % N, oct = Math.floor(k / N);
      part._deg = k; part._oct = oct;
      out.push(base + set.ivs[i4] + 12 * oct);
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
    const want = clamp(t.voices | 0, 1, 9);
    for (let i = 0; i < want; i++) {
      const idx = i % N, oct = Math.floor(i / N);
      out.push(base + set.ivs[idx] + 12 * oct);
    }
    return out;
  }

  // ── THE PART INTERFACE ──────────────────────────────────────────────────
  // notesFor(layer, ctx) → [{ at, freq, durMs }]
  // ONE contract, two implementations. Everything above is an implementation
  // detail of the live one; the emitter below knows only this signature.
  function notesFor(L, ctx) {
    const p = L.part, out = [];
    const cyc = ctx.cycleSec, cs = ctx.cycleStart;
    if (p.kind === 'recorded') {
      const tr = p.transpose | 0;
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
      for (let i = 0; i < p.notes.length; i++) {
        const n = p.notes[i];
        const at = cs + n.t * cyc;
        let f = midiToFreq(n.midi + tr);
        if (hz && kc) {
          try { f = withKeyTime(at, () => _ambLockHarmonizeFreq(L, kc, f, at)) || f; } catch (e) {}
        }
        out.push({ at, freq: f, durMs: Math.round(n.dur * cyc * 1000) });
      }
      return out;
    }
    const cycIdx = Math.round(ctx.cycleStart / Math.max(0.001, cyc));
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
    const ons = onsetsOf(p, seedBase);
    const span = cyc / Math.max(1, ons.length);           // the onset span sizes the note
    // HOLD sizes the note off the STEP GRID instead — N steps long, whatever the
    // onset spacing happens to be. v1's own semantics (`holdSteps`, 0 = use the
    // length instead): the two answer different questions, and a sparse pattern
    // is exactly where they diverge — Length stretches with the gaps, Hold does
    // not. Absent or 0 keeps Length, so nothing moves by default.
    const holdN = clamp((p.shape.holdSteps | 0), 0, 16);
    const durMs = (holdN > 0)
      ? Math.max(20, Math.round((cyc / Math.max(1, p.rhythm.steps | 0)) * 1000 * holdN))
      : Math.max(20, Math.round(span * 1000 * (p.shape.lenRatio / 100)));
    // RESTS through v1's own `_ambEffRest`, which ADDS the Area Groove
      // density macro on top of the layer's value — reading `L.restProb`
      // directly is why the groove panel's Density did nothing to a v2 layer.
      const rest = (typeof _ambEffRest === 'function') ? (_ambEffRest(L) | 0) : (L.restProb | 0);
      const ghost = L.ghosts | 0, lvar = L.lenVary | 0;
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
        try { vpat = _ambEuclidVoicePat(p.rhythm.pulses | 0, p.rhythm.rotate | 0, stp, evc, v, 0); } catch (e) {}
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
      const at = cs + ons[i] * cyc;
      // The step INDEX, not the onset ordinal: a drawn pitch belongs to the cell
      // it was drawn on, so with a sparse rhythm step 5 must keep step 5's note
      // even if it is only the second onset.
      const stepIdx = (p.rhythm.kind === 'euclid' || p.rhythm.kind === 'drawn' || p.rhythm.kind === 'chance')
        ? Math.round(ons[i] * Math.max(1, p.rhythm.steps | 0)) : i;
      const ms = withKeyTime(at, () => pitchesAt(p, ctx.E, ctx.cfg, at, L.instrument.register, seedBase ^ (i * 2654435761), stepIdx, mem, L));
      // LEN VARY scales this onset's notes together — a chord must not come
      // apart into different lengths, which is why it is per ONSET not per note.
      let dm = durMs;
      if (lvar > 0) dm = Math.max(20, Math.round(durMs * (1 + (vRnd(seedBase ^ (i * 40503), 23) * 2 - 1) * (lvar / 100) * 0.6)));
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
        for (let v = 0; v < ms.length; v++) {
          const nt2 = { at, freq: midiToFreq(ms[v]), durMs: dm };
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

  function captureFn(E, L) {
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg || !L) return false;
    const ctx = currentCycle(E, L, cfg);
    // Read through the LIVE spec whichever kind is active — that spec is always
    // retained, so "capture from live" is meaningful on an already-recorded
    // part too (re-take it) and, crucially, a part that was switched to
    // Recorded with nothing in it has a way to become non-empty.
    const asLive = Object.assign({}, L, { part: Object.assign({}, L.part, { kind: 'live' }) });
    let notes = [];
    try { notes = notesFor(asLive, { E, cfg, key: 'v2:' + L.id, cycleStart: ctx.cycleStart, cycleSec: ctx.cycleSec }); }
    catch (e) { return false; }
    if (!notes.length) return false;                    // nothing to freeze
    L.part.notes = notes.map(n => ({
      t: clamp((n.at - ctx.cycleStart) / ctx.cycleSec, 0, 0.99999),
      midi: clamp(freqToMidi(n.freq), 0, 127),
      dur: clamp((n.durMs / 1000) / ctx.cycleSec, 0.001, 8),
    })).sort((a, b) => a.t - b.t);
    L.part.kind = 'recorded';
    L.part.transpose = L.part.transpose | 0;
    stampPartKey(L, (function () { try { return E.getCfg(); } catch (e) { return null; } })());
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
    try { notes = notesFor(asLive, { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }); } catch (e) {}
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
    if (!got) { L.part.notes = []; L.part.kind = 'recorded'; return true; }   // drew nothing = a rest, honoured
    let bars = got.beats / 4;
    try { if (typeof _ambSnapBars === 'function') bars = _ambSnapBars(bars); }
    catch (e) { bars = Math.round(bars * 48) / 48; }
    L.part.bars = clamp(bars > 0 ? bars : 1, 0.125, 64);
    L.part.notes = got.notes.slice().sort((a, b) => a.t - b.t);
    stampPartKey(L, (function () { try { return ge.E.getCfg(); } catch (e) { return null; } })());
    L.part.kind = 'recorded';
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
    for (let guard = 0; guard < 64; guard++, c++) {
      const cs = st.startAt + c * cyc;
      if (cs >= to) break;
      if (cs + cyc <= from - 1e-6) continue;
      // WHEN — which ITERATIONS this layer plays. Emitter-side in v1
      // (`_ambCondFires`), so v2 has to ask; it is not one of the playNote-hook
      // gates. `c` is the cycle index, which is exactly what it wants.
      let fires = true;
      try { if (typeof _ambCondFires === 'function') fires = _ambCondFires(L.when, c, cs); } catch (e) {}
      if (!fires) continue;
      let notes = [];
      try { notes = notesFor(L, { E, cfg, key, cycleStart: cs, cycleSec: cyc }); } catch (e) { break; }
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
    }
    st.lastAt = to;
  }

  // ── TICK ────────────────────────────────────────────────────────────────
  // Called from _ambTick once per tick. Installs the SAME capture sink the v1
  // window branch does — that is what stamps `_ambEmitKey` inside playNote, so
  // the gates, Write capture and per-layer routing all see a v2 note exactly as
  // they see a v1 one.
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
      const probe = notesFor(L, { E, cfg, key, cycleStart: t0, cycleSec: sec });
      let m = Infinity;
      for (let i = 0; i < probe.length; i++) {
        const n = probe[i];
        if (n && n.freq > 0 && n.at < m) m = n.at;
      }
      if (Number.isFinite(m) && m > t0) off = Math.min(m - t0, sec);
    } catch (e) {}
    PV_VIZ = { id: L.id | 0, at: t0 - off, sig: partSigFn(L) };
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
      if (!Number.isFinite(E._barGridAnchor)) {
        E._progAnchor = t0; E._playStartAt = t0; E._barGridAnchor = t0;
      }
      window._ambEmitCutoff = null;
      window._ambHangEmitting = true;
      emit(E, L, key, t0 - 0.05, t0 + sec + 0.01, 0.12, 0, cfg);
    } catch (e) {
    } finally {
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
  const _ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const _pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  // SUSTAINED — one onset per cycle, held. Poly by default because that is the
  // pad case; Voices 1 makes it the mono one, which is why there is one door
  // and not two (the Voices control already says which).
  function makeSustainFn(E, L, poly) {
    if (!L || !L.part) return null;
    const p = L.part;
    p.kind = 'live';
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
    p.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    p.pitch = { kind: 'series', dir: 'up', octaves: 2, degree: 1 };
    p.shape = Object.assign({}, p.shape, { lenRatio: 70, holdSteps: 0 });
    try { E.getCfg(); } catch (e) {}
    return { onsets: p.rhythm.n, octaves: p.pitch.octaves };
  }
  function rollRunFn(E, L) {
    if (!L || !L.part) return null;
    const p = L.part;
    // A roll makes a LIVE part — that is what a Riff is. A recorded one would
    // freeze a single realisation and New take could never move it.
    p.kind = 'live';
    p.bars = _pick([1, 1, 2, 2, 4]);
    const steps = _pick([8, 16, 16]);
    // EUCLID, not an even pulse: the syncopation is most of what makes a riff
    // a riff, and it leaves a Pattern grid the user can edit afterwards.
    const pulses = Math.max(2, Math.min(steps - 1, Math.round(steps * (0.3 + Math.random() * 0.35))));
    p.rhythm = { kind: 'euclid', steps, pulses, rotate: _ri(0, steps - 1), n: 1 };
    p.pitch = {
      kind: 'walk',
      degree: _pick([1, 1, 1, 2, 3]),
      span: _ri(3, 8),
      home: _pick(['floor', 'floor', 'center']),
      stutter: _pick([0, 0, 10, 25, 40]),
      dir: 'up',
    };
    p.shape = Object.assign({}, p.shape, { lenRatio: _ri(45, 95) });
    try { E.getCfg(); } catch (e) {}   // normalize coerces/prunes what we wrote
    return { steps, pulses, bars: p.bars, span: p.pitch.span };
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
    v1Seeds: V1_SEEDS,
    makeSustain: makeSustainFn,
    makeArp: makeArpFn,
    previewKill: previewKill,
    previewing: previewing,
    previewCycle: () => PV_VIZ,
    partSig: partSigFn,
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
    notesFor,                      // the interface, callable directly
    onsetsOf,
    capture: captureFn,            // door 1 into a recorded part: freeze the live one
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
    add: addLayer,
    clear(cfg) { if (cfg) cfg.layers = []; },
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
  function partVizHtml() {
    return '<div class="v2-partviz"><canvas class="v2-vizcv" height="84"></canvas>' +
           '<span class="v2-vizlab ambient-hint"></span></div>';
  }
  function drawPartViz(card, L, E) {
    const host = card && card.querySelector('.v2-partviz'); if (!host) return;
    const cv = host.querySelector('.v2-vizcv'), lab = host.querySelector('.v2-vizlab');
    if (!cv || !cv.getContext) return;
    const w = Math.max(80, Math.round(cv.clientWidth || host.clientWidth || 300));
    const h = 84;
    const dpr = Math.min(3, (window.devicePixelRatio || 1));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = '100%'; cv.style.height = h + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    let cfg = null; try { cfg = E.getCfg(); } catch (e) {}
    if (!cfg) return;
    let cyc = 2, notes = [];
    try { cyc = Math.max(0.05, V2.cycleSec(L, cfg)); } catch (e) {}
    // DRAW THE CYCLE THE PREVIEW PLAYED, not cycle 0. A live part re-rolls per
    // cycle, so a fixed drawing disagrees with every press. The remembered
    // cycle is used only while the part still matches the one it was taken
    // from — change a knob and it falls back to a representative cycle, which
    // is honest rather than stale.
    let cs = 0, fromPv = false;
    try {
      const pv = V2.previewCycle && V2.previewCycle();
      if (pv && pv.id === (L.id | 0) && pv.sig === V2.partSig(L) && Number.isFinite(pv.at)) {
        cs = pv.at; fromPv = true;
      }
    } catch (e) {}
    try {
      notes = V2.notesFor(L, { E, cfg, key: 'v2:' + (L.id | 0), cycleStart: cs, cycleSec: cyc }) || [];
    } catch (e) { notes = []; }
    // THE RULER — beats, bars and bar NUMBERS, in a gutter of their own. Bar
    // lines alone gave the drawing a scale but no reading: you could see that
    // something was wide without knowing whether it was a beat or a bar.
    // Fractional cycles are drawn honestly (a ⅔-bar motif shows two thirds of a
    // bar, not a rounded one), and a FREE part has no bar grid at all — saying
    // so is better than drawing a grid its clock does not follow.
    const TOP = 15;                       // the ruler gutter
    const free = L.part && L.part.clock === 'free';
    const barsF = Math.max(0.0625, (L.part && L.part.bars) || 1);
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
      g.fillText('free · ' + Math.round((L.part && L.part.ms) || 0) + 'ms', 3, 10);
      g.beginPath(); g.moveTo(0, TOP + 0.5); g.lineTo(w, TOP + 0.5); g.stroke();
    } else {
      const beats = Math.max(1, Math.round(barsF * 4));
      for (let i = 0; i <= beats; i++) {
        const atBar = (i % 4) === 0;
        const x = Math.round((i / beats) * w) + 0.5;
        if (x > w) break;
        g.strokeStyle = atBar ? 'rgba(159,122,234,0.30)' : 'rgba(159,122,234,0.10)';
        g.beginPath();
        g.moveTo(x, atBar ? 2 : TOP - 4); g.lineTo(x, h); g.stroke();
        if (atBar && i < beats) {
          g.fillStyle = '#7a7a9c';
          g.fillText(String(i / 4 + 1), Math.min(w - 8, x + 3), 10);
        }
      }
      // the gutter's floor, so the numbers read as a ruler rather than as
      // labels floating over the notes
      g.strokeStyle = 'rgba(159,122,234,0.18)';
      g.beginPath(); g.moveTo(0, TOP + 0.5); g.lineTo(w, TOP + 0.5); g.stroke();
    }
    // `notesFor` returns ABSOLUTE times (cycleStart + offset), so a remembered
    // cycle start has to be subtracted back off before drawing.
    notes = notes.map(n => (n && Number.isFinite(n.at)) ? { at: n.at - cs, freq: n.freq, durMs: n.durMs } : n);
    const played = notes.filter(n => n && n.freq > 0 && n.at >= -1e-6 && n.at < cyc);
    if (!played.length) {
      g.fillStyle = '#6b6b8a'; g.font = '12px -apple-system, Segoe UI, sans-serif';
      g.fillText('silent for this cycle', 8, TOP + (h - TOP) / 2 + 4);
      if (lab) lab.textContent = (L.part && L.part.kind === 'recorded' ? 'recorded' : 'live') + ' · ' + barTxt;
      return;
    }
    const mids = played.map(n => 69 + 12 * Math.log2(n.freq / 440));
    let lo = Math.min(...mids), hi = Math.max(...mids);
    if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
    const pad = 6, span = Math.max(1, hi - lo);
    for (let i = 0; i < played.length; i++) {
      const n = played[i];
      const x = (n.at / cyc) * w;
      const dw = Math.max(3, ((Math.max(20, n.durMs || 0) / 1000) / cyc) * w);
      const y = TOP + pad + (1 - (mids[i] - lo) / span) * (h - TOP - pad * 2 - 6);
      g.fillStyle = 'rgba(159,122,234,0.55)';
      g.strokeStyle = '#d6bcfa'; g.lineWidth = 1;
      const ww = Math.min(dw, w - x);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, ww, 6, 3); else g.rect(x, y, ww, 6);
      g.fill(); g.stroke();
    }
    if (lab) {
      lab.textContent = (L.part && L.part.kind === 'recorded' ? 'recorded' : 'live') + ' · ' +
        played.length + ' note' + (played.length === 1 ? '' : 's') + ' · ' + barTxt +
        ' · ' + (Math.round(cyc * 10) / 10) + 's' +
        (fromPv ? ' · as previewed' : (L.part && L.part.kind === 'live' ? ' · one take of many' : ''));
    }
  }

  const RHYTHM_OPTS = [['pulse', 'Pulse — evenly'], ['euclid', 'Pattern — a grid you edit'],
                       ['chance', 'Chance — scattered']];
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
      const notes = V2.notesFor(Object.assign({}, L, { part: Object.assign({}, L.part, { kind: 'live' }) }),
        { E: _engOf(), cfg: _cfgOf(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 2 });
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
                      ['fixed', 'Fixed — one note'], ['series', 'Series — sweep the chord'],
                      ['anchor', 'Anchor — a pedal point'], ['walk', 'Walk — a line'],
                      ['chance', 'Chance — any tone']];

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
  const sl = (L, field, label, v, min, max, hint, when) => {
    if (typeof _ambSl !== 'function') return '';
    let h = tag(_ambSl(label, uid(L, field), min, max, v, hint), 'ambient-sl', field, when);
    // The unit line rides on the ROW so the knob (which replaces the slider in
    // the sheet) can say what its number means — _ambSl folds `hint` into a
    // title attribute, which a knob face cannot show.
    if (hint) h = h.replace('<div ', '<div data-v2u="' + esc(String(hint)) + '" ');
    return h;
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
  const GRPS = ['Instrument', 'Envelope', 'Part', 'Rhythm', 'Pitch', 'Voicing',
                'Shape', 'Motion', 'Mix', 'Mod', 'Space', 'FX'];
  // TAB CLUSTER — rows sharing a `data-v2tab` become ONE tab in the sheet.
  // Used only where a "parameter" is genuinely plural (an FX stage and its own
  // params, the speech source, the Notes door) or where bare labels collide.
  // Tags every <div in the fragment; only top-level pane children are ever
  // consulted, so the nested ones are inert.
  const tb = (name, html) => html.split('<div ').join('<div data-v2tab="' + name + '" ');
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
        '<div class="v2-grpgrid">' + GRPS.map(g4 =>
          '<button type="button" class="v2-grpbtn" data-v2grp="' + g4 + '">' +
            '<span class="v2-grpbt">' + g4 + '</span>' +
            '<span class="ambient-hint v2-grpsum" data-grp="' + g4 + '"></span>' +
          '</button>').join('') + '</div>' +
        // ── INSTRUMENT — what makes the sound ─────────────────────────────
        grpOpen('Instrument', true,
          sel(L, 'instrument.voice', 'Voice', i.voice,
              [['synth', 'Synth — pitched'], ['kit', 'Drum kit — lanes'], ['speech', 'Speech — words']]) +
          // SPEECH. The TTS voice is `instrument.speechVoice`, NOT `voice` —
          // that one is the instrument. `_ambVoiceChoices` reads `L.voice`
          // meaning the TTS one, so it gets a shim.
          sel(L, 'instrument.speechVoice', 'Spoken by', i.speechVoice || '',
              speechVoiceOpts(i.speechVoice || ''), 'voice:speech') +
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
          sel(L, 'instrument.kit', 'Kit', i.kit, kitOptions(i.kit), 'voice:kit') +
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
          '<div class="ambient-ctrl" data-v2when="voice:synth"><label for="' + uid(L, 'instrument.tone') + '">Tone</label>' +
            '<select id="' + uid(L, 'instrument.tone') + '" class="ambient-select v2-f" data-f="instrument.tone">' + toneOptions(i.tone) + '</select>' +
            '<span class="ambient-hint"></span></div>' +
          st(L, 'instrument.register', 'Register', i.register, 1, 8, 'octave', 'voice:synth') +
          // SCHEDULED TONE — cycle the voice on the BAR clock (4 bars saw, then
          // 4 bars sine, repeat). v1's own builder, and its handler is delegated
          // on the panel host resolving the layer through `_ambCardKey`, which
          // falls back to `[data-phkey]` — a v2 card has carried that since
          // slice 5, so this works with no wiring here either.
          ((typeof _ambToneSeqBoxHtml === 'function')
            ? ('<div class="ambient-ctrl ambient-toneseq-ctrl" data-v2when="voice:synth"><label>Tone cycle</label>' +
                 '<div class="ambient-toneseq-box">' + _ambToneSeqBoxHtml(L) + '</div>' +
                 '<span class="ambient-hint">bar-clocked voice changes</span></div>')
            : '')
        ) +
        // ── ENVELOPE — the instrument's shape over time ───────────────────
        // Split out when the scheduled-tone row landed: Instrument was 456px of
        // the card's 1406 and half of that was the ADSR, which is a group in its
        // own right on any synth. (`decay` and `sustain` were stored and
        // threaded to `_ambApplyAdsr` from slice 13 with no control at all —
        // the reachability rule broken quietly for eight slices.)
        grpOpen('Envelope', false,
          sl(L, 'instrument.attack', 'Attack', i.attack, 0, 8000, 'ms') +
          sl(L, 'instrument.decay', 'Decay', num(i.decay, 200), 0, 8000, 'ms') +
          sl(L, 'instrument.sustain', 'Sustain', num(i.sustain, 70), 0, 100, '%') +
          sl(L, 'instrument.release', 'Release', i.release, 0, 12000, 'ms')
        ) +
        // ── PART — live or recorded, and how long a pass is ───────────────
        grpOpen('Part', true,
          // FIRST, so pressing a seed button and seeing the result is one glance
          // rather than a toast and a guess.
          partVizHtml() +
          // "Part type", not "Part": the group is already called Part, so a tab
          // and a row both reading "Part" inside it named nothing. This row is
          // the KIND — live or recorded — and the tab takes its name from the
          // label, so renaming the label renames both.
          sel(L, 'part.kind', 'Part type', p.kind, [['live', 'Live — made as it plays'], ['recorded', 'Recorded — notes read back']]) +
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
            : st(L, 'part.bars', 'Bars', p.bars, 1, 32, 'per cycle', 'clock:bars')) +
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
          sel(L, 'harmony', 'Harmony', L.harmony || 'fixed',
              [['fixed', 'Fixed — as written'], ['diatonic', 'Follow the key'], ['chordlock', 'Lock to the chord']],
              'kind:recorded') +
          sel(L, 'speed', 'Speed', String(num(L.speed, 1)),
              [['0.25', '¼ — four times slower'], ['0.5', '½ — half speed'], ['1', '1× — as written'],
               ['2', '2× — double speed'], ['4', '4× — four times faster']]) +
          // THE DOOR, ON THE CARD. Selecting "Recorded" from the dropdown used to
          // be a dead end: nothing authors notes, so the part was silent with no
          // way forward and no explanation. (rule 6: name the door.)
          // ONE row, not one per kind. Two elements sharing a class where only
          // one is ever visible is a trap for every future querySelector — the
          // first probe to touch it grabbed the hidden one and reported the
          // button as unreachable.
          '<div data-v2tab="Notes from" class="ambient-ctrl v2-notesrow"><label>Notes from</label>' +
            '<span class="ambient-seg-row">' +
              '<button type="button" class="ambient-seg v2-compose">✎ Compose…</button>' +
              '<button type="button" class="ambient-seg v2-capture">' +
                (p.kind === 'recorded' ? '❄ Re-take live' : '❄ The live part') + '</button>' +
              '<button type="button" class="ambient-seg v2-adopt">♪ A phrase…</button>' +
              // A LIVE door beside the three recorded ones: "where do the notes
              // come from" is the question this row answers, and "rolled" is
              // one of the answers. Press again to re-roll.
              '<button type="button" class="ambient-seg v2-mkpart" data-mk="sustain" title="A held note or chord, one per cycle — the pad shape. Voices makes it mono or poly.">▬ Sustained</button>' +
              '<button type="button" class="ambient-seg v2-mkpart" data-mk="arp" title="Sweep the chord one tone per onset — an arpeggio. The rhythm grid sets the speed.">⟳ Arpeggio</button>' +
              '<button type="button" class="ambient-seg v2-rollrun" title="Roll a riff — a syncopated line, live and re-rollable. Auditions straight away.">🎲 Roll a run</button>' +
            '</span>' +
            '<span class="ambient-hint v2-notecount"></span></div>' +
          // SEED LIKE A v1 LAYER — one button per type. Its own row rather than
          // more buttons on the one above: that row answers "recorded from
          // where", these answer "what shape is the live part", and seven more
          // chips in there would have made a wall of thirteen.
          '<div data-v2tab="Seed like" class="ambient-ctrl"><label>Seed like</label>' +
            '<span class="ambient-seg-row">' +
            ((V2 && V2.v1Seeds) || []).map(([ty, lab]) =>
              '<button type="button" class="ambient-seg v2-seedv1" data-v1="' + ty + '"' +
              ' title="Seed this part the way adding a v1 ' + lab + ' seeds one — its rhythm, its pitch shape and its length. Your instrument is left alone.">' +
              lab + '</button>').join('') +
            '</span>' +
            '<span class="ambient-hint">the part only — the voice you chose stays</span></div>' +
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
            '<div class="ambient-ctrl"><label></label><span class="ambient-seg-row">' +
              '<button type="button" class="ambient-seg v2-gdone">✓ Done</button>' +
              '<button type="button" class="ambient-seg ambient-seedgrid-bank" data-sgk="v2:' + L.id + '"' +
                ' title="Save this phrase to the sequence bank under a name, so it can be reused — on another layer, in another area, or bound to a part.">⬇ To bank…</button>' +
              '<button type="button" class="ambient-seg v2-gcancel">✕ Cancel</button>' +
            '</span><span class="ambient-hint">what you draw is what it plays</span></div>' +
          '</div>' +
          ((p.kind === 'recorded' && !(p.notes || []).length)
            ? '<div data-v2tab="Notes from" class="ambient-ctrl" data-v2when="kind:recorded"><label></label>' +
              '<span class="ambient-hint" style="color:#f6ad55">Nothing recorded yet — take the live part, adopt a phrase, or switch Part back to Live.</span></div>'
            : '')
        ) +
        // ── RHYTHM — when the notes happen ────────────────────────────────
        grpOpen('Rhythm', true,
          // `rhythmShown`, not `r.kind` — 'drawn' matches no option, and a
          // <select> with no matching option does not render empty, it silently
          // falls back to the FIRST one ("Pulse"). `applyGate` corrects it a
          // moment later, but the markup should be right on its own rather than
          // relying on a later pass to repair it.
          sel(L, 'part.rhythm.kind', 'Rhythm', rhythmShown(r.kind), RHYTHM_OPTS, 'kind:live;voice:synth') +
          st(L, 'part.rhythm.n', 'Onsets', r.n, 1, 64, 'per cycle', 'kind:live;voice:synth;rhythm:pulse') +
          st(L, 'part.rhythm.steps', 'Steps', r.steps, 1, 64, 'grid', 'kind:live') +
          st(L, 'part.rhythm.pulses', 'Pulses', r.pulses, 1, 64, 'hits', 'kind:live;voice:synth;rhythm:euclid,drawn') +
          st(L, 'part.rhythm.rotate', 'Rotate', r.rotate, 0, 63, 'shift', 'kind:live;voice:synth;rhythm:euclid,drawn') +
          st(L, 'part.rhythm.voices', 'Euclid voices', num(r.voices, 1), 1, 8, 'interlocking patterns',
             'kind:live;voice:synth;rhythm:euclid') +
          sl(L, 'part.rhythm.chance', 'Chance', r.chance, 0, 100, '% per step', 'kind:live;voice:synth;rhythm:chance') +
          sl(L, 'part.rhythm.syncop', 'Syncopate', num(r.syncop, 0), 0, 100, 'straight → offbeat',
             'kind:live;voice:synth;rhythm:chance') +
          // Re-rolls the pattern every cycle instead of repeating it — v1's own
          // asymmetric rule (drops harder than it adds), so a varied v2 pattern
          // and a varied v1 one wander the same way.
          sl(L, 'part.rhythm.vary', 'Vary', num(r.vary, 0), 0, 100, 'as drawn → re-rolled each cycle',
             'kind:live;rhythm:euclid,drawn') +
          // The grid spans the whole row: at 390px a 16-step grid inside the
          // 3-column `.ambient-ctrl` label gutter gives each cell ~14px.
          // NOT an inline `display:block` — `applyGate` clears the inline style
          // to SHOW a row, which would wipe it. The block layout is a class rule
          // (`.ambient-ctrl.v2-cellrow`), so hiding sets inline `none` and
          // showing falls back to the class. Inline styles and a gate that owns
          // `display` do not mix.
          '<div class="ambient-ctrl v2-cellrow" data-v2when="kind:live;voice:synth;rhythm:euclid,drawn">' +
            '<label>Pattern<button type="button" class="ambient-regen v2-regen" ' +
              'title="Back to the generated pattern — clears your edits">↻</button></label>' +
            cellsHtml(L) +
            ((L.part.pitch && L.part.pitch.kind === 'drawn') ? noteRowHtml(L) : '') +
            '<span class="ambient-hint v2-cellhint"></span></div>' +
          '<div class="ambient-ctrl v2-cellrow v2-lanerow" data-v2when="kind:live;voice:kit">' +
            '<label>Drums</label>' + lanesHtml(L) +
            '<span class="ambient-hint v2-lanehint"></span></div>'
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
          st(L, 'part.pitch.voices', 'Voices', t.voices, 1, 9, 'notes per onset', 'kind:live;voice:synth;pitch:chord,stack') +

          st(L, 'part.pitch.degree', 'Note', t.degree, 1, 12, 'source tone', 'kind:live;voice:synth;pitch:fixed,stack,walk,series') +
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
          sl(L, 'part.shape.lenRatio', 'Length', sh.lenRatio, 1, 400, '% of the onset span', 'kind:live')
        ) +
        // ── VOICING — how a CHORD is laid out, once its notes are known ────
        // Split out of Pitch when Salt re-voice landed and the card measured
        // 1422px: Pitch had become two questions (which notes, and how they are
        // arranged), and the accretion check refused the sum for the third time
        // in this campaign.
        grpOpen('Voicing', false,
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
            '<span class="ambient-hint v2-salthint"></span></div>'
        ) +
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
          sl(L, 'motion', 'Motion', num(L.motion, 0), 0, 100, 'detune wobble', 'kind:live;voice:synth')
        ) +
        // ── MOTION — how the performance varies note to note ──────────────
        // v1 splits these out from Variance for a reason worth keeping:
        // Humanize is UNSEEDED (real performance jitter, never replays) while
        // Vel var is SEEDED on position-in-the-take, so the same take replays
        // the same dynamics. Both come from `_ambApplyAdsr`, so the semantics
        // are v1's rather than a second implementation.
        grpOpen('Motion', false,
          sl(L, 'proximity', 'Proximity', num(L.proximity, 0), 0, 100, 'how close notes stay', 'kind:live') +
          sl(L, 'swing', 'Swing', num(L.swing, 0), 0, 100, 'straight → shuffle', 'kind:live') +
          sl(L, 'accent', 'Accent', num(L.accent, 0), 0, 100, 'flat → dynamic') +
          '<div class="ambient-ctrl"><label>Tight</label>' +
            '<button type="button" class="ambient-seg v2-tighttoggle' + (L.tight ? ' on' : '') + '">' +
              (L.tight ? 'On — clipped' : 'Off') + '</button>' +
            '<span class="ambient-hint">cut each note short of the next</span></div>' +
          sl(L, 'restProb', 'Rests', num(L.restProb, 0), 0, 100, '% of onsets dropped') +
          sl(L, 'ghosts', 'Ghosts', num(L.ghosts, 0), 0, 100, 'quiet extra hits') +
          sl(L, 'lenVary', 'Len vary', num(L.lenVary, 0), 0, 100, 'note-length scatter') +
          sl(L, 'humanize', 'Humanize', num(L.humanize, 0), 0, 100, 'timing jitter — never replays') +
          sl(L, 'velVar', 'Vel var', num(L.velVar, 0), 0, 100, 'level scatter — replays per take')
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
          sl(L, 'cutoff', 'Filter', num(L.cutoff, 100), 0, 100, 'cutoff — 100 is fully open') +
          // `reso` was in the same position as decay/sustain: read by
          // `_ambApplyLayerFilter`, ramp-able, and unreachable.
          sl(L, 'reso', 'Resonance', num(L.reso, 0), 0, 100, 'filter peak') +
          sl(L, 'fine', 'Fine', num(L.fine, 0), -100, 100, 'cents — detune the voice') +
          sl(L, 'portamento', 'Glide', num(L.portamento, 0), 0, 2000, 'ms between notes') +
          sl(L, 'voiceTrim', 'Voice trim', num(L.voiceTrim, 0), -24, 12, 'dB — tame a hot voice') +
          tb('EQ', sl(L, 'eq.low', 'EQ low', num((L.eq || {}).low, 0), -24, 24, 'dB') +
            sl(L, 'eq.mid', 'EQ mid', num((L.eq || {}).mid, 0), -24, 24, 'dB') +
            sl(L, 'eq.high', 'EQ high', num((L.eq || {}).high, 0), -24, 24, 'dB'))
        ) +
        // ── MOD — the per-layer LFO matrix ────────────────────────────────
        // v1's OWN builders (`_ambModTarget`, and `_ambShapeSel` inside it), so
        // the shape vocabulary, the seq row and the custom-partials row are one
        // implementation. Deliberately NOT v1's `_ambModUi`, which also emits
        // the trance gate — v2 has that in FX as Chop, and two controls over one
        // field is the duplication this card was just cleaned of.
        grpOpen('Mod', false,
          ((typeof _ambModTarget === 'function')
            ? ('<div class="ambient-ctrl"><label for="ambient-v2-' + L.id + '-mod-sync">Rate timing</label>' +
                 '<select id="ambient-v2-' + L.id + '-mod-sync" class="ambient-select">' +
                   '<option value="free"' + (((L.mod || {}).sync !== 'sync') ? ' selected' : '') + '>Free (Hz)</option>' +
                   '<option value="sync"' + (((L.mod || {}).sync === 'sync') ? ' selected' : '') + '>Sync (tempo)</option>' +
                 '</select><span class="ambient-hint">free / sync</span></div>' +
               _ambModTarget('v2-' + L.id, 'vca', 'VCA \u00b7 amplitude', 'tremolo', 30) +
               _ambModTarget('v2-' + L.id, 'vco', 'VCO \u00b7 pitch', 'vibrato', 20) +
               _ambModTarget('v2-' + L.id, 'vcf', 'VCF \u00b7 cutoff', 'sweep', 15))
            : '')
        ) +
        // ── SPACE — where the layer sits, and where it is sent ────────────
        // Split out of Mix when the envelope and filter controls landed: Mix
        // would have been 12 visible rows, which the accretion check in
        // `npm run test:ui` refuses by design. Mix is now the layer's OWN
        // sound; Space is where it goes.
        grpOpen('Space', false,
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
          st(L, 'areaFadeMs', 'Area fade', num(L.areaFadeMs, 250), 0, 4000, 'ms leaving an area')
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
      kind: p.kind,
      voice: (L.instrument && L.instrument.voice) || 'synth',
      tg: (L.tg && L.tg.on) ? 'on' : 'off',   // the gate's own rows follow it
      spat: (L.spat && L.spat.on) ? 'on' : 'off',
      rhythm: (p.rhythm && p.rhythm.kind) || '',
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
    const rsel = card.querySelector('[data-f="part.rhythm.kind"]');
    if (rsel) { const want = rhythmShown(now.rhythm); if (rsel.value !== want) rsel.value = want; }
    card.querySelectorAll('[data-v2when]').forEach(row => {
      const ok = String(row.getAttribute('data-v2when')).split(';').every(cl => {
        const [piece, vals] = cl.split(':');
        const want = String(vals || '').split(',');
        const have = now[piece];
        // A piece may hold ONE value (kind, voice, rhythm…) or a SET of them
        // (`on`, the engaged FX). One clause form, both shapes.
        return Array.isArray(have) ? have.some(v => want.indexOf(v) >= 0)
                                   : want.indexOf(have) >= 0;
      });
      row.style.display = ok ? '' : 'none';
    });
    // A SOLOED LAYER MUST LOOK SOLOED. Monitoring state that can vanish while
    // its widget keeps state is the documented drum-solo bug; here solo lives in
    // the ⋯ menu, so the card itself has to say so.
    card.classList.toggle('v2-soloed', !!L.solo);
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
    const sums = {
      Instrument: [i2 => i2.voice === 'kit' ? (L.instrument.kit || 'kit')
                 : i2.voice === 'speech' ? 'speech'
                 : (L.instrument.tone || 'default')][0](L.instrument || {}),
      Envelope: 'A ' + ((L.instrument || {}).attack | 0) + ' \u00b7 R ' + ((L.instrument || {}).release | 0),
      Part: (p.kind === 'recorded' ? (p.notes || []).length + ' notes' : 'live') +
            ' \u00b7 ' + (p.clock === 'free' ? (p.ms || 2000) + 'ms free' : p.bars + ' bars') +
            ((typeof L.when === 'string' && L.when && L.when !== 'always') ? ' \u00b7 not every cycle' : ''),
      Rhythm: (now.voice === 'kit')
        ? ((p.rhythm.lanes || []).reduce((a4, row) => a4 + (row || []).reduce((x, c3) => x + (c3 ? 1 : 0), 0), 0) + ' hits')
        : (now.rhythm === 'drawn' ? 'drawn' : now.rhythm) + ' \u00b7 ' + p.rhythm.steps + ' steps',
      Pitch: now.pitch + ((p.shape && p.shape.lenRatio !== 100) ? ' \u00b7 len ' + p.shape.lenRatio + '%' : ''),
      Voicing: ((L.part.pitch.chordMode || 'simple') +
                (((L.part.pitch.subdiv | 0) > 1) ? ' \u00b7 \u00f7' + (L.part.pitch.subdiv | 0) : '') +
                (L.followSalt ? ' \u00b7 salt' : '')),
      Shape: ((L.strum | 0) > 0 ? 'strum ' + (L.strum | 0) : 'struck'),
      Motion: (() => {
        const on2 = [['proximity', 'proximity'], ['swing', 'swing'], ['accent', 'accent'],
                     ['restProb', 'rests'], ['ghosts', 'ghosts'],
                     ['lenVary', 'len vary'], ['humanize', 'humanize'], ['velVar', 'vel var']]
          .filter(f2 => num(L[f2[0]], 0) > 0).map(f2 => f2[1]);
        if (L.tight) on2.push('tight');
        return on2.length ? on2.join(' \u00b7 ') : 'straight';
      })(),
      Mix: 'level ' + num(L.level, 70) +
           (num(L.cutoff, 100) < 100 ? ' \u00b7 filter ' + num(L.cutoff, 100) : '') +
           (num(L.reso, 0) > 0 ? ' \u00b7 reso ' + num(L.reso, 0) : '') +
           (num(L.fine, 0) !== 0 ? ' \u00b7 fine ' + num(L.fine, 0) : '') +
           (num(L.portamento, 0) > 0 ? ' \u00b7 glide' : '') +
           (num(L.voiceTrim, 0) !== 0 ? ' \u00b7 trim ' + num(L.voiceTrim, 0) + 'dB' : ''),
      Mod: (() => {
        const m = L.mod || {};
        const on3 = ['vca', 'vco', 'vcf'].filter(t => ((m[t] || {}).depth | 0) > 0);
        return on3.length ? on3.join(' \u00b7 ') : 'none';
      })(),
      Space: ((num(L.revSend, 0) > 0 ? 'reverb ' + num(L.revSend, 0) : '') +
              ((L.bus && L.bus !== 'a') ? ' \u00b7 bus ' + String(L.bus).toUpperCase() : '') +
              (num(L.space, 0) !== 0 ? ' \u00b7 width ' + num(L.space, 0) : '') +
              (now.spat === 'on' ? ' \u00b7 moving' : '')).replace(/^ \u00b7 /, '') || 'dry, centred',
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
    const nc = card.querySelector('.v2-notecount');
    if (nc) {
      const n = (p.notes || []).length;
      nc.textContent = p.kind === 'recorded'
        ? (n + ' note' + (n === 1 ? '' : 's') + (p.from ? ' \u00b7 from \u201c' + p.from + '\u201d' : ' held'))
        : 'either one makes it Recorded';
    }
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
      if (cb) cb.classList.toggle('on', open);
    }
    // GROUP BUTTONS: an ACCENT on any treatment group whose summary is not its
    // neutral (the folded card then says at a glance which groups this layer
    // actually uses). The core groups are always in use, so they stay plain.
    const NEUT = { FX: 'none', Mod: 'none', Motion: 'straight',
                   Space: 'dry, centred', Shape: 'struck', Voicing: 'simple' };
    card.querySelectorAll('.v2-grpbtn').forEach(b2 => {
      const g2 = b2.getAttribute('data-v2grp');
      if (g2 in NEUT) b2.classList.toggle('v2-live', (sums[g2] || '') !== NEUT[g2]);
    });
    // The open sheet re-syncs its tabs on every gate pass — the gate can hide
    // the active tab's rows from under it (switch Voice with Tone open).
    if (POP && POP.id === (L.id | 0) && popWrapOf(card)) {
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
  let POP = null;   // { id, grp, tab } — which sheet is open, and on which tab
  function popWrapOf(card) { return card.querySelector(':scope > .v2-pop-wrap'); }
  function popClose(card) {
    const wrap = card && popWrapOf(card);
    if (wrap) {
      const body = wrap.querySelector('.ambient-grp-body');
      // put the lifted drawing back at the top of the body FIRST, so it travels
      // home with it — otherwise it is removed with the wrap and the card's own
      // copy of the group is left without one.
      try {
        const viz = wrap.querySelector(':scope > .v2-pop > .v2-partviz');
        if (viz && body) body.insertBefore(viz, body.firstChild);
      } catch (e) {}
      const g = POP && card.querySelector('.ambient-grp[data-v2grp="' + POP.grp + '"]');
      if (body && g) g.appendChild(body);
      wrap.remove();
    }
    POP = null;
  }
  function popOpen(card, L, grp, tab) {
    document.querySelectorAll('.v2-pop-wrap').forEach(w => {
      const c = w.closest('.v2-layer'); if (c) popClose(c);
    });
    const g = card.querySelector('.ambient-grp[data-v2grp="' + grp + '"]');
    const body = g && g.querySelector('.ambient-grp-body'); if (!body) return;
    const wrap = document.createElement('div');
    wrap.className = 'v2-pop-wrap';
    wrap.innerHTML =
      '<div class="v2-pop-scrim"></div>' +
      '<div class="v2-pop" role="dialog" aria-label="' + esc(grp) + '">' +
        '<div class="v2-pop-head"><span class="v2-pop-title">' + esc(grp) + '</span>' +
          '<span class="ambient-hint v2-grpsum" data-grp="' + esc(grp) + '"></span>' +
          '<button type="button" class="v2-pop-close" aria-label="Close">✕</button></div>' +
        '<div class="v2-pop-tabs"></div>' +
        '<div class="v2-pop-pane"></div>' +
        '<div class="v2-pop-foot"><button type="button" class="v2-pop-preview" ' +
          'title="Hear one cycle of this layer with the current settings — through its own chain, so the FX and level speak too">' +
          '\u25b6 Preview</button></div>' +
      '</div>';
    card.appendChild(wrap);
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
    POP = { id: L.id | 0, grp: grp, tab: tab || null };
    // `position: fixed` resolves against a transformed/filtered ancestor, not
    // the viewport (the documented containing-block trap) — measure at 0,0 and
    // correct with a transform.
    const r = wrap.getBoundingClientRect();
    if (Math.abs(r.left) > 1 || Math.abs(r.top) > 1) {
      wrap.style.transform = 'translate(' + (-r.left) + 'px,' + (-r.top) + 'px)';
    }
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
  function popTabName(row) {
    const t = row.getAttribute('data-v2tab'); if (t) return t;
    const lab = row.querySelector(':scope > label') || row.querySelector('.ambient-mod-sub');
    if (!lab) return '…';
    // first TEXT node only — a label can carry a button (Pattern's ↻), and the
    // mod-sub reads "VCA · amplitude", whose tab is just "VCA".
    const s2 = ((lab.childNodes[0] && lab.childNodes[0].textContent) || lab.textContent || '').trim();
    return (s2.split('·')[0].trim()) || '…';
  }
  function popSync(card, L) {
    const wrap = popWrapOf(card); if (!wrap || !POP) return;
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
    const sig = visTabs.map(t => t.name).join('|');
    if (tabsEl._sig !== sig) {
      tabsEl._sig = sig;
      tabsEl.innerHTML = visTabs.map(t =>
        '<button type="button" class="v2-pop-tab" data-tab="' + esc(t.name) + '">' + esc(t.name) + '</button>').join('');
    }
    tabsEl.querySelectorAll('.v2-pop-tab').forEach(b =>
      b.classList.toggle('on', !!act && b.getAttribute('data-tab') === act.name));
    tabs.forEach(t => t.rows.forEach(row => row.classList.toggle('v2-rowoff', t !== act)));
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
      k.innerHTML = '<div class="v2-knob-ring"></div>' +
        '<div class="v2-knob-face"><span class="v2-knob-val"></span>' +
        '<span class="v2-knob-sub">' + esc(row.getAttribute('data-v2u') || '') + '</span></div>';
      inp.after(k);
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

  V2.render = function (E) {
    _cardE = E;
    const cfg = E && E.getCfg && E.getCfg(); if (!cfg) return;
    const list = V2.layers(cfg);
    const h = host(E); if (!h) return;
    if (!list.length) { h.innerHTML = ''; h._sig = ''; POP = null; return; }
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
      const og = openGrps.get(String(id));
      if (og) card.querySelectorAll('.ambient-grp').forEach(g => {
        g.classList.toggle('open', og.has(g.getAttribute('data-v2grp')));
      });
      applyGate(card, L);
    });
    // A REBUILD DESTROYS AN OPEN SHEET with the card that held it — reopen it
    // on the fresh card, same group, same tab, so a select flipped from inside
    // the sheet (instrument.voice, steps…) does not slam it shut in the hand.
    // (The documented repaint-via-the-sync-path lesson: anything a rebuild
    // throws away must be re-established AFTER the rebuild, by the rebuild.)
    if (POP) {
      const keep = POP; POP = null;
      const card2 = h.querySelector('.v2-layer[data-v2id="' + keep.id + '"]');
      const L2 = list.find(x => (x.id | 0) === keep.id);
      if (card2 && L2 && !card2.classList.contains('collapsed')) {
        popOpen(card2, L2, keep.grp, keep.tab);
      }
    }
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
        try { if (E._v2Phase) delete E._v2Phase['v2:' + ctx.L.id]; } catch (e) {}   // re-anchor on the next tick
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      };
      h.addEventListener('input', (ev) => {
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
        setPath(ctx.L, path, (f.tagName === 'SELECT' || f.type === 'text') ? raw : (parseFloat(raw) || 0));
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

      h.addEventListener('click', (ev) => {
        const t = ev.target;
        // THE GROUP GRID → its sheet; the sheet's own chrome next — these run
        // before every other branch so nothing inside the sheet can fall
        // through to the header's collapse catch-all.
        const gb2 = t.closest && t.closest('.v2-grpbtn');
        if (gb2) {
          const ctx = layerOf(gb2); if (!ctx) return;
          popOpen(ctx.card, ctx.L, gb2.getAttribute('data-v2grp'));
          return;
        }
        const ptab = t.closest && t.closest('.v2-pop-tab');
        if (ptab) {
          const ctx = layerOf(ptab); if (!ctx || !POP) return;
          POP.tab = ptab.getAttribute('data-tab');
          popSync(ctx.card, ctx.L);
          return;
        }
        if (t.closest && (t.closest('.v2-pop-close') || t.closest('.v2-pop-scrim'))) {
          const c3 = t.closest('.v2-layer'); if (c3) popClose(c3);
          return;
        }
        const pv = t.closest && t.closest('.v2-pop-preview');
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
            document.querySelectorAll('.v2-pop-preview').forEach(b3 => {
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
            popClose(c);   // a collapsed card cannot keep a sheet open over it
            const nowCollapsed = c.classList.toggle('collapsed');
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
          // order. The re-render above recreates the chord ruler and the
          // granularity bar EMPTY, and both are filled by sync passes that key
          // on the session — so without this the dock opens with a blank ruler
          // and no Step Div until something else happens to repaint (measured:
          // 4 chord blocks when the session was opened directly, 0 through the
          // button). `_ambRefreshSeedModes` runs whether or not the transport
          // is going, which is the point — composing happens stopped.
          try { if (typeof _ambRefreshSeedModes === 'function') _ambRefreshSeedModes(E); } catch (e) {}
          return;
        }
        const gdone = t.closest('.v2-gdone'), gcancel = t.closest('.v2-gcancel');
        if (gdone || gcancel) {
          try { if (typeof _ambGridEditStop === 'function') _ambGridEditStop(!!gcancel); } catch (e) {}
          h._sig = ''; V2.render(E);
          return;
        }
        // ADOPT A PHRASE — the compose grid's own output, read as a part. A
        // popover rather than a context menu because the bank is a LIBRARY
        // whose length is the user's, not a fixed handful of actions.
        const adopt = t.closest('.v2-adopt');
        if (adopt) {
          const ctx = layerOf(adopt); if (!ctx) return;
          setTimeout(() => {
            const pop = window._ambActionsPopover;
            const list = V2.phrases().filter(p => p.notes > 0);
            if (!pop) return;
            if (!list.length) {
              // An empty bank is not an error — it is a "here is where these
              // come from". A picker that opens on nothing and says nothing is
              // the dead end this whole slice exists to remove.
              pop('No phrases saved yet', [
                { label: 'Phrases are composed in a layer’s ✎ Grid and saved to the bank. Save one there and it will appear here.', disabled: true },
              ]);
              return;
            }
            pop('Play a saved phrase', list.map(p => ({
              label: p.name + '  ·  ' + p.notes + ' note' + (p.notes === 1 ? '' : 's') + ' · ' + p.bars + ' bars',
              fn: () => {
                if (!V2.adopt(E, ctx.L, p.name)) {
                  try { if (typeof showToast === 'function') showToast('Could not read “' + p.name + '” — it has no pitched steps.', { warn: true, ms: 5000 }); } catch (e) {}
                  return;
                }
                try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
                try { if (typeof showToast === 'function') showToast('Playing “' + p.name + '” — ' + ctx.L.part.notes.length + ' notes over ' + ctx.L.part.bars + ' bars. Switch Part to Live to go back.', { ms: 5000 }); } catch (e) {}
                h._sig = ''; V2.render(E);
              },
            })));
          }, 0);
          return;
        }
        const cap = t.closest('.v2-capture');
        if (cap) {
          const ctx = layerOf(cap); if (!ctx) return;
          if (!V2.capture(E, ctx.L)) {
            try { if (typeof showToast === 'function') showToast('Nothing to capture \u2014 this cycle is empty. Check the live Rhythm settings.', { ms: 4500 }); } catch (e) {}
            return;
          }
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          try { if (typeof showToast === 'function') showToast('Kept ' + ctx.L.part.notes.length + ' notes \u2014 it replays them now. Switch Part to Live to go back.', { ms: 5000 }); } catch (e) {}
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
        const mk = t.closest('.v2-mkpart');
        if (mk) {
          const ctx = layerOf(mk); if (!ctx) return;
          const which = mk.getAttribute('data-mk');
          const info = (which === 'arp') ? V2.makeArp(E, ctx.L) : V2.makeSustain(E, ctx.L, true);
          if (!info) return;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          h._sig = ''; V2.render(E);
          // AUDITION IT — the same rule the roll follows: a shape you cannot
          // hear is a change you have to take on trust.
          setTimeout(() => {
            try { V2.preview(E, ctx.L); } catch (e) {}
            // the card was re-rendered above, so re-resolve it before drawing
            try {
              const c2 = document.querySelector('.v2-layer[data-v2id="' + (ctx.L.id | 0) + '"]');
              if (c2) drawPartViz(c2, ctx.L, E);
            } catch (e) {}
          }, 0);
          try {
            if (typeof showToast === 'function') {
              showToast(which === 'arp'
                ? 'Arpeggio — sweeping the chord, ' + info.onsets + ' per cycle over ' + info.octaves + ' octaves.'
                : 'Sustained — ' + info.voices + ' voice' + (info.voices === 1 ? '' : 's') +
                  ' held for the cycle. Set Voices to 1 for a single note.', { ms: 4000 });
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
          const info = V2.rollRun(E, ctx.L);
          if (!info) return;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
          h._sig = ''; V2.render(E);
          // HEAR IT IMMEDIATELY — a roll you cannot hear is a dice throw
          // face-down (the documented rule from the synth-drum roll). Deferred
          // a tick so the re-render has replaced the card first; the preview
          // kills any previous one itself, so re-rolling never stacks.
          setTimeout(() => {
            try { V2.preview(E, ctx.L); } catch (e) {}
            try {
              const c2 = document.querySelector('.v2-layer[data-v2id="' + (ctx.L.id | 0) + '"]');
              if (c2) {
                drawPartViz(c2, ctx.L, E);
                const b2 = c2.querySelector('.v2-pop-preview');
                if (b2) { b2.classList.add('playing'); b2.textContent = '\u25a0 Stop'; }
              }
            } catch (e) {}
          }, 0);
          try {
            if (typeof showToast === 'function') {
              showToast('Rolled a run \u2014 ' + info.pulses + ' of ' + info.steps +
                ' steps over ' + info.bars + ' bar' + (info.bars === 1 ? '' : 's') +
                '. Press again to re-roll; edit it in Rhythm and Pitch.', { ms: 4000 });
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
