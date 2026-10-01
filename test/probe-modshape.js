// PROBE — the mod Shape select on a v2 layer card.
//
// user, 2026-09-25: "not allowing me to select a different shape (selecting an
// option does nothing)".
//
// TWO DEFECTS, one root: v2 called `_ambWireModTarget` but never its partner
// `_ambSyncModShapeEl`, and that function wrote its controls unconditionally.
//
//  1. THE SHAPE'S DEPENDENT ROWS NEVER CAME BACK. Pick `custom` and the change
//     handler reveals the Harmonics row inline; the next render re-draws the
//     block at its STATIC defaults (hidden, H1=100), with `shape` still 'custom'.
//     Same for `seq`. The harmonic amounts never reflected the store at all.
//  2. `_ambSyncModShapeEl` HAD NO FOCUS GUARD — the one idiom every other sync in
//     17-ambient uses (`document.activeElement !== el`). A sync landing while the
//     native <select> picker is open puts the old shape back, and nothing in the
//     store or the console says so. That is the reported symptom exactly.
//
// Fixing (2) is what makes (1) safe to fix: syncing every pass would ITSELF stomp
// an open picker without the guard.
//
// ROUND TWO, 2026-09-26 — the report came back ("menu opens but when you select
// something it doesn't take, stays what it was"), because the fix above guarded
// ONE of TWO writers. `applyGate` kept a hand-rolled copy, `sh.value = mt.shape`,
// and both of its differences from the real function were bugs:
//   3. `mt.shape` IS NOT THE DROPDOWN VALUE for a sequence — the store says
//      `shape: 'seq'` + `seqRef: n` and the option is `seq:<n>`, so the compare
//      never matched and the write set `'seq'`, which matches no option: the
//      select went to value "" and rendered option 0. Pick a saved sequence as
//      the VCA wave and it snapped straight back to `sine`. Measured.
//   4. that copy had NO FOCUS GUARD, in the function that runs on every gate
//      pass. A guard on one of two writers is not a guard.
// Both are gone: `applyGate` calls `_ambSyncModShapeEl` now, one writer.
// Mod also moved from Mix to FX in the same change (user: "move Mod to Fx"), so
// the reachability check here is group-agnostic on purpose.
//
//   node test/probe-modshape.js      (needs `npm start`; BLOOPS_URL to retarget)
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

  // the REAL lifecycle: init → card through the door → PANEL REBUILD → interact
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(500);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(600);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(700);

  const read = () => page.evaluate(() => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const q = (s) => document.getElementById('ambient-v2-' + id + '-' + s);
    const L = (_masterEng.getCfg().layers || []).find((x) => x && (x.id | 0) === id);
    const sel = q('mod-vca-shape'), r = sel ? sel.getBoundingClientRect() : null;
    const modAbsent = !(L && L.mod);
    return { displayed: (sel || {}).value, modAbsent,
             // ABSENT mod IS 'sine': an all-default matrix is pruned back to
             // absent by the normalizer, so "no mod object" and "every target on
             // a flat sine at depth 0" are one state.
             stored: ((L && L.mod || {}).vca || {}).shape || 'sine',
             partHidden: (q('mod-vca-partrow') || {}).hidden,
             seqHidden: (q('mod-vca-seqrow') || {}).hidden,
             h2: (q('mod-vca-part1') || {}).value,
             rect: r ? { w: Math.round(r.width), h: Math.round(r.height), par: !!sel.offsetParent } : null };
  });
  const set = (v) => page.evaluate((v) => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const s = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    s.value = v; s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  // TWO DOORS, not one: the CARD, and then the GROUP the Mod block lives in.
  // Opening only the card leaves every mod control 0×0 — which reads as "the
  // control is missing" rather than "its group is shut".
  const expand = () => page.evaluate(() => {
    const c = document.querySelector('.v2-layer'); if (!c) return null;
    if (c.classList.contains('collapsed')) {
      const h = c.querySelector('.ambient-layer-head,.v2-head,.ambient-grp-head'); if (h) h.click();
    }
    const id = c.getAttribute('data-v2id') | 0;
    const sel = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    const g = sel && sel.closest('.ambient-grp');
    if (g && !g.classList.contains('open')) {
      const gh = g.querySelector(':scope > .ambient-grp-head'); if (gh) gh.click();
    }
    return g ? g.getAttribute('data-v2grp') : null;
  });
  // A REBUILD RETURNS THE CARD TO COLLAPSED, so re-open it or every following
  // read measures 0×0 and reports the control missing rather than hidden.
  const render = async () => { await page.evaluate(() => { _ambRebuildMaster(); }); await zz(700);
    await expand(); await zz(400); };
  await expand(); await zz(600);


  // ---- 0. it is reachable at all --------------------------------------------
  console.log('\n  0. the control');
  const base = await read();
  ok('the Shape select measures on the card', base.rect && base.rect.w > 50 && base.rect.par,
    JSON.stringify(base.rect));
  const opts = await page.evaluate(() => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    return [...document.getElementById('ambient-v2-' + id + '-mod-vca-shape').options].map((o) => o.value);
  });
  ok('…offering every wave plus custom', opts.includes('sine') && opts.includes('sawtooth') && opts.includes('custom'),
    JSON.stringify(opts));

  // ---- 1. a plain shape sticks ----------------------------------------------
  console.log('\n  1. a plain wave');
  await set('sawtooth');
  const saw1 = await read();
  ok('picking sawtooth writes the store AND shows', saw1.displayed === 'sawtooth' && saw1.stored === 'sawtooth',
    JSON.stringify(saw1));
  await render();
  const saw2 = await read();
  ok('…and survives a panel rebuild', saw2.displayed === 'sawtooth' && saw2.stored === 'sawtooth',
    JSON.stringify(saw2));

  // ---- 2. the DEPENDENT ROWS — defect 1 -------------------------------------
  console.log('\n  2. custom → the Harmonics row, and it STAYS');
  await set('custom');
  const c1 = await read();
  ok('picking custom reveals Harmonics', c1.stored === 'custom' && c1.partHidden === false, JSON.stringify(c1));
  await render();
  const c2 = await read();
  ok('…and a render does NOT take it away again',
    c2.stored === 'custom' && c2.displayed === 'custom' && c2.partHidden === false, JSON.stringify(c2));
  await page.evaluate(() => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const e = document.getElementById('ambient-v2-' + id + '-mod-vca-part1');
    e.value = '77'; e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await render();
  const c3 = await read();
  ok('…and a stored harmonic amount is drawn back, not reset to its default',
    c3.h2 === '77', JSON.stringify(c3));

  await set('sine');
  await render();
  const s1 = await read();
  ok('going back to a plain wave hides Harmonics again',
    s1.stored === 'sine' && s1.partHidden === true, JSON.stringify(s1));
  ok('…and an all-default matrix is pruned back to absent, not stored flat',
    s1.modAbsent === true, JSON.stringify(s1));

  // ---- 3. THE FOCUS GUARD — defect 2 ----------------------------------------
  console.log('\n  3. a sync must never overwrite an open picker');
  await set('smooth');            // materialise the matrix — absent has nothing to sync
  await zz(300);
  const guard = await page.evaluate(() => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const s = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    const L = (_masterEng.getCfg().layers || []).find((x) => x && (x.id | 0) === id);
    const el = (suf) => document.getElementById('ambient-v2-' + id + '-' + suf);
    // HEADLESS WILL NOT FOCUS A <select> — activeElement stays BODY — so force the
    // one fact the guard reads. This tests the GUARD, not the browser.
    const real = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => s });
    s.value = 'sharp';                            // picked, picker still open
    _ambSyncModShapeEl(el, L.mod.vca, 'vca');     // a sync lands mid-pick
    const focused = s.value;
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
    s.value = 'sharp';
    _ambSyncModShapeEl(el, L.mod.vca, 'vca');
    const blurred = s.value;
    Object.defineProperty(document, 'activeElement', real);
    return { focused, blurred, stored: L.mod.vca.shape };
  });
  ok('while the select is FOCUSED the pick is left alone',
    guard.focused === 'sharp', JSON.stringify(guard));
  ok('…while UNFOCUSED the same sync still writes the stored value',
    guard.blurred === guard.stored && guard.blurred === 'smooth', JSON.stringify(guard));

  // ---- 4. it persists across a reload ---------------------------------------
  console.log('\n  4. across a reload');
  await set('rampdown');
  await zz(400);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await zz(3000);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(1200);
  await expand();
  await zz(800);
  const r1 = await read();
  ok('the shape comes back after a page reload, in the store and on screen',
    r1.stored === 'rampdown' && r1.displayed === 'rampdown', JSON.stringify(r1));

  // ---- 5. WHERE IT LIVES — Mod is a tab of FX now ---------------------------
  // (2026-09-26, user: "move Mod to Fx".) Group-agnostic everywhere else in this
  // file; asserted ONCE here, because a move is a delete plus an add and the
  // group that used to hold it must not still be offering the tab.
  console.log('\n  5. Mod is in FX, not Mix');
  const where = await page.evaluate(() => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const s2 = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    const g = s2 && s2.closest('.ambient-grp');
    return { grp: g && g.getAttribute('data-v2grp') };
  });
  ok('the mod matrix sits in the FX group', where.grp === 'FX', JSON.stringify(where));
  const sheet = await page.evaluate(async () => {
    const c = document.querySelector('.v2-layer');
    const open = async (g) => { const b = c.querySelector('.v2-gototab[data-goto="' + g + '"]');
      if (!b) return null; b.click(); await new Promise((r) => setTimeout(r, 450));
      const t = document.querySelector('.v2-layer .v2-pop-tabs'); if (!t) return null;
      const fx = t.querySelector('.v2-fxpick');
      return { chips: [...t.querySelectorAll('[data-tab]')].map((x) => x.getAttribute('data-tab')),
               opts: fx ? [...fx.options].map((o) => o.value) : null, val: fx && fx.value }; };
    const mix = await open('Mix');
    const fx = await open('FX');
    return { mix, fx };
  });
  await zz(400);
  ok('the Mix sheet no longer offers Mod',
    sheet.mix && sheet.mix.chips.indexOf('Mod') < 0, JSON.stringify(sheet.mix));
  ok('the FX stage picker offers it', sheet.fx && sheet.fx.opts && sheet.fx.opts.indexOf('Mod') >= 0,
    JSON.stringify(sheet.fx));
  ok('…and FX still LANDS on an effect, not on Mod', sheet.fx && sheet.fx.val === 'Delay',
    JSON.stringify(sheet.fx));

  // ---- 6. A SEQUENCE AS THE WAVE — defect 3 ---------------------------------
  // The one that reads exactly like the report. `applyGate`'s own copy of the
  // writer set `sh.value = 'seq'`, which matches no option, so the select blanked
  // to option 0 the instant a gate pass ran — and one runs on the pick itself.
  console.log('\n  6. a saved sequence as the wave');
  await page.evaluate(() => {
    if (typeof savedSequences === 'undefined') return;
    savedSequences.push({ name: 'Probe seq', steps: [{ note: 'C4', on: true }, { note: 'E4', on: true }] });
  });
  await render();
  const seqPick = await page.evaluate(async () => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const s2 = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    const opts = [...s2.options].map((o) => o.value);
    if (opts.indexOf('seq:0') < 0) return { err: 'no Sequence optgroup', opts };
    s2.value = 'seq:0'; s2.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const rd = () => { const L2 = (_masterEng.getCfg().layers || []).find((x) => x && (x.id | 0) === id);
      return { shape: ((L2.mod || {}).vca || {}).shape, ref: ((L2.mod || {}).vca || {}).seqRef }; };
    const out = { opts, afterPick: s2.value, store: rd() };
    // A GATE PASS, driven the way any value edit on this card drives one.
    const lv = document.querySelector('.v2-layer input.v2-f[id$="-level"]');
    if (lv) { lv.value = String(Math.max(0, (+lv.value || 70) - 1)); lv.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 450));
    const s3 = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    out.afterGate = s3 && s3.value;
    out.storeAfterGate = rd();
    out.seqRowShown = !(document.getElementById('ambient-v2-' + id + '-mod-vca-seqrow') || {}).hidden;
    return out;
  });
  ok('picking a sequence stores seq + its index',
    seqPick.store && seqPick.store.shape === 'seq' && (seqPick.store.ref | 0) === 0, JSON.stringify(seqPick));
  ok('…and the select still SHOWS it (not blanked back to option 0)',
    seqPick.afterPick === 'seq:0', JSON.stringify(seqPick));
  ok('…and a gate pass leaves it alone', seqPick.afterGate === 'seq:0', JSON.stringify(seqPick));
  ok('…with the Read/Curve/Rest sub-row revealed', seqPick.seqRowShown === true, JSON.stringify(seqPick));

  // ---- 7. THE GATE PASS RESPECTS AN OPEN PICKER — defect 4 -------------------
  // Same test as §3, one writer over: `applyGate`, which runs on every value
  // edit. Forcing `activeElement` is the only way to test a guard headlessly.
  console.log('\n  7. applyGate must not overwrite an open picker either');
  const guard2 = await page.evaluate(async () => {
    const id = document.querySelector('.v2-layer').getAttribute('data-v2id') | 0;
    const s2 = document.getElementById('ambient-v2-' + id + '-mod-vca-shape');
    const real = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => s2 });
    s2.value = 'triangle';                       // mid-pick: ahead of the store
    const lv = document.querySelector('.v2-layer input.v2-f[id$="-level"]');
    if (lv) { lv.value = String(Math.max(0, (+lv.value || 70) - 1)); lv.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 450));
    const focused = document.getElementById('ambient-v2-' + id + '-mod-vca-shape').value;
    Object.defineProperty(document, 'activeElement', real);
    const L2 = (_masterEng.getCfg().layers || []).find((x) => x && (x.id | 0) === id);
    return { focused, stored: ((L2.mod || {}).vca || {}).shape };
  });
  ok('a gate pass while the picker is open leaves the visible pick standing',
    guard2.focused === 'triangle', JSON.stringify(guard2));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
