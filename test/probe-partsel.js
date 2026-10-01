// PROBE — CHOOSING A PART: one picker at a time, and one colour per part.
//
// user, 2026-09-27: "color coding still off, the middle Part selector isn't keeping in
// sync with selected part color"; "this middle Part selector should only show when the
// Arrangement > Parts section is closed, otherwise clicking on the Parts in the
// Arrangement Parts section should select which part is being edited in the layers".
//
// Three things, one axis:
//   · `_ambPartAttr` stamps the swatch at BUILD, and the strip's per-frame playhead
//     sync moves the select's VALUE without it — so the control named one part in
//     another's hue. `_ambPartHueEl` makes the swatch a function of the value.
//   · ▤ Parts draws every part as a pressable card, so while it is open the strip is a
//     second door to the same choice: it hides, and comes back when the group folds.
//   · A press on a card goes through `_ambCurPartChoose` — the same action the dropdown
//     runs, including the switch out of 👁 View — and the card says it is chosen.
//     The ordinal rail is excluded: a reorder must not also read as a pick.
//
//   node test/probe-partsel.js        (needs `npm start` on :3001)
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

  // THREE parts, so "selected" and "playing" and "the next one" are all different.
  await page.evaluate(async () => {
    const E = _masterEng, c = E.getCfg();
    const CH = (root) => ({ root, intervals: [0, 4, 7], bars: 1 });
    c.prog.on = true;
    c.prog.chords = [CH(0), CH(5), CH(7), CH(2), CH(9), CH(4), CH(11), CH(6)];
    c.prog.parts = [{ name: 'Intro', len: 3 }, { name: 'Verse', len: 3 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]');
    if (t) t.click();
    await new Promise((r) => setTimeout(r, 600));
    try { _ambSyncFxVis(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  });

  // ---- THE STRIP'S SWATCH FOLLOWS ITS VALUE -----------------------------------
  console.log('\n  ♪ the strip’s colour');
  const hue = await page.evaluate(async () => {
    const E = _masterEng;
    // fold ▤ Parts so the strip is the picker and therefore on screen
    // IDS ARE NAMESPACED PER ENGINE — the master in Mix is `mix-bloom-…`.
    const g = document.querySelector('[id$="proggrp-overview"]');
    if (g && g.classList.contains('open')) g.querySelector('.ambient-grp-head').click();
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector('[id$="-curpart"]');
    const sel = el && el.querySelector('.ambient-curpart-sel');
    if (!sel) return { err: 'no part select' };
    const built = sel.getAttribute('data-part');
    // WHAT THE PLAYHEAD DOES: move the value, then let the per-frame hook run. Its
    // own early-out is cached on the element, so clear it as a frame boundary would.
    sel.value = '2';
    el._playPi = undefined;
    _ambCurPartPlayhead(E);
    const after = sel.getAttribute('data-part');
    const cs = getComputedStyle(sel);
    const pt3 = getComputedStyle(document.documentElement).getPropertyValue('--pt3').trim();
    return { built, after, want: String(_ambPartOrd(2)), edge: cs.borderLeftColor, pt3,
             visible: !!el.offsetParent };
  });
  ok('the strip is on screen with ▤ Parts folded', hue.visible === true, JSON.stringify(hue));
  ok('it is built wearing the part it names', !hue.err && /^[1-8]$/.test(hue.built || ''),
    JSON.stringify(hue));
  ok('…and the swatch MOVES with the value the playhead writes',
    !hue.err && hue.after === hue.want, JSON.stringify([hue.after, hue.want]));
  ok('…all the way to a painted edge, not just an attribute',
    /^rgb/.test(hue.edge || '') && hue.edge !== 'rgba(0, 0, 0, 0)', JSON.stringify(hue.edge));

  // ---- ONE PICKER AT A TIME ---------------------------------------------------
  console.log('\n  ▤ one picker at a time');
  const vis = await page.evaluate(async () => {
    const head = document.querySelector('[id$="proggrp-overview"] .ambient-grp-head');
    if (!head) return { err: 'no ▤ Parts head' };
    const el = document.querySelector('[id$="-curpart"]');
    const closed = { strip: !!el.offsetParent, open: head.closest('.ambient-grp').classList.contains('open') };
    head.click();
    await new Promise((r) => setTimeout(r, 350));
    const opened = { strip: !!el.offsetParent, open: head.closest('.ambient-grp').classList.contains('open'),
                     cards: document.querySelectorAll('.ambient-pov-part[data-povpi]').length };
    return { closed, opened };
  });
  ok('folded: the strip is the picker', !vis.err && vis.closed.strip === true && vis.closed.open === false,
    JSON.stringify(vis));
  ok('open: the cards are, and the strip stands down',
    vis.opened.open === true && vis.opened.strip === false && vis.opened.cards >= 3,
    JSON.stringify(vis));

  // ---- PRESSING A CARD PICKS THAT PART ----------------------------------------
  console.log('\n  ▤ pressing a part card');
  // A LAYER FIRST — this fixture is arrangement-only, and "which part the layers are
  // on" cannot be measured against no layers (a check that reads `null` from an empty
  // host passes for the wrong reason until the day it matters).
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(900);
  const madeLayer = await page.evaluate(() => document.querySelectorAll('.v2-layer').length);
  ok('a layer exists to follow the part', madeLayer >= 1, String(madeLayer));
  // A REAL POINTER, at a point MEASURED to be card background — the centre of a card
  // is a chord chip, and a probe that presses a chip is testing the chip.
  const spot = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ambient-pov-part[data-povpi]')];
    const card = cards[2]; if (!card) return { err: 'no third card' };
    const r = card.getBoundingClientRect();
    for (let y = r.top + 4; y < r.bottom - 2; y += 3) {
      for (let x = r.left + 44; x < r.right - 4; x += 5) {
        const e = document.elementFromPoint(x, y);
        if (!e || !card.contains(e)) continue;
        if (e.closest('[data-pov], [data-povgrab], button, input, select')) continue;
        return { x: Math.round(x), y: Math.round(y), pi: card.getAttribute('data-povpi') | 0 };
      }
    }
    return { err: 'no bare point on the card' };
  });
  ok('there is card background to press', !spot.err, JSON.stringify(spot));
  if (!spot.err) await page.mouse.click(spot.x, spot.y);
  await zz(500);
  const picked = await page.evaluate((pi) => {
    const E = _masterEng;
    let vm = 'view'; try { vm = window._v2.viewMode(); } catch (e) {}
    const card = document.querySelector('.ambient-pov-part[data-povpi="' + pi + '"]');
    const lay = document.querySelector('#bloom-v2-layers .v2-layer');
    return { cur: E._curPart, vm, sel: !!(card && card.classList.contains('pov-part-sel')),
             others: [...document.querySelectorAll('.ambient-pov-part.pov-part-sel')].length,
             layerPart: lay ? lay.getAttribute('data-part') : null,
             want: String(_ambPartOrd(pi)) };
  }, spot.pi | 0);
  ok('the press chooses that part', picked.cur === (spot.pi | 0), JSON.stringify(picked));
  ok('…and choosing is the intent to HOLD it, so it switches to ✎ Edit',
    picked.vm === 'edit', JSON.stringify(picked.vm));
  ok('…the card says it is the one, and only that card',
    picked.sel === true && picked.others === 1, JSON.stringify(picked));
  ok('…and the layer cards wear that part',
    picked.layerPart === picked.want, JSON.stringify([picked.layerPart, picked.want]));

  // THE RAIL IS FOR DRAGGING. A press there must not also pick.
  const rail = await page.evaluate(async () => {
    const E = _masterEng;
    const before = E._curPart;
    const cards = [...document.querySelectorAll('.ambient-pov-part[data-povpi]')];
    const other = cards.find((c) => (c.getAttribute('data-povpi') | 0) !== (before | 0));
    const g = other && other.querySelector('.ambient-pov-ord');
    if (!g) return { err: 'no rail' };
    const r = g.getBoundingClientRect();
    return { before, pi: other.getAttribute('data-povpi') | 0, x: Math.round(r.left + r.width / 2),
             y: Math.round(r.top + r.height / 2) };
  });
  if (!rail.err) await page.mouse.click(rail.x, rail.y);
  await zz(300);
  const afterRail = await page.evaluate(() => _masterEng._curPart);
  ok('a press on the drag rail does NOT pick — a reorder is not a choice',
    !rail.err && afterRail === rail.before, JSON.stringify([rail, afterRail]));

  // ---- ↻ LOOP SURVIVES THE STRIP BEING HIDDEN ---------------------------------
  console.log('\n  ↻ loop from the card');
  const loop = await page.evaluate(async () => {
    const E = _masterEng;
    const pi = E._curPart | 0;
    const dots = document.querySelector('.ambient-pov-part[data-povpi="' + pi + '"] .ambient-pov-dots');
    if (!dots) return { err: 'no ⋯ on the chosen card' };
    const prev = window.showCtxMenu; let items = null;
    window.showCtxMenu = (x, y, its) => { items = its; };
    try {
      dots.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const it = (items || []).find((i) => i && i.label && /Loop this part/.test(i.label));
      if (!it) return { err: 'no ↻ item', labels: (items || []).map((i) => i && i.label) };
      it.fn();
      await new Promise((r) => setTimeout(r, 200));
    } finally { window.showCtxMenu = prev; }
    const card = document.querySelector('.ambient-pov-part[data-povpi="' + pi + '"]');
    return { pi, armed: E._partLoop, marked: !!(card && card.classList.contains('pov-loop')) };
  });
  ok('the ⋯ menu carries ↻ Loop while the strip is hidden', !loop.err, JSON.stringify(loop));
  ok('…it arms the same transient field the strip’s button writes',
    loop.armed === loop.pi, JSON.stringify(loop));
  ok('…and the card shows it, so it can never be invisibly on',
    loop.marked === true, JSON.stringify(loop));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
