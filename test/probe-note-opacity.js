// PROBE — a quieter note is drawn fainter.
//
// user, 2026-09-23: "loudness/accent of each note event in visualizer should
// be visualized as opacity".
//
// Alpha already carried a meaning — the take fade, which says how many of the
// coming passes play this note — so the two are COMBINED and floored rather
// than one overwriting the other. Checked twice over: the alpha the picture
// publishes for each note, and the PIXELS it actually put on the canvas.
//
//   node test/probe-note-opacity.js     (needs `npm start`; BLOOPS_URL to retarget)
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

  // ── A WRITTEN PART WITH DYNAMICS ────────────────────────────────────────
  // Four notes at four volumes, one per bar, all on the same pitch so the only
  // thing that can differ in the picture is how solid they are.
  const drawn = await page.evaluate(async () => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    delete L.part.form;
    L.part.kind = 'recorded';
    L.part.bars = 4;
    L.part.notes = [
      { t: 0.00, midi: 48, dur: 0.12, vel: 100 },
      { t: 0.25, midi: 48, dur: 0.12, vel: 70 },
      { t: 0.50, midi: 48, dur: 0.12, vel: 40 },
      { t: 0.75, midi: 48, dur: 0.12, vel: 100 },
    ];
    E.getCfg();
    // WHAT THE CANVAS WAS ACTUALLY TOLD. A published number the paint ignores
    // is the exact bug this drawing keeps producing — and pixel sampling could
    // not tell the note from its background here, so the alpha is recorded at
    // the moment of the fill instead. Decisive, and it cannot be faked by the
    // value the picture claims.
    const proto = CanvasRenderingContext2D.prototype;
    if (!window.__fillPatched) {
      window.__fillPatched = 1;
      const orig = proto.fill;
      proto.fill = function () { try { (window.__fillA = window.__fillA || []).push(Math.round(this.globalAlpha * 1000) / 1000); } catch (e) {} return orig.apply(this, arguments); };
    }
    window.__fillA = [];
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 1300));
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    if (!cv) return { err: 'no canvas' };
    const hits = (cv._hits || []).slice().sort((a, b) => a.x - b.x);
    // …AND THE PIXELS. The published alpha is the picture's claim; this is what
    // it actually painted. Sampled at the middle of each block, in DEVICE
    // pixels — the canvas is scaled by dpr and `_hits` is in CSS pixels.
    const g = cv.getContext('2d');
    const sx = cv.width / Math.max(1, cv.clientWidth);
    const sy = cv.height / Math.max(1, cv.clientHeight);
    return { n: hits.length, alphas: hits.map((ht) => ht.a),
             filled: (window.__fillA || []).slice() };
  });

  console.log('  published alpha: ' + JSON.stringify(drawn.alphas));
  const fillAlphas = (drawn.filled || []).filter((a) => a < 1);
  console.log('  alphas the canvas filled with (<1): ' + JSON.stringify(fillAlphas) + '\n');

  ok('the drawing published an alpha per note', !drawn.err && drawn.n === 4 &&
    drawn.alphas.every((a) => typeof a === 'number'), JSON.stringify(drawn));
  ok('a quieter note gets a lower alpha than a loud one',
    drawn.alphas[0] > drawn.alphas[1] && drawn.alphas[1] > drawn.alphas[2],
    JSON.stringify(drawn.alphas));
  ok('…the loudest is fully solid',
    drawn.alphas[0] === 1 && drawn.alphas[3] === 1, JSON.stringify(drawn.alphas));
  ok('…and the quietest is still clearly visible, not an outline',
    drawn.alphas[2] >= 0.4, String(drawn.alphas[2]));
  // THE PIXELS AGREE. A published number that the canvas ignores is exactly the
  // class of bug this drawing keeps producing, so the paint is measured too.
  ok('and the CANVAS was really told to paint them fainter, not just the number',
    fillAlphas.length >= 2 &&
    fillAlphas.indexOf(drawn.alphas[1]) >= 0 && fillAlphas.indexOf(drawn.alphas[2]) >= 0,
    JSON.stringify({ filled: fillAlphas, want: [drawn.alphas[1], drawn.alphas[2]] }));

  // ── A PART WITH NO DYNAMICS IS UNCHANGED ────────────────────────────────
  // Relative to the loudest note on screen, so a flat part draws exactly as it
  // always did — this must not quietly dim every existing picture.
  const flat = await page.evaluate(async () => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.part.notes = L.part.notes.map((n) => Object.assign({}, n, { vel: undefined }));
    L.part.notes.forEach((n) => { delete n.vel; });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 1200));
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    return (cv._hits || []).map((ht) => ht.a);
  });
  console.log('  no dynamics: ' + JSON.stringify(flat) + '\n');
  ok('a part with no dynamics draws every note solid, as before',
    flat.length > 0 && flat.every((a) => a === 1), JSON.stringify(flat));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
