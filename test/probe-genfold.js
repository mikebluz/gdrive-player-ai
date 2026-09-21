// PROBE — ✦ Generate's three zones are shut when it opens, and fold on a tap.
//
// user: "now Generate menu is feeling totally unwieldy, the 3 subsections
// should be collapsed by default (Material, Main Knobs, Fine Tune".
//
// Measured, not asserted: the panel's height with everything shut, each bar
// driven under a real finger, and the rows appearing and going again. The
// DRAWING deliberately stays on screen throughout — it sits between zone 1's
// bar and the scrolling band, so folding the zones does not take away the
// thing you are looking at.
//
//   node test/probe-genfold.js        (needs `npm start` on :3001)
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
  await page.evaluate(() => {
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
  });
  await zz(1400);

  const look = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const h = (sel) => { const e = card.querySelector(sel);
      return e ? Math.round(e.getBoundingClientRect().height) : -1; };
    // ZONE 1 HOLDS NO `.ambient-ctrl` AT ALL — its body is the material
    // PICKER (a bare select in `.v2-shaperow`), so counting rows there reads
    // 0 whether it is open or shut. Measure the BODY, which is the thing the
    // fold actually hides.
    const body = (gz) => { const e = card.querySelector('.v2-gzbody[data-gz="' + gz + '"]');
      return e ? Math.round(e.getBoundingClientRect().height) : -1; };
    const rows = (gz) => [...card.querySelectorAll('.v2-gzbody[data-gz="' + gz + '"] .ambient-ctrl')]
      .filter((r) => r.getBoundingClientRect().height > 0).length;
    return {
      panel: h('.v2-genpop'),
      bars: [...card.querySelectorAll('.v2-gzbar')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()),
      barsShown: [...card.querySelectorAll('.v2-gzbar')]
        .filter((b) => b.getBoundingClientRect().height > 0).length,
      viz: h('.v2-genwrap .v2-stageviz'),
      open: [1, 2, 3].filter((n) => card.classList.contains('v2-gz-' + n)),
      r1: rows(1), r2: rows(2), r3: rows(3),
      b1: body(1), b2: body(2), b3: body(3),
      picker: !!card.querySelector('.v2-gzbody[data-gz="1"] .v2-shapepick'),
    };
  });

  const shut = await look();
  console.log('\n  ✦ Generate as it opens:\n');
  console.log('   panel ' + shut.panel + 'px   drawing ' + shut.viz + 'px   open zones: ' +
    (shut.open.join(',') || 'none'));
  console.log('   rows showing — 1:' + shut.r1 + '  2:' + shut.r2 + '  3:' + shut.r3);
  console.log('   bars: ' + JSON.stringify(shut.bars) + '\n');

  ok('all three zones are shut when the panel opens',
    shut.open.length === 0 && shut.b1 === 0 && shut.b2 === 0 && shut.b3 === 0,
    JSON.stringify({ open: shut.open, b1: shut.b1, b2: shut.b2, b3: shut.b3 }));
  ok('…and the material picker is inside zone 1, not loose above it',
    shut.picker === true, JSON.stringify(shut.picker));
  ok('…but all three bars are still there to open', shut.barsShown === 3,
    shut.barsShown + ' bars on screen');
  ok('…and the drawing stays — folding does not take away the picture',
    shut.viz > 40, shut.viz + 'px tall');
  ok('zone 1 names the material while it is shut',
    /Play the changes/i.test(shut.bars[0] || ''), JSON.stringify(shut.bars[0]));

  // ── OPEN EACH ONE UNDER A REAL FINGER ───────────────────────────────────
  const tapBar = async (gz) => {
    const b = await page.evaluate((n) => {
      const x = document.querySelector('.v2-layer .v2-gzbar[data-gz="' + n + '"]');
      if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    }, gz);
    if (!b || !(b.w > 0)) return false;
    await page.touchscreen.tap(b.x, b.y);
    await zz(800);
    return true;
  };

  for (const gz of [1, 2, 3]) {
    if (!(await tapBar(gz))) { ok('zone ' + gz + ' bar is pressable', false, 'no rect'); continue; }
    const o = await look();
    const h = gz === 1 ? o.b1 : gz === 2 ? o.b2 : o.b3;
    const n = gz === 1 ? o.r1 : gz === 2 ? o.r2 : o.r3;
    ok('tapping zone ' + gz + ' opens it (' + h + 'px' +
         (gz === 1 ? ', the picker' : ', ' + n + ' rows') + ')',
      o.open.indexOf(gz) >= 0 && h > 20 && (gz === 1 || n > 0),
      JSON.stringify({ open: o.open, bodyH: h, rows: n }));
    // …and the others stay shut, so opening one is not opening all
    const others = [1, 2, 3].filter((k) => k !== gz);
    ok('…and zone ' + others.join(' & ') + ' stay shut',
      others.every((k) => o.open.indexOf(k) < 0),
      JSON.stringify(o.open));
    await tapBar(gz);   // shut it again for the next one
    await zz(300);
  }

  const back = await look();
  ok('tapping a bar again folds it away', back.open.length === 0,
    JSON.stringify(back.open));
  ok('…and the panel is back to its opening height',
    Math.abs(back.panel - shut.panel) <= 4,
    shut.panel + 'px → ' + back.panel + 'px');

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
