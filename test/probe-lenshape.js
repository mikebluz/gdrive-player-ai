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

  // ── AND A SHAPED NOTE NEVER RUNS INTO THE NEXT ONE ───────────────
  // user, of the first cut: "length shapes are causing notes to pile on top of
  // each other". Note length is a PERCENTAGE OF THE GAP and its slider stops at
  // 100, so nothing could overlap; a multiplier above 1 broke that invariant.
  // WORST ON A SPARSE PART, where the gap is bars wide — which is the shape the
  // report came from ("4 onsets over 8 bars").
  const lap = async (shape, pulses, bars) => page.evaluate(async (shape, pulses, bars) => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    L.part.bars = bars;
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: pulses, rotate: 0 };
    L.part.shape = Object.assign({}, L.part.shape, { lenRatio: 100 });
    if (shape) L.part.shape.lenShape = shape; else delete L.part.shape.lenShape;
    L.lenVary = 0;
    E.getCfg();
    await new Promise((r) => setTimeout(r, 250));
    const l = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(l, E.getCfg());
    const ns = (V.withEdit(() => V.withTake(0, () => V.notesFor(l,
      { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [])
      .slice().sort((a, b) => a.at - b.at);
    // the worst overrun of a note past the NEXT onset, in ms
    let worst = 0;
    for (let i = 0; i < ns.length - 1; i++) {
      const end = ns[i].at + (ns[i].durMs || 0) / 1000;
      const nxt = ns[i + 1].at;
      if (nxt > ns[i].at + 1e-9) worst = Math.max(worst, Math.round((end - nxt) * 1000));
    }
    return { n: ns.length, worst: worst, durs: ns.map((x) => Math.round(x.durMs || 0)).slice(0, 6) };
  }, shape, pulses, bars);

  const sparseOff = await lap('', 4, 8);
  const sparseLS = await lap('longshort', 4, 8);
  const densePush = await lap('push', 16, 2);
  const denseSwell = await lap('swell', 16, 2);
  console.log('  sparse, off:        ' + JSON.stringify(sparseOff));
  console.log('  sparse, long-short: ' + JSON.stringify(sparseLS));
  console.log('  dense, push:        ' + JSON.stringify(densePush));
  console.log('  dense, swell:       ' + JSON.stringify(denseSwell) + '\n');

  ok('no shape never overlaps — the invariant this has to keep',
    sparseOff.worst === 0, 'overran by ' + sparseOff.worst + 'ms');
  ok('a shaped note stops at the next onset, even on a sparse part',
    sparseLS.worst === 0, 'overran by ' + sparseLS.worst + 'ms');
  ok('…and on every other figure too',
    densePush.worst === 0 && denseSwell.worst === 0,
    JSON.stringify({ push: densePush.worst, swell: denseSwell.worst }));
  // THE FIGURE MUST SURVIVE THE CAP — clamping every note to the gap would be
  // a shape that does nothing, which is the other way to fail this.
  ok('…and the figure is still a figure after the cap',
    new Set(sparseLS.durs).size > 1 && sparseLS.durs[0] !== sparseLS.durs[1],
    JSON.stringify(sparseLS.durs));
  // AND ON A DENSE LINE IT STILL ARTICULATES. `MIN_MS` — "never shorter than a
  // 16th of the bar" — is the right floor for random scatter and the wrong one
  // for a deliberate figure: on a 16th-note part `dm0` already equals it, so
  // the clamp refused every shortening and the shapes came out legato
  // (measured: every note 125ms, the figure invisible). Only the audibility
  // floor should stop an articulation.
  ok('a shape still articulates on a 16th-note line, where the scatter floor sits',
    densePush.durs[0] < sparseOff.durs[0] && densePush.durs[0] < 125 &&
    new Set(denseSwell.durs.slice(0, 6)).size > 1,
    JSON.stringify({ push: densePush.durs.slice(0, 3), swell: denseSwell.durs.slice(0, 6) }));

  // ── MORE FIGURES, AND THREE KNOBS THAT EDIT THEM ────────────────
  // user: "add more length shapes, also add some params so the user can edit
  // the shape". A menu of finished answers is a menu; Depth, Weight and Turn
  // make the table a starting point.
  const opts2 = await page.evaluate(() =>
    [...document.querySelectorAll('.v2-layer .v2-f[data-f="part.shape.lenShape"] option')]
      .map((o) => o.value).filter(Boolean));
  console.log('  figures: ' + JSON.stringify(opts2));
  ok('the figure list has grown',
    opts2.length >= 10 && ['gallop', 'pairs', 'downbeat', 'fade', 'arch']
      .every((k) => opts2.indexOf(k) >= 0), JSON.stringify(opts2));

  const tune = async (shape, depth, weight, turn) => page.evaluate(async (shape, depth, weight, turn) => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    L.part.bars = 2;
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    L.part.shape = Object.assign({}, L.part.shape,
      { lenRatio: 70, lenShape: shape, lenDepth: depth, lenWeight: weight, lenTurn: turn });
    L.lenVary = 0;
    E.getCfg();
    await new Promise((r) => setTimeout(r, 250));
    const l = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(l, E.getCfg());
    const ns = (V.withEdit(() => V.withTake(0, () => V.notesFor(l,
      { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [])
      .slice().sort((a, b) => a.at - b.at);
    return { durs: ns.map((x) => Math.round(x.durMs || 0)).slice(0, 8),
             ws: ns.map((x) => (Number.isFinite(x.shw) ? Math.round(x.shw * 100) / 100 : null)).slice(0, 4) };
  }, shape, depth, weight, turn);

  const full = await tune('longshort', 100, 100, 0);
  const half = await tune('longshort', 50, 100, 0);
  const flatD = await tune('longshort', 0, 100, 0);
  const noW = await tune('longshort', 100, 0, 0);
  const turned = await tune('longshort', 100, 100, 1);
  const gall = await tune('gallop', 100, 100, 0);
  console.log('  depth 100: ' + JSON.stringify(full.durs.slice(0, 4)) + '  weights ' + JSON.stringify(full.ws));
  console.log('  depth 50:  ' + JSON.stringify(half.durs.slice(0, 4)));
  console.log('  depth 0:   ' + JSON.stringify(flatD.durs.slice(0, 4)));
  console.log('  weight 0:  ' + JSON.stringify(noW.durs.slice(0, 4)) + '  weights ' + JSON.stringify(noW.ws));
  console.log('  turn 1:    ' + JSON.stringify(turned.durs.slice(0, 4)));
  console.log('  gallop:    ' + JSON.stringify(gall.durs.slice(0, 6)) + '\n');

  // DEPTH scales the departure from even, both ways.
  ok('Depth 50 is half the figure of Depth 100',
    half.durs[0] < full.durs[0] && half.durs[1] > full.durs[1] &&
    half.durs[0] > half.durs[1],
    JSON.stringify({ full: full.durs.slice(0, 2), half: half.durs.slice(0, 2) }));
  ok('…and Depth 0 is flat, which is what Off means',
    new Set(flatD.durs).size === 1, JSON.stringify(flatD.durs.slice(0, 4)));
  // WEIGHT decides how much reaches loudness, and must not touch the lengths.
  ok('Weight 0 shapes length only — same durations, no lean',
    JSON.stringify(noW.durs) === JSON.stringify(full.durs) &&
    noW.ws.every((w) => w === 1),
    JSON.stringify({ durs: noW.durs.slice(0, 2), ws: noW.ws }));
  // TURN rotates the figure, so the bar starts on the other half of it.
  ok('Turn 1 starts the figure on its second step',
    turned.durs[0] === full.durs[1] && turned.durs[1] === full.durs[0],
    JSON.stringify({ turned: turned.durs.slice(0, 2), full: full.durs.slice(0, 2) }));
  // AND A NEW FIGURE IS REALLY A FIGURE.
  ok('Gallop is one held and two clipped, repeating',
    gall.durs[0] > gall.durs[1] && gall.durs[1] === gall.durs[2] &&
    gall.durs[3] === gall.durs[0],
    JSON.stringify(gall.durs.slice(0, 6)));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
