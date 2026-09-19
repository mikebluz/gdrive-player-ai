// PROBE — with a FREE clock, the CYCLE is the bar.
//
// `part.bars` is hidden when Cycle is Free (its row is gated `clock:bars`) but
// it stayed stored, and every bar-derived DENSITY quantity went on dividing by
// it: the gap floor, the note-length floor, the snap grid, the ghost floor and
// the per-bar budget of the density ceiling. So a number with no control on the
// card decided how tightly the dice could pack, and the same free layer sounded
// different depending on what Bars happened to be when you last left the grid.
//
// The claim now: on a FREE clock the output does not depend on `part.bars` AT
// ALL, and the floor is a 16th of the CYCLE. On the grid clock Bars still means
// everything it did — that half must not be flattened by the fix.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);

  const run = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.pitch = { kind: 'fixed', degree: 1 };
    E.getCfg();
    const sig = () => {
      const cyc = window._v2.cycleSec(L(), E.getCfg());
      const ns = (window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: cyc })) || [])
        .slice().sort((a, b) => a.at - b.at);
      const at = ns.map((n) => Math.round(n.at * 1000));
      let mg = Infinity;
      for (let i = 1; i < at.length; i++) mg = Math.min(mg, at[i] - at[i - 1]);
      return { s: at.join(',') + '|' + ns.map((n) => Math.round(n.durMs)).join(','),
               n: at.length, mg: at.length > 1 ? mg : null };
    };
    const DICE = ['twist', 'ghosts', 'phrasing', 'lenVary'];
    const setup = (r, d) => {
      DICE.forEach((k) => delete L()[k]);
      L().part.rhythm = JSON.parse(JSON.stringify(r));
      Object.keys(d).forEach((k) => { L()[k] = d[k]; });
    };
    const o = {};
    // ── THE FIXTURES ─────────────────────────────────────────────────
    // Each one is a case where the output PROVABLY depended on the hidden Bars
    // before the fix — found by running the unfixed code over a grid of
    // rhythm × dice combinations and keeping the ones that differed, rather
    // than by picking a plausible-looking fixture. (The first version of this
    // probe used a sparse pattern and two of its three checks passed under
    // poison: the dice never came near the floors, so the floors' value did
    // not matter.) `was` records what the unfixed code produced.
    const P8 = { kind: 'pulse', n: 8, steps: 8 };
    const P4 = { kind: 'pulse', n: 4, steps: 16 };
    o.cases = [];
    [['pulse8+twist', P8, { twist: 100 }, '8 notes at Bars 1, 12 at Bars 4'],
     ['pulse8+phrasing', P8, { phrasing: 100 }, '15 vs 16 notes; min gap 250 vs 83 ms'],
     ['pulse8+ghosts', P8, { ghosts: 100 }, 'same count, different placement'],
     ['pulse4+twist+ghosts', P4, { twist: 80, ghosts: 80 }, '5 notes vs 8'],
    ].forEach(([name, r, d, was]) => {
      L().part.clock = 'free'; L().part.ms = 4000;
      setup(r, {});                       // the pattern ALONE, for comparison
      L().part.bars = 1; E.getCfg(); const bare = sig();
      setup(r, d);
      L().part.bars = 1; E.getCfg(); const a1 = sig();
      L().part.bars = 4; E.getCfg(); const a4 = sig();
      L().part.bars = 16; E.getCfg(); const a16 = sig();
      o.cases.push({ name: name, was: was, same: a1.s === a4.s && a4.s === a16.s,
                     n: a1.n, bare: bare.n, mg: a1.mg, at: a1.s.split('|')[0] });
    });
    // ── THE FLOOR REALLY IS THE CYCLE'S ─────────────────────────────
    // A property check, not a regression one: the ghost floor is a 32nd of the
    // musical unit, so doubling a FREE cycle must double the tightest gap.
    setup(P8, { ghosts: 100 });
    L().part.clock = 'free'; L().part.bars = 2;
    L().part.ms = 4000; E.getCfg(); o.short = sig();
    L().part.ms = 8000; E.getCfg(); o.long = sig();
    // ── THE GRID CLOCK IS UNTOUCHED ─────────────────────────────────
    setup(P8, { twist: 100 });
    L().part.clock = 'bars'; delete L().part.ms;
    L().part.bars = 1; E.getCfg(); o.b1 = sig();
    L().part.bars = 4; E.getCfg(); o.b4 = sig();
    DICE.forEach((k) => delete L()[k]);
    // ── AND THE ROW REALLY IS HIDDEN WHEN FREE (why it went unnoticed) ──
    const repaint = async () => {
      const h = document.getElementById('bloom-v2-layers');
      const un = () => { const c = document.querySelector('.v2-layer'); if (c) c.classList.remove('collapsed'); };
      if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
      if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(140);
    };
    const barsRowVisible = async () => {
      await repaint();
      const d = document.querySelector('.v2-layer .v2-gototab[data-goto="Time"]');
      if (d) { d.click(); await wait(440); }
      const bt = document.querySelector('.v2-layer .v2-pop-tabs [data-tab="Bars"]');
      if (bt) { bt.click(); await wait(300); }
      const row = [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')]
        .find((x) => (((x.querySelector('label') || {}).textContent) || '').trim() === 'Bars');
      return row ? Math.round(row.getBoundingClientRect().height) : -1;
    };
    L().part.clock = 'bars'; E.getCfg(); o.rowOnGrid = await barsRowVisible();
    L().part.clock = 'free'; L().part.ms = 4000; E.getCfg(); o.rowOnFree = await barsRowVisible();
    return o;
  });

  // ── THE FIX, on four fixtures that each depended on Bars before it ────
  run.cases.forEach((c) => {
    ok('FREE ' + c.name + ': output no longer depends on Bars (was ' + c.was + ')',
      c.same, JSON.stringify(c));
  });
  // THE DICE MUST ACTUALLY BE DOING SOMETHING, or these compare two silences.
  // Not all four: with the cycle as the bar, a 4 s cycle of 8 onsets has 500 ms
  // slots and a 250 ms floor, so Twist's burst cannot fit one in — which is the
  // fix working, not a dead fixture (it added 4 notes when the floor came from
  // a hidden Bars 4). Three of the four still add, and that is the guard.
  ok('…and the fixtures really exercise the dice — notes were added',
    run.cases.filter((c) => c.n > c.bare).length >= 3,
    JSON.stringify(run.cases.map((c) => c.name + ' ' + c.bare + '\u2192' + c.n)));
  // A PROPERTY check: the floor is a fraction of the CYCLE, so it scales with it.
  ok('the floor comes from the cycle — doubling Every doubles the tightest gap',
    run.short.mg !== null && run.long.mg !== null &&
    Math.abs(run.long.mg - run.short.mg * 2) <= 2,
    JSON.stringify({ at4000: run.short.mg, at8000: run.long.mg }));
  // ── AND THE HALF THAT MUST NOT CHANGE ────────────────────────────────
  ok('the GRID clock is untouched — Bars still changes everything there',
    run.b1.s !== run.b4.s, JSON.stringify({ b1: run.b1.n, b4: run.b4.n }));
  ok('the Bars row is shown on the grid clock and HIDDEN when Free',
    run.rowOnGrid > 0 && run.rowOnFree <= 0,
    JSON.stringify({ grid: run.rowOnGrid, free: run.rowOnFree }));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  run.cases.forEach((c) => console.log('  ' + c.name + ': ' + c.at + '  (min gap ' + c.mg + ' ms)'));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
