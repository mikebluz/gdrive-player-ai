// PROBE — drawing the picture must not CHANGE the picture.
//
// THE BUG (2026-09-18): the Strum play order came from v1's `_ambStrumOrder`,
// which draws from `_ambRand` — the ENGINE-WIDE stream (`_E.rng`). `notesFor`
// is what the DRAWING asks, so merely repainting advanced the stream that
// decides the notes: one call made 118 writes to `_E.rng`. So the same take
// drew a different order on the next repaint (notes "moving around" with
// nothing changed), playback pulled at its own point in that stream and
// disagreed with the picture, and a v2 layer silently shifted every OTHER
// layer's draws as a side effect of being looked at.
//
// Temporary: this belongs in test/ui-lifecycle.js (and is there too), which
// cannot run at this branch's HEAD — `.v2-capture` was removed from the card on
// 2026-09-17 and the gate still drives it in eight places.
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
  // TWO layers: a shared-stream shift is also a CROSS-LAYER bug, and one layer
  // cannot show that half of it.
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
    await zz(600);
    await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click(); });
    await zz(900);
  }
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);
  await page.evaluate(() => {
    document.querySelectorAll('.v2-layer').forEach((c) => {
      c.classList.remove('collapsed');
      const g = c.querySelector('.ambient-grp[data-v2grp="Content"]');
      const hd = g && g.querySelector('.ambient-grp-head'); if (hd) hd.click();
    });
  });
  await zz(700);
  // STRUM ON, with FIDELITY — fidelity 0 is low→high every time and draws
  // nothing, so a fixture at 0 cannot see this at all.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: true, name: 'STREAM',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] }] };
    (cfg.layers || []).forEach((L, i) => {
      L.part.kind = 'live'; L.part.bars = 4; L.part.notes = [];
      L.part.rhythm = { kind: 'euclid', pulses: 7 + i, steps: 16, rotate: 3 };
      L.part.pitch = { kind: 'chord', span: 12, voices: 4 };
      L.strum = 45; L.strumFidelity = 70;
    });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(900);

  const run = await page.evaluate(async () => {
    const E = _masterEng;
    // READ THE VISIBLE CANVAS of each card — `.v2-vizcv` exists in both the card
    // body and the section sheet, and the first in DOM order can be the stale
    // hidden copy nothing has redrawn.
    const read = () => [...document.querySelectorAll('.v2-layer')].map((c) => {
      const all = [...c.querySelectorAll('.v2-vizcv')];
      const cv = all.find((x) => x.offsetParent && x.getBoundingClientRect().height > 10) || all[0];
      return (cv && cv._hits || []).slice().sort((a, b) => a.t - b.t)
        .map((x) => Math.round(x.t * 1000) + ':' + x.midi).join(' ');
    }).join(' || ');
    const draw = async () => {
      document.querySelectorAll('.v2-layer').forEach((c) => c.classList.remove('collapsed'));
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E);
      await new Promise((r) => setTimeout(r, 400));
      return read();
    };
    const shots = [];
    for (let i = 0; i < 6; i++) shots.push(await draw());
    const rngBefore = E.rng;
    const L0 = () => (E.getCfg().layers || [])[0];
    window._v2.withEdit(() => window._v2.withTake(window._v2.pinOf(L0()), () =>
      window._v2.notesFor(L0(), { E, cfg: E.getCfg(), key: 'v2:' + L0().id, cycleStart: 0, cycleSec: 8 })));
    const rngAfter = E.rng;
    return { shots, distinct: [...new Set(shots)].length, rngTouched: rngBefore !== rngAfter };
  });

  ok('six repaints in a row draw the SAME picture — nothing changed between them',
    run.distinct === 1,
    run.distinct + ' distinct pictures; first two: ' +
      (run.shots[0] || '').slice(0, 110) + '  |  ' + (run.shots[1] || '').slice(0, 110));
  ok('asking for the notes does not touch the engine’s shared RNG',
    !run.rngTouched, 'the draw consumed from _E.rng');
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
