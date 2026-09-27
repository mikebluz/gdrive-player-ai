// PROBE — ⏸ A BLOCK'S LENGTH, IN BARS OR IN CHANGES.
//
// user, 2026-09-27: "wherever scheduling is happening, Bar and Change (whole or
// fractional) should be optional units to express scheduling in".
//
// A part with no changes is the one block whose length is stated rather than derived,
// so it is the first surface outside ◇ Tone set to take the pair. The rules:
//   · `bars` keeps its key whatever it counts (save-compat); `bunit: 'chg'` says the
//     number is CHANGES, additive and absent by default;
//   · the conversion happens at DERIVATION, where the chords in force are known — the
//     arrangement clock still receives `ref: 'bar'`, which is what keeps arch-parity
//     meaningful and every saved project identical;
//   · it walks the REAL cadence: 2 changes over a 1·3 cadence is 4 bars, not 2×2.
//
//   node test/probe-blockunits.js        (needs `npm start` on :3001)
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
  await zz(800);

  console.log('\n  ⏸ the clock it reaches');
  const eng = await page.evaluate(() => {
    const E = _masterEng; _E = E;
    const c = E.getCfg();
    const CH = (root, bars) => ({ root, intervals: [0, 4, 7], bars });
    c.prog.on = true; c.barsPerChord = 1;
    // an UNEVEN cadence: change 0 is one bar, change 1 is three
    c.prog.chords = [CH(0, 1), CH(5, 3)];
    c.prog.parts = [{ name: 'Verse', len: 2 }, { name: 'Break', open: 1, bars: 2 }];
    E.getCfg();
    const cfg = E.getCfg();
    const lenOf = () => {
      const a = (E.getCfg().arch || []).find((x) => x && /Break/.test(x.name || ''));
      return a && a.len ? { num: a.len.num, den: a.len.den, ref: a.len.ref } : null;
    };
    const asBars = lenOf();
    // …now say the same block in CHANGES
    E.getCfg().prog.parts[1].bars = 2;
    E.getCfg().prog.parts[1].bunit = 'chg';
    E.getCfg();
    const asChanges = lenOf();
    const stored = E.getCfg().prog.parts[1];
    return { asBars, asChanges, storedBars: stored.bars, storedUnit: stored.bunit,
             helper: _ambBlockBars(cfg, 2, 'chg', 1),
             helperBar: _ambBlockBars(cfg, 2, undefined, 1),
             label: _ambBlockLenLabel(2, 'chg'), labelBar: _ambBlockLenLabel(2, undefined),
             underneath: _ambCadUnder(cfg, 1) };
  });
  ok('the fixture really is uneven — 1 then 3',
    JSON.stringify(eng.underneath) === '[1,3]', JSON.stringify(eng.underneath));
  ok('2 bars is 2 bars', !!eng.asBars && eng.asBars.num === 2 && eng.asBars.ref === 'bar',
    JSON.stringify(eng.asBars));
  ok('…and 2 CHANGES is 4 bars — the cadence, walked, never averaged',
    !!eng.asChanges && eng.asChanges.num === 4, JSON.stringify(eng.asChanges));
  ok('…and the clock is still handed bars, so the arrangement gained no new reference',
    eng.asChanges.ref === 'bar' && eng.asChanges.den === 1, JSON.stringify(eng.asChanges));
  ok('the store keeps the count under its own key, and says what it counts',
    eng.storedBars === 2 && eng.storedUnit === 'chg', JSON.stringify(eng));
  ok('the helper agrees with the derivation, and bars are untouched',
    eng.helper === 4 && eng.helperBar === 2, JSON.stringify([eng.helper, eng.helperBar]));
  ok('one labeller, both units', eng.label === '2 changes' && eng.labelBar === '2 bars',
    JSON.stringify([eng.label, eng.labelBar]));

  // ---- ABSENT IS BARS, AND A SAVED BLOCK IS UNTOUCHED -------------------------
  const norm = await page.evaluate(() => {
    const E = _masterEng;
    E.getCfg().prog.parts[1].bunit = 'nonsense';
    const a = E.getCfg().prog.parts[1];
    E.getCfg().prog.parts[1].bunit = 'chg';
    const b = E.getCfg().prog.parts[1];
    return { junkDropped: a.bunit === undefined, kept: b.bunit === 'chg' };
  });
  ok('a unit it does not know is dropped, not stored', norm.junkDropped === true, JSON.stringify(norm));
  ok('…and the one it does survives the normalizer', norm.kept === true, JSON.stringify(norm));

  // ---- THE SURFACES SAY IT ----------------------------------------------------
  console.log('\n  ⏸ what the block says');
  const ui = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]');
    if (t) t.click();
    await new Promise((r) => setTimeout(r, 500));
    const g = document.querySelector('[id$="proggrp-overview"]');
    if (g && !g.classList.contains('open')) g.querySelector('.ambient-grp-head').click();
    try { _ambRenderProgOverview(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    const chip = document.querySelector('[id$="prog-overview"] .ambient-pov-open');
    const out = { chip: chip ? chip.textContent.trim() : null,
                  reach: !!(chip && chip.offsetParent && chip.getBoundingClientRect().width > 20) };
    // the ⏸ Length menu — both groups, and the pick writes both fields
    const prev = window.showCtxMenu; let items = null;
    window.showCtxMenu = (x, y, its) => { items = its; };
    try {
      chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      out.labels = (items || []).map((i) => (i && i.label) || String(i));
      const pick = (items || []).find((i) => i && i.fn && /4 bars/.test(i.label));
      if (pick) pick.fn();
      await new Promise((r) => setTimeout(r, 200));
      const p1 = E.getCfg().prog.parts[1];
      out.toBars = { bars: p1.bars, unit: p1.bunit };
      items = null;
      // RE-QUERY: the pick re-rendered the strip, so the node captured above is
      // detached — and a detached node reaches no delegated handler.
      const chip2 = document.querySelector('[id$="prog-overview"] .ambient-pov-open');
      chip2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const pick2 = (items || []).find((i) => i && i.fn && /3 changes/.test(i.label));
      if (pick2) pick2.fn();
      await new Promise((r) => setTimeout(r, 200));
      const p2 = E.getCfg().prog.parts[1];
      out.toChanges = { bars: p2.bars, unit: p2.bunit };
    } finally { window.showCtxMenu = prev; }
    return out;
  });
  ok('the chip states the block in its own unit', /2 changes/.test(ui.chip || ''), JSON.stringify(ui.chip));
  ok('…and it is a control you can reach', ui.reach === true, JSON.stringify(ui.reach));
  ok('the ⏸ menu offers BOTH units, each under its own heading',
    (ui.labels || []).some((l) => /In bars/.test(l)) && (ui.labels || []).some((l) => /In changes/.test(l)),
    JSON.stringify(ui.labels));
  ok('picking bars clears the unit — absent is how "bars" is spelled',
    ui.toBars.bars === 4 && ui.toBars.unit === undefined, JSON.stringify(ui.toBars));
  ok('…and picking changes writes both fields',
    ui.toChanges.bars === 3 && ui.toChanges.unit === 'chg', JSON.stringify(ui.toChanges));

  // ---- ＋ ADD PART OFFERS THE SAME PAIR ---------------------------------------
  const add = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    _ambAddPartModal(E, 40, 120);
    await new Promise((r) => setTimeout(r, 80));
    const ov = document.querySelector('.ambient-addpart-modal');
    if (!ov) return { err: 'no modal' };
    ov.querySelectorAll('.ap-kind .ambient-seg').forEach((b) => { if (b.dataset.kind === 'open') b.click(); });
    await new Promise((r) => setTimeout(r, 120));
    const segs = [...ov.querySelectorAll('.ap-bunit .ambient-seg')];
    const r = segs.length ? segs[1].getBoundingClientRect() : null;
    const out = { segs: segs.map((b) => b.dataset.bunit),
                  reach: !!(segs[1] && segs[1].offsetParent && r.width > 20 && r.height > 14) };
    ov.querySelector('.ap-bars').value = '2';
    segs[1].click();                              // changes
    await new Promise((r2) => setTimeout(r2, 100));
    out.lit = segs[1].classList.contains('active') && !segs[0].classList.contains('active');
    ov.querySelector('.ap-next').click();         // "Add part" on the open kind
    await new Promise((r2) => setTimeout(r2, 300));
    const parts = E.getCfg().prog.parts || [];
    const np = parts[parts.length - 1] || {};
    out.stored = { open: !!np.open, bars: np.bars, unit: np.bunit };
    const a = (E.getCfg().arch || []).filter((x) => x && x.len);
    out.archLast = a.length ? a[a.length - 1].len : null;
    return out;
  });
  ok('＋ Add part offers bars · changes on the Length row', !add.err &&
    JSON.stringify(add.segs) === '["bar","chg"]', JSON.stringify(add));
  ok('…measurable, and the pick lights', add.reach === true && add.lit === true, JSON.stringify(add));
  ok('…and the block it makes carries the unit through to the clock',
    add.stored.open === true && add.stored.bars === 2 && add.stored.unit === 'chg' &&
    !!add.archLast && add.archLast.num === 4 && add.archLast.ref === 'bar',
    JSON.stringify(add));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
