// PROBE — ⟲ A LOOP LENGTH IN PASSES OR IN CHANGES.
//
// user, 2026-09-27: "wherever scheduling is happening, Bar and Change (whole or
// fractional) should be optional units to express scheduling in".
//
// `layer.lenSync` already bound a layer's repeat length to the arrangement in PASSES of
// a part — an arrangement-relative unit, but the only one. It now also counts CHANGES:
// "this riff takes 3 changes before it repeats", walked against the real cadence and
// cycling if the count runs past the part's own changes.
//
// `passes` keeps its key whatever it counts (save-compat); `unit: 'chg'` is additive
// and ABSENT = passes, so every binding written before today resolves to the same bars.
//
//   node test/probe-lenunit.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(800);

  console.log('\n  ⟲ the binding');
  const eng = await page.evaluate(() => {
    const E = _masterEng; _E = E;
    const c = E.getCfg();
    const CH = (root, bars) => ({ root, intervals: [0, 4, 7], bars });
    c.prog.on = true; c.barsPerChord = 1;
    // an UNEVEN cadence: 1 · 3 · 1 · 3
    c.prog.chords = [CH(0, 1), CH(5, 3), CH(7, 1), CH(2, 3)];
    c.prog.parts = [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
    const cfg = E.getCfg();
    return {
      partBars: _ambLenPartBars(cfg, 0),
      one: _ambLenChangesBars(cfg, 0, 1),
      two: _ambLenChangesBars(cfg, 0, 2),
      three: _ambLenChangesBars(cfg, 0, 3),      // cycles: 1 + 3 + 1
      cad: _ambCadence(cfg, 0),
    };
  });
  ok('the fixture is uneven — 1 then 3', JSON.stringify(eng.cad) === '[1,3]', JSON.stringify(eng.cad));
  ok('one change is that change, not an average', eng.one === 1, String(eng.one));
  ok('…two is the pair', eng.two === 4, String(eng.two));
  ok('…and a count past the part cycles round it', eng.three === 5, String(eng.three));
  ok('a whole pass is still the whole part', eng.partBars === 4, String(eng.partBars));

  // ---- IT REACHES `write.bars`, WHICH IS WHAT LOOPS A LAYER --------------------
  const wrote = await page.evaluate(() => {
    const E = _masterEng;
    const c = E.getCfg();
    const L = _ambSeqList ? null : null;
    // a v1 extra that carries lenSync — the bed is always present
    c.bed.present = true;
    c.bed.lenSync = { part: 0, passes: 2 };
    E.getCfg();
    const asPasses = E.getCfg().bed.write ? E.getCfg().bed.write.bars : null;
    E.getCfg().bed.lenSync = { part: 0, passes: 2, unit: 'chg' };
    E.getCfg();
    const asChanges = E.getCfg().bed.write ? E.getCfg().bed.write.bars : null;
    const stored = E.getCfg().bed.lenSync;
    E.getCfg().bed.lenSync = { part: 0, passes: 2, unit: 'nonsense' };
    E.getCfg();
    const junk = E.getCfg().bed.lenSync.unit;
    return { asPasses, asChanges, stored, junk };
  });
  ok('2 passes of a 4-bar part is 8 bars', wrote.asPasses === 8, JSON.stringify(wrote));
  ok('…and 2 CHANGES of it is 4 — the cadence, not the part', wrote.asChanges === 4, JSON.stringify(wrote));
  ok('the store keeps the count under its own key and names its unit',
    wrote.stored && wrote.stored.passes === 2 && wrote.stored.unit === 'chg', JSON.stringify(wrote.stored));
  ok('…and a unit it does not know is dropped', wrote.junk === undefined, JSON.stringify(wrote.junk));

  // ---- THE MODAL OFFERS BOTH --------------------------------------------------
  console.log('\n  ⟲ the modal');
  const ui = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    E.getCfg().bed.lenSync = { part: 0, passes: 2 };
    E.getCfg();
    _ambLenSyncModal(E, { mode: 'edit', key: 'bed' });
    await new Promise((r) => setTimeout(r, 200));
    const ov = document.querySelector('.sm-overlay');
    if (!ov) return { err: 'no modal' };
    const segs = [...ov.querySelectorAll('.lsm-unit .ambient-seg')];
    const r = segs.length ? segs[1].getBoundingClientRect() : null;
    const out = { units: segs.map((b) => b.dataset.lu),
                  reach: !!(segs[1] && segs[1].offsetParent && r.width > 30 && r.height > 14),
                  okBefore: (ov.querySelector('.lsm-ok') || {}).textContent || '' };
    if (segs[1]) segs[1].click();
    await new Promise((r2) => setTimeout(r2, 150));
    out.pn = (ov.querySelector('.lsm-pn') || {}).textContent || '';
    out.okAfter = (ov.querySelector('.lsm-ok') || {}).textContent || '';
    ov.querySelector('.lsm-ok').click();
    await new Promise((r2) => setTimeout(r2, 250));
    out.stored = JSON.stringify(E.getCfg().bed.lenSync || null);
    out.bars = E.getCfg().bed.write ? E.getCfg().bed.write.bars : null;
    return out;
  });
  ok('⟲ the modal offers passes · changes', !ui.err && JSON.stringify(ui.units) === '["pass","chg"]',
    JSON.stringify(ui));
  ok('…measurable, not merely present', ui.reach === true, JSON.stringify(ui.reach));
  ok('…the readout follows the unit', /change/.test(ui.pn || ''), JSON.stringify(ui.pn));
  ok('…the bar total on the confirm button changes with it',
    ui.okBefore !== ui.okAfter && /4-bar/.test(ui.okAfter || ''), JSON.stringify([ui.okBefore, ui.okAfter]));
  ok('…and the pick is what gets stored, and what loops the layer',
    /"unit":"chg"/.test(ui.stored || '') && ui.bars === 4, JSON.stringify([ui.stored, ui.bars]));

  // ---- THE v2 HALF — ITS OWN NORMALIZER AND ITS OWN RECONCILER ----------------
  // `18-layer-v2.js` carried a COPY of the lenSync coercion and a second
  // passes×bars reconciler, so a v2 layer dropped the unit on every getCfg and
  // looped in passes whatever the store said. Both now go through v1's one
  // definition (`_ambNormalizeLenSync`) and v1's one conversion.
  console.log('\n  ⟲ a v2 layer');
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(900);

  const v2 = await page.evaluate(() => {
    const E = _masterEng;
    const o = { made: !!(E.getCfg().layers || []).length };
    if (!o.made) return o;
    // PER PART OUTRANKS THE CLOCK (`cycModeOf`), so a layer filed per part has no
    // cycle of its own to bind — the fixture is a layer with one content everywhere.
    const free = () => { const L = E.getCfg().layers[0];
      delete L.partFor; delete L.partSelect; E.getCfg(); };
    free();
    const set = (ls) => { free(); E.getCfg().layers[0].lenSync = ls; E.getCfg();
                          const L = E.getCfg().layers[0];
                          return { unit: (L.lenSync || {}).unit, n: (L.lenSync || {}).passes, bars: L.part.bars }; };
    o.passes = set({ part: 0, passes: 2 });
    o.chg = set({ part: 0, passes: 2, unit: 'chg' });
    o.one = set({ part: 0, passes: 1, unit: 'chg' });
    o.three = set({ part: 0, passes: 3, unit: 'chg' });
    // THE 64-BAR CEILING IS TAKEN IN WHOLE UNITS, and the count is written back so
    // the chip stays honest — 64 passes of a 4-bar part is 16, not a 64-bar slice of
    // the 256 asked for. Both halves, from the same helper.
    o.cap = set({ part: 0, passes: 64 });
    o.capChg = set({ part: 0, passes: 40, unit: 'chg' });   // 1·3 cadence: 32 changes = 64 bars
    E.getCfg().bed.lenSync = { part: 0, passes: 64 };
    E.getCfg();
    o.v1cap = E.getCfg().bed.lenSync.passes;
    // …and the ONE coercion takes its cap from its caller, so neither surface
    // narrows what the other one stores.
    const coerce = (n, max) => { const o2 = { lenSync: { part: 0, passes: n } };
      _ambNormalizeLenSync(o2, max); return (o2.lenSync || {}).passes; };
    o.coerce64 = coerce(40, 64); o.coerce32 = coerce(40);
    // THE CLOCK KEEPS ITS OWN `else`: an unbound, non-free layer stores no ms.
    delete E.getCfg().layers[0].lenSync;
    E.getCfg();
    o.msGone = E.getCfg().layers[0].part.ms === undefined;
    o.label = (typeof _ambLenSyncLabel === 'function')
      ? _ambLenSyncLabel(E.getCfg(), { part: 0, passes: 3, unit: 'chg' }) : '';
    o.labelPass = (typeof _ambLenSyncLabel === 'function')
      ? _ambLenSyncLabel(E.getCfg(), { part: 0, passes: 3 }) : '';
    o.hadPartFor = Number.isFinite(E.getCfg().layers[0].partFor);
    set({ part: 0, passes: 2, unit: 'chg' });
    return o;
  });
  ok('a v2 layer exists to bind', v2.made === true, JSON.stringify(v2));
  ok('the unit SURVIVES the v2 normalizer', v2.chg && v2.chg.unit === 'chg', JSON.stringify(v2.chg));
  ok('…2 passes of the part is 8 bars of cycle', v2.passes && v2.passes.bars === 8, JSON.stringify(v2.passes));
  ok('…and 2 CHANGES of it is 4 — v2 walks the same cadence v1 does',
    v2.chg && v2.chg.bars === 4, JSON.stringify(v2.chg));
  ok('…one change is the first change, not a quarter of the part',
    v2.one && v2.one.bars === 1, JSON.stringify(v2.one));
  ok('…and three cycles round it — 1 + 3 + 1', v2.three && v2.three.bars === 5, JSON.stringify(v2.three));
  ok('the 64-bar ceiling is taken in WHOLE passes, and the count is written back',
    v2.cap && v2.cap.n === 16 && v2.cap.bars === 64 && v2.v1cap === 16,
    JSON.stringify([v2.cap, v2.v1cap]));
  ok('…and in WHOLE CHANGES too — never a loop ending inside a chord',
    v2.capChg && v2.capChg.n === 32 && v2.capChg.bars === 64, JSON.stringify(v2.capChg));
  ok('the one coercion takes its cap from the caller — 64 for v2, 32 for v1’s modal',
    v2.coerce64 === 40 && v2.coerce32 === 32, JSON.stringify([v2.coerce64, v2.coerce32]));
  ok('an unbound bar-clock layer stores no ms — the clock kept its own else',
    v2.msGone === true, JSON.stringify(v2.msGone));
  ok('the one labeller names the unit', /3 changes of /.test(v2.label || '') && /3 × /.test(v2.labelPass || ''),
    JSON.stringify([v2.label, v2.labelPass]));

  // THE CARD SAYS IT, AND ITS STEPPER STEPS THE COUNT — the row is found by
  // WALKING THE DOORS (group button → tab), so it has to be reachable through one
  // of them, not merely present in the markup.
  const expand = await page.evaluate(() => {
    const el = document.querySelector('.v2-layer .ambient-collapse');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (expand) await page.touchscreen.tap(expand.x, expand.y);
  await zz(700);
  const card = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    const h = document.getElementById('bloom-v2-layers');
    const un = () => { const cd = document.querySelector('.v2-layer'); if (cd) cd.classList.remove('collapsed'); };
    // TWICE, and un-collapsed after each: the card is `_sig`-cached, and editing a
    // layer object directly does not move that signature.
    if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
    if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(140);
    // ANYWHERE ON THE CARD, measured — the sheet and the card's own group bodies
    // both hold rows, and which one carries it is the card's business, not the
    // probe's. What matters is that a real instance is on screen.
    const seen = () => [...document.querySelectorAll('.v2-layer [data-f="lenSync.passes"]')]
      .find((x) => x.offsetParent && x.getBoundingClientRect().height > 8) || null;
    // ⚙ DEEP SITS OVER THE SHEET — the Generate door opens that staged panel, not
    // a group of rows, and while it is open every sheet row measures 0×0. Closed
    // first, and again if a door opens it, or the walk reports its own success as a
    // missing control (it did, for three runs).
    const shutDeep = async () => {
      const cd = document.querySelector('.v2-layer');
      if (cd && cd.classList.contains('v2-genopen')) {
        const x = cd.querySelector('.v2-gencancel'); if (x) { x.click(); await wait(280); }
      }
    };
    // THE DOOR IS THE ROW'S OWN: the head of the group it is filed under, which is
    // the press a finger makes (a `.v2-gototab` only exists INSIDE an already-open
    // sheet, so it can never be the first one). Its own tab after that, when the
    // group opens as a tabbed sheet rather than in the card body.
    await shutDeep();
    let el = seen(), door = null, tab = null;
    const anchor = document.querySelector('.v2-layer [data-f="lenSync.passes"]');
    const grp = anchor ? ((anchor.closest('[data-v2g]') || {}).dataset || {}).v2g : null;
    const want = anchor ? ((anchor.closest('[data-v2tab]') || {}).dataset || {}).v2tab : null;
    if (!el && grp) {
      const head = document.querySelector('.v2-layer [data-v2grp="' + grp + '"] .ambient-grp-head');
      if (head) { head.click(); await wait(520); await shutDeep(); door = grp; el = seen(); }
      if (!el && want) {
        const t = document.querySelector('.v2-layer .v2-pop-tabs [data-tab="' + want + '"]');
        if (t) { t.click(); await wait(320); tab = want; el = seen(); }
      }
    }
    if (!el) return { err: 'no reachable row',
      why: { doors: [...document.querySelectorAll('.v2-layer .v2-gototab')].map((g) => g.dataset.goto),
             tabs: [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')].map((t) => t.dataset.tab),
             anyInDom: document.querySelectorAll('[data-f="lenSync.passes"]').length,
             cardCls: (document.querySelector('.v2-layer') || {}).className,
             cyc: (document.querySelector('.v2-cycmode') || {}).value,
             ls: JSON.stringify((E.getCfg().layers[0] || {}).lenSync || null),
             grp: grp, want: want,
             cyc: (document.querySelector('.v2-layer .v2-cycmode') || {}).value,
             inp: (() => { const lv = document.querySelector('.v2-layer [data-f="lenSync.passes"]');
               if (!lv) return null; const r = lv.getBoundingClientRect();
               return { off: !!lv.offsetParent, w: Math.round(r.width), h: Math.round(r.height),
                        cls: lv.className, tag: lv.tagName,
                        d: getComputedStyle(lv).display, top: Math.round(r.top) }; })(),
             rowHTML: (() => { const lv = document.querySelector('.v2-layer [data-f="lenSync.passes"]');
               const r = lv ? (lv.closest('.ambient-ctrl') || lv) : null;
               return r ? r.outerHTML.slice(0, 260) : ''; })(),
             sty: (() => { const lv = document.querySelector('.v2-layer [data-f="lenSync.passes"]');
               const r = lv ? (lv.closest('.ambient-ctrl') || lv) : null;
               return r ? (r.getAttribute('style') || '') : ''; })(),
             chain: (() => { const out = []; const lv = document.querySelector('.v2-layer [data-f="lenSync.passes"]');
               let n = lv ? (lv.closest('.ambient-ctrl') || lv) : null;
               while (n && n !== document.body) { const cs = getComputedStyle(n);
                 out.push({ c: (n.className || '').slice(0, 60), d: cs.display, v: cs.visibility,
                            h: Math.round(n.getBoundingClientRect().height) });
                 n = n.parentElement; } return out; })(),
             overlay: !!document.querySelector('.sm-overlay') } };
    const row = el.closest('.ambient-ctrl') || el;
    row.scrollIntoView({ block: 'center' });
    await wait(200);
    const r = row.getBoundingClientRect();
    const up = row.querySelector('.ambient-step-up');
    const ur = up ? up.getBoundingClientRect() : null;
    // A TOUCH LANDS IN VIEWPORT COORDINATES — a row 2400px down measures 32px tall
    // and is still untappable, so the point is checked against what is actually
    // under it (the gate's own rule).
    const hit = ur ? document.elementFromPoint(ur.left + ur.width / 2, ur.top + ur.height / 2) : null;
    return { door: door, tab: tab,
             covered: !!(up && hit !== up && !up.contains(hit)),
             label: ((row.querySelector('label') || {}).textContent || ''),
             title: row.getAttribute('title') || '',
             value: el.value,
             hint: (row.querySelector('.ambient-hint') || {}).textContent || '',
             rect: [Math.round(r.width), Math.round(r.height)],
             upAt: ur ? { x: ur.left + ur.width / 2, y: ur.top + ur.height / 2,
                          w: Math.round(ur.width), h: Math.round(ur.height) } : null };
  });
  ok('the bound row is reachable through a door, measured', !card.err &&
    card.rect[0] > 40 && card.rect[1] > 8, JSON.stringify(card));
  ok('…its LABEL names what the number counts, not bars',
    card.label === 'Changes' && card.value === '2', JSON.stringify([card.label, card.value]));
  ok('…and no leftover bar-count tooltip (the description map is keyed by the label)',
    !/How many bars/.test(card.title || ''), JSON.stringify(card.title));
  ok('…the hint names CHANGES and what they come to',
    /changes of /.test(card.hint || '') && /4 bars/.test(card.hint || ''), JSON.stringify(card.hint));
  ok('…and its + is on screen, nothing over it', !card.err && !card.covered &&
    !!card.upAt && card.upAt.w > 20 && card.upAt.h > 20, JSON.stringify([card.upAt, card.covered]));
  if (card.upAt && card.upAt.w > 20 && card.upAt.h > 20 && !card.covered) {
    await page.touchscreen.tap(card.upAt.x, card.upAt.y);
    await zz(450);
    const after = await page.evaluate(() => {
      const L = _masterEng.getCfg().layers[0];
      const el = [...document.querySelectorAll('.v2-layer [data-f="lenSync.passes"]')]
        .find((x) => x.offsetParent) || null;
      const row = el ? (el.closest('.ambient-ctrl') || el) : null;
      return { n: (L.lenSync || {}).passes, unit: (L.lenSync || {}).unit, bars: L.part.bars,
               hint: row ? ((row.querySelector('.ambient-hint') || {}).textContent || '') : '' };
    });
    ok('a real touch on + steps the CHANGE count, and the walk follows it',
      after.n === 3 && after.unit === 'chg' && after.bars === 5, JSON.stringify(after));
    ok('…and the hint repaints to the new total', /5 bars/.test(after.hint || ''), JSON.stringify(after.hint));
  } else {
    ok('the bound stepper has a touchable +', false, JSON.stringify(card.upAt));
  }

  // THE UNIT IS EDITED IN v1'S MODAL, WHICH RE-SYNCS RATHER THAN REBUILDING — so
  // the label and the number on the open card need a second writer. Switch back to
  // passes there and read the card without rendering it again.
  const back = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    const id = E.getCfg().layers[0].id | 0;
    _ambLenSyncModal(E, { mode: 'edit', key: 'v2:' + id });
    await new Promise((r) => setTimeout(r, 250));
    const ov = document.querySelector('.sm-overlay');
    if (!ov) return { err: 'no modal' };
    const seg = [...ov.querySelectorAll('.lsm-unit .ambient-seg')].find((b) => b.dataset.lu === 'pass');
    if (!seg) return { err: 'no passes button' };
    seg.click();
    await new Promise((r) => setTimeout(r, 150));
    ov.querySelector('.lsm-ok').click();
    await new Promise((r) => setTimeout(r, 400));
    const L = E.getCfg().layers[0];
    const el = [...document.querySelectorAll('.v2-layer [data-f="lenSync.passes"]')]
      .find((x) => x.offsetParent) || null;
    const row = el ? (el.closest('.ambient-ctrl') || el) : null;
    return { unit: (L.lenSync || {}).unit, n: (L.lenSync || {}).passes, bars: L.part.bars,
             label: row ? ((row.querySelector('label') || {}).textContent || '') : '',
             value: el ? el.value : '', hint: row ? ((row.querySelector('.ambient-hint') || {}).textContent || '') : '' };
  });
  ok('the modal edits a v2 layer’s binding — back to passes', !back.err &&
    back.unit === undefined && back.n === 3 && back.bars === 12, JSON.stringify(back));
  ok('…and the open card follows it: label, count and hint all repainted',
    back.label === 'Passes' && back.value === '3' && /passes of /.test(back.hint || '') &&
    /12 bars/.test(back.hint || ''), JSON.stringify(back));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
