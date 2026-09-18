// PROBE — the reported layer, rebuilt from its own readout line:
//   VARIES: ornaments · N notes · 4 bars · 8s · take 17 · retaken: bar 3
//   · own rules: bar 1.31–1⅓ · as previewed        over D · Em · F♯m · G
//
// Draws it repeatedly and presses ▶ Preview between rounds. PLAIN REDRAWS were
// always stable; it is the PRESS that moved the picture, which is why "it still
// moves" and "six identical repaints" were both true at once.
//
// Measured 2026-09-18, the same fixture against both servers:
//   unfixed  — 4 distinct pictures in 9 rounds; pitches CREEP on each press
//              (64→64→65→67, 0→2→4→5, 93→93→95→96) as the progression rotates
//              under the notes and the walk follows the chord
//   fixed    — 1 distinct picture in 9 rounds
//
// Temporary: belongs in test/ui-lifecycle.js, which cannot run at this branch's
// HEAD (`.v2-capture` was removed from the card on 2026-09-17 and the gate
// still drives it in eight places).
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000 });
const page = await b.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
await page.goto(process.env.BLOOPS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
await zz(2500);
await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
await zz(600);
await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
await zz(600);
await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
  .find((x) => x.textContent.trim() === 'Layer').click(); });
await zz(900);
await page.evaluate(() => { _ambRebuildMaster(); });
await zz(800);
await page.evaluate(() => {
  const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
  const g = c.querySelector('.ambient-grp[data-v2grp="Content"]');
  const hd = g && g.querySelector('.ambient-grp-head'); if (hd) hd.click();
});
await zz(600);

await page.evaluate(() => {
  const E = _masterEng, cfg = E.getCfg();
  cfg.prog = { on: true, name: 'REPRO',
    chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
             { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] }] };
  const L = (cfg.layers || [])[0];
  L.part.kind = 'live';
  L.part.bars = 4;
  L.part.notes = [];
  L.part.take = 17;
  L.part.rhythm = { kind: 'euclid', pulses: 9, steps: 16, rotate: 3 };
  L.part.pitch = { kind: 'walk', span: 20 };
  L.instrument = Object.assign({}, L.instrument, { register: 4 });
  L.ornament = 30;                                // the sole VARIES reason
  L.part.takeb = { '3': 4 };                      // "retaken: bar 3"
  L.part.ruleb = { '1.31-1.33': { rhythm: { pulses: 5 } } };  // "own rules: bar 1.31–1⅓"
  E.getCfg();
  const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
  window._v2.render(E);
});
await zz(800);

const out = await page.evaluate(async () => {
  const E = _masterEng;
  const L = () => (E.getCfg().layers || [])[0];
  const read = () => {
    const c = document.querySelector('.v2-layer');
    const all = [...c.querySelectorAll('.v2-vizcv')];
    const cv = all.find((x) => x.offsetParent && x.getBoundingClientRect().height > 10) || all[0];
    const hits = (cv && cv._hits || []).slice().sort((a, b2) => a.t - b2.t);
    const lab = (cv && cv.closest('.v2-partviz') || c).querySelector('.v2-vizlab');
      // QUANTIZED TO A MUSICAL TICK, not to the millisecond. `t` is a fraction of
      // the cycle and the notes sit on the 1/48-bar grid, so t=0.9375 scaled by
      // 1000 is 937.5 — an exact rounding TIE that flips on a float ULP and
      // reports two identical pictures as different (the documented float-noise
      // class: an integer value lands at x.00000000000001 as often as not).
      // 960 is a whole multiple of every grid this app uses, so a grid position
      // never lands half-way.
    return { sig: hits.map((x) => Math.round(x.t * 960) + ':' + x.midi).join(' '),
             n: hits.length, lab: (lab ? lab.textContent : '').replace(/\s+/g, ' ').slice(0, 96) };
  };
  const draw = async () => {
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 400));
    return read();
  };
  const prev = async () => {
    window._v2.preview(E, L());
    await new Promise((r) => setTimeout(r, 750));
    window._v2.previewKill(E, L());
    await new Promise((r) => setTimeout(r, 150));
  };
  const rounds = [];
  // three plain redraws, then a preview press, three more, another press, …
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 2; i++) rounds.push(Object.assign({ tag: 'draw' }, await draw()));
    await prev();
    rounds.push(Object.assign({ tag: 'after preview' }, await draw()));
  }
  return { rounds, distinct: [...new Set(rounds.map((r) => r.sig))].length,
           counts: [...new Set(rounds.map((r) => r.n))] };
});

out.rounds.forEach((r, i) => console.log(
  '  ' + String(i + 1).padStart(2) + ' ' + r.tag.padEnd(14) + ' n=' + String(r.n).padStart(3) +
  '  ' + r.sig.slice(0, 88)));
const good = out.distinct === 1;
console.log((good ? '  \u2713 ' : '  \u2717 ') +
  'the picture holds still across preview presses \u2014 ' + out.distinct +
  ' distinct picture' + (out.distinct === 1 ? '' : 's') + ' in ' + out.rounds.length + ' rounds');
console.log('\nprobe: ' + (good ? '1 passed, 0 failed' : '0 passed, 1 failed'));
await b.close();
process.exit(good ? 0 : 1);
