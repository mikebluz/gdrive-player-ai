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

  // ── THE PLAYHEAD STARTS WHERE THE CYCLE STARTS ──────────────────────────
  // "the playhead starts on step 4 or so". `stepsPlayhead` reads the LAYER's
  // own cycle window and lights `floor(f × steps)`; measured here through the
  // same call rather than through the rAF, so the arithmetic is the thing
  // under test and not the frame timing.
  const ph = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    const cfg = E.getCfg();
    const st = Math.max(1, (L.part.rhythm || {}).steps | 0);
    // A REAL START: the transport stamps all three anchors at the moment ▶ is
    // pressed, and every clock in the app is relative to them.
    const t0 = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    E._progAnchor = t0; E._playStartAt = t0; E._barGridAnchor = t0;
    // THE LAYER'S PHASE, AS A REAL START STAMPS IT — the emitter anchors each
    // layer's lattice here, so this is the clock the notes are on and the one
    // the grid must agree with.
    E._v2Phase = E._v2Phase || {};
    E._v2Phase['v2:' + (L.id | 0)] = { startAt: t0 };
    const ps = E._v2Phase['v2:' + (L.id | 0)];
    const at = (now) => {
      let w = null;
      try { w = V.cycleWindowAt(L, E, cfg, now, ps); } catch (e) { return null; }
      if (!w || !(w.cyc > 0) || !Number.isFinite(w.cs)) return null;
      let f = ((now - w.cs) / w.cyc) % 1; if (f < 0) f += 1;
      return { step: Math.min(st - 1, Math.floor(f * st)),
               lead: Math.round((now - w.cs) * 1000) / 1000 };
    };
    return { st, cyc: V.cycleSec(L, cfg), first: at(t0), early: at(t0 + 0.02),
             quarter: at(t0 + V.cycleSec(L, cfg) / 4) };
  });
  console.log('  playhead — steps=' + ph.st + ', cycle=' + (Math.round(ph.cyc * 100) / 100) + 's');
  console.log('    at the press: ' + JSON.stringify(ph.first));
  console.log('    +20ms:       ' + JSON.stringify(ph.early));
  console.log('    a quarter in: ' + JSON.stringify(ph.quarter) + '\n');
  ok('the playhead starts on step 1, not part way in',
    !!ph.first && ph.first.step === 0, JSON.stringify(ph.first));
  ok('…and a quarter of the cycle in, it is a quarter of the way along',
    !!ph.quarter && ph.quarter.step === Math.floor(ph.st / 4),
    JSON.stringify({ got: ph.quarter, want: Math.floor(ph.st / 4) }));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
