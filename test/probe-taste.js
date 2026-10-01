// PROBE — ✺ TASTE: 🎲 SURPRISE ME LEARNS WHAT YOU KEEP.
//
// The roll samples from HARDCODED priors (a macro engages at 0.7 into 10..60, a sparse
// die at 0.4 into 5..cap). Those constants exist because i.i.d. randomness has no
// structure, so the only way to keep a roll playable was to keep it timid. The signal is
// already recorded: you roll until you like something and press ✓ Done, so every roll you
// move past is an implicit reject and the kept one is a positive.
//
// The claims:
//   · on = 0 IGNORES everything learned  — the shipped roll, whatever the model holds
//   · on > 0 actually steers the roll     — same seed, different draw
//   · keeps raise engagement and pull the value; rejects lower engagement only
//   · ✓ Done / ✕ Cancel label the pending roll
//   · the control and ↺ Forget are reachable
//
//   node test/probe-taste.js        (needs `npm start` on :3001)
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
  await zz(1200);

  console.log('\n  ✺ the learning rule');
  const rule = await page.evaluate(() => {
    bloopsTaste = { on: 0, ax: {} };
    const ax = () => JSON.parse(JSON.stringify(bloopsTaste.ax));
    // a player who keeps Flourishes ON and high
    for (let i = 0; i < 25; i++) window._v2.tasteObserve({ 'm:fl': 52 }, true);
    const kept = ax()['m:fl'];
    // …and one who keeps it OFF
    bloopsTaste.ax = {};
    for (let i = 0; i < 25; i++) window._v2.tasteObserve({ 'm:fl': 0 }, true);
    const keptOff = ax()['m:fl'];
    // rejects move ENGAGEMENT only — never the value
    bloopsTaste.ax = {};
    window._v2.tasteObserve({ 'm:fl': 52 }, true);
    const before = ax()['m:fl'];
    for (let i = 0; i < 15; i++) window._v2.tasteObserve({ 'm:fl': 52 }, false);
    const after = ax()['m:fl'];
    const spec = window._v2.tasteSpec();
    bloopsTaste = { on: 0, ax: {} };
    return { kept, keptOff, before, after, specKeys: Object.keys(spec).length, keys: Object.keys(spec),
             hasMacros: !!(spec['m:fl'] && spec['m:ls'] && spec['m:th']),
             noPass: !Object.keys(spec).some((k) => k.indexOf('p:') === 0) };
  });
  ok('keeping it ON and high raises engagement and pulls the value up',
    rule.kept.p > 0.85 && rule.kept.m > 48, JSON.stringify(rule.kept));
  ok('keeping it OFF drops engagement toward the floor',
    rule.keptOff.p < 0.15, JSON.stringify(rule.keptOff));
  ok('rejects lower ENGAGEMENT…', rule.after.p < rule.before.p,
    JSON.stringify([rule.before.p, rule.after.p]));
  ok('…and leave the VALUE alone — a reject says "not this often", not "wrong value"',
    Math.abs(rule.after.m - rule.before.m) < 1e-9, JSON.stringify([rule.before.m, rule.after.m]));
  ok('the model covers the three macros and the three dice no macro carries',
    rule.hasMacros && rule.specKeys === 6 &&
    JSON.stringify(rule.keys) === JSON.stringify(['m:fl', 'm:ls', 'm:th',
      't:part.pitch.randomness', 't:part.pitch.drift', 't:part.rhythm.vary']),
    JSON.stringify(rule.keys));
  ok('…and NOT the pass dice — they re-roll, so ✓ Done never judged them',
    rule.noPass === true, JSON.stringify(rule.noPass));

  // ── the real door ────────────────────────────────────────────────────────
  console.log('\n  ✺ the roll it steers');
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer'); if (b) b.click(); });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(1000);
  const opened = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // THE DICE ROWS ARE GATED `kind:live`. A layer with no material yet measures 0×0
    // for both the roll and Taste, and a click on a gated row does nothing at all —
    // which reads as "the model does not steer" when nothing was ever rolled.
    const E = _masterEng; const L = E.getCfg().layers[0];
    L.part.kind = 'live';
    L.part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(500);
    const cd0 = document.querySelector('.v2-layer'); if (!cd0) return { err: 'no card' };
    cd0.classList.remove('collapsed'); await wait(300);
    // THE DICE ROWS LIVE IN \u2699 DEEP. Their chain is
    // `.v2-gzbody` \u2192 `.v2-genrows` \u2192 `.v2-genpop` \u2192 `.v2-genwrap`, and `.v2-genwrap`
    // is display:none until the panel is open — so without opening it the roll button
    // is present, 0\u00d70 and permanently inert, and only the DOCUMENT-level delegation
    // made a `.click()` do anything at all. Open the real door.
    window._v2.openGen(_masterEng, _masterEng.getCfg().layers[0]);
    await wait(700);
    let btn = document.querySelector('.v2-genwrap .v2-dall[data-da="take:rand"]')
           || document.querySelector('.v2-dall[data-da="take:rand"]');
    // …and the ZONE it sits in may still be folded. Open ITS OWN zone, by number:
    // \u2699 Deep is `.v2-gzbar[data-gz=N]` \u2192 `.v2-gzbody[data-gz=N]`, and clicking
    // "whatever button is in the zone" hits \u21ba All to default, which zeroes every die
    // \u2014 measured, and it reads exactly like a roll that did nothing.
    const vis = (el) => !!(el && el.offsetParent && el.getBoundingClientRect().height > 8);
    if (!vis(btn)) {
      const body = btn ? btn.closest('.v2-gzbody') : null;
      const gz = body ? body.getAttribute('data-gz') : null;
      const bar = gz ? document.querySelector('.v2-gzbar[data-gz="' + gz + '"]') : null;
      if (bar) { bar.click(); await wait(500); }
      btn = document.querySelector('.v2-dall[data-da="take:rand"]');
    }
    const r = btn ? btn.getBoundingClientRect() : null;
    return { found: !!btn,
             live: !!(btn && btn.offsetParent && r.width > 20 && r.height > 14) };
  });
  ok('the 🎲 take-dice row is reachable AND live, measured',
    opened.found === true && opened.live === true, JSON.stringify(opened));

  const roll = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const FIELDS = ['restProb', 'ghosts', 'lenVary', 'startVary', 'twist', 'phrasing',
                    'part.pitch.randomness', 'part.pitch.drift', 'part.rhythm.vary', 'part.rhythm.rateVar'];
    const gp = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    // READ THE STAGED COPY. \u2699 Deep opens a DRAFT, so \ud83c\udfb2 Surprise me writes to the
    // staged layer and `cfg.layers[0]` correctly stays untouched until \u2713 Done — which
    // is the whole point of the keep signal. Reading the real layer shows zeros for
    // ever and looks exactly like a roll that never happened.
    const L = () => {
      const id = _masterEng.getCfg().layers[0].id | 0;
      return window._v2.stagedOf(id) || _masterEng.getCfg().layers[0];
    };
    const read = () => FIELDS.map((f) => Math.round((gp(L(), f) | 0)));
    const real = Math.random;
    const seed = () => { let z = 987654321; Math.random = () => { z = (z * 1664525 + 1013904223) >>> 0; return z / 4294967296; }; };
    // RE-QUERY EVERY TIME. The roll handler calls `V2.render(E)`, which REBUILDS the
    // card — a reference captured before the first roll is detached afterwards, and
    // clicking a detached node does nothing at all. That reads as "the model does not
    // steer" while it is really "nothing was rolled", and it passes the same-draw
    // check trivially. Measured: rolls 2 and 3 were silent.
    const doRoll = async () => {
      seed();
      const b = document.querySelector('.v2-dall[data-da="take:rand"]');
      if (!b) return ['NO BUTTON'];
      b.click(); await wait(300); return read();
    };

    bloopsTaste = { on: 0, ax: {} };
    // AN EQUALITY CHECK IS SATISFIED BY ABSENCE. Twice now "same seed, same draw"
    // passed because nothing was rolled at all — once with the row gated, once with a
    // stale button reference. So prove the roll MOVED something before comparing.
    const pre = read();
    const a = await doRoll();
    const moved = JSON.stringify(pre) !== JSON.stringify(a);
    // TEACH IT HARD, then roll again with on STILL 0 — it must not have listened
    for (let i = 0; i < 30; i++) {
      window._v2.tasteObserve({ 'm:fl': 58, 'm:ls': 58, 'm:th': 58,
        't:part.pitch.randomness': 38, 't:part.pitch.drift': 28,
        't:part.rhythm.vary': 43, 't:part.rhythm.rateVar': 28 }, true);
    }
    const b = await doRoll();
    // …now let it listen
    bloopsTaste.on = 100;
    const c = await doRoll();
    Math.random = real;
    const taught = JSON.parse(JSON.stringify(bloopsTaste.ax));
    return { a, b, c, moved, taughtFl: taught['m:fl'] };
  });
  ok('the roll actually rolled — the comparisons below rest on something',
    roll.moved === true, JSON.stringify([roll.a]));
  ok('at 0 the roll IGNORES everything learned — same seed, same draw',
    JSON.stringify(roll.a) === JSON.stringify(roll.b),
    JSON.stringify([roll.a, roll.b]));
  ok('…and turning it up actually steers the roll',
    JSON.stringify(roll.c) !== JSON.stringify(roll.a),
    JSON.stringify([roll.a, roll.c]));
  ok('…having genuinely learned the taught axis',
    roll.taughtFl && roll.taughtFl.p > 0.85 && roll.taughtFl.m > 52, JSON.stringify(roll.taughtFl));

  console.log('\n  ✺ ✓ Done is the label');
  const label = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    bloopsTaste = { on: 50, ax: {} };
    const id = _masterEng.getCfg().layers[0].id | 0;
    document.querySelector('.v2-dall[data-da="take:rand"]').click();
    await wait(260);
    const before = Object.keys(bloopsTaste.ax).length;
    const kept = window._v2._tasteKeep(id, true);      // ✓ Done
    const again = window._v2._tasteKeep(id, true);     // nothing pending now
    return { before, kept, again, after: Object.keys(bloopsTaste.ax).length };
  });
  ok('a roll leaves a pending vector that ✓ Done labels', label.kept === true, JSON.stringify(label));
  ok('…and it is consumed once, not every time', label.again === false, JSON.stringify(label.again));

  console.log('\n  ✺ the control');
  const ui = await page.evaluate(() => {
    const sl = document.querySelector('.v2-taste');
    const fg = document.querySelector('.v2-tasteforget');
    // if it is hidden, say WHAT is hiding it — the chain is the answer, not the rect
    const chain = (() => { const out = []; let n = sl;
      while (n && n !== document.body) { const cs = getComputedStyle(n);
        out.push({ c: (n.className || '').toString().slice(0, 40), d: cs.display, v: cs.visibility,
                   h: Math.round(n.getBoundingClientRect().height) });
        n = n.parentElement; } return out; })();
    const r = sl ? sl.getBoundingClientRect() : null;
    const fr = fg ? fg.getBoundingClientRect() : null;
    return { sl: !!sl, fg: !!fg,
             slReach: !!(sl && sl.offsetParent && r.width > 40 && r.height > 10),
             fgReach: !!(fg && fg.offsetParent && fr.width > 40 && fr.height > 14),
             hint: (document.querySelector('.v2-tastehint') || {}).textContent || '',
             chain: chain.slice(0, 6) };
  });
  ok('the Taste control is reachable, measured', ui.slReach === true, JSON.stringify(ui));
  ok('…↺ Forget beside it', ui.fgReach === true, JSON.stringify(ui.fgReach));
  const forgot = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.v2-tasteforget').click(); await wait(400);
    return { n: Object.keys(bloopsTaste.ax || {}).length, on: bloopsTaste.on };
  });
  ok('↺ Forget clears what it learned but keeps the strength',
    forgot.n === 0 && forgot.on === 50, JSON.stringify(forgot));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
