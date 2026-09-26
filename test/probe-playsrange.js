// PROBE — 🎲 Repeats as a RANGE: `parts[i].playsTo`.
//
// "This vamp runs 2 to 4 times." The last item on
// docs/bloom-arrangement-generative.md §4, and the one that was blocked twice over:
//   · `plays` was COUNTED TWICE (plays × _ambPartPassCols, which falls back to
//     _ambPartNaturalPasses = plays), so a range on top would have shipped numbers
//     that could not be read — "2 to 4" playing 4 to 16 times. Fixed first.
//   · the pass COLUMN had two readings, benign until a range made it load-bearing.
//     Fixed first too.
//
// ADDITIVE BY SHAPE: `plays` stays the plain number every existing reader reads and
// `playsTo` is a sibling. Absent, or not above `plays`, means FIXED — so every
// project written before this rolls nothing and plays exactly as it did.
//
//   node test/probe-playsrange.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(900);

  const setUp = () => page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = true; c.seed = 4242; c.barsPerChord = 1;
    c.prog.chords = [0, 5, 7, 9, 2, 4].map(r => ({ root: r, intervals: [0, 4, 7], bars: 1 }));
    c.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }, { name: 'C', len: 2 }];
    ['arrOrder', 'grid', 'arrGrid', 'chain'].forEach(k => delete c.prog[k]);
    c.prog.parts.forEach(pt => { delete pt.chance; delete pt.playsTo; delete pt.plays; });
    E.getCfg();
  });
  await setUp();

  // ---- 1. STORE --------------------------------------------------------------
  console.log('\n  1. store — a sibling of `plays`, fixed unless it is above it');
  const st = await page.evaluate(() => {
    const E = _masterEng, out = {};
    out.fresh = (E.getCfg().prog.parts || []).map(x => ('playsTo' in x));
    const c = E.getCfg(); c.prog.parts[0].plays = 2; c.prog.parts[0].playsTo = 4;
    const c2 = E.getCfg();
    out.kept = [c2.prog.parts[0].plays, c2.prog.parts[0].playsTo];
    out.engages = !!_ambGridOn(c2);
    // a ceiling AT the floor is fixed, and must not be stored
    const c3 = E.getCfg(); c3.prog.parts[1].plays = 3; c3.prog.parts[1].playsTo = 3;
    out.equalPruned = ('playsTo' in E.getCfg().prog.parts[1]);
    // …and one BELOW it too
    const c4 = E.getCfg(); c4.prog.parts[2].plays = 3; c4.prog.parts[2].playsTo = 2;
    out.belowPruned = ('playsTo' in E.getCfg().prog.parts[2]);
    // survives repeated normalizes (the fresh-object trap)
    E.getCfg(); const c5 = E.getCfg();
    out.survives = [c5.prog.parts[0].plays, c5.prog.parts[0].playsTo];
    return out;
  });
  ok('absent on every part to begin with', JSON.stringify(st.fresh) === '[false,false,false]',
    JSON.stringify(st.fresh));
  ok('a real range is stored as floor + ceiling', JSON.stringify(st.kept) === '[2,4]', JSON.stringify(st.kept));
  ok('…and engages the grid clock, so the roll is reachable', st.engages === true, String(st.engages));
  ok('a ceiling AT the floor is pruned — "fixed" has one representation',
    st.equalPruned === false, String(st.equalPruned));
  ok('…and one BELOW it too, so a range can never read backwards',
    st.belowPruned === false, String(st.belowPruned));
  ok('…and it survives repeated normalizes', JSON.stringify(st.survives) === '[2,4]',
    JSON.stringify(st.survives));

  // ---- 2. THE ROLL -----------------------------------------------------------
  console.log('\n  2. the roll — in range, varied, deterministic');
  const roll = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { delete pt.plays; delete pt.playsTo; });
    c.prog.parts[0].plays = 2; c.prog.parts[0].playsTo = 4;
    const cfg = E.getCfg();
    const h = _ambArrRoundHorizon(cfg, 1);
    const rolls = []; for (let r = 0; r < h; r++) rolls.push(_ambPartRepeatsRound(cfg, 0, r));
    const again = []; for (let r = 0; r < h; r++) again.push(_ambPartRepeatsRound(cfg, 0, r));
    const fixed = []; for (let r = 0; r < h; r++) fixed.push(_ambPartRepeatsRound(cfg, 1, r));
    return { h, rolls, again, fixed };
  });
  console.log('     horizon ' + roll.h + ', A at 2–4: ' + JSON.stringify(roll.rolls));
  ok('every roll lands inside the range', roll.rolls.every(v => v >= 2 && v <= 4), JSON.stringify(roll.rolls));
  ok('…and they are not all the same number', new Set(roll.rolls).size > 1, JSON.stringify(roll.rolls));
  ok('…deterministically — the same question twice gives the same answer',
    JSON.stringify(roll.rolls) === JSON.stringify(roll.again), JSON.stringify([roll.rolls, roll.again]));
  ok('a part with NO range never rolls', roll.fixed.every(v => v === 1), JSON.stringify(roll.fixed));

  // ---- 3. THE CLOCK ----------------------------------------------------------
  console.log('\n  3. the clock — rounds differ, the super-cycle stays whole');
  const clock = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { delete pt.plays; delete pt.playsTo; delete pt.chance; });
    c.prog.parts[0].plays = 2; c.prog.parts[0].playsTo = 4;
    const cfg = E.getCfg(), pl = _ambGridPlan(cfg);
    if (!pl) return { plan: false };
    const v = pl.slots.filter(x => x.pFirst).map(x => x.pi);
    const h = _ambArrRoundHorizon(cfg, 1);
    const aTotal = v.filter(x => x === 0).length;
    // B and C are fixed at one visit each, so they mark the round boundaries
    return { plan: true, h, cycle: pl.cycle, order: v.join(''), aTotal,
             bTotal: v.filter(x => x === 1).length, cTotal: v.filter(x => x === 2).length,
             whole: Math.abs(pl.cycle - Math.round(pl.cycle)) < 1e-9 };
  });
  console.log('     visits: ' + clock.order + '  cycle ' + clock.cycle +
              '  rounds ' + clock.bTotal + '  horizon ' + clock.h);
  ok('a range alone builds a plan', clock.plan === true, JSON.stringify(clock));
  // THE SUPER-CYCLE IS NOT THE HORIZON. It closes when the whole state repeats, and
  // with a range that means the horizon AND the column phase realigning: the
  // cumulative visit count advances by a different amount each round, so
  // `visits % partCols` takes its own time to come back round. Measured 8 rounds for
  // a horizon of 4. B is fixed at one visit per round, so IT counts the rounds.
  ok('the expansion runs past one round — the horizon is a floor, not the period',
    clock.bTotal >= clock.h, clock.bTotal + ' rounds, horizon ' + clock.h);
  ok('…the other fixed part appears exactly as often, so those are whole rounds',
    clock.bTotal === clock.cTotal, clock.bTotal + ' vs ' + clock.cTotal);
  ok('…while the ranged part stays inside its floor and ceiling across all of them',
    clock.aTotal >= 2 * clock.bTotal && clock.aTotal <= 4 * clock.bTotal,
    clock.aTotal + ' over ' + clock.bTotal + ' rounds of 2-4');
  ok('…and genuinely varies rather than sitting at one count',
    clock.aTotal !== 2 * clock.bTotal && clock.aTotal !== 4 * clock.bTotal,
    'A total ' + clock.aTotal + ' over ' + clock.bTotal + ' rounds');
  ok('…and the super-cycle is still a whole number of chord-bars',
    clock.whole === true, String(clock.cycle));

  // ---- 4. THE COLUMNS FOLLOW THE CEILING -------------------------------------
  console.log('\n  4. ▦ Passes draws the CEILING, not the roll');
  const cols = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { delete pt.plays; delete pt.playsTo; });
    c.prog.parts[0].plays = 2; c.prog.parts[0].playsTo = 4;
    const cfg = E.getCfg();
    return { drawn: _ambPartPassCols(cfg, 0), floor: 2, ceiling: 4,
             other: _ambPartPassCols(cfg, 1) };
  });
  ok('a part at 2–4 draws FOUR columns — the matrix must not resize while you listen',
    cols.drawn === 4, String(cols.drawn));
  ok('…and a part with no range still draws one', cols.other === 1, String(cols.other));

  // ---- 5. THE MEMO -----------------------------------------------------------
  console.log('\n  5. editing a range re-expands the plan');
  const memo = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { delete pt.plays; delete pt.playsTo; });
    c.prog.parts[0].plays = 2; c.prog.parts[0].playsTo = 4;
    const sig = () => { const pl = _ambGridPlan(E.getCfg());
      return pl ? pl.slots.filter(x => x.pFirst).map(x => x.pi).join('') + '@' + pl.cycle : ''; };
    const a = sig();
    const c2 = E.getCfg(); c2.prog.parts[0].playsTo = 6;
    const b = sig();
    const c3 = E.getCfg(); c3.prog.parts[0].playsTo = 4; c3.seed = 999;
    const d = sig();
    return { a, b, d };
  });
  ok('widening the range re-expands it', memo.a !== memo.b, JSON.stringify(memo));
  ok('…and a new take re-rolls the counts', memo.d !== memo.a, JSON.stringify(memo));

  // ---- 6. REACHABLE ----------------------------------------------------------
  console.log('\n  6. reachable — beside Repeats, driven with a real press');
  await setUp();
  await page.evaluate(() => { _ambOpenProgEditor(_masterEng, {}); });
  await zz(700);
  await page.evaluate(() => {
    const h = document.getElementById('ambient-prog-editor');
    const t = h && h.querySelector('.pe-parttab[data-pe="part:0"]');
    if (t) t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await zz(600);
  const ui = await page.evaluate(() => {
    const h = document.getElementById('ambient-prog-editor'); if (!h) return { there: false };
    const up = h.querySelector('[data-pe^="partplayshi"][data-pe$=":1"]');
    if (!up) return { there: true, up: null };
    const r = up.getBoundingClientRect();
    const grp = up.closest('.pe-partgrp');
    return { there: true,
             up: { w: Math.round(r.width), h: Math.round(r.height), par: !!up.offsetParent },
             hasRepeats: !!(grp && grp.querySelector('[data-pe^="partplays:"]')),
             hint: grp ? (grp.querySelector('.pe-partgrp-hint') || {}).textContent : null };
  });
  ok('the ceiling stepper MEASURES in the part editor',
    ui.up && ui.up.w > 20 && ui.up.h > 20 && ui.up.par, JSON.stringify(ui.up));
  ok('…in the same group as Repeats — one control, not two', ui.hasRepeats === true, String(ui.hasRepeats));
  ok('…reading as fixed until it is raised', /runs once|runs \d+×/.test(ui.hint || ''), JSON.stringify(ui.hint));

  const drive = await page.evaluate(() => {
    const out = {};
    const press = (sel, times) => { for (let i = 0; i < times; i++) {
      const el = document.getElementById('ambient-prog-editor').querySelector(sel);
      if (el) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } };
    press('[data-pe^="partplays:"][data-pe$=":1"]', 1);        // Repeats 1 → 2
    press('[data-pe^="partplayshi"][data-pe$=":1"]', 2);       // ceiling 2 → 4
    const ps = _ambPeParts(_ambProgEd), pi = _ambProgEd.part;
    out.range = [ps[pi].plays, ps[pi].playsTo];
    const g = document.getElementById('ambient-prog-editor').querySelector('[data-pechance]');
    out.hint = (document.getElementById('ambient-prog-editor')
      .querySelector('[data-pe^="partplayshi"]').closest('.pe-partgrp')
      .querySelector('.pe-partgrp-hint') || {}).textContent;
    // raising Repeats past the ceiling must drop the range, not invert it
    press('[data-pe^="partplays:"][data-pe$=":1"]', 3);        // Repeats 2 → 5
    const ps2 = _ambPeParts(_ambProgEd);
    out.afterRaise = [ps2[pi].plays, ps2[pi].playsTo == null ? 'absent' : ps2[pi].playsTo];
    return out;
  }).catch(e => ({ err: String(e) }));
  if (drive.err) { fail++; console.log('  ✗ drive block threw\n      ' + drive.err); }
  else {
    ok('pressing + on each builds a 2–4 range', JSON.stringify(drive.range) === '[2,4]',
      JSON.stringify(drive.range));
    ok('…and the hint says what that MEANS, not the numbers again',
      /different number each round/.test(drive.hint || ''), JSON.stringify(drive.hint));
    ok('raising Repeats past the ceiling drops the range rather than inverting it',
      drive.afterRaise[0] === 5 && drive.afterRaise[1] === 'absent', JSON.stringify(drive.afterRaise));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
