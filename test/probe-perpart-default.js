// PROBE — ◫ Per part is the default once parts exist.
//
// user, 2026-09-23: "if there are parts defined, new layers should be created
// with Per Part mode on so they sync to the layer automatically, not-sync'ed
// should be opt-in if parts exist".
//
// WHY IT MATTERS, measured across five reports: a record's `bars` is written
// once and only ONE thing ever revises it — the reconciler in `normalizeAll`,
// gated on `Number.isFinite(partFor)`. A BOUND layer follows the cadence for
// ever; an UNBOUND one keeps whatever length it was built with and laps the
// part by the difference every pass ("an extra beat jammed in at the end of
// the first pass").
//
//   node test/probe-perpart-default.js     (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(700);

  // ── NO PARTS: NOTHING CHANGES ───────────────────────────────────────────
  // A layer has always arrived unbound, and with nothing to bind to it must
  // keep arriving that way — this is additive, not a new requirement.
  const bare = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog.on = false;
    cfg.layers = [];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
    const L = window._v2.addDefault(E);
    return { partFor: L ? L.partFor : 'no layer', bound: !!(L && Number.isFinite(L.partFor)) };
  });
  console.log('\n  no parts: ' + JSON.stringify(bare));
  ok('with no parts a new layer arrives unbound, exactly as before',
    bare.bound === false, JSON.stringify(bare));

  // ── PARTS DEFINED: BOUND ON ARRIVAL ─────────────────────────────────────
  const withParts = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog.on = true;
    // THE REPORTED CADENCE — 3 · 4 · 1 = 8 bars — and two named parts over it.
    cfg.prog.chords = [
      { root: 2, intervals: [0, 4, 7], bars: 3 },
      { root: 6, intervals: [0, 3, 7], bars: 4 },
      { root: 7, intervals: [0, 4, 7], bars: 1 },
      { root: 4, intervals: [0, 3, 7], bars: 4 }];
    cfg.barsPerChord = 2;
    cfg.prog.parts = [{ name: 'A', len: 3 }, { name: 'B', len: 1 }];
    delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    cfg.layers = [];
    E.getCfg();
    const L = window._v2.addDefault(E);
    const cad = (pi) => Math.round(_ambLenPartBars(E.getCfg(), pi) * 1000) / 1000;
    return { partFor: L ? L.partFor : null,
             bound: !!(L && Number.isFinite(L.partFor)),
             hasIce: !!(L && L.partAll),
             bars: L ? L.part.bars : null,
             partBars: L && Number.isFinite(L.partFor) ? cad(L.partFor | 0) : null };
  });
  console.log('  parts defined: ' + JSON.stringify(withParts));
  ok('with parts defined a new layer arrives BOUND to one',
    withParts.bound === true, JSON.stringify(withParts));
  ok('…with its length already the part’s, not a default 2',
    withParts.bars === withParts.partBars, JSON.stringify(withParts));
  ok('…and the Everywhere record iced, so turning it off is a real inverse',
    withParts.hasIce === true, JSON.stringify(withParts));

  // ── AND THAT IS WHAT MAKES IT SELF-HEAL ─────────────────────────────────
  // The whole point: a bound record follows the cadence. Push the length out of
  // true and normalize must pull it back — this is the behaviour an unbound
  // layer does not have, and the reason five reports ended in a drift.
  const heals = await page.evaluate(() => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    const want = Math.round(_ambLenPartBars(E.getCfg(), L().partFor | 0) * 1000) / 1000;
    L().part.bars = 8.125; E.getCfg(); E.getCfg();
    return { want, after: L().part.bars };
  });
  console.log('  knocked to 8.125 → ' + heals.after + ' (part is ' + heals.want + ')\n');
  ok('a bound record snaps back to its part’s length on normalize',
    heals.after === heals.want, JSON.stringify(heals));

  // ── OPTING OUT IS STILL THERE ───────────────────────────────────────────
  // "not-sync'ed should be opt-in" — so the way OUT has to keep working, and
  // it has to restore the Everywhere record rather than just dropping a field.
  const optOut = await page.evaluate(() => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    const before = { bound: Number.isFinite(L().partFor), ice: !!L().partAll };
    const moved = window._v2.partSelect(E, L(), null);
    E.getCfg();
    return { before, moved, after: { bound: Number.isFinite(L().partFor), ice: !!L().partAll } };
  });
  console.log('  opt out: ' + JSON.stringify(optOut) + '\n');
  ok('per part can still be turned off, and the ice comes back as the record',
    optOut.moved === true && optOut.after.bound === false && optOut.after.ice === false,
    JSON.stringify(optOut));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
