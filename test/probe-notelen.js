// PROBE — Note length is a main knob, and it drives what plays.
//
// user, 2026-09-23: "Where is note length setting in generate menu? It should
// be a primary value and highlighted".
//
// It was in ⚙ Deep ▸ Fine-tune ▸ Rhythm — two taps down, behind a tab — which
// is the wrong depth for the knob that decides whether a line is stabbed or
// legato. Its partner `lenVary` was deeper still, under ▸ Advanced: each die,
// so the value was buried and the thing that makes it BREATHE was buried under
// that.
//
//   node test/probe-notelen.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(700);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'bass';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1700);
  // THE MAIN KNOBS — step 2, the fold the user means by "the generate menu".
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const x = c.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !c.classList.contains('v2-gz-2')) x.click();
  });
  await zz(900);

  const door = await page.evaluate(() => {
    const look = (f) => {
      const el = document.querySelector('.v2-layer .v2-f[data-f="' + f + '"]');
      if (!el) return { there: false };
      const row = el.closest('.ambient-ctrl');
      const r = row ? row.getBoundingClientRect() : el.getBoundingClientRect();
      return { there: true,
               reachable: r.width > 0 && r.height > 0 && !!el.offsetParent,
               inView: r.right <= document.documentElement.clientWidth + 1,
               primary: !!(row && row.classList.contains('v2-primary')),
               inFineTune: !!(row && row.className.indexOf('v2-ft') >= 0),
               label: row && row.querySelector('label') ? row.querySelector('label').textContent.trim() : null };
    };
    return { len: look('part.shape.lenRatio'), vary: look('lenVary') };
  });
  console.log('\n  Note length: ' + JSON.stringify(door.len));
  console.log('  Length vary: ' + JSON.stringify(door.vary) + '\n');

  ok('Note length is in the main knobs and on screen',
    door.len.there && door.len.reachable && door.len.inView, JSON.stringify(door.len));
  ok('…not behind a Fine-tune tab any more',
    door.len.inFineTune === false, JSON.stringify(door.len));
  ok('…and marked as a primary value',
    door.len.primary === true, JSON.stringify(door.len));
  ok('…with Length vary promoted beside it',
    door.vary.there && door.vary.reachable && door.vary.primary === true,
    JSON.stringify(door.vary));
  ok('…and it fits the card at 390px',
    door.len.inView && door.vary.inView, JSON.stringify({ len: door.len.inView, vary: door.vary.inView }));

  // ── AND IT DRIVES WHAT PLAYS ────────────────────────────────────────────
  // A control in the right place that changes nothing is the dead-door shape
  // this panel keeps weeding out, so the lengths are measured off the emitter.
  const durs = async (len, vary) => page.evaluate(async (len, vary) => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    L.part.shape = Object.assign({}, L.part.shape, { lenRatio: len });
    L.lenVary = vary;
    E.getCfg();
    await new Promise((r) => setTimeout(r, 300));
    const l = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(l, E.getCfg());
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
      { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [];
    const ds = ns.map((x) => Math.round(x.durMs || 0));
    return { n: ds.length, min: Math.min.apply(null, ds), max: Math.max.apply(null, ds),
             distinct: new Set(ds).size };
  }, len, vary);

  const short = await durs(20, 0);
  const long = await durs(100, 0);
  const varied = await durs(60, 70);
  console.log('  len 20: ' + JSON.stringify(short));
  console.log('  len 100: ' + JSON.stringify(long));
  console.log('  len 60 + vary 70: ' + JSON.stringify(varied) + '\n');

  ok('a short Note length makes shorter notes than a long one',
    short.max < long.min, JSON.stringify({ short: short.max, long: long.min }));
  ok('…and at 0 vary every note is the same length',
    short.distinct === 1 && long.distinct === 1,
    JSON.stringify({ short: short.distinct, long: long.distinct }));
  ok('…while Length vary makes them differ, which is the whole point of it',
    varied.distinct > 3 && varied.min < varied.max,
    JSON.stringify(varied));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
