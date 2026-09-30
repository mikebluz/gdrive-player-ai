// MEASUREMENT — where does a LIVE EDIT's time go, and does it make notes late?
//
// Not a pass/fail gate: a profiler. It plays the project, records a quiet
// baseline, then drives a real slider drag and a real select change while the
// audio is running, and reports:
//
//   · main-thread LONG TASKS (>50ms) — the thing that makes audio slip
//   · per-function time: _normalizeAmbientCfg, persistWorkspaceNow,
//     _ambSyncControls, V2.render, _ambSyncMods, _ambTick
//   · _ambTick INTERVAL JITTER — a skipped tick is a scheduling hole
//   · NOTE LEAD — how far ahead of the audio clock each note was posted.
//     A note posted with lead <= 0 is already late: the core/Tone plays it
//     immediately instead of on its grid position, which is what "slippage"
//     sounds like. This is the number that matters.
//
// Usage:  node test/probe-liveedit-perf.js            (synthetic project)
//         LE_WS=<workspace.json> node test/probe-liveedit-perf.js
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
const WINDOW_MS = Number(process.env.LE_WINDOW || 7000);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const real = process.env.LE_WS && fs.existsSync(process.env.LE_WS)
  ? (JSON.parse(fs.readFileSync(process.env.LE_WS, 'utf8')).keys || {})['bloops-workspace']
  : null;
const WS = JSON.stringify({ version: 1, masterAmbient: { seed: 7, layers: [
  { id: 1, name: 'Pad', on: true, kind: 'live', level: 60, instrument: { voice: 'sample:piano' } },
  { id: 2, name: 'Keys', on: true, kind: 'live', level: 55, instrument: { voice: 'sample:piano' } },
] } });
await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} },
  real || WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(2500);

console.log('\nLive-edit performance' + (real ? '  (real project)' : '  (synthetic project)'));

// ── Install the instruments BEFORE playback ─────────────────────────────────
await page.evaluate(() => {
  document.body.classList.add('view-mix');
  try { _ambInitMaster(); } catch (e) {}
  const M = (window.__LE = {
    fn: {},            // name -> {n, ms, max}
    ticks: [],         // _ambTick wall-clock stamps
    leads: [],         // {lead, at} per scheduled note
    longs: [],         // {start, dur} long tasks
    cancels: [],       // {key, at, lead} per future-voice retraction
    deferred: 0,       // notes that went to the node build queue (see below)
    deferKeys: {},     // …and which layer / voice they belonged to
    t0: performance.now(),
  });
  const rec = (name, ms) => {
    const e = M.fn[name] || (M.fn[name] = { n: 0, ms: 0, max: 0 });
    e.n++; e.ms += ms; if (ms > e.max) e.max = ms;
  };
  // Top-level `function` declarations are properties of `window`, so replacing
  // one replaces the binding every internal caller resolves. (A top-level
  // `const` is script-scoped and NOT patchable — those are left alone.)
  const wrap = (name) => {
    const f = window[name];
    if (typeof f !== 'function') { M.fn[name] = { n: -1, ms: 0, max: 0, missing: true }; return; }
    window[name] = function (...a) {
      const s = performance.now();
      try { return f.apply(this, a); } finally { rec(name, performance.now() - s); }
    };
  };
  ['_normalizeAmbientCfg', 'persistWorkspaceNow', '_ambSyncControls', '_ambSyncMods',
   '_ambRenderMixer', '_ambRenderMonitor', '_ambRenderScheduler', '_ambRenderProgOverview',
   '_ambBuildMod'].forEach(wrap);

  // _ambTick: time it AND record its cadence (a gap is a scheduling hole).
  {
    const f = window._ambTick;
    if (typeof f === 'function') {
      window._ambTick = function (...a) {
        const s = performance.now();
        M.ticks.push(s);
        try { return f.apply(this, a); } finally { rec('_ambTick', performance.now() - s); }
      };
    }
  }
  // V2.render lives on the shared object, not on window.
  try {
    const V = window._v2;
    if (V && typeof V.render === 'function') {
      const f = V.render;
      V.render = function (...a) {
        const s = performance.now();
        try { return f.apply(this, a); } finally { rec('V2.render', performance.now() - s); }
      };
    }
  } catch (e) {}

  // NOTE LEAD — the decisive number. `playNote(freq, params, durMs, startTime)`
  // gets an ABSOLUTE AudioContext time; lead = startTime - now. <= 0 means the
  // note was posted after its own onset and cannot land on the grid.
  {
    const f = window.playNote;
    if (typeof f === 'function') {
      window.playNote = function (freq, params, durationMs, startTime, ...rest) {
        const lead = (typeof startTime === 'number' && window.Tone && Tone.now)
          ? (startTime - Tone.now()) * 1000 : null;
        try { window.__LE._voice = (params && (params.type || params.voice)) || '?'; } catch (e) {}
        const r = f.call(this, freq, params, durationMs, startTime, ...rest);
        // `_ambEmitKey` is stamped by the capture-sink tee INSIDE playNote, so
        // it must be read after calling through (docs/traps-bloom.md).
        try { if (lead !== null) M.leads.push({ lead, at: performance.now(), key: window._ambEmitKey || '?' }); } catch (e) {}
        return r;
      };
    }
  }
  // RE-ANCHORS. A live edit retracts the layer's un-started future so the new
  // setting is heard; `at` is where it cuts. Two things must hold: it must not
  // cut inside the engine's own emit lead (that is the runway), and a drag must
  // coalesce them instead of firing one per input event.
  {
    const f = window.cancelBloomFutureVoices;
    if (typeof f === 'function') {
      window.cancelBloomFutureVoices = function (key, at, ...rest) {
        try {
          M.cancels.push({ key, at: performance.now(),
                           lead: (typeof at === 'number' && window.Tone && Tone.now) ? (at - Tone.now()) * 1000 : null });
        } catch (e) {}
        return f.call(this, key, at, ...rest);
      };
    }
  }
  // CORE vs NODE. A note handed to the WASM core is scheduled on the render
  // thread and CANNOT slip. A node voice is deferred and BUILT later by
  // `_vqPump` on the main thread — if the build misses the note's start time,
  // Tone clamps to `now` and it lands late. So "how much of this project is
  // core-rendered" is the phone's whole exposure to main-thread stalls.
  // `_vqShouldDefer` returning true is the tell: that note went node-side.
  {
    const f = window._vqShouldDefer;
    if (typeof f === 'function') {
      window._vqShouldDefer = function (...a) {
        const r = f.apply(this, a);
        try { M.deferred++;
          if (r) { const k = (window._ambEmitKey || '?') + ' ' + (window.__LE._voice || '?');
                   M.deferKeys[k] = (M.deferKeys[k] || 0) + 1; }
        } catch (e) {}
        return r;
      };
    }
    const g = window._vqPump;
    if (typeof g === 'function') {
      window._vqPump = function (...a) {
        const s = performance.now();
        try { return g.apply(this, a); } finally { rec('_vqPump', performance.now() - s); }
      };
    }
  }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) M.longs.push({ start: e.startTime, dur: e.duration }); })
      .observe({ entryTypes: ['longtask'] });
  } catch (e) {}
});
await zz(800);

const snap = () => page.evaluate(() => {
  const M = window.__LE;
  return { fn: JSON.parse(JSON.stringify(M.fn)), nTicks: M.ticks.length,
           ticks: M.ticks.slice(), leads: M.leads.slice(), longs: M.longs.slice(),
           cancels: M.cancels.slice(), deferred: M.deferred,
           deferKeys: JSON.parse(JSON.stringify(M.deferKeys)) };
});
const mark = async () => { const s = await snap(); return { s, t: Date.now() }; };

const analyse = (a, b, label, wallMs) => {
  const fn = {};
  Object.keys(b.fn).forEach((k) => {
    const x = a.fn[k] || { n: 0, ms: 0, max: 0 }, y = b.fn[k];
    if (y.missing) { fn[k] = { missing: true }; return; }
    fn[k] = { n: y.n - x.n, ms: +(y.ms - x.ms).toFixed(1), max: +y.max.toFixed(1) };
  });
  const ticks = b.ticks.slice(a.nTicks);
  let maxGap = 0, gaps = [];
  for (let i = 1; i < ticks.length; i++) { const g = ticks[i] - ticks[i - 1]; gaps.push(g); if (g > maxGap) maxGap = g; }
  gaps.sort((x, y) => x - y);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const leads = b.leads.slice(a.leads.length);
  const late = leads.filter((l) => l.lead <= 0);
  const tight = leads.filter((l) => l.lead > 0 && l.lead < 20);
  // WHICH layer lost its runway — a collapsed lead on one key is a re-anchor
  // burst on that layer; a collapse across all of them is the tick budget.
  const byKey = {};
  leads.forEach((l) => {
    const k = l.key || '?';
    const e = byKey[k] || (byKey[k] = { n: 0, min: Infinity });
    e.n++; if (l.lead < e.min) e.min = l.lead;
  });
  const worstKeys = Object.entries(byKey).sort((x, y) => x[1].min - y[1].min).slice(0, 4)
    .map(([k, v]) => k + ' min ' + v.min.toFixed(0) + 'ms (' + v.n + ')');
  const nDefer = (b.deferred|0) - (a.deferred|0);
  const cancels = b.cancels.slice(a.cancels.length);
  const shallow = cancels.filter((c) => c.lead !== null && c.lead < 250);
  const longs = b.longs.slice(a.longs.length);
  const longMs = longs.reduce((s, l) => s + l.dur, 0);
  return { label, wallMs, fn, nTicks: ticks.length, medGap: +med.toFixed(1), maxGap: +maxGap.toFixed(1),
           nNotes: leads.length, nLate: late.length, nTight: tight.length,
           minLead: leads.length ? +Math.min(...leads.map((l) => l.lead)).toFixed(1) : null,
           medLead: leads.length ? +leads.map((l) => l.lead).sort((x, y) => x - y)[Math.floor(leads.length / 2)].toFixed(1) : null,
           nLong: longs.length, longMs: +longMs.toFixed(0), worstKeys,
           nCancel: cancels.length, nShallow: shallow.length, nDefer,
           deferKeys: Object.entries(b.deferKeys).map(([k,v])=>k+' ×'+v).slice(0,6),
           minCancelLead: cancels.length ? +Math.min(...cancels.filter((c)=>c.lead!==null).map((c) => c.lead)).toFixed(0) : null,
           worstLong: longs.length ? +Math.max(...longs.map((l) => l.dur)).toFixed(0) : 0 };
};

const report = (r) => {
  console.log('\n  ── ' + r.label + '  (' + r.wallMs + ' ms wall) ──');
  console.log('     ticks ' + r.nTicks + '  median gap ' + r.medGap + ' ms  WORST GAP ' + r.maxGap + ' ms');
  console.log('     notes ' + r.nNotes + '  median lead ' + r.medLead + ' ms  min lead ' + r.minLead + ' ms'
    + '  LATE(<=0) ' + r.nLate + '  tight(<20ms) ' + r.nTight);
  console.log('     notes to the NODE build queue: ' + r.nDefer + ' of ' + r.nNotes
    + (r.nNotes ? '  (' + Math.round(r.nDefer / r.nNotes * 100) + '% exposed to main-thread stalls)' : ''));
  if (r.deferKeys && r.deferKeys.length) console.log('       node-side: ' + r.deferKeys.join('  ·  '));
  console.log('     re-anchors ' + r.nCancel + '  shallowest cut ' + r.minCancelLead + ' ms ahead'
    + (r.nShallow ? '  \u26a0 ' + r.nShallow + ' INSIDE the runway' : ''));
  if (r.worstKeys && r.worstKeys.length) console.log('     tightest runway by layer: ' + r.worstKeys.join('  ·  '));
  console.log('     long tasks ' + r.nLong + '  total ' + r.longMs + ' ms  worst ' + r.worstLong + ' ms');
  const rows = Object.entries(r.fn).filter(([, v]) => !v.missing && v.n > 0)
    .sort((a, b) => b[1].ms - a[1].ms);
  if (rows.length) {
    console.log('     time by function (calls · total ms · worst single call):');
    rows.forEach(([k, v]) => console.log('       ' + k.padEnd(24) + String(v.n).padStart(6)
      + ' · ' + String(v.ms).padStart(8) + ' ms · ' + v.max + ' ms'));
  }
  const miss = Object.entries(r.fn).filter(([, v]) => v.missing).map(([k]) => k);
  if (miss.length) console.log('     (not instrumented: ' + miss.join(', ') + ')');
};

// ── Start playback ──────────────────────────────────────────────────────────
const started = await page.evaluate(async () => {
  try { await Tone.start(); } catch (e) {}
  const btn = document.getElementById('mix-bloom-play-btn') || document.querySelector('[id$="-play-btn"]');
  if (!btn) return 'no play button';
  btn.click();
  await new Promise((r) => setTimeout(r, 2000));
  return (typeof _masterEng !== 'undefined' && _masterEng.timer) ? 'playing' : 'not playing';
});
console.log('  playback: ' + started);

// ── A. Baseline: playing, nobody touching anything ──────────────────────────
let a = await mark();
await zz(WINDOW_MS);
let b = await mark();
report(analyse(a.s, b.s, 'A · BASELINE (playing, no edits)', b.t - a.t));

// ── B. A real slider DRAG on a layer card, while playing ────────────────────
const dragTarget = await page.evaluate(() => {
  // Expand the first v2 card so its controls are reachable, then find a Level
  // slider — the most ordinary live edit there is.
  const card = document.querySelector('.ambient-layer.v2-layer');
  if (!card) return 'no v2 card';
  if (card.classList.contains('collapsed')) {
    const h = card.querySelector('.ambient-layer-head'); if (h) h.click();
  }
  return 'ok';
});
await zz(700);
a = await mark();
const dragged = await page.evaluate(async (ms) => {
  const sl = document.querySelector('.ambient-layer.v2-layer input.ambient-sl')
          || document.querySelector('.ambient-mix-slider');
  if (!sl) return 0;
  const end = performance.now() + ms;
  let n = 0, v = parseInt(sl.value, 10) || 50;
  while (performance.now() < end) {
    v = 20 + ((v + 3) % 60);
    sl.value = String(v);
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    n++;
    await new Promise((r) => setTimeout(r, 40));   // ~25 moves/second, a real drag
  }
  sl.dispatchEvent(new Event('change', { bubbles: true }));
  window.__LE.edit = { path: sl.getAttribute('data-f') || null, value: sl.value, n };
  return n;
}, WINDOW_MS);
b = await mark();
const rb = analyse(a.s, b.s, 'B · SLIDER DRAG while playing (' + dragged + ' input events)', b.t - a.t);
report(rb);

// ── B2. THE EDIT MUST STILL LAND. Coalescing a re-anchor is only correct if
//        the last value the finger left is in the config and was re-anchored.
await zz(400);
const landed = await page.evaluate(() => {
  const e = window.__LE.edit; if (!e || !e.path) return { noEdit: true };
  const card = document.querySelector('.ambient-layer.v2-layer');
  const id = card ? (card.getAttribute('data-v2id') | 0) : 0;
  const L = (_masterEng.getCfg().layers || []).find((x) => (x.id | 0) === id);
  const got = e.path.split('.').reduce((o, k) => (o == null ? o : o[k]), L);
  const cx = window.__LE.cancels.filter((c) => c.key === 'v2:' + id);
  return { path: e.path, wanted: e.value, got: String(got),
           nCancel: cx.length, lastLead: cx.length ? +cx[cx.length - 1].lead.toFixed(0) : null };
});
console.log('\n  ── B2 · did the edit land? ──');
if (landed.noEdit) console.log('     (no data-f slider found to drive)');
else {
  console.log('     ' + landed.path + ': slider left at ' + landed.wanted + ', config holds ' + landed.got
    + (landed.wanted === landed.got ? '  ✓' : '  ✗ MISMATCH'));
  console.log('     re-anchors for that layer: ' + landed.nCancel
    + (landed.lastLead != null ? ', last cut ' + landed.lastLead + ' ms ahead' : '')
    + (landed.nCancel > 0 ? '  ✓' : '  ✗ the edit was never re-anchored'));
}

// ── C. Let the debounced persist land, undisturbed ──────────────────────────
a = await mark();
await zz(2000);
b = await mark();
report(analyse(a.s, b.s, 'C · SETTLE (2s after the drag — the debounced save lands here)', b.t - a.t));

console.log('\n  page errors: ' + (errs.length ? errs.slice(0, 3).join(' | ') : 'none'));
await browser.close();
