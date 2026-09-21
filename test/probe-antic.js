// PROBE — an anticipated Groundwork part plays the SAME figure in every bar.
//
// user: "changes to Character seem to introduce onset timing irregularities,
// like they hit too early after the very first one". ⛰ Comp switches on Arrive
// (`rhythm.antic`), which pulls each change an 8th early. The cycle's own top
// used to be excluded — nothing precedes it to arrive early from — so bar 1
// played the comp figure straight and every later bar pushed, and the part
// came out as one 750ms gap followed by an even 1000ms pulse for ever:
//
//     before   0 · 750 · 1750 · 2750 · 3750 · 4750
//     after    750 · 1750 · 2750 · 3750 · 4750 · 5750
//
// The anticipation of the first change WRAPS to the end of the cycle now,
// which is where it sounds in a part that loops.
//
//   node test/probe-antic.js        (needs `npm start` on :3001)
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
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
                       { root: 5, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);

  const r = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const Lat = () => (E.getCfg().layers || [])[0];
    const L0 = Lat(); L0.part.kind = 'live'; L0.part.notes = []; E.getCfg();
    const onsets = () => {
      const L = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(V.pinOf(L), () => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 }))) || [];
      return [...new Set(ns.map((n) => Math.round(n.at * 1000)))].sort((a, b) => a - b);
    };
    const grab = (pid) => {
      const L = Lat(); L.part.kind = 'live'; L.part.notes = []; E.getCfg();
      V.applyPreset(E, Lat(), pid); E.getCfg();
      return { antic: (Lat().part.rhythm || {}).antic || 0, on: onsets() };
    };
    const out = { comp: grab('comp'), held: grab('held'), stabs: grab('stabs') };
    // …and the same Comp with Arrive off, which must be the plain comp figure
    V.applyPreset(E, Lat(), 'comp'); E.getCfg();
    delete Lat().part.rhythm.antic; E.getCfg();
    out.compOff = { antic: 0, on: onsets() };
    // …and the ORDER the seam returns, which a wrapped onset can break
    const L = Lat();
    V.applyPreset(E, Lat(), 'comp'); E.getCfg();
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const raw = V.withEdit(() => V.withTake(V.pinOf(Lat()), () => V.notesFor(Lat(),
      { E, cfg: E.getCfg(), key: 'v2:' + Lat().id, cycleStart: 0, cycleSec: 6 }))) || [];
    out.ordered = raw.every((n, i) => i === 0 || n.at >= raw[i - 1].at - 1e-9);
    const durList = () => {
      const L2 = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns2 = V.withEdit(() => V.withTake(V.pinOf(L2), () => V.notesFor(L2,
        { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 6 }))) || [];
      const byT = {};
      ns2.forEach((n) => { const t = Math.round(n.at * 1000); byT[t] = Math.round(n.durMs); });
      return Object.keys(byT).map(Number).sort((a, b) => a - b).map((t) => byT[t]);
    };
    out.durs = { on: durList() };
    delete Lat().part.rhythm.antic; E.getCfg();
    out.durs.off = durList();
    V.applyPreset(E, Lat(), 'comp'); E.getCfg();
    out.lastEnd = Math.round(Math.max.apply(null, raw.map((n) => n.at * 1000 + n.durMs)));
    return out;
  });

  const gaps = (a) => a.slice(1).map((t, i) => t - a[i]);
  console.log('\n  ⛰ Groundwork onsets over 3 bars (6s):\n');
  console.log('   Comp (Arrive on)   ' + r.comp.on.join(' · '));
  console.log('     gaps             ' + gaps(r.comp.on).join(' · '));
  console.log('   Comp (Arrive off)  ' + r.compOff.on.join(' · '));
  console.log('     gaps             ' + gaps(r.compOff.on).join(' · '));
  console.log('   Held               ' + r.held.on.join(' · '));
  console.log('   Stabs              ' + r.stabs.on.join(' · ') + '\n');

  ok('⛰ Comp switches Arrive on', r.comp.antic === 1, JSON.stringify(r.comp.antic));
  // THE REPORT, AS A CHECK: one odd gap then an even pulse for ever.
  ok('every bar of an anticipated part plays the SAME figure',
    new Set(gaps(r.comp.on)).size === 1,
    'gaps: ' + gaps(r.comp.on).join(' · '));
  ok('…and nothing is left sitting on the cycle’s own downbeat',
    r.comp.on[0] > 0, 'first onset at ' + r.comp.on[0] + 'ms');
  ok('…the wrapped anticipation lands an 8th before the next pass',
    r.comp.on[r.comp.on.length - 1] === 5750,
    'last onset at ' + r.comp.on[r.comp.on.length - 1] + 'ms');
  // IT IS SUPPOSED TO OVERHANG. An anticipation sounds early and HOLDS
  // THROUGH the downbeat it anticipates — `dm0 += anticK` does that for every
  // anticipated note, and for the wrapped one "through the downbeat" means
  // across the loop seam. What it must NOT do is run over the next pass's
  // first hit, which on this part is 6000 + 750.
  ok('…and it holds through the seam without covering the next pass\u2019s first hit',
    r.lastEnd > 6000 && r.lastEnd < 6750,
    'last note ends at ' + r.lastEnd + 'ms (seam 6000, next hit 6750)');
  ok('the seam still returns its notes in time order', r.ordered === true,
    'a wrapped onset is generated first and sounds last');

  console.log('');
  ok('Arrive off is the plain comp figure — the 1 and the & of 2',
    JSON.stringify(r.compOff.on) === JSON.stringify([0, 750, 2000, 2750, 4000, 4750]),
    JSON.stringify(r.compOff.on));
  ok('a Character WITHOUT Arrive is untouched by any of this',
    JSON.stringify(r.held.on) === JSON.stringify([0, 2000, 4000]) &&
    JSON.stringify(r.stabs.on) === JSON.stringify([0, 1000, 2000, 3000, 4000, 5000]),
    'held ' + JSON.stringify(r.held.on) + '  stabs ' + JSON.stringify(r.stabs.on));

  // ── AND THE KNOB THAT CAUSES IT SAYS SO ─────────────────────────────────
  // user: "why are chords different lengths". Arrive is the only thing that
  // alternates them — the anticipated chord is held an 8th longer and the one
  // ahead of it gives that 8th up — and its hint was EMPTY.
  console.log('  chord lengths on ⛰ Comp:\n');
  console.log('   Arrive on    ' + r.durs.on.join(' · '));
  console.log('   Arrive off   ' + r.durs.off.join(' · ') + '\n');
  // A NOTE FILLS THE SPACE IT ACTUALLY HAS. Under Arrive every change is
  // anticipated, so the onsets come out evenly spaced — and the lengths must
  // follow them. They did not: `gapAt` measured the GRID, which Arrive does
  // not move, so a part with even onsets had lengths alternating 250 · 550
  // ("still differing lengths on reroll").
  ok('with Arrive on, every chord is the same length',
    new Set(r.durs.on).size === 1,
    JSON.stringify(r.durs.on));
  ok('…and that length is Note length % of the space it has (40% of 1000ms)',
    r.durs.on[0] === 400, r.durs.on[0] + 'ms of a 1000ms gap at 40%');
  // …and with Arrive OFF the comp grid is genuinely uneven — 750 and 1250 —
  // so its lengths SHOULD differ. Even lengths there would be the bug.
  ok('with Arrive off, the comp figure\u2019s own unevenness still shows',
    new Set(r.durs.off).size === 2 &&
    r.durs.off[0] === 300 && r.durs.off[1] === 500,
    JSON.stringify(r.durs.off));

  {
    const c = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      if (card.classList.contains('collapsed')) card.querySelector('.ambient-collapse').click();
      return true;
    });
    await zz(900);
    await page.evaluate(() => {
      window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
    });
    await zz(1300);
    const h = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      const el = [...card.querySelectorAll('.v2-genwrap .v2-f[data-f="part.rhythm.antic"]')][0];
      const row = el && el.closest('.ambient-ctrl');
      if (!row) return { err: 'no Arrive row' };
      const hint = row.querySelector('.ambient-hint');
      const hr = hint && hint.getBoundingClientRect();
      const pr = row.getBoundingClientRect();
      const sel = row.querySelector('select');
      return {
        text: hint ? hint.textContent.trim() : '',
        wide: !!(hr && pr && hr.width > pr.width * 0.6),
        fits: !!(hint && hint.scrollWidth <= hint.clientWidth + 1),
        selW: sel ? Math.round(sel.getBoundingClientRect().width) : 0,
      };
    });
    console.log('   Arrive hint: “' + (h.text || h.err) + '”');
    console.log('   select ' + h.selW + 'px, hint full-width=' + h.wide + '\n');
    ok('the Arrive control explains what it does',
      !!h.text && /8th/.test(h.text) && /share of the space/.test(h.text),
      JSON.stringify(h.text || h.err));
    ok('…and its sentence does not squeeze the select beside it',
      h.wide === true && h.fits === true && h.selW > 80,
      'select ' + h.selW + 'px, wide=' + h.wide + ', fits=' + h.fits);
  }

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
