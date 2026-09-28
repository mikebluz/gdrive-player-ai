// PROBE — ✺ COUPLE: LAYERS THAT PULL TOGETHER, THEN SLIP APART.
//
// `drift` is a CONSTANT — a fixed phase offset a layer wears for ever — and layers are
// otherwise independent generators sharing only the clock and the key. Couple gives them
// a weak Kuramoto pull toward each other, spent as a BOUNDED wobble (±SPAN of the layer's
// own period through a sine), never an unbounded slide.
//
// The claims are about the DYNAMICS, and they cut both ways:
//   · 0 adds exactly nothing        — absent must be byte-identical (golden-render)
//   · coupling ENTRAINS             — the order parameter r rises well above weak coupling
//   · …but does NOT lock            — r stays off 1 and keeps moving; a locked ensemble is
//                                     a fixed offset, which is what `drift` already was
//   · the offset stays BOUNDED      — |off| ≤ SPAN · period, so a layer wobbles around
//                                     where it belongs instead of walking away
//
//   node test/probe-couple.js        (needs `npm start` on :3001)
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

  console.log('\n  ✺ absent adds nothing');
  const off = await page.evaluate(() => {
    const E = _masterEng; const c = E.getCfg();
    if (!c.groove) c.groove = {};
    delete c.groove.couple; E.getCfg();
    return { stored: E.getCfg().groove.couple,
             zero: _ambCoupleOffset('bed', 2.0, 0),
             noPeriod: _ambCoupleOffset('bed', 0, 80) };
  });
  ok('at 0 the offset is exactly 0', off.zero === 0, JSON.stringify(off.zero));
  ok('…and with no period to wobble in, still 0', off.noPeriod === 0, JSON.stringify(off.noPeriod));
  ok('…the key is not materialised by normalize', off.stored === undefined, JSON.stringify(off.stored));

  console.log('\n  ✺ the dynamics');
  const sim = await page.evaluate(() => {
    const keys = ['bed', 'motif', 'texture', 'beat', 'v2:1', 'v2:2'];
    const pers = [2.0, 1.33, 0.75, 1.0, 1.7, 2.4];
    const run = (amt) => {
      _AMB_COUPLE.clear();
      const rs = []; let maxAbs = 0;
      for (let i = 0; i < 4000; i++) {
        keys.forEach((k, j) => {
          const o = _ambCoupleOffset(k, pers[j], amt);
          maxAbs = Math.max(maxAbs, Math.abs(o) / pers[j]);   // as a fraction of the period
        });
        if (i > 400 && i % 5 === 0) rs.push(_ambCoupleField().r);
      }
      const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
      return { mean, min: Math.min(...rs), max: Math.max(...rs), maxAbs };
    };
    const weak = run(5), strong = run(90);
    _AMB_COUPLE.clear();
    return { weak, strong };
  });
  console.log('      measured: weak r=' + sim.weak.mean.toFixed(3) +
              ' [' + sim.weak.min.toFixed(2) + '..' + sim.weak.max.toFixed(2) + ']' +
              '  ·  strong r=' + sim.strong.mean.toFixed(3) +
              ' [' + sim.strong.min.toFixed(2) + '..' + sim.strong.max.toFixed(2) + ']' +
              '  ·  max |off| = ' + sim.strong.maxAbs.toFixed(3) + ' of a period');
  ok('coupling ENTRAINS — the order parameter rises',
    sim.strong.mean > sim.weak.mean + 0.15,
    'weak=' + sim.weak.mean.toFixed(3) + ' strong=' + sim.strong.mean.toFixed(3));
  ok('…but never LOCKS — a locked ensemble is just a fixed offset',
    sim.strong.mean < 0.98, 'r=' + sim.strong.mean.toFixed(3));
  ok('…and it keeps moving: they slip in and out',
    (sim.strong.max - sim.strong.min) > 0.05,
    'range=' + (sim.strong.max - sim.strong.min).toFixed(3));
  ok('the offset stays BOUNDED inside the span',
    sim.strong.maxAbs <= 0.0851 && sim.strong.maxAbs > 0.05,
    'maxAbs=' + sim.strong.maxAbs.toFixed(4));

  console.log('\n  ✺ the control');
  const tap = async (sel) => {
    const at = await page.evaluate((s) => {
      const el = document.querySelector(s); if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!el.offsetParent || r.width < 4 || r.height < 4) return { bad: true };
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    if (!at || at.bad) return false;
    await page.touchscreen.tap(at.x, at.y); await zz(700); return true;
  };
  ok('⇶ Arrangement opens', await tap('[id$="-tabsec"] .ambient-tabsec-tab[data-tab="progsec"]'));
  ok('✺ Variation opens', await tap('[id$="proggrp-variation"] .ambient-grp-head'));
  ok('🕺 Groove opens from its chip', await tap('[id$="prog-varbar"] [data-pov="grp:groove"]'));
  const ui = await page.evaluate(() => {
    const pop = document.querySelector('.ambient-grp-pop') || document;
    const sl = [...pop.querySelectorAll('.ambient-groove-mac')].find((x) => x.dataset.gm === 'couple');
    const r = sl ? sl.getBoundingClientRect() : null;
    const row = sl ? sl.closest('.ambient-groove-macro') : null;
    return { found: !!sl,
             labels: [...pop.querySelectorAll('.ambient-groove-macro label')].map((x) => x.textContent),
             reach: !!(sl && sl.offsetParent && r.width > 40 && r.height > 10),
             hint: row ? ((row.querySelector('.ambient-sched-lbl') || {}).textContent || '') : '' };
  });
  ok('Couple is a macro beside the others', ui.found === true && ui.labels.indexOf('Couple') >= 0,
    JSON.stringify(ui.labels));
  ok('…measurable, not merely present', ui.reach === true, JSON.stringify(ui.reach));
  ok('…and it says what it does', /slip/.test(ui.hint || ''), JSON.stringify(ui.hint));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
