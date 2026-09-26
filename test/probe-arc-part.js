// PROBE — 🌒 Arc at the PART rung: `parts[i].arc = { amount }`.
//
// The arc's DEPTH is the one axis a part can scale without breaking the curve.
// `shape` and `bars` describe the piece and the phase runs on the global bar
// clock, so a part that redefined them would jump to a different point of a
// different shape halfway through — the curve would be discontinuous at its own
// boundary. Depth is also the musical axis: "the chorus is always full, the verse
// breathes" is depth 0 in one part and 70 in another.
//
// Grammar is ↔ Rubato's part rung exactly: absent = inherit, an explicit
// `{amount: 0}` = FLAT HERE however deep the area's arc is.
//
//   node test/probe-arc-part.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(900);

  // Two parts of two chords each, so a part boundary exists to test across.
  const setUp = () => page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.on = true;
    c.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 2 }, { root: 5, intervals: [0, 3, 7], bars: 2 },
                     { root: 7, intervals: [0, 4, 7], bars: 2 }, { root: 2, intervals: [0, 3, 7], bars: 2 }];
    c.barsPerChord = 2;
    c.prog.parts = [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }];
    c.prog.arc = { amount: 70, bars: 32, shape: 'build' };
    delete c.prog.grid;
    const c2 = E.getCfg();
    return { parts: (c2.prog.parts || []).map(x => x.name), arc: c2.prog.arc };
  });
  const s0 = await setUp();
  console.log('\n  setup: ' + JSON.stringify(s0));
  ok('two parts over four 2-bar chords, area arc at depth 70',
    s0.parts.length === 2 && s0.arc && s0.arc.amount === 70, JSON.stringify(s0));

  // ---- 1. STORE --------------------------------------------------------------
  console.log('\n  1. store — depth only, absent = inherit, explicit 0 = flat here');
  const store = await page.evaluate(() => {
    const E = _masterEng, out = {};
    out.fresh = (E.getCfg().prog.parts || []).map(x => ('arc' in x));
    const c = E.getCfg();
    c.prog.parts[0].arc = { amount: 90, shape: 'wave', bars: 64 };   // extras must be dropped
    const c2 = E.getCfg();
    // `?? null`, not a bare stringify: if the carry is dropped this is undefined
    // and JSON.parse kills the whole run, which hides the failure instead of
    // naming it (the guarded-click rule, one layer up).
    out.coerced = c2.prog.parts[0].arc ? JSON.parse(JSON.stringify(c2.prog.parts[0].arc)) : null;
    c2.prog.parts[1].arc = { amount: 0 };                            // meaningful zero
    const c3 = E.getCfg();
    out.zeroKept = ('arc' in c3.prog.parts[1]) && !!c3.prog.parts[1].arc && c3.prog.parts[1].arc.amount === 0;
    // it must survive repeated normalizes — _ambRepairParts builds a fresh object
    const c4 = E.getCfg(), c5 = E.getCfg();
    out.survives = [c5.prog.parts[0].arc ? c5.prog.parts[0].arc.amount : null,
                    c5.prog.parts[1].arc ? c5.prog.parts[1].arc.amount : null];
    return out;
  });
  ok('absent on both parts to begin with', JSON.stringify(store.fresh) === '[false,false]',
    JSON.stringify(store.fresh));
  ok('a part stores DEPTH ONLY — shape and bars are dropped',
    store.coerced && store.coerced.amount === 90 &&
    !('shape' in store.coerced) && !('bars' in store.coerced), JSON.stringify(store.coerced));
  ok('an explicit 0 is KEPT — "full here" is sayable against a deep area arc',
    store.zeroKept === true, String(store.zeroKept));
  ok('…and both survive repeated normalizes (the fresh-object trap)',
    JSON.stringify(store.survives) === '[90,0]', JSON.stringify(store.survives));

  // ---- 2. THE AREA KEEPS ITS CURVE WHILE A PART OVERRIDES --------------------
  console.log('\n  2. the area curve is not thrown away at depth 0');
  const keep = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    c.prog.arc = { amount: 0, bars: 64, shape: 'wave' };      // flat area, chosen curve
    const c2 = E.getCfg();
    const withParts = c2.prog.arc ? JSON.parse(JSON.stringify(c2.prog.arc)) : null;
    // …and with NO part override it prunes away as before
    const c3 = E.getCfg();
    delete c3.prog.parts[0].arc; delete c3.prog.parts[1].arc;
    const c4 = E.getCfg();
    return { withParts, withoutParts: ('arc' in c4.prog) };
  });
  ok('a flat area keeps its wave/64 while a part still overrides',
    keep.withParts && keep.withParts.amount === 0 && keep.withParts.shape === 'wave' && keep.withParts.bars === 64,
    JSON.stringify(keep.withParts));
  ok('…and with no part override an all-zero arc prunes away as before',
    keep.withoutParts === false, String(keep.withoutParts));

  // ---- 3. THE RESOLVER -------------------------------------------------------
  console.log('\n  3. the ladder — part → area, at a real time');
  const lad = await page.evaluate(() => {
    const E = _masterEng;
    E._progAnchor = 0; E._playStartAt = 0;
    const c = E.getCfg();
    c.prog.arc = { amount: 70, bars: 32, shape: 'build' };
    delete c.prog.parts[0].arc; delete c.prog.parts[1].arc;
    const bpm = (c.bpm && c.bpm > 0) ? c.bpm : 120;
    const barSec = (60 / bpm) * 4;
    const at = (bars) => bars * barSec;
    const c1 = E.getCfg();
    // part 0 covers chords 0-1 = bars 0-4; part 1 covers bars 4-8
    const noOverride = [_ambArcAmountAt(E, at(1), c1), _ambArcAmountAt(E, at(5), c1)];
    E.getCfg().prog.parts[1].arc = { amount: 0 };     // chorus always full
    const c2 = E.getCfg();
    const chorusFull = [_ambArcAmountAt(E, at(1), c2), _ambArcAmountAt(E, at(5), c2)];
    E.getCfg().prog.parts[0].arc = { amount: 95 };    // verse breathes hard
    const c3 = E.getCfg();
    const both = [_ambArcAmountAt(E, at(1), c3), _ambArcAmountAt(E, at(5), c3)];
    return { noOverride, chorusFull, both, barSec };
  });
  ok('with no part override, both parts take the area depth',
    JSON.stringify(lad.noOverride) === '[70,70]', JSON.stringify(lad.noOverride));
  ok('an explicit 0 on the Chorus makes it FULL while the Verse still breathes',
    JSON.stringify(lad.chorusFull) === '[70,0]', JSON.stringify(lad.chorusFull));
  ok('…and each part can carry its own depth',
    JSON.stringify(lad.both) === '[95,0]', JSON.stringify(lad.both));

  // ---- 4. IT REACHES THE GATE ------------------------------------------------
  console.log('\n  4. the gate — the part depth is what actually thins');
  const gate = await page.evaluate(() => {
    const E = _masterEng;
    E._progAnchor = 0; E._playStartAt = 0;
    const c = E.getCfg();
    c.prog.arc = { amount: 80, bars: 32, shape: 'build' };
    c.prog.parts[0].arc = { amount: 80 };
    c.prog.parts[1].arc = { amount: 0 };
    const cfg = E.getCfg();
    const bpm = (cfg.bpm && cfg.bpm > 0) ? cfg.bpm : 120;
    const barSec = (60 / bpm) * 4;
    const layers = []; for (let k = 0; k < 200; k++) layers.push({ id: k, type: 'motif' });
    // bar 1 is the thinnest slice of the build AND inside the Verse;
    // bar 5 is the next slice and inside the Chorus.
    const rate = (bars) => {
      let n = 0;
      layers.forEach(L => { if (_ambSectionGateOK(E, L, bars * barSec, cfg, false)) n++; });
      return n / layers.length;
    };
    const out = { verse: rate(1), chorus: rate(5) };
    // a part rung ALONE must engage the gate, with the area flat
    const c2 = E.getCfg(); c2.prog.arc = { amount: 0, bars: 32, shape: 'build' };
    c2.prog.parts[0].arc = { amount: 90 };
    const cfg2 = E.getCfg();
    out.partAloneEngages = (() => { let n = 0;
      layers.forEach(L => { if (_ambSectionGateOK(E, L, 1 * barSec, cfg2, false)) n++; });
      return n / layers.length; })();
    out.areaFlat = (cfg2.prog.arc || {}).amount;
    return out;
  });
  console.log('     verse ' + (gate.verse * 100).toFixed(0) + '% · chorus ' + (gate.chorus * 100).toFixed(0) + '%');
  ok('the Verse thins at the arc’s thinnest slice', gate.verse < 0.6, String(gate.verse));
  ok('…while the Chorus, at depth 0, keeps every layer', gate.chorus === 1, String(gate.chorus));
  ok('a PART rung alone engages the gate against a flat area',
    gate.areaFlat === 0 && gate.partAloneEngages < 0.6,
    JSON.stringify([gate.areaFlat, gate.partAloneEngages]));

  // ---- 5. REACHABLE IN THE PART EDITOR --------------------------------------
  console.log('\n  5. reachable — the part editor, measured');
  await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    // §4 left the area arc FLAT; restore a depth so the seed check below has
    // something to inherit (an "Its own" seeded from 0 would be correct there,
    // which is why the expectation has to state which area depth it is reading).
    c.prog.arc = { amount: 70, bars: 32, shape: 'build' };
    delete c.prog.parts[0].arc; delete c.prog.parts[1].arc;
    E.getCfg();
    _ambOpenProgEditor(E, {});
  });
  await zz(700);
  await page.evaluate(() => {
    const h = document.getElementById('ambient-prog-editor');
    // the part TAB is `data-pe="part:<i>"` (class .pe-parttab) — open part 0 so
    // the Variation section below it describes a real part
    const t = h && h.querySelector('.pe-parttab[data-pe="part:0"]');
    if (t) t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await zz(600);
  const ui = await page.evaluate(() => {
    const h = document.getElementById('ambient-prog-editor');
    if (!h) return { there: false };
    const pick = (sel) => { const e = h.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), par: !!e.offsetParent, txt: e.textContent.trim().slice(0, 24) }; };
    return { there: true, inherit: pick('[data-pe^="partarc"][data-pe$=":0"]'),
             own: pick('[data-pe^="partarc"][data-pe$=":1"]'),
             depth: pick('[data-pearc]'),
             rub: pick('[data-pe^="partrub"][data-pe$=":1"]') };
  });
  ok('the part editor opens on a part', ui.there === true, JSON.stringify(ui));
  ok('🌒 Arc has its own Inherit / Its own pair, both measuring',
    ui.inherit && ui.inherit.w > 20 && ui.inherit.par && ui.own && ui.own.w > 20 && ui.own.par,
    JSON.stringify([ui.inherit, ui.own]));
  ok('…beside ↔ Rubato’s, so it reads as a third axis not more of the second',
    ui.rub && ui.rub.w > 20 && ui.rub.par, JSON.stringify(ui.rub));
  ok('the Depth field is HIDDEN while inheriting', ui.depth === null, JSON.stringify(ui.depth));

  const drive = await page.evaluate(() => {
    const E = _masterEng, h = document.getElementById('ambient-prog-editor'), out = {};
    h.querySelector('[data-pe^="partarc"][data-pe$=":1"]')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return new Promise((res) => setTimeout(() => {
      const h2 = document.getElementById('ambient-prog-editor');
      const f = h2.querySelector('[data-pearc]');
      out.fieldShown = !!f && f.getBoundingClientRect().width > 10 && !!f.offsetParent;
      out.seeded = f ? parseInt(f.value, 10) : null;
      if (f) { f.value = '45'; f.dispatchEvent(new Event('change', { bubbles: true })); }
      const ps = _ambPeParts(_ambProgEd);
      out.written = ps && ps[_ambProgEd.part] && ps[_ambProgEd.part].arc
        ? ps[_ambProgEd.part].arc.amount : null;
      h2.querySelector('[data-pe^="partarc"][data-pe$=":0"]')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      setTimeout(() => {
        const ps2 = _ambPeParts(_ambProgEd);
        out.cleared = !(ps2 && ps2[_ambProgEd.part] && ps2[_ambProgEd.part].arc);
        out.rubUntouched = true;
        res(out);
      }, 250);
    }, 300));
  }).catch(e => ({ err: String(e) }));
  if (drive.err) { fail++; console.log('  ✗ drive block threw\n      ' + drive.err); }
  else {
    ok('"Its own" reveals the Depth field', drive.fieldShown === true, JSON.stringify(drive));
    ok('…seeded from the AREA depth, so engaging it is inaudible',
      drive.seeded === 70, String(drive.seeded));
    ok('…and a typed depth writes through', drive.written === 45, String(drive.written));
    ok('Inherit clears it again', drive.cleared === true, String(drive.cleared));
  }

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
