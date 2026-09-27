// PROBE — ⊞ RESOLUTION ON A ♦ BEAT LAYER: the knob has to move the PATTERN.
//
// user, 2026-09-27: "generating a new part for a Beat after creating a new part \u2026 is
// buggy, it doesn't generate a new rhythm or structure when changing params like
// Resolution and Length Shape".
//
// Creating a part was NOT the variable — measured: the store survives and
// `beatScalePer` scales the euclid correctly with one part or two. The bug is that
// `beat.per` is read by ONE of three states:
//
//   const bt = (!inSteps && p.rhythm.beat && Array.isArray(p.rhythm.beat.lanes)) ? … : null;
//   const bl = bt ? beatLanes(p, btSt, seedBase, btPer) : null;
//   const lanes = bl || p.rhythm.lanes || [];     // ← falls back to the DRAWN grid
//
//   • euclid with pulses, ⌘ Roll form   → `beatScalePer` moves the counts. WORKED.
//   • no lane with pulses                → `beatLanes` returns null, drawn cells play.
//   • ▦ Steps form                      → the euclid is bypassed outright.
//
// In the last two the drawn cells are the material, so ⊞ Resolution changed a stored
// number and nothing you could hear. `V2.beatRederive` resamples them onto the new grid
// instead — hits keep their place in TIME, because the knob is a grid and not a dice.
//
//   node test/probe-beatres.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(500);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
  await zz(700);

  // A kit layer with TWO arrangement parts — the state the report was made from.
  await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = true; c.seed = 4242; c.barsPerChord = 1;
    c.prog.chords = [0, 5, 7, 9].map(r => ({ root: r, intervals: [0, 4, 7], bars: 1 }));
    c.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }];
    const L = (c.layers || [])[0];
    L.instrument.voice = 'kit'; L.instrument.kit = 'tr808';
    L.part.kind = 'live'; L.part.bars = 1;
    E.getCfg();
  });

  // The three states, driven through `beatRederive` exactly as the handler does.
  const run = (setup, from, to) => page.evaluate((st, f, t) => {
    const E = _masterEng;
    const L0 = (E.getCfg().layers || [])[0];
    // eslint-disable-next-line no-new-func
    (new Function('L', 'per', st))(L0, f);
    E.getCfg();
    const L = (E.getCfg().layers || [])[0];
    const before = { steps: L.part.rhythm.steps | 0, form: L.part.form || 'roll',
      grid: L.part.grid | 0, kind: L.part.rhythm.kind,
      lanes: (L.part.rhythm.lanes || []).map(r => (r || []).join('')).join('|'),
      pulses: ((L.part.rhythm.beat || {}).lanes || []).map(e => (e && e.p) | 0).join(',') };
    const prev = window._v2.beatPerOf(L.part.rhythm.beat);
    L.part.rhythm.beat = L.part.rhythm.beat || {};
    L.part.rhythm.beat.per = t;
    let red = null;
    try { red = window._v2.beatRederive(L, prev); } catch (e) { red = 'ERR ' + e.message; }
    E.getCfg();
    const L2 = (E.getCfg().layers || [])[0];
    const after = { steps: L2.part.rhythm.steps | 0, form: L2.part.form || 'roll',
      grid: L2.part.grid | 0, kind: L2.part.rhythm.kind,
      lanes: (L2.part.rhythm.lanes || []).map(r => (r || []).join('')).join('|'),
      pulses: ((L2.part.rhythm.beat || {}).lanes || []).map(e => (e && e.p) | 0).join(','),
      per: window._v2.beatPerOf(L2.part.rhythm.beat) };
    return { before, after, red };
  }, setup, from, to);

  // ---- 1. THE EUCLID — the one state that already worked -----------------------
  console.log('\n  1. a euclid beat — the counts move with the grid');
  const eu = await run(`
    L.part.form = 'roll';
    L.part.rhythm = { kind: 'pulse', steps: 16, pulses: 4, n: 1,
      beat: { per: 16, lanes: [{ p: 4, r: 0 }, { p: 2, r: 4 }] } };
  `, 16, 32);
  ok('⊞ 16 → 32 doubles every lane\u2019s pulse count',
    eu.after.pulses.indexOf('8,4') === 0 && eu.after.per === 32, JSON.stringify([eu.red, eu.after]));

  // ---- 2. DRAWN CELLS, no pulses — the reported bug --------------------------
  console.log('\n  2. a DRAWN beat with no pulses — the reported bug');
  const dr = await run(`
    L.part.form = 'roll';
    L.part.rhythm = { kind: 'drawn', steps: 8, pulses: 3, n: 1,
      lanes: [[1,0,0,0,1,0,0,0], [0,0,1,0,0,0,1,0]] };
    delete L.part.rhythm.beat;
  `, 16, 32);
  // THE GRID IS `per × bars`, never a scaling of whatever the old cell count happened
  // to be: a drawn kit's `steps` and the euclid's `per × bars` can disagree (8 cells on a
  // one-bar part while `per` says 16), and Resolution is the thing that states the grid,
  // so it re-syncs them. 8 → 32 on a one-bar part at ⊞ 32.
  ok('the grid actually moves — to `per × bars`, which is what the knob names',
    dr.after.steps === 32 && dr.before.steps === 8, JSON.stringify([dr.before.steps, dr.after.steps]));
  ok('…and the pattern comes with it, hits in the same places in TIME',
    dr.after.lanes.split('|')[0] === '10000000000000001000000000000000' &&
    dr.after.lanes.split('|')[1] === '00000000100000000000000010000000', JSON.stringify(dr.after.lanes));
  ok('…nothing was lost going finer', dr.red && dr.red.lost === 0, JSON.stringify(dr.red));
  ok('…and it stays DRAWN — the resampled cells are not thrown away as a formula',
    dr.after.kind === 'drawn', JSON.stringify(dr.after.kind));

  // ---- 3. COARSER is the lossy direction, and it SAYS so ----------------------
  console.log('\n  3. coarser — the one lossy direction');
  // ⊞ 8 from ⊞ 16 does NOT collide adjacent hits — `round(1 × 8/16)` is 1, its own
  // cell. It takes a 4× reduction to put two hits in one place, which is the case worth
  // warning about.
  const co = await run(`
    L.part.form = 'roll';
    L.part.rhythm = { kind: 'drawn', steps: 16, pulses: 3, n: 1,
      lanes: [[1,1,0,0,1,0,0,0,1,0,0,0,1,0,0,0]] };
    delete L.part.rhythm.beat;
  `, 16, 4);
  ok('a coarser grid shrinks the cells', co.after.steps === 4, JSON.stringify(co.after.steps));
  ok('…and REPORTS the hits that collided rather than dropping them silently',
    co.red && co.red.lost === 1, JSON.stringify(co.red));

  // ---- 4. ▦ STEPS FORM — the euclid is bypassed there ----------------------
  console.log('\n  4. ▦ Steps form — where the euclid never ran at all');
  const stf = await run(`
    L.part.form = 'steps'; L.part.grid = 16;
    L.part.rhythm = { kind: 'drawn', steps: 16, pulses: 3, n: 1,
      lanes: [[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]] };
    L.part.rhythm.beat = { per: 16, lanes: [{ p: 4, r: 0 }] };
  `, 16, 32);
  ok('⊞ Resolution moves that form\u2019s OWN ruler (`part.grid`), or normalize undoes it',
    stf.after.grid === 32 && stf.after.steps === 32, JSON.stringify(stf.after));
  ok('…and the drawn cells are resampled onto it, euclid pulses or no',
    stf.after.lanes.split('|')[0] === '10000000100000001000000010000000', JSON.stringify(stf.after.lanes));

  // ---- 5. A VALUE THE GRID CANNOT EXPRESS --------------------------------------
  console.log('\n  5. 48 has no grid division of its own');
  const sn = await run(`
    L.part.form = 'steps'; L.part.grid = 16;
    L.part.rhythm = { kind: 'drawn', steps: 16, pulses: 3, n: 1, lanes: [[1,0,0,0]] };
    delete L.part.rhythm.beat;
  `, 16, 48);
  ok('it snaps to the nearest legal division instead of stranding the resample',
    sn.after.grid === 64 && sn.after.steps === 64, JSON.stringify([sn.after.grid, sn.after.steps]));

  // ---- 6. NO-OP STAYS A NO-OP --------------------------------------------------
  console.log('\n  6. the same value twice changes nothing');
  const noop = await run(`
    L.part.form = 'roll';
    L.part.rhythm = { kind: 'drawn', steps: 16, pulses: 3, n: 1, lanes: [[1,0,1,0]] };
    L.part.rhythm.beat = { per: 16, lanes: [{ p: 4, r: 0 }] };
  `, 16, 16);
  ok('re-picking the resolution it is already on is a no-op',
    noop.red === false && noop.after.steps === noop.before.steps, JSON.stringify([noop.red, noop.before.steps, noop.after.steps]));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
