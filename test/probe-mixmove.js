// PROBE — ⇅ Mix: the arrangement rides its own faders.
//
// user, 2026-09-30: "a Novelty param that live mixes parts up and down, raising
// and lowering parts, also should be a fade quotient to determine how gradual or
// instant the level changes should be; we'll need a smart way to help the user
// define maximum and minimum for each layer, since those will be subjectively
// determined by the user".
//
// The subjective part is answered without anything to type: the level you set is
// the CEILING, one shared "down to" is the floor, and ⤓ From my mixing turns the
// levels you have ACTUALLY used (`mixSeen`, recorded on every hand move of a
// fader) into that layer's own range. What is checked here is that the mix moves,
// that it never gets louder than the balance you chose, that switching it off puts
// every fader back, and that ⤓ learns only from real moves.
//
//   node test/probe-mixmove.js       (needs `npm start`; BLOOPS_URL to retarget)
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
    c.prog.chords = [{ root: 2, intervals: [0, 4, 7], bars: 1 }, { root: 7, intervals: [0, 4, 7], bars: 1 }];
    _masterEng.getCfg();
  });
  await zz(400);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('mix-bloom-add-layer').click());
    await zz(400);
    await page.evaluate(() => [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click());
    await zz(650);
  }

  const eng = await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    (E.getCfg().layers || []).forEach((L, i) => { L.level = 70 + i * 5; L.part.kind = 'live'; L.part.mat = 'sustain'; });
    E.getCfg();
    const o = { nL: (E.getCfg().layers || []).length };
    const at = (t) => (E.getCfg().layers || []).map((L) => Math.round(_ambMixMoveTarget(E, L, E.getCfg(), t))).join(',');
    o.off = at(0);
    E.getCfg().prog.mixmove = { amount: 80, glide: 20, depth: 40, bars: 4 }; E.getCfg();
    o.t = [at(0), at(20), at(40), at(60)];
    o.moves = new Set(o.t).size > 1;
    o.layersDiffer = new Set(o.t[1].split(',')).size > 1;
    o.stable = (at(20) === o.t[1]);
    o.neverAbove = o.t.every((s) => s.split(',').every((v, i) => +v <= 70 + i * 5 + 0.5));
    // live: the gain really moves, and switching off puts every fader back
    try { await Tone.start(); } catch (e) {}
    _ambStartGenerator(E); await w(600);
    const rd = () => Object.keys(E.mod).map((k) => {
      const e = E.mod[k]; return e && e.levelGain ? Math.round(e.levelGain.gain.value * 1000) : -1; }).join(',');
    const g = [rd()]; await w(2200); g.push(rd()); await w(2200); g.push(rd());
    o.gainMoves = new Set(g).size > 1; o.gains = g;
    delete E.getCfg().prog.mixmove; E.getCfg(); await w(1200);
    const base = Object.keys(E.mod).map((k) => {
      const L = _ambLayerByKey(E, k); return Math.round(_ambLevelGain(L ? L.level : 70) * 1000); }).join(',');
    o.restored = (rd() === base);
    _ambStopGenerator(E);
    return o;
  });

  console.log('\n  the move');
  ok('off, every layer sits exactly where its fader is', eng.off === '70,75,80', eng.off);
  ok('…on, the mix moves as the piece plays', eng.moves, eng.t.join('  '));
  ok('…layers move independently of each other', eng.layersDiffer, eng.t[1]);
  ok('…the same take replays it exactly', eng.stable);
  ok('…and NOTHING ever gets louder than the balance you set', eng.neverAbove, eng.t.join('  '));
  ok('the live gain really moves while playing', eng.gainMoves, eng.gains.join('  '));
  ok('…and switching it off puts every fader back', eng.restored);

  // ---- the fade quotient ---------------------------------------------------
  // MEASURED AT THE PARAM, not by reading `gain.value`: a scheduled ramp reports
  // its TARGET there, so both fades looked identical while the curves differed.
  // What the feature promises is the time constant handed to the gain, so that is
  // what is recorded — and at fade 0 it must still be non-zero, because an abrupt
  // gain step is a click (the rule this repo states for every gain-like change).
  const fade = await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms)); const E = _masterEng;
    // Tone wraps the AudioParam, so the native prototype is not the call site —
    // the gain object each layer actually holds is.
    // The layer gains only exist while it is playing, and with core strips on they
    // are the strip SHIM — so `rampTo`, the one method both kinds answer, is the
    // call site to watch.
    let seen = [], undo = [];
    const spy = () => {
      undo.forEach((f) => f()); undo = [];
      Object.keys(E.mod).forEach((k) => {
        const g = E.mod[k] && E.mod[k].levelGain && E.mod[k].levelGain.gain;
        if (!g || typeof g.rampTo !== 'function') return;
        const o = g.rampTo;
        g.rampTo = function (v, d) { seen.push(d); return o.apply(this, arguments); };
        undo.push(() => { g.rampTo = o; });
      });
      return undo.length;
    };
    const run = async (glide) => {
      // the SHORTEST span, so several targets land inside the watch window
      E.getCfg().prog.mixmove = { amount: 90, glide, depth: 60, bars: 2 }; E.getCfg();
      _ambStartGenerator(E); await w(300);
      if (!spy()) { _ambStopGenerator(E); return -1; }
      seen = [];
      await w(1800); _ambStopGenerator(E); await w(200);
      const big = seen.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a);
      return big.length ? big[0] : 0;
    };
    const instant = await run(0), gradual = await run(100);
    undo.forEach((f) => f());
    if (instant < 0 || gradual < 0) { delete E.getCfg().prog.mixmove; E.getCfg(); return { unsupported: true }; }
    delete E.getCfg().prog.mixmove; E.getCfg();
    return { instant, gradual };
  });
  console.log('\n  the fade quotient');
  if (fade.unsupported) ok('the fade quotient reaches the gain', false, 'AudioParam not patchable here');
  else {
    ok('a higher fade hands the gain a longer glide',
      fade.gradual > fade.instant * 5, 'time constant — fade 0: ' + fade.instant.toFixed(3) + 's, fade 100: ' + fade.gradual.toFixed(3) + 's');
    ok('…and fade 0 is still a ramp, never an abrupt step (it would click)',
      fade.instant > 0.005 && fade.instant < 0.2, fade.instant.toFixed(4) + 's');
  }

  // ---- ⤓ From my mixing: it learns only from REAL moves --------------------
  const learn = await page.evaluate(() => {
    const E = _masterEng, o = {};
    (E.getCfg().layers || []).forEach((L) => { delete L.mixSeen; delete L.mixRange; }); E.getCfg();
    o.noneYet = (E.getCfg().layers || []).every((L) => !L.mixSeen);
    // ⇅ Mix's OWN movement must never widen the range it is moving inside
    E.getCfg().prog.mixmove = { amount: 90, glide: 10, depth: 50, bars: 4 }; E.getCfg();
    _ambMixMoveTick(E, E.getCfg(), 10); _ambMixMoveTick(E, E.getCfg(), 40);
    o.notSelfTaught = (E.getCfg().layers || []).every((L) => !L.mixSeen);
    // …but a HAND move is remembered, wherever it came from
    const keys = _ambMixerLayers(E.getCfg()).map((x) => x.key);
    _ambSetLayerLevel(E, keys[0], 30); _ambSetLayerLevel(E, keys[0], 88); _ambSetLayerLevel(E, keys[0], 70);
    const L0 = _ambLayerByKey(E, keys[0]);
    o.seen = JSON.stringify(L0.mixSeen);
    const btn = document.querySelector('.ambient-mixmove-learn');
    o.btn = !!btn; if (btn) btn.click();
    const after = _ambLayerByKey(E, keys[0]);
    o.range = JSON.stringify(after.mixRange);
    o.othersLeftAlone = keys.slice(1).every((k) => !(_ambLayerByKey(E, k) || {}).mixRange);
    delete E.getCfg().prog.mixmove; E.getCfg();
    return o;
  });
  console.log('\n  ⤓ From my mixing');
  ok('nothing is remembered before you touch a fader', learn.noneYet);
  ok('…⇅ Mix\'s own movement never widens the range it moves inside', learn.notSelfTaught);
  ok('…a hand move is remembered as the quietest and loudest used',
    learn.seen === '{"lo":30,"hi":88}', learn.seen);
  ok('…and ⤓ turns that into this layer\'s own floor and ceiling',
    learn.btn && learn.range === '{"drop":40,"lift":18}', 'button ' + learn.btn + ', range ' + learn.range);
  ok('…layers you never rode are left following the shared "down to"', learn.othersLeftAlone);

  // ---- ✺ Novelty, and the master ✺ Variation switch ------------------------
  const nov = await page.evaluate(() => {
    const E = _masterEng, o = {};
    const st = (a) => { const s = _ambNovState(); s.amount = a; s.bal = { h: 50, t: 50, f: 50, x: 50, i: 50 }; };
    const amt = () => { const m = E.getCfg().prog.mixmove; return m ? (m.amount | 0) : 0; };
    st(40);
    o.row = _ambNovPlan(E.getCfg(), _ambNovState()).filter((x) => /Mix/.test(x.label))
      .map((x) => ({ live: x.live !== false, to: x.to }))[0] || null;
    _ambNovApply(E, E.getCfg()); E.getCfg(); o.mild = amt();
    st(90); _ambNovApply(E, E.getCfg()); E.getCfg(); o.wild = amt();
    _ambNovCompare(E, E.getCfg()); E.getCfg(); o.compareOff = amt();
    _ambNovCompare(E, E.getCfg()); E.getCfg(); o.compareOn = amt();
    _ambVarBypassSet(E, E.getCfg(), true); E.getCfg(); o.bypassed = amt();
    _ambVarBypassSet(E, E.getCfg(), false); E.getCfg(); o.restored = amt();
    return o;
  });
  console.log('\n  ✺ Novelty');
  ok('the row is live and states what Apply will do', !!nov.row && nov.row.live, JSON.stringify(nov.row));
  ok('…Apply sets it, and a higher dial moves the mix more', nov.mild > 0 && nov.wild > nov.mild,
    nov.mild + ' → ' + nov.wild);
  ok('…the ✺ Novelty on/off switch puts it back exactly',
    nov.compareOff === nov.mild && nov.compareOn === nov.wild, nov.compareOff + ' / ' + nov.compareOn);
  ok('the master ✺ Variation switch bypasses it and restores it',
    nov.bypassed === 0 && nov.restored === nov.wild, nov.bypassed + ' → ' + nov.restored);

  // ---- REACHABLE on the 🌒 Arc card ---------------------------------------
  await page.evaluate(() => { const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click(); });
  await zz(500);
  await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp[data-grp="✺ Variation"] > .ambient-grp-head');
    if (g && !g.parentElement.classList.contains('open')) g.click();
    try { _ambRenderVarBar(_masterEng); } catch (e) {}
  });
  await zz(500);
  const box = await page.evaluate(() => {
    const b = document.querySelector('.ambient-pov-varstrip [data-pov="grp:arc"]');
    if (!b) return null; b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (box) await page.touchscreen.tap(box.x, box.y);
  await zz(800);
  const ui = await page.evaluate(() => {
    const E = _masterEng;
    delete E.getCfg().prog.mixmove; E.getCfg();
    try { _ambSyncControls(E); } catch (e) {}
    const tog = document.querySelector('.ambient-mixmove-toggle');
    if (!tog) return { missing: true };
    tog.scrollIntoView({ block: 'center' });
    const r = tog.getBoundingClientRect();
    // NOT `offsetParent` — null inside the popover's fixed wrapper (documented)
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const o = { w: Math.round(r.width), h: Math.round(r.height),
      reachable: r.width > 20 && r.height > 8 && r.top >= 0 && r.bottom <= innerHeight + 1 && (hit === tog || tog.contains(hit)) };
    o.hiddenWhileOff = document.querySelector('.ambient-mixmove-bars').style.display === 'none';
    tog.click();
    o.onWrites = JSON.stringify(E.getCfg().prog.mixmove);
    const amtEl = document.querySelector('.ambient-mixmove-amt');
    amtEl.value = '65'; amtEl.dispatchEvent(new Event('input', { bubbles: true }));
    const gl = document.querySelector('.ambient-mixmove-glide');
    gl.value = '10'; gl.dispatchEvent(new Event('input', { bubbles: true }));
    o.edited = JSON.stringify(E.getCfg().prog.mixmove);
    document.querySelector('.ambient-mixmove-toggle').click();
    o.offClears = !E.getCfg().prog.mixmove;
    return o;
  });
  console.log('\n  🌒 Arc card — ⇅ Mix');
  ok('the ⇅ Mix switch is reachable on the card', !ui.missing && ui.reachable, JSON.stringify(ui));
  ok('…its controls are hidden while it is off', !!ui.hiddenWhileOff);
  ok('…switching it on seeds a musical middle', /"amount":45/.test(ui.onWrites || ''), ui.onWrites);
  ok('…move and fade edit it', /"amount":65/.test(ui.edited || '') && /"glide":10/.test(ui.edited || ''), ui.edited);
  ok('…and switching it off stores nothing at all', !!ui.offClears);

  // ---- the Mixer says where the mix has taken a fader ----------------------
  const seen = await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms)); const E = _masterEng;
    const host = document.getElementById(E.hostId);
    const faders = host ? host.querySelectorAll('.ambient-mix-slider[data-mixkey]') : [];
    if (!faders.length) return { noStrip: true };
    (E.getCfg().layers || []).forEach((L) => { delete L.mixRange; }); E.getCfg();
    E.getCfg().prog.mixmove = { amount: 95, glide: 5, depth: 60, bars: 2 }; E.getCfg();
    _ambStartGenerator(E); await w(2200);
    const txt = () => [...host.querySelectorAll('.ambient-mix-val')].map((e) => e.textContent).join(' ');
    const marked = () => host.querySelectorAll('.ambient-mix-val.mix-moved').length;
    const o = { during: txt(), markedDuring: marked() };
    _ambStopGenerator(E);
    delete E.getCfg().prog.mixmove; E.getCfg(); await w(900);
    o.after = txt(); o.markedAfter = marked();
    o.set = (E.getCfg().layers || []).map((L) => (Number.isFinite(L.level) ? L.level : 70) + '%').join(' ');
    return o;
  });
  console.log('\n  the Mixer, while it moves');
  if (seen.noStrip) ok('the Mixer value follows the live mix', false, 'no Mixer strip in this view');
  else {
    ok('a moved fader says where the mix has taken it', seen.markedDuring > 0,
      'during: ' + seen.during + ' (marked ' + seen.markedDuring + ')');
    ok('…and it says your own number again once it is off',
      seen.markedAfter === 0 && seen.after === seen.set, 'after: ' + seen.after + ' / set: ' + seen.set);
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
