// PROBE — the drawing must show the notes ▶ Preview actually played.
//
// THE BUG (2026-09-18): `previewLayer` pins `_progAnchor` / `_playStartAt` /
// `_barGridAnchor` to the press so the changes start from the top, and restores
// them in its `finally` — synchronously, before a single note has sounded. Every
// draw after the press then resolved the harmony at the SAME absolute times
// against a different progression origin, so the picture showed the progression
// ROTATED under the same notes: chord tones a third away, and once the span
// folds them, an octave away. `Tone.now()` moves between presses, so the
// rotation moved too. Reported as "notes are moving around and are not
// representing exactly what's playing … chords seem to move octaves in the
// visualizer but playback stays the same".
//
// Temporary: this belongs in test/ui-lifecycle.js (and is there too), which
// cannot run at this branch's HEAD — `.v2-capture` was removed from the card on
// 2026-09-17 and the gate still drives it in eight places.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(600);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = c.querySelector('.ambient-grp[data-v2grp="Content"]');
    const hd = g && g.querySelector('.ambient-grp-head'); if (hd) hd.click();
  });
  await zz(600);

  // D · Em · F♯m · G, a bar each, under a 4-bar live part whose pitches come
  // from the chord — the shape in the report. Every group of three names its
  // chord, so a rotation is legible in the output rather than inferred.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: true, name: 'ANCHOR',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] }] };
    const L = (cfg.layers || [])[0];
    L.part.kind = 'live'; L.part.bars = 4; L.part.notes = [];
    L.part.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    L.part.pitch = { kind: 'chord', span: 12 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(700);

  // MISALIGNED ON PURPOSE. The bug is invisible when the press happens to land
  // a whole number of chord spans from whatever origin the draw falls back to —
  // which it does often enough that one press proves nothing (measured: press 1
  // agreed, press 2 was rotated by one chord). Parking a KNOWN stale anchor a
  // half-chord away makes the disagreement deterministic instead of a coin toss.
  const run = await page.evaluate(async () => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    E._progAnchor = now + 1.0;          // half of a 2 s chord span at 120 bpm
    E._playStartAt = now + 1.0;
    const played = [];
    const orig = window.playNote;
    window.playNote = function (f) {
      if (f > 0) played.push(Math.round(69 + 12 * Math.log2(f / 440)));
      return orig.apply(this, arguments);
    };
    window._v2.preview(E, L());
    window.playNote = orig;
    await new Promise((r) => setTimeout(r, 700));
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 450));
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const drawn = (cv && cv._hits || []).slice().sort((a, b) => a.t - b.t).map((x) => x.midi);
    window._v2.previewKill(E, L());
    delete E._progAnchor; delete E._playStartAt;
    // the picture draws ONE cycle; the emit's window runs a hair past it, so the
    // claim is that the drawing is a PREFIX of what was played, in order
    return { played, drawn, prefix: JSON.stringify(played.slice(0, drawn.length)) === JSON.stringify(drawn) };
  });

  const NAMES = { 60: 'C', 62: 'D', 64: 'E', 65: 'F', 67: 'G', 69: 'A', 71: 'B', 72: 'C' };
  const chord = (a, i) => (NAMES[a[i]] || a[i]) + (NAMES[a[i + 1]] || a[i + 1]) + (NAMES[a[i + 2]] || a[i + 2]);
  const chords = (a) => { const o = []; for (let i = 0; i + 2 < a.length; i += 3) o.push(chord(a, i)); return o.join(' '); };
  console.log('  played: ' + chords(run.played));
  console.log('  drawn : ' + chords(run.drawn));
  ok('the drawing shows the notes the preview played, not the progression rotated',
    run.drawn.length > 0 && run.prefix,
    'played=' + run.played.join(',') + ' drawn=' + run.drawn.join(','));
  // ── CASE B: THE PICTURE MUST NOT JUMP ON THE FIRST PREVIEW PRESS ──────
  // ▶ Preview lands the first note ON the press, so the cycle begins `off`
  // EARLIER — and the pin anchored the changes at `t0`, which put chord 1 that
  // far INTO the part instead of at its top. The stopped drawing aligns the
  // chords with the part's own first pass, so the two disagreed by `off` and
  // the picture JUMPED the first time you pressed Preview. Invisible whenever
  // the first onset is on beat 1 (`off` is 0 and the two coincide), which is
  // why this fixture ROTATES a euclid pattern so the first onset is late.
  // Five chords under a four-bar part, the last a 7th, so a misalignment is a
  // different note COUNT and not only different pitches.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: true, name: 'SEAM',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] },
               { root: 9, intervals: [0, 4, 7, 10] }] };
    const L = (cfg.layers || [])[0];
    L.part.kind = 'live'; L.part.bars = 4; L.part.notes = [];
    L.part.rhythm = { kind: 'euclid', pulses: 7, steps: 16, rotate: 5 };
    L.part.pitch = { kind: 'chord', span: 12, voices: 4 };
    delete E._progAnchor; delete E._playStartAt; delete E._barGridAnchor;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(700);

  // THE CANVAS THE USER IS LOOKING AT. There is more than one `.v2-vizcv` in
  // the document (the card body and the section sheet each carry the drawing),
  // so a bare `querySelector` answers for whichever comes first — and that one
  // can be the stale, hidden copy nothing has redrawn. It cost an hour here:
  // the "after" reading was the "before" draw. Pick by RECT — the reachability
  // rule, applied to reading rather than to tapping.
  const shot = () => page.evaluate(async () => {
    const E = _masterEng;
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 450));
    const all = [...document.querySelectorAll('.v2-vizcv')];
    const cv = all.find((x) => x.offsetParent && x.getBoundingClientRect().height > 10) || all[0];
    return (cv && cv._hits || []).slice().sort((a, b) => a.t - b.t).map((x) => x.midi);
  });
  const seamBefore = await shot();
  const seamPlayed = await page.evaluate(async () => {
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const got = [];
    const orig = window.playNote;
    window.playNote = function (f) {
      if (f > 0) got.push(Math.round(69 + 12 * Math.log2(f / 440)));
      return orig.apply(this, arguments);
    };
    try { window._v2.preview(E, L()); } finally { window.playNote = orig; }
    await new Promise((r) => setTimeout(r, 700));
    return got;
  });
  const seamAfter = await shot();
  await page.evaluate(() => { const E = _masterEng; window._v2.previewKill(E, (E.getCfg().layers || [])[0]); });

  console.log('  before: ' + seamBefore.join(','));
  console.log('  played: ' + seamPlayed.join(','));
  console.log('  after : ' + seamAfter.join(','));
  ok('a preview press does not move the picture — same take, same notes',
    seamBefore.length > 0 && seamBefore.join(',') === seamAfter.join(','),
    'before=' + seamBefore.join(',') + ' after=' + seamAfter.join(','));
  ok('…and the UN-previewed picture already showed what a preview would play',
    seamBefore.length > 0 &&
    seamPlayed.slice(0, seamBefore.length).join(',') === seamBefore.join(','),
    'played=' + seamPlayed.join(',') + ' drawn=' + seamBefore.join(','));

  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
