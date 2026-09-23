// PROBE — an UNEVEN part says so, because it cannot line up with the beat.
//
// user, 2026-09-22, of a bass over an 8.13-bar part: "the second is staggered
// and gets out of sync with the beat, feels about 1/8 or 1/4 off".
//
// Nothing downstream was wrong. The loop is 8⅛ bars, so pass 2 starts ⅛ bar —
// half a beat — later against the bar grid, and by then the whole part sits
// off the beat. The cadence editor already calls such a total "uneven — not a
// whole number of bars"; the layer card showed the number 8.13 and nothing
// else, so the cause was invisible from the screen you hear it on.
//
// MEASURED AS DRIFT, not just as a string: the probe plays the same part over
// several passes and checks where pass N actually starts against the bar grid.
//
//   node test/probe-uneven.js     (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(900);

  // THE DRIFT IS ARITHMETIC, and it is the whole of the complaint: a loop whose
  // length is not a whole number of bars starts somewhere new every pass.
  const drift = await page.evaluate(() => {
    const at = (bars, n) => {
      const out = [];
      for (let p = 0; p < n; p++) {
        const start = p * bars;                 // where pass p begins, in bars
        out.push(Math.round((start - Math.floor(start)) * 1000) / 1000);
      }
      return out;
    };
    return { uneven: at(8.125, 5), even: at(8, 5) };
  });
  console.log('\n  8.125-bar part — pass starts within the bar: ' + JSON.stringify(drift.uneven));
  console.log('  8-bar part      — pass starts within the bar: ' + JSON.stringify(drift.even) + '\n');
  ok('an 8⅛-bar loop starts somewhere new every pass',
    new Set(drift.uneven).size > 1 && Math.abs(drift.uneven[1] - 0.125) < 1e-6,
    JSON.stringify(drift.uneven));
  ok('…while a whole-bar loop starts on the bar every time',
    new Set(drift.even).size === 1 && drift.even[0] === 0, JSON.stringify(drift.even));

  // ── AND THE CARD SAYS SO ────────────────────────────────────────────────
  const say = async (bars) => page.evaluate(async (bars) => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live';
    delete L.part.form;
    L.part.bars = bars;
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    L.part.barsMode = 'fill';
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 900));
    const lab = document.querySelector('.v2-layer .v2-vizlab');
    return lab ? lab.textContent.trim() : null;
  }, bars);

  const odd = await say(8.125);
  const even = await say(8);
  console.log('  8.125 bars: ' + JSON.stringify(odd));
  console.log('  8 bars:     ' + JSON.stringify(even) + '\n');

  ok('the readout calls an uneven part uneven',
    /uneven/.test(odd || ''), JSON.stringify(odd));
  ok('…and names the drift in beats, not as a decimal',
    /half a beat later against the beat/.test(odd || ''), JSON.stringify(odd));
  ok('…and says nothing of the sort on a whole-bar part',
    !/uneven/.test(even || ''), JSON.stringify(even));

  // ── ⇄ EVEN IT OUT — THE CURE, BESIDE THE DIAGNOSIS ────────────────────
  // user, after the readout landed: "still goes off with 2nd pass". Naming the
  // cause on the layer card while the only cure lives on another screen is half
  // an answer. The Cadence editor owns chord lengths and already judges a total
  // "uneven", so the one tap that acts on it belongs there.
  const evened = await page.evaluate(async () => {
    const E = _masterEng;
    const cfg = E.getCfg();
    cfg.prog.on = true;
    // FOUR CHORDS SUMMING TO 8⅛ — the reported shape: even but for one eighth.
    cfg.prog.chords = [
      { root: 0, intervals: [0, 3, 7], bars: 2 }, { root: 5, intervals: [0, 4, 7], bars: 2 },
      { root: 7, intervals: [0, 4, 7], bars: 2 }, { root: 2, intervals: [0, 3, 7], bars: 2.125 }];
    cfg.barsPerChord = 2;
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
    const total = () => Math.round(_ambLenPartBars(E.getCfg(), 0) * 1000) / 1000;
    const before = total();
    // OPEN THE REAL EDITOR and press the real button.
    if (typeof _ambCadenceModal === 'function') _ambCadenceModal(E, 0);
    await new Promise((r) => setTimeout(r, 800));
    const btn = document.querySelector('.ambient-cad-modal .cad-even');
    const rect = btn ? btn.getBoundingClientRect() : null;
    const shown = !!btn && rect.width > 0 && rect.height > 0 && !!btn.offsetParent;
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = total();
    const lens = _ambCadence(E.getCfg(), 0).map((v) => Math.round(v * 1000) / 1000);
    const rb = document.querySelector('.ambient-cad-modal .cad-even');
    const rbr = rb ? rb.getBoundingClientRect() : null;
    const reopened = !!rb && rbr.width > 0 && rbr.height > 0 && !!rb.offsetParent;
    try { const c = document.querySelector('.ambient-cad-modal .cad-close'); if (c) c.click(); } catch (e) {}
    return { before, after, lens, shown, stillOffered: !!reopened,
             fits: Math.abs(after - Math.round(after)) < 1e-6 };
  });
  console.log('  cadence ' + evened.before + ' bars \u2192 ' + evened.after +
    '  lens ' + JSON.stringify(evened.lens) + '\n');
  ok('an uneven cadence offers \u21c4 Even it out, on screen',
    evened.shown === true, JSON.stringify({ shown: evened.shown }));
  ok('…and one tap makes the cadence a whole number of bars',
    evened.fits && evened.after === 8, evened.before + ' \u2192 ' + evened.after);
  ok('…keeping the shape rather than flattening it',
    evened.lens.length === 4 && evened.lens.every((v) => v >= 0.125),
    JSON.stringify(evened.lens));
  ok('…and the offer goes away once it is even',
    evened.stillOffered === false, 'the button is still there on an even cadence');

  // ── ⇄ EVEN THE PART, FROM THE CARD ──────────────────────────────────────
  // Reported twice more after the warning landed — "still goes off with 2nd
  // pass", then "everything goes wrong on second pass of part" — both times
  // with the card still reading 8.13 bars. The cure existed in the Cadence
  // editor, which is not the screen you are on when you hear it, so the
  // warning named a fix nobody reached. Same action, one tap from the symptom.
  const fromCard = await page.evaluate(async () => {
    const E = _masterEng;
    const cfg = E.getCfg();
    cfg.prog.on = true;
    cfg.prog.chords = [
      { root: 0, intervals: [0, 3, 7], bars: 2 }, { root: 5, intervals: [0, 4, 7], bars: 2 },
      { root: 7, intervals: [0, 4, 7], bars: 2 }, { root: 2, intervals: [0, 3, 7], bars: 2.125 }];
    cfg.barsPerChord = 2;
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; delete L.part.form;
    L.part.barsMode = 'fill';
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    L.part.bars = _ambLenPartBars(E.getCfg(), 0);
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 900));
    const btn = () => document.querySelector('.v2-layer .v2-evenfix');
    const vis = (b) => { if (!b) return false; const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !!b.offsetParent; };
    const before = { total: Math.round(_ambLenPartBars(E.getCfg(), 0) * 1000) / 1000,
                     shown: vis(btn()) };
    // THE CARD'S BUTTON IS A DOOR: it opens the Cadence editor, where the
    // action lives. Pressing it and then pressing ⇄ Even it out there is the
    // whole path, and it is the path a finger takes.
    const b0 = btn(); if (b0) b0.click();
    await new Promise((r) => setTimeout(r, 900));
    const modal = !!document.querySelector('.ambient-cad-modal .cad-even');
    const ev2 = document.querySelector('.ambient-cad-modal .cad-even');
    if (ev2) ev2.click();
    await new Promise((r) => setTimeout(r, 900));
    try { const c = document.querySelector('.ambient-cad-modal .cad-close'); if (c) c.click(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    return { before, openedEditor: modal,
             after: Math.round(_ambLenPartBars(E.getCfg(), 0) * 1000) / 1000,
             stillShown: vis(btn()),
             partBars: ((E.getCfg().layers || [])[0] || {}).part ?
               (E.getCfg().layers || [])[0].part.bars : null,
             cycSec: Math.round(window._v2.cycleSec((E.getCfg().layers || [])[0], E.getCfg()) * 100) / 100,
             lens: _ambCadence(E.getCfg(), 0).map((v) => Math.round(v * 1000) / 1000) };
  });
  console.log('  from the card: ' + JSON.stringify(fromCard) + '\n');
  ok('an uneven part shows \u21c4 Even the part on the layer card',
    fromCard.before.shown === true && fromCard.before.total === 8.125,
    JSON.stringify(fromCard.before));
  ok('…and it opens the Cadence, where the action lives',
    fromCard.openedEditor === true, JSON.stringify(fromCard));
  ok('…and evening it there makes the part whole',
    fromCard.after === 8, fromCard.before.total + ' \u2192 ' + fromCard.after);
  // THE DOOR TRACKS THE PART, NOT THE CADENCE — and that distinction is the
  // whole of "part/content integration". Evening the CADENCE makes it 8 bars;
  // the layer's part follows when the cadence edit's own cascade is applied
  // (a prompt, so a headless probe cannot answer it). Until then the part IS
  // still 8.125 and the warning and its door are telling the truth. Asserting
  // "the door went away" would have been asserting the wrong invariant.
  const partWhole = Math.abs(fromCard.partBars - Math.round(fromCard.partBars)) < 1e-6;
  ok('…and the door tracks the PART, staying while the part is still uneven',
    fromCard.stillShown === !partWhole,
    JSON.stringify({ partBars: fromCard.partBars, cadence: fromCard.after,
                     doorShown: fromCard.stillShown }));

  // ── THE CADENCE IS EVEN AND THE CONTENT STILL LAPS ──────────────────────
  // user, 2026-09-22, with the Cadence editor reading "8 bars EVEN" (D 3 ·
  // F#m 4 · G 1) and the layer card still reading 8.13: "the second pass still
  // gets off by 1/8 note or so, like there's an extra beat jammed in at the end
  // of the first pass". Two faults wear one symptom, and the first version of
  // this door sent this case to the Cadence editor — which had nothing to fix.
  const lapping = await page.evaluate(async () => {
    const E = _masterEng;
    const cfg = E.getCfg();
    cfg.prog.on = true;
    // THE REPORTED CADENCE, exactly: 3 · 4 · 1 = 8 bars, even.
    cfg.prog.chords = [
      { root: 2, intervals: [0, 4, 7], bars: 3 }, { root: 6, intervals: [0, 3, 7], bars: 4 },
      { root: 7, intervals: [0, 4, 7], bars: 1 }];
    cfg.barsPerChord = 2;
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
    const cadence = Math.round(_ambLenPartBars(E.getCfg(), 0) * 1000) / 1000;
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; delete L.part.form;
    L.part.barsMode = 'fill';
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    // …and a RECORD that does not fit it — the state the report is in.
    L.part.bars = 8.125;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 1000));
    const lab = document.querySelector('.v2-layer .v2-vizlab');
    const btn = document.querySelector('.v2-layer .v2-evenfix');
    const r = btn ? btn.getBoundingClientRect() : null;
    const shown = !!btn && r.width > 0 && r.height > 0 && !!btn.offsetParent;
    if (btn) btn.click();
    await new Promise((r2) => setTimeout(r2, 900));
    const cadOpen = !!document.querySelector('.ambient-cad-modal');
    const syncOpen = !!document.querySelector('.v2-sync-modal');
    try { document.querySelectorAll('.sm-overlay').forEach((o) => o.remove()); } catch (e) {}
    return { cadence, partBars: 8.125, says: lab ? lab.textContent.trim() : null,
             shown, cadOpen, syncOpen };
  });
  console.log('  even cadence + lapping content:');
  console.log('    cadence ' + lapping.cadence + ' bars, content ' + lapping.partBars + ' bars');
  console.log('    says: ' + JSON.stringify(lapping.says));
  console.log('    opened: ' + (lapping.cadOpen ? 'Cadence' : (lapping.syncOpen ? '\u21c4 Sync' : 'nothing')) + '\n');

  ok('the cadence really is even in this case', lapping.cadence === 8,
    String(lapping.cadence));
  ok('…and the notice blames the CONTENT, not the cadence',
    /this content is 8\.13 bars over a 8-bar part/.test(lapping.says || ''),
    JSON.stringify(lapping.says));
  ok('…naming how far it laps each pass',
    /laps by half a beat every pass/.test(lapping.says || ''), JSON.stringify(lapping.says));
  ok('…the door is on screen', lapping.shown === true, JSON.stringify(lapping.shown));
  ok('…and it opens \u21c4 Sync, not the Cadence that has nothing to fix',
    lapping.syncOpen === true && lapping.cadOpen === false,
    JSON.stringify({ cad: lapping.cadOpen, sync: lapping.syncOpen }));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
