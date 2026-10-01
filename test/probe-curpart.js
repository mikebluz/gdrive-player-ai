// PROBE — ◫ PER PART FILES CONTENT UNDER THE PART THE ⇶ STRIP NAMES.
//
// user, 2026-09-27: "editing parts per layer is not working, when I go to generate a
// content for a part for a layer, it just switches back to the first part, not affecting
// the current part at all".
//
// `E._curPart` is TRANSIENT BY DESIGN (never persisted), so after a reload it is ABSENT
// while the strip, the card hues and every layer's `partFor` still say Chorus. Five sites
// inlined `Number.isFinite(E._curPart) ? … : 0` and so answered PART 1 — and two of them
// DECIDE WHERE CONTENT IS FILED (◫ Per part, and the ⟲ Locked rung). Measured before the
// fix: the strip said index 1, the pill filed the layer under index 0 and read
// "◫ Per part · 1 · Verse".
//
// The fix is one answer: `_ambCurPartEdit(E)` (v1's resolver, which falls back through a
// layer's persisted `partFor`), and `_ambRenderCurPart` LATCHES what it draws into
// `E._curPart` when the field is absent — never over an explicit pick.
//
// POISON-VERIFIED: removing the latch fails "`_curPart` is LATCHED to it". It fails only
// THAT one, because with other layers still filed per part `_ambCurPartEdit` derives the
// right answer anyway — the resolver covers the ordinary case, the latch covers the one
// where nothing is left to derive from. Both are needed; neither alone is the fix.
//
//   node test/probe-curpart.js        (needs `npm start` on :3001)
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
  const boot = async () => {
    await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
    await zz(1400);
  };
  // A REAL TOUCH, measured first — a `0×0` rect is the tell (the gate's own rule).
  const tap = async (sel) => {
    const at = await page.evaluate((s) => {
      const el = document.querySelector(s); if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!el.offsetParent || r.width < 4 || r.height < 4) return { bad: true };
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    if (!at || at.bad) return false;
    await page.touchscreen.tap(at.x, at.y); await zz(800); return true;
  };
  const addLayer = async () => {
    await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
      if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
    await zz(450);
    await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
      if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
    await zz(900);
  };

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500); await boot();
  // TWO PARTS OF DIFFERENT LENGTHS, so a record filed under the wrong one is visible
  // in its bars as well as in its key.
  await page.evaluate(() => {
    const E = _masterEng; const c = E.getCfg();
    const CH = (root, bars) => ({ root, intervals: [0, 4, 7], bars });
    c.prog.on = true; c.barsPerChord = 1;
    c.prog.chords = [CH(0, 1), CH(5, 1), CH(7, 2), CH(2, 2)];
    c.prog.parts = [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
  });
  await zz(400);
  await addLayer(); await addLayer();

  console.log('\n  ⇶ the axis survives a reload');
  await page.evaluate(() => { _ambCurPartChoose(_masterEng, 1); });   // park on Chorus
  await zz(700);
  await page.evaluate(() => { try { persistWorkspace(); } catch (e) {} });
  await zz(600);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await zz(3000); await boot();

  const re = await page.evaluate(() => {
    const E = _masterEng; const cfg = E.getCfg();
    return { latched: Number.isFinite(E._curPart) ? (E._curPart | 0) : 'UNSET',
             strip: (document.querySelector('.ambient-curpart-sel') || {}).value,
             edit: (typeof _ambCurPartEdit === 'function') ? _ambCurPartEdit(E) : '?',
             partFors: (cfg.layers || []).map((L) => L.partFor) };
  });
  ok('the strip still names Chorus after a reload', re.strip === '1', JSON.stringify(re));
  ok('…and `_curPart` is LATCHED to it, not left absent', re.latched === 1, JSON.stringify(re));
  ok('…the one resolver agrees', re.edit === 1, JSON.stringify(re));
  ok('…and every layer is still filed for it', JSON.stringify(re.partFors) === '[1,1]', JSON.stringify(re.partFors));

  console.log('\n  ◫ the pill files under the part the strip names');
  // layer 1 back to ▭ Everywhere; layer 2 stays filed, which is the ordinary shape
  await page.evaluate(() => {
    const E = _masterEng;
    window._v2.partSelect(E, E.getCfg().layers[0], null);
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(700);
  ok('the card opens', await tap('.v2-layer .ambient-collapse'));
  const pre = await page.evaluate(() => {
    const p = document.querySelector('.v2-pop-pp');
    const r = p ? p.getBoundingClientRect() : null;
    return { text: p ? p.textContent.trim() : null,
             reach: !!(p && p.offsetParent && r.width > 20 && r.height > 14) };
  });
  ok('the ▭/◫ pill is reachable, measured', pre.reach === true, JSON.stringify(pre));
  ok('…and says the layer is on one content', /Everywhere/.test(pre.text || ''), JSON.stringify(pre.text));

  ok('a real touch lands on it', await tap('.v2-pop-pp'));
  const after = await page.evaluate(() => {
    const E = _masterEng; const L = E.getCfg().layers[0];
    const p = document.querySelector('.v2-pop-pp');
    return { partFor: Number.isFinite(L.partFor) ? (L.partFor | 0) : 'unset',
             bars: L.part ? L.part.bars : null,
             pill: p ? p.textContent.trim() : null,
             strip: (document.querySelector('.ambient-curpart-sel') || {}).value };
  });
  ok('◫ Per part files the layer under CHORUS, the part the strip names',
    after.partFor === 1 && after.strip === '1', JSON.stringify(after));
  ok('…the pill says so in that part’s own words', /Chorus/.test(after.pill || ''), JSON.stringify(after.pill));
  ok('…and the record took Chorus’s length, not Verse’s', after.bars === 4, JSON.stringify(after.bars));

  console.log('\n  ⟲ and so does the Locked rung');
  const lock = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng; const L = E.getCfg().layers[0];
    // PER PART OUTRANKS THE CLOCK (`cycModeOf`), so while the layer is filed per part
    // the Cycle ladder is GATED AWAY — `.v2-cycmode` is not in the DOM at all, which is
    // not a finding. Un-file, then REBUILD, or the walk below looks for a row that the
    // last render had no reason to draw.
    window._v2.partSelect(E, L, null); E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(500);
    const card = () => document.querySelector('.v2-layer[data-v2id="' + (L.id | 0) + '"]');
    const cd = card(); if (cd) cd.classList.remove('collapsed');
    await wait(300);
    // WALK THE DOORS to it — the group it is filed under, then its own tab.
    const seen = () => { const el = card() && card().querySelector('.v2-cycmode');
      return (el && el.offsetParent) ? el : null; };
    let sel = seen();
    if (!sel) {
      const anchor = card() && card().querySelector('.v2-cycmode');
      const grp = anchor ? ((anchor.closest('[data-v2g]') || {}).dataset || {}).v2g : null;
      const want = anchor ? ((anchor.closest('[data-v2tab]') || {}).dataset || {}).v2tab : null;
      if (grp) {
        const head = card().querySelector('[data-v2grp="' + grp + '"] .ambient-grp-head');
        if (head) { head.click(); await wait(600); sel = seen(); }
      }
      if (!sel && want) {
        const t = card().querySelector('.v2-pop-tabs [data-tab="' + want + '"]');
        if (t) { t.click(); await wait(400); sel = seen(); }
      }
    }
    if (!sel) return { err: 'no cycle select',
      inDom: document.querySelectorAll('.v2-cycmode').length,
      grps: [...card().querySelectorAll('[data-v2grp]')].map((g) => g.getAttribute('data-v2grp')),
      tabs: [...card().querySelectorAll('.v2-pop-tabs [data-tab]')].map((t) => t.dataset.tab) };
    sel.value = 'locked';
    // BOTH EVENTS — this card wires selects on `input` AND `change` (the documented
    // select rule in 18-layer-v2); dispatching only one can miss the arm.
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(800);
    const L2 = (E.getCfg().layers || []).find((x) => (x.id | 0) === (L.id | 0)) || {};
    return { part: (L2.lenSync || {}).part, passes: (L2.lenSync || {}).passes,
             bound: !!L2.lenSync, cyc: sel.value,
             curPart: Number.isFinite(E._curPart) ? (E._curPart | 0) : 'unset' };
  });
  ok('⟲ Locked binds to Chorus too, not to part 1', !lock.err && lock.part === 1,
    JSON.stringify(lock));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
