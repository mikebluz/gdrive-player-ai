// PROBE — ⬚ Multi: a ruler tap gathers every note in that region.
//
// user, 2026-09-23: "in Multi mode, selecting the bar should select all note
// events in the bar".
//
// The ruler already answers "which bars" for 🎲 New take. The claim here is
// that it means the SAME THING in ⬚ Multi — pick this region — and only what
// is picked changes with the mode. So these checks are about the two readings
// staying one implementation: the same bar, the same chord span, a toggle that
// behaves like every other Multi press, and the open plot still meaning "miss".
//
//   node test/probe-multi-bar.js     (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(1300);

  // TWO BARS, TWO NOTES IN EACH — so "all of bar 2" and "everything" are
  // different answers and a check cannot pass by selecting the lot.
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.form;
    L.part.kind = 'recorded';
    L.part.bars = 2;
    L.part.notes = [
      { t: 0.05, midi: 60, dur: 0.06 },
      { t: 0.30, midi: 64, dur: 0.06 },
      { t: 0.55, midi: 67, dur: 0.06 },
      { t: 0.80, midi: 71, dur: 0.06 },
    ];
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(900);
  await page.evaluate(() => {
    [...document.querySelectorAll('.v2-layer')].forEach((c) => {
      if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
    });
  });
  await zz(900);
  await page.evaluate(() => {
    const sel = document.querySelector('.v2-modepick');
    sel.value = 'multi';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(1200);

  const fix = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    return { mode: window._v2.viewMode(), n: (L.part.notes || []).length,
             ts: (L.part.notes || []).map((x) => x.t), cv: !!cv, geo: !!(cv && cv._barsGeo) };
  });
  console.log('\n  fixture: ' + JSON.stringify(fix));
  ok('four notes, two to a bar, and the drawing is up',
    fix.n === 4 && fix.cv && fix.geo && fix.mode === 'edit', JSON.stringify(fix));

  // ── WHERE A BAR IS ON SCREEN ────────────────────────────────────────────
  // One inverse of the draw's own mapping. The bar NUMBERS are the row under
  // the chord band, so the y is between the two — a y of 8 lands in the band
  // when a progression draws one.
  const at = async (bar) => page.evaluate((bar) => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect(), g = cv._barsGeo, pg = cv._pitchGeo, cg = cv._chordGeo;
    const vsc = (g.vsc > 0) ? g.vsc : 1, f0 = g.f0 || 0;
    const fr = (bar + 0.5) / g.barsF;
    const x = r.left + (g.x0 || 0) + ((fr - f0) / vsc) * g.w;
    const y = r.top + (cg && cg.top ? (cg.top + pg.top) / 2 : Math.max(4, pg.top / 2));
    return { x, y };
  }, bar);
  const plotAt = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect(), pl = cv._plotGeo, pg = cv._pitchGeo;
    const y = r.top + pg.top + Math.min(70, Math.max(20, (r.bottom - (r.top + pg.top)) * 0.5));
    const x = r.left + pl.x0 + pl.w * 0.45;
    const el = document.elementFromPoint(x, y);
    return { x, y, inView: y < window.innerHeight && y > 0,
             el: el && (el.className || el.tagName) };
  });
  const held = () => page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const bar = document.querySelector('.v2-layer .v2-multibar');
    return { sel: (window._v2.multiSel(L) || []).slice().sort((a, b) => a - b),
             barHidden: !bar || bar.hidden,
             txt: (document.querySelector('.v2-layer .v2-multin') || {}).textContent || '' };
  });

  const b2 = await at(1);
  await page.mouse.click(b2.x, b2.y);
  await zz(500);
  const one = await held();
  console.log('  bar 2: ' + JSON.stringify(one));
  // THE WHOLE REQUEST, in one check.
  ok('a tap on bar 2 gathers every note in bar 2 — and only those',
    one.sel.join(',') === '2,3', JSON.stringify(one.sel));
  ok('…and the count on the card says so', !one.barHidden && /2 notes gathered/.test(one.txt),
    JSON.stringify(one));

  // TOGGLING, like every other ⬚ Multi press.
  await page.mouse.click(b2.x, b2.y);
  await zz(500);
  const off = await held();
  ok('…a second tap on a bar already gathered whole gives it back',
    off.sel.length === 0 && off.barHidden, JSON.stringify(off));

  // TWO BARS ADD UP, and the second tap must not replace the first.
  const b1 = await at(0);
  await page.mouse.click(b1.x, b1.y);
  await zz(450);
  const first = await held();
  await page.mouse.click(b2.x, b2.y);
  await zz(450);
  const both = await held();
  console.log('  bar 1 then 2: ' + JSON.stringify(first.sel) + ' → ' + JSON.stringify(both.sel));
  ok('a tap on bar 1 gathers ITS notes', first.sel.join(',') === '0,1', JSON.stringify(first.sel));
  ok('…and bar 2 ADDS to the gathering rather than replacing it',
    both.sel.join(',') === '0,1,2,3', JSON.stringify(both.sel));

  // THE OPEN PLOT STILL MEANS "MISS" — one gesture, one meaning.
  await page.mouse.click(plotAt.x, plotAt.y);
  await zz(450);
  const cleared = await held();
  console.log('  plot tap at ' + JSON.stringify(plotAt));
  // THE TAP MUST LAND ON THE CANVAS, or "nothing happened" passes for the
  // wrong reason — the first cut of this check tapped 70px below the plot, off
  // the element entirely, and read the unchanged gathering as a clear.
  ok('a tap in the open plot still means "gather nothing"',
    String(plotAt.el).indexOf('v2-vizcv') >= 0 && plotAt.inView &&
    cleared.sel.length === 0 && cleared.barHidden,
    JSON.stringify({ where: plotAt.el, ...cleared }));

  // …AND THE RULER DID NOT QUIETLY BECOME A BAR SELECT AS WELL. ⬚ Multi and
  // 🎲 New take read the same strip; a press must not do both.
  const bsel = await page.evaluate(() =>
    (document.querySelector('.v2-layer .v2-vizlab') || {}).textContent || '');
  await page.mouse.click(b2.x, b2.y);
  await zz(450);
  const bsel2 = await page.evaluate(() =>
    (document.querySelector('.v2-layer .v2-vizlab') || {}).textContent || '');
  ok('…and it does NOT also arm a 🎲 New take bar selection',
    !/re-rolling|retaking/.test(bsel2), JSON.stringify({ before: bsel.slice(0, 60), after: bsel2.slice(0, 60) }));

  // THE OTHER READING OF THE SAME STRIP still works — leave ⬚ Multi and the
  // ruler goes back to picking bars for 🎲 New take.
  await page.evaluate(() => {
    const sel = document.querySelector('.v2-modepick');
    sel.value = 'edit';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(900);
  const b2b = await at(1);
  await page.mouse.click(b2b.x, b2b.y);
  await zz(500);
  const lab = await page.evaluate(() =>
    (document.querySelector('.v2-layer .v2-vizlab') || {}).textContent || '');
  ok('out of ⬚ Multi the same tap picks the bar for 🎲 New take again',
    /re-rolling|retaking/.test(lab), lab.slice(0, 140));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
