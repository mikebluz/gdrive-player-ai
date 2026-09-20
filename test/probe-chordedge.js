// PROBE — A NOTE THAT BEGINS ON A CHANGE BELONGS TO THAT CHANGE.
//
// Reported from a FROZEN FIXED take, 24 notes in 6 onsets, 3 bars, D·F#m·G:
// "preview press still causing first note of third change (fifth onset) to
// change back and forth … looks like 1 half step". Read off the screenshots,
// bar 3 onset 1 drew F#5·A4·F#4·C#4 (= F#m, the PREVIOUS chord) in one state
// and G5·B4·G4·D4 (= G) in the other.
//
// CAUSE. The harmony resolver answers by differencing an ABSOLUTE onset
// (`cycleStart + offset`) against an absolute anchor. For an onset sitting
// EXACTLY on a change that is a subtraction of two large, nearly equal
// doubles, and it is not always exact:
//     (0.4392 + 4) - 0.4392  ===  3.9999999999999996
// — below the boundary, so the PREVIOUS chord wins. 516 of 4000 plausible
// cycle starts lose it this way. At cycleStart 0 (the stopped drawing) it is
// exact, which is why the picture flipped between stopped and previewing, and
// between presses. NOT a `(2/3)*6` rounding error — that product is exactly
// 4.0; the loss is in the big-number subtraction, which is why it needs a wall
// clock to show at all.
//
// FIX: every "which change is sounding at this onset" asks through `chgTime()`
// — one named 0.1 ms nudge, a thousand times below anything audible and a
// thousand billion times above the error.
//
// WHY A SWEEP AND NOT PREVIEW PRESSES. Driving the real button is a lottery:
// a press lands on a bad cycle start about one time in eight, so a run can go
// green with the fix reverted (it did). This pins the invariant instead — with
// the anchors pinned to the cycle start, the layer's cycle begins exactly at
// the progression's origin, so EVERY cycle start must harmonise identically.
// The ladder is fixed, so the check is deterministic.
//
//   node test/probe-chordedge.js        (needs `npm start` on :3001)
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

  const lost = (() => { let n = 0;
    for (let i = 0; i < 4000; i++) { const X = i * 0.0173 + 0.37; if ((X + 4) - X !== 4) n++; }
    return n; })();
  console.log('\n  the arithmetic, before anything else:');
  console.log('    (2/3) * 6            = ' + ((2 / 3) * 6).toPrecision(17) + '   (exact — not the cause)');
  console.log('    (0.4392 + 4) - 0.4392 = ' + ((0.4392 + 4) - 0.4392).toPrecision(17) + '  (the cause — below 4)');
  console.log('    cycle starts that lose the 4 s boundary: ' + lost + ' of 4000\n');

  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  // THREE CHANGES, ONE PER BAR — so onsets 1, 3 and 5 of a 6-onset 3-bar part
  // land exactly on a change. That is the whole fixture.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [
      { root: 2, intervals: [0, 4, 7] },
      { root: 6, intervals: [0, 3, 7] },
      { root: 7, intervals: [0, 4, 7] },
    ];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer'); b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);

  const run = await page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    const NM = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const frozen = (harm) => { const p = L.part;
      p.kind = 'recorded'; p.made = 'take'; p.bars = 3;
      delete p.clock; delete p.ms; delete p.barsMode;
      delete L.partFor; delete L.parts; delete L.partAll; delete L.lenSync;
      L.harmony = harm;
      const notes = [];
      for (let i = 0; i < 6; i++) { const t = i / 6;
        [60, 64, 67, 72].forEach((m) => notes.push({ t, midi: m, dur: 0.12 })); }
      p.notes = notes; E.getCfg(); };
    const generated = () => { const p = L.part;
      p.kind = 'live'; p.bars = 3; p.notes = []; delete p.vary; delete L.chg;
      delete p.clock; delete p.ms; delete p.barsMode; delete L.harmony;
      delete L.partFor; delete L.parts; delete L.partAll; delete L.lenSync;
      p.rhythm = { kind: 'pulse', n: 6 };
      p.pitch = { kind: 'chord', voices: 4, degree: 1, span: 4, home: 'center' };
      E.getCfg(); };

    // ONE CYCLE START, ANCHORS PINNED TO IT — which is exactly what a preview
    // does (`_progAnchor = _playStartAt = _barGridAnchor = the cycle it plays`).
    const ask = (X) => {
      E._progAnchor = X; E._playStartAt = X; E._barGridAnchor = X;
      const ns = window._v2.withEdit(() => window._v2.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: X, cycleSec: 6 })) || [];
      const by = {};
      ns.forEach((x) => { const k = Math.round((x.at - X) * 1000);
        const m = Math.round(69 + 12 * Math.log2((x.freq || 440) / 440));
        (by[k] = by[k] || []).push(m); });
      return Object.keys(by).sort((a, b) => a - b).map((k, i) => {
        const pcs = [...new Set(by[k].map((m) => ((m % 12) + 12) % 12))].sort((a, b) => a - b);
        return 'on' + (i + 1) + ':' + pcs.map((c) => NM[c]).join('');
      }).join(' ');
    };

    // ── AND THE SAME BOUNDARY DECIDES HOW LONG A NOTE IS DRAWN ───────────
    // `_ambChordEndAt` asks the same question to find where a note is released,
    // and it was asking it bare: for an onset exactly on a change it bisected
    // for the end of the WRONG chord — the note's own onset — so `end > atSec`
    // failed and the choke did not fire at all. Measured on 2-bar notes, the
    // same take came out 1988 ms on one cycle start and 4000 ms on the next.
    // A 5 ms tolerance: the boundary comes from a 14-step bisection with ~0.5 ms
    // resolution, so neighbouring cycle starts legitimately differ by under a
    // millisecond (sub-pixel, and far below the 2000 ms swing this is for).
    const chokeSweep = () => {
      const key = 'v2:' + L.id;
      L.part.notes.forEach((n) => { n.dur = 2 / 3; });      // 2 bars of a 3-bar cycle
      E.getCfg(); E._cfg = E.getCfg();
      const rows = [];
      for (let i = 0; i < 120; i++) {
        const X = i * 0.0173 + 0.37;
        E._progAnchor = X; E._playStartAt = X; E._barGridAnchor = X;
        const ns = window._v2.withEdit(() => window._v2.notesFor(L,
          { E, cfg: E.getCfg(), key, cycleStart: X, cycleSec: 6 })) || [];
        const by = {};
        ns.forEach((n) => { const k = Math.round((n.at - X) * 1000); if (!by[k]) by[k] = n; });
        rows.push(Object.keys(by).sort((a, b) => a - b).map((k) => {
          const n = by[k];
          try { return Math.round(window._ambNoteChoke(key, n.at, n.durMs, {})); } catch (e) { return -1; }
        }));
      }
      const first = rows[0];
      let worst = 0, at = null;
      rows.forEach((r, i) => r.forEach((v, j) => {
        const d = Math.abs(v - first[j]);
        if (d > worst) { worst = d; at = { X: (i * 0.0173 + 0.37), got: r }; }
      }));
      return { worst, first, at };
    };

    const out = [];
    [['a FROZEN take, chordlocked (the reported shape)', () => frozen('chordlock')],
     ['a FROZEN take, following the changes diatonically', () => frozen('diatonic')],
     ['a GENERATED part, one chord per onset', () => generated()]].forEach(([nm, setup]) => {
      setup();
      const seen = new Map();
      for (let i = 0; i < 240; i++) {
        const X = i * 0.0173 + 0.37;
        const sig = ask(X);
        if (!seen.has(sig)) seen.set(sig, X);
      }
      out.push({ nm, n: seen.size,
        rows: [...seen.entries()].slice(0, 4).map(([s, X]) => 'cycleStart ' + X.toFixed(4) + '  ' + s) });
    });
    frozen('chordlock');
    return { out, choke: chokeSweep() };
  });

  console.log('  240 cycle starts each, anchors pinned — the answer must not depend on which:\n');
  run.out.forEach((r) => {
    ok(r.nm + ' — one harmonisation across every cycle start',
      r.n === 1, r.rows.join('\n      '));
    if (r.n === 1) console.log('      ' + r.rows[0]);
  });

  // …and the LENGTHS, over the same ladder
  const ck = run.choke;
  ok('a note on a change is choked the same way at every cycle start',
    ck.worst <= 5,
    'cycleStart 0.3700  ' + ck.first.join(', ') +
    (ck.at ? ('\n      cycleStart ' + ck.at.X.toFixed(4) + '  ' + ck.at.got.join(', ')) : '') +
    '\n      worst disagreement: ' + ck.worst + ' ms');
  if (ck.worst <= 5) console.log('      lengths ' + ck.first.join(', ') +
    '  (worst spread across 120 cycle starts: ' + ck.worst + ' ms)');

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
