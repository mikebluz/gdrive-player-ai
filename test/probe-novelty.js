// PROBE — ✺ Novelty: one dial over the arrangement's ten dice.
//
// user, 2026-09-26, on the original ask ("lots of novelty… even easier"): the dice
// were built but finding them was six doors across two panes.
//
// A ONE-SHOT, NOT A DIAL, and that is the load-bearing decision. A macro that writes
// the same keys the individual controls write has an easy forward direction and a
// LOSSY reverse one — you cannot read one number back out of ten, and the moment
// someone edits 🌒 Arc by hand a live dial lies about what is set. So this is
// ⚄ Generate's shape (controls · PREVIEW · Apply) and it stores NOTHING: the dice
// remain the only state, exactly as before it existed.
//
// FOUR AXES, not three: Time is its own, because schema v10 split ↔ Rubato out of
// 🧂 Salt on purpose (one changes which chord, the other when it falls).
//
//   node test/probe-novelty.js      (needs `npm start`; BLOOPS_URL to retarget)
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
    ['vary', 'tension', 'reroll', 'salt', 'order', 'rubato', 'arrOrder', 'arc', 'grid', 'arrGrid', 'chain']
      .forEach(k => delete c.prog[k]);
    c.prog.parts.forEach(pt => delete pt.chance);
    const c2 = E.getCfg();
    return { parts: (c2.prog.parts || []).length };
  });
  await setUp();

  // ---- 1. THE PLAN -----------------------------------------------------------
  console.log('\n  1. the plan — what Apply would do, before it does it');
  const plan = await page.evaluate(() => {
    const c = _masterEng.getCfg();
    const at = (amount, bal) => _ambNovPlan(c, { amount, bal: bal || { h: 50, t: 50, f: 50, x: 50 } })
      .map(r => r.label + '=' + r.to).join(' ');
    return { zero: at(0), mid: at(55), full: at(100),
             labels: _ambNovPlan(c, { amount: 55, bal: { h: 50, t: 50, f: 50, x: 50 } }).map(r => r.label) };
  });
  console.log('     at 55: ' + plan.mid);
  ok('amount 0 leaves every axis at nothing — "play as written" is sayable',
    /Vary=0/.test(plan.zero) && /Arc=0/.test(plan.zero) && /Chords=written/.test(plan.zero) &&
    /Parts=written/.test(plan.zero) && /Chance=100/.test(plan.zero), plan.zero);
  ok('a mid amount moves the continuous axes but not yet the form',
    /Vary=50/.test(plan.mid) && /Arc=44/.test(plan.mid) && /Parts=random/.test(plan.mid), plan.mid);
  ok('full turns everything on, and 🎲 Chance keeps a FLOOR so no part mostly vanishes',
    /Chords=random/.test(plan.full) && /Chance=60/.test(plan.full), plan.full);
  ok('it covers all four axes — Harmony, Time, Form and Texture',
    plan.labels.some(l => /Vary/.test(l)) && plan.labels.some(l => /Rubato/.test(l)) &&
    plan.labels.some(l => /Parts/.test(l)) && plan.labels.some(l => /Arc/.test(l)),
    JSON.stringify(plan.labels));

  // ---- 2. BALANCE LEANS, IT DOES NOT ADD -------------------------------------
  console.log('\n  2. balance leans the change, it never adds any');
  const bal = await page.evaluate(() => {
    const c = _masterEng.getCfg();
    const val = (lbl, amount, b) => {
      const r = _ambNovPlan(c, { amount, bal: b }).find(x => x.label.indexOf(lbl) >= 0);
      return r ? r.to : null;
    };
    const even = { h: 50, t: 50, f: 50, x: 50 };
    return {
      evenVary: val('Vary', 60, even), evenArc: val('Arc', 60, even),
      harmUp: val('Vary', 60, { h: 100, t: 50, f: 50, x: 50 }),
      harmDown: val('Vary', 60, { h: 0, t: 50, f: 50, x: 50 }),
      arcUnmoved: val('Arc', 60, { h: 100, t: 50, f: 50, x: 50 }),
      zeroStaysZero: val('Vary', 0, { h: 100, t: 100, f: 100, x: 100 })
    };
  });
  ok('an even balance gives every axis the amount itself',
    bal.evenVary === 54 && bal.evenArc === 48, JSON.stringify(bal));
  ok('leaning one axis up raises it…', bal.harmUp > bal.evenVary, JSON.stringify([bal.harmUp, bal.evenVary]));
  ok('…leaning it down lowers it…', bal.harmDown === 0, String(bal.harmDown));
  ok('…and leaves the others exactly where they were',
    bal.arcUnmoved === bal.evenArc, JSON.stringify([bal.arcUnmoved, bal.evenArc]));
  ok('at amount 0 no balance can conjure novelty from nothing',
    bal.zeroStaysZero === 0, String(bal.zeroStaysZero));

  // ---- 3. APPLY WRITES EXACTLY WHAT THE PREVIEW SAID -------------------------
  console.log('\n  3. apply writes the plan, and only the plan');
  const applied = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    const st = { amount: 70, bal: { h: 50, t: 50, f: 50, x: 50 } };
    _ambNovUiSet(st);
    const want = {};
    _ambNovPlan(c, st).forEach(r => { if (r.write) want[r.label] = String(r.to); });
    const n = _ambNovApply(E, c);
    const c2 = E.getCfg();
    const got = {};
    _ambNovPlan(c2, st).forEach(r => { if (r.write) got[r.label] = String(r.from); });
    return { n, match: JSON.stringify(want) === JSON.stringify(got), want, got,
             storedKeys: Object.keys(c2.prog).filter(k => /nov/i.test(k)),
             vary: c2.prog.vary, arc: (c2.prog.arc || {}).amount,
             arrOrder: (c2.prog.arrOrder || {}).mode };
  });
  ok('every planned row was written', applied.n >= 9, String(applied.n));
  ok('…and reading the config back gives exactly what the preview promised',
    applied.match === true, JSON.stringify([applied.want, applied.got]));
  ok('the dice really moved', applied.vary > 0 && applied.arc > 0 && applied.arrOrder === 'shuffle',
    JSON.stringify([applied.vary, applied.arc, applied.arrOrder]));
  ok('NOTHING new is stored — no novelty key reaches the save file',
    applied.storedKeys.length === 0, JSON.stringify(applied.storedKeys));

  // ---- 3b. WRITABLE IS NOT AUDIBLE -------------------------------------------
  // user, 2026-09-26: "does this new section do anything if there are no parts?"
  // Measured then: on an area with NO CHANGES the plan wrote EIGHT rows and exactly
  // ONE of them (🌒 Arc) could be heard — every harmony and time axis resolves
  // through the chord clock. The preview counted all eight as changes, which is the
  // lying readout this control was shaped to avoid.
  console.log('\n  3b. an area with no changes — only 🌒 Arc can act');
  const empty = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = false; c.prog.chords = []; delete c.prog.parts;
    ['vary', 'tension', 'reroll', 'salt', 'order', 'rubato', 'arrOrder', 'arc'].forEach(k => delete c.prog[k]);
    const cfg = E.getCfg();
    const st = { amount: 70, bal: { h: 50, t: 50, f: 50, x: 50 } };
    _ambNovUiSet(st);
    const plan = _ambNovPlan(cfg, st);
    const n = _ambNovApply(E, E.getCfg());
    const c2 = E.getCfg();
    return {
      live: plan.filter(r => r.live !== false).map(r => r.label),
      dead: plan.filter(r => r.live === false).map(r => r.label),
      whys: plan.filter(r => r.live === false).map(r => r.why),
      applied: n,
      arcSet: (c2.prog.arc || {}).amount || 0,
      harmonyKeys: ['vary', 'tension', 'reroll', 'salt', 'order', 'rubato'].filter(k => k in c2.prog),
      says: _ambNovWords(70, false)
    };
  });
  console.log('     live: ' + JSON.stringify(empty.live) + '  dead: ' + empty.dead.length);
  ok('with no changes ONLY 🌒 Arc is live — every other axis needs the chord clock',
    JSON.stringify(empty.live) === '["🌒 Arc"]', JSON.stringify(empty.live));
  ok('…the dead rows say WHY rather than showing a number that cannot act',
    empty.whys.every(w => /needs changes|two sets/.test(w || '')), JSON.stringify(empty.whys));
  ok('…Apply writes only the one that can be heard',
    empty.applied === 1 && empty.arcSet > 0, JSON.stringify([empty.applied, empty.arcSet]));
  ok('…and stores NO harmony or time key it could not act on',
    empty.harmonyKeys.length === 0, JSON.stringify(empty.harmonyKeys));
  ok('…while the sentence describes the density, not a harmony that is not there',
    /Layers/.test(empty.says) && /Add changes/.test(empty.says), JSON.stringify(empty.says));

  // ---- 4. UNDO ---------------------------------------------------------------
  console.log('\n  4. ten keys at once must be takeable back');
  await setUp();
  const undo = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    ['vary', 'tension', 'reroll', 'salt', 'order', 'rubato', 'arrOrder', 'arc'].forEach(k => delete c.prog[k]);
    c.prog.vary = 17;                       // a hand-set value that must come back
    c.prog.parts.forEach(pt => delete pt.chance);
    const before = JSON.stringify({ v: c.prog.vary, a: c.prog.arc, o: c.prog.arrOrder });
    _ambNovUiSet({ amount: 80, bal: { h: 50, t: 50, f: 50, x: 50 } });
    _ambNovApply(E, E.getCfg());
    const mid = JSON.stringify({ v: E.getCfg().prog.vary, a: E.getCfg().prog.arc, o: E.getCfg().prog.arrOrder });
    _ambNovRevert(E, E.getCfg());
    const c3 = E.getCfg();
    const after = JSON.stringify({ v: c3.prog.vary, a: c3.prog.arc, o: c3.prog.arrOrder });
    return { before, mid, after, chanceGone: (c3.prog.parts || []).every(pt => !Number.isFinite(pt.chance)) };
  });
  ok('apply changed things', undo.before !== undo.mid, JSON.stringify([undo.before, undo.mid]));
  ok('…and undo puts the hand-set value back exactly',
    undo.after === undo.before, JSON.stringify([undo.before, undo.after]));
  ok('…including the per-part 🎲 Chance it wrote', undo.chanceGone === true, String(undo.chanceGone));

  // ---- 5. ONE PART — SAY SO, DO NOT WRITE ------------------------------------
  console.log('\n  5. with one part there is no form to move');
  const one = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts = [{ name: 'Only', len: 6 }];
    const c2 = E.getCfg();
    const rows = _ambNovPlan(c2, { amount: 90, bal: { h: 50, t: 50, f: 50, x: 50 } });
    const partsRow = rows.find(r => r.label.indexOf('Parts') >= 0);
    return { inert: !!(partsRow && !partsRow.write), why: partsRow ? partsRow.why : null,
             noChanceRow: !rows.some(r => r.label.indexOf('Chance') >= 0),
             othersStillWrite: rows.filter(r => r.write).length > 5 };
  });
  ok('the ↻ Parts row goes inert rather than offering a write that cannot act',
    one.inert === true, JSON.stringify(one));
  ok('…and it names the way forward instead of showing a dead number',
    /second set of changes/i.test(one.why || ''), JSON.stringify(one.why));
  ok('…while every other axis still applies', one.othersStillWrite === true, String(one.othersStillWrite));

  // ---- 6. REACHABLE ----------------------------------------------------------
  console.log('\n  6. reachable — measured, and driven with a real press');
  await setUp();
  await page.evaluate(() => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click();
  });
  await zz(700);
  await page.evaluate(() => {
    const h = document.querySelector('.ambient-proggrp .ambient-grp-head[data-grp="▤ Parts"]');
    if (h) h.click();
  });
  await zz(600);
  const door = await page.evaluate(() => {
    const b = document.querySelector('[data-pov="grp:novelty"]');
    if (!b) return { there: false };
    const r = b.getBoundingClientRect();
    const sibs = ['grp:salt', 'grp:arc', 'grp:order'].map(k => {
      const e = document.querySelector('[data-pov="' + k + '"]');
      return e ? Math.round(e.getBoundingClientRect().width) : 0;
    });
    return { there: true, w: Math.round(r.width), h: Math.round(r.height), par: !!b.offsetParent,
             first: !!(b.nextElementSibling && b.nextElementSibling.getAttribute('data-pov') === 'grp:salt'), sibs };
  });
  ok('the ✺ Novelty door exists on the ▤ Parts bar', door.there === true, JSON.stringify(door));
  ok('…and MEASURES, beside its siblings which also do',
    door.w > 10 && door.h > 5 && door.par === true && door.sibs.every(w => w > 10), JSON.stringify(door));
  ok('…leading the bar, before the single-axis doors', door.first === true, String(door.first));

  const parked = await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp[data-grp="✺ Novelty"]');
    if (!g) return { there: false };
    return { there: true, disp: getComputedStyle(g).display, par: !!g.offsetParent };
  });
  ok('the group is PARKED HIDDEN until its door is pressed — no stray accordion',
    parked.there && parked.disp === 'none' && parked.par === false, JSON.stringify(parked));

  await page.evaluate(() => {
    const b = document.querySelector('[data-pov="grp:novelty"]');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click();
  });
  await zz(700);
  const ui = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host');
    const pick = (sel) => { const e = host && host.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), par: !!e.offsetParent }; };
    return { host: !!host, amt: pick('.ambient-nov-amt'), apply: pick('.ambient-nov-apply'),
             says: (host && host.querySelector('.ambient-nov-says') || {}).textContent,
             pv: (host ? host.querySelectorAll('.ambient-nov-pvrow').length : 0),
             balHidden: !!(host && host.querySelector('.ambient-nov-bal') || {}).hidden,
             title: (document.querySelector('.ambient-grppop-modal .sm-title') || {}).textContent };
  });
  ok('the popover opens, titled ✺ Novelty', ui.host === true && /Novelty/.test(ui.title || ''),
    JSON.stringify(ui.title));
  ok('the dial and Apply both measure', ui.amt && ui.amt.w > 50 && ui.amt.par &&
    ui.apply && ui.apply.w > 40 && ui.apply.par, JSON.stringify([ui.amt, ui.apply]));
  ok('…the preview lists every row it would write', ui.pv >= 9, String(ui.pv));
  ok('…the sentence describes the RESULT, not the number', /breathes|improvises|Barely|different take|Nothing moves/.test(ui.says || ''),
    JSON.stringify(ui.says));
  ok('…and it reflects THIS area, not the one the panel was built against',
    !/Add changes/.test(ui.says || ''), JSON.stringify(ui.says));
  ok('…and Shape it starts closed — one dial is the whole control by default',
    ui.balHidden === true, String(ui.balHidden));

  const drive = await page.evaluate(() => {
    const host = document.querySelector('.ambient-grppop-host'), out = {};
    const amt = host.querySelector('.ambient-nov-amt');
    amt.value = '80'; amt.dispatchEvent(new Event('input', { bubbles: true }));
    out.saysAt80 = host.querySelector('.ambient-nov-says').textContent;
    host.querySelector('.ambient-nov-shape').click();
    const h2 = document.querySelector('.ambient-grppop-host');
    out.balShown = !h2.querySelector('.ambient-nov-bal').hidden;
    out.balRows = h2.querySelectorAll('.ambient-nov-balrow').length;
    h2.querySelector('.ambient-nov-apply').click();
    const c = _masterEng.getCfg();
    out.wrote = { vary: c.prog.vary, arc: (c.prog.arc || {}).amount, parts: (c.prog.arrOrder || {}).mode };
    const h3 = document.querySelector('.ambient-grppop-host');
    out.undoShown = !h3.querySelector('.ambient-nov-undo').hidden;
    h3.querySelector('.ambient-nov-undo').click();
    const c2 = _masterEng.getCfg();
    out.reverted = !c2.prog.vary && !c2.prog.arc && !c2.prog.arrOrder;
    return out;
  }).catch(e => ({ err: String(e) }));
  if (drive.err) { fail++; console.log('  ✗ drive block threw\n      ' + drive.err); }
  else {
    ok('moving the dial updates the sentence', /improvises|different take/.test(drive.saysAt80 || ''),
      JSON.stringify(drive.saysAt80));
    ok('▸ Shape it reveals exactly four balance rows',
      drive.balShown === true && drive.balRows === 4, JSON.stringify([drive.balShown, drive.balRows]));
    ok('Apply writes through to the real config',
      drive.wrote.vary > 0 && drive.wrote.arc > 0 && drive.wrote.parts === 'shuffle',
      JSON.stringify(drive.wrote));
    ok('…↶ Undo appears once there is something to undo', drive.undoShown === true, String(drive.undoShown));
    ok('…and takes it all back', drive.reverted === true, String(drive.reverted));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
