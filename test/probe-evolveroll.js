// PROBE — when Evolve has nothing to roll, the drawing SAYS so.
//
// user: "Evolve is not rerollling this content I created using Deep … it only
// does so when I turn Salt on … also Show ahead doesn't seem to be working
// anymore (not seeing any show-ahead takes for Play the Changes material)".
//
// Three reports, one fact. ⟳ Show ahead draws the notes that DIFFER between
// takes; ⟳ Evolve advances the take. A Play-the-changes part is deterministic
// — its chord tones come from the changes and its strike pattern is fixed —
// so every take is the same take: Evolve changes nothing and there is nothing
// to outline. Salt was the only thing varying the part, which is why Evolve
// looked like it depended on it.
//
// The ONE rolled ingredient Groundwork has is a ♪ Line set to Walk, and the
// button's default is `series`, a deterministic sweep. So this holds the
// engine to that fact and the readout to admitting it.
//
//   node test/probe-evolveroll.js        (needs `npm start` on :3001)
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
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] }, { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);

  // ── THE ENGINE FACT ──────────────────────────────────────────────────────
  const eng = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const Lat = () => (E.getCfg().layers || [])[0];
    const L0 = Lat();
    L0.part.kind = 'live'; L0.part.notes = []; E.getCfg();
    V.applyPreset(E, Lat(), 'held'); E.getCfg();
    const sigAt = (t) => {
      const L = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      return (V.withEdit(() => V.withTake(t, () => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 }))) || [])
        .map((n) => Math.round(n.at * 1000) + ':' + Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).join(' ');
    };
    const takes = () => new Set([0, 1, 2, 3].map(sigAt)).size;
    const setLine = (kind) => {
      const L = Lat();
      const g = L.part.ground || (L.part.ground = {});
      const bag = g.parts || (g.parts = {});
      (bag['0'] || (bag['0'] = {})).mel = { rate: 4, kind, oct: 1, len: 80, vel: 70, on: 1 };
      E.getCfg();
    };
    const out = { bare: takes() };
    ['series', 'walk', 'chord', 'fixed'].forEach((k) => { setLine(k); out[k] = takes(); });
    // …and leave it on the deterministic default, which is what the report has
    setLine('series');
    return out;
  });

  console.log('\n  Play the changes — distinct takes out of 4:\n');
  console.log('   no line        ' + eng.bare);
  ['series', 'walk', 'chord', 'fixed'].forEach((k) =>
    console.log('   ♪ Line ' + k.padEnd(8) + eng[k] + (k === 'series' ? '   ← the button’s default' : '')));
  console.log('');

  ok('a bare Play-the-changes part replays IDENTICALLY on every take', eng.bare === 1,
    eng.bare + ' distinct');
  ok('…and a ♪ Line set to Walk is what gives it dice', eng.walk === 4,
    'walk gave ' + eng.walk + ' distinct takes');
  ok('…while the default `series` line does NOT', eng.series === 1,
    'series gave ' + eng.series + ' distinct takes');

  // ── AND THE DRAWING ADMITS IT ────────────────────────────────────────────
  const say = async () => {
    await page.evaluate(() => {
      const E = _masterEng, L = (E.getCfg().layers || [])[0];
      L.chg = Object.assign({}, L.chg || {}, { ev: 1, am: 100 });   // Evolve on
      L.ahead = 7;                                                   // Show ahead on
      E.getCfg(); window._v2.render(E);
    });
    await zz(1100);
    return page.evaluate(() => {
      // `.v2-vizlab` IS the readout — the line the report quoted ("EVOLVES
      // every cycle: notes · 36 notes in 6 onsets …"). An earlier cut of this
      // check hunted for any leaf containing "take N" and found a different
      // sentence entirely, then reported the fix as missing.
      const card = document.querySelector('.v2-layer');
      const el = card && card.querySelector('.v2-vizlab');
      return (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
    });
  };
  const txtSeries = await say();
  console.log('   readout (series line):\n     “' + txtSeries.slice(0, 200) + '”\n');
  ok('the drawing says the coming takes are identical', /IDENTICAL/.test(txtSeries),
    JSON.stringify(txtSeries.slice(0, 200)));
  ok('…and names what would give it dice', /Walk/i.test(txtSeries),
    JSON.stringify(txtSeries.slice(0, 200)));

  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.ground.parts['0'].mel.kind = 'walk';
    E.getCfg(); window._v2.render(E);
  });
  await zz(1100);
  const txtWalk = await say();
  console.log('   readout (walk line):\n     “' + txtWalk.slice(0, 200) + '”\n');
  ok('…and stops saying it once the part really does roll', !/IDENTICAL/.test(txtWalk),
    JSON.stringify(txtWalk.slice(0, 200)));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
