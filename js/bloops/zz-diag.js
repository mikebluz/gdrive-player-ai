// ===== TEMP DIAGNOSTIC — safe to delete. Catches scheduler/playNote errors
// and reports whether the scheduler loop is still alive. =====
(function () {
  // Catch ANY uncaught error (e.g. a throw inside schedulerTick that stops
  // the loop) with full detail.
  window.addEventListener('error', function (e) {
    console.log('[DIAG] !!! UNCAUGHT ERROR: ' + (e.message || e.error) +
      '  @ ' + (e.filename || '?') + ':' + (e.lineno || '?') +
      (e.error && e.error.stack ? '\n' + e.error.stack.split('\n').slice(0, 4).join('\n') : ''));
  });
  function logLaneSounds() {
    try {
      if (typeof lanes === 'undefined' || !Array.isArray(lanes)) return;
      lanes.forEach(function (lane, i) {
        if (!lane || !Array.isArray(lane.steps)) return;
        var counts = {};
        lane.steps.forEach(function (s) {
          if (!s) return;
          var voices = Array.isArray(s.chord) ? s.chord : [s];
          voices.forEach(function (v) {
            var t = (v && v.sound) || (v && v.params && v.params.type) || (s.sound) || 'rest';
            counts[t] = (counts[t] || 0) + 1;
          });
        });
        var parts = Object.keys(counts).map(function (t) {
          var loaded = '';
          if (t.indexOf('sample:') === 0 && typeof sampleSamplers !== 'undefined') {
            var info = sampleSamplers.get(t.slice(7));
            loaded = info && info.sampler ? (info.sampler.loaded ? ' [LOADED]' : ' [NOT-LOADED]') : ' [MISSING]';
          }
          return t + '×' + counts[t] + loaded;
        });
        console.log('[DIAG] lane ' + i + ': ' + (parts.join(', ') || 'empty'));
        // Feature scan — what's special about these steps (so it can be replicated).
        var feat = {};
        lane.steps.forEach(function (s) {
          if (!s) return;
          if (Array.isArray(s.chord)) feat.chord = (feat.chord || 0) + 1;
          if (s.duration && s.duration !== 1) feat['dur=' + s.duration] = (feat['dur=' + s.duration] || 0) + 1;
          if (s.subdivision != null && s.subdivision !== 0.5) feat['sub=' + s.subdivision] = (feat['sub=' + s.subdivision] || 0) + 1;
          if (s.ratchet) feat.ratchet = (feat.ratchet || 0) + 1;
          if (s.cond) feat['cond=' + s.cond] = (feat['cond=' + s.cond] || 0) + 1;
          if (Number.isFinite(s.prob) && s.prob < 100) feat.prob = (feat.prob || 0) + 1;
          if (Number.isFinite(s.slip) && s.slip) feat.slip = (feat.slip || 0) + 1;
          if (s.bend) feat.bend = (feat.bend || 0) + 1;
          if (s.variants || s.variance) feat.variance = (feat.variance || 0) + 1;
          if (s.isSub || (Array.isArray(s.subSteps) && s.subSteps.length)) feat.subSteps = (feat.subSteps || 0) + 1;
          if (s.params && s.params.glide) feat.glide = (feat.glide || 0) + 1;
          if (s._off) feat.bypass = (feat.bypass || 0) + 1;
        });
        var fk = Object.keys(feat);
        if (fk.length) console.log('[DIAG]   lane ' + i + ' features: ' + fk.map(function (k) { return k + '×' + feat[k]; }).join(', '));
      });
    } catch (e) { console.log('[DIAG] lane-scan error', e); }
  }
  function start() {
    if (typeof Tone === 'undefined' || !Tone.getContext || !Tone.getContext().rawContext) {
      setTimeout(start, 500);
      return;
    }
    var ac = Tone.getContext().rawContext;
    var pn = 0, pnThrows = 0, lastThrow = '';
    if (typeof window.playNote === 'function' && !window.__diagWrapped) {
      var orig = window.playNote;
      window.playNote = function () {
        pn++;
        try { return orig.apply(this, arguments); }
        catch (e) { pnThrows++; lastThrow = (e && e.message) || String(e); console.log('[DIAG] !!! playNote threw: ' + lastThrow + (e && e.stack ? '\n' + e.stack.split('\n').slice(0,4).join('\n') : '')); throw e; }
      };
      window.__diagWrapped = true;
    }
    var an = ac.createAnalyser();
    an.fftSize = 2048;
    try { Tone.getDestination().connect(an); } catch (e) {}
    var buf = new Float32Array(an.fftSize);
    var last = 0, loggedSounds = false;
    setInterval(function () {
      an.getFloatTimeDomainData(buf);
      var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      var rms = Math.sqrt(s / buf.length);
      if (!loggedSounds && pn > 0) { loggedSounds = true; logLaneSounds(); }
      var sched = 'n/a';
      try { sched = (typeof sequenceTimer === 'undefined') ? 'n/a' : (sequenceTimer === null ? 'STOPPED' : 'alive'); } catch (e) { sched = 'n/a'; }
      console.log('[DIAG] ctx=' + ac.state + ' rms=' + rms.toFixed(3) +
        ' playNote=' + pn + ' (+' + (pn - last) + ')' +
        ' sched=' + sched + (pnThrows ? ' THROWS=' + pnThrows : ''));
      last = pn;
    }, 500);
    console.log('[DIAG] running — press Play, let it run ~12s, paste everything (esp. lines with !!!).');
  }
  start();
})();
