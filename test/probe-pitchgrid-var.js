// PROBE — ⌸ the pitch grid, stage 5: the knobs around it.
//
// Two claims:
//   · THE RHYTHM DICE THIN A GRID PER ROW. On every other material `vary`
//     perturbs the onset list, which here is the UNION of the rows — so it
//     would drop a whole chord at once, and its "add a silent slot" half is a
//     no-op because an added step names no note. Per row it means what it says:
//     any one voice may sit a turn out. And it must be rolled ONCE — rolling in
//     `onsetsOf` as well would thin twice with two disagreeing draws.
//   · A KNOB THE GRID ANSWERS MUST SAY SO. Hold ("this note is N steps long")
//     and Register ("the octave the notes sit in") are both answered by the
//     rows, and the emitter ignores them there — so the card must not offer
//     them as though they could act.
//
//   node test/probe-pitchgrid-var.js   (needs `npm start`; BLOOPS_URL to retarget)
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

  // A THREE-VOICE CHORD ON EVERY FOURTH STEP — so "a voice sat out" and "the
  // whole chord went" are different, visible answers.
  const setup = async (vary) => page.evaluate((vary) => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.notes; delete L.part.form;
    L.part.kind = 'euclid';
    L.part.form = 'steps';
    L.part.bars = 2;
    L.part.grid = 16;
    L.part.shape = Object.assign({}, L.part.shape, { lenShape: '', lenRatio: 90, holdSteps: 0, slip: 0 });
    L.restProb = 0; L.ghosts = 0; L.lenVary = 0; L.accent = 0;
    L.twist = 0; L.phrasing = 0; L.swing = 0; L.humanize = 0;
    delete L.chg; delete L.part.vary;
    const rows = {};
    [60, 64, 67].forEach((m) => { rows[String(m)] = { c: [0, 4, 8, 12, 16, 20, 24, 28].map((i) => [i, 1]) }; });
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'grid', rows: rows, inv: 0, drift: 0 });
    L.part.rhythm = Object.assign({}, L.part.rhythm, { vary: vary });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    return null;
  }, vary);

  const heard = () => page.evaluate(() => {
    const E = _masterEng, V = window._v2, L = (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cfg = E.getCfg(), cyc = V.cycleSec(L, cfg), st = L.part.rhythm.steps | 0;
    const cell = cyc / st;
    const ns = (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || []);
    return ns.map((n) => Math.round(n.at / cell) + ':' +
      Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).sort();
  });

  await setup(0);
  const plain = await heard();
  console.log('\n  vary 0: ' + plain.length + ' notes');
  ok('with the dice off, the grid plays exactly what is drawn',
    plain.length === 24 && new Set(plain).size === 24, JSON.stringify(plain.slice(0, 4)));

  await setup(100);
  const thin = await heard();
  const thin2 = await heard();
  console.log('  vary 100: ' + thin.length + ' notes');
  ok('the dice THIN it', thin.length > 0 && thin.length < plain.length,
    JSON.stringify({ off: plain.length, on: thin.length }));
  // PER ROW, NOT PER STEP: a thinned take must still put chords down — if the
  // dice were rolled over the union, whole steps would vanish together and the
  // survivors would be all-or-nothing per step.
  const perStep = {};
  thin.forEach((k) => { const st = k.split(':')[0]; perStep[st] = (perStep[st] || 0) + 1; });
  const sizes = Object.keys(perStep).map((k) => perStep[k]);
  ok('…per ROW — some steps keep a voice or two rather than all three or none',
    sizes.some((n) => n === 1 || n === 2), JSON.stringify(perStep));
  // …AND IT INVENTS NOTHING. Every survivor is a note that was drawn.
  const drawn = new Set(plain);
  ok('…and every surviving note is one that was drawn',
    thin.every((k) => drawn.has(k)), JSON.stringify(thin.filter((k) => !drawn.has(k)).slice(0, 4)));
  ok('…and the same take replays the same way', 
    thin.join('|') === thin2.join('|'), JSON.stringify({ a: thin.length, b: thin2.length }));

  // ── A KNOB THE GRID ANSWERS MUST SAY SO ─────────────────────────────────
  await setup(0);
  await page.evaluate(() => {
    [...document.querySelectorAll('.v2-layer')].forEach((c) => {
      if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
    });
  });
  await zz(900);
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
  const gated = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const state = (path) => {
      const f = c.querySelector('.v2-f[data-f="' + path + '"]');
      if (!f) return 'absent';
      const row = f.closest('.ambient-ctrl');
      if (!row) return 'loose';
      if (row.hidden || !row.offsetParent) return 'hidden';
      return (f.disabled || row.classList.contains('v2-rowna')) ? 'greyed' : 'live';
    };
    return { hold: state('part.shape.holdSteps'), reg: state('instrument.register'),
             // a control the grid does NOT answer stays live, so this is not
             // just "everything went away"
             len: state('part.shape.lenRatio') };
  });
  console.log('  gated: ' + JSON.stringify(gated));
  ok('Hold does not offer itself on a grid — the rows answer that question',
    gated.hold === 'hidden' || gated.hold === 'greyed' || gated.hold === 'absent',
    JSON.stringify(gated));
  ok('…nor does Register, where a row IS an absolute note',
    gated.reg === 'hidden' || gated.reg === 'greyed' || gated.reg === 'absent',
    JSON.stringify(gated));
  ok('…while Note length, which the grid does NOT answer, stays live',
    gated.len === 'live', JSON.stringify(gated));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
