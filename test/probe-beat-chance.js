// PROBE — probability and pitch on a ▦ Pattern beat.
//
// user, 2026-09-22: "how can user introduce probability and stochastic
// improvisation to pattern beats, including pitch changes (changing pitch of
// pitched drum sounds)".
//
// Before this, a kit had ONE probability — Rests, a single value for the whole
// layer — and no pitch at all: every hit was `36 + VDRUM[lane]`, fixed. Three
// things answer it, and each is checked by what it makes the emitter DO rather
// than by what it stores:
//   ░ Chance  — per-step probability (`rhythm.cellFx[lane:step].c`)
//   ♪ Tune    — per-step semitones (`.t`), the deliberate pitch
//   Pitch vary — ± semitones per hit (`L.pitchVary`), the stochastic pitch
// …plus Vary, which re-decides a DRAWN grid per take the way it always did the
// generated one.
//
//   node test/probe-beat-chance.js     (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c && c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'beat';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1700);
  await page.evaluate(() => { const d = document.querySelector('.v2-layer .v2-gendone'); if (d) d.click(); });
  await zz(1200);
  // INTO ▦ PATTERN, where the grid is the material.
  await page.evaluate(() => { const b = document.querySelector('.v2-layer .v2-formbtn'); if (b) b.click(); });
  await zz(1400);

  // ── THE MODE ROW IS REACHABLE ───────────────────────────────────────────
  const modes = await page.evaluate(() => {
    const row = document.querySelector('.v2-layer .v2-partsteps .v2-cellmodes');
    if (!row) return { there: false };
    const r = row.getBoundingClientRect();
    return { there: true, reachable: r.width > 0 && r.height > 0 && !!row.offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1,
             labels: [...row.querySelectorAll('.v2-cellmode')].map((b) => b.getAttribute('data-cellmode')),
             on: (row.querySelector('.v2-cellmode.on') || {}).getAttribute
                 ? row.querySelector('.v2-cellmode.on').getAttribute('data-cellmode') : null };
  });
  console.log('\n  mode row: ' + JSON.stringify(modes));
  ok('the ■ Hit · ░ Chance · ♪ Tune row is on screen and fits at 390px',
    modes.there && modes.reachable && modes.inView, JSON.stringify(modes));
  ok('…offering the three modes, starting on ■ Hit',
    JSON.stringify(modes.labels) === JSON.stringify(['hit', 'chance', 'tune']) && modes.on === 'hit',
    JSON.stringify(modes));

  const tapMode = async (m) => {
    const p = await page.evaluate((m) => {
      const b = document.querySelector('.v2-layer .v2-partsteps .v2-cellmode[data-cellmode="' + m + '"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, m);
    if (p) await page.touchscreen.tap(p.x, p.y);
    await zz(900);
  };
  const tapCell = async (li, ci, times) => {
    for (let k = 0; k < (times || 1); k++) {
      const p = await page.evaluate((li, ci) => {
        const c = document.querySelector('.v2-layer .v2-partsteps .v2-lanecell[data-lane="' + li + '"][data-ci="' + ci + '"]');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, li, ci);
      if (!p) return false;
      await page.touchscreen.tap(p.x, p.y);
      await zz(650);
    }
    return true;
  };

  // A CLEAN GRID: one kick on step 0, nothing else — so every number below is
  // about that one cell.
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    const r = L.part.rhythm;
    r.lanes = Array.from({ length: window._v2.LANES }, () => []);
    r.lanes[0][0] = 1;
    delete r.cellFx; delete L.pitchVary;
    if (r.beat) delete r.beat.vary;
    // RE-DECIDE EACH PASS. `cycIdx` — the seed every per-hit draw keys on —
    // only advances per cycle when the part is set to re-decide; otherwise it
    // is `take + epoch`, constant, and the layer plays ONE take over and over
    // BY DESIGN (the Live/Deep rule). So chance and pitch vary are properties
    // of a take unless this is on, and "stochastic improvisation" means this
    // switch plus these controls. Measuring without it measures one throw 200
    // times and reads as a dead control.
    L.part.vary = 1;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(1000);

  // WHAT PLAYS, over many cycles — a probability is a claim about the long run,
  // so one cycle cannot check it. Each cycle is a fresh take (`cycIdx` keys the
  // draw), which is exactly what "stochastic improvisation" means here.
  const runs = (n) => page.evaluate((n) => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(L, E.getCfg());
    let hits = 0, cyclesWith = 0; const semis = [], perCycle = [];
    for (let c = 0; c < n; c++) {
      const ns = V.withEdit(() => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: c * cyc, cycleSec: cyc })) || [];
      let k = 0;
      ns.forEach((x) => {
        if (x.lane !== 0 || x.ghost) return;
        hits++; k++;
        semis.push(Math.round((69 + 12 * Math.log2(x.freq / 440)) * 100) / 100);
      });
      perCycle.push(k);
      if (k > 0) cyclesWith++;
    }
    return { hits, of: n, semis, cyclesWith, perCycle };
  }, n);

  const base = await runs(40);
  console.log('  plain:  ' + base.hits + '/40 cycles sounded, semitone ' + base.semis[0]);
  ok('a drawn kick sounds every cycle before any of this',
    base.cyclesWith === 40, base.cyclesWith + '/40');

  // ── ░ CHANCE ────────────────────────────────────────────────────────────
  await tapMode('chance');
  await tapCell(0, 0, 2);          // 100 → 75 → 50
  const ch = await page.evaluate(() => {
    const r = (_masterEng.getCfg().layers || [])[0].part.rhythm;
    return (r.cellFx || {})['0:0'] || null;
  });
  const half = await runs(200);
  console.log('  chance: stored ' + JSON.stringify(ch) + ' → ' + half.cyclesWith + '/200 cycles sounded');
  ok('two taps in ░ Chance put that cell at 50%', !!ch && ch.c === 50, JSON.stringify(ch));
  // A COIN, NOT A PATTERN: wide bounds, because this is a probability and a
  // tight assertion here would be a flake generator.
  ok('…and it sounds about half the time', half.cyclesWith > 60 && half.cyclesWith < 140,
    half.cyclesWith + '/200 — wanted roughly 100');
  ok('…and the cell says so on the grid', await page.evaluate(() =>
    !!document.querySelector('.v2-layer .v2-partsteps .v2-lanecell[data-lane="0"][data-ci="0"].v2-cellmaybe')),
    'no .v2-cellmaybe class on the cell');

  // ── ♪ TUNE ──────────────────────────────────────────────────────────────
  await page.evaluate(() => {
    const E = _masterEng, r = (E.getCfg().layers || [])[0].part.rhythm;
    delete r.cellFx; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(900);
  await tapMode('tune');
  await tapCell(0, 0, 3);          // 0 → +2 → +3 → +5
  const tu = await page.evaluate(() => {
    const r = (_masterEng.getCfg().layers || [])[0].part.rhythm;
    return { fx: (r.cellFx || {})['0:0'] || null,
             shown: (document.querySelector('.v2-layer .v2-partsteps .v2-lanecell[data-lane="0"][data-ci="0"] .v2-celltune') || {}).textContent || null };
  });
  const tuned = await runs(6);
  console.log('  tune:   stored ' + JSON.stringify(tu) + ' → semitone ' + tuned.semis[0] +
    ' (was ' + base.semis[0] + ')');
  ok('three taps in ♪ Tune put that cell at +5 semitones',
    !!tu.fx && tu.fx.t === 5, JSON.stringify(tu.fx));
  ok('…and the hit plays five semitones higher',
    Math.abs((tuned.semis[0] - base.semis[0]) - 5) < 0.01,
    base.semis[0] + ' → ' + tuned.semis[0]);
  ok('…and the cell shows its offset', tu.shown === '+5', JSON.stringify(tu.shown));

  // ── PITCH VARY — the stochastic half ────────────────────────────────────
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.rhythm.cellFx; L.pitchVary = 5; E.getCfg();
  });
  await zz(600);
  const pv = await runs(24);
  const spread = Math.max.apply(null, pv.semis) - Math.min.apply(null, pv.semis);
  const distinct = new Set(pv.semis).size;
  console.log('  pitchVary 5: ' + distinct + ' distinct pitches over 24 cycles, spread ' +
    spread.toFixed(2) + ' semitones\n');
  ok('Pitch vary moves the pitch from hit to hit', distinct > 12,
    distinct + ' distinct of 24');
  ok('…within the semitones it says, not beyond', spread > 2 && spread <= 10,
    'spread ' + spread.toFixed(2) + ' — wanted inside ±5');
  // SEEDED, so a take replays: the same cycle asked twice is the same pitch.
  const repeat = await runs(24);
  ok('…and it is a take, not noise — the same cycle replays identically',
    JSON.stringify(repeat.semis) === JSON.stringify(pv.semis),
    'two reads of the same cycles disagreed');

  // ── VARY REACHES THE DRAWN GRID ─────────────────────────────────────────
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.pitchVary;
    const r = L.part.rhythm;
    // A HAND-DRAWN KIT WITH NO RULES LEFT — every lane's pulses cleared, so
    // `beat` survives normalize ONLY because Vary is stated. With the rules
    // still in place the object is kept for them and this proves nothing.
    r.beat = r.beat || { lanes: [] };
    r.beat.lanes = Array.from({ length: window._v2.LANES }, () => ({}));
    r.beat.vary = 60;
    E.getCfg();
  });
  await zz(600);
  const vr = await page.evaluate(() => {
    const r = (_masterEng.getCfg().layers || [])[0].part.rhythm;
    return (r.beat || {}).vary;
  });
  const varied = await runs(40);
  const shapes = new Set(varied.perCycle).size;
  console.log('  vary 60 on a DRAWN grid: kick hits per cycle ' +
    JSON.stringify(varied.perCycle.slice(0, 12)) + ' … (' + shapes + ' distinct counts)');
  ok('Vary is kept on a hand-drawn kit, not pruned away', vr === 60, JSON.stringify(vr));
  // THE BAR IS NOT THE SAME BAR EVERY CYCLE — which is the whole of "a drawn
  // grid takes takes". Counted as distinct hit-counts per cycle rather than a
  // total, because a total cannot tell one busy cycle from two quiet ones.
  ok('…and a drawn grid now takes takes — the bar is not identical every cycle',
    shapes > 1, 'every cycle produced ' + varied.perCycle[0] + ' kick hits');

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
