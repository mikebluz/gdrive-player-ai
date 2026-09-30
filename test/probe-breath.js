// PROBE — ⏸ Breath and ✦ Flourish: silence and rate, PLACED.
//
// user, 2026-09-30: "work silence (lack of notes) into the generation tooling;
// how can we allow the tasteful holding back of playing, and also flourishes
// (sudden changes in note rate, sometimes several in quick succession)".
//
// Everything the engine had was a per-ONSET coin flip, so silence arrived as
// random gaps. These two work in WINDOWS of the cycle and are decided per
// window, seeded from the take — so what is checked here is that a rest LANDS
// where it was asked for, that the layer can never vanish for a whole pass,
// that a pass replays until 🎲 New take, and that the drawing and the emitter
// are handed the same notes (the one rule this file keeps paying for).
//
//   node test/probe-breath.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.evaluate(() => {
    document.body.classList.add('view-mix'); _ambInitMaster();
    const c = _masterEng.getCfg();
    c.prog.on = true;
    c.prog.chords = [{ root: 2, intervals: [0, 4, 7], bars: 1 }, { root: 7, intervals: [0, 4, 7], bars: 1 },
                     { root: 9, intervals: [0, 4, 7], bars: 1 }, { root: 4, intervals: [0, 3, 7], bars: 1 }];
    _masterEng.getCfg();
  });
  await zz(400);
  // the door a person uses
  await page.evaluate(() => document.getElementById('mix-bloom-add-layer').click());
  await zz(450);
  await page.evaluate(() => [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click());
  await zz(800);

  const eng = await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = () => document.querySelector('.v2-layer'); const E = _masterEng;
    card().classList.remove('collapsed'); _v2.openGen(E, E.getCfg().layers[0]); await w(300);
    card().querySelector('.v2-genwrap .v2-mkpart[data-mk="line"]').click(); await w(300);
    card().querySelector('.v2-genwrap .v2-gendone').click(); await w(500);
    const L0 = E.getCfg().layers[0];
    L0.part.bars = 4; L0.part.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    delete L0.part.vary;            // a FIXED take: every pass the same, so drawn == played
    E.getCfg();
    const gen = () => {
      const X = E.getCfg().layers[0], cyc = _v2.cycleSec(X, E.getCfg()), bf = X.part.bars;
      const ns = _v2.withEdit(() => _v2.withTake(_v2.pinOf(X), () => _v2.notesFor(X,
        { E, cfg: E.getCfg(), key: 'v2:' + X.id, cycleStart: 0, cycleSec: cyc })));
      const per = [0, 0, 0, 0]; ns.forEach((n) => { per[Math.min(3, Math.floor((n.at / cyc) * bf + 1e-6))]++; });
      return { per, n: ns.length, sig: ns.map((n) => Math.round(n.at * 1000)).join(',') };
    };
    const set = (k, v) => { const X = E.getCfg().layers[0]; if (v) X[k] = v; else delete X[k]; E.getCfg(); };
    const o = {};
    o.plain = gen();
    set('breath', { amount: 55, len: 'bar', where: 'end' }); o.end = gen();
    set('breath', { amount: 100, len: 'bar' }); o.all = gen();
    set('breath', { amount: 1, len: 'bar', pair: 'fill' }); set('flourish', { amount: 55, wild: 60 }); o.paired = gen();
    set('breath', { amount: 40, len: 'bar' }); set('flourish', { amount: 35, wild: 60 });
    o.a = gen(); o.b = gen();
    const X = E.getCfg().layers[0]; X.part.take = (X.part.take | 0) + 1; E.getCfg();
    o.retake = gen();
    // ONE CYCLE, BOTH CODE PATHS — pinned (what the card draws) vs unpinned (what
    // the emitter asks for). Clocks moved together, so only the stage can differ.
    const L = E.getCfg().layers[0], key = 'v2:' + L.id, cyc = _v2.cycleSec(L, E.getCfg()), csX = cyc * 3;
    const sig = (ns) => ns.map((n) => Math.round((n.at - csX) * 1000)).sort((x, y) => x - y).join(',');
    const pinned = sig(_v2.withEdit(() => _v2.withTake(_v2.pinOf(L), () => _v2.notesFor(L,
      { E, cfg: E.getCfg(), key, cycleStart: csX, cycleSec: cyc }))));
    const sv = { pa: E._progAnchor, ps: E._playStartAt, bg: E._barGridAnchor };
    E._progAnchor = csX; E._playStartAt = csX; E._barGridAnchor = csX;
    let live = '';
    try { live = sig(_v2.withEdit(() => _v2.notesFor(L, { E, cfg: E.getCfg(), key, cycleStart: csX, cycleSec: cyc }))); }
    finally { E._progAnchor = sv.pa; E._playStartAt = sv.ps; E._barGridAnchor = sv.bg; }
    o.pathsAgree = pinned === live; o.pathN = pinned.split(',').length;
    set('breath', null); set('flourish', null);
    o.pruned = !E.getCfg().layers[0].breath && !E.getCfg().layers[0].flourish;
    // Length set BEFORE Amount must survive the normalizer (two presses, one row each)
    E.getCfg().layers[0].breath = { len: 'beat' }; E.getCfg();
    o.lenKept = ((E.getCfg().layers[0].breath || {}).len === 'beat');
    set('breath', null);
    return o;
  });

  console.log('\n  ⏸ Breath');
  ok('a plain layer is untouched — absent by default', eng.plain.per.join('/') === '8/8/8/8', eng.plain.per.join('/'));
  ok('…"phrase ends" rests at the END of the phrase', eng.end.per[3] === 0 && eng.end.per[0] > 0, eng.end.per.join('/'));
  ok('…and at 100% the layer STILL says something (never a whole silent pass)',
    eng.all.per.some((x) => x > 0), eng.all.per.join('/'));
  console.log('\n  ✦ Flourish');
  ok('"flourish, then rest" puts the burst before the silence', (() => {
    const i = eng.paired.per.findIndex((x) => x > eng.plain.per[0]);
    return i >= 0 && i + 1 < 4 && eng.paired.per[i + 1] === 0;
  })(), eng.paired.per.join('/'));
  console.log('\n  the take');
  ok('a pass replays exactly until 🎲 New take', eng.a.sig === eng.b.sig);
  ok('…and a new take places them somewhere else', eng.retake.sig !== eng.a.sig);
  console.log('\n  one answer for the picture and the sound');
  ok('the drawing and the emitter are handed the SAME notes', eng.pathsAgree, eng.pathN + ' notes');
  console.log('\n  the saved shape');
  ok('both are pruned when set back to nothing', eng.pruned);
  ok('…and Length set before Amount is not thrown away between the two presses', eng.lenKept);

  // ---- REACHABLE: the rows, and the one-place control on ✺ Groove ----------
  const rows = await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = () => document.querySelector('.v2-layer'); const E = _masterEng;
    card().classList.remove('collapsed'); _v2.openGen(E, E.getCfg().layers[0]); await w(400);
    const z = card().querySelector('.v2-genzone[data-gz="3"]'); if (z) z.click(); await w(300);
    const tb = card().querySelector('.v2-fttab[data-ft="rhythm"]'); if (tb) tb.click(); await w(300);
    const out = { bad: [] };
    ['breath.amount', 'breath.len', 'breath.where', 'flourish.amount', 'flourish.wild',
     'flourish.where', 'breath.pair'].forEach((f) => {
      const el = card().querySelector('.v2-genwrap .v2-f[data-f="' + f + '"]');
      if (!el) { out.bad.push(f + ' MISSING'); return; }
      el.scrollIntoView({ block: 'center' });
      const q = el.getBoundingClientRect(), row = el.closest('.ambient-ctrl');
      const pr = row ? row.getBoundingClientRect() : q;
      if (!(q.width > 20 && q.height > 16 && el.offsetParent)) out.bad.push(f + ' ' + Math.round(q.width) + 'x' + Math.round(q.height));
      else if (q.right > pr.right + 1) out.bad.push(f + ' overflows its row');
    });
    const sl = card().querySelector('.v2-genwrap .v2-f[data-f="breath.amount"]');
    sl.value = '45'; sl.dispatchEvent(new Event('input', { bubbles: true })); await w(200);
    const se = card().querySelector('.v2-genwrap .v2-f[data-f="breath.len"]');
    se.value = 'chg'; se.dispatchEvent(new Event('input', { bubbles: true }));
    se.dispatchEvent(new Event('change', { bubbles: true })); await w(300);
    const S = _v2.stagedOf(E.getCfg().layers[0].id);
    out.staged = !!(S && S.breath && S.breath.amount === 45 && S.breath.len === 'chg');
    out.layerUntouched = !E.getCfg().layers[0].breath;        // nothing is written until ✓ Done
    card().querySelector('.v2-genwrap .v2-gendone').click(); await w(500);
    const B = E.getCfg().layers[0].breath || {};
    out.written = (B.amount === 45 && B.len === 'chg');
    delete E.getCfg().layers[0].breath; E.getCfg();
    return out;
  });
  console.log('\n  ⚙ Deep ▸ Fine-tune ▸ Rhythm');
  ok('all seven rows are reachable and fit their rows', !rows.bad.length, rows.bad.join(' | '));
  ok('…they stage, and write nothing until ✓ Done', rows.staged && rows.layerUntouched);
  ok('…and ✓ Done writes them', rows.written);

  await page.evaluate(() => { const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click(); });
  await zz(500);
  await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp[data-grp="✺ Variation"] > .ambient-grp-head');
    if (g && !g.parentElement.classList.contains('open')) g.click();
    try { _ambRenderVarBar(_masterEng); } catch (e) {}
  });
  await zz(500);
  const box = await page.evaluate(() => {
    const b = document.querySelector('.ambient-pov-varstrip [data-pov="grp:groove"]');
    if (!b) return null; b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (box) await page.touchscreen.tap(box.x, box.y);
  await zz(800);
  const cardOut = await page.evaluate(() => {
    const b = document.querySelector('.ambient-groove-brs[data-brs="breath.amount"]');
    if (!b) return { missing: true };
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    // NOT `offsetParent` — it is null for anything inside the popover's
    // fixed-position wrapper, which reads as "hidden" on a control you can see.
    // What is AT the control is the test that cannot lie.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const set = (sel, v, ev) => { const e = document.querySelector(sel); if (!e) return; e.value = v; e.dispatchEvent(new Event(ev, { bubbles: true })); };
    set('.ambient-groove-brs[data-brs="breath.amount"]', '40', 'change');
    set('.ambient-groove-brsel[data-brsel="breath.where"]', 'end', 'change');
    set('.ambient-groove-brs[data-brs="flourish.amount"]', '35', 'change');
    const L = _masterEng.getCfg().layers[0];
    return { w: Math.round(r.width), h: Math.round(r.height),
      shown: r.width > 20 && r.height > 8 && r.top >= 0 && r.bottom <= innerHeight + 1 && (hit === b || b.contains(hit)),
      at: hit ? (hit.className || hit.tagName).toString().slice(0, 40) : 'nothing',
      wrote: !!(L.breath && L.breath.amount === 40 && L.breath.where === 'end' && L.flourish && L.flourish.amount === 35) };
  });
  console.log('\n  ✺ Groove — the one-place control');
  ok('the Breath block is reachable on the card', !cardOut.missing && cardOut.shown && cardOut.w > 20,
    JSON.stringify(cardOut));
  ok('…and it writes through to the layer', !!cardOut.wrote, JSON.stringify(cardOut));

  // ---- ✺ NOVELTY reaches them, and the master switch parks them --------------
  // One dial over the whole arrangement has to move these too, or "how much the
  // piece changes as it plays" quietly means "except its silence".
  const nov = await page.evaluate(() => {
    const E = _masterEng;
    // from nothing: the ✺ Groove block above left values on a layer
    (E.getCfg().layers || []).forEach((L) => { delete L.breath; delete L.flourish; });
    E.getCfg();
    const st = (a) => { const s = _ambNovState(); s.amount = a; s.bal = { h: 50, t: 50, f: 50, x: 50, i: 50 }; };
    const snap = () => (E.getCfg().layers || []).map((L) =>
      (L.breath ? L.breath.amount : 0) + '/' + (L.flourish ? L.flourish.amount : 0) +
      (L.breath && L.breath.where ? ':' + L.breath.where : '') +
      (L.breath && L.breath.pair ? ':' + L.breath.pair : '')).join(' | ');
    const o = { nL: (E.getCfg().layers || []).length, before: snap() };
    o.zero = (E.getCfg().layers || []).map(() => '0/0').join(' | ');
    st(40);
    o.rows = _ambNovPlan(E.getCfg(), _ambNovState())
      .filter((x) => /Breath|Flourish/.test(x.label)).map((x) => ({ live: x.live !== false, to: x.to }));
    _ambNovApply(E, E.getCfg()); E.getCfg(); o.mild = snap();
    st(85); _ambNovApply(E, E.getCfg()); E.getCfg(); o.wild = snap();
    _ambNovCompare(E, E.getCfg()); E.getCfg(); o.compareOff = snap();
    _ambNovCompare(E, E.getCfg()); E.getCfg(); o.compareOn = snap();
    _ambNovRevert(E, E.getCfg()); E.getCfg(); o.undone = snap();
    st(70); _ambNovApply(E, E.getCfg()); E.getCfg(); const was = snap();
    _ambVarBypassSet(E, E.getCfg(), true); E.getCfg(); o.bypassed = snap();
    _ambVarBypassSet(E, E.getCfg(), false); E.getCfg(); o.restored = snap();
    o.bypassRoundTrip = (o.restored === was);
    return o;
  });
  console.log('\n  ✺ Novelty');
  ok('both rows are live with layers to write to', nov.rows.length === 2 && nov.rows.every((x) => x.live),
    JSON.stringify(nov.rows));
  ok('…Apply sets every layer, and more of it at a higher dial',
    nov.before === nov.zero && nov.wild !== nov.mild &&
    nov.mild.split(' | ').every((x) => /^[1-9]/.test(x)),
    nov.before + '  →  ' + nov.mild + '  →  ' + nov.wild);
  ok('…a high dial places them at phrase ends and pairs the fill',
    /:end/.test(nov.wild) && /:fill/.test(nov.wild), nov.wild);
  ok('…the ✺ Novelty on/off switch puts them back exactly', nov.compareOn === nov.wild && nov.compareOff === nov.mild,
    nov.compareOff + '  /  ' + nov.compareOn);
  ok('…and ↶ Undo does too', nov.undone === nov.mild, nov.undone);
  console.log('\n  ✺ Variation: On/Off');
  ok('the master switch bypasses them with everything else', nov.bypassed === nov.zero, nov.bypassed);
  ok('…and brings them back exactly as they were', nov.bypassRoundTrip, nov.restored);

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
