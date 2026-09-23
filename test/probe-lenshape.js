// PROBE — ⌁ Length shape: a figure of length AND weight, and it outranks.
//
// user, 2026-09-23: "I want to be able to insert more excitement and interest
// into generated part, starting from something straightforward and aligned to
// the part", then "it should be parallel to the current length/accent controls
// (if this one is active it overrides those other ones)".
//
// Note length is ONE number and Length vary scatters it at random, so a line
// could be even or noisy and nothing in between. A shape is the missing
// middle: a short repeating figure over the BAR — the same unit ♦ Beat's lanes
// and ⊞ Resolution are written in, which is what keeps it recognisable when
// the part grows.
//
//   node test/probe-lenshape.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const x = c.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !c.classList.contains('v2-gz-2')) x.click();
  });
  await zz(900);

  // ── THE DOOR ────────────────────────────────────────────────────────────
  const door = await page.evaluate(() => {
    const sel = document.querySelector('.v2-layer .v2-f[data-f="part.shape.lenShape"]');
    if (!sel) return { there: false };
    const row = sel.closest('.ambient-ctrl');
    const r = row.getBoundingClientRect();
    return { there: true, tag: sel.tagName,
             reachable: r.width > 0 && r.height > 0 && !!sel.offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1,
             primary: row.classList.contains('v2-primary'),
             opts: [...sel.options].map((o) => o.value),
             value: sel.value };
  });
  console.log('\n  ⌁ door: ' + JSON.stringify(door));
  ok('⌁ Length shape is a primary main knob, on screen and fitting 390px',
    door.there && door.reachable && door.inView && door.primary, JSON.stringify(door));
  ok('…off by default, with the figures to choose from',
    door.value === '' && door.opts.length >= 6 && door.opts.indexOf('longshort') >= 0,
    JSON.stringify(door.opts));

  // ── IT SHAPES WHAT PLAYS ────────────────────────────────────────────────
  const play = async (shape, lenVary, accent) => page.evaluate(async (shape, lenVary, accent) => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    L.part.bars = 2;
    L.part.shape = Object.assign({}, L.part.shape, { lenRatio: 70 });
    if (shape) L.part.shape.lenShape = shape; else delete L.part.shape.lenShape;
    L.lenVary = lenVary; L.accent = accent;
    E.getCfg();
    await new Promise((r) => setTimeout(r, 250));
    const l = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(l, E.getCfg());
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
      { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [];
    return { durs: ns.map((x) => Math.round(x.durMs || 0)),
             ws: ns.map((x) => (Number.isFinite(x.shw) ? Math.round(x.shw * 100) / 100 : null)) };
  }, shape, lenVary, accent);

  const flat = await play('', 0, 0);
  const ls = await play('longshort', 0, 0);
  const stab = await play('stab', 0, 0);
  console.log('  off:        ' + JSON.stringify(flat.durs.slice(0, 8)));
  console.log('  long-short: ' + JSON.stringify(ls.durs.slice(0, 8)) + '  weights ' + JSON.stringify(ls.ws.slice(0, 4)));
  console.log('  stabs:      ' + JSON.stringify(stab.durs.slice(0, 8)) + '\n');

  ok('with no shape every note is the same length',
    new Set(flat.durs).size === 1, JSON.stringify(flat.durs.slice(0, 6)));
  // A FIGURE, NOT NOISE: long-short alternates, and it alternates the SAME way
  // every bar — that is the whole difference from Length vary.
  ok('Long – short alternates long and short',
    ls.durs[0] > ls.durs[1] && ls.durs[2] > ls.durs[3] &&
    ls.durs[0] === ls.durs[2] && ls.durs[1] === ls.durs[3],
    JSON.stringify(ls.durs.slice(0, 6)));
  ok('…and repeats identically in the next bar, so it is a figure',
    ls.durs[0] === ls.durs[4] && ls.durs[1] === ls.durs[5],
    JSON.stringify(ls.durs.slice(0, 8)));
  ok('…carrying a weight, so the long note is the leaned-on one',
    ls.ws[0] > 1 && ls.ws[1] < 1, JSON.stringify(ls.ws.slice(0, 4)));
  ok('Stabs clips every note evenly',
    new Set(stab.durs).size === 1 && stab.durs[0] < flat.durs[0],
    JSON.stringify({ stab: stab.durs[0], off: flat.durs[0] }));

  // ── AND IT OUTRANKS ─────────────────────────────────────────────────────
  // "if this one is active it overrides those other ones" — so a shape with
  // Length vary cranked must still be the figure, not the figure plus noise.
  const noisy = await play('longshort', 90, 90);
  const same = JSON.stringify(noisy.durs) === JSON.stringify(ls.durs);
  console.log('  long-short + vary 90 + accent 90: ' + JSON.stringify(noisy.durs.slice(0, 8)) + '\n');
  ok('Length vary is ignored while a shape is set',
    same, JSON.stringify({ withVary: noisy.durs.slice(0, 4), without: ls.durs.slice(0, 4) }));

  // …and the card SAYS they are outranked rather than leaving live knobs that
  // quietly do nothing.
  const greyed = await page.evaluate(async () => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.part.shape = Object.assign({}, L.part.shape, { lenShape: 'longshort' });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 900));
    const st = (f) => {
      const el = document.querySelector('.v2-layer .v2-f[data-f="' + f + '"]');
      const row = el && el.closest('.ambient-ctrl');
      return row ? { na: row.classList.contains('v2-rowna'), shown: !!row.offsetParent } : null;
    };
    return { len: st('part.shape.lenRatio'), vary: st('lenVary') };
  });
  console.log('  outranked rows: ' + JSON.stringify(greyed) + '\n');
  ok('Note length and Length vary grey while a shape is on, rather than vanishing',
    !!greyed.len && greyed.len.na === true && greyed.len.shown === true &&
    !!greyed.vary && greyed.vary.na === true,
    JSON.stringify(greyed));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
