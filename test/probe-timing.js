// PROBE — ⏱ TIMING: swing · lean · odds · ratchet.
//
// "we need better onset characterization; i.e. more/better stochastic controls
// around determining exactly when notes fire, something musical and rhythmic."
//
// THE POINT OF THE STAGE IS THAT IT IS IN THE SEAM. `notesFor` is what the
// emitter, the drawing, the outlines, ⚙ Deep's preview and capture all call, so
// a control that moves an onset has to live there or the picture cannot show
// it. Swing used to be applied in the emit loop: measured, swing 100 delayed
// every odd slot by 125 ms while `notesFor` returned 0·250·500·750 unchanged,
// which is why a shuffling layer drew straight 8ths.
//
//   node test/probe-timing.js        (needs `npm start` on :3001)
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
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);

  const r = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0], p = L.part;
    // EIGHT EVEN ONSETS over a 2 s cycle — slot 250 ms, so every number below
    // is readable by eye.
    p.kind = 'live'; p.bars = 1; p.notes = []; delete p.vary; delete L.chg;
    p.rhythm = { kind: 'euclid', steps: 8, pulses: 8, rotate: 0, n: 1 };
    p.pitch = { kind: 'walk', voices: 1, degree: 1, span: 4, home: 'center', dir: 'up' };
    p.shape = { lenRatio: 60 };
    delete p.clock; delete p.ms; delete L.tight;
    E.getCfg(); E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const ask = () => (window._v2.withEdit(() => window._v2.notesFor(L,
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 2 })) || [])
      .map((n) => ({ at: Math.round(n.at * 1000), d: Math.round(n.durMs) }))
      .sort((x, y) => x.at - y.at);
    const ats = () => ask().map((x) => x.at);

    const out = {};
    delete L.swing; delete p.timing; E.getCfg();
    out.plain = ats();

    // SWING — every odd slot delayed, and it must show HERE
    L.swing = 100; E.getCfg();
    out.swing100 = ats();
    L.swing = 50; E.getCfg();
    out.swing50 = ats();

    // …ON A CHOSEN SUBDIVISION rather than the part's own grid. Measured on a
    // SIXTEEN-onset part, because on an 8-onset one a 16th-note swing grid
    // correctly does nothing (every onset lands on an even 16th) — so the
    // first version of this check passed without proving anything.
    p.rhythm = { kind: 'euclid', steps: 16, pulses: 16, rotate: 0, n: 1 };
    L.swing = 100; delete p.timing; E.getCfg();
    out.wideOwnGrid = ats();                // its own grid IS 16ths
    p.timing = { swingDiv: 8 }; E.getCfg();
    out.wideDiv8 = ats();                   // pairs counted in 8ths instead
    p.timing = { swingDiv: 16 }; E.getCfg();
    out.wideDiv16 = ats();
    delete L.swing; delete p.timing;
    p.rhythm = { kind: 'euclid', steps: 8, pulses: 8, rotate: 0, n: 1 };
    E.getCfg();

    // LEAN — the whole part behind (or ahead of) the beat, no scatter
    p.timing = { lean: 30 }; E.getCfg();
    out.leanLate = ats();
    p.timing = { lean: -20 }; E.getCfg();
    out.leanEarly = ats();

    // ODDS — a per-step probability; 0 is a step that never plays
    p.timing = { odds: { 1: 0, 3: 0, 5: 0, 7: 0 } }; E.getCfg();
    out.oddsOff = ats();
    out.oddsStored = JSON.parse(JSON.stringify(p.timing.odds || {}));
    // …and 100 is stored as ABSENT, so "plays" costs nothing
    p.timing = { odds: { 2: 100 } }; E.getCfg();
    out.odds100 = p.timing ? (p.timing.odds || null) : null;

    // RATCHET — one onset becomes N fast hits of the same note
    p.timing = { ratchet: { chance: 100, hits: 3, spread: 'even' } }; E.getCfg();
    const rt = ask();
    out.ratchetN = rt.length;
    out.ratchetFirst = rt.slice(0, 3).map((x) => x.at + '/' + x.d);
    p.timing = { ratchet: { chance: 0, hits: 3 } }; E.getCfg();
    out.ratchetOffStored = p.timing ? (p.timing.ratchet || null) : null;

    // REPEATABLE — the same take rolls the same ratchets every time
    p.timing = { ratchet: { chance: 50, hits: 4, spread: 'accel' } }; E.getCfg();
    out.rep = [ats().join(','), ats().join(','), ats().join(',')];

    // ABSENT BY DEFAULT — nothing stored, nothing changed
    delete p.timing; delete L.swing; E.getCfg();
    out.clean = ats();
    out.storedAfter = p.timing === undefined;
    return out;
  });

  console.log('\n  8 even onsets over a 2 s cycle — slot 250 ms\n');
  console.log('   plain        ' + r.plain.join(', '));
  console.log('   swing 100    ' + r.swing100.join(', '));
  console.log('   swing 50     ' + r.swing50.join(', '));
  console.log('\n   16 onsets, 125 ms apart:');
  console.log('   swing, own grid (16ths)  ' + r.wideOwnGrid.slice(0, 6).join(', ') + ' …');
  console.log('   swing, swingDiv 8        ' + r.wideDiv8.slice(0, 6).join(', ') + ' …');
  console.log('   swing, swingDiv 16       ' + r.wideDiv16.slice(0, 6).join(', ') + ' …\n');
  console.log('   lean +30     ' + r.leanLate.join(', '));
  console.log('   lean -20     ' + r.leanEarly.join(', '));
  console.log('   odds off 1357 ' + r.oddsOff.join(', '));
  console.log('   ratchet x3   ' + r.ratchetN + ' notes; first three ' + r.ratchetFirst.join('  '));

  ok('swing MOVES the notes notesFor returns — the picture can show it',
    JSON.stringify(r.plain) !== JSON.stringify(r.swing100), r.swing100.join(','));
  ok('…and it delays the ODD slots only, by half a slot at 100',
    r.swing100[0] === 0 && r.swing100[1] === 375 && r.swing100[2] === 500 && r.swing100[3] === 875,
    r.swing100.join(','));
  ok('…proportionally: 50 is half of 100',
    r.swing50[1] === 313 || r.swing50[1] === 312, r.swing50.join(','));
  ok('…and swingDiv counts the pairs on ITS grid, not the part’s',
    r.wideDiv16[1] === 188 && r.wideDiv16[2] === 250 &&
    r.wideDiv8[1] === 188 && r.wideDiv8[2] === 375 &&
    new Set(r.wideDiv8).size === r.wideDiv8.length &&
    new Set(r.wideDiv16).size === r.wideDiv16.length,
    '16ths: ' + r.wideDiv16.slice(0, 5).join(',') +
    '\n      8ths:  ' + r.wideDiv8.slice(0, 5).join(',') +
    '\n      own:   ' + r.wideOwnGrid.slice(0, 5).join(','));
  ok('lean moves the WHOLE part late, evenly — a lean is not a scatter',
    r.leanLate.every((v, i) => i === 0 ? v === 30 : v - r.plain[i] === 30), r.leanLate.join(','));
  ok('…and early, clamped to the start of the cycle',
    r.leanEarly[1] === r.plain[1] - 20 && r.leanEarly[0] === 0, r.leanEarly.join(','));
  ok('odds 0 silences exactly those steps and leaves the rest alone',
    JSON.stringify(r.oddsOff) === JSON.stringify([0, 500, 1000, 1500]), r.oddsOff.join(','));
  ok('…and 100 is stored as ABSENT — "it plays" costs nothing',
    r.odds100 === null, JSON.stringify(r.odds100));
  ok('a ratchet turns one onset into its hits — 8 onsets x3 = 24',
    r.ratchetN === 24, r.ratchetN + ' notes');
  ok('…and a 0 chance stores nothing at all',
    r.ratchetOffStored === null, JSON.stringify(r.ratchetOffStored));
  ok('the same take ratchets the same way every ask — seeded, so it draws',
    r.rep[0] === r.rep[1] && r.rep[1] === r.rep[2]);
  ok('absent by default: with Timing cleared the part is byte-identical again',
    JSON.stringify(r.clean) === JSON.stringify(r.plain) && r.storedAfter,
    r.clean.join(','));

  // ── AND THE UI IS REACHABLE (CLAUDE.md rule 7) ───────────────────────
  // A querySelector hit proves nothing: measure the rect and `offsetParent` in
  // the view the user has open, then drive it and read the config back.
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    L.part.kind = 'live';
    L.part.rhythm = { kind: 'euclid', steps: 8, pulses: 5, rotate: 0, n: 1 };
    delete L.part.timing; _masterEng.getCfg();
  });
  await zz(300);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer'); if (!c) return;
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    c.querySelectorAll('.v2-rowoff').forEach((e) => e.classList.remove('v2-rowoff'));
    c.querySelectorAll('[data-v2tab]').forEach((e) => { e.hidden = false; });
  });
  await zz(600);
  const ui = await page.evaluate(() => {
    const box = (sel2) => { const el = document.querySelector(sel2); if (!el) return null;
      const r2 = el.getBoundingClientRect();
      return { w: Math.round(r2.width), h: Math.round(r2.height), on: !!el.offsetParent }; };
    const set = (f, v) => { const el = document.querySelector('[data-f="' + f + '"]');
      if (!el) return false; el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const out = { boxes: {} };
    ['part.timing.swingDiv', 'part.timing.lean', 'part.timing.ratchet.chance',
     'part.timing.ratchet.hits', 'part.timing.ratchet.spread'].forEach((f) => {
      out.boxes[f] = box('[data-f="' + f + '"]');
    });
    out.boxes['odds cell'] = box('.v2-odd');
    // the lane must not push past its row — no horizontal scrolling, ever
    const lane = document.querySelector('.v2-oddslane');
    const par = lane && lane.parentElement;
    out.overflows = !!(lane && par &&
      (lane.getBoundingClientRect().right > par.getBoundingClientRect().right + 1 ||
       lane.scrollWidth > lane.clientWidth + 1));
    set('part.timing.swingDiv', 16); set('part.timing.lean', -25);
    set('part.timing.ratchet.chance', 40); set('part.timing.ratchet.hits', 3);
    set('part.timing.ratchet.spread', 'accel');
    // the lane must survive its own repaint — tap the SAME node six times
    const cell = document.querySelectorAll('.v2-odd')[2];
    const seq = [];
    const Lv = () => (_masterEng.getCfg().layers || [])[0];
    for (let k = 0; k < 6; k++) {
      if (cell) cell.click();
      const t2 = Lv().part.timing;
      seq.push((t2 && t2.odds && t2.odds['2'] !== undefined) ? t2.odds['2'] : 100);
    }
    out.taps = seq;
    out.stored = JSON.parse(JSON.stringify(Lv().part.timing || null));
    return out;
  });
  const allOn = Object.keys(ui.boxes).every((k) => ui.boxes[k] && ui.boxes[k].on &&
    ui.boxes[k].w > 8 && ui.boxes[k].h > 8);
  ok('every \u23f1 Timing control is REACHABLE — real box, real offsetParent',
    allOn, JSON.stringify(ui.boxes));
  ok('\u2026and the Odds lane never scrolls sideways',
    !ui.overflows, 'lane overflows its row');
  ok('driving them writes the config, with a <select> coerced to a NUMBER',
    ui.stored && ui.stored.swingDiv === 16 && ui.stored.lean === -25 &&
    ui.stored.ratchet && ui.stored.ratchet.hits === 3 && ui.stored.ratchet.spread === 'accel',
    JSON.stringify(ui.stored));
  ok('\u2026and the lane survives its own repaint \u2014 six taps, six steps',
    JSON.stringify(ui.taps) === JSON.stringify([75, 50, 25, 0, 100, 75]),
    JSON.stringify(ui.taps));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
