// PROBE — ⏻ FIXED is a MODE the user sets, and it actually pins.
//
// "the FIXED/VARIED setting is still hard to reason about … let's just add a
// brute force toggle for the user to make the content FIXED, otherwise it's
// always VARIED" — and, from the screenshot, "I never chose it to be FIXED".
//
// Nobody did: FIXED used to be the ZERO CASE of a computation over ~15
// settings, so a freshly generated layer read FIXED with nothing set. It could
// also be FALSE (measured elsewhere: a "FIXED" part re-pitching every pass
// because its cycle did not divide the changes). A verdict assembled from
// fifteen inputs is unreasonable to reason about AND can be wrong; a mode
// cannot be wrong, because the engine enforces it.
//
// WHAT IS PINNED HERE: the default is VARIES, the toggle is the only source of
// FIXED, it outranks every per-pass draw AND the take clock, it destroys
// nothing, and it does not stop the layer following the changes.
//
//   node test/probe-fixed.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] },
                       { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);
  await page.evaluate(() => { const c = document.querySelector('.v2-layer'); if (c) {
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); } });
  await zz(500);

  const r = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0], p = L.part;
    p.kind = 'live'; p.bars = 3; p.notes = [];
    p.rhythm = { kind: 'euclid', steps: 12, pulses: 9, rotate: 0, n: 1 };
    p.pitch = { kind: 'walk', voices: 1, degree: 1, span: 4, home: 'center', dir: 'up' };
    delete p.vary; delete L.chg; delete L.fixed; delete p.clock; delete p.ms;
    E.getCfg();
    const word = () => { try { const lv = window._v2.liveness(L, E.getCfg());
      return lv.state; } catch (e) { return 'err'; } };
    // eight passes of what actually plays
    const passes = (n) => {
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const cyc = 6, out = [];
      for (let i = 0; i < n; i++) {
        const ns = window._v2.withEdit(() => window._v2.notesFor(L,
          { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: i * cyc, cycleSec: cyc })) || [];
        out.push(ns.map((x) => Math.round(69 + 12 * Math.log2((x.freq || 440) / 440)) +
          '@' + Math.round((x.at - i * cyc) * 1000)).join(' '));
      }
      return out;
    };
    const out = {};
    out.freshWord = word();

    // EVOLVE ON — the layer genuinely changes pass to pass
    L.chg = { ev: 1, am: 100 }; E.getCfg();
    out.evolveWord = word();
    out.evolveDistinct = new Set(passes(8)).size;

    // …now FIX it. The take must stop moving.
    L.fixed = 1; E.getCfg();
    out.fixedWord = word();
    out.fixedDistinct = new Set(passes(8)).size;
    out.chgKept = JSON.parse(JSON.stringify(L.chg || null));

    // the performance draws are outranked, not erased
    L.humanize = 40; L.velVar = 50; L.accent = 60; L.motion = 30;
    L.slide = 25; L.ornament = 20; E.getCfg();
    out.fixedWithDice = word();
    out.fixedDiceDistinct = new Set(passes(8)).size;
    let shim = null;
    try { shim = window._v2.adsrShim ? window._v2.adsrShim(L) : null; } catch (e) {}
    out.storedDice = { humanize: L.humanize, velVar: L.velVar, accent: L.accent,
                       motion: L.motion, slide: L.slide, ornament: L.ornament };

    // …and turning it OFF hands everything straight back
    delete L.fixed; E.getCfg();
    out.offWord = word();
    out.offDistinct = new Set(passes(8)).size;
    out.diceAfterOff = { humanize: L.humanize, velVar: L.velVar, accent: L.accent,
                         motion: L.motion, slide: L.slide, ornament: L.ornament };

    // FIXED still follows the changes — the pitches track the chord
    L.fixed = 1; delete L.chg; E.getCfg();
    const oneCycle = window._v2.withEdit(() => window._v2.notesFor(L,
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 })) || [];
    const pcs = (lo, hi) => [...new Set(oneCycle
      .filter((x) => (x.at >= lo && x.at < hi))
      .map((x) => Math.round(69 + 12 * Math.log2((x.freq || 440) / 440)) % 12))].sort((a, b) => a - b).join(',');
    out.bar1 = pcs(0, 2); out.bar2 = pcs(2, 4); out.bar3 = pcs(4, 6);

    // nothing stored when off
    delete L.fixed; E.getCfg();
    out.storedWhenOff = L.fixed === undefined;
    return out;
  });

  console.log('\n  a freshly generated layer, nothing set:\n');
  ok('reads VARIES, not FIXED — nobody chose anything',
    r.freshWord === 'varies', 'got ' + r.freshWord);
  ok('⟳ Evolve still reads EVOLVES and genuinely changes pass to pass',
    r.evolveWord === 'evolves' && r.evolveDistinct > 1,
    r.evolveWord + ', ' + r.evolveDistinct + ' distinct passes');

  console.log('\n  ⏻ Fixed on:\n');
  ok('the badge says FIXED because you said so',
    r.fixedWord === 'fixed', 'got ' + r.fixedWord);
  ok('…and the take stops moving — one note set across 8 passes',
    r.fixedDistinct === 1, r.fixedDistinct + ' distinct passes');
  ok('…with Evolve OUTRANKED, not erased — chg is kept verbatim',
    r.chgKept && r.chgKept.ev === 1 && r.chgKept.am === 100, JSON.stringify(r.chgKept));
  ok('…and every per-pass die is outranked too — still one note set',
    r.fixedWithDice === 'fixed' && r.fixedDiceDistinct === 1,
    r.fixedWithDice + ', ' + r.fixedDiceDistinct + ' distinct passes');
  ok('…while their stored values survive untouched',
    r.storedDice.humanize === 40 && r.storedDice.velVar === 50 && r.storedDice.accent === 60 &&
    r.storedDice.motion === 30 && r.storedDice.slide === 25 && r.storedDice.ornament === 20,
    JSON.stringify(r.storedDice));

  console.log('\n  ⏻ Fixed off again:\n');
  ok('the layer is handed straight back — it varies again',
    r.offWord !== 'fixed' && r.offDistinct > 1,
    r.offWord + ', ' + r.offDistinct + ' distinct passes');
  ok('…with every die exactly where it was',
    JSON.stringify(r.diceAfterOff) === JSON.stringify(r.storedDice), JSON.stringify(r.diceAfterOff));
  ok('absent by default — off stores nothing at all', r.storedWhenOff);

  console.log('\n  and FIXED still follows the changes (D · F♯m · G, one per bar):\n');
  console.log('      bar 1 pcs: ' + r.bar1 + '   bar 2: ' + r.bar2 + '   bar 3: ' + r.bar3);
  ok('the pitches track the chord — FIXED pins the dice, not the song',
    r.bar1 !== r.bar2 || r.bar2 !== r.bar3,
    r.bar1 + ' / ' + r.bar2 + ' / ' + r.bar3);

  // ── THE BUTTON ────────────────────────────────────────────────────────
  await page.evaluate(() => { const L = (_masterEng.getCfg().layers || [])[0];
    delete L.fixed; _masterEng.getCfg(); _ambRebuildMaster(); });
  await zz(900);
  await page.evaluate(() => { const c = document.querySelector('.v2-layer'); if (c) {
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); } });
  await zz(500);
  const ui = await page.evaluate(() => {
    const b = document.querySelector('.v2-fixtog');
    if (!b) return { err: 'no toggle' };
    const r2 = b.getBoundingClientRect();
    const box = { w: Math.round(r2.width), h: Math.round(r2.height), on: !!b.offsetParent };
    const L = () => (_masterEng.getCfg().layers || [])[0];
    const before = { face: b.textContent.trim(), fixed: !!L().fixed };
    b.click();
    const after = { face: document.querySelector('.v2-fixtog').textContent.trim(), fixed: !!L().fixed };
    const evo = document.querySelector('.v2-evotog');
    const greyed = !!(evo && evo.classList.contains('v2-outranked'));
    document.querySelector('.v2-fixtog').click();
    const back = { face: document.querySelector('.v2-fixtog').textContent.trim(), fixed: !!L().fixed };
    return { box, before, after, back, greyed };
  });
  console.log('\n  the toggle on the card:\n');
  ok('⏻ Fixed is REACHABLE — real box, real offsetParent',
    ui.box && ui.box.on && ui.box.w > 40 && ui.box.h > 10, JSON.stringify(ui));
  ok('…a press turns it on and the face says which state it is in',
    ui.before && !ui.before.fixed && ui.after.fixed && /Fixed/.test(ui.after.face) &&
    ui.after.face !== ui.before.face,
    JSON.stringify({ before: ui.before, after: ui.after }));
  ok('…⟳ Evolve greys beside it rather than vanishing', ui.greyed);
  ok('…and pressing again hands it back', ui.back && !ui.back.fixed &&
    ui.back.face === ui.before.face, JSON.stringify(ui.back));

  // ── \u2744 AND FROZEN SAYS WHY ───────────────────────────────────────────
  const fr = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    const txt = () => { try { return window._v2.liveTxt ? window._v2.liveTxt(L, E.getCfg())
      : (document.querySelector('.v2-vizlab') || {}).textContent || ''; } catch (e) { return 'err'; } };
    const out = {};
    // a gesture-frozen part carries its reason
    L.part.kind = 'live'; L.part.notes = []; delete L.part.froze; delete L.fixed;
    E.getCfg();
    try { window._v2.capture(E, L, {}); } catch (e) {}
    L.part.froze = 'drag'; E.getCfg();
    out.drag = (document.querySelector('.v2-vizlab') || {}).textContent || '';
    out.stored = L.part.froze;
    // an unknown reason is dropped rather than printed
    L.part.froze = 'nonsense'; E.getCfg();
    out.bogus = L.part.froze === undefined;
    // …and a reason does not survive going live again
    L.part.froze = 'drag'; L.part.kind = 'live'; E.getCfg();
    out.clearedOnRelease = L.part.froze === undefined;
    return out;
  });
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);
  const shown = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = []; delete L.part.froze;
    E.getCfg();
    try { window._v2.capture(E, L, {}); } catch (e) {}
    L.part.froze = 'note'; E.getCfg();
    _ambRebuildMaster();
    const c = document.querySelector('.v2-layer');
    if (c) { c.classList.remove('collapsed'); c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); }
    return ((document.querySelector('.v2-vizlab') || {}).textContent || '').replace(/\s+/g, ' ').trim();
  });
  console.log('\n  \u2744 the frozen readout:\n');
  console.log('      ' + shown.slice(0, 110));
  ok('FROZEN names the gesture that froze it',
    /froze when you tapped a note to edit/.test(shown), shown.slice(0, 140));
  ok('\u2026an unknown reason is dropped, never printed', fr.bogus);
  ok('\u2026and the reason does not outlive the state', fr.clearedOnRelease);

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
