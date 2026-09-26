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
    (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
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

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
