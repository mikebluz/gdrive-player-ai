// PROBE — 🧂 Salt turns off and back on, and a pass can differ.
//
// user, 2026-09-23: "need to be able to toggle Salt on/off, which can then also
// be scheduled (have some passes Salted and some not)".
//
// Salt is FIVE axes across TWO stores (`salt.colors` / `salt.scatter`, and
// `prog.vary` / `prog.tension` / `prog.reroll`), and this panel's own title
// already defines the off state: "everything at 0 = play exactly as written".
// So the switch zeroes the five and remembers them, rather than gating 28 read
// sites — every one of which already treats 0 as off.
//
// PER PASS WAS ALREADY IN THE MODEL: `_ambPartSaltAt` reads
// `passSalt[<pass>]` and takes an explicit zero as "OFF on this pass". What was
// missing was any way to say off at all; this is the area rung of that ladder.
//
//   node test/probe-salt-toggle.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(800);

  const setUp = () => page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog.on = true;
    cfg.prog.chords = [
      { root: 2, intervals: [0, 4, 7], bars: 3 },
      { root: 6, intervals: [0, 3, 7], bars: 4 },
      { root: 7, intervals: [0, 4, 7], bars: 1 }];
    cfg.barsPerChord = 2;
    // THE REPORTED SETTINGS — the five dials from the screenshot.
    cfg.prog.salt = { colors: 3, scatter: 35 };
    cfg.prog.vary = 45; cfg.prog.tension = 45; cfg.prog.reroll = 50;
    E.getCfg();
    const p = E.getCfg().prog;
    return { colors: (p.salt || {}).colors, scatter: (p.salt || {}).scatter,
             vary: p.vary, tension: p.tension, reroll: p.reroll,
             cfgOn: !!_ambProgSaltCfg(E.getCfg()) };
  });
  const state = () => page.evaluate(() => {
    const p = _masterEng.getCfg().prog;
    return { colors: (p.salt || {}).colors, scatter: (p.salt || {}).scatter,
             vary: p.vary, tension: p.tension, reroll: p.reroll,
             was: (p.salt || {}).was || null,
             cfgOn: !!_ambProgSaltCfg(_masterEng.getCfg()) };
  });
  const tapToggle = () => page.evaluate(() => {
    // BY CLASS, NOT BY ID. Every instance prefixes its ids (the Mix engine's is
    // `mix-bloom-…`), so the bare id matches nothing — the documented trap that
    // made this probe report a control it was looking at.
    const b = document.querySelector('.ambient-salt-onoff');
    if (!b) return { there: false };
    const r = b.getBoundingClientRect();
    b.click();
    return { there: true, wasVisible: r.width > 0 && r.height > 0 };
  });

  const on0 = await setUp();
  console.log('\n  salted: ' + JSON.stringify(on0));
  ok('the area starts salted, and the engine agrees',
    on0.colors === 3 && on0.vary === 45 && on0.cfgOn === true, JSON.stringify(on0));

  const t1 = await tapToggle();
  await zz(500);
  const off1 = await state();
  console.log('  after off: ' + JSON.stringify(off1));
  ok('there is a 🧂 Salt switch to press', t1.there === true, JSON.stringify(t1));
  ok('…and off means every axis is 0, which is "as written"',
    !off1.colors && !off1.scatter && !off1.vary && !off1.tension && !off1.reroll,
    JSON.stringify(off1));
  ok('…the engine stops reading salt at all',
    off1.cfgOn === false, JSON.stringify(off1.cfgOn));
  ok('…and what it WAS is remembered, not thrown away',
    !!off1.was && off1.was.colors === 3 && off1.was.vary === 45 &&
    off1.was.tension === 45 && off1.was.reroll === 50 && off1.was.scatter === 35,
    JSON.stringify(off1.was));

  // THE MEMORY HAS TO SURVIVE THE MIGRATION CHOKEPOINT — an all-zero salt is
  // pruned, and the remembered values would have gone with it.
  const survived = await page.evaluate(() => {
    const E = _masterEng; E.getCfg(); E.getCfg(); E.getCfg();
    return (E.getCfg().prog.salt || {}).was || null;
  });
  ok('…and survives normalize, which prunes an all-zero salt',
    !!survived && survived.colors === 3, JSON.stringify(survived));

  await tapToggle();
  await zz(500);
  const on1 = await state();
  console.log('  after on:  ' + JSON.stringify(on1) + '\n');
  ok('turning it back on restores exactly what it was',
    on1.colors === 3 && on1.scatter === 35 && on1.vary === 45 &&
    on1.tension === 45 && on1.reroll === 50 && on1.cfgOn === true,
    JSON.stringify(on1));
  ok('…and the memory is cleared once it is back',
    on1.was === null, JSON.stringify(on1.was));

  // ── AND A SINGLE PASS CAN DIFFER ────────────────────────────────────────
  // Already in the model — `_ambPartSaltAt` takes an explicit zero on a pass as
  // OFF for that pass. Checked here so the second half of the request is not
  // taken on trust.
  const perPass = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog.passSalt = { '1': { colors: 0 } };     // pass 2 unsalted
    E.getCfg();
    const p = E.getCfg().prog;
    return { stored: !!(p.passSalt && p.passSalt['1']),
             zero: p.passSalt && p.passSalt['1'] ? (p.passSalt['1'].colors | 0) : null };
  });
  console.log('  per-pass override: ' + JSON.stringify(perPass) + '\n');
  ok('a single pass can be marked unsalted, and it survives normalize',
    perPass.stored === true && perPass.zero === 0, JSON.stringify(perPass));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
