// PROBE — every ✺ Variation on/off switch really bypasses its axis.
//
// user, 2026-09-30: "bug with Groove on/off, it doesn't seem to be bypassed when
// turned off, do an audit of the Variation on/off switches and make sure they all
// work correctly; if they all work fine something else is introducing rhythm jank".
//
// ONE DEFINITION OF "OFF", applied to all of them: switched off must be
// INDISTINGUISHABLE from never having been set. So each axis is measured three
// times — never set, set hard, then switched off — and the third must equal the
// first, note for note. Anything an axis leaves behind when it is off is exactly
// the "it isn't bypassed" report, whatever the switch's own state says.
//
//   node test/probe-variation-audit.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => document.getElementById('mix-bloom-add-layer').click());
    await zz(400);
    await page.evaluate(() => [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click());
    await zz(650);
  }

  const res = await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed'); _v2.openGen(E, E.getCfg().layers[0]); await w(300);
    card().querySelector('.v2-genwrap .v2-mkpart[data-mk="line"]').click(); await w(300);
    card().querySelector('.v2-genwrap .v2-gendone').click(); await w(500);
    (E.getCfg().layers || []).forEach((L) => { L.part.bars = 4; L.part.rhythm = { kind: 'pulse', n: 8, steps: 16 }; delete L.part.vary; });
    E.getCfg();
    // WHAT THE LAYER PLAYS, exactly: every onset's time, pitch, length and accent.
    // `_ambSyncControls` first, because it is what sets the module's `_E` — and
    // `_ambGroove()` reads the groove off `_E._cfg`. Without it every Groove macro
    // measures as INERT, which would have read as "they are all bypassed already".
    let try_ = 0;
    const sig = () => (try_ = 0, E._cfg = E.getCfg(), (() => { try { _ambSyncControls(E); } catch (e) {} })(),
      (E.getCfg().layers || []).map((L) => {
      const cyc = _v2.cycleSec(L, E.getCfg());
      return _v2.withEdit(() => _v2.withTake(_v2.pinOf(L), () => _v2.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc })))
        .map((n) => Math.round(n.at * 1000) + ':' + Math.round(n.freq || 0) + ':' +
                    Math.round(n.durMs || 0) + ':' + (Number.isFinite(n.acc) ? n.acc.toFixed(2) : '-')).join(',');
    }).join(' | '));
    const g = () => { const c = E.getCfg(); if (!c.groove || typeof c.groove !== 'object') c.groove = { swing: 0, accent: 0, pushMode: 'ms' }; return c.groove; };
    // EVERY AXIS BACK TO NOTHING. Cases must not inherit each other, or "off did
    // not restore" just means the case before it is still set.
    const reset = () => {
      const c = E.getCfg();
      c.groove = { swing: 0, accent: 0, pushMode: 'ms' };
      c.startVary = 0;
      ['rubato', 'salt', 'vary', 'tension', 'reroll', 'order', 'arrOrder', 'arc', 'mixmove', 'varOff', 'varBypass']
        .forEach((k) => { delete c.prog[k]; });
      (c.layers || []).forEach((L) => { delete L.breath; delete L.flourish; delete L.mixRange; delete L.push; });
      E.getCfg();
    };
    const out = { base: (reset(), sig()), cases: [] };
    // ---- each axis: never set → set hard → switched off -------------------
    const run = (name, set, off) => {
      reset();
      const clean = sig() === out.base;
      set(); E.getCfg();
      const on = sig();
      off(); E.getCfg();
      const back = sig();
      out.cases.push({ name, clean, changed: on !== out.base, restored: back === out.base });
    };
    // 🕺 Groove — the BYPASS switch, one flag over every macro
    const GM = ['swing', 'accent', 'density', 'ghost', 'rolls', 'streak', 'couple'];
    run('🕺 Groove bypass — every macro at once', () => {
      const q = g(); GM.forEach((k) => { q[k] = 55; }); E.getCfg().startVary = 60;
    }, () => { g().bypass = true; });
    // …and the same flag with ⏸/✦ set, because those are edited ON the Groove card
    run('🕺 Groove bypass — with ⏸ Breath / ✦ Flourish set', () => {
      const q = g(); GM.forEach((k) => { q[k] = 55; });
      (E.getCfg().layers || []).forEach((L) => { L.breath = { amount: 60, len: 'bar' }; L.flourish = { amount: 60, wild: 70 }; });
    }, () => { g().bypass = true; });
    // …and each macro's own switch (the ✺ Variation option switches)
    GM.forEach((k) => {
      run('   ✺ ' + k + ' switch', () => { const q = g(); q[k] = 55; },
        () => { _ambVarOptSet(E.getCfg(), k, false); });
    });
    run('   ✺ Humanize switch', () => { E.getCfg().startVary = 70; }, () => { _ambVarOptSet(E.getCfg(), 'humanize', false); });
    // 🧂 Salt's five
    ['colors', 'vary', 'tension', 'reroll', 'scatter'].forEach((k) => {
      run('   ✺ ' + k + ' switch', () => { const c = E.getCfg(); _ambVarOptSet(c, k, true); const o = _AMB_VAR_OPTS[k]; o.set(c, o.max >= 100 ? 70 : Math.max(1, o.max - 1)); },
        () => { _ambVarOptSet(E.getCfg(), k, false); });
    });
    run('   ✺ Rubato switch', () => { E.getCfg().prog.rubato = { amount: 70 }; }, () => { _ambVarOptSet(E.getCfg(), 'rubato', false); });
    // ↻ Order, 🌒 Arc, ⇅ Mix — the "off deletes the key" idiom
    run('↻ Order off', () => { E.getCfg().prog.order = { mode: 'shuffle', when: 'always' }; }, () => { delete E.getCfg().prog.order; });
    run('🌒 Arc off', () => { E.getCfg().prog.arc = { amount: 80, bars: 8, shape: 'wave' }; }, () => { delete E.getCfg().prog.arc; });
    run('⏸/✦ their own amounts back to 0', () => {
      (E.getCfg().layers || []).forEach((L) => { L.breath = { amount: 60, len: 'bar' }; L.flourish = { amount: 60, wild: 70 }; });
    }, () => { (E.getCfg().layers || []).forEach((L) => { delete L.breath; delete L.flourish; }); });
    // the MASTER switch has to cover everything at once
    out.master = (function () {
      reset();
      const c = E.getCfg();
      const q = g(); GM.forEach((k) => { q[k] = 55; }); c.startVary = 60;
      c.prog.rubato = { amount: 70 }; c.prog.salt = { colors: 4, scatter: 70 };
      c.prog.vary = 60; c.prog.tension = 50; c.prog.reroll = 40;
      c.prog.order = { mode: 'shuffle', when: 'always' }; c.prog.arc = { amount: 70, bars: 8, shape: 'wave' };
      (c.layers || []).forEach((L) => { L.breath = { amount: 60, len: 'bar' }; L.flourish = { amount: 60, wild: 70 }; });
      E.getCfg(); const on = sig();
      _ambVarBypassSet(E, E.getCfg(), true); E.getCfg(); const off = sig();
      _ambVarBypassSet(E, E.getCfg(), false); E.getCfg(); const back = sig();
      return { changed: on !== out.base, bypassed: off === out.base, restored: back === on };
    })();
    return out;
  });

  console.log('\n  each switch: OFF must equal NEVER SET');
  res.cases.forEach((c) => {
    if (!c.clean) ok(c.name, false, 'the case did not start from a clean slate');
    else if (!c.changed) ok(c.name + ' — (inert here, nothing to bypass)', true);
    else ok(c.name, c.restored, 'ON changed the notes, OFF did not put them back');
  });
  console.log('\n  ✺ Variation: On/Off — the master');
  ok('it silences every axis at once', res.master.changed && res.master.bypassed, JSON.stringify(res.master));
  ok('…and brings them all back', res.master.restored, JSON.stringify(res.master));

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
