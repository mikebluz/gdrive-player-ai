// PROBE — Push/Pull, Drift and ✺ Couple must MOVE a v2 layer.
//
// The bug (found 2026-09-30 while enumerating what moves rhythm): all three are
// applied by `_ambDriftOffset`, which is called from the seven v1 emitters and
// from nothing in 18-layer-v2 — so on a v2 layer they were stored and never
// read. Every control looked live, the store held the value, and the audio was
// identical. It also explains why the ✺ Variation audit could never measure
// Couple: there was nothing to measure.
//
// MEASURED ON LIVE PLAYBACK, not the offline render. The first version of this
// probe bounced the project and compared note lists, and it was wrong twice
// over: comparing two sorted lists index-by-index reported a shift that was
// pure misalignment, and even once matched by nearest time the bounce showed
// a POSITIVE push working while a negative one did nothing — which live
// playback then disproved outright (push -60 moves the onsets 60 ms early,
// measured). The bounce is a two-pass record-then-replay, so it is the wrong
// instrument for "where does this note land".
//
// The measurement is the circular mean of each onset's phase MODULO the step
// period. That compares no lists at all, so a note added or dropped at an edge
// cannot skew it, and the answer is directly the thing being asked: how far off
// its own grid does this layer sit.
//
// THE BOUNCE IS CHECKED TOO, BUT RELATIVE TO THE OTHER LAYER. The capture
// anchors time zero on the FIRST onset, and with a negative push that onset is
// the pushed layer's own — so measured against the bounce's start a negative
// push looks like nothing happened (and the other layer looks pushed LATE).
// That was reported as "a negative push does not survive a bounce"; A − B in
// the captured notes is exactly −60 ms, so it does.
//
// Poison-verified 2026-09-30: `const at = n.at` (the old line) in
// 18-layer-v2's emit fails 6 named checks — both pushes live, both in the
// bounce, % mode, and Couple.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  · ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  · ' + detail : '')); }
};

// Two plain pulse layers on a 2-bar cycle: dense enough to give many onsets,
// simple enough that nothing else moves them.
const WS = JSON.stringify({
  version: 1,
  masterAmbient: {
    seed: 4242, bpm: 120,
    layers: [
      { id: 1, name: 'A', on: true, kind: 'live', level: 60,
        instrument: { voice: 'sine' },
        part: { bars: 2, rhythm: { kind: 'pulse', steps: 8, n: 8 } } },
      { id: 2, name: 'B', on: true, kind: 'live', level: 60,
        instrument: { voice: 'sine' },
        part: { bars: 2, rhythm: { kind: 'pulse', steps: 8, n: 8 } } },
    ],
  },
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} }, WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(2500);

console.log('\n✺ Push / Pull · Drift · Couple on a v2 layer');

const r = await page.evaluate(async () => {
  document.body.classList.add('view-mix');
  try { _ambInitMaster(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));
  try { await Tone.start(); } catch (e) {}
  const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
  if (!E) return { noEngine: true };

  // RE-RESOLVE EVERY TIME. `getCfg()` runs the normalizer, which REPLACES
  // objects — a reference captured before one is an orphan and writes to it
  // never reach the config.
  const L = (id) => ((E.getCfg().layers || []).find((x) => (x.id | 0) === id) || null);
  if (!L(1) || !L(2)) return { noLayers: true, ids: (E.getCfg().layers || []).map((x) => x.id) };

  const cap = { on: false, by: {} };
  {
    const f = window.playNote;
    window.playNote = function (freq, params, durationMs, startTime, ...rest) {
      const rv = f.call(this, freq, params, durationMs, startTime, ...rest);
      try {
        if (cap.on && typeof startTime === 'number') {
          const k = window._ambEmitKey || '?';
          (cap.by[k] = cap.by[k] || []).push(startTime);
        }
      } catch (e) {}
      return rv;
    };
  }
  // 8 steps over 2 bars at 120 bpm = one onset every 0.5 s.
  const STEP = 0.5;
  // Circular mean of (t mod STEP), in ms — no list comparison, so a note added
  // or dropped at an edge cannot skew it.
  const phase = (arr) => {
    if (!arr || arr.length < 4) return null;
    let sx = 0, sy = 0;
    for (const t of arr) {
      const a = 2 * Math.PI * ((((t % STEP) + STEP) % STEP) / STEP);
      sx += Math.cos(a); sy += Math.sin(a);
    }
    let a = Math.atan2(sy / arr.length, sx / arr.length);
    if (a < 0) a += 2 * Math.PI;
    return (a / (2 * Math.PI)) * STEP * 1000;
  };
  // Signed difference between two phases, wrapped into ±half a step.
  const dPhase = (a, b) => {
    if (a == null || b == null) return null;
    let d = b - a; const P = STEP * 1000;
    while (d > P / 2) d -= P;
    while (d < -P / 2) d += P;
    return d;
  };

  const setPush = (v, mode) => {
    const l = L(1); if (l) l.push = v;
    const c = E.getCfg(); c.groove = c.groove || {};
    if (mode) c.groove.pushMode = mode; else delete c.groove.pushMode;
    const l2 = L(1); if (l2) l2.push = v;
    E.getCfg();
  };
  const measure = async () => {
    await new Promise((r) => setTimeout(r, 1800));   // let the committed runway turn over
    cap.on = true; cap.by = {};
    await new Promise((r) => setTimeout(r, 3000));
    cap.on = false;
    return { a: phase(cap.by['v2:1']), b: phase(cap.by['v2:2']), n: (cap.by['v2:1'] || []).length };
  };

  const out = {};
  try { document.getElementById('mix-bloom-play-btn').click(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 2500));

  setPush(0);
  const base = await measure();
  out.n = base.n;
  out.playing = base.n > 0;

  setPush(60);
  const late = await measure();
  out.late = dPhase(base.a, late.a);
  out.other = dPhase(base.b, late.b);

  setPush(-60);
  out.early = dPhase(base.a, (await measure()).a);

  setPush(60);
  { const c = E.getCfg(); c.groove.bypass = true; E.getCfg(); }
  out.bypassed = dPhase(base.a, (await measure()).a);
  { const c = E.getCfg(); c.groove.bypass = false; E.getCfg(); }

  setPush(0);
  out.zero = dPhase(base.a, (await measure()).a);

  // % MODE is a percentage of the layer's CYCLE (2 bars = 4 s here). Before the
  // fix it was a percentage of `_ambEffIntervalSec`'s 0.05 s floor, so 3 %
  // moved the layer 1.5 ms instead of 120.
  setPush(3, 'pct');
  out.pct = dPhase(base.a, (await measure()).a);
  setPush(0);

  // ✺ COUPLE is a live wobble, not a constant: the circular mean barely moves,
  // so measure how far the onsets SCATTER off the grid instead. Couple off
  // must sit on the grid; Couple 100 must not.
  const scatter = (arr) => {
    if (!arr || arr.length < 4) return null;
    let worst = 0;
    for (const t of arr) {
      let d = (((t % STEP) + STEP) % STEP); if (d > STEP / 2) d -= STEP;
      worst = Math.max(worst, Math.abs(d));
    }
    return worst * 1000;
  };
  const capFor = async () => {
    await new Promise((r) => setTimeout(r, 1800));
    cap.on = true; cap.by = {};
    await new Promise((r) => setTimeout(r, 4000));
    cap.on = false;
    return cap.by['v2:1'];
  };
  { const c = E.getCfg(); c.groove = c.groove || {}; c.groove.couple = 0; E.getCfg(); }
  const anchor = (await capFor()) || [];
  // re-reference the grid to this layer's own anchor, so a constant offset is not "scatter"
  const ref = anchor.length ? anchor[0] : 0;
  const rel = (arr) => (arr || []).map((t) => t - ref);
  out.coupleOff = scatter(rel(anchor));
  { const c = E.getCfg(); c.groove.couple = 100; E.getCfg(); }
  out.coupleOn = scatter(rel(await capFor()));
  try { out.couplePer = _ambLayerPeriodSec(E, 'v2:1', L(1), E.getCfg()); } catch (e) { out.couplePer = 'throw ' + e.message; }
  { const c = E.getCfg(); c.groove.couple = 0; E.getCfg(); }

  try { document.getElementById('mix-bloom-play-btn').click(); } catch (e) {}

  // THE BOUNCE: A − B in the captured note list, for ±60.
  for (const p of [60, -60]) {
    setPush(p);
    const capB = _ambCaptureNotesSynthetic(E, 8, 0);
    const by = {}; (capB && capB.notes || []).forEach((n) => { (by[n.key] = by[n.key] || []).push(n.at); });
    out['bounce' + p] = dPhase(phase(by['v2:2']), phase(by['v2:1']));
  }
  setPush(0);
  return out;
});

if (r.noEngine) { ok('the Bloom master engine came up', false); }
else if (r.noLayers) { ok('both test layers loaded', false, 'ids: ' + (r.ids || []).join(',')); }
else {
  const fmt = (v) => (v == null ? 'n/a' : v.toFixed(1) + ' ms');
  const near = (v, want, tol) => v != null && Math.abs(v - want) <= tol;
  ok('the transport actually played', r.playing === true, (r.n | 0) + ' onsets captured on v2:1');
  ok('push = +60 ms moves the layer LATE', near(r.late, 60, 4), fmt(r.late));
  ok('push = -60 ms moves it EARLY', near(r.early, -60, 4), fmt(r.early));
  ok('the other layer does NOT move', near(r.other, 0, 4), fmt(r.other));
  ok('the Groove bypass zeroes it', near(r.bypassed, 0, 4), fmt(r.bypassed));
  ok('back to 0 returns it', near(r.zero, 0, 4), fmt(r.zero));
  ok('the bounce keeps push +60 (A − B)', near(r['bounce60'], 60, 4), fmt(r['bounce60']));
  ok('the bounce keeps push −60 (A − B)', near(r['bounce-60'], -60, 4), fmt(r['bounce-60']));
  ok('push = 3 % (of the 4 s cycle) moves it 120 ms', near(r.pct, 120, 4), fmt(r.pct));
  ok('Couple 0 sits on the grid', r.coupleOff != null && r.coupleOff < 2, fmt(r.coupleOff));
  ok('Couple 100 scatters the onsets off it', r.coupleOn != null && r.coupleOn > 5,
    fmt(r.coupleOn) + ' · period ' + r.couplePer);
}
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
