// PROBE — ▦ Pattern on a KIT: the drawn grid is what plays, and the playhead
// starts where the cycle does.
//
// user, 2026-09-22: "pattern not working right; when i switch to pattern, it
// keeps playing the Roll content, also the playhead starts on step 4 or so".
//
// ⌗ Roll and ▦ Pattern are PARALLEL forms — each keeps its own material and
// `notesFor` asks the FORM which branch emits. That rule was applied to the
// note list and to `onsetsOf`, but NOT to the kit branch, which reads
// `rhythm.beat` (the Roll's rules) whenever it exists and never looks at
// `part.form`. So on a drum layer ▦ Pattern drew one grid and played another.
//
//   node test/probe-pattern.js     (needs `npm start`; BLOOPS_URL to retarget)
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
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);

  // ── A DRUM LAYER WITH RULES — the ♦ Beat backbeat, 14 hits a bar ────────
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'beat';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1700);
  // ✓ DONE, BY ITS OWN CLASS. `.v2-gendone` also carries `.v2-genclose`, and a
  // selector list answers for whichever comes FIRST in the DOM — which is the
  // head's ✕, i.e. CANCEL. The draft was discarded and the layer measured as a
  // bare synth (the documented duplicate-class trap, on the very surface whose
  // comment warns about it).
  await page.evaluate(() => {
    const d = document.querySelector('.v2-layer .v2-gendone');
    if (d) d.click();
  });
  await zz(1200);

  const hitsOf = () => page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(L, E.getCfg());
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [];
    const by = {}; ns.forEach((x) => { if (Number.isFinite(x.lane)) by[x.lane] = (by[x.lane] || 0) + 1; });
    return { n: ns.length, by, form: V.formOf(L),
             hasBeatRules: !!(L.part.rhythm || {}).beat,
             steps: (L.part.rhythm || {}).steps | 0,
             lanesDrawn: ((L.part.rhythm || {}).lanes || [])
               .reduce((a, row) => a + (row || []).filter(Boolean).length, 0) };
  });

  const roll = await hitsOf();
  console.log('\n  ⌗ Roll:     ' + JSON.stringify(roll));
  ok('a fresh ♦ Beat is a kit in ⌗ Roll with rules',
    roll.form === 'roll' && roll.hasBeatRules && roll.n === 14, JSON.stringify(roll));

  // ── SWITCH TO ▦ PATTERN, THE WAY A FINGER DOES ──────────────────────────
  const swi = await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-formbtn');
    if (!b) return { there: false };
    const r = b.getBoundingClientRect();
    return { there: true, reachable: r.width > 0 && r.height > 0 && !!b.offsetParent,
             x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  ok('the ⌗ Roll ⇄ ▦ Pattern switch is a real target',
    swi.there && swi.reachable, JSON.stringify(swi));
  if (swi.reachable) await page.touchscreen.tap(swi.x, swi.y);
  await zz(1400);

  const pat = await hitsOf();
  console.log('  ▦ Pattern: ' + JSON.stringify(pat));
  ok('…and it lands in ▦ Pattern', pat.form === 'steps', JSON.stringify(pat));

  // ── THE GRID THAT IS DRAWN IS THE GRID THAT PLAYS ───────────────────────
  // Entering ▦ Pattern on a kit SEEDS the lanes from the rules, exactly as the
  // single-row form seeds `cells` — otherwise the form opens on an empty grid
  // and a beat that is still sounding, which is the worst of both.
  ok('entering ▦ Pattern seeds the lanes from the rules, so the grid is not empty',
    pat.lanesDrawn === 14, 'drawn cells: ' + pat.lanesDrawn);
  // SWITCHING FORMS IS SILENT — the seeded grid is the beat, so the same
  // fourteen keep sounding and the form change is not itself an edit. It
  // CANNOT tell which source answered (both agree by construction at this
  // moment, which is the point of seeding); the tap below is what discriminates.
  ok('…and switching form changes nothing you hear, because the grid IS the beat',
    pat.n === roll.n && JSON.stringify(pat.by) === JSON.stringify(roll.by),
    JSON.stringify({ roll: roll.by, pattern: pat.by }));

  // ── A TAP ON THE GRID IS HEARD ──────────────────────────────────────────
  // The reported shape: one kick on step 1 and nothing else, against a beat
  // that kept playing its fourteen.
  const cleared = await page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    const r = L.part.rhythm;
    r.lanes = Array.from({ length: window._v2.LANES }, () => []);
    E.getCfg();
    return ((E.getCfg().layers || [])[0].part.rhythm.lanes || [])
      .reduce((a, row) => a + (row || []).filter(Boolean).length, 0);
  });
  await zz(400);
  await page.evaluate(() => { const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = ''; window._v2.render(_masterEng); });
  await zz(900);
  const tap = await page.evaluate(() => {
    // SCOPED TO THE GRID ON SCREEN. A card carries the lane cells TWICE — the
    // ▦ Pattern grid in the body and the same grid inside a collapsed group —
    // and a bare `.v2-lanecell` answers for whichever comes first in the DOM,
    // which is the hidden one (a 0x0 rect, the documented tell).
    const c = document.querySelector('.v2-layer .v2-partsteps .v2-lanecell[data-lane="0"][data-ci="0"]');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             reachable: r.width > 0 && r.height > 0 && !!c.offsetParent };
  });
  ok('a kick cell on the ▦ Pattern grid is a real target',
    !!tap && tap.reachable, JSON.stringify(tap));
  if (tap && tap.reachable) await page.touchscreen.tap(tap.x, tap.y);
  await zz(900);
  const one = await hitsOf();
  console.log('  cleared to ' + cleared + ', then one kick drawn: ' + JSON.stringify(one) + '\n');
  ok('one kick drawn is one kick played — the whole point of the form',
    one.n === 1 && one.by[0] === 1, JSON.stringify(one));

  // ── THE PLAYHEAD STARTS WHERE THE CYCLE STARTS ──────────────────────
  // "the playhead starts on step 4 or so", and then "on the last step for a
  // split second". Driven through the REAL frame (`window._v2VizFrame`) and
  // read off the DOM, not by recomputing the arithmetic here — a probe that
  // reimplements the thing under test measures its own copy, and this one did
  // exactly that until the pre-roll fix landed and it could not see it.
  const ph = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    const cfg = E.getCfg();
    const key = 'v2:' + (L.id | 0);
    const st = Math.max(1, (L.part.rhythm || {}).steps | 0);
    const cyc = V.cycleSec(L, cfg);
    const card = document.querySelector('.v2-layer');
    const wrap = card.querySelector('.v2-partsteps');
    // A REAL START stamps all three anchors; the LAYER's phase is the clock its
    // notes are on, and `startAt` is snapped to the shared bar grid — which is
    // why it can sit in the future while the first frames already run.
    const lit = (offset) => {
      const t = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
      E._progAnchor = t; E._playStartAt = t; E._barGridAnchor = t;
      E._v2Phase = E._v2Phase || {};
      E._v2Phase[key] = { startAt: t - offset, lastAt: null };
      const sv = E.timer; E.timer = E.timer || 1;
      if (wrap) wrap._phStep = null;                 // the per-frame cache
      try { window._v2VizFrame(E); } finally { E.timer = sv; }
      const on = wrap ? wrap.querySelector('.v2-lanecell.playing, .v2-cell.playing') : null;
      return on ? (on.getAttribute('data-ci') | 0) : null;
    };
    return { st, cyc, haveWrap: !!wrap,
             // THE MIDDLE OF A STEP, never its edge: the frame reads the
             // AUDIBLE clock (plus one screen frame), which lags the clock this
             // offset is measured from by a millisecond or two — enough to land
             // an exact quarter-cycle on the step BELOW and fail for a reason
             // that has nothing to do with the playhead.
             atStart: lit(0.001), quarter: lit(cyc * ((Math.floor(st / 4) + 0.5) / st)),
             pre: lit(-0.05), preFar: lit(-0.4) };
  });
  console.log('  playhead — steps=' + ph.st + ', cycle=' + (Math.round(ph.cyc * 100) / 100) + 's');
  console.log('    at the press:          step ' + ph.atStart);
  console.log('    a quarter in:          step ' + ph.quarter);
  console.log('    50ms BEFORE the cycle: step ' + ph.pre);
  console.log('    400ms before:          step ' + ph.preFar + '\n');
  ok('the frame lights a column on the ▦ Pattern grid at all',
    ph.haveWrap && ph.atStart != null, JSON.stringify(ph));
  ok('the playhead starts on step 1, not part way in',
    ph.atStart === 0, 'step ' + ph.atStart);
  ok('…and a quarter of the cycle in, it is a quarter of the way along',
    ph.quarter === Math.floor(ph.st / 4), 'step ' + ph.quarter + ', want ' + Math.floor(ph.st / 4));
  // A CYCLE THAT HAS NOT BEGUN WAITS ON ITS FIRST STEP. Wrapping into the cycle
  // BEFORE the anchor lights the last step for the length of the pre-roll,
  // which reads as the grid running backwards for a frame.
  ok('…and during the pre-roll it waits on step 1, it does not flash the last',
    ph.pre === 0 && ph.preFar === 0,
    'at 50ms: ' + ph.pre + ', at 400ms: ' + ph.preFar + ' (last step is ' + (ph.st - 1) + ')');

  // ── A SEEDED GRID COVERS THE WHOLE PART ─────────────────────────────────
  // user, 2026-09-22, of a rolled ♪ Line switched to ▦ Pattern: "most steps
  // unpopulated" — 18 hits in the first 32 cells of 130, the rest dead.
  // `rhythm.steps` is the ROLL's euclid resolution until the form flips, and
  // normalize then re-sizes it to the SEQUENCER's grid (bars × gridPerBar).
  // Seeding before that sizing filled the old, much smaller count and left the
  // tail of the grid empty. Measured on a LONG part, because on a one-bar part
  // the two numbers coincide and the bug cannot show.
  const seeded = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    // A multi-bar arrangement, the shape the report came from.
    { const cfg = E.getCfg();
      cfg.prog.on = true;
      cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 3 },
        { root: 4, intervals: [0, 3, 7], bars: 3 }, { root: 5, intervals: [0, 4, 7], bars: 2 }];
      delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
      E.getCfg(); }
    const L = (E.getCfg().layers || [])[0];
    // BACK TO ⌗ Roll, as a synth playing a euclid — the form the report starts in.
    delete L.part.form;
    L.instrument = L.instrument || {}; L.instrument.voice = 'synth';
    L.part.kind = 'live';
    L.part.bars = 8;
    L.part.rhythm = { kind: 'euclid', steps: 32, pulses: 18, rotate: 0 };
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'walk' });
    delete L.part.rhythm.cells;
    E.getCfg();
    const before = { steps: L.part.rhythm.steps | 0, bars: +L.part.bars };
    // …and into ▦ Pattern through the real button.
    const b = document.querySelector('.v2-layer .v2-formbtn');
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 1200));
    const L2 = (E.getCfg().layers || [])[0];
    const r = L2.part.rhythm;
    const st = r.steps | 0;
    const cells = (r.cells || []).slice(0, st);
    const on = cells.filter(Boolean).length;
    // WHERE the hits sit: a seed that covered only the old grid leaves the
    // whole tail empty, and that is the thing to measure.
    let last = -1;
    cells.forEach((c, i) => { if (c) last = i; });
    return { before, steps: st, on, last, form: V.formOf(L2),
             tailEmpty: last >= 0 && last < Math.floor(st * 0.5) };
  });
  console.log('\n  seeded grid: ' + JSON.stringify(seeded));
  ok('switching a rolled line to ▦ Pattern lands in the form', seeded.form === 'steps',
    JSON.stringify(seeded));
  ok('…and the grid is sized to the PART, not the roll\u2019s euclid resolution',
    seeded.steps > seeded.before.steps, seeded.before.steps + ' → ' + seeded.steps);
  ok('…and the seed covers the whole of it, not just the first cells',
    seeded.on > 0 && !seeded.tailEmpty,
    seeded.on + ' hits, last at step ' + (seeded.last + 1) + ' of ' + seeded.steps);

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
