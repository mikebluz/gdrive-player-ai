// PROBE — ⌸ the pitch grid, stage 1: the STORE.
//
// user, 2026-09-24: "a pattern per note on the piano, all at a set length
// (number of steps) with resolution control … then if select adjacent notes,
// can choose to either have those remain separate hits, or elide them into a
// single sustained note".
//
// Nothing is user-visible yet. What is checked here is the part that cannot be
// retrofitted: the shape `part.pitch.rows` takes, that normalize is TOTAL over
// it (no unknown value can reach the emitter), that it is ABSENT BY DEFAULT so
// every project saved before today is byte-identical, and that `rhythm.cells`
// is DERIVED from it — one writer, so the grid and the onset list cannot
// disagree about where the notes are.
//
//   node test/probe-pitchgrid.js     (needs `npm start`; BLOOPS_URL to retarget)
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

  // ▦ PATTERN FORM, 2 bars at 1/16 = 32 cells. In Pattern form the cell count
  // is DERIVED (bars × grid), which is the "set length with resolution control"
  // the request asks for — it already ships, so the probe uses it rather than
  // inventing a second length authority.
  const base = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.notes;
    L.part.kind = 'euclid';
    L.part.form = 'steps';
    L.part.bars = 2;
    L.part.grid = 16;
    E.getCfg();
    return { steps: L.part.rhythm.steps, cells: (L.part.rhythm.cells || []).length,
             hasRows: L.part.pitch.rows !== undefined, kind: L.part.pitch.kind };
  });
  console.log('\n  base: ' + JSON.stringify(base));
  ok('▦ Pattern derives 32 cells from 2 bars × 1/16',
    base.steps === 32 && base.cells === 32, JSON.stringify(base));
  // ADDITIVE AND ABSENT BY DEFAULT — the whole save-compat promise in one check.
  ok('…and a layer that never opens the grid stores no rows at all',
    base.hasRows === false, JSON.stringify(base));

  // ── THE SHAPE SURVIVES A NORMALIZE ──────────────────────────────────────
  const kept = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.pitch.kind = 'grid';
    L.part.pitch.rows = {
      '60': { c: [[0, 4], [8, 1]] },
      '64': { c: [[0, 1], [16, 2]], ind: 1 },
      '67': { c: [[8, 1]] },
    };
    E.getCfg();
    return JSON.parse(JSON.stringify(L.part.pitch.rows));
  });
  console.log('  kept: ' + JSON.stringify(kept));
  ok('a hit and a tie are ONE representation — [i,1] and [i,4]',
    kept['60'].c.length === 2 && kept['60'].c[0][1] === 4 && kept['60'].c[1][1] === 1,
    JSON.stringify(kept['60']));
  ok('…and the per-row Evolve opt-out is kept only where it is taken',
    kept['64'].ind === 1 && kept['60'].ind === undefined && kept['67'].ind === undefined,
    JSON.stringify({ a: kept['60'].ind, b: kept['64'].ind, c: kept['67'].ind }));

  // ── THE ONSETS ARE DERIVED, NOT STORED TWICE ────────────────────────────
  const derived = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const cells = L.part.rhythm.cells || [];
    return { on: cells.map((c, i) => (c ? i : -1)).filter((i) => i >= 0), n: cells.length };
  });
  console.log('  onsets: ' + JSON.stringify(derived.on));
  // Runs start at 0 (two rows), 8 (two rows) and 16 (one row) — three onsets,
  // and a tie's INTERIOR cells are not onsets, which is the whole point of it.
  ok('rhythm.cells is derived from the rows — an onset per run START',
    derived.on.join(',') === '0,8,16' && derived.n === 32, JSON.stringify(derived));

  // ── NORMALIZE IS TOTAL ──────────────────────────────────────────────────
  const clean = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.pitch.rows = {
      '60': { c: [[4, 99]] },                 // runs past the end
      '62': { c: [[8, 8], [10, 2]] },         // overlapping — the earlier is trimmed
      '64': { c: [[5, 0], [-3, 4], [40, 2]] },// zero length, negative start, past the end
      '66': { c: [] },                        // nothing — the row goes
      '200': { c: [[0, 1]] },                 // not a midi note
      '68': { c: [[3, 2], [3, 5]] },          // two runs on one cell — the longer wins
      '70': { c: [[1, 2]], bogus: 7, ind: 'yes' },
    };
    E.getCfg();
    const rw = L.part.pitch.rows || {};
    return { keys: Object.keys(rw).sort((a, b) => a - b),
             r60: rw['60'] && rw['60'].c, r62: rw['62'] && rw['62'].c,
             r68: rw['68'] && rw['68'].c, r70: rw['70'] };
  });
  console.log('  cleaned: ' + JSON.stringify(clean));
  ok('a run is clipped to the grid, never past its end',
    JSON.stringify(clean.r60) === '[[4,28]]', JSON.stringify(clean.r60));
  // THE ONSET YOU DREW IS THE THING TO KEEP: an overlap shortens the earlier
  // run to meet the later one rather than dropping the later onset.
  ok('…overlapping runs shorten, they do not swallow the next onset',
    JSON.stringify(clean.r62) === '[[8,2],[10,2]]', JSON.stringify(clean.r62));
  ok('…a zero-length, negative or out-of-range run is dropped',
    clean.keys.indexOf('64') < 0, JSON.stringify(clean.keys));
  ok('…a row with nothing in it is deleted, and so is a row that is not a note',
    clean.keys.indexOf('66') < 0 && clean.keys.indexOf('200') < 0, JSON.stringify(clean.keys));
  ok('…two runs on one cell become one, keeping the longer',
    JSON.stringify(clean.r68) === '[[3,5]]', JSON.stringify(clean.r68));
  ok('…and an unknown key never survives',
    clean.r70 && clean.r70.bogus === undefined && clean.r70.ind === 1, JSON.stringify(clean.r70));

  // ── THE READERS ─────────────────────────────────────────────────────────
  const read = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    L.part.pitch.rows = { '60': { c: [[0, 4], [8, 1]] }, '64': { c: [[0, 1]] }, '67': { c: [[8, 1]] } };
    E.getCfg();
    const p = L.part;
    return { at0: V.gridAt(p, 0), at4: V.gridAt(p, 4), at8: V.gridAt(p, 8),
             rows: !!V.gridRowsOf(p) };
  });
  console.log('  read: ' + JSON.stringify(read));
  ok('gridAt names the chord that STARTS on a step, low to high, with each run’s length',
    JSON.stringify(read.at0) === '[{"midi":60,"len":4},{"midi":64,"len":1}]',
    JSON.stringify(read.at0));
  // A TIE'S INTERIOR IS NOT AN ONSET — step 4 is inside 60's run and nothing
  // starts there, so it is empty. That is what makes the run one note.
  ok('…and a cell inside a tie starts nothing',
    JSON.stringify(read.at4) === '[]', JSON.stringify(read.at4));
  ok('…while the next run does', JSON.stringify(read.at8) === '[{"midi":60,"len":1},{"midi":67,"len":1}]',
    JSON.stringify(read.at8));

  // ── THE DOOR IS TWO-WAY ─────────────────────────────────────────────────
  // Switching pitch kind to hear an idea must not cost you the grid, exactly as
  // `cells` survives a trip through ⌗ Roll.
  const trip = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    const before = JSON.stringify(L.part.pitch.rows);
    L.part.pitch.kind = 'walk'; E.getCfg();
    const away = { rows: JSON.stringify(L.part.pitch.rows), reads: !!V.gridRowsOf(L.part) };
    L.part.pitch.kind = 'grid'; E.getCfg();
    return { before, away, back: JSON.stringify(L.part.pitch.rows) };
  });
  ok('the grid survives a trip through another pitch kind',
    trip.away.rows === trip.before && trip.back === trip.before,
    JSON.stringify({ before: trip.before.slice(0, 60), away: trip.away.rows.slice(0, 60) }));
  ok('…but it is not the material while another kind is chosen',
    trip.away.reads === false, JSON.stringify(trip.away.reads));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
