// PROBE — ONE CONTENT, TWO REPRESENTATIONS: does the PICTURE match the AUDIO?
//
// "params being deterministic in creating a singular content whose audio and
// visual representations perfectly sync up."
//
// `notesFor` is the ONE seam — the drawing calls it and so does the emitter —
// so they agree by construction. What breaks that is anything acting AFTER the
// seam, in the emit loop, and anything that resolves the harmony against a
// DIFFERENT clock than the notes were made in.
//
// This asks both questions over a matrix of generated materials:
//   DETERMINISM  three calls to `notesFor` on one take \u2014 same answer?
//   SYNC         what reaches playNote vs what notesFor said, note for note.
//
// TWO DIVERGENCES ARE REAL AND PINNED AS SUCH (they are by design today, and
// this gate fails if either changes silently):
//   \u00b7 Humanize writes `params._humanSec`, applied downstream of the `at` the
//     emitter schedules \u2014 so it moves the sound off the drawn grid, unseeded,
//     and can never be drawn. Measured \u00b17ms at 40.
//   \u00b7 Ornament ADDS grace notes in the emit loop; the picture has no idea.
//
// AND ONE WAS A BUG, fixed here: the \u2699 Deep staged drawing took the preview's
// cycle start WITHOUT its anchors, so it resolved preview-time onsets against
// the restored global progression origin. A 3-voice chord part drew 21 and
// played 21 with 14 of them DIFFERENT; Groundwork drew 27 against 18 heard.
//
//   node test/probe-gensync.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '  \u2014 ' + detail : '')); }
};

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000 });
  const page = await b.newPage();
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

  await page.evaluate(() => {
    window.__E = () => _masterEng;
    window.__L = () => (_masterEng.getCfg().layers || [])[0];
    window.__mk = (spec) => {
      const E = window.__E(), L = window.__L(), p = L.part;
      p.kind = 'live'; p.bars = 3; p.notes = [];
      delete p.vary; delete L.chg; delete p.clock; delete p.ms; delete p.timing;
      delete L.fixed; delete p.takeb; delete p.ruleb; delete p.xf;
      ['humanize','velVar','accent','slide','ornament','motion','strum','strumFidelity','swing','tight']
        .forEach((k) => { delete L[k]; });
      p.rhythm = Object.assign({ kind: 'euclid', steps: 12, pulses: 7, rotate: 0, n: 3 }, spec.rhythm || {});
      p.pitch = Object.assign({ kind: 'walk', voices: 1, degree: 1, span: 4, home: 'center', dir: 'up' }, spec.pitch || {});
      p.shape = Object.assign({ lenRatio: 68 }, spec.shape || {});
      Object.keys(spec.layer || {}).forEach((k) => { L[k] = spec.layer[k]; });
      E.getCfg();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      return true;
    };
    // what the DRAWING is built from
    window.__ask = (cs, cyc) => {
      const E = window.__E(), L = window.__L();
      return (window._v2.withEdit(() => window._v2.withTake(window._v2.pinOf(L),
        () => window._v2.notesFor(L, { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: cs, cycleSec: cyc }))) || [])
        .map((n) => ({ at: Math.round((n.at - cs) * 1000),
                       m: Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)),
                       d: Math.round(n.durMs) }))
        .sort((x, y) => x.at - y.at || x.m - y.m);
    };
    // what actually SOUNDS — wrap playNote around a real preview
    window.__heard = null;
    window.__preview = () => {
      const E = window.__E(), L = window.__L();
      const orig = window.playNote;
      const got = [];
      window.playNote = function (f, params, dur, at) {
        // `_humanSec` is Humanize: it is written into the PARAMS and applied
        // downstream, NOT to `at` — so a harness that reads `at` alone reports
        // "in sync" for a layer whose notes are audibly off the grid. Capture it.
        got.push({ f, dur, at, hs: (params && params._humanSec) || 0 });
        return orig.apply(this, arguments);
      };
      let n = 0;
      try { n = window._v2.preview(E, L) || 0; } catch (e) {}
      window.playNote = orig;
      const pv = window._v2.previewCycle();
      const cs = pv ? pv.at : 0;
      window.__shift = got.reduce((m, g) => Math.max(m, Math.abs(g.hs || 0)), 0);
      window.__heard = got.map((g) => ({ at: Math.round((g.at - cs) * 1000),
                                         m: Math.round(69 + 12 * Math.log2((g.f || 440) / 440)),
                                         d: Math.round(g.dur) }))
        .sort((x, y) => x.at - y.at || x.m - y.m);
      try { window._v2.previewKill(E, L); } catch (e) {}
      return { n, cs };
    };
  });

  const cases = [
    ['plain walk', {}],
    ['chords, 3 voices', { pitch: { kind: 'chord', voices: 3 } }],
    ['groundwork', { rhythm: { kind: 'ground', strike: 'half' }, pitch: { kind: 'chord', voices: 3 } }],
    ['arp', { pitch: { kind: 'arp' }, rhythm: { kind: 'euclid', steps: 16, pulses: 11 } }],
    ['mixed', { pitch: { kind: 'mixed', voices: 3, mix: 50 } }],
    ['+ Humanize 40', { layer: { humanize: 40 } }],
    ['+ Ornament 60', { layer: { ornament: 60 } }],
    ['+ Accent 60', { layer: { accent: 60 } }],
    ['+ Slide 60', { layer: { slide: 60 } }],
    ['+ Wobble 40', { layer: { motion: 40 } }],
    ['+ Strum 60', { pitch: { kind: 'chord', voices: 4 }, layer: { strum: 60, strumFidelity: 60 } }],
    ['+ Swing 60', { layer: { swing: 60 } }],
    ['+ Tight', { layer: { tight: 1 } }],
  ];

  // The two that are KNOWN to diverge, pinned so a silent change fails here.
  const KNOWN = {
    '+ Humanize 40': { why: 'unseeded jitter, applied downstream of the drawn onset',
      check: (c) => c.shiftMs > 0 && c.shiftMs <= 12 && c.extra === 0 && c.missing === 0 },
    '+ Ornament 60': { why: 'grace notes added in the emit loop',
      check: (c) => c.extra > 0 && c.missing === 0 },
  };
  const results = [];
  console.log('\n  cycle = 3 bars = 6 s. DET = notesFor thrice; SYNC = heard vs drawn.\n');
  console.log('   case                  DET   drawn  heard   extra  moved   note');
  console.log('   ' + '-'.repeat(74));
  for (const [nm, spec] of cases) {
    await page.evaluate((s2) => window.__mk(s2), spec);
    await zz(150);
    const det = await page.evaluate(() => {
      const a = JSON.stringify(window.__ask(0, 6));
      const b2 = JSON.stringify(window.__ask(0, 6));
      const c = JSON.stringify(window.__ask(0, 6));
      return { same: a === b2 && b2 === c, n: JSON.parse(a).length };
    });
    const pv = await page.evaluate(() => window.__preview());
    await zz(1400);
    const cmp = await page.evaluate(() => {
      const pv2 = window._v2.previewCycle();
      const cs = pv2 ? pv2.at : 0;
      const drawn = window.__ask(cs, 6);
      const heard = window.__heard || [];
      // the preview schedules one extra note past the cycle (window is
      // cyc + 60ms) — count only what lands inside the cycle
      const inCyc = heard.filter((h) => h.at >= -2 && h.at < 6000);
      const key = (x) => x.at + ':' + x.m;
      const dset = new Set(drawn.map(key));
      const hset = new Set(inCyc.map(key));
      const extra = inCyc.filter((h) => !dset.has(key(h)));
      const missing = drawn.filter((d) => !hset.has(key(d)));
      // a note at the same pitch but a different time = MOVED
      const moved = extra.filter((h) => drawn.some((d) => d.m === h.m && Math.abs(d.at - h.at) < 400));
      return { shiftMs: Math.round((window.__shift || 0) * 1000),
               drawn: drawn.length, heard: inCyc.length,
               extra: extra.length, missing: missing.length, moved: moved.length,
               sample: extra.slice(0, 2).map((x) => x.m + '@' + x.at) };
    });
    const note = (cmp.shiftMs > 0)
      ? ((cmp.extra ? cmp.extra + ' added, ' : '') + 'onsets shifted up to ' + cmp.shiftMs + 'ms')
      : (cmp.extra === 0 && cmp.missing === 0) ? 'in sync'
      : (cmp.moved ? (cmp.moved + ' moved') : '') +
        (cmp.extra - cmp.moved > 0 ? ((cmp.moved ? ' + ' : '') + (cmp.extra - cmp.moved) + ' added') : '') +
        (cmp.missing ? ((cmp.extra ? ' + ' : '') + cmp.missing + ' lost') : '');
    console.log('   ' + nm.padEnd(22) + (det.same ? ' ok ' : ' NO ').padEnd(6) +
      String(cmp.drawn).padStart(5) + String(cmp.heard).padStart(7) +
      String(cmp.extra).padStart(7) + String(cmp.moved).padStart(7) + '   ' + note);
    results.push({ nm, det: det.same, cmp });
  }

  console.log('');
  results.forEach((r) => {
    ok('deterministic \u2014 ' + r.nm, r.det, 'three calls, three answers');
  });
  console.log('');
  results.forEach((r) => {
    const known = KNOWN[r.nm];
    if (known) {
      ok(r.nm + ' \u2014 the KNOWN divergence, unchanged: ' + known.why,
        known.check(r.cmp), JSON.stringify(r.cmp));
      return;
    }
    ok(r.nm + ' \u2014 every note that sounds is drawn, and vice versa',
      r.cmp.extra === 0 && r.cmp.missing === 0 && r.cmp.shiftMs === 0,
      JSON.stringify(r.cmp));
  });
  // ── THE STAGED PANEL (⚙ Deep) ─────────────────────────────────────────
  // READ WHAT `stageVizDraw` DREW, never re-derive it. An earlier version of
  // this check reproduced the function's own logic in the probe and compared
  // THAT to the audio — so poisoning the fix left it green: it was testing its
  // own arithmetic, which is the failure this repo names outright. The staged
  // canvas publishes `_hits` (midi + a cycle fraction `t`); that is the
  // picture's own claim.
  // TWO THINGS THE FIRST ATTEMPT GOT WRONG, both worth keeping written down:
  //   · `.v2-stagecv` matches TWICE — ✨ Quick's canvas and ⚙ Deep's. Quick is
  //     shut, so the unscoped query found a zero-width canvas with no hits.
  //     Scope to `.v2-genwrap`.
  //   · the card must be expanded BY ITS HANDLER. `stageVizDraw` bails on a
  //     zero-width canvas (`if (!(wCss > 0)) return`), and a `classList` poke
  //     leaves the panel unlaid-out, so it never draws at all.
  console.log('\n  ⚙ Deep, draft open — the staged picture vs the staged preview:\n');
  {
    const cbox = await page.evaluate(() => {
      const c = document.querySelector('.v2-layer .ambient-collapse'); if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (cbox) await page.touchscreen.tap(cbox.x, cbox.y);
    await zz(900);
  }
  for (const [nm, spec] of [['groundwork', { rhythm: { kind: 'ground', strike: 'half' }, pitch: { kind: 'chord', voices: 3 } }],
                            ['chords, 3 voices', { pitch: { kind: 'chord', voices: 3 } }],
                            ['plain walk', {}]]) {
    await page.evaluate((s2) => window.__mk(s2), spec);
    await zz(250);
    await page.evaluate(() => {
      const E = window.__E(), L = window.__L();
      try { window._v2.draftCancel(E, L); } catch (e) {}
      window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
    });
    await zz(1100);
    // press the panel's own ▶ Preview, capturing what sounds
    const heard = await page.evaluate(() => {
      const orig = window.playNote;
      const got = [];
      window.playNote = function (f, params, dur, at) {
        got.push({ f, at }); return orig.apply(this, arguments);
      };
      const b2 = document.querySelector('.v2-layer .v2-genprev');
      const found = !!b2;
      if (b2) b2.click();
      window.playNote = orig;
      const pv = window._v2.previewCycle();
      const cs = pv ? pv.at : 0;
      return { found, n: got.length, cs,
        keys: got.map((g) => Math.round((g.at - cs) * 1000) + ':' +
          Math.round(69 + 12 * Math.log2((g.f || 440) / 440))) };
    });
    await zz(900);
    const r = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-genwrap .v2-stagecv');
      if (!cv) return { err: 'no staged canvas' };
      const g = cv._plotGeo || {};
      if (!(cv.clientWidth > 0)) return { err: 'staged canvas has no width' };
      const cyc = g.cyc || 6;
      return { drawn: (cv._hits || []).map((h) =>
        Math.round((h.t || 0) * cyc * 1000) + ':' + h.midi), cyc };
    });
    await page.evaluate(() => {
      const E = window.__E(), L = window.__L();
      try { window._v2.previewKill(E, L); } catch (e) {}
      const x = document.querySelector('.v2-layer .v2-genclose'); if (x) x.click();
      try { window._v2.draftCancel(E, L); } catch (e) {}
    });
    await zz(600);
    let verdict = '', good = false;
    if (r.err) { verdict = r.err; }
    else if (!heard.found) { verdict = 'no ▶ Preview in the panel'; }
    else {
      const inCyc = heard.keys.filter((k) => { const t = parseInt(k, 10); return t >= -2 && t < r.cyc * 1000; });
      const dset = new Set(r.drawn), hset = new Set(inCyc);
      // ±2 ms: the drawn time comes back through a fraction of the cycle
      const near = (k, set) => { const parts = k.split(':'); const t = +parts[0], m = parts[1];
        for (let d = -2; d <= 2; d++) if (set.has((t + d) + ':' + m)) return true; return false; };
      const extra = inCyc.filter((k) => !near(k, dset));
      const missing = r.drawn.filter((k) => !near(k, hset));
      good = extra.length === 0 && missing.length === 0 && r.drawn.length > 0;
      verdict = good ? 'in sync' : (extra.length + ' added, ' + missing.length + ' lost');
      console.log('   ' + nm.padEnd(22) + 'drawn ' + String(r.drawn.length).padStart(3) +
        '   heard ' + String(inCyc.length).padStart(3) + '   ' + verdict);
    }
    ok('⚙ Deep, ' + nm + ' — the staged picture is the staged sound', good, verdict);
  }


  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
