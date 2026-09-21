// PROBE — ⚙ Deep's picture does not change when you press ▶ Preview.
//
// user: "something is off with the visualizer in Deep where when I first open
// it, it shows one way, then when i press Preview, it changes to this".
//
// The staged drawing asked for the draft at `cycleStart: 0` but left the
// GLOBAL progression anchors wherever the transport last put them — so the
// draft was drawn against a progression that started somewhere in its middle.
// ▶ Preview supplies its own clocks, so the moment it ran, the picture redrew
// correctly. The one you saw FIRST was the wrong one.
//
// THE ANCHOR MUST NOT BE ZERO IN THIS TEST. At zero the two agree by accident
// and the bug is invisible — which is why it survived the earlier pass that
// fixed the previewing half.
//
//   node test/probe-stagestable.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

const ANCHOR = 3.37;   // anything but 0 — see the note above

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
    // three DIFFERENT chords — a part drawn against the wrong origin repeats
    // one of them, which is only visible if they differ
    cfg.prog.chords = [{ root: 6, intervals: [0, 3, 7] }, { root: 9, intervals: [0, 4, 7, 11] },
                       { root: 7, intervals: [0, 4, 7, 10] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  // the reported setup: Play the changes · Comp · a Walk line · Evolve
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = []; E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'comp');
    E.getCfg();
    const L2 = (E.getCfg().layers || [])[0];
    const g = L2.part.ground || (L2.part.ground = {});
    const bag = g.parts || (g.parts = {});
    (bag['0'] || (bag['0'] = {})).mel = { rate: 4, kind: 'walk', oct: 1, len: 80, vel: 70, on: 1 };
    L2.chg = { ev: 1, am: 100 };
    E.getCfg(); window._v2.render(E);
  });
  await zz(900);
  await page.evaluate((a) => {
    const E = _masterEng;
    E._progAnchor = a; E._playStartAt = a; E._barGridAnchor = a;
  }, ANCHOR);
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    if (card.classList.contains('collapsed')) card.querySelector('.ambient-collapse').click();
  });
  await zz(900);
  await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-genbtn');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
  });
  await zz(1500);

  const shot = () => page.evaluate(() => {
    // `.v2-stagecv` matches TWICE — ✨ Quick's and ⚙ Deep's. Quick is shut.
    const cv = document.querySelector('.v2-layer .v2-genwrap .v2-stagecv');
    if (!cv || !(cv.clientWidth > 0)) return { err: 'no staged canvas' };
    const g = cv._plotGeo || {};
    const hits = cv._hits || [];
    return {
      n: hits.length,
      sig: hits.map((h) => Math.round((h.t || 0) * (g.cyc || 6) * 1000) + ':' + h.midi).join(' '),
      // DISTINCT CHORDS, not distinct pitches. A part drawn against the wrong
      // origin repeats ONE chord in every bar — but its line notes still
      // wander, so counting pitches finds plenty and proves nothing. (It did:
      // this check passed under the poison until it counted stacks instead.)
      chords: (() => {
        const byT = {};
        hits.forEach((h) => { const t = Math.round((h.t || 0) * (g.cyc || 6) * 1000);
          (byT[t] = byT[t] || []).push(h.midi); });
        const stacks = Object.keys(byT).map((t) => byT[t].slice().sort((a, b) => a - b))
          .filter((a) => a.length >= 3).map((a) => a.join(','));
        return new Set(stacks).size;
      })(),
    };
  });

  const before = await shot();
  if (before.err) { console.log('  ' + before.err); await browser.close(); process.exit(2); }

  const heard = await page.evaluate(() => {
    const orig = window.playNote;
    const got = [];
    window.playNote = function (f, params, dur, at) { got.push({ f, at }); return orig.apply(this, arguments); };
    const b2 = document.querySelector('.v2-layer .v2-genprev');
    const found = !!b2;
    if (b2) b2.click();
    window.playNote = orig;
    const pv = window._v2.previewCycle();
    const cs = pv ? pv.at : 0;
    return { found, n: got.length, cs,
      keys: got.map((x) => Math.round((x.at - cs) * 1000) + ':' +
        Math.round(69 + 12 * Math.log2((x.f || 440) / 440))) };
  });
  await zz(900);
  const after = await shot();

  console.log('\n  ⚙ Deep, progression clock at ' + ANCHOR + 's (not zero):\n');
  console.log('   on open      ' + before.n + ' notes   ' + before.sig.slice(0, 84) + '…');
  console.log('   after ▶      ' + after.n + ' notes   ' + after.sig.slice(0, 84) + '…\n');

  ok('▶ Preview is offered in the panel', heard.found === true);
  ok('the picture on OPEN is the picture after ▶ Preview',
    before.sig === after.sig,
    'they differ — the one you see first is drawn against a different clock');
  ok('…and it follows the changes rather than repeating one chord',
    before.chords >= 3, before.chords + ' distinct chord stacks drawn');

  // …and the picture is what SOUNDS, which is the point of the panel
  {
    const inCyc = heard.keys.filter((k) => { const t = parseInt(k, 10); return t >= -2 && t < 6000; });
    const dset = new Set(before.sig.split(' '));
    const near = (k, set) => { const p2 = k.split(':'); const t = +p2[0], m = p2[1];
      for (let d = -2; d <= 2; d++) if (set.has((t + d) + ':' + m)) return true; return false; };
    const extra = inCyc.filter((k) => !near(k, dset));
    ok('every note heard was already in the picture you opened on',
      extra.length === 0, extra.length + ' heard that were not drawn: ' + extra.slice(0, 6).join(' '));
  }

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
