// PROBE — ⌫ Clear leaves a way back. ✦ Generate opens ⚙ Deep for EVERY part.
//
// user: "i cleared the part and now Generate menu is empty".
//
// ⌫ Clear leaves the part RECORDED with no notes — that is what it is for, and
// its own tooltip promises "the generated settings are kept, so ⚙ Deep brings
// them back". ✦ Generate was opening that panel only for a LIVE part, so a
// cleared one fell through to a sheet holding two recorded-only rows and no
// material picker: the promise could not be kept, and there was no door left.
//
// So this walks the reported path exactly — clear, then press ✦ Generate —
// and checks the panel opens with something to press.
//
//   node test/probe-genafterclear.js        (needs `npm start` on :3001)
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
  page.on('dialog', async (d) => { try { await d.accept(); } catch (e) {} });
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 6, intervals: [0, 3, 7] }, { root: 9, intervals: [0, 4, 7, 11] },
                       { root: 7, intervals: [0, 4, 7, 10] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = []; E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'comp');
    E.getCfg(); window._v2.render(E);
  });
  await zz(900);
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    if (card.classList.contains('collapsed')) card.querySelector('.ambient-collapse').click();
  });
  await zz(1000);

  // ── ⌫ CLEAR, through the same call the button makes ────────────────────
  const cleared = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    try { window._v2.clearPart(E, L); } catch (e) {}
    E.getCfg(); window._v2.render(E);
    const L2 = (E.getCfg().layers || [])[0];
    return { kind: L2.part.kind, notes: (L2.part.notes || []).length };
  });
  await zz(1000);
  console.log('\n  after ⌫ Clear: kind=' + cleared.kind + '  notes=' + cleared.notes + '\n');
  ok('⌫ Clear leaves the part recorded and empty — the reported state',
    cleared.kind === 'recorded' && cleared.notes === 0, JSON.stringify(cleared));

  // ── …then press ✦ Generate, as a person does ───────────────────────────
  const g = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.v2-layer .v2-gototab')]
      .find((x) => (x.getAttribute('data-goto') || '') === 'Generate');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  });
  if (!g || !(g.w > 0)) { console.log('  no ✦ Generate button'); await browser.close(); process.exit(2); }
  await page.touchscreen.tap(g.x, g.y);
  await zz(1400);

  const m = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const vis = (el) => { if (!el) return false;
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      deepOpen: card.classList.contains('v2-genopen'),
      sheet: !!card.querySelector('.v2-secpop-wrap'),
      bars: [...card.querySelectorAll('.v2-gzbar')].filter(vis).length,
      // the way back out of an empty part is the material picker
      picker: !!card.querySelector('.v2-gzbody[data-gz="1"] .v2-shapepick'),
      // …and the two recorded-only rows came along
      transpose: !!card.querySelector('.v2-genwrap [data-f="part.transpose"]'),
      quantize: !!card.querySelector('.v2-genwrap [data-f="harmony"]'),
    };
  });
  console.log('   Deep open: ' + m.deepOpen + '   zone bars: ' + m.bars +
              '   picker: ' + m.picker + '   Transpose/Quantize: ' +
              m.transpose + '/' + m.quantize + '\n');

  ok('✦ Generate opens ⚙ Deep on a CLEARED part, not an empty sheet',
    m.deepOpen === true && m.sheet === false,
    JSON.stringify({ deepOpen: m.deepOpen, sheet: m.sheet }));
  // TWO, not three: Fine-tune's bar is gated `kind:live` and a cleared part is
  // RECORDED, so zone 3 is correctly absent — those are generation knobs and a
  // stored note list ignores them. Material and Main knobs are what a cleared
  // part has, and Material is the one that matters here.
  ok('…with Material and Main knobs there (Fine-tune is live-only)',
    m.bars === 2, m.bars + ' bars');
  ok('…and the material picker inside, which is the way back',
    m.picker === true, JSON.stringify(m.picker));
  ok('Transpose and Pitch quantize moved into the panel with it',
    m.transpose === true && m.quantize === true,
    JSON.stringify({ transpose: m.transpose, quantize: m.quantize }));

  // ── AND THE WAY BACK ACTUALLY WORKS ────────────────────────────────────
  const back = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const z = card.querySelector('.v2-gzbar[data-gz="1"]');
    if (z && !card.classList.contains('v2-gz-1')) z.click();
    return true;
  });
  await zz(700);
  const regen = await page.evaluate(() => {
    const sel = document.querySelector('.v2-layer .v2-gzbody[data-gz="1"] .v2-shapepick');
    const r = sel ? sel.getBoundingClientRect() : null;
    if (sel) {
      sel.value = 'ground';
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { w: r ? Math.round(r.width) : 0 };
  });
  await zz(1100);
  const after = await page.evaluate(() => {
    const E = _masterEng;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const S = window._v2.stagedOf(id) || (E.getCfg().layers || [])[0];
    return { kind: S.part.kind, mat: S.part.mat };
  });
  console.log('   picker ' + regen.w + 'px → kind=' + after.kind + ' mat=' + after.mat + '\n');
  ok('the picker is a real target (not 0px in a shut zone)', regen.w > 80,
    regen.w + 'px');
  ok('…and choosing a material puts the part back to GENERATED',
    after.kind === 'live', JSON.stringify(after));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
