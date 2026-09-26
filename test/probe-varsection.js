// PROBE — ✺ Variation as its own section, above ▤ Parts.
//
// user, 2026-09-26: "these buttons are feeling cramped … i wonder if it should be its
// own subsection above Parts so Parts becomes only the parts and their definitions".
//
// The ▤ Parts bar carried THREE things under one header — STRUCTURE (＋ Part,
// ▤ Song map), VARIATION (six chips) and a VIEW toggle (♪ Names). Six of the nine
// were not about parts at all.
//
// AND IT WAS A BUG, not only a tidy-up: the two halves need DIFFERENT VISIBILITY.
// ✺ Novelty and 🌒 Arc act on an area with NO CHANGES (Arc counts bars, not chords);
// 🧂 Salt, ↔ Rubato, ↻ Order and ❄ Capture cannot. Sharing one bar meant sharing one
// answer, so on a fresh area the whole bar took the empty-state branch and ✺ Novelty
// did not exist at all — measured, and reported by the user as "where is Novelty".
//
//   node test/probe-varsection.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  // THE TAB IS TOGGLED BY ITS OWN BUTTON — press it ONCE. Pressing again closes the
  // pane, and every measurement after that reads 0×0 and looks like a missing feature.
  await page.evaluate(() => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click();
  });
  await zz(600);
  await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp .ambient-grp-head[data-grp="▤ Parts"]');
    if (g && !g.parentElement.classList.contains('open')) g.click();
  });
  await zz(500);

  const look = () => page.evaluate(() => {
    const grp = document.querySelector('.ambient-proggrp[data-grp="✺ Variation"]');
    const vis = (sel) => [...document.querySelectorAll(sel)]
      .map(e => ({ k: e.getAttribute('data-pov'), w: Math.round(e.getBoundingClientRect().width), par: !!e.offsetParent }))
      .filter(x => x.w > 0 && x.par).map(x => x.k);
    const strip = document.querySelector('.ambient-pov-strip:not(.ambient-pov-varstrip)');
    const varStrip = document.querySelector('.ambient-pov-varstrip');
    // document order: the Variation section must come BEFORE the Parts one
    let order = null;
    try {
      const pg = document.querySelector('.ambient-proggrp[data-grp="▤ Parts"]');
      if (grp && pg) order = (grp.compareDocumentPosition(pg) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'above' : 'below';
    } catch (e) {}
    return { section: !!(grp && grp.offsetParent), order,
             open: !!(grp && grp.classList.contains('open')),
             variation: vis('.ambient-pov-varstrip [data-pov]'),
             parts: strip ? vis('#' + strip.id + ' [data-pov]') : [],
             rows: varStrip ? varStrip.querySelectorAll('.ambient-pov-bar').length : 0 };
  });

  // ---- 1. AN AREA WITH NO CHANGES --------------------------------------------
  console.log('\n  1. an area with no changes — the case that was broken');
  const empty = await look();
  console.log('     variation: ' + JSON.stringify(empty.variation) + '  parts: ' + JSON.stringify(empty.parts));
  ok('the ✺ Variation section exists and is visible', empty.section === true, JSON.stringify(empty));
  ok('…above ▤ Parts, which is the area → part ladder this pane reads by',
    empty.order === 'above', String(empty.order));
  ok('…open by default — a collapsed accordion is where the old chips went to hide',
    empty.open === true, String(empty.open));
  ok('✺ NOVELTY IS REACHABLE WITH NO CHANGES — the reported bug',
    empty.variation.indexOf('grp:novelty') >= 0, JSON.stringify(empty.variation));
  ok('…and so is 🌒 Arc, which counts bars and genuinely acts here',
    empty.variation.indexOf('grp:arc') >= 0, JSON.stringify(empty.variation));
  ok('…while the four that need the chord clock are NOT offered',
    ['grp:salt', 'grp:rubato', 'grp:order', 'capture'].every(k => empty.variation.indexOf(k) < 0),
    JSON.stringify(empty.variation));
  ok('▤ Parts still offers ＋ Part, so there is a way in',
    empty.parts.indexOf('addpart') >= 0, JSON.stringify(empty.parts));

  // ---- 2. WITH CHANGES --------------------------------------------------------
  console.log('\n  2. with changes — every axis comes back');
  await page.evaluate(() => {
    const c = _masterEng.getCfg();
    c.prog.on = true;
    c.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 3, 7] }];
    c.prog.vary = 40;
    _masterEng.getCfg();
    try { _ambSyncControls(_masterEng); } catch (e) {}
    try { _ambRenderProgOverview(_masterEng); } catch (e) {}
  });
  await zz(800);
  const full = await look();
  console.log('     variation: ' + JSON.stringify(full.variation));
  console.log('     parts    : ' + JSON.stringify(full.parts));
  ok('all six variation chips are offered once there are changes',
    ['grp:novelty', 'grp:salt', 'grp:rubato', 'grp:order', 'grp:arc', 'capture']
      .every(k => full.variation.indexOf(k) >= 0), JSON.stringify(full.variation));
  ok('…and NONE of them is left on the ▤ Parts bar',
    ['grp:novelty', 'grp:salt', 'grp:rubato', 'grp:order', 'grp:arc', 'capture']
      .every(k => full.parts.indexOf(k) < 0), JSON.stringify(full.parts));
  ok('▤ Parts keeps what IS about parts — ＋ Part, ▤ Song map, ♪ Names',
    ['addpart', 'arrmap', 'names'].every(k => full.parts.indexOf(k) >= 0), JSON.stringify(full.parts));
  ok('…and the chord chips, which are the parts’ own definitions',
    full.parts.some(k => /^chord:/.test(k)), JSON.stringify(full.parts));

  // ---- 3. THE GRID ------------------------------------------------------------
  // user: "it should be a more symmetrical grid of buttons, larger buttons, and each
  // a different color (unless tightly coupled)". Six axes of one subject, so six
  // identical cells — the same answer 🧂 the salt dials got to the same complaint.
  console.log('\n  3. a symmetrical grid, not a wrapping line');
  const grid = () => page.evaluate(() => {
    const cells = [...document.querySelectorAll('.ambient-pov-varbar > [data-pov]')];
    const rows = {};
    cells.forEach(c => { const r = c.getBoundingClientRect();
      (rows[Math.round(r.top)] = rows[Math.round(r.top)] || []).push(1); });
    const ws = cells.map(c => Math.round(c.getBoundingClientRect().width));
    const hs = cells.map(c => Math.round(c.getBoundingClientRect().height));
    const host = document.querySelector('.ambient-progsec') || document.body;
    return { n: cells.length, perRow: Object.values(rows).map(r => r.length),
             widthsEqual: new Set(ws).size === 1, w: ws[0] || 0,
             minH: hs.length ? Math.min.apply(null, hs) : 0,
             sameH: new Set(hs).size === 1,
             colours: new Set(cells.map(c => getComputedStyle(c).borderTopColor)).size,
             overflowX: host.scrollWidth > host.clientWidth + 1 };
  });
  const g390 = await grid();
  console.log('     390px: ' + JSON.stringify(g390));
  ok('all six cells are the SAME WIDTH — a grid, not a wrapping line',
    g390.n === 6 && g390.widthsEqual === true, JSON.stringify(g390));
  ok('…and the same height, so no row is taller than another',
    g390.sameH === true, JSON.stringify(g390));
  ok('…in rows that DIVIDE six, never an orphan row of one',
    g390.perRow.length > 0 && g390.perRow.every(n => n === g390.perRow[0]),
    JSON.stringify(g390.perRow));
  ok('…each cell a real touch target, which the old 30px chips were not',
    g390.minH >= 44, String(g390.minH));
  ok('…six distinct hues, one per axis', g390.colours === 6, String(g390.colours));
  ok('…with no horizontal overflow, which UI rule 1 forbids outright',
    g390.overflowX === false, JSON.stringify(g390));

  // THE WIDE CASE IS NOT MEASURED HERE. This gate is SINGLE-VIEWPORT (390px) on
  // purpose, and resizing mid-run tears the panel down — measured: every cell reads
  // 0. What IS asserted is the rule that makes the wide case safe: it is a real CSS
  // grid with an EXPLICIT column count, not `auto-fit`. auto-fit picks whatever fits,
  // so at any width that takes five it leaves a last row of ONE — the ragged shape
  // this replaced. (3-across at 1100px measured by hand: 2 rows, equal, 56px.)
  const decl = await page.evaluate(() => {
    const bar = document.querySelector('.ambient-pov-varbar');
    if (!bar) return null;
    const cs = getComputedStyle(bar);
    return { display: cs.display, tracks: cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length };
  });
  ok('it is a real CSS grid with an explicit column count, not a wrapping flex line',
    decl && decl.display === 'grid' && decl.tracks === 2, JSON.stringify(decl));
  ok('…and six divides that column count, so no row can be orphaned',
    decl && 6 % decl.tracks === 0, JSON.stringify(decl));

  // ---- 4. THE DOOR STILL OPENS ------------------------------------------------
  console.log('\n  4. the door still opens onto the real popover');
  const opened = await page.evaluate(() => {
    const b = document.querySelector('.ambient-pov-varstrip [data-pov="grp:novelty"]');
    if (!b) return { there: false };
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click();
    return { there: true };
  });
  await zz(700);
  const pop = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host');
    const amt = host && host.querySelector('.ambient-nov-amt');
    return { host: !!host, amt: !!(amt && amt.getBoundingClientRect().width > 50 && amt.offsetParent),
             title: (document.querySelector('.ambient-grppop-modal .sm-title') || {}).textContent };
  });
  ok('pressing ✺ Novelty in its new home opens the popover', opened.there && pop.host === true,
    JSON.stringify([opened, pop]));
  ok('…with the dial measuring inside it', pop.amt === true, String(pop.amt));
  ok('…still titled ✺ Novelty', /Novelty/.test(pop.title || ''), JSON.stringify(pop.title));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
