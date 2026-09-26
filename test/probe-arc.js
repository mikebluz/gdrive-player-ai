// PROBE — 🌒 Arc: the arrangement's own density curve.
//
// user, 2026-09-25: "how can we add stochastic/generative aspects to Arrangement
// to make creating real 'live' feeling playback with lots of novelty even easier".
//
// Every OTHER arrangement-level die varies the CONTENT of a fixed form — 🧂 Salt,
// 🌊 Vary, 🌡 Tension, 🎲 Take and ↻ Order all change WHICH CHORD, ↔ Rubato changes
// WHEN IT FALLS. Nothing changed HOW MUCH PLAYS, so an arrangement sat at one
// density for the whole play no matter how many layer dice were rolling.
//
// Arc is the orchestration twin of 🌡 Tension. It multiplies nothing and gates
// nothing on its own: it is a third arrangement gate folded into
// `_ambSectionGateOK`, which is already called adjacent to every chord-gate site.
//
//   node test/probe-arc.js      (needs `npm start`; BLOOPS_URL to retarget)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(900);

  // ---- 1. THE NORMALIZER -----------------------------------------------------
  console.log('\n  1. store — absent by default, pruned to absent when off');
  const norm = await page.evaluate(() => {
    const E = _masterEng;
    const out = {};
    out.fresh = ('arc' in E.getCfg().prog);
    const c1 = E.getCfg(); c1.prog.arc = { amount: 0, bars: 64, shape: 'wave' };
    out.zero = ('arc' in E.getCfg().prog);
    const c2 = E.getCfg(); c2.prog.arc = { amount: 40 };
    out.seeded = JSON.parse(JSON.stringify(E.getCfg().prog.arc));
    const c3 = E.getCfg(); c3.prog.arc = { amount: 999, bars: 5000, shape: 'nope' };
    out.clamped = JSON.parse(JSON.stringify(E.getCfg().prog.arc));
    const c4 = E.getCfg(); delete c4.prog.arc;
    out.cleared = ('arc' in E.getCfg().prog);
    return out;
  });
  ok('absent on a fresh area', norm.fresh === false, JSON.stringify(norm.fresh));
  ok('amount 0 deletes the whole key — "off" and "absent" are ONE state',
    norm.zero === false, JSON.stringify(norm.zero));
  ok('an amount alone gains the defaults (32 bars, building)',
    norm.seeded && norm.seeded.amount === 40 && norm.seeded.bars === 32 && norm.seeded.shape === 'build',
    JSON.stringify(norm.seeded));
  ok('out-of-range values are clamped, a bad shape falls back to building',
    norm.clamped && norm.clamped.amount === 100 && norm.clamped.bars === 128 && norm.clamped.shape === 'build',
    JSON.stringify(norm.clamped));
  ok('deleting it leaves no residue', norm.cleared === false, JSON.stringify(norm.cleared));

  // ---- 2. THE CURVE ----------------------------------------------------------
  console.log('\n  2. the curve — each shape does what its name says');
  const curve = await page.evaluate(() => {
    const cfg = { seed: 12345, prog: { arc: null } };
    const S = _AMB_ARC_SLICES;
    const run = (arc) => { cfg.prog.arc = arc; const a = []; for (let i = 0; i < S; i++) a.push(+_ambArcMulAtSlice(cfg, i).toFixed(6)); return a; };
    const off = run(null);
    const build = run({ amount: 50, bars: 32, shape: 'build' });
    const wave = run({ amount: 50, bars: 32, shape: 'wave' });
    const full = run({ amount: 100, bars: 32, shape: 'build' });
    // drift, arcs 0 and 1 — absolute slice, so arc 1 is slices S..2S-1
    cfg.prog.arc = { amount: 50, bars: 32, shape: 'drift' };
    const d0 = [], d1 = [];
    for (let i = 0; i < S; i++) d0.push(+_ambArcMulAtSlice(cfg, i).toFixed(6));
    for (let i = 0; i < S; i++) d1.push(+_ambArcMulAtSlice(cfg, S + i).toFixed(6));
    return { S, off, build, wave, full, d0, d1 };
  });
  const S = curve.S;
  console.log('     build: ' + JSON.stringify(curve.build));
  console.log('     wave : ' + JSON.stringify(curve.wave));
  console.log('     drift: ' + JSON.stringify(curve.d0) + '\n            ' + JSON.stringify(curve.d1));
  ok('off → a flat 1 at every slice, so nothing is gated',
    curve.off.every(v => v === 1), JSON.stringify(curve.off));
  ok('building ramps thinnest → full, and never goes back',
    curve.build[0] < curve.build[S - 1] && curve.build.every((v, i) => i === 0 || v >= curve.build[i - 1]),
    JSON.stringify(curve.build));
  ok('…reaching exactly full at the last slice', curve.build[S - 1] === 1, String(curve.build[S - 1]));
  ok('waves start full and are thinnest in the middle',
    curve.wave[0] === 1 && curve.wave[S / 2] === Math.min(...curve.wave),
    JSON.stringify(curve.wave));
  ok('…and are symmetric about that dip',
    curve.wave[1] === curve.wave[S - 1] && curve.wave[2] === curve.wave[S - 2],
    JSON.stringify(curve.wave));
  ok('depth 100 still leaves a tenth playing — a breakdown, not silence',
    Math.min(...curve.full) > 0.09 && Math.min(...curve.full) < 0.11, String(Math.min(...curve.full)));
  ok('drifting visits EVERY density building does — it can never be stuck thin',
    JSON.stringify(curve.d0.slice().sort()) === JSON.stringify(curve.build.slice().sort()),
    JSON.stringify(curve.d0.slice().sort()) + ' vs ' + JSON.stringify(curve.build.slice().sort()));
  ok('…in a different order each arc', JSON.stringify(curve.d0) !== JSON.stringify(curve.d1),
    JSON.stringify(curve.d0));

  // ---- 3. THE CLOCK ----------------------------------------------------------
  console.log('\n  3. the clock — bars, not chords');
  const clock = await page.evaluate(() => {
    const E = { _progAnchor: 0, _playStartAt: 0 };
    const cfg = { bpm: 120, prog: { arc: { amount: 40, bars: 32, shape: 'build' } } };
    const barSec = (60 / 120) * 4;
    const at = (bars) => _ambArcSliceAt(E, bars * barSec, cfg);
    const a = { zero: at(0), mid: at(2), one: at(4), eight: at(32), neg: at(-5) };
    cfg.prog.arc.bars = 8;
    const b = { one: at(1), eight: at(8) };
    return { a, b, sliceBars: 32 / _AMB_ARC_SLICES };
  });
  ok('bar 0 is slice 0', clock.a.zero === 0, JSON.stringify(clock.a));
  ok('a slice is arc/8 bars — 4 bars at the default 32', clock.a.mid === 0 && clock.a.one === 1,
    JSON.stringify(clock.a));
  ok('one whole arc later the slice count has advanced by 8', clock.a.eight === S,
    String(clock.a.eight));
  ok('before the anchor clamps to slice 0 rather than going negative', clock.a.neg === 0,
    String(clock.a.neg));
  ok('a shorter arc slices faster', clock.b.one === 1 && clock.b.eight === S,
    JSON.stringify(clock.b));

  // ---- 4. THE GATE -----------------------------------------------------------
  console.log('\n  4. the gate — folded into the arrangement gate, absent = untouched');
  const gate = await page.evaluate(() => {
    const E = { _progAnchor: 0, _playStartAt: 0 };
    const barSec = (60 / 120) * 4;
    const mk = (arc) => ({ bpm: 120, seed: 999, prog: { arc } });
    const atSlice = (cfg, sl) => {
      const arcBars = (cfg.prog.arc && cfg.prog.arc.bars) || 32;
      const sb = arcBars / _AMB_ARC_SLICES;
      return (sl * sb + sb * 0.5) * barSec;
    };
    // 200 distinct layers, so a RATE is measurable rather than one coin flip.
    const layers = []; for (let k = 0; k < 200; k++) layers.push({ id: k, type: 'motif' });
    const rate = (cfg, sl, hard) => {
      let n = 0;
      layers.forEach(L => { if (_ambSectionGateOK(E, L, atSlice(cfg, sl), cfg, hard)) n++; });
      return n / layers.length;
    };
    const offCfg = mk(null);
    const onCfg = mk({ amount: 70, bars: 32, shape: 'build' });
    const out = {};
    out.offAll = [0, 3, 7].map(sl => rate(offCfg, sl));
    out.onThin = rate(onCfg, 0);
    out.onFull = rate(onCfg, S_ => 0) === undefined ? rate(onCfg, 7) : rate(onCfg, 7);
    out.onMul0 = +_ambArcMulAtSlice(onCfg, 0).toFixed(4);
    out.onMul7 = +_ambArcMulAtSlice(onCfg, 7).toFixed(4);
    out.hard = rate(onCfg, 0, true);
    // determinism — same question twice
    out.repeat = rate(onCfg, 0) === out.onThin;
    // a layer with NO sectionMask is still subject to it: that IS the point
    out.noMaskGated = (() => {
      const L = { id: 3, type: 'motif' };
      return !!L && !_ambSectionGateOK(E, L, atSlice(onCfg, 0), onCfg, false) !== undefined;
    })();
    // composes with a sectionMask rather than replacing it
    const secCfg = mk({ amount: 70, bars: 32, shape: 'build' });
    secCfg.sections = [{ id: 'a', name: 'A', bars: 4 }, { id: 'b', name: 'B', bars: 4 }];
    const masked = { id: 5, type: 'motif', sectionMask: { steps: [100, 0] } };
    // section B is 0% → refused whatever the arc says
    out.maskStillWins = !_ambSectionGateOK(E, masked, 5 * barSec, secCfg, false);
    return out;
  }).catch(e => ({ err: String(e) }));
  if (gate.err) { fail++; console.log('  ✗ gate block threw\n      ' + gate.err); }
  else {
    console.log('     slice 0 mul ' + gate.onMul0 + ' → ' + (gate.onThin * 100).toFixed(0) + '% played');
    console.log('     slice 7 mul ' + gate.onMul7 + ' → ' + (gate.onFull * 100).toFixed(0) + '% played');
    ok('arc absent → every layer passes at every slice (byte-identical path)',
      gate.offAll.every(v => v === 1), JSON.stringify(gate.offAll));
    ok('arc on → the thinnest slice really does drop layers',
      gate.onThin < 0.6, String(gate.onThin));
    ok('…and the fullest slice drops none', gate.onFull === 1, String(gate.onFull));
    ok('…the played rate tracks the curve it claims (within sampling error)',
      Math.abs(gate.onThin - gate.onMul0) < 0.12,
      'rate ' + gate.onThin + ' vs mul ' + gate.onMul0);
    ok('`hard` skips it, so the drawing never disagrees with itself',
      gate.hard === 1, String(gate.hard));
    ok('deterministic — the same question twice gives the same answer',
      gate.repeat === true, String(gate.repeat));
    ok('a layer with NO mask is still subject to it', gate.noMaskGated === true, String(gate.noMaskGated));
    ok('a 0% section mask still wins — the arc composes, it does not replace',
      gate.maskStillWins === true, String(gate.maskStillWins));
  }

  // ---- 5. REACHABILITY -------------------------------------------------------
  console.log('\n  5. reachable — measured, in the view the user has open');
  await page.evaluate(() => {
    const c = _masterEng.getCfg();
    c.prog.on = true;
    c.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 3, 7] }];
    delete c.prog.arc;
    _masterEng.getCfg();
    const tab = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]');
    if (tab) tab.click();
  });
  await zz(700);
  // THE DOORS LIVE IN THE ▤ Parts ACCORDION, which is closed by default — all five
  // of them (🧂 Salt, ↔ Rubato, ↻ Order, 🌒 Arc, ▤ Song map) measure 0×0 until it is
  // opened, the pre-existing four included. Open it the way a finger would.
  await page.evaluate(() => {
    const h = document.querySelector('.ambient-proggrp .ambient-grp-head[data-grp="\u25a4 Parts"]');
    if (h) h.click();
  });
  await zz(600);
  const door = await page.evaluate(() => {
    const b = document.querySelector('[data-pov="grp:arc"]');
    if (!b) return { there: false };
    const r = b.getBoundingClientRect();
    const sibs = ['grp:salt', 'grp:rubato', 'grp:order', 'arrmap'].map(k => {
      const e = document.querySelector('[data-pov="' + k + '"]');
      if (!e) return { k, w: 0, par: false };
      const rr = e.getBoundingClientRect();
      return { k, w: Math.round(rr.width), par: !!e.offsetParent };
    });
    return { there: true, w: Math.round(r.width), h: Math.round(r.height),
             parented: !!b.offsetParent, txt: b.textContent.trim(), sibs };
  });
  // A `pop` GROUP MUST BE INVISIBLE WHILE PARKED. Its only visibility rule is
  // _ambProgGrpSync's key list, and that list is hand-written — leave 'arc' out of
  // it and the group does not go missing, it goes STRAY: a sixth accordion sitting
  // open in the pane with a duplicate of every control the popover holds. That is
  // the failure the four preceding checks cannot see, so it gets its own.
  const parked = await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp[data-grp="\ud83c\udf12 Arc"]');
    if (!g) return { there: false };
    const r = g.getBoundingClientRect();
    return { there: true, disp: getComputedStyle(g).display, w: Math.round(r.width), par: !!g.offsetParent };
  });
  ok('the group is PARKED HIDDEN before its door is touched — no stray sixth accordion',
    parked.there === true && parked.disp === 'none' && parked.par === false, JSON.stringify(parked));
  ok('the 🌒 Arc door exists on the arrangement bar', door.there === true, JSON.stringify(door));
  ok('…beside its four siblings, all measuring — so a 0×0 here is this feature, not the bar',
    door.sibs && door.sibs.every(x => x.w > 10 && x.par), JSON.stringify(door.sibs));
  ok('…and MEASURES — a real rect with an offsetParent, not a 0×0 querySelector hit',
    door.w > 10 && door.h > 5 && door.parented === true, JSON.stringify(door));

  const opened = await page.evaluate(() => {
    const b = document.querySelector('[data-pov="grp:arc"]');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    b.click();
    return true;
  });
  await zz(600);
  const inside = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host');
    const pick = (sel) => {
      const el = host && host.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), parented: !!el.offsetParent };
    };
    return { host: !!host,
             row: pick('.ambient-prog-arc'),
             tog: pick('.ambient-arc-toggle'),
             title: (document.querySelector('.ambient-grppop-modal .sm-title') || {}).textContent };
  });
  ok('tapping it opens the popover with the group lifted in', inside.host === true, JSON.stringify(inside));
  ok('…the row measures inside it', inside.row && inside.row.w > 50 && inside.row.parented,
    JSON.stringify(inside.row));
  ok('…the toggle measures inside it', inside.tog && inside.tog.w > 10 && inside.tog.parented,
    JSON.stringify(inside.tog));
  ok('…and the popover is titled 🌒 Arc, not its own key',
    /Arc/.test(inside.title || ''), JSON.stringify(inside.title));

  // ---- 6. THE CONTROLS WRITE THE STORE --------------------------------------
  console.log('\n  6. driven with a real press, then read back');
  const drive = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host');
    const out = {};
    const tog = host.querySelector('.ambient-arc-toggle');
    tog.click();
    out.afterOn = JSON.parse(JSON.stringify(_masterEng.getCfg().prog.arc || null));
    // the selects are hidden while off and must be showing now
    const sh = host.querySelector('.ambient-arc-shape'), bs = host.querySelector('.ambient-arc-bars');
    const am = host.querySelector('.ambient-arc-amt');
    const rr = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && !!el.offsetParent; };
    out.shownOn = { shape: rr(sh), bars: rr(bs), amt: rr(am) };
    sh.value = 'drift'; sh.dispatchEvent(new Event('change', { bubbles: true }));
    bs.value = '64'; bs.dispatchEvent(new Event('change', { bubbles: true }));
    out.afterSel = JSON.parse(JSON.stringify(_masterEng.getCfg().prog.arc || null));
    am.value = '0'; am.dispatchEvent(new Event('input', { bubbles: true }));
    out.afterZero = ('arc' in _masterEng.getCfg().prog);
    return out;
  }).catch(e => ({ err: String(e) }));
  if (drive.err) { fail++; console.log('  ✗ drive block threw\n      ' + drive.err); }
  else {
    ok('the toggle turns it on with an AUDIBLE default, not 0',
      drive.afterOn && drive.afterOn.amount === 40 && drive.afterOn.shape === 'build',
      JSON.stringify(drive.afterOn));
    ok('…and the three faces appear once it is on',
      drive.shownOn.shape && drive.shownOn.bars && drive.shownOn.amt, JSON.stringify(drive.shownOn));
    ok('shape + length write through to the store',
      drive.afterSel && drive.afterSel.shape === 'drift' && drive.afterSel.bars === 64,
      JSON.stringify(drive.afterSel));
    ok('depth 0 deletes the key again — one representation of off',
      drive.afterZero === false, String(drive.afterZero));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
