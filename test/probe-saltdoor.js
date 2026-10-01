// PROBE — 🧂 THE SALT CELL HAS A DOOR AGAIN.
//
// The per-chord RE-ROLL (`saltNudge`) and the COLOUR-SNAP toggle (`saltFree`) are
// engine-read and were UNREACHABLE TWICE: once when the ⌗ Matrix fold deleted the only
// callers that passed their callbacks, and again when ▦ Passes — the grid that carried
// the cells — was retired into ▦ Schedule and its host left the panel. Both times the
// writes stayed live with nothing able to set them.
//
// The door is now where the cells live: ▦ Schedule ▸ Salt, long-press (or right-click)
// a cell. A TAP still paints how much of the Salt that layer takes on that chord.
//
//   node test/probe-saltdoor.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 900, height: 950 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(800);
  // a layer to own a row in the grid
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(900);

  console.log('\n  🧂 the cell');
  const open = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    const c = E.getCfg();
    const CH = (root) => ({ root, intervals: [0, 4, 7], bars: 1 });
    c.prog.on = true;
    c.prog.chords = [CH(0), CH(5), CH(7), CH(2)];
    c.prog.parts = [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]');
    if (t) t.click();
    await new Promise((r) => setTimeout(r, 500));
    const gp = document.querySelector('[id$="proggrp-overview"]');
    if (gp && !gp.classList.contains('open')) gp.querySelector('.ambient-grp-head').click();
    const gs = document.querySelector('[id$="proggrp-schedgrid"]');
    if (gs && !gs.classList.contains('open')) gs.querySelector('.ambient-grp-head').click();
    try { window._ambRenderSchedule(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    const host = document.querySelector('[id$="-schedgrid"]');
    if (!host) return { err: 'no schedule grid' };
    const sb = [...host.querySelectorAll('[data-sch="mode:salt"]')][0];
    if (sb) sb.click();
    await new Promise((r) => setTimeout(r, 400));
    const cells = [...host.querySelectorAll('.sch-cell[data-sch]')].filter((x) => !x.disabled);
    const c0 = cells[0];
    const r0 = c0 ? c0.getBoundingClientRect() : null;
    if (c0) c0.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    const r1 = c0 ? c0.getBoundingClientRect() : null;
    const L0 = (E.getCfg().layers || [])[0];
    return { maskBefore: JSON.stringify((L0 && L0.saltMask) || null),
             cells: cells.length, sel: c0 ? c0.getAttribute('data-sch') : null,
             reach: !!(c0 && c0.offsetParent && r0.width > 8 && r0.height > 8),
             x: r1 ? Math.round(r1.left + r1.width / 2) : -1,
             y: r1 ? Math.round(r1.top + r1.height / 2) : -1 };
  });
  ok('▦ Schedule ▸ Salt draws cells', !open.err && open.cells > 0, JSON.stringify(open));
  ok('…and no layer has a salt store yet — absent is neutral', open.maskBefore === 'null', String(open.maskBefore));
  ok('…and one is a real target you can press', open.reach === true, JSON.stringify(open));

  // A REAL LONG PRESS — down, hold past the threshold, up.
  await page.mouse.move(open.x, open.y);
  await page.mouse.down();
  await zz(700);
  await page.mouse.up();
  await zz(400);
  const held = await page.evaluate(() => {
    const ov = document.querySelector('.ambient-step-modal-ov');
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    return { ov: !!ov,
             reroll: !!(ov && ov.querySelector('.pm-sp-reroll')),
             snap: !!(ov && ov.querySelector('.pm-sp-snap')),
             slider: !!(ov && ov.querySelector('.ambient-pm-modal-sl')),
             names: ((ov && ov.querySelector('.ambient-pm-modal-head')) || {}).textContent || '',
             painted: !!(L && L.saltMask),
             mask: JSON.stringify((L && L.saltMask) || null), ate: _masterEng && undefined };
  });
  ok('a long-press opens the cell’s own modal', held.ov === true, JSON.stringify(held));
  ok('…carrying the two controls that had no door — 🎲 re-roll and ◈ snap',
    held.reroll === true && held.snap === true, JSON.stringify(held));
  ok('…and the exact amount, which is what the cell’s tap only steps',
    held.slider === true, JSON.stringify(held));
  ok('…while the hold did NOT also paint the cell it opened',
    held.painted === false, JSON.stringify(held));

  const acted = await page.evaluate(async () => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    const ov = document.querySelector('.ambient-step-modal-ov');
    const hit = (sel) => { const b = ov && ov.querySelector(sel); if (b) b.click(); return !!b; };
    const o = {};
    o.rerollHit = hit('.pm-sp-reroll');
    await new Promise((r) => setTimeout(r, 200));
    o.nudge = JSON.stringify(L().saltNudge || null);
    return o;
  });
  ok('🎲 re-roll bumps this chord’s nudge — the write that nothing could reach',
    acted.rerollHit === true && /"0":1|:1/.test(acted.nudge || ''), JSON.stringify(acted));

  // …and the snap toggle, on a fresh open (the re-roll closes the modal)
  await page.mouse.move(open.x, open.y);
  await page.mouse.down(); await zz(700); await page.mouse.up(); await zz(400);
  const snapped = await page.evaluate(async () => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    const ov = document.querySelector('.ambient-step-modal-ov');
    const b = ov && ov.querySelector('.pm-sp-snap');
    if (!b) return { err: 'no snap button' };
    b.click(); await new Promise((r) => setTimeout(r, 200));
    const on = JSON.stringify(L().saltFree || null);
    const stillOpen = !!document.querySelector('.ambient-step-modal-ov');
    const b2 = document.querySelector('.ambient-step-modal-ov .pm-sp-snap');
    if (b2) b2.click();
    await new Promise((r) => setTimeout(r, 200));
    return { on, stillOpen, off: 'saltFree' in L() };
  });
  ok('◈ snap writes the colour timing for this chord', !snapped.err && /:1/.test(snapped.on || ''),
    JSON.stringify(snapped));
  ok('…the modal stays open — a toggle that closes reads as "did that work?"',
    snapped.stillOpen === true, JSON.stringify(snapped));
  ok('…and toggling back prunes it', snapped.off === false, JSON.stringify(snapped));

  // A PLAIN TAP STILL PAINTS — with a tool that has something to say. "Takes it" on a
  // cell that already takes it is a no-op BY DESIGN (tapping what a cell already has
  // puts it back), so the tap has to be a real edit or this check proves nothing.
  await page.evaluate(() => {
    document.querySelectorAll('.ambient-step-modal-ov').forEach((o) => o.remove());
    const host = document.querySelector('[id$="-schedgrid"]');
    const off = host && host.querySelector('[data-sch="tool:off"]');
    if (off) off.click();
  });
  await zz(300);
  await page.mouse.click(open.x, open.y);
  await zz(300);
  const tapped = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    return { mask: JSON.stringify((L && L.saltMask && L.saltMask.steps) || null) };
  });
  ok('a plain tap still paints the cell', /^\[0,/.test(tapped.mask || ''), JSON.stringify(tapped));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
