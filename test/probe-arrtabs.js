// PROBE — TWO TABS, SIX VARIATION CARDS, AND THE KEY THAT MOVED.
//
// user, 2026-09-27: "move Groove into Arrangement as the 6th button in the bottom right of
// the Variation subsection; again Key seems useless, i think we can remove it; then we just
// have Arrangement and Mix buttons" — and "i see no Jitter param in Groove".
//
// The Jitter switch had been added to the ⚙ Settings menu's legacy groove list, which is the
// GRID sequencer's copy of these controls. Reported missing, which is what this file says
// happens to a control put where nobody looks.
//
// A MOVE IS A DELETE PLUS AN ADD. ♯ Key's tab is gone but its CONTROLS are not: the area key
// is load-bearing (53 sites resolve through `_ambKeyRootPc`, and it is the only key an area
// with no progression has), so it is the first subsection inside ⇶ Arrangement now. Every id
// is unchanged, so its wiring binds as before — which is what the last three checks measure.
//
//   node test/probe-arrtabs.js        (needs `npm start` on :3001)
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
  // a progression, so the Variation cards have something to govern
  await page.evaluate(() => {
    const E = _masterEng; const c = E.getCfg();
    const CH = (r, b) => ({ root: r, intervals: [0, 4, 7], bars: b });
    c.prog.on = true; c.barsPerChord = 1;
    c.prog.chords = [CH(0, 1), CH(5, 1), CH(7, 2), CH(2, 2)];
    c.prog.parts = [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
    try { _ambSyncControls(E); } catch (e) {}   // or the off-hint stays up
  });
  await zz(900);

  // A REAL TOUCH, measured first — a 0×0 rect is the tell.
  const tap = async (sel, nth) => {
    const at = await page.evaluate((s, n) => {
      const els = [...document.querySelectorAll(s)];
      const el = Number.isFinite(n) ? els[n] : els[0]; if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!el.offsetParent || r.width < 4 || r.height < 4) return { bad: true };
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return { bad: true, covered: true };
      return { x, y };
    }, sel, nth);
    if (!at || at.bad) return false;
    await page.touchscreen.tap(at.x, at.y); await zz(700); return true;
  };

  console.log('\n  ⇶ two tabs, not four');
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[id$="-tabsec"] .ambient-tabsec-tab')]
    .map((t) => ({ tab: t.dataset.tab, txt: t.textContent.trim(), on: !!t.offsetParent })));
  ok('the bar is Arrangement + Mixer only', tabs.length === 2 &&
    tabs[0].tab === 'progsec' && tabs[1].tab === 'mixer', JSON.stringify(tabs));
  ok('…and both are on screen', tabs.every((t) => t.on), JSON.stringify(tabs));
  ok('no ♯ Key tab and no 🕺 Groove tab remain',
    !tabs.some((t) => /keysec|groove/.test(t.tab || '')), JSON.stringify(tabs.map((t) => t.tab)));

  console.log('\n  ✺ Groove is the 6th Variation card');
  ok('⇶ Arrangement opens', await tap('[id$="-tabsec"] .ambient-tabsec-tab', 0));
  const cards = await page.evaluate(() => {
    const gs = [...document.querySelectorAll('[id$="-progsec"] .ambient-proggrp[data-pop="1"]')];
    return gs.map((g) => ({ id: (g.id || '').replace(/^.*proggrp-/, ''),
                            lab: (g.querySelector('.ambient-grp-head') || {}).textContent || '' }));
  });
  const ids = cards.map((c) => c.id);
  // ♯ Key is a card too now, at the TOP of Arrangement — the Variation ROW is the
  // six that follow it, so the claim is about the TAIL, not the whole list.
  const varRow = ids.slice(-6);
  ok('six cards in the Variation row, Groove last',
    JSON.stringify(varRow) === '["salt","novelty","rubato","order","arc","groove"]', JSON.stringify(ids));
  ok('…its five neighbours are untouched and in their old order',
    JSON.stringify(varRow.slice(0, 5)) === '["salt","novelty","rubato","order","arc"]', JSON.stringify(varRow));
  // THE VISIBLE CARD IS THE CHIP IN THE VARIATION STRIP, not the group — a pop group
  // with no chip is unreachable, and `partseq` pins that in both directions. This is
  // the button the ask was actually about.
  // THE STRIP LIVES INSIDE \u273a Variation, WHICH STARTS COLLAPSED — so the chips are
  // measured only after walking that door, which is what a finger does. Measuring
  // before it reports 0\u00d70 and reads as "the chip is missing" (it is not).
  ok('\u273a Variation opens', await tap('[id$="proggrp-variation"] .ambient-grp-head'));
  const chips = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('[id$="prog-varbar"] [data-pov^="grp:"]')];
    const gv = cs.find((c) => c.getAttribute('data-pov') === 'grp:groove');
    const r = gv ? gv.getBoundingClientRect() : null;
    const sib = cs.find((c) => c !== gv && c.offsetParent && c.getBoundingClientRect().height > 4);
    const sr = sib ? sib.getBoundingClientRect() : { height: 0 };
    return { keys: cs.map((c) => c.getAttribute('data-pov').slice(4)),
             last: cs.length ? cs[cs.length - 1].getAttribute('data-pov').slice(4) : null,
             reach: !!(gv && gv.offsetParent && r.width > 40 && r.height > 20),
             rect: r ? [Math.round(r.width), Math.round(r.height)] : null,
             sameAsSib: !!sib && Math.abs(r.height - sr.height) < 3,
             txt: gv ? gv.textContent.trim() : null };
  });
  ok('🕺 Groove has a chip in the Variation strip', chips.keys.indexOf('groove') >= 0,
    JSON.stringify(chips.keys));
  ok('…and it is the LAST one — the 6th, bottom right', chips.last === 'groove',
    JSON.stringify(chips.keys));
  ok('…reachable, measured', chips.reach === true, JSON.stringify([chips.rect, chips.reach]));
  ok('…the same size as the chips beside it', chips.sameAsSib === true, JSON.stringify(chips));

  // THE CHIP IS THE DOOR. The group is hidden in place — its head is not a second
  // door — so the walk goes through the chip, which opens it as a popover by the
  // `_ambProgGrpPopover` move-the-live-node path its five neighbours use.
  console.log('\n  ✺ …and Jitter is INSIDE it');
  ok('a real touch on the 🕺 Groove chip opens it',
    await tap('[id$="prog-varbar"] [data-pov="grp:groove"]'));
  const jit = await page.evaluate(() => {
    const pop = document.querySelector('.ambient-grp-pop');
    const scope = pop || document;
    const bs = [...scope.querySelectorAll('.ambient-groove-noise')];
    const pk = bs.find((b) => b.dataset.gnoise === 'pink');
    const r = pk ? pk.getBoundingClientRect() : null;
    return { popped: !!pop,
             title: pop ? ((pop.querySelector('.sm-title') || {}).textContent || '') : '',
             n: bs.length, labels: bs.map((b) => b.textContent.trim()),
             mode: window._bloopsNoiseMode ? window._bloopsNoiseMode() : '?',
             reach: !!(pk && pk.offsetParent && r.width > 30 && r.height > 20),
             rect: r ? [Math.round(r.width), Math.round(r.height)] : null };
  });
  ok('…it opens as a popover, titled', jit.popped === true && /Groove/.test(jit.title),
    JSON.stringify([jit.popped, jit.title]));
  ok('the Jitter row is in the Groove panel the user actually opens',
    jit.n === 2 && JSON.stringify(jit.labels) === '["White","Pink"]', JSON.stringify(jit));
  ok('…measurable, not merely present', jit.reach === true, JSON.stringify([jit.rect, jit.reach]));
  ok('…and it starts on white', jit.mode === 'white', JSON.stringify(jit.mode));
  ok('a real touch lands on Pink', await tap('.ambient-grp-pop .ambient-groove-noise', 1));
  const flipped = await page.evaluate(() => ({
    mode: window._bloopsNoiseMode(),
    lit: ((document.querySelector('.ambient-groove-noise.active') || {}).dataset || {}).gnoise || '',
    hint: (document.querySelector('.ambient-groove-jitterhint') || {}).textContent || '',
  }));
  ok('…the switch flips and the panel follows it',
    flipped.mode === 'pink' && flipped.lit === 'pink' && /pink/.test(flipped.hint),
    JSON.stringify(flipped));
  // …and put it back, or the next section measures through the overlay
  await page.evaluate(() => { const d = document.querySelector('.ambient-grp-pop .sm-apply'); if (d) d.click(); });
  await zz(600);

  console.log('\n  ▭ the pane spaces evenly, and nothing shows twice');
  const lay = await page.evaluate(() => {
    const grps = [...document.querySelectorAll('[id$="-progsec"] .ambient-proggrp')].map((g) => {
      const b = g.getBoundingClientRect();
      return { id: (g.id || '').replace(/^.*proggrp-/, ''), vis: !!g.offsetParent,
               top: Math.round(b.top), bot: Math.round(b.bottom), h: Math.round(b.height) };
    });
    const vis = grps.filter((g) => g.vis && g.h > 4).map((g) => g.id);
    const rows = grps.filter((g) => g.vis && g.h > 4);
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(rows[i].top - rows[i - 1].bot);
    const ar = document.querySelector('[id$="prog-actionrow"]');
    return { vis, gaps, rowH: ar ? Math.round(ar.getBoundingClientRect().height) : null,
             grooveHidden: !grps.find((g) => g.id === 'groove').vis };
  });
  // \ud83d\udd7a Groove's chip IS its door. Left visible in place as well, the pane grew a
  // second door to the same thing — `_ambProgGrpSync`'s list is hardcoded and a new
  // pop group left out of it is not hidden.
  ok('the 🕺 Groove GROUP is hidden in place — the chip is its only door',
    lay.grooveHidden === true, JSON.stringify(lay.vis));
  // The empty actions row (`#ambient-prog-sub` + a hidden hint) is 13px of nothing once
  // changes are on. Harmless when it was first in the pane; under ♯ Key it read as a gap.
  ok('…the empty actions row collapses', lay.rowH === 0, JSON.stringify(lay.rowH));
  ok('…so every group is spaced the same', !!lay.gaps.length &&
    lay.gaps.every((g) => Math.abs(g - lay.gaps[0]) < 3), JSON.stringify([lay.vis, lay.gaps]));

  console.log('\n  ♯ Key moved, it did not die');
  await page.evaluate(() => { const d = document.querySelector('.ambient-grp-pop .sm-apply'); if (d) d.click(); });
  await zz(600);
  const key = await page.evaluate(() => {
    const g = document.querySelector('[id$="proggrp-keysec"]');
    if (!g) return { err: 'the Key subsection is gone entirely' };
    const inArr = !!g.closest('[id$="-progsec"]');
    const h = g.querySelector('.ambient-grp-head');
    h.scrollIntoView({ block: 'center' });
    const r = h.getBoundingClientRect();
    return { inArr, txt: h.textContent.trim(),
             reach: !!(h.offsetParent && r.width > 40 && r.height > 20),
             rect: [Math.round(r.width), Math.round(r.height)] };
  });
  ok('♯ Key lives inside ⇶ Arrangement now', !key.err && key.inArr === true, JSON.stringify(key));
  ok('…and its door is reachable, measured', key.reach === true, JSON.stringify(key));
  ok('a real touch opens it', await tap('[id$="proggrp-keysec"] .ambient-grp-head'));
  const inner = await page.evaluate(() => {
    const t = document.querySelector('[id$="key-toggle"]');
    const ind = document.querySelector('[id$="cfg-keyind"]');
    const r = t ? t.getBoundingClientRect() : null;
    return { toggle: !!t, ind: !!ind,
             reach: !!(t && t.offsetParent && r.width > 40 && r.height > 14),
             rect: r ? [Math.round(r.width), Math.round(r.height)] : null,
             // the ids the wiring binds to must have survived the move
             body: !!document.querySelector('[id$="keysec-body"]'),
             pane: !!document.querySelector('[id$="-keysec"]:not([id*="proggrp"])') };
  });
  ok('…the Chromatic⟷Key toggle came with it, and is reachable',
    inner.toggle && inner.reach === true, JSON.stringify(inner));
  ok('…and every id its wiring binds to survived the move',
    inner.ind && inner.body && inner.pane, JSON.stringify(inner));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
