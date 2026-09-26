// PROBE — ↻ Parts: `prog.arrOrder`, ↻ Order one rung up.
//
// ↻ Order permutes the CHORDS inside a set of changes; this permutes the PARTS
// inside a round. Same store shape, same When grid, same dedicated seeded RNG.
//
// WHY A PERMUTATION AND NOT A SKIP. `_ambGridSlots` expands the super-cycle by
// simulating until its state key repeats, and `plan.cycle` — which `gloops` is
// derived from — is that expansion's total. A permutation holds the SAME parts, so
// a round's length is invariant and the arrangement stays as long as it was. A
// dice-rolled skip changes the length and cannot ride the cached plan at all.
//
// THE HORIZON is what keeps the expansion finite: a shuffle seeded on the round
// never repeats, so the state key never would either and the walk would run to
// _AMB_GRID_MAX_ITERS with a meaningless total. The order is declared to repeat
// every `_AMB_ARRORDER_ROUNDS` rounds and that period rides IN the key.
//
//   node test/probe-arrorder.js      (needs `npm start`; BLOOPS_URL to retarget)
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

  // THREE parts of two 1-bar chords each — three is the smallest count where a
  // shuffle and a reverse differ, so a test cannot pass by accident.
  const setUp = () => page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = true;
    c.prog.chords = [];
    for (let i = 0; i < 6; i++) c.prog.chords.push({ root: (i * 2) % 12, intervals: [0, 4, 7], bars: 1 });
    c.barsPerChord = 1;
    c.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }, { name: 'C', len: 2 }];
    c.seed = 4242;
    delete c.prog.arrOrder; delete c.prog.grid; delete c.prog.arrGrid; delete c.prog.chain;
    const c2 = E.getCfg();
    return { parts: (c2.prog.parts || []).map(x => x.name),
             ranges: (_ambGridRanges(c2) || []).length, gridOn: !!_ambGridOn(c2) };
  });
  const s0 = await setUp();
  console.log('\n  setup: ' + JSON.stringify(s0));
  ok('three parts of two chords, and no grid clock yet',
    s0.parts.length === 3 && s0.ranges === 3 && s0.gridOn === false, JSON.stringify(s0));

  // ---- 1. STORE + ENGAGEMENT -------------------------------------------------
  console.log('\n  1. store, and it switches the grid clock on');
  const st = await page.evaluate(() => {
    const E = _masterEng, out = {};
    out.fresh = ('arrOrder' in E.getCfg().prog);
    const c = E.getCfg(); c.prog.arrOrder = { mode: 'nonsense' };
    out.badDropped = ('arrOrder' in E.getCfg().prog);
    const c2 = E.getCfg(); c2.prog.arrOrder = { mode: 'shuffle', when: 'zzz' };
    const c3 = E.getCfg();
    out.coerced = JSON.parse(JSON.stringify(c3.prog.arrOrder));
    out.engages = !!_ambGridOn(c3);
    // ONE part is nothing to reorder — it must NOT switch the clock on
    const c4 = E.getCfg(); c4.prog.parts = [{ name: 'A', len: 6 }];
    const c5 = E.getCfg();
    out.onePartInert = !_ambArrOrderOn(c5);
    return out;
  });
  ok('absent by default', st.fresh === false, String(st.fresh));
  ok('a bad mode is dropped whole', st.badDropped === false, String(st.badDropped));
  ok('a bad When falls back to "always"',
    st.coerced && st.coerced.mode === 'shuffle' && st.coerced.when === 'always', JSON.stringify(st.coerced));
  ok('…and engaging it switches the grid clock on, so the permutation is reachable',
    st.engages === true, String(st.engages));
  ok('ONE part is not a question — it stays inert rather than offering a dead control',
    st.onePartInert === true, String(st.onePartInert));

  // ---- 2. THE PERMUTATION ----------------------------------------------------
  console.log('\n  2. the permutation itself');
  await setUp();
  const perm = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.arrOrder = { mode: 'reverse', when: 'always' };
    const c1 = E.getCfg();
    const rev = [0, 1, 2].map(r => _ambArrOrderPerm(c1, 3, r));
    c1.prog.arrOrder = { mode: 'shuffle', when: 'always' };
    const c2 = E.getCfg();
    const sh = [0, 1, 2, 3, 4, 5].map(r => (_ambArrOrderPerm(c2, 3, r) || []).join(''));
    c2.prog.arrOrder = { mode: 'shuffle', when: '10' };   // 1 in 2
    const c3 = E.getCfg();
    const gated = [0, 1, 2, 3].map(r => _ambArrOrderPerm(c3, 3, r) ? 'perm' : 'written');
    return { rev, sh, gated, horizon: _ambArrOrderRounds(c2, 1) };
  });
  console.log('     shuffle rounds 0..5: ' + JSON.stringify(perm.sh));
  ok('reverse is the written order backwards, every round',
    JSON.stringify(perm.rev) === JSON.stringify([[2,1,0],[2,1,0],[2,1,0]]), JSON.stringify(perm.rev));
  ok('shuffle gives a real permutation of every part — it reorders, never drops',
    perm.sh.every(x => x.length === 3 && x.split('').sort().join('') === '012'), JSON.stringify(perm.sh));
  ok('…differing between rounds', new Set(perm.sh.slice(0, 4)).size > 1, JSON.stringify(perm.sh));
  ok('…and REPEATING at the declared horizon, so the super-cycle can close',
    perm.sh[0] === perm.sh[perm.horizon] && perm.horizon > 1,
    'horizon ' + perm.horizon + ' ' + JSON.stringify(perm.sh));
  ok('a When grid leaves the ungated rounds written',
    JSON.stringify(perm.gated) === '["perm","written","perm","written"]', JSON.stringify(perm.gated));

  // ---- 3. THE CLOCK — the length is what must not move ----------------------
  console.log('\n  3. the super-cycle closes, and keeps its length');
  const clock = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    delete c.prog.arrOrder;
    // THERE IS NO PLAN TO COMPARE AGAINST, and that is the point: ↻ Parts is what
    // engages the grid clock, so with it off `_ambGridPlan` is null and the chord
    // walk runs instead. The written baseline is therefore the progression's own
    // round — six 1-bar chords — which is what `reverse` must come back equal to.
    const plainPlan = _ambGridPlan(E.getCfg());
    const written = { plan: !!plainPlan,
      cycle: (c.prog.chords || []).reduce((n, ch) => n + ((ch && ch.bars) || 1), 0),
      slots: (c.prog.chords || []).length, order: '012' };
    const c2 = E.getCfg(); c2.prog.arrOrder = { mode: 'shuffle', when: 'always' };
    const p2 = _ambGridPlan(E.getCfg());
    const shuffled = p2 ? { slots: p2.slots.length, cycle: p2.cycle,
      order: p2.slots.filter(x => x.pFirst).map(x => x.pi).join('') } : null;
    // CAPTURE THE HORIZON WHILE SHUFFLE IS SET. `reverse`'s horizon is its When
    // grid's alone (1 with 'always'), so reading it after the switch below reports
    // the wrong axis' answer.
    const horizon = _ambArrOrderRounds(E.getCfg(), 6);
    const c3 = E.getCfg(); c3.prog.arrOrder = { mode: 'reverse', when: 'always' };
    const p3 = _ambGridPlan(E.getCfg());
    const reversed = p3 ? { slots: p3.slots.length, cycle: p3.cycle,
      order: p3.slots.filter(x => x.pFirst).map(x => x.pi).join('') } : null;
    return { written, shuffled, reversed, horizon };
  });
  console.log('     written : ' + JSON.stringify(clock.written));
  console.log('     shuffled: ' + JSON.stringify(clock.shuffled));
  console.log('     reversed: ' + JSON.stringify(clock.reversed));
  ok('with ↻ Parts off there is NO grid plan at all — the plain chord walk runs',
    clock.written && clock.written.plan === false, JSON.stringify(clock.written));
  ok('reverse plays the parts backwards',
    clock.reversed && clock.reversed.order === '210', JSON.stringify(clock.reversed));
  ok('…in the SAME number of bars — a permutation keeps the round’s length',
    clock.reversed && clock.written && clock.reversed.cycle === clock.written.cycle,
    clock.reversed.cycle + ' vs ' + clock.written.cycle);
  ok('shuffle expands to the horizon instead of closing after one round',
    !!clock.shuffled && clock.shuffled.order.length === 3 * clock.horizon,
    'order ' + (clock.shuffled || {}).order + ' horizon ' + clock.horizon);
  ok('…and that super-cycle is exactly `horizon` written rounds long',
    !!clock.shuffled && clock.shuffled.cycle === clock.written.cycle * clock.horizon,
    (clock.shuffled || {}).cycle + ' vs ' + (clock.written.cycle * clock.horizon));
  ok('…with every round still holding all three parts (nothing dropped, nothing doubled)',
    !!clock.shuffled && clock.shuffled.order.match(/.{3}/g).every(r => r.split('').sort().join('') === '012'),
    (clock.shuffled || {}).order);
  ok('…and the rounds are not all the same order', !!clock.shuffled &&
    new Set(clock.shuffled.order.match(/.{3}/g)).size > 1, (clock.shuffled || {}).order);

  // ---- 3b. IT MOVES PARTS, NOT VISITS ---------------------------------------
  console.log('\n  3b. a part\u2019s passes stay together');
  const runs = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    // A has TWO passes, so its two visits are adjacent in the written round. A
    // shuffle that permuted VISITS would deal the second one to the far side of C,
    // undoing the "a part runs its passes back to back" rule.
    c.prog.parts = [{ name: 'A', len: 2, grid: { cols: 2, seq: { 1: [1, 0] } } },
                    { name: 'B', len: 2 }, { name: 'C', len: 2 }];
    c.prog.arrOrder = { mode: 'shuffle', when: 'always' };
    const pl = _ambGridPlan(E.getCfg());
    const order = pl ? pl.slots.filter(x => x.pFirst).map(x => x.pi).join('') : '';
    const rounds = order.match(/.{4}/g) || [];
    return { order, rounds, adjacent: rounds.every(r => /00/.test(r)),
             everyRoundWhole: rounds.every(r => r.split('').sort().join('') === '0012') };
  });
  console.log('     rounds: ' + JSON.stringify(runs.rounds));
  ok('a part with two passes keeps them ADJACENT in every shuffled round',
    runs.adjacent === true, JSON.stringify(runs.rounds));
  ok('…and every round still holds exactly the written multiset of visits',
    runs.everyRoundWhole === true, JSON.stringify(runs.rounds));
  ok('…while the rounds genuinely differ', new Set(runs.rounds).size > 1, JSON.stringify(runs.rounds));

  // ---- 4. THE MEMO -----------------------------------------------------------
  console.log('\n  4. the plan memo sees it');
  await setUp();
  const memo = await page.evaluate(() => {
    const E = _masterEng;
    const ord = () => { const p = _ambGridPlan(E.getCfg());
      return p ? p.slots.filter(x => x.pFirst).map(x => x.pi).join('') : ''; };
    const c = E.getCfg(); c.prog.arrOrder = { mode: 'shuffle', when: 'always' };
    const a = ord();
    const c2 = E.getCfg(); c2.prog.arrOrder = { mode: 'reverse', when: 'always' };
    const b = ord();
    const c3 = E.getCfg(); c3.prog.arrOrder = { mode: 'shuffle', when: 'always' }; c3.seed = 777;
    const d = ord();
    return { a, b, d };
  });
  ok('switching mode re-expands the plan (no stale slots)', memo.a !== memo.b, JSON.stringify(memo));
  ok('…and a new take re-shuffles, so the seed is in the key too',
    memo.d !== memo.a, JSON.stringify(memo));

  // ---- 5. REACHABLE ----------------------------------------------------------
  console.log('\n  5. reachable — in the ↻ Order group, beside its own rung');
  await setUp();
  await page.evaluate(() => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click();
  });
  await zz(700);
  await page.evaluate(() => {
    const h = document.querySelector('.ambient-proggrp .ambient-grp-head[data-grp="▤ Parts"]');
    if (h) h.click();
  });
  await zz(500);
  await page.evaluate(() => {
    const b = document.querySelector('[data-pov="grp:order"]');
    if (b) { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click(); }
  });
  await zz(700);
  const ui = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host');
    const pick = (sel) => { const e = host && host.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), par: !!e.offsetParent,
               txt: (e.textContent || '').trim().slice(0, 16) }; };
    return { host: !!host, chords: pick('.ambient-order-toggle'), parts: pick('.ambient-arrorder-toggle'),
             note: (host && host.querySelector('.arrorder-note') || {}).textContent };
  });
  ok('the ↻ Order group opens', ui.host === true, JSON.stringify(ui));
  ok('both rungs measure, and each says WHAT it reorders',
    ui.chords && ui.chords.w > 20 && ui.chords.par && /Chords/.test(ui.chords.txt) &&
    ui.parts && ui.parts.w > 20 && ui.parts.par && /Parts/.test(ui.parts.txt),
    JSON.stringify([ui.chords, ui.parts]));

  const drive = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host'), out = {};
    host.querySelector('.ambient-arrorder-toggle').click();
    out.on = JSON.parse(JSON.stringify(_masterEng.getCfg().prog.arrOrder || null));
    const h2 = document.querySelector('.ambient-grppop-host');
    const m = h2.querySelector('.ambient-arrorder-mode'), w = h2.querySelector('.ambient-arrorder-when');
    out.shown = !!m && m.getBoundingClientRect().width > 10 && !!m.offsetParent;
    m.value = 'reverse'; m.dispatchEvent(new Event('change', { bubbles: true }));
    w.value = '1000'; w.dispatchEvent(new Event('change', { bubbles: true }));
    out.set = JSON.parse(JSON.stringify(_masterEng.getCfg().prog.arrOrder || null));
    // ↻ Chords must be untouched by its neighbour
    out.chordsUntouched = !(_masterEng.getCfg().prog.order);
    document.querySelector('.ambient-grppop-host .ambient-arrorder-toggle').click();
    out.off = ('arrOrder' in _masterEng.getCfg().prog);
    return out;
  }).catch(e => ({ err: String(e) }));
  if (drive.err) { fail++; console.log('  ✗ drive block threw\n      ' + drive.err); }
  else {
    ok('the label turns it on with a usable default', drive.on && drive.on.mode === 'shuffle',
      JSON.stringify(drive.on));
    ok('…the two lists appear once it is on', drive.shown === true, String(drive.shown));
    ok('…and both write through', drive.set && drive.set.mode === 'reverse' && drive.set.when === '1000',
      JSON.stringify(drive.set));
    ok('↻ Chords is untouched by its neighbour', drive.chordsUntouched === true, String(drive.chordsUntouched));
    ok('off deletes the key again', drive.off === false, String(drive.off));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
