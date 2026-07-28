(function () {
  'use strict';
  // =========================================================================
  // 24-bloom-coldtest.js — PER-LAYER cold-vs-warm playback probe
  // =========================================================================
  // Built for the "Playback hardening" backlog item (docs/bloom-layer-model.md
  // §11): two reports that do NOT reproduce in headless measurement —
  //   A) some layers very quiet on the first press after an idle, normal after
  //      a stop/start;
  //   B) patterns/tones off for a moment then normal.
  //
  // Everything measurable from the master bus came back IDENTICAL cold vs warm
  // (whole-mix RMS to four decimals, levelGain, gate, per-note volume params,
  // watchdog ctRate). The master bus SUMS every layer, so a single quiet layer
  // is invisible in it. This probe therefore taps an analyser onto EACH LAYER's
  // own chain output and records per-layer RMS — the one measurement that can
  // say "the drone came in 12 dB down on the cold press".
  //
  // INERT on load: defines window.__bloomCold and nothing else. It runs the
  // transport itself (no clicking required) and never writes config.
  //
  //   __bloomCold.run()      → cold press, then warm press, then the comparison
  //   __bloomCold.report()   → re-print the last comparison
  //   __bloomCold.dump()     → JSON of the last run, for pasting into a report
  //   __bloomCold.runs       → the raw captures
  //
  // Reading the output: `coldDb` is each layer's level on the cold press
  // relative to the SAME layer on the warm press. 0 dB = identical. A layer
  // several dB down (or silent) on cold is the bug, and names the suspect.
  // =========================================================================

  var SEC = 6;            // record this long after each press
  var WARMUP_GAP = 1.2;   // pause between the cold run and the warm run

  function eng() { try { return _masterEng; } catch (e) { return null; } }
  function ctxOf() {
    try { return Tone.getContext().rawContext; } catch (e) { return null; }
  }
  function layerKeys(E) {
    try { return Object.keys(E.mod || {}).filter(function (k) { return k.indexOf('#dep') < 0; }); }
    catch (e) { return []; }
  }
  // The node carrying a layer's post-level, post-FX signal. `pan` is the layer's
  // output Panner (the one node confirmed to reach the bus in stereo); fall back
  // down the chain for differently-built layers.
  //
  // Each candidate is CHECKED for a real connect(): a chain entry can hold plain
  // config objects alongside audio nodes (dist/delay/chorus are `{}` until their
  // FX is engaged), and a naive `a || b || c` picked one of those and died with
  // "node.connect is not a function". Returns {node, via} so the report can say
  // which point of the chain it measured.
  function tapNode(e) {
    if (!e) return null;
    var order = ['pan', 'gate', 'levelGain', 'vca', 'vcf', 'input'];
    for (var i = 0; i < order.length; i++) {
      var n = e[order[i]];
      if (n && typeof n.connect === 'function') return { node: n, via: order[i] };
    }
    return null;
  }

  // Attach an analyser to every built layer and sample RMS per frame.
  //
  // MUST use Tone.Analyser, not ctx.createAnalyser(): the layer chain is built
  // from Tone nodes, and connecting one to a node created on the RAW context
  // throws InvalidAccessError (cross-context). The first version swallowed that
  // in a catch and silently produced an empty table — so attach failures are
  // now recorded and surfaced rather than hidden.
  function attach(E) {
    var taps = {}, failed = [];
    layerKeys(E).forEach(function (k) {
      var t = tapNode(E.mod[k]);
      if (!t) { failed.push(k + ':no-connectable-node'); return; }
      try {
        var an = new Tone.Analyser('waveform', 1024);
        t.node.connect(an);
        taps[k] = { an: an, node: t.node, via: t.via, rms: [] };
      } catch (e) { failed.push(k + ':' + (e && (e.name + ' ' + e.message) || 'connect-failed')); }
    });
    if (failed.length) console.warn('[coldtest] could not tap: ' + failed.join(', '));
    if (!Object.keys(taps).length) console.warn('[coldtest] NO layers tapped — the table will be empty.');
    return taps;
  }
  function detach(taps) {
    Object.keys(taps || {}).forEach(function (k) {
      try { taps[k].node.disconnect(taps[k].an); } catch (e) {}
      try { taps[k].an.dispose(); } catch (e) {}
    });
  }

  function record(E, taps, t0, done) {
    var ctx = ctxOf();
    var stop = false;
    (function frame() {
      if (stop) return;
      var t = ctx.currentTime;
      Object.keys(taps).forEach(function (k) {
        var T = taps[k];
        try {
          var v = T.an.getValue();
          var s = 0; for (var i = 0; i < v.length; i++) s += v[i] * v[i];
          T.rms.push([+(t - t0).toFixed(3), Math.sqrt(s / v.length)]);
        } catch (e) {}
      });
      if (t - t0 >= SEC) { stop = true; done(); return; }
      requestAnimationFrame(frame);
    })();
  }

  // Mean RMS over the window, ignoring the pre-first-onset silence so a layer
  // that simply STARTS later isn't scored as quiet.
  function level(rows) {
    var live = rows.filter(function (r) { return r[1] > 0.0005; });
    if (!live.length) return 0;
    var s = 0; for (var i = 0; i < live.length; i++) s += live[i][1];
    return s / live.length;
  }
  function firstSound(rows) {
    for (var i = 0; i < rows.length; i++) if (rows[i][1] > 0.002) return rows[i][0];
    return null;
  }
  function db(a, b) {
    if (!(a > 0) || !(b > 0)) return (a > 0) === (b > 0) ? 0 : -99;
    return +(20 * Math.log10(a / b)).toFixed(1);
  }

  function snapshot(E) {
    var out = { cold: !!E._coldStart, coldLeadSetting: null, layers: {} };
    // The CONFIGURED cold lead (what a cold press would use) — not the lead this
    // press actually took; `cold` above says which path was taken.
    try { out.coldLeadSetting = (typeof window.bloomColdLead === 'function') ? window.bloomColdLead() : null; } catch (e) {}
    layerKeys(E).forEach(function (k) {
      var e = E.mod[k]; if (!e) return;
      out.layers[k] = {
        levelGain: (e.levelGain && e.levelGain.gain) ? +e.levelGain.gain.value.toFixed(3) : null,
        gate: (e.gate && e.gate.gain) ? +e.gate.gain.value.toFixed(3) : null,
        core: !!e.core,                       // core strip vs node fallback
        revSend: !!e.revSend,
      };
    });
    return out;
  }

  // MASTER-BUS tap. Under WASM core strips the per-layer Tone chain carries NO
  // signal (the worklet renders and mixes internally), so tapping E.mod[key]
  // reads silence — which is exactly what the first version of this probe did.
  // The only engine-honest way to attribute level per layer is therefore to SOLO
  // each layer and measure the master bus.
  function masterTap() {
    try {
      var an = new Tone.Analyser('waveform', 1024);
      Tone.getDestination().connect(an);
      return an;
    } catch (e) { console.warn('[coldtest] master tap failed: ' + e.message); return null; }
  }
  function masterRelease(an) {
    try { Tone.getDestination().disconnect(an); } catch (e) {}
    try { an.dispose(); } catch (e) {}
  }
  function recordMaster(an, t0, done) {
    var ctx = ctxOf(), rows = [], stop = false;
    (function frame() {
      if (stop) return;
      var t = ctx.currentTime;
      try {
        var v = an.getValue(), s = 0;
        for (var i = 0; i < v.length; i++) s += v[i] * v[i];
        rows.push([+(t - t0).toFixed(3), Math.sqrt(s / v.length)]);
      } catch (e) {}
      if (t - t0 >= SEC) { stop = true; done(rows); return; }
      requestAnimationFrame(frame);
    })();
  }
  // Every layer the mixer lists, with its live cfg object (so `on` can be toggled).
  function layerList() {
    try { return _ambMixerLayers(_masterEng.getCfg()) || []; } catch (e) { return []; }
  }
  // One SOLO press: only `soloKey` audible, everything else off. Restores flags.
  function soloPress(soloKey, forceCold) {
    return new Promise(function (resolve) {
      var E = eng(); if (!E) return resolve(null);
      try { if (E.timer) _ambStopGenerator(E); } catch (e) {}
      setTimeout(function () {
        var list = layerList(), saved = list.map(function (it) { return it.layer.on; });
        list.forEach(function (it) { it.layer.on = (it.key === soloKey); });
        try { _ambColdTestForce(forceCold); } catch (e) {}
        var ctx = ctxOf(), t0 = ctx ? ctx.currentTime : 0;
        var an = masterTap();
        try { _ambStartGenerator(E); } catch (e) {}
        if (!an) { list.forEach(function (it, i) { it.layer.on = saved[i]; }); return resolve(null); }
        recordMaster(an, t0, function (rows) {
          masterRelease(an);
          try { _ambStopGenerator(E); } catch (e) {}
          list.forEach(function (it, i) { it.layer.on = saved[i]; });
          resolve({ mean: +level(rows).toFixed(5), first: firstSound(rows) });
        });
      }, 250);
    });
  }

  // One press: force the cold/warm state, start, record, stop.
  function onePress(forceCold, label) {
    return new Promise(function (resolve) {
      var E = eng(); if (!E) return resolve(null);
      try { if (E.timer) _ambStopGenerator(E); } catch (e) {}
      setTimeout(function () {
        // Force the classification: the cold path keys off time since the last
        // stop, so shove that far into the past (or right up to now) rather than
        // making the operator wait out the real idle threshold.
        try { _ambColdTestForce(forceCold); } catch (e) {}
        var ctx = ctxOf(), t0 = ctx ? ctx.currentTime : 0;
        try { _ambStartGenerator(E); } catch (e) {}
        var taps = attach(E) || {};
        var snap = snapshot(E);
        // notes, so a MISSING layer is distinguishable from a quiet one
        var notes = {};
        var pn = window.playNote;
        window.playNote = function (f, p, d, at) {
          var r = pn.apply(this, arguments);
          try { var k = window._ambEmitKey || '?'; notes[k] = (notes[k] || 0) + 1; } catch (e) {}
          return r;
        };
        record(E, taps, t0, function () {
          window.playNote = pn;
          var res = { label: label, cold: snap.cold, coldLeadSetting: snap.coldLeadSetting, state: snap.layers, notes: notes, rms: {} };
          Object.keys(taps).forEach(function (k) {
            res.rms[k] = { mean: +level(taps[k].rms).toFixed(5), first: firstSound(taps[k].rms), n: taps[k].rms.length, via: taps[k].via };
          });
          detach(taps);
          try { _ambStopGenerator(E); } catch (e) {}
          resolve(res);
        });
      }, 250);
    });
  }

  function compare(cold, warm, solo) {
    if (!cold || !warm) return 'run() first';
    var keys = Object.keys(warm.notes).concat(Object.keys(cold.notes))
      .filter(function (k, i, a) { return k !== '?' && a.indexOf(k) === i; }).sort();
    var lines = [];
    lines.push('PASS 1 — full mix (realistic DSP load): did every layer EMIT?');
    lines.push('  layer            coldNotes  warmNotes   verdict');
    var suspects = [];
    keys.forEach(function (k) {
      var cn = cold.notes[k] || 0, wn = warm.notes[k] || 0;
      var verdict = (wn > 0 && cn === 0) ? 'NO NOTES on the cold press'
        : (wn > 0 && cn < wn * 0.5) ? 'cold emitted ' + Math.round(100 * cn / wn) + '% of warm'
        : 'ok';
      if (verdict !== 'ok') suspects.push(k + ' — ' + verdict);
      lines.push('  ' + k.padEnd(15) + String(cn).padStart(9) + String(wn).padStart(11) + '   ' + verdict);
    });
    if (solo && Object.keys(solo).length) {
      lines.push('');
      lines.push('PASS 2 — solo per layer (level attribution; master bus, real engine):');
      lines.push('  layer            coldRMS    warmRMS    coldDb   firstSound c/w');
      keys.forEach(function (k) {
        var e = solo[k]; if (!e || !e.cold || !e.warm) return;
        var d = db(e.cold.mean, e.warm.mean);
        // Flag EITHER direction: a cold press 20 dB loud is as wrong as one 20 dB
        // quiet, and only checking "quieter" let a planted fault through in
        // testing. The reported symptom is quiet, but the rule shouldn't assume it.
        if (Math.abs(d) >= 3) suspects.push(k + ' — ' + Math.abs(d) + ' dB ' + (d < 0 ? 'QUIETER' : 'LOUDER') + ' on the cold press');
        lines.push('  ' + k.padEnd(15) + String(e.cold.mean).padStart(9) + String(e.warm.mean).padStart(11) +
          String(d).padStart(10) + ('   ' + (e.cold.first == null ? '-' : e.cold.first) + ' / ' + (e.warm.first == null ? '-' : e.warm.first)));
      });
      lines.push('  (soloing lowers DSP load, so a load-dependent fault may not show here —');
      lines.push('   PASS 1 runs at full load and is the one to trust for "did it play at all".)');
    }
    lines.push('');
    lines.push('cold press: coldStart=' + cold.cold + '   warm press: coldStart=' + warm.cold + '   (cold lead setting ' + cold.coldLeadSetting + 's)');
    var eng0 = Object.keys(warm.state)[0];
    lines.push('engine: ' + ((warm.state[eng0] && warm.state[eng0].core) ? 'WASM core strips' : 'Tone node fallback'));
    lines.push(suspects.length ? '>>> SUSPECTS: ' + suspects.join('; ')
      : '>>> nothing anomalous this run (every layer emitted; no layer off by 3 dB or more on cold)');
    return lines.join('\n');
  }

  var runs = { cold: null, warm: null, solo: {}, text: '' };

  function run(opts) {
    var E = eng();
    if (!E) { console.warn('[coldtest] no master engine'); return; }
    var doSolo = !(opts && opts.solo === false);
    var list = layerList();
    if (!list.length) { console.warn('[coldtest] no layers in this area'); return; }
    var est = (2 + (doSolo ? list.length * 2 : 0)) * (SEC + 1.5);
    console.log('[coldtest] ~' + Math.round(est) + 's: full-mix cold/warm' + (doSolo ? ' + solo sweep of ' + list.length + ' layers' : '') + ' — leave it alone until it prints.');
    return onePress(true, 'cold').then(function (c) {
      runs.cold = c;
      return new Promise(function (r) { setTimeout(r, WARMUP_GAP * 1000); });
    }).then(function () {
      return onePress(false, 'warm');
    }).then(function (w) {
      runs.warm = w; runs.solo = {};
      if (!doSolo) return null;
      // sequential solo passes: cold then warm for each layer
      return list.reduce(function (chain, it) {
        return chain.then(function () {
          console.log('[coldtest]   solo ' + it.key + ' …');
          return soloPress(it.key, true).then(function (c2) {
            return soloPress(it.key, false).then(function (w2) {
              runs.solo[it.key] = { cold: c2, warm: w2 };
            });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      runs.text = compare(runs.cold, runs.warm, runs.solo);
      console.log('\n' + runs.text + '\n');
      console.log('[coldtest] __bloomCold.dump() for a pasteable JSON report.');
      return runs.text;
    });
  }
  function layerKeysReady(E) { try { return layerKeys(E).length > 0; } catch (e) { return false; } }

  window.__bloomCold = {
    run: run,
    report: function () { console.log('\n' + (runs.text || 'run() first') + '\n'); return runs.text; },
    dump: function () { return JSON.stringify(runs, null, 1); },
    runs: runs,
    get SEC() { return SEC; },
    set SEC(v) { SEC = Math.max(1, Math.min(30, +v || 6)); },
  };
})();
