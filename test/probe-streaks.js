// PROBE — ✺ STREAKS: NOTES AND RESTS IN RUNS, NOT SPRINKLED.
//
// The rest check is an i.i.d. coin flip per slot, so a high Sparse reads as random
// dropout rather than as phrasing — a sequence of independent decisions has no shape.
// Streaks makes it self-exciting: a sounding note raises a per-layer EXCITATION that
// decays per slot, and the rest threshold moves against the deviation of that
// excitation from its OWN slow average.
//
// The three claims worth pinning are the model's, not the wiring's:
//   · 0 is exactly the old threshold   — absent must be byte-identical (golden-render)
//   · it CLUSTERS                      — lag-1 autocorrelation of the fire sequence > 0
//   · it is NOT a density control      — self-centring, so the rest RATE barely moves
//
//   node test/probe-streaks.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(1200);

  console.log('\n  ✺ absent is the old behaviour');
  const off = await page.evaluate(() => {
    const E = _masterEng; const c = E.getCfg();
    if (!c.groove) c.groove = {};
    delete c.groove.streak; E.getCfg();
    return { stored: E.getCfg().groove.streak,
             thr: _ambEffRest({ restProb: 40 }),
             thrPlain: _ambEffRest({ restProb: 0 }) };
  });
  ok('with no `streak` the threshold is exactly restProb', off.thr === 40 && off.thrPlain === 0,
    JSON.stringify(off));
  ok('…and the key is not materialised by normalize', off.stored === undefined, JSON.stringify(off.stored));

  console.log('\n  ✺ the model');
  const sim = await page.evaluate(() => {
    const E = _masterEng; const c = E.getCfg();
    // a DETERMINISTIC stream, so the measurement itself is stable run to run
    let z = 12345;
    const rnd = () => { z = (z * 1664525 + 1013904223) >>> 0; return z / 4294967296; };
    const key = () => (typeof _ambEmitLayerKey !== 'undefined' ? (_ambEmitLayerKey || '?') : '?');
    const run = (amt) => {
      // `_normalizeAmbientCfg` REPLACES objects on every getCfg, so a reference taken
      // before one is an orphan — re-fetch, write, normalize. And `_ambGroove` reads
      // the CACHED `_E._cfg`, not `getCfg()`, so the cache is refreshed too or the
      // engine never sees the value (measured: on and off came out byte-identical).
      E.getCfg().groove.streak = amt;
      E.getCfg();
      _masterEng._cfg = _masterEng.getCfg();
      z = 12345;
      const seq = [];
      for (let i = 0; i < 6000; i++) {
        const thr = _ambEffRest({ restProb: 40 });
        const fired = (rnd() * 100 >= thr);
        if (fired) _ambStreakNote(key());
        seq.push(fired ? 1 : 0);
      }
      const n = seq.length;
      const m = seq.reduce((a, b) => a + b, 0) / n;
      let v = 0, cv = 0;
      for (let i = 0; i < n; i++) v += (seq[i] - m) * (seq[i] - m);
      for (let i = 1; i < n; i++) cv += (seq[i] - m) * (seq[i - 1] - m);
      // longest run of notes, as a second, blunter witness of the same thing
      let run1 = 0, best = 0;
      for (let i = 0; i < n; i++) { if (seq[i]) { run1++; best = Math.max(best, run1); } else run1 = 0; }
      return { rate: m, r1: v ? cv / v : 0, longest: best };
    };
    const a = run(0), b = run(70);
    const seen = (typeof _ambGroove === 'function') ? ((_ambGroove() || {}).streak) : 'no _ambGroove';
    E.getCfg().groove.streak = 0; E.getCfg(); _masterEng._cfg = _masterEng.getCfg();
    return { off: a, on: b, seen: seen };
  });
  ok('the engine actually SAW the setting', sim.seen === 70, JSON.stringify(sim.seen));
  console.log('      measured: off rate=' + sim.off.rate.toFixed(3) + ' r1=' + sim.off.r1.toFixed(3) +
              ' longest=' + sim.off.longest +
              '  ·  on rate=' + sim.on.rate.toFixed(3) + ' r1=' + sim.on.r1.toFixed(3) +
              ' longest=' + sim.on.longest);
  ok('off: the onsets are independent — no run structure',
    Math.abs(sim.off.r1) < 0.06, 'r1=' + sim.off.r1.toFixed(3));
  ok('on: notes and rests come in RUNS', sim.on.r1 > 0.20, 'r1=' + sim.on.r1.toFixed(3));
  ok('…and the runs get visibly longer', sim.on.longest > sim.off.longest,
    JSON.stringify([sim.off.longest, sim.on.longest]));
  // THE POINT OF SELF-CENTRING. A fixed midpoint would bias a quiet layer toward
  // more silence and turn this into a density control by the back door.
  ok('…while the overall rest rate barely moves — a SHAPE change, not a density one',
    Math.abs(sim.on.rate - sim.off.rate) < 0.06,
    'off=' + sim.off.rate.toFixed(3) + ' on=' + sim.on.rate.toFixed(3) +
    ' Δ=' + (sim.on.rate - sim.off.rate).toFixed(3));

  console.log('\n  ✺ the control');
  // through the real doors: Arrangement → Variation → the 🕺 Groove chip
  const tap = async (sel, nth) => {
    const at = await page.evaluate((s, n) => {
      const els = [...document.querySelectorAll(s)];
      const el = Number.isFinite(n) ? els[n] : els[0]; if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!el.offsetParent || r.width < 4 || r.height < 4) return { bad: true };
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel, nth);
    if (!at || at.bad) return false;
    await page.touchscreen.tap(at.x, at.y); await zz(700); return true;
  };
  ok('⇶ Arrangement opens', await tap('[id$="-tabsec"] .ambient-tabsec-tab[data-tab="progsec"]'));
  ok('✺ Variation opens', await tap('[id$="proggrp-variation"] .ambient-grp-head'));
  ok('🕺 Groove opens from its chip', await tap('[id$="prog-varbar"] [data-pov="grp:groove"]'));
  const ui = await page.evaluate(() => {
    const pop = document.querySelector('.ambient-grp-pop') || document;
    const sl = [...pop.querySelectorAll('.ambient-groove-mac')].find((x) => x.dataset.gm === 'streak');
    const r = sl ? sl.getBoundingClientRect() : null;
    const row = sl ? sl.closest('.ambient-groove-macro') : null;
    const sibs = [...pop.querySelectorAll('.ambient-groove-macro')].map((x) =>
      (x.querySelector('label') || {}).textContent || '');
    return { found: !!sl, labels: sibs,
             reach: !!(sl && sl.offsetParent && r.width > 40 && r.height > 10),
             hint: row ? ((row.querySelector('.ambient-sched-lbl') || {}).textContent || '') : '',
             val: sl ? sl.value : null };
  });
  ok('Streaks is a macro beside the other six', ui.found === true && ui.labels.indexOf('Streaks') >= 0,
    JSON.stringify(ui.labels));
  ok('…measurable, not merely present', ui.reach === true, JSON.stringify([ui.reach, ui.val]));
  ok('…and it says what it does', /runs/.test(ui.hint || ''), JSON.stringify(ui.hint));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
