// PROBE — 🎲 Chance: `parts[i].chance`, a part that plays some rounds and not others.
//
// Sections have had 100/60/30/0 cells since v2; PARTS had nothing, so "the bridge
// comes round one time in three" was not sayable. The semantics were already
// settled by the part matrix: **OFF = SKIPPED, the round is genuinely shorter**
// (decision 1) — a skipped part is an existing supported state, and this only
// decides it by a seeded hash instead of by a written empty cell.
//
// UNLIKE ↻ Parts, THIS CHANGES A ROUND'S LENGTH. That is what the horizon buys:
// the SUPER-CYCLE is the unit that must hold still, and `plan.cycle` is its total
// however the rounds inside it vary. Both per-round dice therefore have to share
// ONE horizon — two periods would let the state key close the super-cycle while
// the other die was still varying.
//
//   node test/probe-partchance.js      (needs `npm start`; BLOOPS_URL to retarget)
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
    delete c.prog.arrOrder; delete c.prog.grid; delete c.prog.arrGrid; delete c.prog.chain;
    const c2 = E.getCfg();
    return { parts: (c2.prog.parts || []).map(x => x.name), gridOn: !!_ambGridOn(c2) };
  });
  const s0 = await setUp();
  console.log('\n  setup: ' + JSON.stringify(s0));
  ok('three parts, no grid clock yet', s0.parts.length === 3 && s0.gridOn === false, JSON.stringify(s0));

  // ---- 1. STORE --------------------------------------------------------------
  console.log('\n  1. store — 100 is absence, 0 is a state you can set');
  const st = await page.evaluate(() => {
    const E = _masterEng, out = {};
    out.fresh = (E.getCfg().prog.parts || []).map(x => ('chance' in x));
    const c = E.getCfg(); c.prog.parts[1].chance = 100;
    out.hundredPruned = ('chance' in E.getCfg().prog.parts[1]);
    const c2 = E.getCfg(); c2.prog.parts[1].chance = 40;
    const c3 = E.getCfg();
    out.stored = c3.prog.parts[1].chance;
    out.engages = !!_ambGridOn(c3);
    c3.prog.parts[2].chance = 0;
    const c4 = E.getCfg();
    out.zeroKept = c4.prog.parts[2].chance === 0;
    const c5 = E.getCfg(); c5.prog.parts[1].chance = 500;
    out.clamped = E.getCfg().prog.parts[1].chance;
    return out;
  });
  ok('absent on every part to begin with', JSON.stringify(st.fresh) === '[false,false,false]',
    JSON.stringify(st.fresh));
  ok('100 is pruned — "always" has one representation', st.hundredPruned === false, String(st.hundredPruned));
  ok('a real chance is stored, and engages the grid clock',
    st.stored === 40 && st.engages === true, JSON.stringify([st.stored, st.engages]));
  ok('0 is KEPT — "never, for now" is a state you set deliberately',
    st.zeroKept === true, String(st.zeroKept));
  ok('out-of-range clamps', st.clamped === 100 || st.clamped === undefined, String(st.clamped));

  // ---- 2. THE DICE -----------------------------------------------------------
  console.log('\n  2. the dice — deterministic, and it really skips');
  await setUp();
  const dice = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts[1].chance = 50;
    const cfg = E.getCfg();
    const h = _ambArrRoundHorizon(cfg, 1);
    const rolls = []; for (let r = 0; r < h; r++) rolls.push(_ambPartPlaysRound(cfg, 1, r) ? 1 : 0);
    const again = []; for (let r = 0; r < h; r++) again.push(_ambPartPlaysRound(cfg, 1, r) ? 1 : 0);
    // always / never are not dice at all
    const c2 = E.getCfg(); c2.prog.parts[0].chance = 0;
    const cfg2 = E.getCfg();
    const never = [0, 1, 2, 3].map(r => _ambPartPlaysRound(cfg2, 0, r) ? 1 : 0);
    const always = [0, 1, 2, 3].map(r => _ambPartPlaysRound(cfg2, 2, r) ? 1 : 0);
    return { h, rolls, again, never, always };
  });
  console.log('     horizon ' + dice.h + ', part B at 50%: ' + JSON.stringify(dice.rolls));
  ok('the horizon is more than one round, so a skip pattern can exist at all',
    dice.h > 1, String(dice.h));
  ok('a 50% part plays some rounds and not others',
    dice.rolls.some(x => x === 1) && dice.rolls.some(x => x === 0), JSON.stringify(dice.rolls));
  ok('…deterministically — the same question twice gives the same answer',
    JSON.stringify(dice.rolls) === JSON.stringify(dice.again), JSON.stringify([dice.rolls, dice.again]));
  ok('0% never plays', dice.never.every(x => x === 0), JSON.stringify(dice.never));
  ok('absent always plays', dice.always.every(x => x === 1), JSON.stringify(dice.always));

  // ---- 3. THE CLOCK ----------------------------------------------------------
  console.log('\n  3. the clock — rounds get shorter, the super-cycle stays whole');
  const clock = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    delete c.prog.parts[0].chance; delete c.prog.parts[1].chance; delete c.prog.parts[2].chance;
    c.prog.parts[1].chance = 50;
    const cfg = E.getCfg();
    const pl = _ambGridPlan(cfg);
    const h = _ambArrRoundHorizon(cfg, 1);
    if (!pl) return { plan: false };
    // one entry per part-visit, in play order
    const visits = pl.slots.filter(x => x.pFirst).map(x => x.pi);
    // rounds are delimited by the walk; count B's appearances against the horizon
    const bCount = visits.filter(x => x === 1).length;
    const aCount = visits.filter(x => x === 0).length;
    return { plan: true, h, cycle: pl.cycle, visits: visits.join(''), aCount, bCount };
  });
  console.log('     visits: ' + JSON.stringify(clock.visits) + '  cycle ' + clock.cycle);
  ok('a chance alone builds a plan (the grid clock is engaged)', clock.plan === true, JSON.stringify(clock));
  ok('the never-skipped parts appear once per round across the whole horizon',
    clock.aCount === clock.h, clock.aCount + ' vs horizon ' + clock.h);
  ok('…while the 50% part appears FEWER times — it is genuinely skipped',
    clock.bCount > 0 && clock.bCount < clock.h, clock.bCount + ' of ' + clock.h);
  ok('…so the super-cycle is SHORTER than every round playing in full',
    clock.cycle < 6 * clock.h && clock.cycle > 0, clock.cycle + ' < ' + (6 * clock.h));
  ok('…and it is still a whole number of chord-bars (no fractional round)',
    Math.abs(clock.cycle - Math.round(clock.cycle)) < 1e-9, String(clock.cycle));

  // ---- 4. A ROUND IS NEVER EMPTY ---------------------------------------------
  console.log('\n  4. every part rolling badly must not make a zero-length round');
  const empty = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { pt.chance = 0; });          // nothing may play
    const cfg = E.getCfg();
    const pl = _ambGridPlan(cfg);
    return { plan: !!pl, cycle: pl ? pl.cycle : 0, slots: pl ? pl.slots.length : 0 };
  });
  ok('with every part at 0% the round falls back to AS WRITTEN, not to nothing',
    empty.plan === true && empty.cycle > 0 && empty.slots > 0, JSON.stringify(empty));

  // ---- 4b. THE PLAN MEMO SEES A CHANCE EDIT ---------------------------------
  console.log('\n  4b. editing a chance re-expands the plan');
  const memo = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { delete pt.chance; });
    c.prog.parts[1].chance = 50;
    const vis = () => { const pl = _ambGridPlan(E.getCfg());
      return pl ? pl.slots.filter(x => x.pFirst).map(x => x.pi).join('') + '@' + pl.cycle : ''; };
    const a1 = vis();
    // …a DIFFERENT chance must give a different expansion, with nothing else moved
    const c2 = E.getCfg(); c2.prog.parts[1].chance = 10;
    const a2 = vis();
    // …and so must a new take, because the roll is a function of the seed
    const c3 = E.getCfg(); c3.prog.parts[1].chance = 50; c3.seed = 31337;
    const a3 = vis();
    return { a1, a2, a3 };
  });
  ok('changing a chance re-expands the plan (no stale slots)',
    memo.a1 !== memo.a2, JSON.stringify(memo));
  ok('…and a new take re-rolls which rounds it plays',
    memo.a3 !== memo.a1, JSON.stringify(memo));

  // ---- 5. THE TWO DICE SHARE ONE HORIZON -------------------------------------
  console.log('\n  5. ↻ Parts and 🎲 Chance agree on one period');
  const shared = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts.forEach(pt => { delete pt.chance; });
    const only = {};
    c.prog.arrOrder = { mode: 'shuffle', when: '100' };       // period 3
    only.order = _ambArrRoundHorizon(E.getCfg(), 1);
    const c2 = E.getCfg(); delete c2.prog.arrOrder; c2.prog.parts[1].chance = 50;
    only.chance = _ambArrRoundHorizon(E.getCfg(), 1);
    const c3 = E.getCfg(); c3.prog.arrOrder = { mode: 'shuffle', when: '100' };
    only.both = _ambArrRoundHorizon(E.getCfg(), 1);
    return only;
  });
  console.log('     order ' + shared.order + ' · chance ' + shared.chance + ' · both ' + shared.both);
  ok('together they take the LCM, not one of the two',
    shared.both % shared.order === 0 && shared.both % shared.chance === 0 &&
    shared.both >= Math.max(shared.order, shared.chance), JSON.stringify(shared));

  // ---- 5b. `plays` IS COUNTED ONCE -------------------------------------------
  // A DECISION WITH A RIGHT ANSWER, so it is asserted here and not only pinned in
  // arch-parity: a part is visited `cols × plays` times. `_ambPartPassCols` falls
  // back to `_ambPartNaturalPasses` for a grid-less part and natural passes ARE
  // `plays`, so the default walk used to read `plays` twice — `plays: 3` played NINE
  // times. Only reachable without a grid once ↻ Parts / 🎲 Chance began engaging the
  // grid clock, which is how it surfaced.
  console.log('\n  5b. a part is visited cols × plays times, not plays × plays');
  const counts = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = true; c.seed = 4242; c.barsPerChord = 1;
    c.prog.chords = [0, 5, 7, 9, 2, 4].map(r => ({ root: r, intervals: [0, 4, 7], bars: 1 }));
    // A: a real grid (cols 3) AND plays 2 → 6.   C: plays 3, NO grid → 3, not 9.
    c.prog.parts = [{ name: 'A', len: 3, plays: 2, grid: { cols: 3, seq: { 1: [0], 2: [2, 0] } } },
                    { name: 'B', len: 1 }, { name: 'C', len: 2, plays: 3 }];
    delete c.prog.arrOrder; delete c.prog.arrGrid; delete c.prog.chain;
    c.prog.parts.forEach(pt => { delete pt.chance; });
    const cfg = E.getCfg(), pl = _ambGridPlan(cfg);
    if (!pl) return { plan: false };
    const v = pl.slots.filter(x => x.pFirst);
    const per = {}; v.forEach(x => { per[x.pi] = (per[x.pi] || 0) + 1; });
    return { plan: true, per, cycle: pl.cycle, order: v.map(x => x.pi).join('') };
  });
  console.log('     visits per part: ' + JSON.stringify(counts.per) + '  cycle ' + counts.cycle);
  ok('a part with a grid of 3 and Repeats 2 is visited 6 times (cols × plays)',
    counts.per && counts.per['0'] === 6, JSON.stringify(counts.per));
  ok('a part with Repeats 3 and NO grid is visited 3 times, not 9',
    counts.per && counts.per['2'] === 3, JSON.stringify(counts.per));
  ok('a part with neither is visited once', counts.per && counts.per['1'] === 1,
    JSON.stringify(counts.per));
  ok('…and the cycle is the sum of what those visits actually cover',
    counts.cycle === 19, String(counts.cycle));

  // ONE READING OF "HOW MANY PASSES". `_ambGridSlots` used to stamp `col` from the
  // part's GRID width while ▦ Passes drew `_ambPartPassCols` — which falls back to
  // Repeats when there is no grid. So a grid-less part with Repeats 3 played three
  // visits all stamped column 0 against three drawn columns, and every per-pass
  // override past the first was unreachable, silently.
  const cols = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts = [{ name: 'A', len: 2, plays: 3 },
                    { name: 'B', len: 2, grid: { cols: 2, seq: { 1: [1, 0] } } },
                    { name: 'C', len: 2 }];
    const cfg = E.getCfg(), pl = _ambGridPlan(cfg);
    if (!pl) return { plan: false };
    const played = {}, drawn = {};
    pl.slots.filter(x => x.pFirst).forEach(x => { (played[x.pi] = played[x.pi] || []).push(x.col); });
    [0, 1, 2].forEach(i => { drawn[i] = _ambPartPassCols(cfg, i); });
    return { plan: true, played, drawn };
  });
  console.log('     columns played ' + JSON.stringify(cols.played) + ' · drawn ' + JSON.stringify(cols.drawn));
  ok('a grid-less part with Repeats 3 walks columns 0·1·2, not 0·0·0',
    cols.played && JSON.stringify(cols.played['0']) === '[0,1,2]', JSON.stringify(cols.played));
  ok('…and every part plays exactly the columns ▦ Passes draws for it',
    cols.drawn && [0, 1, 2].every(i => (cols.played[i] || []).length === cols.drawn[i] &&
      (cols.played[i] || []).every((cv, k) => cv === k)),
    JSON.stringify([cols.played, cols.drawn]));

  // ---- 6. REACHABLE ----------------------------------------------------------
  console.log('\n  6. reachable — the part editor, measured');
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
    const f = h.querySelector('[data-pechance]');
    if (!f) return { there: true, field: null };
    const r = f.getBoundingClientRect();
    const grp = f.closest('.pe-partgrp');
    return { there: true,
             field: { w: Math.round(r.width), h: Math.round(r.height), par: !!f.offsetParent, val: f.value },
             hint: grp ? (grp.querySelector('.pe-partgrp-hint') || {}).textContent : null,
             nearRepeats: !!(grp && grp.previousElementSibling &&
               /Repeats/.test(grp.previousElementSibling.textContent || '')) };
  });
  ok('the Chance field MEASURES in the part editor',
    ui.field && ui.field.w > 20 && ui.field.par, JSON.stringify(ui.field));
  ok('…defaulting to 100, and saying so in words',
    ui.field && ui.field.val === '100' && /every time/i.test(ui.hint || ''), JSON.stringify([ui.field, ui.hint]));
  ok('…sitting beside Repeats, which is the other half of the part’s schedule',
    ui.nearRepeats === true, String(ui.nearRepeats));

  const drive = await page.evaluate(() => {
    const h = document.getElementById('ambient-prog-editor'), out = {};
    const f = h.querySelector('[data-pechance]');
    f.value = '30'; f.dispatchEvent(new Event('change', { bubbles: true }));
    return new Promise((res) => setTimeout(() => {
      const ps = _ambPeParts(_ambProgEd);
      out.written = ps && ps[_ambProgEd.part] ? ps[_ambProgEd.part].chance : null;
      const h2 = document.getElementById('ambient-prog-editor');
      const g2 = h2.querySelector('[data-pechance]').closest('.pe-partgrp');
      out.hint = (g2.querySelector('.pe-partgrp-hint') || {}).textContent;
      const f2 = h2.querySelector('[data-pechance]');
      f2.value = '100'; f2.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        const ps2 = _ambPeParts(_ambProgEd);
        out.cleared = !(ps2 && ps2[_ambProgEd.part] && Number.isFinite(ps2[_ambProgEd.part].chance));
        res(out);
      }, 250);
    }, 300));
  }).catch(e => ({ err: String(e) }));
  if (drive.err) { fail++; console.log('  ✗ drive block threw\n      ' + drive.err); }
  else {
    ok('typing a chance writes through', drive.written === 30, String(drive.written));
    ok('…and the hint states the consequence, not the number again',
      /30% of the time/.test(drive.hint || ''), JSON.stringify(drive.hint));
    ok('back to 100 deletes it again', drive.cleared === true, String(drive.cleared));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
