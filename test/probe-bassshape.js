// PROBE — ◢ PITCH SHAPE on a fixed line (◢ Bass · ▪ One note).
//
// user, 2026-09-27: "we need a Pitch shape as well for Bass in Generate (so play the
// same note for the whole chord, or play all different notes, etc.)".
//
// ◢ Bass was the ONE material with no pitch rule: its four Characters are the same
// recipe (root degree, low) with a different RHYTHM — this file's own comment says so —
// so the note never moved whatever you set. `part.pitch.move` is that rule.
//
//   node test/probe-bassshape.js        (needs `npm start` on :3001)
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
  await zz(500);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(600);
  // the cards are drawn by the panel rebuild, not by the add itself
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);

  console.log('\n  1. reachable — the row is in Generate, under Pitch');
  const ui = await page.evaluate(async () => {
    // MAKE IT A BASS FIRST. The row is gated `pitch:fixed`, so on a default layer it is
    // correctly HIDDEN — measuring it there proves the gate, not the control.
    const L9 = (_masterEng.getCfg().layers || [])[0];
    L9.part.kind = 'live';
    L9.part.pitch = { kind: 'fixed', degree: 1 };
    L9.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0, n: 1 };
    _masterEng.getCfg();
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    const c = document.querySelector('.v2-layer');
    if (!c) return { err: 'no card', layers: ((_masterEng.getCfg().layers) || []).length,
                     host: !!document.getElementById('bloom-v2-layers'),
                     cards: document.querySelectorAll('.v2-layer').length,
                     view: document.body.className };
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-layer-head').click();
    await new Promise((r) => setTimeout(r, 600));
    // THE API, not a guessed door: ✦ Generate opens ⚙ Deep for every part now, and
    // `openGen` is the one opener — clicking a chip that may or may not exist measures a
    // closed panel and calls a working control missing.
    try { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); } catch (e) {}
    await new Promise((r) => setTimeout(r, 800));
    // TWO FOLDS, like every row in this panel: the generate ZONE and the ▸ recipe
    // subsection. Driven, not class-stripped — the head's handler is what opens them.
    // Open every fold in the panel by DRIVING its own control — the zones and the
    // ▸ subsections both hang off `.v2-discbtn`, and stripping the class instead is the
    // documented "that is not expanding it" mistake.
    // THE ZONE IS A BAR ON THE CARD (`.v2-gzbar[data-gz]`), and only the zone whose
    // number the CARD carries as a class is shown — so the row lives behind two folds:
    // its zone, then its ▸ subsection. Both driven by their own control.
    const f0 = document.querySelector('.v2-layer [data-f="part.pitch.move"]');
    const body0 = f0 && f0.closest('.v2-gzbody');
    const gz = body0 && body0.getAttribute('data-gz');
    const bar = gz && document.querySelector('.v2-layer .v2-gzbar[data-gz="' + gz + '"]');
    if (bar) { bar.click(); await new Promise((r) => setTimeout(r, 400)); }
    for (const d of [...document.querySelectorAll('.v2-layer .v2-discbtn')]) {
      d.click(); await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 300));
    const f = document.querySelector('.v2-layer [data-f="part.pitch.move"]');
    if (!f) return { err: 'no Pitch shape row' };
    const r2 = f.getBoundingClientRect();
    const row = f.closest('.ambient-ctrl');
    const kindRow = document.querySelector('.v2-layer [data-f="part.pitch.kind"]');
    const chain = []; let n9 = f;
    while (n9 && n9 !== document.body) { const cs = getComputedStyle(n9);
      if (cs.display === 'none' || cs.visibility === 'hidden' || n9.hidden)
        chain.push((n9.className || n9.tagName) + ':' + cs.display + (n9.hidden ? '/hidden' : ''));
      n9 = n9.parentElement; }
    return { hiddenBy: chain.slice(0, 4), gen: !!document.querySelector('.v2-genwrap'),
             genOpen: !!document.querySelector('.v2-genwrap:not([hidden])'),
             opts: [...f.options].map((o) => o.value), value: f.value,
             w: Math.round(r2.width), on: !!f.offsetParent,
             label: row ? (row.querySelector('label') || {}).textContent : null,
             afterKind: !!(kindRow && row && (kindRow.closest('.ambient-ctrl').compareDocumentPosition(row) & 4)) };
  });
  ok('the Pitch shape row exists and measures', !ui.err && ui.w > 40 && ui.on, JSON.stringify(ui));
  ok('…offering every shape', !ui.err && ui.opts.length === 7 && ui.opts[0] === 'root',
    JSON.stringify(ui.opts));
  ok('…named "Pitch shape", and placed under Pitch',
    !ui.err && /Pitch shape/.test(ui.label || '') && ui.afterKind === true, JSON.stringify([ui.label, ui.afterKind]));


  // A BASS: euclid × fixed degree 1, one bar, sixteenths — four onsets, one per beat,
  // which is what makes "alternating by beat" observable at all.
  const notes = (move) => page.evaluate((mv) => {
    const E = _masterEng, cfg = E.getCfg();
    const L = (cfg.layers || [])[0];
    L.instrument.voice = 'synth';
    L.part.kind = 'live'; L.part.bars = 1; L.part.form = 'roll';
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0, n: 1 };
    L.part.pitch = { kind: 'fixed', degree: 1 };
    if (mv) L.part.pitch.move = mv;
    E.getCfg();
    const L2 = (E.getCfg().layers || [])[0];
    const stored = (L2.part.pitch || {}).move;
    const ns = window._v2.notesFor(L2, { E, cfg: E.getCfg(), key: 'v2:' + L2.id,
      cycleStart: 0, cycleSec: 4 }) || [];
    // A NOTE CARRIES `freq`, NOT `midi` — the emitter builds voices from frequency, so
    // asserting on `n.midi` reads 0 for every note and every shape looks identical.
    const toM = (f) => Math.round(69 + 12 * Math.log2((f || 440) / 440));
    return { stored, midi: ns.map((n) => toM(n.freq)), n: ns.length };
  }, move);

  console.log('\n  2. absent is the root — and stores nothing');
  const root = await notes('');
  ok('a bass with no shape plays ONE pitch under the whole change',
    root.n >= 3 && new Set(root.midi).size === 1, JSON.stringify(root));
  ok('…and the field is absent, so nothing written before this moves a note',
    root.stored === undefined, String(root.stored));

  console.log('\n  3. the shapes actually move the note');
  const fifth = await notes('fifth');
  const up = await notes('up');
  const any = await notes('any');
  const oct = await notes('octave');
  ok('root & fifth alternates between exactly TWO pitches',
    new Set(fifth.midi).size === 2, JSON.stringify(fifth.midi));
  ok('…and the second one is a FIFTH above the root, not whatever entry 2 happens to be',
    (() => { const u = [...new Set(fifth.midi)].sort((a, b) => a - b);
      return u.length === 2 && (u[1] - u[0]) === 7; })(), JSON.stringify(fifth.midi));
  ok('root & octave alternates by twelve',
    (() => { const u = [...new Set(oct.midi)].sort((a, b) => a - b);
      return u.length === 2 && (u[1] - u[0]) === 12; })(), JSON.stringify(oct.midi));
  ok('up the chord plays a DIFFERENT tone on each beat',
    new Set(up.midi).size >= 3, JSON.stringify(up.midi));
  ok('…and it ascends', (() => { const m = up.midi; let asc = 0;
      for (let i = 1; i < m.length; i++) if (m[i] > m[i - 1]) asc++;
      return asc >= m.length - 2; })(), JSON.stringify(up.midi));
  ok('any chord tone moves too', new Set(any.midi).size >= 2, JSON.stringify(any.midi));

  console.log('\n  4. deterministic, and the store is coerced');
  const a1 = await notes('any'), a2 = await notes('any');
  ok('the same take replays the same notes', JSON.stringify(a1.midi) === JSON.stringify(a2.midi),
    JSON.stringify([a1.midi, a2.midi]));
  const bad = await page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.part.pitch.move = 'sideways';                 // not a shape
    const a = ((E.getCfg().layers || [])[0].part.pitch || {}).move;
    (E.getCfg().layers || [])[0].part.pitch.move = 'root';   // the default, spelled out
    const b = ((E.getCfg().layers || [])[0].part.pitch || {}).move;
    return { a, b };
  });
  ok('an unknown shape is dropped, not stored', bad.a === undefined, String(bad.a));
  ok('…and "root" prunes to absent — one representation of the default',
    bad.b === undefined, String(bad.b));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
