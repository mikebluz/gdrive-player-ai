// PROBE — a Family filter between Tone type and Tone.
//
// "we need to add an intermediate filter between Tone type and Tone to help
// reduce the number of options in the Tone dropdown, it's too unwieldy as is".
//
// The load-bearing checks are the two a filter can quietly get wrong:
//   · filtering must NOT change the sound — it narrows a list, nothing else;
//   · and it must never HIDE the tone in force, or the select falls back to
//     option 0 and reports a voice the layer is not playing.
// It narrows by `toneFamilyFor`, the SAME axis the grid's own tone menu groups
// by, so the two can never disagree about what a Key is.
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
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);

  const run = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    // A COLLAPSED CARD GETS NO SHEET — expand, THEN render.
    const repaint = async () => {
      const h = document.getElementById('bloom-v2-layers');
      const un = () => { const c = document.querySelector('.v2-layer'); if (c) c.classList.remove('collapsed'); };
      if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
      if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(140);
    };
    const openInstr = async () => {
      const d = document.querySelector('.v2-layer .v2-gototab[data-goto="Instrument"]');
      if (d) { d.click(); await wait(460); }
      return !!d;
    };
    const toTab = async (nm) => {
      const b = document.querySelector('.v2-layer .v2-pop-tabs [data-tab="' + nm + '"]');
      if (b) { b.click(); await wait(300); }
      return !!b;
    };
    const famSel = () => document.querySelector('.v2-pop-pane .v2-tonefam');
    const toneSel = () => document.querySelector('.v2-pop-pane select[data-f="instrument.tone"]');
    const toneVals = () => { const el = toneSel(); return el ? [...el.options].map((x) => x.value) : null; };
    const goSound = async () => { await openInstr(); await toTab('Sound'); };

    L().on = true; L().present = true; L().instrument.voice = 'synth';
    E.getCfg();
    await repaint(); await goSound();
    const o = {};
    o.door = !!famSel();
    o.famRect = (() => { const el = famSel(); if (!el) return null;
      const r = el.closest('.ambient-ctrl').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; })();
    o.famOpts = famSel() ? [...famSel().options].map((x) => x.value) : null;
    o.allN = (typeof _ambToneOptions === 'function') ? _ambToneOptions().length : 0;
    o.toneNAll = (toneVals() || []).length;
    // THE GRID VOICE — a real stored value the list did not contain
    o.hasGrid = (toneVals() || []).indexOf('') >= 0;
    L().instrument.tone = ''; E.getCfg();
    await repaint(); await goSound();
    o.gridShown = toneSel() ? toneSel().value : null;
    // ── NARROW IT ───────────────────────────────────────────────────
    // pick a family that is NOT the current tone's, with more than one member
    const counts = {};
    (typeof _ambToneOptions === 'function' ? _ambToneOptions() : []).forEach((x) => {
      const f = toneFamilyFor(x.value); counts[f] = (counts[f] || 0) + 1; });
    const fams = Object.keys(counts).filter((f) => counts[f] >= 2);
    o.pickFam = fams[0] || null;
    // set a tone from a DIFFERENT family first, so the keep-what-is-in-force
    // rule is actually exercised
    const other = (typeof _ambToneOptions === 'function' ? _ambToneOptions() : [])
      .find((x) => toneFamilyFor(x.value) !== o.pickFam);
    o.otherTone = other ? other.value : null;
    o.otherFam = other ? toneFamilyFor(other.value) : null;
    L().instrument.tone = o.otherTone; E.getCfg();
    await repaint(); await goSound();
    o.beforeFilter = { tone: L().instrument.tone, sel: toneSel() ? toneSel().value : null,
                       fam: famSel() ? famSel().value : null };
    { const el = famSel(); if (el) { el.value = o.pickFam; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    await wait(520); await goSound();
    const vals = toneVals() || [];
    o.after = {
      fam: famSel() ? famSel().value : null,
      tone: L().instrument.tone,                       // MUST NOT have moved
      sel: toneSel() ? toneSel().value : null,         // MUST still show it
      n: vals.length,
      keptCur: vals.indexOf(o.otherTone) >= 0,
      // everything else in the list belongs to the chosen family (the kept
      // current tone and the grid voice are the two allowed exceptions)
      pure: vals.filter((v) => v !== '' && v !== o.otherTone)
                .every((v) => toneFamilyFor(v) === o.pickFam),
      want: counts[o.pickFam],
    };
    // ── AND BACK TO ALL ─────────────────────────────────────────────
    { const el = famSel(); if (el) { el.value = 'all'; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    await wait(520); await goSound();
    o.backAll = { n: (toneVals() || []).length, tone: L().instrument.tone };
    // ── NOT FOR KIT OR SPEECH ───────────────────────────────────────
    L().instrument.voice = 'kit'; E.getCfg();
    await repaint(); await goSound();
    o.kitFam = (() => { const el = famSel(); if (!el) return -1;
      return Math.round(el.closest('.ambient-ctrl').getBoundingClientRect().height); })();
    L().instrument.voice = 'synth'; E.getCfg();
    return o;
  });

  ok('a Family row sits between Tone type and Tone, and is REACHABLE',
    run.door && run.famRect && run.famRect.w > 0 && run.famRect.h > 0,
    JSON.stringify(run.famRect));
  ok('…it offers All plus the families that actually have tones',
    Array.isArray(run.famOpts) && run.famOpts[0] === 'all' && run.famOpts.length > 2,
    JSON.stringify(run.famOpts));
  // The list the complaint was about.
  ok('…and unfiltered really is the whole wall — the reason this exists',
    run.allN > 40 && run.toneNAll >= run.allN,
    JSON.stringify({ tones: run.allN, inSelect: run.toneNAll }));
  // A pre-existing hole: `tone: ''` is a stored value the list did not contain.
  ok('the Grid voice is an option, so the default can show itself',
    run.hasGrid === true && run.gridShown === '',
    JSON.stringify({ hasGrid: run.hasGrid, shown: run.gridShown }));
  // ── THE TWO A FILTER CAN QUIETLY GET WRONG ───────────────────────────
  ok('narrowing to a family cuts the list down to that family',
    run.after.fam === run.pickFam && run.after.n < run.toneNAll && run.after.pure === true,
    JSON.stringify(run.after));
  ok('…and it does NOT change the sound — a filter narrows a list, nothing else',
    run.after.tone === run.otherTone && run.backAll.tone === run.otherTone,
    JSON.stringify({ was: run.otherTone, after: run.after.tone, back: run.backAll.tone }));
  ok('…and never hides the tone in force, even from another family',
    run.after.keptCur === true && run.after.sel === run.otherTone,
    JSON.stringify({ tone: run.otherTone, fam: run.otherFam, shown: run.after.sel }));
  ok('All puts the whole list back',
    run.backAll.n === run.toneNAll, JSON.stringify(run.backAll));
  ok('it is a SYNTH control — a kit list is a handful of kits, not a wall',
    run.kitFam <= 0, JSON.stringify(run.kitFam));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  families: ' + (run.famOpts || []).join(' · '));
  console.log('  ' + run.toneNAll + ' tones → ' + run.after.n + ' under "' + run.pickFam + '"');
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
