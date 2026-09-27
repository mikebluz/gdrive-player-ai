// PROBE — ✺ JITTER: WHITE OR PINK, A PARALLEL MODE BEHIND A SWITCH.
//
// user, 2026-09-27: "make it a parallel mode gated behind a switch".
//
// Musical expression is empirically 1/f. White noise at 60 reads as broken, pink at 60
// reads as intentional — which is why every variance die ships with a CEILING instead of
// its full range. This offers the other character without taking the first away:
// `grooveNoise` ('white' = default AND absent) rides the existing groove snapshot, and the
// Humanize family asks `_ambHumanPM1` / `_ambVelJitter01` for it.
//
// The claims worth pinning are the MATH, not just the wiring:
//   · pink is genuinely 1/f      — lag-1 autocorrelation strongly positive; white ≈ 0
//   · the knob keeps its meaning — the two modes carry the SAME RMS (÷√K, not ÷K)
//   · it is still reproducible   — stateless Voss, so same position = same value
//
//   node test/probe-pinkjitter.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(900);

  console.log('\n  ✺ the default');
  const dflt = await page.evaluate(() => ({
    mode: window._bloopsNoiseMode ? window._bloopsNoiseMode() : 'MISSING',
    door: typeof window._bloopsHumanPM1,
  }));
  ok('white is the default — absent means the behaviour that shipped', dflt.mode === 'white',
    JSON.stringify(dflt));
  ok('…and the one door is published for the grid scheduler', dflt.door === 'function',
    JSON.stringify(dflt.door));

  // ── THE SWITCH, THROUGH ITS REAL DOOR ────────────────────────────────────
  // A `querySelector` hit proves nothing — a 0×0 rect is the tell — so the row is
  // MEASURED in the view the user actually has open, then driven with a real touch.
  console.log('\n  ✺ the switch is reachable');
  await page.evaluate(() => { const b = document.getElementById('bloom-hdr-elapsed');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(700);
  const reach = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.gv-noise-opt')];
    const pk = bs.find((b) => b.dataset.noise === 'pink') || null;
    const r = pk ? pk.getBoundingClientRect() : null;
    return { n: bs.length, labels: bs.map((b) => b.textContent.trim()),
             lit: ((bs.find((b) => b.classList.contains('active')) || {}).dataset || {}).noise || '',
             readout: (document.querySelector('#gv-noise-v') || {}).textContent,
             reach: !!(pk && pk.offsetParent && r.width > 20 && r.height > 14),
             rect: r ? [Math.round(r.width), Math.round(r.height)] : null,
             at: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
             titled: !!(pk && (pk.getAttribute('title') || '').length > 20) };
  });
  ok('the Groove panel offers White · Pink', JSON.stringify(reach.labels) === '["White","Pink"]',
    JSON.stringify(reach));
  ok('…measurable, not merely present', reach.reach === true, JSON.stringify([reach.rect, reach.reach]));
  ok('…White is lit, and the readout names it',
    reach.lit === 'white' && reach.readout === 'white', JSON.stringify([reach.lit, reach.readout]));
  ok('…and Pink says what it does, in words', reach.titled === true, JSON.stringify(reach.titled));

  ok('a real touch lands on Pink', !!reach.at);
  if (reach.at) await page.touchscreen.tap(reach.at.x, reach.at.y);
  await zz(500);
  const after = await page.evaluate(() => ({
    mode: window._bloopsNoiseMode(),
    lit: ((document.querySelector('.gv-noise-opt.active') || {}).dataset || {}).noise || '',
    readout: (document.querySelector('#gv-noise-v') || {}).textContent,
  }));
  ok('…the switch flips, and the panel follows it',
    after.mode === 'pink' && after.lit === 'pink' && after.readout === 'pink',
    JSON.stringify(after));

  // ── THE MATH ─────────────────────────────────────────────────────────────
  console.log('\n  ✺ pink is actually 1/f');
  const math = await page.evaluate(() => {
    const N = 4096;
    // the pink index steps once per 1/16 s, so that is the sample spacing
    const draw = () => { const a = []; for (let i = 0; i < N; i++) a.push(window._bloopsHumanPM1(i / 16)); return a; };
    const stats = (a) => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      let v = 0, c = 0;
      for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
      for (let i = 1; i < a.length; i++) c += (a[i] - m) * (a[i - 1] - m);
      return { rms: Math.sqrt(v / a.length), r1: c / v };
    };
    const pinkA = draw();
    const pinkB = draw();                       // same positions, second time
    const repeats = pinkA.every((x, i) => x === pinkB[i]);
    const P = stats(pinkA);
    // …and the same sweep in white
    document.querySelectorAll('.gv-noise-opt').forEach((b) => { if (b.dataset.noise === 'white') b.click(); });
    const W = stats(draw());
    const mode = window._bloopsNoiseMode();
    return { P, W, repeats, backToWhite: mode };
  });
  // THE FIGURES ARE PRINTED EITHER WAY — a threshold that passes silently tells you
  // nothing about how close it came, which is how a marginal number goes unnoticed
  // until it flakes (the mod-parity lesson, in miniature).
  console.log('      measured: pink r1=' + math.P.r1.toFixed(3) + ' rms=' + math.P.rms.toFixed(4) +
              '  ·  white r1=' + math.W.r1.toFixed(3) + ' rms=' + math.W.rms.toFixed(4) +
              '  ·  rms ratio=' + (math.P.rms / math.W.rms).toFixed(3));
  ok('pink DRIFTS — lag-1 autocorrelation strongly positive',
    math.P.r1 > 0.35, 'r1=' + math.P.r1.toFixed(3));
  ok('…white does not — each onset is independent',
    Math.abs(math.W.r1) < 0.15, 'r1=' + math.W.r1.toFixed(3));
  ok('…and the knob keeps its meaning: the two modes carry the SAME RMS',
    Math.abs(math.P.rms / math.W.rms - 1) < 0.15,
    'pink=' + math.P.rms.toFixed(4) + ' white=' + math.W.rms.toFixed(4) +
    ' ratio=' + (math.P.rms / math.W.rms).toFixed(3));
  ok('…pink is STATELESS — the same positions replay exactly', math.repeats === true,
    JSON.stringify(math.repeats));
  ok('…and the switch goes back', math.backToWhite === 'white', JSON.stringify(math.backToWhite));

  // ── IT SURVIVES A RELOAD, AND ABSENT STILL MEANS WHITE ───────────────────
  console.log('\n  ✺ it persists, and absence is white');
  await page.evaluate(() => {
    document.querySelectorAll('.gv-noise-opt').forEach((b) => { if (b.dataset.noise === 'pink') b.click(); });
    try { persistWorkspace(); } catch (e) {}
  });
  await zz(800);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await zz(3000);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(1200);
  const kept = await page.evaluate(() => window._bloopsNoiseMode());
  ok('the pick survives a reload', kept === 'pink', JSON.stringify(kept));
  const absent = await page.evaluate(() => {
    // a groove record from BEFORE this existed carries no `noise` at all
    if (typeof _ambApplyGroove === 'function') _ambApplyGroove({ swing: 0, accentAmt: 35 });
    return window._bloopsNoiseMode();
  });
  ok('…and a groove record with no `noise` reads as white, not as undefined',
    absent === 'white', JSON.stringify(absent));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
