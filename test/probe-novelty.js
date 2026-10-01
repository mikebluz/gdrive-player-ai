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

  // ---- 1b. THE REPEATS RANGE -------------------------------------------------
  // 🎲 Repeats … to shipped as §4c on 2026-09-26 and the macro could not see it:
  // the Form axis wrote `arrOrder` and `chance` only, so a control that existed was
  // invisible to the dial. It is the CEILING that moves — `plays` is the user's own
  // floor and must come out untouched — and the ceiling is per part, because one
  // shared number would flatten a 1× part and a 4× part into the same thing.
  console.log('\n  1b. 🎲 Repeats … to — the ceiling, per part, floors untouched');
  const rng = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    // three DIFFERENT floors, so a shared ceiling could not pass
    c.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2, plays: 3 }, { name: 'C', len: 2, plays: 4 }];
    c.prog.parts.forEach(pt => delete pt.playsTo);
    const c2 = E.getCfg();
    const row = (amount) => _ambNovPlan(c2, { amount, bal: { h: 50, t: 50, f: 50, x: 50 } })
      .find(r => r.label.indexOf('Repeats') >= 0);
    // READ THE OBJECT APPLY WROTE, not a fresh `getCfg`. The normalizer also drops a
    // ceiling that is not above its floor, so re-normalizing hides whether the WRITE
    // pruned — and the write has to, for the same reason the ± edit path repeats the
    // rule: what is on screen before the next getCfg must already be right.
    const apply = (amount) => { _ambNovUiSet({ amount, bal: { h: 50, t: 50, f: 50, x: 50 } });
      const cfgA = E.getCfg();
      _ambNovApply(E, cfgA);
      return (cfgA.prog.parts || []).map(pt => (pt.plays | 0 || 1) + '>' + (Number.isFinite(pt.playsTo) ? (pt.playsTo | 0) : '-')); };
    const out = { at30: row(30).to, at55: row(55).to, at100: row(100).to,
                  applied55: apply(55), applied100: apply(100), backTo30: apply(30) };
    // the FLOORS must be exactly what they were, at every amount
    out.floors = E.getCfg().prog.parts.map(pt => (pt.plays | 0) || 1);
    // …and the ceiling is clamped, not run past the top of the store
    c.prog.parts[2].plays = 64; E.getCfg();
    apply(100);
    out.clamped = (E.getCfg().prog.parts[2] || {}).playsTo;
    return out;
  });
  ok('below the threshold it is FIXED — no ceiling, so an old project rolls nothing',
    rng.at30 === 'fixed' && rng.applied55 !== undefined, JSON.stringify(rng));
  ok('a mid amount widens every part by one pass, over its OWN floor',
    rng.at55 === '+1 pass' && JSON.stringify(rng.applied55) === '["1>2","3>4","4>5"]', JSON.stringify(rng.applied55));
  ok('…and full widens it further', rng.at100 === '+3 passes' &&
    JSON.stringify(rng.applied100) === '["1>4","3>6","4>7"]', JSON.stringify(rng.applied100));
  ok('turning the dial back DOWN takes the range away rather than leaving a stale ceiling',
    JSON.stringify(rng.backTo30) === '["1>-","3>-","4>-"]', JSON.stringify(rng.backTo30));
  ok('the floor the user set is never written', JSON.stringify(rng.floors) === '[1,3,4]',
    JSON.stringify(rng.floors));
  ok('the ceiling is clamped to the top of the store', rng.clamped === undefined || rng.clamped === 64,
    String(rng.clamped));

  // ---- 1c. ARC AT THE PART RUNG ----------------------------------------------
  // \u00a74d shipped `parts[i].arc = { amount }` on 2026-09-25 and the macro drove only
  // the AREA rung, so half of \u00a75b's Orchestration idea had no dial. This row is the
  // only one that writes a DIFFERENT value per part, which is the whole point: one
  // value everywhere is what the area rung already is.
  console.log('\n  1c. \ud83c\udf12 Arc \u00b7 per part — parts breathe by different amounts');
  const parc = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }, { name: 'C', len: 2 }];
    c.prog.parts.forEach(pt => { delete pt.arc; delete pt.playsTo; });
    delete c.prog.arc;
    const c2 = E.getCfg();
    const row = (amount) => _ambNovPlan(c2, { amount, bal: { h: 50, t: 50, f: 50, x: 50 } })
      .find(r => r.label.indexOf('per part') >= 0);
    // READ THE OBJECT APPLY WROTE — a fresh getCfg re-normalizes and would hide
    // whether the write itself cleared the overrides.
    const apply = (amount) => { _ambNovUiSet({ amount, bal: { h: 50, t: 50, f: 50, x: 50 } });
      const cfgA = E.getCfg(); _ambNovApply(E, cfgA);
      return { per: (cfgA.prog.parts || []).map(pt => (pt.arc && typeof pt.arc === 'object') ? (pt.arc.amount | 0) : '-'),
               area: (cfgA.prog.arc && (cfgA.prog.arc.amount | 0)) || 0 }; };
    return { at40: row(40).to, at55: row(55).to, at100: row(100).to,
             a55: apply(55), a100: apply(100), back: apply(40) };
  });
  ok('below the threshold every part inherits — nothing per part is stored',
    parc.at40 === 'even' && JSON.stringify(parc.back.per) === '["-","-","-"]', JSON.stringify(parc));
  ok('above it the parts land either side of the area depth, not all on it',
    parc.at55 === '\u00b119' && JSON.stringify(parc.a55.per) === '[25,63,25]' && parc.a55.area === 44,
    JSON.stringify(parc.a55));
  ok('…the spread widens with the dial, and is clamped at the top of the store',
    parc.at100 === '\u00b135' && JSON.stringify(parc.a100.per) === '[45,100,45]', JSON.stringify(parc.a100));
  ok('…and the AREA rung keeps saying exactly what its own row promised',
    parc.a100.area === 80, String(parc.a100.area));
  ok('turning the dial back down hands the parts back to the area, not to a stale depth',
    JSON.stringify(parc.back.per) === '["-","-","-"]' && parc.back.area === 32, JSON.stringify(parc.back));

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
  // ⇅ Mix (9ce36eb) counts BARS like 🌒 Arc, so it is live with no changes too
  ok('with no changes ONLY 🌒 Arc and ⇅ Mix are live — every other axis needs the chord clock',
    JSON.stringify(empty.live) === '["🌒 Arc","⇅ Mix"]', JSON.stringify(empty.live));
  ok('…the dead rows say WHY rather than showing a number that cannot act',
    empty.whys.every(w => /needs changes|needs a layer|two sets|Tone set/.test(w || '')), JSON.stringify(empty.whys));
  ok('…Apply writes only the ones that can be heard',
    empty.applied === 2 && empty.arcSet > 0, JSON.stringify([empty.applied, empty.arcSet]));
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
    c.prog.parts.forEach(pt => { delete pt.chance; delete pt.playsTo; delete pt.arc; });
    const before = JSON.stringify({ v: c.prog.vary, a: c.prog.arc, o: c.prog.arrOrder });
    _ambNovUiSet({ amount: 80, bal: { h: 50, t: 50, f: 50, x: 50 } });
    _ambNovApply(E, E.getCfg());
    const mid = JSON.stringify({ v: E.getCfg().prog.vary, a: E.getCfg().prog.arc, o: E.getCfg().prog.arrOrder });
    _ambNovRevert(E, E.getCfg());
    const c3 = E.getCfg();
    const after = JSON.stringify({ v: c3.prog.vary, a: c3.prog.arc, o: c3.prog.arrOrder });
    return { before, mid, after,
             chanceGone: (c3.prog.parts || []).every(pt => !Number.isFinite(pt.chance)),
             rangeGone: (c3.prog.parts || []).every(pt => !Number.isFinite(pt.playsTo)),
             partArcGone: (c3.prog.parts || []).every(pt => !pt.arc) };
  });
  ok('apply changed things', undo.before !== undo.mid, JSON.stringify([undo.before, undo.mid]));
  ok('…and undo puts the hand-set value back exactly',
    undo.after === undo.before, JSON.stringify([undo.before, undo.after]));
  ok('…including the per-part 🎲 Chance it wrote', undo.chanceGone === true, String(undo.chanceGone));
  ok('…and the per-part repeats CEILING it wrote', undo.rangeGone === true, String(undo.rangeGone));
  ok('…and the per-part \ud83c\udf12 Arc depth, which is an OBJECT and a different snapshot key',
    undo.partArcGone === true, String(undo.partArcGone));

  // ---- 5. ONE PART — SAY SO, DO NOT WRITE ------------------------------------
  console.log('\n  5. with one part there is no form to move');
  const one = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.parts = [{ name: 'Only', len: 6 }];
    const c2 = E.getCfg();
    const rows = _ambNovPlan(c2, { amount: 90, bal: { h: 50, t: 50, f: 50, x: 50 } });
    const partsRow = rows.find(r => r.label.indexOf('Parts') >= 0);
    const rngRow = rows.find(r => r.label.indexOf('Repeats') >= 0);
    return { inert: !!(partsRow && !partsRow.write), why: partsRow ? partsRow.why : null,
             noChanceRow: !rows.some(r => r.label.indexOf('Chance') >= 0),
             rangeLive: !!(rngRow && rngRow.write && rngRow.live !== false),
             noRangeRow: !rngRow,
             noPartArcRow: !rows.some(r => r.label.indexOf('per part') >= 0),
             othersStillWrite: rows.filter(r => r.write).length > 5 };
  });
  ok('the ↻ Parts row goes inert rather than offering a write that cannot act',
    one.inert === true, JSON.stringify(one));
  ok('…and it names the way forward instead of showing a dead number',
    /second set of changes/i.test(one.why || ''), JSON.stringify(one.why));
  ok('…while every other axis still applies', one.othersStillWrite === true, String(one.othersStillWrite));
  // `prog.parts` is PRUNED at one part, so there is no per-part store for a ceiling —
  // the range is offered with the rest of the form or not at all, exactly like
  // 🎲 Chance. Asserting its ABSENCE is what stops it drifting back to a dead row.
  ok('…and neither the repeats range nor the per-part Arc is offered — no per-part store',
    one.rangeLive === false && one.noRangeRow === true && one.noPartArcRow === true, JSON.stringify(one));

  // ---- 6. REACHABLE ----------------------------------------------------------
  console.log('\n  6. reachable — measured, and driven with a real press');
  await setUp();
  await page.evaluate(() => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click();
  });
  await zz(700);
  await page.evaluate(() => {
    // ✺ Variation is its own group since ababd3d; ▤ Parts no longer holds the door
    const h = document.querySelector('.ambient-proggrp[data-grp="✺ Variation"] > .ambient-grp-head');
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
    // FIVE SINCE 2026-09-26 — ◇ Instrument joined, because "which voice plays it" is a
    // fifth question and not a corner of Texture. The count is asserted exactly, so a
    // sixth axis cannot arrive without someone reading the reasoning in `_AMB_NOV_AXES`.
    ok('▸ Shape it reveals exactly five balance rows, one per axis',
      drive.balShown === true && drive.balRows === 5, JSON.stringify([drive.balShown, drive.balRows]));
    ok('Apply writes through to the real config',
      drive.wrote.vary > 0 && drive.wrote.arc > 0 && drive.wrote.parts === 'shuffle',
      JSON.stringify(drive.wrote));
    ok('…↶ Undo appears once there is something to undo', drive.undoShown === true, String(drive.undoShown));
    ok('…and takes it all back', drive.reverted === true, String(drive.reverted));
  }

  // ---- 8. ◇ TONE SET — THE AXIS THAT WRITES A LAYER ------------------------
  // (2026-09-26.) Every other row writes `prog`. This one moves the two dials on a
  // layer's own Tone set, which is why the undo snapshot had to grow a layer rung —
  // keyed BY LAYER, because layers are added and deleted freely and an index-keyed
  // snapshot restores the wrong layer's voices the moment one goes.
  console.log('\n  8. ◇ Tone set — the row that writes layers, not the arrangement');
  await setUp();
  // A v2 LAYER, through the real door — this file's fixture is arrangement-only, so
  // there is none until now, and ◇ Doubling is exactly the thing only a v2 layer has.
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
  await zz(700);
  const tset = await page.evaluate(async () => {
    const E = _masterEng;
    const c = E.getCfg();
    const L2 = (c.layers || [])[0];
    // a v2 layer (stacks) and a v1 layer (swaps only), with DIFFERENT priors so a
    // restore cannot pass by writing one value everywhere
    L2.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 4 }, { tone: 'square', bars: 4 }], pal: 11 };
    c.bed.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 4 }, { tone: 'triangle', bars: 2 }], pal: 22 };
    E.getCfg();
    const rows = (amount) => _ambNovPlan(E.getCfg(), { amount, bal: { h: 50, t: 50, f: 50, x: 50, i: 50 } });
    const row = (amount) => rows(amount).find(r => r.label.indexOf('Tone set') >= 0);
    const out = { label: (row(55) || {}).label, at55: (row(55) || {}).to, at100: (row(100) || {}).to,
                  live: (row(55) || {}).live };
    // the AXIS is its own — leaning Instrument down must not move it via Texture
    const leaned = _ambNovPlan(E.getCfg(), { amount: 80, bal: { h: 50, t: 50, f: 50, x: 50, i: 0 } })
      .find(r => r.label.indexOf('Tone set') >= 0);
    out.leanedOff = leaned ? leaned.to : null;
    // APPLY at full, then read both layers back
    _ambNovUiSet({ amount: 100, bal: { h: 50, t: 50, f: 50, x: 50, i: 50 } });
    _ambNovApply(E, E.getCfg());
    const rd = () => { const c3 = E.getCfg();
      const a = (c3.layers || [])[0].toneSeq || {}, b = c3.bed.toneSeq || {};
      return { v2: { pal: a.pal, dub: a.dub, maxV: a.maxV, steps: (a.steps || []).length },
               v1: { pal: b.pal, dub: b.dub, maxV: b.maxV, steps: (b.steps || []).length } }; };
    out.applied = rd();
    // the snapshot must be keyed BY LAYER
    out.snapKeys = (function () { try { return Object.keys(JSON.parse(_ambNovUndo.snap).tset || {}).sort(); }
      catch (e) { return ['<err ' + e.message + '>']; } })();
    // a layer whose set has GONE between Apply and Undo must be skipped, not throw
    delete E.getCfg().bed.toneSeq;
    out.reverted = _ambNovRevert(E, E.getCfg());
    const c4 = E.getCfg();
    out.after = { v2pal: ((c4.layers || [])[0].toneSeq || {}).pal,
                  v2dub: ((c4.layers || [])[0].toneSeq || {}).dub,
                  v1: !!c4.bed.toneSeq };
    return out;
  });
  ok('the row is offered, and live, once a layer has a Tone set of two voices',
    tset.label === '◇ Tone set' && tset.live === true, JSON.stringify(tset));
  ok('…and it names how many layers it speaks for',
    /2 layers/.test(tset.at55 || ''), JSON.stringify(tset.at55));
  ok('…◇ Palette at mid, and ◇ Doubling only from higher up',
    /palette/.test(tset.at55 || '') && !/doubling/.test(tset.at55 || '') && /doubling/.test(tset.at100 || ''),
    JSON.stringify([tset.at55, tset.at100]));
  ok('…it is its OWN axis — leaning Instrument to 0 switches it off alone',
    /off/.test(tset.leanedOff || ''), JSON.stringify(tset.leanedOff));
  ok('Apply writes ◇ Palette to every eligible layer',
    tset.applied.v2.pal === 90 && tset.applied.v1.pal === 90, JSON.stringify(tset.applied));
  ok('…◇ Doubling ONLY to the layers that can actually stack',
    tset.applied.v2.dub > 0 && tset.applied.v1.dub === undefined, JSON.stringify(tset.applied));
  ok('…it never writes the voice CAP, which is the user\u2019s ceiling',
    tset.applied.v2.maxV === undefined && tset.applied.v1.maxV === undefined, JSON.stringify(tset.applied));
  ok('…and never adds, removes or reorders a voice — the set is hand-authored',
    tset.applied.v2.steps === 2 && tset.applied.v1.steps === 2, JSON.stringify(tset.applied));
  ok('the undo snapshot is keyed BY LAYER, not by position',
    JSON.stringify(tset.snapKeys) === '["bed","v2:1"]', JSON.stringify(tset.snapKeys));
  ok('↶ Undo puts each layer\u2019s OWN prior back',
    tset.reverted === true && tset.after.v2pal === 11 && tset.after.v2dub === undefined,
    JSON.stringify(tset.after));
  ok('…and a layer whose set has gone since is skipped, not thrown away with the undo',
    tset.after.v1 === false, JSON.stringify(tset.after));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
