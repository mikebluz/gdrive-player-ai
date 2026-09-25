// PROBE — nothing on screen may lead the ear.
//
// user, 2026-09-24: "playback is out of sync with visual/playhead again;
// playhead starts and then music starts shortly after so it's out of sync".
//
// MEASURED CAUSE: a press schedules the first voices a LEAD ahead — 0.350 s on
// a cold press, 0.06 s warm — and everything musical is correctly pinned to it
// (`_barGridAnchor`, `_progAnchor` and the layer's phase all agree). The ⌗ Roll
// sweep stays dark through that window. The ▦ Pattern step grid did not: it
// clamped to step 1 and lit it, which reads as the playhead starting early.
//
// So the claim here is one rule for every playhead: while `now < startAt`,
// NOTHING is lit — and the moment the cycle begins, something is.
//
//   node test/probe-preroll.js       (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(1400);
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.notes;
    L.part.kind = 'euclid';
    L.part.bars = 2;
    L.part.form = 'steps';
    L.part.grid = 8;
    L.part.rhythm = Object.assign({}, L.part.rhythm, { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 });
    // entering ▦ Pattern seeds the cells; setting `form` in config skips that door
    L.part.rhythm.cells = (window._v2.euclidCells(4, 16, 0) || []).map((c) => (c ? 1 : 0));
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'walk', degree: 1, span: 5 });
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
  await zz(800);

  const look = () => page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    const ps = E._v2Phase && E._v2Phase['v2:' + (L.id | 0)];
    let aud = 0;
    try { aud = (typeof _shapeAudibleNow === 'function') ? _shapeAudibleNow() : Tone.now(); }
    catch (e) { aud = Tone.now(); }
    const ph = document.querySelector('.v2-layer .v2-vizph');
    return { preroll: ps && Number.isFinite(ps.startAt) ? +(ps.startAt - aud).toFixed(3) : null,
             lit: document.querySelectorAll('.v2-layer .v2-cell.playing, .v2-layer .v2-lanecell.playing').length,
             sweep: !!(ph && ph._on),
             lead: (Number.isFinite(E._barGridAnchor) && Number.isFinite(E._playStartAt))
               ? +(E._barGridAnchor - E._playStartAt).toFixed(3) : null };
  });

  await page.evaluate(() => { _ambStartGenerator(_masterEng); });
  await zz(70);
  const early = await look();
  await zz(130);
  const mid = await look();
  await zz(300);
  const after = await look();
  await page.evaluate(() => { try { _ambStopGenerator(_masterEng); } catch (e) {} });
  console.log('\n  lead: ' + early.lead + 's');
  console.log('  pre  ' + JSON.stringify(early));
  console.log('  pre  ' + JSON.stringify(mid));
  console.log('  post ' + JSON.stringify(after));

  ok('a cold press really does schedule ahead — there is a window to get wrong',
    early.lead > 0.1 && early.preroll > 0.1, JSON.stringify({ lead: early.lead, preroll: early.preroll }));
  // THE REPORT, in one check.
  ok('▦ Pattern lights NOTHING while the first note is still in the future',
    early.lit === 0 && mid.lit === 0, JSON.stringify({ early: early.lit, mid: mid.lit }));
  ok('…and the ⌗ Roll sweep is dark through the same window',
    early.sweep === false && mid.sweep === false, JSON.stringify({ early: early.sweep, mid: mid.sweep }));
  // …AND IT IS NOT JUST DEAD. Once the cycle has begun, the grid reports.
  ok('…then the moment the cycle begins, the grid lights the step that is sounding',
    after.preroll < 0 && after.lit > 0, JSON.stringify(after));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
