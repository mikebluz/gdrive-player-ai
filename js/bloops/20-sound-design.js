    // ============================================================
    // 20-sound-design.js — "Design" view + advanced synthesis
    // ============================================================
    // The dedicated sound-design surface, opened from the Tone menu's
    // "✦ Design…" entry. Flow: pick a seed voice (synth/sample) → sculpt
    // (amp envelope, multimode filter + filter envelope, …) → name → save.
    // A saved patch becomes a reusable "User" voice that shows up in the Tone
    // menu (getAllSoundOptions, via _userPatchOptions) and plays on any cell.
    //
    // This file is loaded LAST (after 01-19) so it can reference everything
    // (playNote, getAllSoundOptions, Tone, the grid). All synthesis additions
    // are gated on a patch turning a block `on`, so the warm note path for
    // ordinary cells is untouched (CLAUDE.md audio rule).
    //
    // Phase status: Phases 0-4 shipped (store/seed/save, knob widget, multimode
    // filter + filter env, 2 LFOs + Env2 + macros + 8×N mod-matrix, Surprise +
    // cycling Preview, unison/FM-AM timbre/sub/ring, scannable wavetable +
    // granular, patch management). Bloom integration is planned but NOT started
    // (left untouched on purpose) — see B1/B2/B3 below.
    //
    // ============================================================
    // DEFERRED TO-DOs (tabled — revisit on request, e.g. "any ToDos?")
    // ============================================================
    // 1. LFO 'seq' shape (sequence-as-waveform) — EASIEST.
    //    Use a saved sequence's pitch/velocity/gate contour as the LFO curve,
    //    looping at the LFO rate. Reuse Bloom's _seqToCurve / _seqCurveAt
    //    (17-ambient.js). Work: (a) per-LFO picker UI (which sequence + source
    //    + interp) shown when shape==='seq'; (b) at play, build the curve and
    //    drive a Signal to follow it — same scheduling as the smooth/sharp
    //    sources in _sdBuildModRig. ~a focused session; engine is mostly reuse.
    // 2. Granular position as a LIVE mod destination — MEDIUM.
    //    Tone.GrainPlayer exposes no modulatable read-position param (set only
    //    at .start()), so live position-scan needs a hand-rolled grain
    //    scheduler (windowed BufferSources spawned at the grain rate, each
    //    offset from a position Signal) — which would also unlock jitter /
    //    spray / freeze / per-grain env. CHEAP PARTIAL available now: wire the
    //    mod rig into the grain branch for pitch/rate (GrainPlayer.detune /
    //    playbackRate ARE modulatable) — live granular pitch/speed without the
    //    rewrite.
    // 3. Hard-sync — HARDEST (two routes).
    //    Route A (true): an AudioWorklet custom oscillator (reset slave phase
    //    on master wrap + PolyBLEP anti-aliasing); separate voice path, loaded
    //    via audioWorklet.addModule. Route B (recommended, cheap): a
    //    "sync-spectrum wavetable" — precompute PeriodicWave frames, one per
    //    sync ratio (render one master period of the synced wave → FFT →
    //    createPeriodicWave), then Position == sync amount. Rides on the
    //    existing wavetable engine + its Position mod destination (already
    //    wired), so envelope-swept sync comes nearly for free. ~85% of the
    //    sound for a fraction of Route A's effort.
    // ------------------------------------------------------------
    // Bloom integration plan (separate track, non-breaking) — NOT a tabled
    // item, just deferred: B1 = fix the user:<id> param merge so Bloom's
    // per-layer _detuneMod/FX/level survive (caller-owned whitelist + multiply
    // level), so designed voices play in Bloom layers (which already emit via
    // playNote and already list User patches in _ambToneOptions). B2 = move
    // Bloom's VCA/VCO/VCF onto this shared mod engine behind a flag + parity
    // test. B3 = expose the Design panels per Bloom layer. Ship B1 first.
    // ============================================================

    // ---- "User" patch store -------------------------------------------------
    const userPatches = new Map();   // id(string) -> { id, name, baseType, params }
    let _sdUserSeq = 0;
    const SD_LS_KEY = 'bloops-user-patches';
    function _sdLoadUserPatches() {
      try {
        const raw = localStorage.getItem(SD_LS_KEY);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return;
        arr.forEach(p => {
          if (p && p.id != null) {
            userPatches.set(String(p.id), p);
            _sdUserSeq = Math.max(_sdUserSeq, parseInt(p.id, 10) || 0);
          }
        });
      } catch (e) {}
    }
    function _sdSaveUserPatches() {
      // factory presets are code-defined (re-registered every load) — never persist
      try { localStorage.setItem(SD_LS_KEY, JSON.stringify(Array.from(userPatches.values()).filter(p => !p.factory))); } catch (e) {}
    }
    function _sdCreateUserPatch(name, baseType, params) {
      const id = String(++_sdUserSeq);
      const patch = {
        id, name: (name || ('Patch ' + id)).trim().slice(0, 40),
        baseType: baseType || 'sawtooth',
        params: JSON.parse(JSON.stringify(params || {})),
      };
      userPatches.set(id, patch);
      _sdSaveUserPatches();
      return patch;
    }
    function _sdDeleteUserPatch(id) {
      if (userPatches.delete(String(id))) { _sdSaveUserPatches(); return true; }
      return false;
    }
    // ---- Patch management (Tone menu ▸ User actions) -----------------------
    function _sdRefreshToneMenu() { try { if (typeof populateTonePanel === 'function') populateTonePanel(); } catch (e) {} }
    function _sdToast(msg) { try { if (typeof showToast === 'function') showToast(msg); } catch (e) {} }
    function _sdEditPatch(id) { _sdOpenDesign('user:' + id); }
    function _sdRenamePatch(id) {
      const pch = userPatches.get(String(id)); if (!pch) return;
      const nn = window.prompt('Rename sound:', pch.name);
      if (nn == null) return;
      const t = nn.trim(); if (!t) return;
      pch.name = t.slice(0, 40); _sdSaveUserPatches(); _sdRefreshToneMenu();
    }
    function _sdDuplicatePatch(id) {
      const pch = userPatches.get(String(id)); if (!pch) return;
      const dup = _sdCreateUserPatch((pch.name + ' copy').slice(0, 40), pch.baseType, pch.params);
      _sdRefreshToneMenu(); _sdToast('Duplicated “' + pch.name + '”');
      return dup;
    }
    function _sdDeletePatchUI(id) {
      const pch = userPatches.get(String(id)); if (!pch) return;
      if (!window.confirm('Delete the User sound “' + pch.name + '”?')) return;
      _sdDeleteUserPatch(id); _sdRefreshToneMenu(); _sdToast('Deleted “' + pch.name + '”');
    }
    function _sdExportPatch(id) {
      const pch = userPatches.get(String(id)); if (!pch) return;
      try {
        const data = { bloopsPatch: 1, name: pch.name, baseType: pch.baseType, params: pch.params };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = (pch.name.replace(/[^\w\-]+/g, '_') || 'patch') + '.bloop.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { _sdToast('Export failed'); }
    }
    function _sdImportPatch() {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json,application/json';
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try {
            const d = JSON.parse(r.result);
            if (d && d.params && d.baseType) {
              const pch = _sdCreateUserPatch((d.name || 'Imported').slice(0, 40), d.baseType, d.params);
              _sdRefreshToneMenu(); _sdToast('Imported “' + pch.name + '”');
            } else { _sdToast('Not a valid patch file'); }
          } catch (e) { _sdToast('Could not read patch'); }
        };
        r.readAsText(f);
      });
      inp.click();
    }
    // Options for getAllSoundOptions (called from 04, guarded by typeof).
    function _userPatchOptions() {
      return Array.from(userPatches.values()).map(p => ({ value: 'user:' + p.id, label: p.name }));
    }
    function _resolveUserPatch(value) {
      if (typeof value !== 'string' || value.indexOf('user:') !== 0) return null;
      return userPatches.get(value.slice(5)) || null;
    }

    // ---- Design-param defaults / merge -------------------------------------
    // Mirror of _sdDefaultDesignParams() (15-grid-build.js) — re-declared here
    // with a guard so this file is self-contained if load order ever shifts.
    function _sdDesignDefaults() {
      if (typeof _sdDefaultDesignParams === 'function') return _sdDefaultDesignParams();
      return {
        osc: { unison: 1, spread: 20, sub: 0, subShape: 'sine', harmonicity: 2, modIndex: 10, ring: 0, ringRatio: 1 },
        filter:    { on: false, type: 'lowpass', cutoff: 12000, q: 0.7, drive: 0 },
        filterEnv: { on: false, attack: 5, decay: 220, sustain: 40, release: 300, amount: 0, vel: 0 },
        lfos: [{ on: false, shape: 'sine', rateHz: 5 }, { on: false, shape: 'triangle', rateHz: 0.5 }],
        env2: { on: false, attack: 5, decay: 200, sustain: 0, release: 300 },
        macros: [{ name: 'Macro 1', value: 0 }, { name: 'Macro 2', value: 0 }, { name: 'Macro 3', value: 0 }, { name: 'Macro 4', value: 0 }],
        modMatrix: [],
      };
    }
    // Seed → which oscillator controls apply.
    const SD_BASIC_SHAPES = ['sine', 'square', 'triangle', 'sawtooth', 'pulse', 'fat'];
    function _sdSeedClass(baseType) {
      if (SD_BASIC_SHAPES.indexOf(baseType) >= 0) return 'basic';
      if (baseType === 'fm') return 'fm';
      if (baseType === 'am') return 'am';
      if (baseType === 'duo') return 'duo';
      if (baseType === 'wavetable') return 'wavetable';
      if (baseType === 'sample:grain') return 'grain';
      // pad / mono / bass carry their own hardcoded envelope/filter, so they
      // don't expose oscillator-design knobs (their timbre is preset-defined).
      return 'other';   // samples / pluck / noise / drums / mono / bass / pad
    }
    // Wavetable: morph a 4-frame bank (sine→triangle→sawtooth→square) by a
    // 0-100 position. Returns per-frame gains (two adjacent frames crossfaded).
    const SD_WT_FRAMES = ['sine', 'triangle', 'sawtooth', 'square'];
    function _sdWavetableGains(position) {
      const N = SD_WT_FRAMES.length;
      const p = Math.max(0, Math.min(1, (position || 0) / 100)) * (N - 1);
      const i = Math.min(N - 2, Math.floor(p));
      const frac = p - i;
      const g = new Array(N).fill(0);
      g[i] = 1 - frac; g[i + 1] = frac;
      return g;
    }
    // A fresh, fully-defaulted patch param object (amp env + design blocks).
    function _sdNewPatchParams(baseType) {
      const d = _sdDesignDefaults();
      const harm = baseType === 'fm' ? 3 : baseType === 'duo' ? 1.5 : 2;
      return {
        attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0,
        osc: Object.assign({}, d.osc, { harmonicity: harm }),
        filter: d.filter, filterEnv: d.filterEnv, lfos: d.lfos, env2: d.env2,
        macros: d.macros, modMatrix: d.modMatrix,
        // Granular (grain seed) — read by the GrainPlayer branch (flat keys).
        grainSize: 0.1, grainOverlap: 0.05, grainRate: 1, grainOffset: 0,
        // Wavetable scan position (wavetable seed): 0-100 morphs the 4-frame
        // bank sine → triangle → sawtooth → square.
        wtPosition: 0,
        _seed: baseType || 'sawtooth',
      };
    }
    // True when a patch's oscillator design forces a fresh voice (so playNote
    // must NOT serve it from the pooled-synth fast path). Only ring mod needs
    // one now: FM/AM timbre (harmonicity/modIndex) is set per acquisition on a
    // pooled body, and unison designs pool under a signature key that bakes the
    // fat-oscillator config in (see _buildPooledSynthForPreset). Sub-osc and
    // filter wrap the synth externally, so they never needed a fresh voice.
    // This matters for dense Bloom layers: a Design patch always carries a
    // finite harmonicity, and the old fm/am clause made every such note build
    // a full synth (~7ms) instead of pooling (~1ms) — enough stacked voices
    // starved the scheduler and cut audio out (see bloom-dense-project-perf).
    function _sdOscNeedsFreshVoice(oscD, type) {
      if (!oscD) return false;
      if (oscD.ring > 0) return true;   // ring mod multiplies the voice output
      return false;
    }
    // Resolved oscillator-design values for playNote (clamped). null when absent.
    function _sdOscDesign(params) {
      const o = params && params.osc;
      if (!o) return null;
      return {
        unison: Math.max(1, Math.min(7, (o.unison | 0) || 1)),
        spread: Math.max(0, Math.min(100, Number.isFinite(o.spread) ? o.spread : 20)),
        sub: Math.max(0, Math.min(100, o.sub || 0)),
        subShape: o.subShape || 'sine',
        harmonicity: Number.isFinite(o.harmonicity) ? o.harmonicity : null,
        modIndex: Number.isFinite(o.modIndex) ? o.modIndex : null,
        ring: Math.max(0, Math.min(100, o.ring || 0)),
        ringRatio: Math.max(0.25, Math.min(8, Number.isFinite(o.ringRatio) ? o.ringRatio : 1)),
      };
    }
    // Mod-matrix vocabulary (sources × destinations) + per-destination ranges.
    const SD_MOD_SOURCES = [
      { id: 'lfo1', label: 'LFO 1' }, { id: 'lfo2', label: 'LFO 2' },
      { id: 'env2', label: 'Env 2' }, { id: 'vel', label: 'Vel' },
      { id: 'macro1', label: 'M1' }, { id: 'macro2', label: 'M2' },
      { id: 'macro3', label: 'M3' }, { id: 'macro4', label: 'M4' },
    ];
    const SD_MOD_DESTS = [
      { id: 'pitch', label: 'Pitch' }, { id: 'cutoff', label: 'Cutoff' },
      { id: 'reso', label: 'Reso' }, { id: 'amp', label: 'Amp' }, { id: 'pan', label: 'Pan' },
    ];
    // Destination list for a given seed: the base set, plus WT Pos for the
    // wavetable seed (scans the morph). Keeps the matrix relevant per seed.
    function _sdDestsForSeed(baseType) {
      const base = SD_MOD_DESTS.slice();
      if (baseType === 'wavetable') base.push({ id: 'wtpos', label: 'WT Pos' });
      return base;
    }
    // Full-scale (amount=100) range, in the destination param's own units.
    const SD_DEST_RANGE = { pitch: 1200 /*cents*/, cutoff: 4000 /*Hz*/, reso: 8 /*Q*/, amp: 0.9 /*gain*/, pan: 1, wtpos: 1 /*crossfade*/ };
    function _sdMatrixGet(P, src, dest) {
      const e = (P.modMatrix || []).find(r => r.src === src && r.dest === dest);
      return e ? (e.amount || 0) : 0;
    }
    function _sdMatrixSet(P, src, dest, amount) {
      if (!Array.isArray(P.modMatrix)) P.modMatrix = [];
      const i = P.modMatrix.findIndex(r => r.src === src && r.dest === dest);
      if (!amount) { if (i >= 0) P.modMatrix.splice(i, 1); return; }
      if (i >= 0) P.modMatrix[i].amount = amount;
      else P.modMatrix.push({ src, dest, amount });
    }

    // ---- Audio: per-voice modulation rig (LFOs / Env2 / Vel / Macros) ------
    // Called from playNote AFTER the synth + filter exist. Every source becomes
    // a node whose output is scaled by a Gain and SUMMED into the destination
    // AudioParam (WebAudio adds connected inputs to the param's own value), so
    // the filter envelope + multiple modulators coexist. Returns nodes to be
    // disposed with the voice. Only the standard synth path (with .detune) is
    // covered in this phase; cutoff/reso need the filter on; pan needs a panner.
    function _sdNeedsModPan(params) {
      return Array.isArray(params && params.modMatrix)
        && params.modMatrix.some(r => r.dest === 'pan' && r.amount);
    }
    function _sdNeedsModGain(params) {
      return Array.isArray(params && params.modMatrix)
        && params.modMatrix.some(r => r.dest === 'amp' && r.amount);
    }
    // Evaluate a mod source as a plain JS function of time (seconds since voice
    // start) — used for FILTER destinations, where a connected signal (or any
    // continuously-ramping automation) makes Chrome recompute biquad
    // coefficients at audio rate: 24 design voices with one LFO→cutoff each
    // dropped the audio clock to ~0.82× real time (the dense-project cut-out),
    // while STEPPED/held automation on the same param measured free. Returns
    // null when the source is unavailable/off.
    function _sdModSrcFn(id, params, ctx) {
      const vel = (ctx && ctx.velocity != null) ? ctx.velocity : 1;
      const dur = Math.max(0.02, (ctx && ctx.dur) || 0.3);
      const lfos = Array.isArray(params.lfos) ? params.lfos : [];
      const macros = Array.isArray(params.macros) ? params.macros : [];
      if (id === 'lfo1' || id === 'lfo2') {
        const lf = lfos[id === 'lfo1' ? 0 : 1];
        if (!lf || !lf.on) return null;
        const rate = Math.max(0.01, lf.rateHz || 1);
        const shape = lf.shape || 'sine';
        if (shape === 'smooth' || shape === 'sharp') {
          // Stochastic: precompute random control points once per voice
          // (fresh values at the LFO rate, like the Signal-stepped version).
          const step = 1 / Math.max(0.05, lf.rateHz || 1);
          const count = Math.min(240, Math.ceil((dur + 2.5) / step)) + 1;
          const pts = [];
          for (let k = 0; k <= count; k++) pts.push(Math.random() * 2 - 1);
          return (t) => {
            const x = Math.max(0, t / step), i = Math.min(count - 1, Math.floor(x));
            if (shape === 'sharp') return pts[i];
            const fr = Math.min(1, x - i);
            return pts[i] + (pts[Math.min(count, i + 1)] - pts[i]) * fr;
          };
        }
        return (t) => {
          const ph = (t * rate) % 1;
          if (shape === 'triangle') return ph < 0.5 ? (ph * 4 - 1) : (3 - ph * 4);
          if (shape === 'sawtooth') return ph * 2 - 1;
          if (shape === 'square') return ph < 0.5 ? 1 : -1;
          return Math.sin(ph * 2 * Math.PI);
        };
      }
      if (id === 'env2') {
        const e = params.env2;
        if (!e || !e.on) return null;
        const a = Math.max(0.001, (e.attack || 0) / 1000), d = Math.max(0.001, (e.decay || 0) / 1000);
        const s = Math.max(0, Math.min(1, (e.sustain || 0) / 100)), r = Math.max(0.001, (e.release || 0) / 1000);
        return (t) => {
          if (t <= 0) return 0;
          if (t < a) return t / a;
          if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
          if (t < dur) return s;
          return Math.max(0, s * (1 - (t - dur) / r));
        };
      }
      if (id === 'vel') return () => vel;
      if (id.indexOf('macro') === 0) {
        const m = macros[parseInt(id.slice(5), 10) - 1];
        const v = m ? Math.max(0, Math.min(1, (m.value || 0) / 100)) : 0;
        return () => v;
      }
      return null;
    }

    function _sdBuildModRig(params, refs, ctx) {
      const matrix = (params && Array.isArray(params.modMatrix)) ? params.modMatrix.filter(r => r && r.amount) : [];
      if (!matrix.length || typeof Tone === 'undefined') return [];
      const now = (ctx && typeof ctx.startTime === 'number') ? ctx.startTime
        : ((typeof Tone.now === 'function') ? Tone.now() : 0);
      const vel = (ctx && ctx.velocity != null) ? ctx.velocity : 1;
      const dur = Math.max(0.02, (ctx && ctx.dur) || 0.3);
      const nodes = [];
      const lfos = Array.isArray(params.lfos) ? params.lfos : [];
      const macros = Array.isArray(params.macros) ? params.macros : [];

      // ---- FILTER destinations (cutoff / reso): scheduled control-rate curve.
      // Never connect a modulator into a biquad param — that forces per-SAMPLE
      // filter-coefficient recompute in Chrome and overran the render thread on
      // dense design layers. Instead sample env+mods in JS every ~30 ms and
      // schedule the COMBINED curve directly on the param with short 5 ms
      // glides (flat between points → k-rate almost always; the glide avoids
      // step zipper). Pre-summing is required because param automation can't
      // sum two schedules — this takes over the filter-env ramps too
      // (_sdFilterEnvShape is the same math _sdBuildVoiceFilter schedules).
      // Held presses (dur > 30 s: unbounded hold) keep the connected-LFO path
      // below — a single live voice is affordable.
      const cutRoutes = refs.filter ? matrix.filter(r => r.dest === 'cutoff') : [];
      const resRoutes = refs.filter ? matrix.filter(r => r.dest === 'reso') : [];
      const schedFilterMod = (dur <= 30) && (cutRoutes.length || resRoutes.length);
      if (schedFilterMod) {
        const clampHz = (v) => Math.max(20, Math.min(20000, v));
        const f = params.filter || {};
        const baseHz = clampHz(Number.isFinite(f.cutoff) ? f.cutoff : 12000);
        const baseQ = Math.max(0.1, Math.min(20, Number.isFinite(f.q) ? f.q : 0.7));
        const envShape = _sdFilterEnvShape(params, ctx, clampHz);
        const span = Math.max(dur, envShape ? envShape.end : 0) + 2.5;
        // 45 ms control points with 5 ms glides ≈ 11% of quanta carrying ramp
        // content — the k-rate/a-rate sweet spot measured for biquad params.
        const step = Math.max(0.045, span / 400);
        const routeFns = (routes) => routes
          .map((r) => ({ scale: (r.amount / 100) * (SD_DEST_RANGE[r.dest] || 1), fn: _sdModSrcFn(r.src, params, ctx) }))
          .filter((r) => r.fn);
        // Hold the previous value until 5 ms before each control point, then
        // glide to the new one: flat between points (k-rate quanta), no zipper.
        const scheduleCurve = (param, valueAt, clamp) => {
          try {
            param.cancelScheduledValues(now);
            let prev = clamp(valueAt(0));
            param.setValueAtTime(prev, now);
            for (let t = step; t <= span; t += step) {
              const v = clamp(valueAt(t));
              param.setValueAtTime(prev, now + t - 0.005);
              param.linearRampToValueAtTime(v, now + t);
              prev = v;
            }
          } catch (e) {}
        };
        if (cutRoutes.length) {
          const fns = routeFns(cutRoutes);
          scheduleCurve(refs.filter.frequency, (t) => {
            let v = envShape ? envShape.valueAt(t) : baseHz;
            for (const m of fns) v += m.scale * m.fn(t);
            return v;
          }, clampHz);
        }
        if (resRoutes.length) {
          const fns = routeFns(resRoutes);
          scheduleCurve(refs.filter.Q, (t) => {
            let v = baseQ;
            for (const m of fns) v += m.scale * m.fn(t);
            return v;
          }, (v) => Math.max(0.05, Math.min(30, v)));
        }
      }
      // Lazily create each referenced source node, cached by id.
      const srcCache = {};
      const makeSource = (id) => {
        if (srcCache[id] !== undefined) return srcCache[id];
        let node = null;
        try {
          if (id === 'lfo1' || id === 'lfo2') {
            const lf = lfos[id === 'lfo1' ? 0 : 1];
            if (lf && lf.on) {
              if (lf.shape === 'smooth' || lf.shape === 'sharp') {
                // Stochastic LFOs: a Signal stepped to fresh random values at
                // the LFO rate — 'sharp' jumps (sample & hold), 'smooth' ramps.
                node = new Tone.Signal(0);
                const rate = Math.max(0.05, lf.rateHz || 1);
                const step = 1 / rate;
                const span = dur + 2.5;                       // cover the release tail
                const count = Math.min(240, Math.ceil(span / step));
                const sig = node;
                for (let k = 0; k <= count; k++) {
                  const t = now + k * step;
                  const r = Math.random() * 2 - 1;
                  try {
                    if (lf.shape === 'sharp') sig.setValueAtTime(r, t);
                    else sig.linearRampToValueAtTime(r, t);
                  } catch (e) {}
                }
              } else if (dur <= 30) {
                // Deterministic LFO shapes for SEQUENCED notes: scheduled
                // control-rate automation on a Signal, same pattern as the
                // stochastic shapes above. A per-voice Tone.LFO is an audio-
                // rate oscillator + waveshaper + scaling stage; 24 design
                // voices × 2 LFOs measurably overran the render thread (audio
                // clock fell to ~0.57× real time = the dense-project cut-out;
                // see bloom-dense-project-perf). A ConstantSource ramping
                // through precomputed points renders ~free and sums into the
                // destination param identically. Held grid presses (dur 3600)
                // keep the true LFO below — one live voice, unbounded hold.
                node = new Tone.Signal(0);
                const rate = Math.max(0.01, lf.rateHz || 1);
                const period = 1 / rate;
                const span = dur + 2.5;                       // cover the release tail
                const sig = node;
                const shape = lf.shape || 'sine';
                if (shape === 'square') {
                  // Alternate ±1 at half-period steps; floor the step so very
                  // long/fast combos degrade in resolution, not coverage.
                  const step = Math.max(period / 2, span / 512);
                  const count = Math.ceil(span / step);
                  for (let k = 0; k <= count; k++) {
                    try { sig.setValueAtTime((k % 2 === 0) ? 1 : -1, now + k * step); } catch (e) {}
                  }
                } else {
                  // sine / triangle / sawtooth: piecewise-linear samples of one
                  // cycle, repeated. 16 points/cycle is audibly smooth for a
                  // control signal; the step floor caps total events at ~512.
                  const step = Math.max(period / 16, span / 512);
                  const count = Math.ceil(span / step);
                  const val = (t) => {
                    const ph = (t * rate) % 1;                // 0..1, phase 0 at voice start (like LFO.start(now))
                    if (shape === 'triangle') return ph < 0.5 ? (ph * 4 - 1) : (3 - ph * 4);
                    if (shape === 'sawtooth') return ph * 2 - 1;
                    return Math.sin(ph * 2 * Math.PI);        // sine (and fallback)
                  };
                  try { sig.setValueAtTime(val(0), now); } catch (e) {}
                  for (let k = 1; k <= count; k++) {
                    try { sig.linearRampToValueAtTime(val(k * step), now + k * step); } catch (e) {}
                  }
                }
              } else {
                node = new Tone.LFO({ frequency: Math.max(0.01, lf.rateHz || 1), min: -1, max: 1, type: lf.shape || 'sine' });
                node.start(now);
              }
            }
          } else if (id === 'env2') {
            const e = params.env2;
            if (e && e.on) {
              node = new Tone.Envelope({ attack: Math.max(0.001, (e.attack || 0) / 1000), decay: Math.max(0.001, (e.decay || 0) / 1000), sustain: Math.max(0, Math.min(1, (e.sustain || 0) / 100)), release: Math.max(0.001, (e.release || 0) / 1000) });
              node.triggerAttackRelease(dur, now);
            }
          } else if (id === 'vel') {
            node = new Tone.Signal(vel);
          } else if (id.indexOf('macro') === 0) {
            const m = macros[parseInt(id.slice(5), 10) - 1];
            node = new Tone.Signal(m ? Math.max(0, Math.min(1, (m.value || 0) / 100)) : 0);
          }
        } catch (e) { node = null; }
        if (node) nodes.push(node);
        srcCache[id] = node;
        return node;
      };
      const destParam = (dest) => {
        if (dest === 'pitch') return (refs.synth && refs.synth.detune) || null;
        if (dest === 'cutoff') return (refs.filter && refs.filter.frequency) || null;
        if (dest === 'reso') return (refs.filter && refs.filter.Q) || null;
        if (dest === 'amp') return (refs.gain && refs.gain.gain) || null;
        if (dest === 'pan') return (refs.panner && refs.panner.pan) || null;
        if (dest === 'wtpos') return refs.wtpos || null;   // a Signal/Param
        return null;
      };
      matrix.forEach(r => {
        // cutoff/reso already applied above as a scheduled curve — connecting
        // a source node into a biquad param would both double-modulate and
        // reintroduce the per-sample coefficient cost.
        if (schedFilterMod && (r.dest === 'cutoff' || r.dest === 'reso')) return;
        const src = makeSource(r.src);
        const param = destParam(r.dest);
        if (!src || !param) return;
        const scale = (r.amount / 100) * (SD_DEST_RANGE[r.dest] || 1);
        try {
          const g = new Tone.Gain(scale);
          src.connect(g); g.connect(param);
          nodes.push(g);
        } catch (e) {}
      });
      return nodes;
    }

    // Piecewise-linear value of the filter envelope over time (seconds since
    // voice start) — the SAME curve _sdBuildVoiceFilter schedules as ramps.
    // Shared so the mod rig's combined cutoff curve (env + LFOs, pre-summed)
    // can't drift from the ramp-scheduled envelope. null when filterEnv is off.
    function _sdFilterEnvShape(params, ctx, clampHz) {
      const f = params && params.filter;
      const fe = params && params.filterEnv;
      if (!f || !fe || !fe.on) return null;
      const vel = (ctx && ctx.velocity != null) ? ctx.velocity : 1;
      const dur = Math.max(0.02, (ctx && ctx.dur) || 0.3);
      const base = clampHz(Number.isFinite(f.cutoff) ? f.cutoff : 12000);
      const oct = ((fe.amount || 0) / 100) * 5 + ((fe.vel || 0) / 100) * 5 * vel;
      const peakHz = clampHz(base * Math.pow(2, oct));
      const susHz  = clampHz(base * Math.pow(2, oct * Math.max(0, Math.min(1, (fe.sustain || 0) / 100))));
      const a = Math.max(0.001, (fe.attack  || 0) / 1000);
      const d = Math.max(0.001, (fe.decay   || 0) / 1000);
      const r = Math.max(0.001, (fe.release || 0) / 1000);
      const relT = Math.max(a + d, dur);
      return {
        base, peakHz, susHz, a, d, r, relT, end: relT + r,
        valueAt: (t) => {
          if (t <= 0) return base;
          if (t < a) return base + (peakHz - base) * (t / a);
          if (t < a + d) return peakHz + (susHz - peakHz) * ((t - a) / d);
          if (t < relT) return susHz;
          if (t < relT + r) return susHz + (base - susHz) * ((t - relT) / r);
          return base;
        },
      };
    }

    // ---- Audio: per-voice multimode filter + filter envelope ---------------
    // Built in playNote (04) only when params.filter.on. Returns a Tone.Filter
    // whose frequency is (optionally) enveloped via scheduled ramps — no extra
    // persistent node, and it's disposed with the voice's effect chain.
    function _sdBuildVoiceFilter(params, ctx) {
      const f = params && params.filter;
      if (!f || !f.on || typeof Tone === 'undefined') return null;
      const clampHz = (v) => Math.max(20, Math.min(20000, v));
      const base = clampHz(Number.isFinite(f.cutoff) ? f.cutoff : 12000);
      let filt;
      try {
        filt = new Tone.Filter({
          type: f.type || 'lowpass',
          frequency: base,
          Q: Math.max(0.1, Math.min(20, Number.isFinite(f.q) ? f.q : 0.7)),
          rolloff: -24,
        });
      } catch (e) { return null; }
      const fe = params.filterEnv;
      if (fe && fe.on) {
        try {
          const now = (ctx && typeof ctx.startTime === 'number')
            ? ctx.startTime
            : ((typeof Tone.now === 'function') ? Tone.now() : 0);
          // Envelope curve math lives in _sdFilterEnvShape (amount/vel in
          // "octaves", ±5 oct full-scale) — shared with the mod rig's combined
          // cutoff curve so the two can never drift.
          const sh = _sdFilterEnvShape(params, ctx, clampHz);
          const p = filt.frequency;
          p.cancelScheduledValues(now);
          p.setValueAtTime(sh.base, now);
          p.linearRampToValueAtTime(sh.peakHz, now + sh.a);
          p.linearRampToValueAtTime(sh.susHz, now + sh.a + sh.d);
          const relAt = now + sh.relT;
          p.setValueAtTime(sh.susHz, relAt);
          p.linearRampToValueAtTime(sh.base, relAt + sh.r);
        } catch (e) {}
      }
      return filt;
    }

    // ---- Rotary knob widget -------------------------------------------------
    // _sdMakeKnob({ label, min, max, value, step, unit, log, onChange, format,
    //               defaultValue }) → wrapper element. wrapper._sd exposes
    // { setValue(v,fire), getValue() }. Vertical drag changes value; double-
    // click resets to defaultValue. Pointer events cover mouse + touch.
    function _sdMakeKnob(opts) {
      const o = Object.assign({ min: 0, max: 100, value: 0, step: 0, unit: '', log: false,
        label: '', format: null, defaultValue: null, onChange: null }, opts);
      const wrap = document.createElement('div'); wrap.className = 'sd-knob' + (o.compact ? ' sd-knob-compact' : '');
      const dial = document.createElement('div'); dial.className = 'sd-knob-dial';
      const ind  = document.createElement('div'); ind.className = 'sd-knob-ind'; dial.appendChild(ind);
      const lab  = document.createElement('div'); lab.className = 'sd-knob-label'; lab.textContent = o.label;
      const valEl = document.createElement('div'); valEl.className = 'sd-knob-val';
      wrap.appendChild(lab); wrap.appendChild(dial); wrap.appendChild(valEl);
      const clamp = (v) => Math.max(o.min, Math.min(o.max, v));
      const logMin = (o.log && o.min > 0) ? o.min : 0;
      const toFrac = (v) => o.log
        ? Math.log(v / logMin) / Math.log(o.max / logMin)
        : (v - o.min) / (o.max - o.min);
      const fromFrac = (fr) => o.log
        ? logMin * Math.pow(o.max / logMin, fr)
        : o.min + fr * (o.max - o.min);
      const quant = (v) => o.step ? Math.round(v / o.step) * o.step : v;
      const fmt = (v) => o.format ? o.format(v)
        : ((Math.round(v * 100) / 100) + (o.unit ? (' ' + o.unit) : ''));
      let value = clamp(o.value);
      const render = () => {
        const fr = Math.max(0, Math.min(1, toFrac(value)));
        dial.style.setProperty('--sd-ang', (-135 + fr * 270) + 'deg');
        valEl.textContent = fmt(value);
      };
      const setValue = (v, fire) => { value = clamp(quant(v)); render(); if (fire && o.onChange) o.onChange(value); };
      render();
      let dragging = false, startY = 0, startFr = 0;
      dial.addEventListener('pointerdown', (e) => {
        e.preventDefault(); dragging = true; startY = e.clientY; startFr = toFrac(value);
        try { dial.setPointerCapture(e.pointerId); } catch (x) {}
        dial.classList.add('dragging');
      });
      dial.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const fine = e.shiftKey ? 0.25 : 1;          // hold Shift = fine
        const dy = (startY - e.clientY) * fine;
        const fr = Math.max(0, Math.min(1, startFr + dy / 200));
        setValue(fromFrac(fr), true);
      });
      const end = (e) => { if (dragging) { dragging = false; dial.classList.remove('dragging'); try { dial.releasePointerCapture(e.pointerId); } catch (x) {} } };
      dial.addEventListener('pointerup', end);
      dial.addEventListener('pointercancel', end);
      if (o.defaultValue != null) dial.addEventListener('dblclick', () => setValue(o.defaultValue, true));
      wrap._sd = { setValue, getValue: () => value };
      return wrap;
    }

    // ---- Design view (overlay) ---------------------------------------------
    let _sdState = null;   // { params, baseType, editId } while the overlay is open

    function _sdSeedOptions() {
      // Base voices a patch can be built from: synths + samples, but NOT other
      // user patches or ensembles (no recursion).
      let opts = [];
      try { if (typeof getAllSoundOptions === 'function') opts = getAllSoundOptions() || []; } catch (e) {}
      return opts.filter(o => typeof o.value === 'string'
        && o.value.indexOf('user:') !== 0
        && o.value.indexOf('ensemble:') !== 0);
    }

    function _sdEnsureOverlay() {
      let ov = document.getElementById('sd-overlay');
      if (ov) return ov;
      ov = document.createElement('div');
      ov.id = 'sd-overlay';
      ov.className = 'sd-overlay';
      ov.innerHTML = '<div class="sd-modal" role="dialog" aria-label="Sound Design">' +
        '<div class="sd-head"><span class="sd-title">✦ Design a sound</span>' +
        '<button type="button" class="sd-close" id="sd-close" title="Close">✕</button></div>' +
        '<div class="sd-body" id="sd-body"></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) _sdCloseDesign(); });
      ov.querySelector('#sd-close').addEventListener('click', _sdCloseDesign);
      return ov;
    }

    function _sdOpenDesign(editValue) {
      // Close any open menu panel so the Design overlay replaces it rather than
      // stacking over it (the Tone menu, but also the Sounds / FX panels that
      // may be open behind it, and their banner triggers).
      try {
        ['tone-panel', 'grid-settings-panel', 'fx-panel'].forEach(id => {
          const el = document.getElementById(id); if (el) el.classList.remove('open');
        });
        ['tone-banner-half', 'scale-banner-half', 'fx-banner'].forEach(id => {
          const el = document.getElementById(id); if (el) el.classList.remove('open');
        });
      } catch (e) {}
      const ov = _sdEnsureOverlay();
      const existing = editValue ? _resolveUserPatch(editValue) : null;
      if (existing) {
        // Editing an existing User patch — edits save back over it.
        _sdState = { params: JSON.parse(JSON.stringify(existing.params)), baseType: existing.baseType, editId: existing.id, name: existing.name };
        _sdRenderEditor();
      } else if (typeof editValue === 'string' && editValue && _sdIsSeedValue(editValue)) {
        // Editing a built-in tone (e.g. the active grid tone): seed the editor
        // straight from that voice and skip the seed picker. Built-ins can't be
        // mutated, so saving forks a new User patch (editId stays null).
        _sdState = { params: _sdNewPatchParams(editValue), baseType: editValue, editId: null, name: '' };
        _sdRenderEditor();
      } else {
        _sdState = null;
        _sdRenderSeedPicker();
      }
      ov.classList.add('open');
    }
    // True when `value` is one of the Design seed voices (a built-in tone the
    // editor can be seeded from), as opposed to a user:/ensemble: value.
    function _sdIsSeedValue(value) {
      try { return _sdSeedOptions().some(o => o.value === value); } catch (e) { return false; }
    }
    // Edit the grid's currently-active tone in the sound designer. A uniform
    // tone opens for editing (User patch → edit in place; built-in → seeded
    // fork); a "Custom" grid (cells differ — no single tone) falls back to the
    // seed picker.
    function _sdEditActiveGridTone() {
      let value;
      try {
        if (Array.isArray(cellSounds) && cellSounds.length &&
            (typeof cellSoundsAreUniform !== 'function' || cellSoundsAreUniform())) {
          value = cellSounds[0];
        }
      } catch (e) {}
      _sdOpenDesign(value || undefined);
    }
    function _sdCloseDesign() {
      try { _sdStopPreview(); } catch (e) {}
      const ov = document.getElementById('sd-overlay');
      if (ov) ov.classList.remove('open');
      _sdState = null;
    }

    function _sdRenderSeedPicker() {
      const body = document.getElementById('sd-body');
      if (!body) return;
      body.innerHTML = '<div class="sd-step-label">1 · Pick a starting voice</div>' +
        '<div class="sd-seed-grid" id="sd-seed-grid"></div>';
      const grid = body.querySelector('#sd-seed-grid');
      _sdSeedOptions().forEach(opt => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sd-seed-btn'; b.textContent = opt.label;
        b.addEventListener('click', () => {
          _sdState = { params: _sdNewPatchParams(opt.value), baseType: opt.value, editId: null, name: '' };
          _sdRenderEditor();
        });
        grid.appendChild(b);
      });
    }

    // Helper to build a labelled section with a row of knobs.
    function _sdSection(title, opts) {
      const sec = document.createElement('div'); sec.className = 'sd-section';
      const head = document.createElement('div'); head.className = 'sd-section-head';
      head.textContent = title;
      sec.appendChild(head);
      if (opts && opts.toggle) {
        const t = document.createElement('button');
        t.type = 'button'; t.className = 'sd-toggle' + (opts.toggle.on ? ' on' : '');
        t.textContent = opts.toggle.on ? 'On' : 'Off';
        t.addEventListener('click', () => {
          const now = !t.classList.contains('on');
          t.classList.toggle('on', now); t.textContent = now ? 'On' : 'Off';
          opts.toggle.onChange(now);
        });
        head.appendChild(t);
      }
      const row = document.createElement('div'); row.className = 'sd-knob-row';
      sec.appendChild(row);
      sec._row = row;
      return sec;
    }

    function _sdRenderEditor() {
      const body = document.getElementById('sd-body');
      if (!body || !_sdState) return;
      const P = _sdState.params;
      const baseLabel = (_sdSeedOptions().find(o => o.value === _sdState.baseType) || {}).label || _sdState.baseType;
      body.innerHTML = '';

      // Top bar: back to seed · name · Surprise · Rate · Preview · Save.
      const top = document.createElement('div'); top.className = 'sd-editor-top';
      top.innerHTML =
        '<button type="button" class="sd-mini" id="sd-back">‹ Seed: ' + baseLabel + '</button>' +
        '<input type="text" class="sd-name" id="sd-name" maxlength="40" placeholder="Name this sound…" />' +
        '<button type="button" class="sd-mini sd-surprise" id="sd-surprise" title="Randomize every parameter">🎲 Surprise me</button>' +
        '<button type="button" class="sd-mini sd-reset" id="sd-reset" title="Reset every setting (envelope, filter, LFOs, matrix…) to this seed\'s defaults">↺ Reset</button>' +
        '<div class="sd-rate-wrap"><span class="sd-rate-cap">Rate</span><span id="sd-rate-host"></span></div>' +
        '<div class="sd-rate-wrap"><span class="sd-rate-cap">Oct</span>' +
          '<select class="sd-oct" id="sd-oct" title="Octave of the preview notes">' +
            [-3, -2, -1, 0, 1, 2, 3].map(o => '<option value="' + o + '"' + (o === _sdPreviewOctave ? ' selected' : '') + '>' + (o > 0 ? '+' + o : o) + '</option>').join('') +
          '</select></div>' +
        '<button type="button" class="sd-mini sd-preview" id="sd-preview">▶ Preview</button>' +
        '<button type="button" class="sd-save" id="sd-save">Save</button>';
      body.appendChild(top);
      top.querySelector('#sd-name').value = _sdState.name || '';
      top.querySelector('#sd-rate-host').appendChild(_sdMakeKnob({
        compact: true, label: '', min: 0.5, max: 8, value: _sdPreviewRate, step: 0.1,
        defaultValue: 2.5, format: (v) => (Math.round(v * 10) / 10) + '/s',
        onChange: (v) => _sdSetPreviewRate(v),
      }));
      top.querySelector('#sd-back').addEventListener('click', () => {
        if (_sdState.editId) return;            // editing → no re-seed
        _sdStopPreview();
        _sdRenderSeedPicker();
      });
      top.querySelector('#sd-surprise').addEventListener('click', _sdSurprise);
      top.querySelector('#sd-reset').addEventListener('click', _sdResetParams);
      top.querySelector('#sd-preview').addEventListener('click', _sdCyclePreview);
      { const oct = top.querySelector('#sd-oct');
        if (oct) oct.addEventListener('change', () => { _sdPreviewOctave = parseInt(oct.value, 10) || 0; }); }
      top.querySelector('#sd-save').addEventListener('click', _sdSaveFromEditor);
      _sdReflectPreviewBtn();

      const panes = document.createElement('div'); panes.className = 'sd-panes';
      body.appendChild(panes);

      // --- Oscillator / Wavetable / Granular (seed-dependent) ---
      if (!P.osc) P.osc = _sdDesignDefaults().osc;
      const seedClass = _sdSeedClass(_sdState.baseType);
      const ms = (v) => Math.round(v) + ' ms';
      if (seedClass === 'wavetable') {
        const wt = _sdSection('Wavetable');
        const frameName = (pos) => { const g = _sdWavetableGains(pos); const i = g.findIndex(x => x >= 0.5); return SD_WT_FRAMES[Math.max(0, i)]; };
        wt._row.appendChild(_sdMakeKnob({ label: 'Position', min: 0, max: 100, value: P.wtPosition || 0, step: 1, defaultValue: 0, format: (v) => frameName(v), onChange: (v) => P.wtPosition = v }));
        const note = document.createElement('div'); note.className = 'sd-wt-note';
        note.textContent = 'sine → triangle → sawtooth → square';
        wt._row.appendChild(note);
        panes.appendChild(wt);
      } else if (seedClass === 'grain') {
        const gr = _sdSection('Granular');
        gr._row.appendChild(_sdMakeKnob({ label: 'Grain', min: 10, max: 500, value: Math.round((P.grainSize || 0.1) * 1000), step: 1, defaultValue: 100, format: ms, onChange: (v) => P.grainSize = v / 1000 }));
        gr._row.appendChild(_sdMakeKnob({ label: 'Density', min: 1, max: 250, value: Math.round((P.grainOverlap || 0.05) * 1000), step: 1, defaultValue: 50, format: ms, onChange: (v) => P.grainOverlap = v / 1000 }));
        gr._row.appendChild(_sdMakeKnob({ label: 'Rate', min: -2, max: 2, value: Number.isFinite(P.grainRate) ? P.grainRate : 1, step: 0.05, defaultValue: 1, format: (v) => (Math.round(v * 100) / 100) + '×', onChange: (v) => P.grainRate = v }));
        gr._row.appendChild(_sdMakeKnob({ label: 'Position', min: 0, max: 100, value: Math.round((P.grainOffset || 0) * 100), step: 1, unit: '%', defaultValue: 0, onChange: (v) => P.grainOffset = v / 100 }));
        panes.appendChild(gr);
      } else if (seedClass !== 'other') {
        const osc = _sdSection('Oscillator');
        if (seedClass === 'basic') {
          osc._row.appendChild(_sdMakeKnob({ label: 'Unison', min: 1, max: 7, value: P.osc.unison || 1, step: 1, defaultValue: 1, format: (v) => (v <= 1 ? 'off' : v + ' ×'), onChange: (v) => P.osc.unison = v }));
          osc._row.appendChild(_sdMakeKnob({ label: 'Spread', min: 0, max: 100, value: P.osc.spread, step: 1, unit: '¢', defaultValue: 20, onChange: (v) => P.osc.spread = v }));
        } else {
          // Double-click resets to the SEED's default harmonicity (fm 3 / duo
          // 1.5 / else 2), not the current value — matching _sdNewPatchParams.
          const _harmDefault = _sdState.baseType === 'fm' ? 3 : _sdState.baseType === 'duo' ? 1.5 : 2;
          osc._row.appendChild(_sdMakeKnob({ label: 'Harmonic', min: 0.25, max: 12, value: P.osc.harmonicity, step: 0.05, defaultValue: _harmDefault, format: (v) => (Math.round(v * 100) / 100) + '', onChange: (v) => P.osc.harmonicity = v }));
          if (seedClass === 'fm') {
            osc._row.appendChild(_sdMakeKnob({ label: 'FM Index', min: 0, max: 40, value: P.osc.modIndex, step: 0.5, defaultValue: 10, onChange: (v) => P.osc.modIndex = v }));
          }
        }
        // Sub-oscillator (all oscillator seeds).
        osc._row.appendChild(_sdMakeKnob({ label: 'Sub', min: 0, max: 100, value: P.osc.sub, step: 1, unit: '%', defaultValue: 0, onChange: (v) => P.osc.sub = v }));
        const subWrap = document.createElement('div'); subWrap.className = 'sd-select-wrap';
        subWrap.innerHTML = '<label>Sub wave</label><select class="sd-select"></select>';
        ['sine', 'triangle', 'square'].forEach(s => {
          const op = document.createElement('option'); op.value = s;
          op.textContent = s.charAt(0).toUpperCase() + s.slice(1);
          if (P.osc.subShape === s) op.selected = true; subWrap.querySelector('select').appendChild(op);
        });
        subWrap.querySelector('select').addEventListener('change', (e) => P.osc.subShape = e.target.value);
        osc._row.appendChild(subWrap);
        // Ring modulation (all oscillator seeds) — multiplies the voice by a
        // modulator at freq×ratio for metallic / inharmonic timbres.
        osc._row.appendChild(_sdMakeKnob({ label: 'Ring', min: 0, max: 100, value: P.osc.ring || 0, step: 1, unit: '%', defaultValue: 0, onChange: (v) => P.osc.ring = v }));
        osc._row.appendChild(_sdMakeKnob({ label: 'Ring ×', min: 0.25, max: 8, value: P.osc.ringRatio || 1, step: 0.05, defaultValue: 1, format: (v) => (Math.round(v * 100) / 100) + '×', onChange: (v) => P.osc.ringRatio = v }));
        panes.appendChild(osc);
      }

      // --- Amp envelope ---
      const amp = _sdSection('Amp envelope');
      amp._row.appendChild(_sdMakeKnob({ label: 'Attack',  min: 0, max: 4000, value: P.attack,  step: 1, defaultValue: 10,   format: ms, onChange: (v) => P.attack = v }));
      amp._row.appendChild(_sdMakeKnob({ label: 'Decay',   min: 1, max: 4000, value: P.decay,   step: 1, defaultValue: 100,  format: ms, onChange: (v) => P.decay = v }));
      amp._row.appendChild(_sdMakeKnob({ label: 'Sustain', min: 0, max: 100,  value: P.sustain, step: 1, unit: '%', defaultValue: 50, onChange: (v) => P.sustain = v }));
      amp._row.appendChild(_sdMakeKnob({ label: 'Release', min: 1, max: 8000, value: P.release, step: 1, defaultValue: 1400, format: ms, onChange: (v) => P.release = v }));
      amp._row.appendChild(_sdMakeKnob({ label: 'Level',   min: 0, max: 100,  value: P.volume,  step: 1, unit: '%', defaultValue: 100, onChange: (v) => P.volume = v }));
      panes.appendChild(amp);

      // --- Filter ---
      if (!P.filter) P.filter = _sdDesignDefaults().filter;
      const hz = (v) => v >= 1000 ? (Math.round(v / 10) / 100) + ' kHz' : Math.round(v) + ' Hz';
      const filt = _sdSection('Filter', { toggle: { on: !!P.filter.on, onChange: (on) => { P.filter.on = on; } } });
      const typeWrap = document.createElement('div'); typeWrap.className = 'sd-select-wrap';
      typeWrap.innerHTML = '<label>Type</label><select class="sd-select" id="sd-filter-type"></select>';
      ['lowpass', 'highpass', 'bandpass', 'notch'].forEach(t => {
        const op = document.createElement('option'); op.value = t;
        op.textContent = t.charAt(0).toUpperCase() + t.slice(1);
        if (P.filter.type === t) op.selected = true;
        typeWrap.querySelector('select').appendChild(op);
      });
      typeWrap.querySelector('select').addEventListener('change', (e) => P.filter.type = e.target.value);
      filt._row.appendChild(typeWrap);
      filt._row.appendChild(_sdMakeKnob({ label: 'Cutoff', min: 20, max: 20000, value: P.filter.cutoff, log: true, defaultValue: 12000, format: hz, onChange: (v) => P.filter.cutoff = v }));
      filt._row.appendChild(_sdMakeKnob({ label: 'Reso',   min: 0.1, max: 20,  value: P.filter.q, step: 0.1, defaultValue: 0.7, onChange: (v) => P.filter.q = v }));
      panes.appendChild(filt);

      // --- Filter envelope ---
      if (!P.filterEnv) P.filterEnv = _sdDesignDefaults().filterEnv;
      const fenv = _sdSection('Filter envelope', { toggle: { on: !!P.filterEnv.on, onChange: (on) => { P.filterEnv.on = on; } } });
      fenv._row.appendChild(_sdMakeKnob({ label: 'Amount',  min: -100, max: 100, value: P.filterEnv.amount, step: 1, unit: '%', defaultValue: 0, onChange: (v) => P.filterEnv.amount = v }));
      fenv._row.appendChild(_sdMakeKnob({ label: 'Attack',  min: 0, max: 4000, value: P.filterEnv.attack,  step: 1, defaultValue: 5,   format: ms, onChange: (v) => P.filterEnv.attack = v }));
      fenv._row.appendChild(_sdMakeKnob({ label: 'Decay',   min: 1, max: 4000, value: P.filterEnv.decay,   step: 1, defaultValue: 220, format: ms, onChange: (v) => P.filterEnv.decay = v }));
      fenv._row.appendChild(_sdMakeKnob({ label: 'Sustain', min: 0, max: 100,  value: P.filterEnv.sustain, step: 1, unit: '%', defaultValue: 40, onChange: (v) => P.filterEnv.sustain = v }));
      fenv._row.appendChild(_sdMakeKnob({ label: 'Release', min: 1, max: 8000, value: P.filterEnv.release, step: 1, defaultValue: 300, format: ms, onChange: (v) => P.filterEnv.release = v }));
      fenv._row.appendChild(_sdMakeKnob({ label: 'Vel→Cut', min: 0, max: 100,  value: P.filterEnv.vel,     step: 1, unit: '%', defaultValue: 0, onChange: (v) => P.filterEnv.vel = v }));
      panes.appendChild(fenv);

      // --- LFOs (×2) ---
      if (!Array.isArray(P.lfos) || P.lfos.length < 2) P.lfos = _sdDesignDefaults().lfos;
      ['LFO 1', 'LFO 2'].forEach((nm, i) => {
        const lf = P.lfos[i]; if (!lf) return;
        const sec = _sdSection(nm, { toggle: { on: !!lf.on, onChange: (on) => lf.on = on } });
        const sw = document.createElement('div'); sw.className = 'sd-select-wrap';
        sw.innerHTML = '<label>Shape</label><select class="sd-select"></select>';
        [['sine', 'Sine'], ['triangle', 'Triangle'], ['sawtooth', 'Sawtooth'], ['square', 'Square'], ['smooth', 'Smooth (rand)'], ['sharp', 'Sharp (S&H)']].forEach(([s, lab]) => {
          const op = document.createElement('option'); op.value = s;
          op.textContent = lab;
          if (lf.shape === s) op.selected = true; sw.querySelector('select').appendChild(op);
        });
        sw.querySelector('select').addEventListener('change', (e) => lf.shape = e.target.value);
        sec._row.appendChild(sw);
        sec._row.appendChild(_sdMakeKnob({ label: 'Rate', min: 0.05, max: 30, value: lf.rateHz, log: true, defaultValue: i ? 0.5 : 5, format: (v) => (v < 1 ? (Math.round(v * 100) / 100) : (Math.round(v * 10) / 10)) + ' Hz', onChange: (v) => lf.rateHz = v }));
        panes.appendChild(sec);
      });

      // --- Env 2 (aux envelope) ---
      if (!P.env2) P.env2 = _sdDesignDefaults().env2;
      const e2 = _sdSection('Env 2 (aux)', { toggle: { on: !!P.env2.on, onChange: (on) => P.env2.on = on } });
      e2._row.appendChild(_sdMakeKnob({ label: 'Attack',  min: 0, max: 4000, value: P.env2.attack,  step: 1, defaultValue: 5,   format: ms, onChange: (v) => P.env2.attack = v }));
      e2._row.appendChild(_sdMakeKnob({ label: 'Decay',   min: 1, max: 4000, value: P.env2.decay,   step: 1, defaultValue: 200, format: ms, onChange: (v) => P.env2.decay = v }));
      e2._row.appendChild(_sdMakeKnob({ label: 'Sustain', min: 0, max: 100,  value: P.env2.sustain, step: 1, unit: '%', defaultValue: 0, onChange: (v) => P.env2.sustain = v }));
      e2._row.appendChild(_sdMakeKnob({ label: 'Release', min: 1, max: 8000, value: P.env2.release, step: 1, defaultValue: 300, format: ms, onChange: (v) => P.env2.release = v }));
      panes.appendChild(e2);

      // --- Macros ---
      if (!Array.isArray(P.macros) || !P.macros.length) P.macros = _sdDesignDefaults().macros;
      const mac = _sdSection('Macros');
      P.macros.forEach((m, i) => {
        mac._row.appendChild(_sdMakeKnob({ label: m.name || ('Macro ' + (i + 1)), min: 0, max: 100, value: m.value, step: 1, unit: '%', defaultValue: 0, onChange: (v) => m.value = v }));
      });
      panes.appendChild(mac);

      // --- Mod matrix ---
      const matSec = document.createElement('div'); matSec.className = 'sd-section';
      const mh = document.createElement('div'); mh.className = 'sd-section-head';
      mh.textContent = 'Mod matrix';
      const hint = document.createElement('span'); hint.className = 'sd-matrix-hint';
      hint.textContent = 'source → destination amount';
      mh.appendChild(hint);
      matSec.appendChild(mh);
      matSec.appendChild(_sdRenderMatrix(P, _sdDestsForSeed(_sdState.baseType)));
      panes.appendChild(matSec);
    }

    function _sdRenderMatrix(P, dests) {
      dests = dests || SD_MOD_DESTS;
      const grid = document.createElement('div'); grid.className = 'sd-matrix';
      grid.style.gridTemplateColumns = '58px repeat(' + dests.length + ', 1fr)';
      const corner = document.createElement('div'); corner.className = 'sd-matrix-corner';
      grid.appendChild(corner);
      dests.forEach(d => {
        const h = document.createElement('div'); h.className = 'sd-matrix-colh'; h.textContent = d.label;
        grid.appendChild(h);
      });
      SD_MOD_SOURCES.forEach(s => {
        const rh = document.createElement('div'); rh.className = 'sd-matrix-rowh'; rh.textContent = s.label;
        grid.appendChild(rh);
        dests.forEach(d => {
          const cell = document.createElement('div'); cell.className = 'sd-matrix-cell';
          cell.appendChild(_sdMakeKnob({
            compact: true, label: '', min: -100, max: 100, step: 1, defaultValue: 0,
            value: _sdMatrixGet(P, s.id, d.id),
            format: (v) => (v > 0 ? '+' : '') + Math.round(v),
            onChange: (v) => _sdMatrixSet(P, s.id, d.id, v),
          }));
          grid.appendChild(cell);
        });
      });
      return grid;
    }

    // Build the params object used to actually sound the patch (base type +
    // amp env + design blocks). Shared by Preview and the resolved voice.
    function _sdPatchPlayParams(state) {
      const P = state.params;
      return Object.assign({}, P, { type: state.baseType });
    }

    // ---- Preview engine (cycling: Note → Scales → Chords → off) -----------
    // Repeated presses of Preview cycle the mode; the Rate knob sets the loop
    // speed (notes/sec). Mode 1 loops the root note, mode 2 walks randomly-
    // chosen scales, mode 3 plays randomly-chosen chords. All read _sdState
    // live, so Surprise-me / knob tweaks are heard on the next tick.
    let _sdPreviewMode = 0;            // 0 idle · 1 note · 2 scales · 3 chords
    let _sdPreviewTimer = null;
    let _sdPreviewRate = 2.5;          // notes per second
    let _sdPreviewOctave = 0;          // octave shift for preview notes (×12 semis)
    let _sdSeq = null, _sdSeqIdx = 0;  // current random scale walk
    const _SD_PREVIEW_LABELS = ['▶ Preview', '● Note', '● Scales', '● Chords'];

    const _sdRand = (a, b) => a + Math.random() * (b - a);
    const _sdRandInt = (a, b) => Math.floor(_sdRand(a, b + 1));
    const _sdRandLog = (a, b) => a * Math.pow(b / a, Math.random());
    const _sdPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const _sdChance = (p) => Math.random() < p;
    const _sdMidiToFreq = (m) => ((typeof masterFreqA === 'number') ? masterFreqA : 440) * Math.pow(2, (m - 69) / 12);

    function _sdPlayPreviewNote(midi, params, dur) {
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      try { if (typeof playNote === 'function') playNote(_sdMidiToFreq(midi), params, dur); } catch (e) {}
    }
    function _sdRandScaleIv() {
      const keys = (typeof SCALES === 'object' && SCALES) ? Object.keys(SCALES).filter(k => Array.isArray(SCALES[k]) && SCALES[k].length >= 3 && SCALES[k].length <= 9) : [];
      if (!keys.length) return [0, 2, 4, 5, 7, 9, 11];
      return SCALES[_sdPick(keys)];
    }
    function _sdPreviewTick() {
      if (!_sdState || !document.getElementById('sd-overlay') || !document.getElementById('sd-overlay').classList.contains('open')) { _sdStopPreview(); return; }
      const dur = Math.max(120, (1000 / _sdPreviewRate) * 0.9);
      const base = _sdPatchPlayParams(_sdState);
      const off = (_sdPreviewOctave | 0) * 12;   // octave shift for preview notes
      if (_sdPreviewMode === 1) {
        _sdPlayPreviewNote(60 + off, base, dur);
      } else if (_sdPreviewMode === 2) {
        if (!_sdSeq || _sdSeqIdx >= _sdSeq.length) {
          const iv = _sdRandScaleIv(); const root = 48 + off + _sdRandInt(0, 12);
          _sdSeq = iv.map(s => root + s).concat([root + 12]); _sdSeqIdx = 0;
        }
        _sdPlayPreviewNote(_sdSeq[_sdSeqIdx++], base, dur);
      } else if (_sdPreviewMode === 3) {
        const forms = (typeof _AMB_CHORD_FORMS !== 'undefined') ? _AMB_CHORD_FORMS : [['maj', 'Major', [0, 4, 7]]];
        const f = _sdPick(forms); const root = 48 + off + _sdRandInt(0, 12);
        (f[2] || [0, 4, 7]).forEach(s => _sdPlayPreviewNote(root + s, base, dur));
      }
    }
    function _sdStopTimer() { if (_sdPreviewTimer) { clearInterval(_sdPreviewTimer); _sdPreviewTimer = null; } }
    function _sdStartPreviewLoop() {
      _sdStopTimer();
      _sdPreviewTick();
      _sdPreviewTimer = setInterval(_sdPreviewTick, Math.max(80, 1000 / _sdPreviewRate));
    }
    function _sdSetPreviewRate(v) {
      _sdPreviewRate = v;
      if (_sdPreviewTimer) { _sdStopTimer(); _sdPreviewTimer = setInterval(_sdPreviewTick, Math.max(80, 1000 / _sdPreviewRate)); }
    }
    function _sdStopPreview() { _sdStopTimer(); _sdPreviewMode = 0; _sdSeq = null; _sdSeqIdx = 0; _sdReflectPreviewBtn(); }
    function _sdCyclePreview() {
      _sdPreviewMode = (_sdPreviewMode + 1) % 4;
      _sdSeq = null; _sdSeqIdx = 0;
      if (_sdPreviewMode === 0) { _sdStopPreview(); return; }
      _sdStartPreviewLoop();
      _sdReflectPreviewBtn();
    }
    function _sdReflectPreviewBtn() {
      const b = document.getElementById('sd-preview');
      if (!b) return;
      b.textContent = _SD_PREVIEW_LABELS[_sdPreviewMode] || _SD_PREVIEW_LABELS[0];
      b.classList.toggle('sd-preview-on', _sdPreviewMode !== 0);
    }

    // ---- Reset: restore every design parameter to the seed's defaults ------
    // Destructive (clears the user's envelope / filter / LFO / matrix edits),
    // so it confirms first. Keeps the chosen seed + the name field. Preview
    // reads _sdState.params live, so the change is heard on the next tick.
    function _sdResetParams() {
      if (!_sdState) return;
      try {
        if (typeof window !== 'undefined' && window.confirm &&
            !window.confirm('Reset all settings to defaults? This clears your current envelope, filter, LFO and matrix edits.')) return;
      } catch (e) {}
      _sdState.params = (typeof _sdNewPatchParams === 'function')
        ? _sdNewPatchParams(_sdState.baseType)
        : Object.assign({ attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0 }, _sdDesignDefaults());
      _sdRenderEditor();   // rebuild knobs to reflect the restored defaults
      try { if (typeof showToast === 'function') showToast('Sound settings reset to defaults'); } catch (e) {}
    }

    // ---- Surprise me: randomize every design parameter --------------------
    function _sdSurprise() {
      if (!_sdState) return;
      const P = _sdState.params;
      P.attack = Math.round(_sdRandLog(1, 600));
      P.decay = Math.round(_sdRandLog(20, 1500));
      P.sustain = _sdRandInt(0, 100);
      P.release = Math.round(_sdRandLog(120, 3000));
      P.volume = _sdRandInt(78, 100);
      P.filter = { on: _sdChance(0.7), type: _sdPick(['lowpass', 'highpass', 'bandpass', 'notch']),
        cutoff: Math.round(_sdRandLog(180, 16000)), q: Math.round(_sdRand(0.5, 12) * 10) / 10, drive: 0 };
      P.filterEnv = { on: _sdChance(0.55), attack: Math.round(_sdRandLog(1, 200)), decay: Math.round(_sdRandLog(40, 1500)),
        sustain: _sdRandInt(0, 80), release: Math.round(_sdRandLog(80, 1500)), amount: _sdRandInt(-100, 100), vel: _sdRandInt(0, 60) };
      P.lfos = [0, 1].map(() => ({ on: _sdChance(0.5), shape: _sdPick(['sine', 'triangle', 'sawtooth', 'square']),
        rateHz: Math.round(_sdRandLog(0.1, 15) * 100) / 100 }));
      P.env2 = { on: _sdChance(0.4), attack: Math.round(_sdRandLog(1, 300)), decay: Math.round(_sdRandLog(40, 1500)),
        sustain: _sdRandInt(0, 80), release: Math.round(_sdRandLog(80, 1500)) };
      P.macros = (P.macros && P.macros.length ? P.macros : _sdDesignDefaults().macros).map((m, i) => ({ name: m.name || ('Macro ' + (i + 1)), value: _sdRandInt(0, 100) }));
      // 1-4 random routings (biased musical: skip cutoff/reso when filter off).
      const srcs = SD_MOD_SOURCES.map(s => s.id);
      const dests = SD_MOD_DESTS.map(d => d.id).filter(d => P.filter.on || (d !== 'cutoff' && d !== 'reso'));
      const mm = []; const n = _sdRandInt(1, 4);
      for (let i = 0; i < n; i++) {
        const src = _sdPick(srcs), dest = _sdPick(dests);
        if (mm.some(r => r.src === src && r.dest === dest)) continue;
        mm.push({ src, dest, amount: _sdRandInt(-90, 90) });
      }
      P.modMatrix = mm;
      _sdRenderEditor();   // rebuild knobs to reflect new values
    }

    function _sdSaveFromEditor() {
      if (!_sdState) return;
      const nameEl = document.getElementById('sd-name');
      const name = (nameEl && nameEl.value || '').trim();
      if (!name) {
        if (nameEl) { nameEl.classList.add('sd-name-err'); nameEl.focus(); }
        try { if (typeof showToast === 'function') showToast('Name your sound first'); } catch (e) {}
        return;
      }
      // Strip the editor-only _seed marker before persisting.
      const params = JSON.parse(JSON.stringify(_sdState.params));
      delete params._seed;
      let patch;
      if (_sdState.editId && userPatches.has(_sdState.editId)) {
        patch = userPatches.get(_sdState.editId);
        patch.name = name.slice(0, 40); patch.baseType = _sdState.baseType; patch.params = params;
        _sdSaveUserPatches();
      } else {
        patch = _sdCreateUserPatch(name, _sdState.baseType, params);
      }
      _sdCloseDesign();
      // Refresh anything that lists tones, and apply the new patch to the grid.
      try { if (typeof populateTonePanel === 'function') populateTonePanel(); } catch (e) {}
      try {
        if (typeof applyToneToAllCells === 'function') applyToneToAllCells('user:' + patch.id);
        else if (typeof setGridTone === 'function') setGridTone('user:' + patch.id);
      } catch (e) {}
      try { if (typeof showToast === 'function') showToast('Saved “' + patch.name + '” to User sounds'); } catch (e) {}
    }

    // Init: load saved patches at startup.
    _sdLoadUserPatches();
    // ---- Factory Tone Presets ------------------------------------------------
    // Named, code-defined Design patches — one per design feature, so every
    // block of the sound engine (filter, filter env, LFO matrix, unison, sub,
    // ring, FM overrides) has a ready-made audition tone in the pickers.
    // Re-registered on every load (factory definitions always win); excluded
    // from localStorage persistence; deleting one just brings it back on reload.
    (function _sdRegisterFactoryPresets() {
      const mk = (id, name, baseType, mod) => {
        const params = _sdNewPatchParams(baseType);
        (function merge(dst, src) {
          Object.keys(src).forEach((k) => {
            if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') merge(dst[k], src[k]);
            else dst[k] = src[k];
          });
        })(params, mod || {});
        userPatches.set(id, { id, name, baseType, params, factory: true });
      };
      mk('f-sweep', 'Sweep Saw', 'sawtooth', {
        attack: 15, decay: 150, sustain: 70, release: 400,
        filter: { on: true, type: 'lowpass', cutoff: 800, q: 4 },
        filterEnv: { on: true, amount: 60, attack: 5, decay: 300, sustain: 30, release: 300 },
      });
      mk('f-wobble', 'Wobble Saw', 'sawtooth', {
        attack: 15, decay: 150, sustain: 70, release: 400,
        filter: { on: true, type: 'lowpass', cutoff: 900, q: 3 },
        lfos: [{ on: true, shape: 'sine', rateHz: 2.5 }, { on: false, shape: 'triangle', rateHz: 0.5 }],
        modMatrix: [{ src: 'lfo1', dest: 'cutoff', amount: 50 }],
      });
      mk('f-drift', 'Drift Saw', 'sawtooth', {
        attack: 30, decay: 200, sustain: 65, release: 600,
        filter: { on: true, type: 'lowpass', cutoff: 1200, q: 2 },
        lfos: [{ on: true, shape: 'smooth', rateHz: 1.5 }, { on: false, shape: 'triangle', rateHz: 0.5 }],
        modMatrix: [{ src: 'lfo1', dest: 'cutoff', amount: 45 }],
      });
      mk('f-super', 'Supersaw', 'sawtooth', {
        attack: 20, decay: 150, sustain: 75, release: 500,
        osc: { unison: 6, spread: 40 },
      });
      mk('f-deep', 'Deep Square', 'square', {
        attack: 10, decay: 180, sustain: 70, release: 350,
        osc: { sub: 70, subShape: 'sine' },
      });
      mk('f-ring', 'Ring Bell', 'sine', {
        attack: 5, decay: 400, sustain: 30, release: 800,
        osc: { ring: 50, ringRatio: 2.5 },
      });
      mk('f-vibra', 'Vibra Sine', 'sine', {
        attack: 40, decay: 150, sustain: 80, release: 500,
        lfos: [{ on: true, shape: 'sine', rateHz: 5.5 }, { on: false, shape: 'triangle', rateHz: 0.5 }],
        modMatrix: [{ src: 'lfo1', dest: 'pitch', amount: 15 }],
      });
      mk('f-trem', 'Tremolo Tri', 'triangle', {
        attack: 25, decay: 150, sustain: 75, release: 450,
        lfos: [{ on: false, shape: 'sine', rateHz: 5 }, { on: true, shape: 'sine', rateHz: 4 }],
        modMatrix: [{ src: 'lfo2', dest: 'amp', amount: 60 }],
      });
      mk('f-swell', 'Swell Filter', 'sawtooth', {
        attack: 200, decay: 200, sustain: 80, release: 700,
        filter: { on: true, type: 'lowpass', cutoff: 400, q: 2 },
        env2: { on: true, attack: 800, decay: 400, sustain: 60, release: 600 },
        modMatrix: [{ src: 'env2', dest: 'cutoff', amount: 70 }],
      });
      mk('f-fmbright', 'FM Bright', 'fm', {
        attack: 10, decay: 200, sustain: 65, release: 450,
        osc: { harmonicity: 5, modIndex: 14 },
      });
    })();
