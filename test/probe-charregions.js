// PROBE — a content moves THROUGH Characters: fractional stretches of one
// part, each generating as a different Character.
//
// user: "by interleaving i meant basically assigning subsets of bars
// (including fractional) to different characters, so having a content move
// through characters within a content".
//
// The contract this checks, and nothing softer:
//   · a stretch given a Character stops playing what the part plays there
//   · two stretches with different Characters play different material
//   · everything OUTSIDE the stretches is BYTE-IDENTICAL to the plain part —
//     a region edit that quietly re-rolls the rest is the bug this whole
//     branch has been chasing
//   · fractional stretches (half a bar) are regions like any other
//   · the stamp survives normalize and reads back as itself, untuned
//   · clearing gives back exactly the original notes
//
//   node test/probe-charregions.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] },
                       { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] },
                       { root: 9, intervals: [0, 3, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);

  const out = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    // RE-READ EVERY TIME — `_normalizeAmbientCfg` replaces objects on every
    // `getCfg()`, so a held reference is an orphan.
    const Lat = () => (E.getCfg().layers || [])[0];
    const SPB = 48;
    const R = {};

    // A 4-BAR ROLL as the ground state: dense enough that a region has notes
    // in it, and live so the region overlay is what decides the material.
    const L0 = Lat();
    L0.part.kind = 'live'; L0.part.bars = 4; L0.part.notes = [];
    delete L0.part.vary; delete L0.chg; delete L0.part.ruleb; delete L0.part.takeb;
    E.getCfg();
    V.applyPreset(E, Lat(), 'rollwander');
    E.getCfg();

    const CYC = 8;
    // A NOTE'S SLOT on the 1/48-bar grid — the same test the engine uses, so
    // "inside the region" means here exactly what it means there.
    const slotOf = (n, bars) => ((n.at) / CYC) * bars * SPB;
    const sig = (ns) => ns.map((n) => Math.round(n.at * 1000) + ':' +
      Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)) + ':' + Math.round(n.durMs)).join(' ');
    const notes = () => {
      const L = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      return (V.withEdit(() => V.withTake(V.pinOf(L),
        () => V.notesFor(L, { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: CYC }))) || []);
    };
    const inReg = (ns, a, b) => { const bars = Lat().part.bars;
      return ns.filter((n) => { const s = slotOf(n, bars); return s >= a - 1e-6 && s < b - 1e-6; }); };

    const plain = notes();
    R.plain = { n: plain.length, sig: sig(plain) };

    // bars 1–2 → an Arp; bar 3 → Groundwork Stabs; bar 4½–5 is past the end,
    // so the fractional stretch is the second HALF of bar 4.
    const A = [0, 2 * SPB], B = [2 * SPB, 3 * SPB], C = [3 * SPB + SPB / 2, 4 * SPB];
    const kA = A[0] + ':' + A[1], kB = B[0] + ':' + B[1], kC = C[0] + ':' + C[1];

    R.setA = V.setBarChar(E, Lat(), [kA], 'arpwide');
    E.getCfg();
    R.setB = V.setBarChar(E, Lat(), [kB], 'stabs');
    E.getCfg();
    R.setC = V.setBarChar(E, Lat(), [kC], 'pad');
    E.getCfg();

    R.stored = JSON.parse(JSON.stringify(Lat().part.ruleb || {}));
    R.rebuiltA = V.charOverlay(E, Lat(), 'arpwide');
    R.stateA = V.charState(E, Lat(), kA);
    R.stateB = V.charState(E, Lat(), kB);
    R.stateC = V.charState(E, Lat(), kC);

    const mixed = notes();
    R.mixed = { n: mixed.length, sig: sig(mixed) };

    // …the three stretches, and the untouched remainder.
    R.regs = {
      A: { was: sig(inReg(plain, A[0], A[1])), now: sig(inReg(mixed, A[0], A[1])) },
      B: { was: sig(inReg(plain, B[0], B[1])), now: sig(inReg(mixed, B[0], B[1])) },
      C: { was: sig(inReg(plain, C[0], C[1])), now: sig(inReg(mixed, C[0], C[1])) },
    };
    // EVERYTHING ELSE: bar 3–4½ minus B, i.e. the stretch from 3 bars to 3½.
    const restWas = sig(inReg(plain, 3 * SPB, 3 * SPB + SPB / 2));
    const restNow = sig(inReg(mixed, 3 * SPB, 3 * SPB + SPB / 2));
    R.rest = { was: restWas, now: restNow };

    // …and the way back.
    R.cleared = V.setBarChar(E, Lat(), [kA, kB, kC], '');
    E.getCfg();
    R.after = { ruleb: Lat().part.ruleb || null, sig: sig(notes()) };
    return R;
  });

  console.log('\n  a 4-bar Wandering roll, then three stretches given Characters:\n');
  console.log('   plain        ' + out.plain.n + ' notes');
  console.log('   interleaved  ' + out.mixed.n + ' notes');
  console.log('   stored       ' + Object.keys(out.stored).map((k) =>
    k + '→' + (out.stored[k].char || '?')).join('  ') + '\n');

  ok('all three stretches accepted a Character', out.setA && out.setB && out.setC,
    JSON.stringify({ A: out.setA, B: out.setB, C: out.setC }));
  ok('each one stored a stamp AND fields the engine reads',
    Object.keys(out.stored).length === 3 &&
    Object.keys(out.stored).every((k) => out.stored[k].char &&
      ['rhythm', 'pitch', 'shape'].some((g) => out.stored[k][g])),
    JSON.stringify(out.stored));
  ok('each stretch reads back as its own Character, untuned',
    out.stateA.id === 'arpwide' && out.stateA.tuned === false &&
    out.stateB.id === 'stabs' && out.stateB.tuned === false &&
    out.stateC.id === 'pad' && out.stateC.tuned === false,
    JSON.stringify([out.stateA, out.stateB, out.stateC]) +
    '\n      stored  ' + JSON.stringify(out.stored[Object.keys(out.stored)[0]]) +
    '\n      rebuilt ' + JSON.stringify(out.rebuiltA));

  console.log('');
  ok('bars 1–2 stopped playing what the part played there', out.regs.A.now !== out.regs.A.was,
    'was ' + out.regs.A.was.slice(0, 60) + '\n      now ' + out.regs.A.now.slice(0, 60));
  ok('bar 3 stopped playing what the part played there', out.regs.B.now !== out.regs.B.was,
    'was ' + out.regs.B.was.slice(0, 60) + '\n      now ' + out.regs.B.now.slice(0, 60));
  ok('the FRACTIONAL stretch (bar 4½–5) did too', out.regs.C.now !== out.regs.C.was,
    'was ' + out.regs.C.was.slice(0, 60) + '\n      now ' + out.regs.C.now.slice(0, 60));
  ok('the three stretches play three different things',
    new Set([out.regs.A.now, out.regs.B.now, out.regs.C.now]).size === 3,
    [out.regs.A.now, out.regs.B.now, out.regs.C.now].map((s) => s.split(' ').length).join(' · '));

  console.log('');
  ok('the part OUTSIDE the stretches is byte-identical', out.rest.now === out.rest.was,
    'was ' + out.rest.was + '\n      now ' + out.rest.now);
  ok('clearing gives back exactly the original notes',
    out.cleared === true && !out.after.ruleb && out.after.sig === out.plain.sig,
    'ruleb=' + JSON.stringify(out.after.ruleb) +
    (out.after.sig === out.plain.sig ? '' : '\n      notes did not come back'));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
