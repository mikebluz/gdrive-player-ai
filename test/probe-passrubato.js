// PROBE — ↔ Rubato at the PASS rung.
//
// docs/bloom-salt-organisation.md §9 recorded this rung as absent ON PURPOSE:
// "the only state in which a per-pass value can be read is the state in which
// Rubato does nothing" — per-pass values resolve only under a Passes grid, and
// the grid branch of the clock returned from the cached plan without re-slicing.
//
// §9c removed exactly that. `_ambGridCumAt` re-slices each part-visit per
// super-cycle and already receives the pass's FIRST SLOT, which carries its
// `col`. So the doc's paragraph went stale, not wrong-at-the-time, and the rung
// is a lookup: `_ambRubatoForSlot` reads pass → part → area.
//
// THE LOAD-BEARING INVARIANT is that a pass keeps its LENGTH. `gloops` is derived
// from `plan.cycle`, and the Scheduler lane, the bar counts and every phrase fit
// read pass edges — so per-pass rubato may move chords INSIDE a pass and must
// move neither the pass boundaries nor the super-cycle total.
//
//   node test/probe-passrubato.js      (needs `npm start`; BLOOPS_URL to retarget)
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

  // Four 1-bar chords, a 2-pass grid → an 8-bar super-cycle of 8 slots.
  const build = () => page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = true;
    c.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 1 },
                     { root: 5, intervals: [0, 3, 7], bars: 1 },
                     { root: 7, intervals: [0, 4, 7], bars: 1 },
                     { root: 2, intervals: [0, 3, 7], bars: 1 }];
    c.barsPerChord = 1;
    c.prog.grid = { cols: 2, seq: {} };
    delete c.prog.rubato; delete c.prog.passRubato;
    const c2 = E.getCfg();
    const plan = _ambGridPlan(c2);
    return { gridOn: !!_ambGridOn(c2), slots: plan ? plan.slots.length : 0,
             cycle: plan ? plan.cycle : 0, cols: (c2.prog.grid || {}).cols };
  });
  const b = await build();
  console.log('\n  setup: ' + JSON.stringify(b));
  ok('a 2-pass grid over 4 one-bar chords gives 8 slots across 8 bars',
    b.gridOn && b.slots === 8 && b.cycle === 8, JSON.stringify(b));

  // ---- 1. STORE --------------------------------------------------------------
  console.log('\n  1. store — its own, absent by default, meaningful zero kept');
  const store = await page.evaluate(() => {
    const E = _masterEng, out = {};
    out.fresh = ('passRubato' in E.getCfg().prog);
    // an explicit ZERO must survive: it is the only way to say "as written here"
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 0 });
    out.zeroKept = JSON.parse(JSON.stringify(E.getCfg().prog.passRubato || null));
    _ambPassRubatoSet(E.getCfg(), 0, 0, { amount: 999 });
    out.clamped = (E.getCfg().prog.passRubato['0'] || {}).amount;
    // clearing every pass deletes the store, so "inherits everywhere" has ONE shape
    _ambPassRubatoSet(E.getCfg(), 0, 0, null);
    _ambPassRubatoSet(E.getCfg(), 0, 1, null);
    out.emptied = ('passRubato' in E.getCfg().prog);
    // it is NOT a field on passSalt
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 50 });
    out.notOnSalt = !('passSalt' in E.getCfg().prog);
    out.readBack = _ambPassRubatoAt(E.getCfg(), 0, 1);
    out.otherPass = _ambPassRubatoAt(E.getCfg(), 0, 0);
    return out;
  });
  ok('absent on a fresh progression', store.fresh === false, JSON.stringify(store.fresh));
  ok('an explicit 0 is KEPT — "as written on this pass" is sayable',
    store.zeroKept && store.zeroKept['1'] && store.zeroKept['1'].amount === 0, JSON.stringify(store.zeroKept));
  ok('amounts clamp to 100', store.clamped === 100, String(store.clamped));
  ok('clearing every pass deletes the store', store.emptied === false, String(store.emptied));
  ok('it is its OWN store, not a field on passSalt', store.notOnSalt === true, String(store.notOnSalt));
  ok('a set pass reads back, an unset one reads null (inherit ≠ zero)',
    store.readBack === 50 && store.otherPass === null,
    JSON.stringify([store.readBack, store.otherPass]));

  // ---- 2. IT SURVIVES NORMALIZE ON A PART -----------------------------------
  console.log('\n  2. carried through _ambRepairParts (a fresh object per part)');
  const carry = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts = [{ name: 'A', len: 2, passRubato: { '1': { amount: 70 } }, grid: { cols: 2, seq: {} } },
                    { name: 'B', len: 2, grid: { cols: 2, seq: {} } }];
    delete c.prog.passRubato;
    const c2 = E.getCfg();
    const c3 = E.getCfg();                       // normalize TWICE — the drop shows on the 2nd
    return { parts: (c3.prog.parts || []).length,
             kept: JSON.parse(JSON.stringify((c3.prog.parts && c3.prog.parts[0] && c3.prog.parts[0].passRubato) || null)),
             viaAt: _ambPassRubatoAt(c3, 0, 1), other: _ambPassRubatoAt(c3, 1, 1) };
  });
  ok('a part keeps its passRubato across repeated normalizes',
    carry.kept && carry.kept['1'] && carry.kept['1'].amount === 70, JSON.stringify(carry));
  ok('…and it is per part — the other part inherits',
    carry.viaAt === 70 && carry.other === null, JSON.stringify([carry.viaAt, carry.other]));

  // ---- 3. THE LADDER --------------------------------------------------------
  console.log('\n  3. the ladder — pass → part → area, narrowest first');
  const ladder = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    delete c.prog.parts;
    c.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 1 }, { root: 5, intervals: [0, 3, 7], bars: 1 },
                     { root: 7, intervals: [0, 4, 7], bars: 1 }, { root: 2, intervals: [0, 3, 7], bars: 1 }];
    c.prog.grid = { cols: 2, seq: {} };
    c.prog.rubato = { amount: 30 };
    delete c.prog.passRubato;
    const c1 = E.getCfg();
    const areaOnly = [_ambRubatoForSlot(c1, { pi: 0, col: 0 }), _ambRubatoForSlot(c1, { pi: 0, col: 1 })];
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 80 });
    const c2 = E.getCfg();
    const withPass = [_ambRubatoForSlot(c2, { pi: 0, col: 0 }), _ambRubatoForSlot(c2, { pi: 0, col: 1 })];
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 0 });
    const c3 = E.getCfg();
    const withZero = [_ambRubatoForSlot(c3, { pi: 0, col: 0 }), _ambRubatoForSlot(c3, { pi: 0, col: 1 })];
    // engagement: a pass rung ALONE must switch the re-slice on
    const c4 = E.getCfg(); delete c4.prog.rubato;
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 60 });
    const c5 = E.getCfg();
    return { areaOnly, withPass, withZero,
             engagedByPassAlone: !!_ambProgSaltAnyLen(c5),
             areaGone: !c5.prog.rubato };
  });
  ok('with nothing per pass, every pass takes the area amount',
    JSON.stringify(ladder.areaOnly) === '[30,30]', JSON.stringify(ladder.areaOnly));
  ok('a pass with its own amount overrides only itself',
    JSON.stringify(ladder.withPass) === '[30,80]', JSON.stringify(ladder.withPass));
  ok('an explicit 0 on a pass means AS WRITTEN there, not "inherit"',
    JSON.stringify(ladder.withZero) === '[30,0]', JSON.stringify(ladder.withZero));
  ok('a pass rung ALONE engages the re-slice (area amount deleted)',
    ladder.areaGone === true && ladder.engagedByPassAlone === true,
    JSON.stringify([ladder.areaGone, ladder.engagedByPassAlone]));

  // ---- 4. IT ACTS, AND KEEPS THE ARRANGEMENT STILL --------------------------
  console.log('\n  4. the edges move INSIDE a pass and nowhere else');
  const edges = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.rubato = { amount: 0 };
    delete c.prog.rubato;
    _ambPassRubatoSet(E.getCfg(), 0, 0, { amount: 0 });    // pass 1: as written
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 85 });   // pass 2: heavily moved
    const c2 = E.getCfg();
    const plan = _ambGridPlan(c2);
    const written = Array.from(plan.cum).map(v => +v.toFixed(6));
    const got = Array.from(_ambGridCumAt(c2, plan, 0)).map(v => +v.toFixed(6));
    // …and the memo must not serve these edges after an edit
    _ambPassRubatoSet(E.getCfg(), 0, 1, { amount: 20 });
    const c3 = E.getCfg();
    const got2 = Array.from(_ambGridCumAt(c3, _ambGridPlan(c3), 0)).map(v => +v.toFixed(6));
    return { written, got, got2, cycle: plan.cycle,
             firstSlotOfPass2: plan.slots.findIndex((s, i) => i > 0 && s.pFirst) };
  });
  console.log('     written: ' + JSON.stringify(edges.written));
  console.log('     got    : ' + JSON.stringify(edges.got));
  const P2 = edges.firstSlotOfPass2;
  ok('pass 2 starts at slot 4 of 8', P2 === 4, String(P2));
  ok('pass 1 (as written) is untouched, edge for edge',
    JSON.stringify(edges.written.slice(0, P2 + 1)) === JSON.stringify(edges.got.slice(0, P2 + 1)),
    JSON.stringify(edges.got.slice(0, P2 + 1)));
  ok('pass 2 (its own rubato) really does move its chords',
    JSON.stringify(edges.written.slice(P2 + 1, 8)) !== JSON.stringify(edges.got.slice(P2 + 1, 8)),
    JSON.stringify(edges.got.slice(P2 + 1, 8)));
  ok('THE PASS BOUNDARY DOES NOT MOVE — pass 2 still begins at the same bar',
    edges.got[P2] === edges.written[P2], edges.got[P2] + ' vs ' + edges.written[P2]);
  ok('…nor does the super-cycle total, which gloops is derived from',
    edges.got[8] === edges.written[8] && edges.got[8] === edges.cycle,
    edges.got[8] + ' vs ' + edges.written[8]);
  ok('editing one pass invalidates the edge memo (no stale bar edges)',
    JSON.stringify(edges.got2) !== JSON.stringify(edges.got), JSON.stringify(edges.got2));
  ok('…and the re-sliced pass still ends where it began ending',
    edges.got2[8] === edges.cycle, String(edges.got2[8]));

  // ---- 5. REACHABLE IN THE PASS MODAL ---------------------------------------
  console.log('\n  5. reachable — the pass modal, measured');
  await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    delete c.prog.passRubato; delete c.prog.rubato;
    E.getCfg();
    _ambPassSaltModal(E, 0, 1);
  });
  await zz(600);
  const modal = await page.evaluate(() => {
    const ov = document.querySelector('.ambient-psalt-ov');
    if (!ov) return { there: false };
    const pick = (sel) => {
      const el = ov.querySelector(sel); if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), par: !!el.offsetParent };
    };
    return { there: true, title: (ov.querySelector('.sm-title') || {}).textContent,
             block: pick('.psalt-rub'), head: pick('.psalt-rubhead'),
             inherit: pick('[data-prub="inherit"]'), own: pick('[data-prub="own"]'),
             amt: pick('[data-prubf="amount"]') };
  });
  ok('the pass modal opens', modal.there === true, JSON.stringify(modal));
  ok('…and is titled for BOTH axes it now holds', /Salt/.test(modal.title || '') && /Rubato/.test(modal.title || ''),
    JSON.stringify(modal.title));
  ok('the ↔ Rubato block MEASURES inside it',
    modal.block && modal.block.w > 50 && modal.block.par, JSON.stringify(modal.block));
  ok('…with its own Inherit / Its own pair, both measuring',
    modal.inherit && modal.inherit.w > 20 && modal.inherit.par &&
    modal.own && modal.own.w > 20 && modal.own.par, JSON.stringify([modal.inherit, modal.own]));
  ok('the amount field is HIDDEN while inheriting', modal.amt === null, JSON.stringify(modal.amt));

  const driven = await page.evaluate(() => {
    const E = _masterEng, ov = document.querySelector('.ambient-psalt-ov');
    const out = {};
    ov.querySelector('[data-prub="own"]').click();
    out.afterOwn = _ambPassRubatoAt(E.getCfg(), 0, 1);
    const ov2 = document.querySelector('.ambient-psalt-ov');
    const amt = ov2.querySelector('[data-prubf="amount"]');
    const r = amt ? amt.getBoundingClientRect() : null;
    out.amtShown = !!amt && r.width > 10 && !!amt.offsetParent;
    amt.value = '65'; amt.dispatchEvent(new Event('change', { bubbles: true }));
    out.afterSet = _ambPassRubatoAt(E.getCfg(), 0, 1);
    // Salt's own Inherit must not be disturbed by the neighbouring pair
    const ov3 = document.querySelector('.ambient-psalt-ov');
    ov3.querySelector('[data-psalt="own"]').click();
    out.saltOwn = !!(_ambPassSaltStore(E.getCfg(), 0, false) || {})['1'];
    out.rubStillThere = _ambPassRubatoAt(E.getCfg(), 0, 1);
    const ov4 = document.querySelector('.ambient-psalt-ov');
    ov4.querySelector('[data-prub="inherit"]').click();
    out.afterInherit = _ambPassRubatoAt(E.getCfg(), 0, 1);
    out.saltSurvived = !!(_ambPassSaltStore(E.getCfg(), 0, false) || {})['1'];
    return out;
  }).catch(e => ({ err: String(e) }));
  if (driven.err) { fail++; console.log('  ✗ drive block threw\n      ' + driven.err); }
  else {
    ok('"Its own" seeds from what it was inheriting — engaging it is inaudible',
      driven.afterOwn === 0, String(driven.afterOwn));
    ok('…the amount field then appears', driven.amtShown === true, String(driven.amtShown));
    ok('…and writes through', driven.afterSet === 65, String(driven.afterSet));
    ok('Salt’s own pair still works beside it', driven.saltOwn === true, String(driven.saltOwn));
    ok('…without clearing the rubato rung', driven.rubStillThere === 65, String(driven.rubStillThere));
    ok('Rubato’s Inherit clears ONLY rubato',
      driven.afterInherit === null && driven.saltSurvived === true,
      JSON.stringify([driven.afterInherit, driven.saltSurvived]));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
