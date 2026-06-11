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
    function _defaultAmbientConfig() {
      return {
        timing: 'free',                 // 'free' | 'sync'
        seed:   1,
        space:  0,                      // 0 = centred → 100 = half full-L / half full-R
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
        bed:     { on: true,  density: 4, register: 4, spread: 2, intervalMs: 4750, lengthMs: 6650, motion: 30, tone: '', scale: '', mod: _ambDefaultMod() },
        motif:   { on: false, register: 5, range: 2, intervalMs: 1200, lengthMs: 1000, restProb: 30, tone: '', scale: '', mod: _ambDefaultMod() },
        texture: { on: false, register: 6, fill: 35, intervalMs: 450, lengthMs: 300, mutateRate: 40, tone: '', scale: '', mod: _ambDefaultMod() },
        beat:    { on: false, kit: 'tr808', intervalMs: 500, lengthMs: 200, restProb: 25, mod: _ambDefaultMod() },
        // `playing` is never persisted as true — the generator only starts on
        // an explicit gesture (a suspended AudioContext would swallow autostart).
      };
    }
    function _laneAmbientCfg() {
      const lane = (typeof lanes !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (!lane) return null;
      const d = _defaultAmbientConfig();
      let cfg = lane.ambient;
      if (!cfg || typeof cfg !== 'object') { lane.ambient = cfg = d; return cfg; }
      // Phase 1 → 2 migration: a flat config becomes the `bed` layer.
      if (!cfg.bed && Number.isFinite(cfg.density)) {
        cfg.bed = { on: true, density: cfg.density, register: cfg.register, spread: cfg.spread, evolveRate: cfg.evolveRate };
        ['density','register','spread','evolveRate'].forEach(k => delete cfg[k]);
      }
      if (cfg.timing !== 'free' && cfg.timing !== 'sync') cfg.timing = d.timing;
      if (!Number.isFinite(cfg.seed)) cfg.seed = d.seed;
      if (!Number.isFinite(cfg.space)) cfg.space = d.space;
      ['bed','motif','texture','beat'].forEach(layer => {
        if (!cfg[layer] || typeof cfg[layer] !== 'object') cfg[layer] = { ...d[layer] };
      });
      // Phase 2/3 → interval/length migration: derive explicit Interval (ms)
      // and Length (ms) from the old abstract rate sliders, then drop them.
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
      // Backfill any still-missing keys from defaults.
      ['bed','motif','texture','beat'].forEach(layer => {
        Object.keys(d[layer]).forEach(k => {
          if (k === 'on') { if (typeof cfg[layer].on !== 'boolean') cfg[layer].on = d[layer].on; }
          else if (k === 'kit' || k === 'tone' || k === 'scale') { if (typeof cfg[layer][k] !== 'string') cfg[layer][k] = d[layer][k]; }
          else if (k === 'mod') {
            let mm = cfg[layer].mod;
            if (!mm || typeof mm !== 'object') { cfg[layer].mod = mm = _ambDefaultMod(); }
            // Migrate the old flat schema {shape, rate, vca:N, vco:N, vcf:N}
            // into the per-target { depth, rate, shape } form.
            if (typeof mm.vca === 'number' || typeof mm.shape === 'string') {
              const shp = (typeof mm.shape === 'string') ? mm.shape : 'sine';
              const rt = Number.isFinite(mm.rate) ? mm.rate : 25;
              const mk2 = (dep) => ({ depth: Number.isFinite(dep) ? dep : 0, rate: rt, shape: shp });
              cfg[layer].mod = mm = { vca: mk2(mm.vca), vco: mk2(mm.vco), vcf: mk2(mm.vcf) };
            }
            ['vca', 'vco', 'vcf'].forEach(tg => {
              const dt = d[layer].mod[tg];
              if (!mm[tg] || typeof mm[tg] !== 'object') mm[tg] = { ...dt };
              else {
                if (!Number.isFinite(mm[tg].depth)) mm[tg].depth = 0;
                if (!Number.isFinite(mm[tg].rate)) mm[tg].rate = dt.rate;
                if (typeof mm[tg].shape !== 'string') mm[tg].shape = 'sine';
              }
            });
          }
          else if (!Number.isFinite(cfg[layer][k])) cfg[layer][k] = d[layer][k];
        });
      });
      return cfg;
    }

    // ---- Seedable RNG (mulberry32) — so Regenerate is repeatable --------
    let _ambRngState = 1;
    function _ambSeed(s) { _ambRngState = (s >>> 0) || 1; }
    function _ambRand() {
      _ambRngState |= 0; _ambRngState = (_ambRngState + 0x6D2B79F5) | 0;
      let t = Math.imul(_ambRngState ^ (_ambRngState >>> 15), 1 | _ambRngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // ---- Pitch material ------------------------------------------------
    // Each layer may carry its own `scale`; '' (or unknown) follows the
    // workspace currentScale. The root stays the workspace root.
    function _ambResolveScale(scale) {
      if (typeof scale === 'string' && scale && typeof SCALES !== 'undefined' && SCALES[scale]) return scale;
      return (typeof currentScale === 'string') ? currentScale : 'chromatic';
    }
    function _ambScaleIntervals(scale) {
      const name = _ambResolveScale(scale);
      return (typeof SCALES !== 'undefined' && SCALES[name]) ? SCALES[name] : [0, 2, 4, 5, 7, 9, 11];
    }
    function _ambNoteFreq(intervalSemi, octave, scale) {
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const root = (typeof rootIdx === 'number') ? rootIdx : 0;
      const pc = (((root + intervalSemi) % 12) + 12) % 12;
      const midi = 12 * (octave + 1) + pc;
      let freq = A * Math.pow(2, (midi - 69) / 12);
      try {
        const sName = _ambResolveScale(scale);
        if (typeof MICRO_TUNINGS !== 'undefined' && MICRO_TUNINGS[sName]) {
          const micro = MICRO_TUNINGS[sName];
          const tonic = (typeof _effectiveScaleTonic === 'function') ? _effectiveScaleTonic() : root;
          const deg = (((pc - tonic) % 12) + 12) % 12;
          const dev = (micro[deg] || 0) - deg * 100;
          if (dev) freq *= Math.pow(2, dev / 1200);
        }
      } catch (e) {}
      return freq;
    }
    function _ambDegreeFreq(deg, octave, scale) {
      const intervals = _ambScaleIntervals(scale);
      const N = intervals.length;
      const d = ((deg % N) + N) % N;
      return _ambNoteFreq(intervals[d], octave, scale);
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

    // ================= BED engine ===================================
    function _ambPickVoicing(bed) {
      const intervals = _ambScaleIntervals(bed.scale);
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
        out.push(_ambDegreeFreq(deg, oct, bed.scale));
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
    function _ambEmitBed(at, bed, space) {
      const voicing = _ambPickVoicing(bed);
      if (!voicing.length) return;
      const durMs = Math.max(80, bed.lengthMs | 0);
      const overlap = durMs / Math.max(1, bed.intervalMs | 0);
      const pans = _ambSpacePans(voicing.length, space);
      const dest = _ambLayerDest('bed'), dmod = _ambLayerDetuneMod('bed');
      voicing.forEach((f, i) => {
        const params = _ambBedParams(durMs, voicing.length, bed.motion, overlap, pans[i], bed.tone);
        if (dmod) params._detuneMod = dmod;
        try { playNote(f, params, durMs, at + i * 0.012, dest, undefined, activeLaneIdx); } catch (e) {}
      });
    }

    // ================= MOTIF engine =================================
    let _ambMotifDeg = null;
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
    function _ambEmitMotif(at, motif, space) {
      const intervals = _ambScaleIntervals(motif.scale);
      const N = intervals.length;
      const center = Math.max(1, Math.min(8, motif.register | 0));
      const range = Math.max(1, Math.min(4, motif.range | 0));
      const lo = (center - range) * N, hi = (center + range) * N;
      if (_ambMotifDeg == null) _ambMotifDeg = center * N;
      if (_ambRand() * 100 < Math.max(0, Math.min(100, motif.restProb | 0))) return;
      const leap = _ambRand() < 0.18;
      const mag = leap ? 3 + Math.floor(_ambRand() * 3) : 1 + Math.floor(_ambRand() * 2);
      const dir = _ambRand() < 0.5 ? -1 : 1;
      let next = _ambMotifDeg + dir * mag;
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
      _ambMotifDeg = next;
      const f = _ambDegreeFreq(((next % N) + N) % N, Math.floor(next / N), motif.scale);
      const lenMs = Math.max(60, motif.lengthMs | 0);
      // Sequential single notes can't be "distributed" simultaneously, so
      // Space spreads them by panning each randomly within ±space.
      const pan = Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, space)));
      const mp = _ambMotifParams(lenMs, pan, motif.tone);
      const dmod = _ambLayerDetuneMod('motif'); if (dmod) mp._detuneMod = dmod;
      try { playNote(f, mp, lenMs, at, _ambLayerDest('motif'), undefined, activeLaneIdx); } catch (e) {}
    }

    // ================= TEXTURE engine ===============================
    let _ambTexPattern = null;
    let _ambTexStep = 0;
    let _ambTexMutateAt = 0;
    function _ambTexBuildPattern(texture) {
      const intervals = _ambScaleIntervals(texture.scale);
      const N = intervals.length;
      const fill = Math.max(0, Math.min(100, texture.fill | 0)) / 100;
      _ambTexPattern = [];
      for (let i = 0; i < 16; i++) _ambTexPattern.push({ on: _ambRand() < fill * 0.6, deg: Math.floor(_ambRand() * N) });
      _ambTexStep = 0;
    }
    function _ambTexMutate(texture) {
      if (!_ambTexPattern) return;
      const intervals = _ambScaleIntervals(texture.scale);
      const N = intervals.length;
      const i = Math.floor(_ambRand() * _ambTexPattern.length);
      if (_ambRand() < 0.5) _ambTexPattern[i].on = !_ambTexPattern[i].on;
      else _ambTexPattern[i].deg = Math.floor(_ambRand() * N);
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
    function _ambEmitTexture(at, texture, space) {
      if (!_ambTexPattern) _ambTexBuildPattern(texture);
      const center = Math.max(1, Math.min(8, texture.register | 0));
      const slot = _ambTexPattern[_ambTexStep % _ambTexPattern.length];
      _ambTexStep++;
      if (slot && slot.on) {
        const f = _ambDegreeFreq(slot.deg, center + (_ambRand() < 0.3 ? 1 : 0), texture.scale);
        const lenMs = Math.max(60, texture.lengthMs | 0);
        const pan = Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, space)));
        const tp = _ambTexParams(lenMs, pan, texture.tone);
        const dmod = _ambLayerDetuneMod('texture'); if (dmod) tp._detuneMod = dmod;
        try { playNote(f, tp, lenMs, at, _ambLayerDest('texture'), undefined, activeLaneIdx); } catch (e) {}
      }
      const mr = Math.max(0, Math.min(100, texture.mutateRate | 0));
      if (!_ambTexMutateAt) _ambTexMutateAt = at + (6 - mr / 100 * 5);
      if (at >= _ambTexMutateAt) { _ambTexMutate(texture); _ambTexMutateAt = at + (6 - mr / 100 * 5); }
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
    function _ambToneOptions() {
      const out = [{ value: '', label: 'Grid voice' }];
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
    // Scale choices for Bed/Motif/Texture: "Workspace scale" + every scale.
    function _ambScaleOptions() {
      const out = [{ value: '', label: 'Workspace scale' }];
      try {
        if (typeof SCALES !== 'undefined') {
          Object.keys(SCALES).sort().forEach(name => {
            out.push({ value: name, label: (typeof prettyScaleName === 'function') ? prettyScaleName(name) : name });
          });
        }
      } catch (e) {}
      return out;
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
    function _ambEmitBeat(at, beat, space) {
      if (_ambRand() * 100 < Math.max(0, Math.min(100, beat.restProb | 0))) return;
      const pc = _ambPickDrumPc();
      const midi = 36 + pc; // C2 = 36
      let f;
      try { f = Tone.Frequency(midi, 'midi').toFrequency(); } catch (e) { return; }
      const lenMs = Math.max(60, beat.lengthMs | 0);
      const pan = Math.round((_ambRand() * 2 - 1) * Math.max(0, Math.min(100, space)));
      const bp = _ambBeatParams(beat.kit, lenMs, pan);
      const dmod = _ambLayerDetuneMod('beat'); if (dmod) bp._detuneMod = dmod;
      try { playNote(f, bp, lenMs, at, _ambLayerDest('beat'), undefined, activeLaneIdx); } catch (e) {}
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
    const _ambMod = {}; // layer -> { input, vcf, vca, src: { vca, vco, vcf } }
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
    function _ambLaneBusNode() {
      try { if (typeof getLaneBus === 'function') return getLaneBus(activeLaneIdx); } catch (e) {}
      if (typeof globalSendTap !== 'undefined' && globalSendTap) return globalSendTap;
      return Tone.getDestination();
    }
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
    function _ambBuildMod(layer, cfg) {
      if (_ambMod[layer]) { _ambUpdateMod(layer, cfg); return; }
      if (typeof Tone === 'undefined') return;
      try {
        const vca = new Tone.Gain(1).connect(_ambLaneBusNode());
        const vcf = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.7 }).connect(vca);
        _ambMod[layer] = { input: vcf, vcf, vca, src: { vca: null, vco: null, vcf: null } };
        _ambUpdateMod(layer, cfg);
      } catch (e) {}
    }
    function _ambUpdateMod(layer, cfg) {
      const e = _ambMod[layer];
      if (!e) return;
      ['vca', 'vco', 'vcf'].forEach(tg => _ambSyncTarget(e, layer, tg, cfg));
    }
    function _ambTeardownMod(layer) {
      const e = _ambMod[layer];
      if (!e) return;
      ['vca', 'vco', 'vcf'].forEach(tg => { if (e.src && e.src[tg]) _ambDisposeSrc(e.src[tg]); });
      try { e.vcf && e.vcf.dispose(); } catch (x) {}
      try { e.vca && e.vca.dispose(); } catch (x) {}
      delete _ambMod[layer];
    }
    function _ambTeardownMods() { Object.keys(_ambMod).forEach(_ambTeardownMod); }
    function _ambSyncMods() {
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        const active = cfg[layer] && cfg[layer].on && _ambModActive(cfg[layer].mod);
        if (active) _ambBuildMod(layer, cfg);
        else if (_ambMod[layer]) _ambTeardownMod(layer);
      });
    }
    // Schedule random values onto every active stochastic source within the
    // lookahead window (run each generator tick). Uses Math.random so mod
    // randomness doesn't perturb the seeded note RNG.
    function _ambScheduleStochastic(now) {
      const horizon = now + 1.2;
      for (const layer in _ambMod) {
        const e = _ambMod[layer];
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
    function _ambLayerDest(layer) { const e = _ambMod[layer]; return e ? e.input : undefined; }
    function _ambLayerDetuneMod(layer) { const e = _ambMod[layer]; return (e && e.src && e.src.vco && e.src.vco.node) ? e.src.vco.node : undefined; }

    // ---- Unified schedule-ahead generator clock ------------------------
    let _ambTimer = null;
    let _ambBedNextAt = 0, _ambMotifNextAt = 0, _ambTexNextAt = 0, _ambBeatNextAt = 0;
    function _ambResetClocks() {
      _ambBedNextAt = _ambMotifNextAt = _ambTexNextAt = _ambBeatNextAt = 0;
      _ambMotifDeg = null;
      _ambTexPattern = null; _ambTexStep = 0; _ambTexMutateAt = 0;
    }
    function _ambTick() {
      if (typeof ambientMode === 'undefined' || !ambientMode) { _ambStopGenerator(); return; }
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      const now = (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
      const horizon = now + 1.2, lead = now + 0.1;
      const space = cfg.space | 0;
      try { _ambScheduleStochastic(now); } catch (e) {} // feed the stochastic LFOs
      if (cfg.bed && cfg.bed.on) {
        if (!_ambBedNextAt || _ambBedNextAt < now) _ambBedNextAt = lead;
        let g = 0;
        while (_ambBedNextAt < horizon && g++ < 8) {
          _ambEmitBed(_ambBedNextAt, cfg.bed, space);
          _ambBedNextAt += _ambSnap(Math.max(0.05, (cfg.bed.intervalMs | 0) / 1000), cfg);
        }
      }
      if (cfg.motif && cfg.motif.on) {
        if (!_ambMotifNextAt || _ambMotifNextAt < now) _ambMotifNextAt = lead;
        let g = 0;
        while (_ambMotifNextAt < horizon && g++ < 16) {
          _ambEmitMotif(_ambMotifNextAt, cfg.motif, space);
          _ambMotifNextAt += _ambSnap(Math.max(0.04, (cfg.motif.intervalMs | 0) / 1000), cfg);
        }
      }
      if (cfg.texture && cfg.texture.on) {
        if (!_ambTexNextAt || _ambTexNextAt < now) _ambTexNextAt = lead;
        let g = 0;
        while (_ambTexNextAt < horizon && g++ < 16) {
          _ambEmitTexture(_ambTexNextAt, cfg.texture, space);
          _ambTexNextAt += _ambSnap(Math.max(0.03, (cfg.texture.intervalMs | 0) / 1000), cfg);
        }
      }
      if (cfg.beat && cfg.beat.on) {
        if (!_ambBeatNextAt || _ambBeatNextAt < now) _ambBeatNextAt = lead;
        let g = 0;
        while (_ambBeatNextAt < horizon && g++ < 16) {
          _ambEmitBeat(_ambBeatNextAt, cfg.beat, space);
          _ambBeatNextAt += _ambSnap(Math.max(0.04, (cfg.beat.intervalMs | 0) / 1000), cfg);
        }
      }
    }
    function _ambStartGenerator() {
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      if (_ambTimer) return;
      _ambResetClocks();
      _ambSeed(cfg.seed);
      try { _ambSyncMods(); } catch (e) {} // build mod chains before the first voices fire
      _ambTick();
      _ambTimer = setInterval(_ambTick, 150);
      cfg.playing = true;
      _ambRefreshPlayBtn();
      _ambVizKick();
    }
    function _ambStopGenerator() {
      if (_ambTimer) { clearInterval(_ambTimer); _ambTimer = null; }
      _ambResetClocks();
      const lane = (typeof lanes !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (lane && lane.ambient) lane.ambient.playing = false;
      _ambRefreshPlayBtn();
      // Immediate silence — cut the bed/motif/texture voices now (click-free)
      // instead of leaving their long releases to ring out after Stop.
      try { if (typeof silenceActiveVoices === 'function') silenceActiveVoices(); } catch (e) {}
      try { _ambTeardownMods(); } catch (e) {}
    }

    // ---- Freeze → lane -------------------------------------------------
    function _ambFreezeToLane() {
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      const anyOn = (cfg.bed && cfg.bed.on) || (cfg.motif && cfg.motif.on) || (cfg.texture && cfg.texture.on) || (cfg.beat && cfg.beat.on);
      if (!anyOn) return;
      const STEPS = 32;
      const sub = (typeof stepSubdivision === 'number' && stepSubdivision > 0) ? stepSubdivision : 0.5;
      const space = cfg.space | 0;
      _ambSeed(cfg.seed >>> 0);
      _ambMotifDeg = null; _ambTexPattern = null; _ambTexStep = 0;
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
    function _ambMotifFreezeNote(motif) {
      const intervals = _ambScaleIntervals(motif.scale);
      const N = intervals.length;
      const center = Math.max(1, Math.min(8, motif.register | 0));
      const range = Math.max(1, Math.min(4, motif.range | 0));
      const lo = (center - range) * N, hi = (center + range) * N;
      if (_ambMotifDeg == null) _ambMotifDeg = center * N;
      if (_ambRand() * 100 < Math.max(0, Math.min(100, motif.restProb | 0))) return null;
      const leap = _ambRand() < 0.18;
      const mag = leap ? 3 + Math.floor(_ambRand() * 3) : 1 + Math.floor(_ambRand() * 2);
      const dir = _ambRand() < 0.5 ? -1 : 1;
      let next = _ambMotifDeg + dir * mag;
      if (next < lo) next = lo + (lo - next);
      if (next > hi) next = hi - (next - hi);
      next = Math.max(lo, Math.min(hi, next));
      _ambMotifDeg = next;
      return _ambDegreeFreq(((next % N) + N) % N, Math.floor(next / N), motif.scale);
    }
    function _ambTexFreezeNote(texture) {
      if (!_ambTexPattern) _ambTexBuildPattern(texture);
      const center = Math.max(1, Math.min(8, texture.register | 0));
      const slot = _ambTexPattern[_ambTexStep % _ambTexPattern.length];
      _ambTexStep++;
      if (slot && slot.on) return _ambDegreeFreq(slot.deg, center, texture.scale);
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
    function _ambCaptureToBuffer(durSec, onProgress) {
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
          try { _ambStopGenerator(); } catch (e) {}
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            const arr = await blob.arrayBuffer();
            const audioBuf = await ac.decodeAudioData(arr);
            resolve(audioBuf);
          } catch (e) { reject(e); }
        };
        // Fresh, reproducible take from the seed.
        try { _ambStopGenerator(); _ambStartGenerator(); } catch (e) {}
        try { rec.start(); } catch (e) { cleanup(); return reject(e); }
        const startMs = (typeof performance !== 'undefined') ? performance.now() : 0;
        const pi = setInterval(() => {
          const s = ((typeof performance !== 'undefined' ? performance.now() : 0) - startMs) / 1000;
          try { onProgress && onProgress(Math.min(1, s / durSec), Math.min(s, durSec), durSec); } catch (e) {}
        }, 150);
        setTimeout(() => { clearInterval(pi); try { rec.stop(); } catch (e) { cleanup(); reject(e); } }, durSec * 1000);
      });
    }
    async function _ambExportToDrive() {
      if (_ambExportBusy) return;
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      const anyOn = ['bed', 'motif', 'texture', 'beat'].some(k => cfg[k] && cfg[k].on);
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
      const progress = (typeof showRenderProgressModal === 'function') ? showRenderProgressModal('Exporting Bloom…') : null;
      try {
        progress && progress.setStatus('Recording ' + durSec + 's…');
        const buffer = await _ambCaptureToBuffer(durSec, (pct, sec, tot) => progress && progress.setProgress(pct, sec, tot));
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
    let _ambViz = null;
    function _ambVizFrame() {
      if (!_ambViz) return;
      const canvas = document.getElementById('ambient-viz');
      if (!canvas) { _ambViz.raf = 0; return; }
      if (canvas.width !== canvas.clientWidth) canvas.width = canvas.clientWidth;
      if (canvas.height !== canvas.clientHeight) canvas.height = canvas.clientHeight;
      const ctx = canvas.getContext('2d');
      const data = _ambViz.analyser.getValue();
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
      if (_ambTimer && !document.hidden) _ambViz.raf = requestAnimationFrame(_ambVizFrame);
      else _ambViz.raf = 0;
    }
    function _ambVizKick() { if (_ambViz && !_ambViz.raf) _ambViz.raf = requestAnimationFrame(_ambVizFrame); }
    function _ambStartViz() {
      if (_ambViz) { _ambVizFrame(); return; }
      const canvas = document.getElementById('ambient-viz');
      if (!canvas || typeof Tone === 'undefined') return;
      let analyser;
      try {
        analyser = new Tone.Analyser('waveform', 512);
        if (typeof masterBus !== 'undefined' && masterBus) masterBus.connect(analyser);
        else Tone.getDestination().connect(analyser);
      } catch (e) { return; }
      _ambViz = { analyser, raf: 0 };
      _ambVizFrame();
    }
    function _ambStopViz() {
      if (!_ambViz) return;
      if (_ambViz.raf) cancelAnimationFrame(_ambViz.raf);
      try { _ambViz.analyser.dispose(); } catch (e) {}
      _ambViz = null;
    }

    // ---- Panel ---------------------------------------------------------
    let _ambInited = false;
    function _ambFmtMs(ms) {
      ms = ms | 0;
      return ms >= 1000 ? (ms / 1000).toFixed(2).replace(/0$/, '').replace(/\.0?$/, '') + ' s' : ms + ' ms';
    }
    function _ambRefreshPlayBtn() {
      const btn = document.getElementById('ambient-play-btn');
      if (!btn) return;
      const on = !!_ambTimer;
      btn.textContent = on ? '◼ Stop' : '▶ Play';
      btn.classList.toggle('active', on);
    }
    function _ambSyncControls() {
      const cfg = _laneAmbientCfg();
      if (!cfg) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
      const hint = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
      ['free', 'sync'].forEach(t => { const el = document.getElementById('ambient-timing-' + t); if (el) el.classList.toggle('active', cfg.timing === t); });
      set('ambient-space', cfg.space);
      const chk = (id, v) => { const el = document.getElementById(id); if (el) el.classList.toggle('on', !!v); };
      chk('ambient-bed-on', cfg.bed.on);
      set('ambient-bed-tone', cfg.bed.tone);
      set('ambient-bed-scale', cfg.bed.scale);
      set('ambient-bed-density', cfg.bed.density);
      set('ambient-bed-register', cfg.bed.register);
      set('ambient-bed-spread', cfg.bed.spread);
      set('ambient-bed-interval', cfg.bed.intervalMs); hint('ambient-bed-interval-v', _ambFmtMs(cfg.bed.intervalMs));
      set('ambient-bed-length', cfg.bed.lengthMs);     hint('ambient-bed-length-v', _ambFmtMs(cfg.bed.lengthMs));
      set('ambient-bed-motion', cfg.bed.motion);
      chk('ambient-motif-on', cfg.motif.on);
      set('ambient-motif-tone', cfg.motif.tone);
      set('ambient-motif-scale', cfg.motif.scale);
      set('ambient-motif-register', cfg.motif.register);
      set('ambient-motif-range', cfg.motif.range);
      set('ambient-motif-interval', cfg.motif.intervalMs); hint('ambient-motif-interval-v', _ambFmtMs(cfg.motif.intervalMs));
      set('ambient-motif-length', cfg.motif.lengthMs);     hint('ambient-motif-length-v', _ambFmtMs(cfg.motif.lengthMs));
      set('ambient-motif-rest', cfg.motif.restProb);
      chk('ambient-texture-on', cfg.texture.on);
      set('ambient-texture-tone', cfg.texture.tone);
      set('ambient-texture-scale', cfg.texture.scale);
      set('ambient-texture-register', cfg.texture.register);
      set('ambient-texture-fill', cfg.texture.fill);
      set('ambient-texture-interval', cfg.texture.intervalMs); hint('ambient-texture-interval-v', _ambFmtMs(cfg.texture.intervalMs));
      set('ambient-texture-length', cfg.texture.lengthMs);     hint('ambient-texture-length-v', _ambFmtMs(cfg.texture.lengthMs));
      set('ambient-texture-mutate', cfg.texture.mutateRate);
      chk('ambient-beat-on', cfg.beat.on);
      set('ambient-beat-kit', cfg.beat.kit);
      set('ambient-beat-interval', cfg.beat.intervalMs); hint('ambient-beat-interval-v', _ambFmtMs(cfg.beat.intervalMs));
      set('ambient-beat-length', cfg.beat.lengthMs);     hint('ambient-beat-length-v', _ambFmtMs(cfg.beat.lengthMs));
      set('ambient-beat-rest', cfg.beat.restProb);
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
      const seedEl = document.getElementById('ambient-seed-val');
      if (seedEl) seedEl.textContent = '#' + (cfg.seed >>> 0);
      _ambRefreshPlayBtn();
    }
    function _ambientInit() {
      if (_ambInited) { _ambSyncControls(); _ambStartViz(); return; }
      const host = document.getElementById('ambient-inner');
      if (!host) return;
      const sl = (label, id, min, max, val, hint) =>
        '<div class="ambient-ctrl"><label for="' + id + '">' + label + '</label>' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '" />' +
        (hint ? '<span class="ambient-hint">' + hint + '</span>' : '') + '</div>';
      // Time slider: value display lives in a span whose id is <id>-v.
      const tm = (label, id, min, max, step, val) =>
        '<div class="ambient-ctrl"><label for="' + id + '">' + label + '</label>' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" />' +
        '<span class="ambient-hint" id="' + id + '-v"></span></div>';
      const head = (label, onId) =>
        '<div class="ambient-layer-head"><button type="button" class="ambient-toggle" id="' + onId + '">' + label + '</button></div>';
      // Per-layer modulation: each target (VCA/VCO/VCF) gets its own Depth,
      // Rate and Shape (incl. stochastic 'smooth' / 'sharp').
      const shapeSel = (id) => '<select id="' + id + '" class="ambient-select">' +
        ['sine', 'triangle', 'sawtooth', 'square', 'smooth', 'sharp'].map(s => '<option value="' + s + '">' + s + '</option>').join('') + '</select>';
      const modTarget = (layer, target, label, hint, defRate) =>
        '<div class="ambient-mod-target">' +
          '<div class="ambient-mod-sub">' + label + '</div>' +
          sl('Depth', 'ambient-' + layer + '-mod-' + target + '-depth', 0, 100, 0, hint) +
          sl('Rate', 'ambient-' + layer + '-mod-' + target + '-rate', 0, 100, defRate, 'slow → fast') +
          '<div class="ambient-ctrl"><label for="ambient-' + layer + '-mod-' + target + '-shape">Shape</label>' +
            shapeSel('ambient-' + layer + '-mod-' + target + '-shape') + '<span class="ambient-hint">wave</span></div>' +
        '</div>';
      // Collapsed by default — the Mod block is tall, so it lives behind an
      // expandable <details> per layer.
      const modUi = (layer) =>
        '<details class="ambient-mod">' +
          '<summary class="ambient-mod-head">Mod · VCA / VCO / VCF</summary>' +
          modTarget(layer, 'vca', 'VCA · amplitude', 'tremolo', 30) +
          modTarget(layer, 'vco', 'VCO · pitch', 'vibrato', 20) +
          modTarget(layer, 'vcf', 'VCF · cutoff', 'sweep', 15) +
        '</details>';
      host.innerHTML =
        '<div class="ambient-title">Bloom — generative ambient</div>' +
        '<canvas id="ambient-viz" class="ambient-viz"></canvas>' +
        '<div class="ambient-row">' +
          '<button type="button" id="ambient-play-btn" class="ambient-play">▶ Play</button>' +
          '<button type="button" id="ambient-regen-btn" class="ambient-regen" title="New random seed">✨ Regenerate</button>' +
          '<button type="button" id="ambient-freeze-btn" class="ambient-regen" title="Print the generated output to a new editable lane">❄ Freeze→lane</button>' +
          '<button type="button" id="ambient-export-btn" class="ambient-regen" title="Record a fixed length of Bloom and save it to Google Drive">⤓ Export→Drive</button>' +
          '<span class="ambient-seed" id="ambient-seed-val">#1</span>' +
        '</div>' +
        '<div class="ambient-row ambient-timing">' +
          '<span class="ambient-hint">Timing</span>' +
          '<button type="button" class="ambient-seg" id="ambient-timing-free">Free</button>' +
          '<button type="button" class="ambient-seg" id="ambient-timing-sync">Sync</button>' +
        '</div>' +
        sl('Space', 'ambient-space', 0, 100, 0, 'centre → wide') +
        '<div class="ambient-layer">' + head('Bed', 'ambient-bed-on') +
          '<div class="ambient-ctrl"><label for="ambient-bed-tone">Tone</label><select id="ambient-bed-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          '<div class="ambient-ctrl"><label for="ambient-bed-scale">Scale</label><select id="ambient-bed-scale" class="ambient-select"></select><span class="ambient-hint">notes</span></div>' +
          sl('Density', 'ambient-bed-density', 1, 8, 4, 'voices') +
          sl('Register', 'ambient-bed-register', 2, 6, 4, 'octave') +
          sl('Spread', 'ambient-bed-spread', 0, 3, 2, '± oct') +
          tm('Interval', 'ambient-bed-interval', 200, 12000, 50, 4750) +
          tm('Length', 'ambient-bed-length', 300, 16000, 100, 6650) +
          sl('Motion', 'ambient-bed-motion', 0, 100, 30, 'drift') +
          modUi('bed') +
        '</div>' +
        '<div class="ambient-layer">' + head('Motif', 'ambient-motif-on') +
          '<div class="ambient-ctrl"><label for="ambient-motif-tone">Tone</label><select id="ambient-motif-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          '<div class="ambient-ctrl"><label for="ambient-motif-scale">Scale</label><select id="ambient-motif-scale" class="ambient-select"></select><span class="ambient-hint">notes</span></div>' +
          sl('Register', 'ambient-motif-register', 2, 7, 5, 'octave') +
          sl('Range', 'ambient-motif-range', 1, 4, 2, '± oct') +
          tm('Interval', 'ambient-motif-interval', 100, 4000, 20, 1200) +
          tm('Length', 'ambient-motif-length', 80, 4000, 20, 1000) +
          sl('Rests', 'ambient-motif-rest', 0, 100, 30, '%') +
          modUi('motif') +
        '</div>' +
        '<div class="ambient-layer">' + head('Texture', 'ambient-texture-on') +
          '<div class="ambient-ctrl"><label for="ambient-texture-tone">Tone</label><select id="ambient-texture-tone" class="ambient-select"></select><span class="ambient-hint">voice</span></div>' +
          '<div class="ambient-ctrl"><label for="ambient-texture-scale">Scale</label><select id="ambient-texture-scale" class="ambient-select"></select><span class="ambient-hint">notes</span></div>' +
          sl('Register', 'ambient-texture-register', 3, 7, 6, 'octave') +
          sl('Fill', 'ambient-texture-fill', 0, 100, 35, 'sparse→busy') +
          tm('Interval', 'ambient-texture-interval', 80, 2000, 10, 450) +
          tm('Length', 'ambient-texture-length', 60, 2000, 10, 300) +
          sl('Mutate', 'ambient-texture-mutate', 0, 100, 40, 'slow→fast') +
          modUi('texture') +
        '</div>' +
        '<div class="ambient-layer">' + head('Beat', 'ambient-beat-on') +
          '<div class="ambient-ctrl"><label for="ambient-beat-kit">Kit</label>' +
            '<select id="ambient-beat-kit" class="ambient-select"></select><span class="ambient-hint">drums</span></div>' +
          tm('Interval', 'ambient-beat-interval', 80, 2000, 10, 500) +
          tm('Length', 'ambient-beat-length', 60, 2000, 10, 200) +
          sl('Rests', 'ambient-beat-rest', 0, 100, 25, '%') +
          modUi('beat') +
        '</div>' +
        '<div class="ambient-note">Routes through this lane’s bus — dial in its Reverb send for the full wash. Follows the current Scale &amp; Key.</div>';

      // Per-section Tone dropdowns: "Grid voice" (follow cellParams[0]) plus
      // every melodic tone from getAllSoundOptions (drum kits excluded — Beat
      // owns those). Populated once; the core SOUNDS + remote instruments are
      // registered synchronously at startup so the list is essentially full.
      const wireSelect = (id, layer, key, opts) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        opts.forEach(o => {
          const op = document.createElement('option');
          op.value = o.value; op.textContent = o.label;
          sel.appendChild(op);
        });
        sel.addEventListener('change', () => {
          const cfg = _laneAmbientCfg(); if (!cfg) return;
          cfg[layer][key] = sel.value || '';
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      };
      ['bed', 'motif', 'texture'].forEach(layer => {
        wireSelect('ambient-' + layer + '-tone', layer, 'tone', _ambToneOptions());
        wireSelect('ambient-' + layer + '-scale', layer, 'scale', _ambScaleOptions());
      });

      // Mod controls — per target (VCA/VCO/VCF): Depth, Rate, Shape. Changes
      // update the live mod chains immediately when playing.
      ['bed', 'motif', 'texture', 'beat'].forEach(layer => {
        ['vca', 'vco', 'vcf'].forEach(target => {
          ['depth', 'rate'].forEach(key => {
            const el = document.getElementById('ambient-' + layer + '-mod-' + target + '-' + key);
            if (!el) return;
            el.addEventListener('input', () => {
              const cfg = _laneAmbientCfg(); if (!cfg) return;
              cfg[layer].mod[target][key] = parseInt(el.value, 10) || 0;
              if (_ambTimer) { try { _ambSyncMods(); } catch (e) {} }
              if (typeof persistWorkspace === 'function') persistWorkspace();
            });
          });
          const shapeEl = document.getElementById('ambient-' + layer + '-mod-' + target + '-shape');
          if (shapeEl) shapeEl.addEventListener('change', () => {
            const cfg = _laneAmbientCfg(); if (!cfg) return;
            cfg[layer].mod[target].shape = shapeEl.value || 'sine';
            if (_ambTimer) { try { _ambSyncMods(); } catch (e) {} }
            if (typeof persistWorkspace === 'function') persistWorkspace();
          });
        });
      });

      // Populate the drum-kit dropdown.
      const kitSel = document.getElementById('ambient-beat-kit');
      if (kitSel) {
        _ambDrumKits().forEach(k => {
          const o = document.createElement('option'); o.value = k.id; o.textContent = k.name; kitSel.appendChild(o);
        });
        kitSel.addEventListener('change', () => {
          const cfg = _laneAmbientCfg(); if (!cfg) return;
          cfg.beat.kit = kitSel.value || 'tr808';
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      }

      // Plain int slider → nested config.
      const bind = (id, layer, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
          const cfg = _laneAmbientCfg(); if (!cfg) return;
          if (layer === null) cfg[key] = parseInt(el.value, 10) || 0;
          else cfg[layer][key] = parseInt(el.value, 10) || 0;
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      };
      // Time slider → nested config + live value readout.
      const bindTime = (id, layer, key) => {
        const el = document.getElementById(id);
        const vEl = document.getElementById(id + '-v');
        if (!el) return;
        el.addEventListener('input', () => {
          const cfg = _laneAmbientCfg(); if (!cfg) return;
          const v = parseInt(el.value, 10) || 0;
          cfg[layer][key] = v;
          if (vEl) vEl.textContent = _ambFmtMs(v);
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      };
      bind('ambient-space', null, 'space');
      bind('ambient-bed-density', 'bed', 'density');
      bind('ambient-bed-register', 'bed', 'register');
      bind('ambient-bed-spread', 'bed', 'spread');
      bindTime('ambient-bed-interval', 'bed', 'intervalMs');
      bindTime('ambient-bed-length', 'bed', 'lengthMs');
      bind('ambient-bed-motion', 'bed', 'motion');
      bind('ambient-motif-register', 'motif', 'register');
      bind('ambient-motif-range', 'motif', 'range');
      bindTime('ambient-motif-interval', 'motif', 'intervalMs');
      bindTime('ambient-motif-length', 'motif', 'lengthMs');
      bind('ambient-motif-rest', 'motif', 'restProb');
      bind('ambient-texture-register', 'texture', 'register');
      bind('ambient-texture-fill', 'texture', 'fill');
      bindTime('ambient-texture-interval', 'texture', 'intervalMs');
      bindTime('ambient-texture-length', 'texture', 'lengthMs');
      bind('ambient-texture-mutate', 'texture', 'mutateRate');
      bindTime('ambient-beat-interval', 'beat', 'intervalMs');
      bindTime('ambient-beat-length', 'beat', 'lengthMs');
      bind('ambient-beat-rest', 'beat', 'restProb');

      const toggle = (id, layer) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', () => {
          const cfg = _laneAmbientCfg(); if (!cfg) return;
          cfg[layer].on = !cfg[layer].on;
          el.classList.toggle('on', cfg[layer].on);
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      };
      toggle('ambient-bed-on', 'bed');
      toggle('ambient-motif-on', 'motif');
      toggle('ambient-texture-on', 'texture');
      toggle('ambient-beat-on', 'beat');

      ['free', 'sync'].forEach(t => {
        const el = document.getElementById('ambient-timing-' + t);
        if (el) el.addEventListener('click', () => {
          const cfg = _laneAmbientCfg(); if (!cfg) return;
          cfg.timing = t; _ambSyncControls();
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      });

      const playBtn = document.getElementById('ambient-play-btn');
      if (playBtn) playBtn.addEventListener('click', () => { if (_ambTimer) _ambStopGenerator(); else _ambStartGenerator(); });
      const regenBtn = document.getElementById('ambient-regen-btn');
      if (regenBtn) regenBtn.addEventListener('click', () => {
        const cfg = _laneAmbientCfg(); if (!cfg) return;
        const t = (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
        cfg.seed = ((cfg.seed * 1664525 + 1013904223 + Math.floor(t * 1000)) >>> 0) || 1;
        if (_ambTimer) { _ambResetClocks(); _ambSeed(cfg.seed); }
        _ambSyncControls();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
      const freezeBtn = document.getElementById('ambient-freeze-btn');
      if (freezeBtn) freezeBtn.addEventListener('click', () => { try { _ambFreezeToLane(); } catch (e) { console.warn('Bloom freeze failed', e); } });
      const exportBtn = document.getElementById('ambient-export-btn');
      if (exportBtn) exportBtn.addEventListener('click', () => { _ambExportToDrive(); });

      _ambInited = true;
      _ambSyncControls();
      _ambStartViz();
    }

    // ---- Mode entry/exit (called by _syncFluidGridToActiveLane) ---------
    function _onAmbientModeChanged(active) {
      if (active) { _ambientInit(); }
      else { _ambStopGenerator(); _ambStopViz(); }
    }
