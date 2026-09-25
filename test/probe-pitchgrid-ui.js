// PROBE — ⌸ the pitch grid, stage 3: the DOOR and the row editor.
//
// Stages 1–2 gave the store and the sound; nothing was reachable. What this
// pins is the rule this repo has paid for at least six times: a feature is not
// done until its UI is reachable, and a control added inside something
// collapsed is reported as MISSING, not as hidden. So the picker is measured
// (`getBoundingClientRect` + `offsetParent`) in the view the user actually has
// open, and driven with a real event with the config read back.
//
// It also pins the thing that would make ⌸ Grid a trap: choosing it on a layer
// with no rows would be SILENCE, because the rows are the material. Entering
// seeds from what the layer was already playing — the same idiom `drawn` uses
// when it snapshots the euclid pattern on the first tap.
//
//   node test/probe-pitchgrid-ui.js    (needs `npm start`; BLOOPS_URL to retarget)
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

  // A GENERATED PART WITH SOMETHING IN IT, in ▦ Pattern form — so the seed has
  // material to start from and "it went silent" would be visible.
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.notes;
    L.part.kind = 'euclid';
    L.part.form = 'steps';
    L.part.bars = 2;
    L.part.grid = 16;
    L.part.rhythm = Object.assign({}, L.part.rhythm, { kind: 'euclid', steps: 32, pulses: 6, rotate: 0 });
    // ENTERING ▦ Pattern SEEDS THE CELLS from the euclid formula — setting
    // `form` in config skips that door, and `onsetsOf` reads `cells`
    // directly, so an unseeded grid is silent ('an empty grid is a rest').
    L.part.rhythm.cells = (window._v2.euclidCells(6, 32, 0) || []).map((c) => (c ? 1 : 0));
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'walk', degree: 1, span: 6 });
    // A KEY TO BE IN OR OUT OF — the row marks report the harmony, so with no
    // progression there is nothing to mark and they are blank BY DESIGN.
    const c0 = E.getCfg();
    c0.prog = Object.assign({}, c0.prog, { on: true,
      chords: [{ deg: 1 }, { deg: 4 }, { deg: 5 }, { deg: 6 }] });
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
  // OPEN EVERY ZONE — the pitch rule lives behind one of them, and a probe that
  // assumes which would break the first time they are rearranged.
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    [...c.querySelectorAll('.v2-gzbar')].forEach((b) => {
      const gz = b.getAttribute('data-gz');
      if (!c.classList.contains('v2-gz-' + gz)) b.click();
    });
  });
  await zz(1200);

  // THE PITCH RULE'S ONE HOME IS ⚙ Deep ▸ ⚠ Advanced: recipe — a disclosure
  // inside the panel, so measuring it without opening that measures a control
  // nobody has on screen. Opened the way a finger would.
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const b = [...c.querySelectorAll('.v2-discbtn')].find((x) => x.getAttribute('data-disc') === 'recipe');
    if (b) b.click();
  });
  await zz(900);
  // TWO CONTROLS SHARE `data-f="part.pitch.kind"` — the Groundwork melody
  // picker (Run / Wander / Arpeggio / One note) and the real Pitch rule — and
  // `querySelector` answers for whichever comes first in the DOM (the
  // documented duplicate-path trap). Setting 'grid' on the Groundwork one
  // leaves the value '' and normalize falls back to 'chord', which is exactly
  // what this probe measured before the selector was made specific. Pick the
  // one that OFFERS the option.
  const PICK = '[...document.querySelectorAll(\'.v2-layer .v2-f[data-f="part.pitch.kind"]\')]' +
    '.find((s) => [...s.options].some((o) => o.value === "grid"))';
  const door = await page.evaluate((PICK) => {
    const sel = eval(PICK);
    if (!sel) return { there: false };
    const r = sel.getBoundingClientRect();
    return { there: true, hasGrid: [...sel.options].some((o) => o.value === 'grid'),
             label: ([...sel.options].find((o) => o.value === 'grid') || {}).text,
             reachable: r.width > 0 && r.height > 0 && !!sel.offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1 };
  }, PICK);
  console.log('\n  pitch door: ' + JSON.stringify(door));
  ok('⌸ Grid is offered by the Pitch rule, on a control that is on screen',
    door.there && door.hasGrid && door.reachable && door.inView, JSON.stringify(door));

  // ── CHOOSING IT SEEDS, RATHER THAN GOING SILENT ─────────────────────────
  const before = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    const cfg = E.getCfg(), cyc = V.cycleSec(L, cfg);
    return (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || []).length;
  });
  await page.evaluate((PICK) => {
    const sel = eval(PICK);
    sel.value = 'grid';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, PICK);
  await zz(900);
  // ✦ GENERATE IS A STAGED DRAFT — the pitch rule reaches the layer at ✓ Done,
  // not at the select's own commit, so the seed has to survive that route.
  await page.evaluate(() => {
    const d = document.querySelector('.v2-layer .v2-gendone'); if (d) d.click();
  });
  await zz(1500);
  const seeded = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    const cfg = E.getCfg(), cyc = V.cycleSec(L, cfg);
    const ns = (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || []).length;
    const rw = (L.part.pitch || {}).rows || {};
    return { kind: L.part.pitch.kind, rows: Object.keys(rw).length,
             runs: Object.keys(rw).reduce((a, k) => a + rw[k].c.length, 0), ns };
  });
  console.log('  seeded: ' + JSON.stringify(seeded) + '  (was ' + before + ' notes)');
  ok('choosing it starts from what the layer was already playing, not silence',
    seeded.kind === 'grid' && seeded.rows > 0 && seeded.ns > 0, JSON.stringify(seeded));
  ok('…and it keeps roughly the take it seeded from',
    Math.abs(seeded.ns - before) <= 1, JSON.stringify({ before, after: seeded.ns }));

  // ── THE ROW PICKER ──────────────────────────────────────────────────────
  const pick = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const sel = c.querySelector('.v2-growpick');
    if (!sel) return { there: false };
    const r = sel.getBoundingClientRect();
    const cells = c.querySelectorAll('.v2-gcell');
    const withCount = [...sel.options].filter((o) => / · \d+$/.test(o.text));
    return { there: true,
             reachable: r.width > 0 && r.height > 0 && !!sel.offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1,
             opts: sel.options.length, value: sel.value,
             counted: withCount.length, sample: withCount.slice(0, 3).map((o) => o.text),
             marks: [...sel.options].slice(0, 24).some((o) => /[●○]/.test(o.text)),
             cells: cells.length };
  });
  console.log('  picker: ' + JSON.stringify(pick));
  ok('the ⌸ Row picker is on screen, sized, and fits 390px',
    pick.there && pick.reachable && pick.inView, JSON.stringify(pick));
  ok('…it names the rows that hold notes, with a count, so you are not hunting',
    pick.counted > 0 && pick.counted <= pick.opts, JSON.stringify(pick.sample));
  ok('…and marks which rows are in the chord or the key',
    pick.marks === true, JSON.stringify(pick.sample));
  ok('…and the grid under it draws one cell per step',
    pick.cells === 32, JSON.stringify({ cells: pick.cells }));

  // ── NO HORIZONTAL OVERFLOW ──────────────────────────────────────────────
  // Measured per element against its parent — `documentElement.scrollWidth` is
  // useless here, because html/body carry `overflow-x: hidden` and clipped text
  // reads as zero overflow.
  const fits = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const bad = [];
    [...c.querySelectorAll('.v2-growrow, .v2-growhint, .v2-growpick, .v2-growgrid, .v2-gcell')]
      .forEach((el) => {
        const r = el.getBoundingClientRect(), pr = el.parentElement.getBoundingClientRect();
        if (el.scrollWidth > el.clientWidth + 1 || r.right > pr.right + 1) {
          bad.push((el.className || '') + ' ' + Math.round(r.right) + '>' + Math.round(pr.right));
        }
      });
    return bad;
  });
  ok('nothing in the row editor overflows its container', fits.length === 0, JSON.stringify(fits.slice(0, 4)));

  // ── DRIVEN FOR REAL, AND READ BACK ──────────────────────────────────────
  const row = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    return Object.keys(L.part.pitch.rows).map((k) => k | 0).sort((a, b) => a - b)[0];
  });
  const tap = async (i) => {
    await page.evaluate((i) => {
      const b = document.querySelector('.v2-layer .v2-gcell[data-ci="' + i + '"]');
      b.click();
    }, i);
    await zz(700);
    return page.evaluate((row) => {
      const L = (_masterEng.getCfg().layers || [])[0];
      const runs = ((L.part.pitch.rows || {})[String(row)] || {}).c || [];
      return JSON.parse(JSON.stringify(runs));
    }, row);
  };
  // a cell that row is certainly not using: the last one
  const added = await tap(31);
  ok('a tap on an empty cell puts a note there',
    added.some((r) => r[0] === 31 && r[1] === 1), JSON.stringify(added));
  const removed = await tap(31);
  ok('…and a tap on it again takes it away',
    !removed.some((r) => r[0] === 31), JSON.stringify(removed));

  // ── ENDING A HELD NOTE, the way out of a tie before the gesture lands ────
  const tied = await page.evaluate((row) => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.pitch.rows[String(row)] = { c: [[0, 8]] };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    return null;
  }, row);
  await zz(900);
  const held = await page.evaluate(() =>
    document.querySelectorAll('.v2-layer .v2-gcell.tied').length);
  ok('a run draws its held cells differently from where the note starts',
    held === 7, JSON.stringify({ tied: held }));
  const ended = await tap(4);
  ok('…and tapping a held cell ends the note there', 
    JSON.stringify(ended) === '[[0,4]]', JSON.stringify(ended));

  // ── ⌸ ELIDE: THE DRAG IS THE SELECTION ──────────────────────────────────
  // "select adjacent notes … elide them into a single sustained note". The two
  // answers are two gestures rather than a mode: tapping each cell leaves
  // separate hits, dragging across them makes one note held across them.
  // SCROLLED INTO VIEW, AND THE POINT VERIFIED. `page.mouse` dispatches at
  // viewport coordinates, so a cell below the fold takes the press at a point
  // where nothing is — which reads as "the drag did nothing" and is
  // indistinguishable from a broken handler. (Cost a debugging cycle here; the
  // rule is in docs/traps-testing.md.)
  const cellBox = async (i) => {
    await page.evaluate((i) => {
      const b = document.querySelector('.v2-layer .v2-gcell[data-ci="' + i + '"]');
      b.scrollIntoView({ block: 'center' });
    }, i);
    await zz(220);
    return page.evaluate((i) => {
      const b = document.querySelector('.v2-layer .v2-gcell[data-ci="' + i + '"]');
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const el = document.elementFromPoint(x, y);
      return { x, y, onCell: !!(el && el.closest && el.closest('.v2-gcell[data-ci="' + i + '"]')) };
    }, i);
  };
  const runsNow = () => page.evaluate((row) => {
    const L = (_masterEng.getCfg().layers || [])[0];
    return JSON.parse(JSON.stringify(((L.part.pitch.rows || {})[String(row)] || {}).c || []));
  }, row);
  // start from separate hits, exactly the case the request names
  await page.evaluate((row) => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.pitch.rows[String(row)] = { c: [[8, 1], [9, 1], [10, 1], [11, 1]] };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  }, row);
  await zz(900);
  const sepHits = await runsNow();
  ok('four separate hits to start from', sepHits.length === 4, JSON.stringify(sepHits));
  const A = await cellBox(8), B = await cellBox(11);
  ok('the drag’s own coordinates land on the cells they name',
    A.onCell && B.onCell, JSON.stringify({ A, B }));
  await page.mouse.move(A.x, A.y);
  await page.mouse.down();
  await page.mouse.move((A.x + B.x) / 2, B.y, { steps: 4 });
  await page.mouse.move(B.x, B.y, { steps: 4 });
  await page.mouse.up();
  await zz(900);
  const elided = await runsNow();
  console.log('  elided: ' + JSON.stringify(elided));
  ok('a drag across them elides them into ONE note held across the span',
    JSON.stringify(elided) === '[[8,4]]', JSON.stringify(elided));
  // …and it SOUNDS as one note, which is the only claim that matters
  const sounded = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    const cfg = E.getCfg(), cyc = V.cycleSec(L, cfg), st = L.part.rhythm.steps | 0;
    const cell = cyc / st;
    const ns = (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [])
      .filter((n) => Math.round(n.at / cell) >= 8 && Math.round(n.at / cell) <= 11);
    return ns.map((n) => ({ st: Math.round(n.at / cell), c: +((n.durMs / 1000) / cell).toFixed(2) }));
  });
  console.log('  sounded: ' + JSON.stringify(sounded));
  ok('…and it is heard as one long note, not four short ones',
    sounded.length === 1 && sounded[0].st === 8 && Math.abs(sounded[0].c - 3.6) < 0.1,
    JSON.stringify(sounded));
  // THE RUN DRAWS AS ONE BAR — rounded at the ends, squared in the middle.
  const drawn = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const cls = (i) => (c.querySelector('.v2-gcell[data-ci="' + i + '"]') || {}).className || '';
    return { a: /run-a/.test(cls(8)), m: /run-m/.test(cls(9)) && /run-m/.test(cls(10)),
             z: /run-z/.test(cls(11)), solo: /run-solo/.test(cls(8)) };
  });
  ok('…and it draws as one bar: one head, held middles, one tail',
    drawn.a && drawn.m && drawn.z && !drawn.solo, JSON.stringify(drawn));
  // A PLAIN TAP STILL MEANS A HIT — the drag must not have eaten the click.
  const afterTap = await tap(20);
  ok('a plain tap still puts a single hit, not a run',
    afterTap.some((r) => r[0] === 20 && r[1] === 1), JSON.stringify(afterTap));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
