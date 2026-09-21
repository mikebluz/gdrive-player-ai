// PROBE — ⚙ Deep's staged picture is a piano roll, not a barcode.
//
// user: "this visualizer also needs grid lines and a piano roll on the left
// and note readouts". It drew a bar grid and purple bars and nothing else: no
// pitch reference at all, so a semitone and an octave looked alike and no note
// could be named.
//
// Measured rather than asserted about, because a drawing has no DOM to query:
//   · the plot starts at a GUTTER, and the gutter is painted like a keyboard
//     (light ground, dark rows for the black keys) — read off the pixels
//   · `_pitchGeo` is published, which is what `paintSweep` needs to light the
//     sounding note and draw its readout (it was null, so the staged preview
//     got neither)
//   · the notes land on the rows that geometry claims
//   · a note name is drawn when there is room for one
//
//   node test/probe-stageroll.js        (needs `npm start` on :3001)
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
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] }, { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
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
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'held');
    E.getCfg(); window._v2.render(E);
  });
  await zz(900);
  // EXPAND, then open ⚙ Deep by its own button — the panel lives in the card
  // body, so opening it on a collapsed card lays the canvas out at 0×0 and
  // `stageVizDraw` bails before it paints anything at all.
  {
    const c = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      if (!card || !card.classList.contains('collapsed')) return null;
      const x = card.querySelector('.ambient-collapse'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (c) await page.touchscreen.tap(c.x, c.y);
    await zz(900);
  }
  await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-genbtn');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
  });
  await zz(1400);

  const m = await page.evaluate(() => {
    // `.v2-stagecv` MATCHES TWICE — ✨ Quick's canvas and ⚙ Deep's. Quick is
    // shut, so an unscoped query finds a zero-width canvas with no geometry.
    const cv = document.querySelector('.v2-layer .v2-genwrap .v2-stagecv');
    if (!cv) return { err: 'no staged canvas' };
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!(w > 0)) return { err: 'the staged canvas has no width — the card is still collapsed' };
    const pg = cv._pitchGeo, pl = cv._plotGeo;
    const g = cv.getContext('2d');
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // READ THE PIXELS. A gutter that is "there" in the code but painted the
    // same colour as the plot is not a keyboard, and only the bitmap knows.
    const at = (x, y) => {
      const d = g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    };
    const lum = (c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114);
    const top = (pg && pg.top) || 14;
    const rowH = (pg && pg.rowH) || 0;
    // sample the gutter down its length, and the plot just right of it
    const gutSamples = [], plotSamples = [];
    for (let i = 0; i < 12; i++) {
      const y = top + ((h - top) * (i + 0.5)) / 12;
      gutSamples.push(lum(at(4, y)));
      plotSamples.push(lum(at((pl ? pl.x0 : 0) + 6, y)));
    }
    const gutMax = Math.max.apply(null, gutSamples);
    const gutMin = Math.min.apply(null, gutSamples);
    const plotMax = Math.max.apply(null, plotSamples);
    return {
      w, h, x0: pl && pl.x0, pitchGeo: pg && { loM: pg.loM, hiM: pg.hiM, rowH: Math.round(pg.rowH * 10) / 10, top: pg.top },
      hits: (cv._hits || []).length,
      // the gutter must be BRIGHT (white keys) and have dark rows in it
      gutMax, gutMin, plotMax,
      // every hit must sit on the row its midi claims
      offRow: (cv._hits || []).filter((hh) => {
        if (!pg) return true;
        const want = pg.top + (pg.hiM - hh.midi) * pg.rowH;
        return Math.abs(want - hh.y) > 1.5;
      }).length,
      // every hit must start at or after the gutter
      inGutter: (cv._hits || []).filter((hh) => hh.x < (pl ? pl.x0 : 0) - 0.5).length,
    };
  });

  if (m.err) { console.log('  ' + m.err); await browser.close(); process.exit(2); }

  console.log('\n  ⚙ Deep’s staged canvas:\n');
  console.log('   ' + m.w + '×' + m.h + '   gutter x0=' + m.x0 + '   ' + m.hits + ' notes drawn');
  console.log('   pitch rows  ' + JSON.stringify(m.pitchGeo));
  console.log('   luminance   gutter ' + Math.round(m.gutMin) + '–' + Math.round(m.gutMax) +
              '   plot ' + Math.round(m.plotMax) + '\n');

  ok('the plot starts at a gutter rather than at the edge', (m.x0 | 0) >= 16,
    'x0 = ' + m.x0);
  ok('the gutter is painted like a keyboard — light ground, dark keys in it',
    m.gutMax > 150 && m.gutMin < 90,
    'gutter luminance ' + Math.round(m.gutMin) + '–' + Math.round(m.gutMax));
  ok('…and it is much lighter than the plot beside it', m.gutMax - m.plotMax > 80,
    'gutter ' + Math.round(m.gutMax) + ' vs plot ' + Math.round(m.plotMax));
  ok('it publishes `_pitchGeo`, which is what lights the sounding note',
    !!m.pitchGeo && m.pitchGeo.rowH > 0,
    JSON.stringify(m.pitchGeo));
  ok('the rows are tall enough to carry a note name', !!m.pitchGeo && m.pitchGeo.rowH >= 8,
    'rowH = ' + (m.pitchGeo && m.pitchGeo.rowH));
  ok('every note sits on the row its pitch claims', m.offRow === 0,
    m.offRow + ' of ' + m.hits + ' are off their row');
  ok('no note is drawn over the keyboard', m.inGutter === 0,
    m.inGutter + ' start left of the gutter');

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
