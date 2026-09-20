// PROBE — ▶ PREVIEW MUST NOT REDRAW THE PART FOR EVER.
//
// Reported as "pressing play and/or preview seems to edit the notes — some
// notes in the visualizer shorten, an extra chord just shows up and sticks
// around … a state bug with play/preview and the visualizer being in sync
// with the note content". The STORE is innocent (test/probe-content-state.js);
// this is the drawing's state.
//
// TWO DEFECTS, which compounded:
//
//   1 · `PV_VIZ` — the cycle a preview played, a WALL CLOCK — was set by
//       `previewLayer` and never cleared. `previewKill` clears `PV`, the AUDIO
//       tracker, and left this one standing, so `drawPartViz` anchored every
//       later repaint of that layer to a finished preview: through a panel
//       rebuild, for the rest of the session, moving again on every press.
//       `stageVizDraw` had always gated on `previewing()`; the card's drawing
//       was the half that did not.
//
//   2 · the CHOKE (how long a note is drawn — it is released by the next
//       change) was resolved OUTSIDE `withPvClocks`, so a preview-time onset
//       was compared against the restored global clocks. Measured on a held
//       chord: every note 124px on one press and 40px on the next, from
//       nothing but which second the press landed on.
//
// WHAT IS PINNED: a preview is REPEATABLE (it pins the changes to the press,
// so every press draws the same thing), and when it has finished the picture
// is the stopped drawing again — byte for byte.
//
//   node test/probe-pvviz.js        (needs `npm start` on :3001)
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
  // A progression with CHANGES INSIDE THE LAYER'S CYCLE — without one the
  // choke never cuts anything and defect 2 cannot show.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [
      { root: 0, intervals: [0, 4, 7] },
      { root: 5, intervals: [0, 4, 7, 10] },
      { root: 7, intervals: [0, 3, 7] },
      { root: 9, intervals: [0, 4, 7, 11] },
    ];
    cfg.prog.parts = [{ name: 'A', len: 3 }, { name: 'B', len: 1 }];
    delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer'); b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);

  await page.evaluate(() => {
    window.__E = () => _masterEng;
    window.__L = () => (_masterEng.getCfg().layers || [])[0];
    window.__cv = () => document.querySelector('.v2-vizcv');
    // THE PICTURE'S OWN CLAIM — published geometry, never re-derived.
    window.__pic = () => { const cv = window.__cv(); if (!cv) return 'no canvas';
      const hits = (cv._hits || []).map(h => ({ midi: h.midi, x: Math.round(h.x), w: Math.round(h.w) }))
        .sort((a, b) => a.x - b.x || a.midi - b.midi);
      const ch = (cv._chordGeo && cv._chordGeo.marks || []).map(m => (m.nm || '?') + '@' + Math.round((m.f0 || 0) * 100));
      return 'notes[' + hits.map(h => h.midi + '@' + h.x + 'w' + h.w).join(' ') + '] chords[' + ch.join(' ') + ']'; };
    window.__pvNull = () => { try { return !window._v2.previewCycle(); } catch (e) { return false; } };
    window.__press = () => { const b = document.querySelector('.v2-pop-preview, .v2-genprev, .v2-secprev');
      if (!b) return 'missing'; b.click(); return 'ok'; };
    window.__kill = () => { try { window._v2.previewKill(window.__E(), window.__L()); } catch (e) {} };
    window.__rebuild = () => { try { _ambRebuildMaster(); } catch (e) {}
      const cd = document.querySelector('.v2-layer'); if (cd) cd.classList.remove('collapsed'); };
  });

  const cases = [
    { name: 'a HELD CHORD over changes inside the cycle (the shortening case)',
      setup: () => { const L = window.__L(), p = L.part;
        p.kind = 'live'; p.bars = 2; p.notes = []; delete p.vary; delete L.chg;
        p.rhythm = { kind: 'pulse', n: 2 };
        p.pitch = { kind: 'chord', voices: 4, degree: 1, span: 4, home: 'center' };
        delete p.barsMode; delete p.clock; delete p.ms; delete L.harmony;
        delete L.partFor; delete L.parts; delete L.partAll; delete L.lenSync;
        window.__E().getCfg(); },
      everywhere: true, wait: 5000 },
    { name: 'a per-part WRITTEN record, chordlocked (the jumping-pitch case)',
      setup: () => { const E = window.__E(), L = window.__L(), p = L.part;
        p.kind = 'recorded'; p.made = 'compose'; p.bars = 2;
        p.notes = [{ t: 0, midi: 60, dur: 0.22 }, { t: 0.25, midi: 64, dur: 0.22 },
                   { t: 0.5, midi: 67, dur: 0.22 }, { t: 0.75, midi: 72, dur: 0.22 }];
        L.harmony = 'chordlock';
        delete p.barsMode; delete p.clock; delete p.ms; delete L.lenSync;
        if (!Number.isFinite(L.partFor)) { L.partAll = JSON.parse(JSON.stringify(p)); L.partFor = 1; }
        E.getCfg(); },
      wait: 4000 },
  ];

  for (const c of cases) {
    console.log('\n' + c.name + '\n');
    await page.evaluate(c.setup);
    await zz(300);
    await page.evaluate(() => window.__rebuild());
    await zz(900);
    const base = await page.evaluate(() => window.__pic());

    // THREE PRESSES AT THREE DIFFERENT WALL-CLOCK MOMENTS. A preview pins the
    // changes to the press, so all three must draw the same thing; defect 2
    // made the note LENGTHS depend on which second it happened to be.
    const shots = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__press());
      await zz(900);
      shots.push(await page.evaluate(() => window.__pic()));
      await page.evaluate(() => window.__kill());
      await zz(400);
    }
    ok('three presses draw the same picture — a preview is repeatable',
      shots[0] === shots[1] && shots[1] === shots[2],
      shots.map((s, i) => 'press ' + (i + 1) + ': ' + s).join('\n      '));
    // …AND THE LENGTHS ARE THE STOPPED ONES. A preview pins the changes to the
    // press, so its offset into the progression is zero — exactly where the
    // stopped drawing's own chord anchor sits. So a previewing picture must
    // carry the SAME note lengths as the stopped one for a layer whose content
    // is everywhere. This is the deterministic half of the check above: with
    // the choke asked outside `withPvClocks` the widths track the wall clock,
    // so they agree only by luck. (Skipped for a per-part record, whose stopped
    // anchor is its own part's start rather than the progression's.)
    if (c.everywhere) {
      const wOf = (s) => (s.match(/w(\d+)/g) || []).join(',');
      ok('…and it draws the STOPPED note lengths, not the wall clock’s',
        wOf(shots[0]) === wOf(base),
        'stopped:    ' + wOf(base) + '\n      previewing: ' + wOf(shots[0]));
    }

    // …AND WHEN IT IS OVER, THE STOPPED PICTURE IS BACK.
    ok('▶ stop clears the drawing’s remembered cycle', await page.evaluate(() => window.__pvNull()));
    await page.evaluate(() => window.__rebuild());
    await zz(900);
    const afterKill = await page.evaluate(() => window.__pic());
    ok('after a stop the picture is the stopped drawing again, byte for byte',
      afterKill === base, 'before: ' + base + '\n      after:  ' + afterKill);

    // …and the same once a preview simply RUNS OUT, with no stop press.
    await page.evaluate(() => window.__press());
    await zz(c.wait);
    await page.evaluate(() => window.__rebuild());
    await zz(900);
    const afterEnd = await page.evaluate(() => window.__pic());
    ok('…and the same when the preview simply ends, with no stop press',
      afterEnd === base, 'before: ' + base + '\n      after:  ' + afterEnd);
    await page.evaluate(() => window.__kill());
    await zz(300);
  }

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
