// PROBE — ⌸ the pitch grid, stage 2: what it PLAYS.
//
// The store (stage 1) is checked by probe-pitchgrid.js. This is the emit half,
// and the claim it exists to pin is the one that makes eliding worth having:
//
//   ON THE GRID A CELL IS ONE CELL LONG.
//
// Everywhere else in this engine a note's length is a share of the GAP to the
// next onset, so a lone hit on a sparse pattern already sustains for bars — and
// if that were true here, eliding would buy nothing. A run of N cells is N
// cells, `lenRatio` articulates it, and each voice of a chord keeps its own
// run's share, because a bass sustaining under a staccato top is the reason
// ties exist at all.
//
//   node test/probe-pitchgrid-emit.js    (needs `npm start`; BLOOPS_URL to retarget)
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

  // EVERY VARIANCE KNOB OFF, so what comes out is the grid and nothing else.
  // A stage that fires would show up as an extra note or a moved one, which is
  // exactly what the later stages will need to add back deliberately.
  const setup = async (rows, extra) => page.evaluate((rows, extra) => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.notes; delete L.part.form;
    L.part.kind = 'euclid';
    L.part.form = 'steps';
    L.part.bars = 2;
    L.part.grid = 16;
    L.part.shape = Object.assign({}, L.part.shape, { lenShape: '', lenRatio: 90, holdSteps: 0, slip: 0 });
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'grid', rows: rows, inv: 0, drift: 0 });
    L.restProb = 0; L.ghosts = 0; L.lenVary = 0; L.accent = 0;
    L.twist = 0; L.phrasing = 0; L.swing = 0; L.humanize = 0; L.proximity = 0;
    delete L.chg; delete L.part.vary; delete L.part.rhythm.vary;
    Object.assign(L.part, extra || {});
    E.getCfg();
    return null;
  }, rows, extra || null);

  const heard = () => page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cfg = E.getCfg();
    const cyc = V.cycleSec(L, cfg);
    const steps = L.part.rhythm.steps | 0;
    const ns = (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [])
      .slice().sort((a, b) => (a.at - b.at) || (a.freq - b.freq));
    const cell = cyc / Math.max(1, steps);
    return { cyc, steps, cell,
      // step index, midi, and length IN CELLS — the units the grid is drawn in,
      // so an expectation reads as what you drew rather than as milliseconds
      ns: ns.map((n) => ({ st: Math.round(n.at / cell),
                           m: Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)),
                           c: +((n.durMs / 1000) / cell).toFixed(3) })) };
  });

  // ── ONE ROW, ONE LONE CELL, NOTHING AFTER IT FOR HALF THE PART ──────────
  await setup({ '60': { c: [[0, 1]] }, '67': { c: [[16, 1]] } });
  const lone = await heard();
  console.log('\n  lone: ' + JSON.stringify(lone.ns));
  ok('the grid plays exactly what is drawn, on the cells it is drawn on',
    lone.ns.length === 2 && lone.ns[0].st === 0 && lone.ns[0].m === 60 &&
    lone.ns[1].st === 16 && lone.ns[1].m === 67, JSON.stringify(lone.ns));
  // THE CLAIM. A 16-cell gap follows the first note; under the gap rule it
  // would sound for ~14 cells. On the grid it is one cell, articulated to 0.9.
  ok('…and a lone cell is ONE CELL long, not stretched to the next onset',
    Math.abs(lone.ns[0].c - 0.9) < 0.02, JSON.stringify(lone.ns[0]));

  // ── ELIDE ───────────────────────────────────────────────────────────────
  await setup({ '60': { c: [[0, 4]] }, '67': { c: [[16, 1]] } });
  const tied = await heard();
  console.log('  tied: ' + JSON.stringify(tied.ns));
  ok('a 4-cell run is ONE note, four cells long (× Note length)',
    tied.ns.length === 2 && tied.ns[0].st === 0 &&
    Math.abs(tied.ns[0].c - 3.6) < 0.05, JSON.stringify(tied.ns[0]));
  ok('…and the cells inside it start nothing — that is what makes it one note',
    tied.ns.filter((n) => n.st > 0 && n.st < 16).length === 0, JSON.stringify(tied.ns));

  // ── PER VOICE ───────────────────────────────────────────────────────────
  // The reason ties need per-note lengths at all: one onset, two rows, two
  // different runs. Everywhere else an onset's notes share one length.
  await setup({ '48': { c: [[0, 8]] }, '60': { c: [[0, 1]] }, '64': { c: [[0, 1]] } });
  const chord = await heard();
  console.log('  chord: ' + JSON.stringify(chord.ns));
  ok('a chord may hold one voice and clip the others — each run keeps its own length',
    chord.ns.length === 3 &&
    Math.abs(chord.ns.find((n) => n.m === 48).c - 7.2) < 0.1 &&
    Math.abs(chord.ns.find((n) => n.m === 60).c - 0.9) < 0.05 &&
    Math.abs(chord.ns.find((n) => n.m === 64).c - 0.9) < 0.05,
    JSON.stringify(chord.ns));

  // ── A RUN MAY REACH PAST A LATER ONSET ──────────────────────────────────
  // A sustain under a moving line. The gap ceiling that protects every other
  // material would silently cut this, so the grid is its own ceiling.
  await setup({ '48': { c: [[0, 8]] }, '67': { c: [[4, 1]] } });
  const over = await heard();
  console.log('  overlap: ' + JSON.stringify(over.ns));
  ok('a run holds through a later onset rather than being cut at the gap',
    Math.abs(over.ns.find((n) => n.m === 48).c - 7.2) < 0.1, JSON.stringify(over.ns));

  // ── NOTE LENGTH STILL ARTICULATES ───────────────────────────────────────
  await setup({ '60': { c: [[0, 4]] } }, { shape: { lenRatio: 50, lenShape: '', holdSteps: 0 } });
  const half = await heard();
  ok('Note length articulates the run — 4 cells at 50% sounds for 2',
    Math.abs(half.ns[0].c - 2.0) < 0.05, JSON.stringify(half.ns[0]));

  // ── HOLD DOES NOT APPLY ─────────────────────────────────────────────────
  // It answers the question the grid now answers; the card will grey it.
  await setup({ '60': { c: [[0, 4]] } }, { shape: { lenRatio: 90, lenShape: '', holdSteps: 12 } });
  const hold = await heard();
  ok('Hold does not override a drawn run — the grid answers that question',
    Math.abs(hold.ns[0].c - 3.6) < 0.05, JSON.stringify(hold.ns[0]));

  // ── AND NOTHING MOVES FOR A LAYER THAT IS NOT A GRID ────────────────────
  // The save-compat promise, measured rather than asserted: the same layer,
  // the same take, with rows present but another pitch kind chosen.
  const same = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    const ask = () => {
      const cfg = E.getCfg(), cyc = V.cycleSec(L, cfg);
      return JSON.stringify((V.withEdit(() => V.withTake(0, () => V.notesFor(L,
        { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [])
        .map((n) => [Math.round(n.at * 1e5), Math.round(n.freq), n.durMs]));
    };
    L.part.pitch.kind = 'walk'; delete L.part.pitch.rows; E.getCfg();
    const without = ask();
    L.part.pitch.rows = { '60': { c: [[0, 4]] }, '64': { c: [[8, 1]] } }; E.getCfg();
    const withRows = ask();
    return { same: without === withRows, n: JSON.parse(without).length };
  });
  ok('a layer that is not a grid plays identically with rows stored beside it',
    same.same === true && same.n > 0, JSON.stringify(same));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
