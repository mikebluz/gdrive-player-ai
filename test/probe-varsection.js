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

  // ---- 3. THE CRAMPING --------------------------------------------------------
  console.log('\n  3. the cramping — at the width the gate runs at');
  const fit = await page.evaluate(() => {
    const rowsOf = (el) => {
      if (!el) return 0;
      const tops = new Set();
      [...el.querySelectorAll('[data-pov]')].forEach(c => {
        const r = c.getBoundingClientRect(); if (r.width > 0) tops.add(Math.round(r.top));
      });
      return tops.size;
    };
    const v = document.querySelector('.ambient-pov-varstrip');
    const host = document.querySelector('.ambient-progsec') || document.body;
    let minH = 999;
    if (v) [...v.querySelectorAll('[data-pov]')].forEach(c => {
      const r = c.getBoundingClientRect(); if (r.width > 0) minH = Math.min(minH, Math.round(r.height)); });
    return { varRows: rowsOf(v), minH: minH === 999 ? 0 : minH,
             overflowX: host.scrollWidth > host.clientWidth + 1,
             varWidth: v ? Math.round(v.getBoundingClientRect().width) : 0 };
  });
  // NOT AN ARBITRARY ROW COUNT. Six chips on a 390px phone wrap, and that is fine in a
  // section of their own — the complaint was MIXING, not height. What is gated is the
  // rule: no horizontal overflow, and every chip a real touch target.
  // 30px is this panel's established chip height (.ambient-pov-grpbtn, .ambient-pov-addpart,
  // the groove pills). ❄ Capture was a bare `display: block` at 21px and only showed up
  // as the odd one out once ✺ Variation put it beside its siblings.
  ok('every variation chip is the panel\u2019s chip height, none a 21px outlier',
    fit.varRows > 0 && fit.minH >= 30, JSON.stringify(fit));
  ok('…with no horizontal overflow, which UI rule 1 forbids outright',
    fit.overflowX === false, JSON.stringify(fit));

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
