// BOUNCE PARITY GATE — live playback vs an offline bounce, PER LAYER.
//
// The bounce is a SECOND IMPLEMENTATION of the whole playback path (strips,
// FX, sends, buses, master chain, sample voices) rebuilt on an offline
// context, and every divergence between the two is silent. Golden-render
// covers the Rust core; mod-parity covers the node mod sources; nothing
// covered this, so each divergence could only be found by ear, one at a
// time. That is what this gate replaces.
//
// It meters EACH LAYER separately on both sides — a whole-mix statistic
// cannot see one layer dropping out, which is how a sample-bypassing-strips
// bug survived six rounds of mix measurement.
//
// Needs `npm start` running. Run it ALONE (it records real-time audio).
//   node test/bounce-parity.js            compare and report
//   node test/bounce-parity.js --only=fx  run a subset by name
const PORT = process.env.PORT || 3001;
const URL_ = `http://localhost:${PORT}/bloops.html`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SECS = 8;

// The axes on which the two implementations can disagree. Each entry is a
// project; `layers` are (type, patch) pairs applied to fresh extras.
const MATRIX = [
  { name: 'synth-plain',   layers: [['bass', {}], ['run', {}]] },
  { name: 'synth-spread',  layers: [['bass', { panMode: 'spread', space: 80 }], ['run', { panMode: 'spread', space: 60 }]] },
  { name: 'synth-pan',     layers: [['bass', { panMode: 'pan', space: -70 }], ['run', { panMode: 'pan', space: 70 }]] },
  { name: 'synth-spat',    layers: [['bass', { panMode: 'spread', space: 0, spat: { on: true, steps: 9, width: 60 } }], ['run', {}]] },
  { name: 'sample-plain',  layers: [['bed', { tone: 'sample:piano' }], ['run', { tone: 'sample:leadsquare' }]] },
  { name: 'sample-pan',    layers: [['bed', { tone: 'sample:piano', panMode: 'pan', space: -70 }], ['bed', { tone: 'sample:piano', panMode: 'pan', space: 70 }]] },
  { name: 'sample-chorus', layers: [['run', { tone: 'sample:leadsquare', chorus: { mix: 69 } }], ['bass', {}]] },
  { name: 'sample-dist',   layers: [['bed', { tone: 'sample:piano', dist: { mix: 55 } }], ['bass', {}]] },
  { name: 'sample-delay',  layers: [['bed', { tone: 'sample:piano', delay: { mix: 50, time: 300, feedback: 40 } }], ['bass', {}]] },
  { name: 'fx-phaser',     layers: [['run', { phaser: { mix: 60 } }], ['bass', {}]] },
  { name: 'fx-autopan',    layers: [['run', { autopan: { mix: 60 } }], ['bass', {}]] },
  { name: 'reverb-send',   layers: [['bed', { revSend: 70 }], ['run', { revSend: 50 }]] },
  { name: 'trance-gate',   layers: [['bed', { tg: { on: true, steps: 4, pattern: [1, 0, 1, 0], depth: 100, edge: 2 } }], ['bass', {}]] },
  { name: 'gate-sample',   layers: [['bed', { tone: 'sample:piano', tg: { on: true, steps: 4, pattern: [1, 0, 1, 0], depth: 100, edge: 2 } }], ['bass', {}]] },
  { name: 'level-mixed',   layers: [['bed', { level: 94 }], ['run', { level: 42 }], ['bass', { level: 68 }]] },
  // --- isolation cases for the sample level divergence -----------------
  { name: 'iso-synth',      layers: [['bed', { tone: '', level: 70, panMode: 'spread', space: 0 }]] },
  { name: 'iso-sample',     layers: [['bed', { tone: 'sample:piano', level: 70, panMode: 'spread', space: 0 }]] },
  { name: 'iso-sample-l42', layers: [['bed', { tone: 'sample:piano', level: 42, panMode: 'spread', space: 0 }]] },
  { name: 'iso-sample-l94', layers: [['bed', { tone: 'sample:piano', level: 94, panMode: 'spread', space: 0 }]] },
  { name: 'iso-sample-pan', layers: [['bed', { tone: 'sample:piano', level: 70, panMode: 'pan', space: -70 }]] },
  // A REAL reported project (from ⧉ Copy bounce diagnostic): 5 layers, three
  // of them samples, mixed spread/pan/spatialize, FX on two, under a salted
  // 8-chord progression. This is the shape that broke — kept as a case so it
  // can never silently regress.
  { name: 'reported-project',
    area: { bpm: 132, reverb: { size: 80, damp: 45, type: 'lush' },
            prog: { on: true, chords: 8, salt: { len: 10, colors: 4, scatter: 10 } } },
    layers: [
      ['bass', { tone: 'bass', level: 68, panMode: 'spread', space: 0, spat: { on: true, steps: 9, width: 60 }, revSend: 27 }],
      ['run',  { tone: 'sample:leadsquare', level: 58, panMode: 'spread', space: 63, revSend: 40, chorus: { mix: 69 } }],
      ['bed',  { tone: 'sample:piano', level: 42, panMode: 'pan', space: -70, revSend: 0, dist: { mix: 55 } }],
      ['bed',  { tone: 'sample:piano', level: 94, panMode: 'pan', space: 70, revSend: 22 }],
      ['beat', { tone: '', level: 74, panMode: 'spread', space: 0, spat: { on: true, steps: 9, width: 55 }, revSend: 0, dist: { mix: 26 } }],
    ] },
];

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const cases = only ? MATRIX.filter((m) => m.name.includes(only)) : MATRIX;

(async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 900000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 3500));

  const results = [];
  for (const cs of cases) {
    const r = await page.evaluate(async (cs, SECS) => {
     try {
      await Tone.start();
      const log = [];
      // ---- build the project ------------------------------------------
      const cfg = _masterEng.getCfg();
      cfg.extras = []; cfg.bpm = 120; cfg.seed = 4242;
      ['bed', 'motif', 'texture', 'beat'].forEach((k) => { cfg[k].present = false; });
      cs.layers.forEach(([t]) => { try { _ambAddExtra(_masterEng, t); } catch (e) {} });
      cs.layers.forEach(([, patch], i) => {
        const L = cfg.extras[i]; if (!L) return;
        L.on = true; L.mute = false;
        Object.keys(patch).forEach((k) => { L[k] = patch[k]; });
      });
      cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'minor';
      cfg.reverb = { size: 70, damp: 45, type: 'lush' };
      if (cs.area) {
        if (cs.area.bpm) cfg.bpm = cs.area.bpm;
        if (cs.area.reverb) cfg.reverb = cs.area.reverb;
        if (cs.area.prog) {
          const n = cs.area.prog.chords | 0;
          const roots = [0, 5, 7, 3, 2, 9, 4, 11].slice(0, n || 4);
          cfg.prog = { on: true, name: 'P', chords: roots.map((r) => ({ root: r, intervals: [0, 3, 7] })),
                       salt: cs.area.prog.salt || undefined };
        }
      }
      cfg.fadeInMs = 0; cfg.fadeOutMs = 0;
      _masterEng.getCfg();
      await new Promise((r2) => setTimeout(r2, 900));   // let samples register

      // ---- per-layer meter, identical on both sides -------------------
      const src = 'class PM extends AudioWorkletProcessor{'
        + 'constructor(){super();this.s=0;this.n=0;this.b=0;}'
        + 'process(i){const x=i[0];'
        + 'if(x&&x[0]){const L=x[0],R=x[1]||x[0];'
        + 'for(let k=0;k<L.length;k++){this.s+=L[k]*L[k]+R[k]*R[k];}this.n+=L.length*2;}'
        + 'if(++this.b>=375){this.port.postMessage(this.n?Math.sqrt(this.s/this.n):0);'
        + 'this.s=0;this.n=0;this.b=0;}return true;}}'
        + 'registerProcessor("parity-meter",PM);';
      // Register ONCE for the page: a second registerProcessor under the same
      // name rejects, which surfaced as an opaque SyntaxError on config 2.
      const ac = Tone.getContext().rawContext;
      if (!window.__parityMeterReady) {
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        await ac.audioWorklet.addModule(url);
        window.__parityMeterReady = true;
      }

      // ---- LIVE: meter each layer's own strip output ------------------
      // TWICE. Live re-generates its material every play, so a single live
      // reading is not a measurement — it is one sample of a distribution.
      // Six rounds of this investigation were lost to treating one live number
      // as ground truth, so the gate measures live's OWN SPREAD and only flags
      // a bounce that sits outside it.
      const liveRuns = [];
      for (let pass = 0; pass < 2; pass++) {
      _ambStartGenerator(_masterEng);
      await new Promise((r2) => setTimeout(r2, 500));    // chains built
      const liveRms = {};
      const sink = new Tone.Gain(0); sink.toDestination();
      Object.keys(_masterEng.mod || {}).forEach((k) => {
        const e = _masterEng.mod[k]; if (!e) return;
        try {
          const mn = Tone.getContext().createAudioWorkletNode('parity-meter', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: 'explicit',
          });
          const arr = (liveRms[k] = []);
          mn.port.onmessage = (ev) => { if (typeof ev.data === 'number') arr.push(ev.data); };
          const node = _coreVoices._node && _coreVoices._node();
          if (e.core && Number.isFinite(e.core.slot) && node) Tone.connect(node, mn, e.core.slot, 0);
          else if (e.pan) Tone.connect(e.pan, mn);
          Tone.connect(mn, sink);
        } catch (x) {}
      });
      var chains = Object.keys(_masterEng.mod || {}).map((k) => k + ':' + (_masterEng.mod[k].core ? 'strip' : 'node'));
      // Did LIVE degrade while we measured it? The adaptive voice budget sheds
      // the most-decayed (longest, most sustaining) voices first under render
      // pressure — which is exactly the piano/pad layers — so a "the bounce is
      // hot" reading can be live being quiet. Headless is precisely where this
      // fires, so it must be reported or it will be mistaken for a bounce bug.
      var health = null;
      try { const h = window.__bloomHealthLog || [];
            health = h.length ? { n: h.length, last: h[h.length - 1] } : null; } catch (x) {}
      await new Promise((r2) => setTimeout(r2, SECS * 1000 + 300));
      _ambStopGenerator(_masterEng);
      await new Promise((r2) => setTimeout(r2, 400));
      liveRuns.push(liveRms);
      try { sink.disconnect(); } catch (x) {}
      }

      // ---- BOUNCE the same project ------------------------------------
      const res = await window._bloomBounceOffline(SECS, {});
      return { liveRuns, bounce: res.layerRms || {}, chains, health,
               dropouts: res.dropouts || [], missing: res.missing || [] };
     } catch (err) { return { error: String((err && err.stack) || err).slice(0, 400) }; }
    }, cs, SECS);
    results.push({ name: cs.name, ...r });
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');

  // ---- compare -------------------------------------------------------
  const mean = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const db = (x, y) => 20 * Math.log10(Math.max(1e-9, y) / Math.max(1e-9, x));
  let bad = 0;
  for (const r of results) {
    const rows = [];
    const runs = r.liveRuns || [];
    const keys = Array.from(new Set([].concat(...runs.map((x) => Object.keys(x)), Object.keys(r.bounce))));
    for (const k of keys) {
      const ls = runs.map((x) => mean(x[k])).filter((v) => v > 0);
      const L = mean(ls), B = mean(r.bounce[k]);
      // Live's OWN spread between its two passes, in dB. A bounce inside that
      // spread is indistinguishable from live re-generating its material, and
      // flagging it is how this gate would cry wolf.
      const spread = ls.length > 1 ? Math.abs(db(Math.min(...ls), Math.max(...ls))) : 0;
      const d = db(L, B);
      const silent = (L > 1e-4 && B < L * 0.15);
      // Threshold: 4 dB, or twice live's own spread when that is wider.
      const lim = Math.max(4, spread * 2);
      const flag = silent || Math.abs(d) > lim;
      if (flag) bad++;
      rows.push({ k, L, B, d, flag, silent, spread });
    }
    const ALL = process.argv.includes('--all');
    if (ALL) {
      console.log((rows.some((x) => x.flag) ? '✗ ' : '✓ ') + r.name);
      rows.forEach((x) => console.log('    ' + x.k.padEnd(10)
        + ' live ' + x.L.toFixed(5) + '  bounce ' + x.B.toFixed(5)
        + '  ' + (x.d >= 0 ? '+' : '') + x.d.toFixed(1) + ' dB'
        + '  (live spread ' + x.spread.toFixed(1) + ' dB)' + (x.flag ? '   ←' : '')));
      continue;
    }
    const flagged = rows.filter((x) => x.flag);
    if (flagged.length || r.dropouts.length) {
      console.log('✗ ' + r.name + '   [' + r.chains.join(' ') + ']');
      if (r.health) console.log('    LIVE health while measuring: ' + JSON.stringify(r.health));
      flagged.forEach((x) => console.log('    ' + x.k.padEnd(10)
        + ' live ' + x.L.toFixed(5) + '  bounce ' + x.B.toFixed(5)
        + '  ' + (x.d >= 0 ? '+' : '') + x.d.toFixed(1) + ' dB'
        + '  (live spread ' + x.spread.toFixed(1) + ' dB)'
        + (x.silent ? '   ← ABSENT IN THE BOUNCE' : '')));
      r.dropouts.forEach((d) => console.log('    dropout: ' + d.key
        + (d.inAndOut ? ' cuts in and out' : ' goes silent') + ' at ' + d.quietAt.join('s, ') + 's'));
    } else {
      console.log('✓ ' + r.name);
    }
  }
  console.log('');
  console.log(bad === 0 ? 'BOUNCE PARITY: ✓ every layer matches live'
                        : 'BOUNCE PARITY: ✗ ' + bad + ' layer divergence(s)');
  if (errs.length) console.log('page errors:', errs.slice(0, 4));
  await browser.close();
  process.exit(bad === 0 ? 0 : 1);
})();
