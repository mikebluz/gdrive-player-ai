// PROBE — a note on a bar line is DRAWN on that bar line.
//
// user, 2026-09-23: "the left border of the note events don't line up exactly
// with their starting line".
//
// TWO DERIVATIONS OF ONE X — this file's oldest recurring fault. A bar line is
// drawn at `Math.round(xF(…)) + 0.5`, snapped so a 1px stroke is crisp; a note
// was filled at the raw `xF(…)`. A note ON the bar started a fraction of a
// pixel off it, the canvas spread that fraction over two columns, and the eye
// read it as misaligned. The MUSIC was never off — the editor says "bar 4 ·
// beat 1" because the note is exactly there, which is why this went unnoticed
// through five reports about timing.
//
// MEASURED AGAINST THE PICTURE'S OWN PUBLISHED GEOMETRY (`_hits`, `_barsGeo`),
// never by re-deriving the mapping here — re-deriving it is the bug.
//
//   node test/probe-note-align.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c && c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(900);

  const measure = await page.evaluate(async () => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    // FOUR TO THE BAR OVER 8 BARS — every onset lands on a beat, and every
    // fourth one on a bar line. That is the case the report is about.
    L.part.kind = 'live';
    delete L.part.form;
    L.part.bars = 8;
    L.part.barsMode = 'fill';
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'fixed', degree: 1 });
    L.part.shape = Object.assign({}, L.part.shape, { lenRatio: 90 });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 1200));
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    if (!cv) return { err: 'no canvas' };
    const geo = cv._barsGeo, plot = cv._plotGeo, hits = cv._hits || [];
    if (!geo || !plot) return { err: 'no geometry published' };
    // THE PICTURE'S OWN BAR-LINE X, by the same expression the drawing uses.
    const VSC = geo.vsc || 1, F0 = geo.f0 || 0;
    const xF = (f) => geo.x0 + ((f - F0) / VSC) * geo.w;
    const barX = [];
    for (let b = 0; b <= Math.ceil(geo.barsF - 1e-6); b++) barX.push(Math.round(xF(b / geo.barsF)) + 0.5);
    // …and every note's drawn left edge, as published for hit-testing.
    const lefts = hits.map((ht) => ht.x).sort((a, b) => a - b);
    // For each bar line, is there a note whose left edge sits ON it?
    const offs = [];
    barX.forEach((bx) => {
      if (bx < geo.x0 - 1) return;
      // the line's own pixel column is [bx-0.5, bx+0.5)
      const near = lefts.filter((lx) => Math.abs(lx - (bx - 0.5)) < 6);
      if (!near.length) return;
      const best = near.reduce((a, b) => (Math.abs(a - (bx - 0.5)) <= Math.abs(b - (bx - 0.5)) ? a : b));
      offs.push(Math.round((best - (bx - 0.5)) * 1000) / 1000);
    });
    return { bars: geo.barsF, notes: hits.length, barLines: barX.length,
             offsets: offs, worst: offs.length ? Math.max.apply(null, offs.map(Math.abs)) : null,
             allInt: lefts.every((lx) => Math.abs(lx - Math.round(lx)) < 1e-9) };
  });
  console.log('\n  ' + JSON.stringify(measure) + '\n');
  ok('the drawing published its geometry and some notes',
    !measure.err && measure.notes > 0 && measure.barLines > 1, JSON.stringify(measure));
  // WHOLE PIXELS. A fractional left edge is what the canvas smears over two
  // columns, which is the whole of the complaint.
  ok('every note is drawn on a whole pixel',
    measure.allInt === true, 'some note lefts are fractional');
  // AND ON THE LINE. The bar line strokes the column starting at `bx - 0.5`,
  // so a note starting there shares its left edge exactly.
  ok('a note on a bar line starts exactly on that line',
    measure.worst === 0, 'worst offset ' + measure.worst + 'px — ' + JSON.stringify(measure.offsets));

  // ── AND A CHANGE LINE LANDS ON THE NOTE THAT STARTS ON IT ───────────
  // user, of a note beside a full-height change line: "still not exactly lined
  // up". A CHANGE is a third clock: `_ambChordSpanAt` bisects for its boundary
  // and this file already documents that the answer "carries float noise per
  // query", so bar 3 arrives as 0.37499997 and the rounding can fall a pixel
  // the other way from the note's.
  const chords = await page.evaluate(async () => {
    const E = _masterEng;
    const cfg = E.getCfg();
    cfg.prog.on = true;
    // Changes at bar 3 and bar 7 — both on a beat a note also starts on.
    cfg.prog.chords = [
      { root: 2, intervals: [0, 4, 7], bars: 3 },
      { root: 6, intervals: [0, 3, 7], bars: 4 },
      { root: 7, intervals: [0, 4, 7], bars: 1 }];
    cfg.barsPerChord = 2;
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; delete L.part.form;
    L.part.bars = 8; L.part.barsMode = 'fill';
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'fixed', degree: 1 });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 1300));
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    if (!cv) return { err: 'no canvas' };
    const xs = cv._chordX || [];
    const lefts = (cv._hits || []).map((ht) => ht.x);
    const deltas = xs.map((cx) => {
      const near = lefts.filter((lx) => Math.abs(lx - cx) < 8);
      if (!near.length) return null;
      const best = near.reduce((a, b) => (Math.abs(a - cx) <= Math.abs(b - cx) ? a : b));
      return best - cx;
    }).filter((d) => d !== null);
    return { lines: xs.length, xs: xs, deltas: deltas,
             worst: deltas.length ? Math.max.apply(null, deltas.map(Math.abs)) : null };
  });
  console.log('  change lines: ' + JSON.stringify(chords) + '\n');
  ok('the drawing published where it put its change lines',
    !chords.err && chords.lines > 0, JSON.stringify(chords));
  ok('a note starting on a change is drawn on that change line',
    chords.worst === 0,
    'worst ' + chords.worst + 'px \u2014 deltas ' + JSON.stringify(chords.deltas));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
