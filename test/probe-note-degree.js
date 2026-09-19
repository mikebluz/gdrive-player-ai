// PROBE — Note is capped to the tones that exist, and says what it picks.
//
// "cap it to the available tones, and make it clear this is selecting an
// inversion". Every branch that reads `Note` does `clamp(degree - 1, 0, N - 1)`,
// so a stepper offering 1-12 over a triad had THREE live values and nine that
// silently repeated the third — measured before this: Note 4 and Note 3 both
// gave G4 C5 E5.
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
    const TRIAD = [{ root: 0, intervals: [0, 4, 7], bars: 1 }];
    const SEVENTH = [{ root: 0, intervals: [0, 4, 7, 11], bars: 1 }];
    const setProg = (ch) => { const c = E.getCfg(); c.prog = { on: true, name: 'P', chords: ch };
      E._progAnchor = 0; E._barGridAnchor = 0; E._playStartAt = 0; E.getCfg(); };
    setProg(TRIAD);
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.bars = 1; L().part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    L().instrument.register = 4;
    L().part.pitch = { kind: 'stack', degree: 1, voices: 3 };
    E.getCfg();
    const repaint = async () => {
      const h = document.getElementById('bloom-v2-layers');
      const un = () => { const c = document.querySelector('.v2-layer'); if (c) c.classList.remove('collapsed'); };
      if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
      if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(140);
    };
    const openInstr = async () => {
      // PITCH LIVES IN GENERATE (2026-09-18) — it answers what the layer PLAYS,
      // not what it sounds like.
      const d = document.querySelector('.v2-layer .v2-gototab[data-goto="Generate"]');
      if (d) { d.click(); await wait(460); }
      // NOTE IS UNDER PITCH (2026-09-18) — it is a sub-param of the pitch
      // choice, not a sibling of it, so it stopped being a chip of its own.
      const b = document.querySelector('.v2-layer .v2-pop-tabs [data-tab="Pitch"]');
      if (b) { b.click(); await wait(300); }
      return !!b;
    };
    const el = () => document.querySelector('.v2-pop-pane .v2-f[data-f="part.pitch.degree"]');
    const hintOf = () => { const e2 = el(); const row = e2 && e2.closest('.ambient-ctrl');
      const hn = row && row.querySelector('.ambient-hint:not(.ambient-sl-v)');
      return hn ? hn.textContent.trim() : null; };
    const o = {};
    await repaint(); o.tab = await openInstr();
    o.triad = { max: el() ? el().getAttribute('max') : null, hint: hintOf() };
    // …and it NAMES the inversion as you move
    L().part.pitch.degree = 2; E.getCfg(); await repaint(); await openInstr();
    o.inv1 = hintOf();
    L().part.pitch.degree = 3; E.getCfg(); await repaint(); await openInstr();
    o.inv2 = hintOf();
    // THE + BUTTON CANNOT GO PAST THE TOP
    { const e2 = el(); const up = e2 && document.querySelector(
        '.v2-pop-pane .ambient-step-up[data-step="' + e2.id + '"]');
      o.hasUp = !!up;
      if (up) { for (let i = 0; i < 4; i++) { up.click(); await wait(180); } } }
    await wait(260);
    o.capped = (L().part.pitch.degree | 0);
    // VOICES ≠ THE CHORD'S SIZE is not an inversion, and it says so
    L().part.pitch = { kind: 'stack', degree: 2, voices: 2 }; E.getCfg();
    await repaint(); await openInstr();
    o.dyad = hintOf();
    // A DIFFERENT PITCH KIND asks a different question
    L().part.pitch = { kind: 'fixed', degree: 1 }; E.getCfg();
    await repaint(); await openInstr();
    o.fixed = hintOf();
    // A BIGGER CHORD RAISES THE CEILING
    L().part.pitch = { kind: 'stack', degree: 1, voices: 4 };
    setProg(SEVENTH); await repaint(); await openInstr();
    o.seventh = { max: el() ? el().getAttribute('max') : null, hint: hintOf() };
    // A STORED VALUE ABOVE THE CEILING IS NOT CAPPED AWAY
    L().part.pitch = { kind: 'stack', degree: 6, voices: 3 };
    setProg(TRIAD); await repaint(); await openInstr();
    o.stored = { max: el() ? el().getAttribute('max') : null, val: el() ? el().value : null,
                 kept: (L().part.pitch.degree | 0) };
    return o;
  });

  ok('over a TRIAD the stepper tops out at 3, not 12',
    run.tab && run.triad.max === '3', JSON.stringify(run.triad));
  ok('…and it says what it is picking — an inversion, named',
    /which inversion/.test(run.triad.hint || '') && /root position/.test(run.triad.hint || ''),
    JSON.stringify(run.triad.hint));
  ok('…naming each one as you move through them',
    /1st inversion/.test(run.inv1 || '') && /2nd inversion/.test(run.inv2 || ''),
    JSON.stringify({ two: run.inv1, three: run.inv2 }));
  ok('…and + cannot push it past the last inversion',
    run.hasUp && run.capped === 3, JSON.stringify(run.capped));
  // It is only an inversion while Voices is the chord's size — the honest limit.
  ok('with Voices ≠ the chord size it says voicing, not inversion',
    /voicing rather than an inversion/.test(run.dyad || ''), JSON.stringify(run.dyad));
  ok('…and under a different Pitch kind it asks a different question',
    /which of the 3 tones/.test(run.fixed || ''), JSON.stringify(run.fixed));
  // The ceiling is the SOUNDING set, so a 7th chord has one more.
  ok('a four-tone chord raises the ceiling to 4',
    run.seventh.max === '4' && /3rd inversion|of 4/.test(run.seventh.hint || ''),
    JSON.stringify(run.seventh));
  // The cap narrows the dice; it must never rewrite the layer.
  ok('a stored value above the ceiling is kept, not capped away',
    run.stored.kept === 6 && run.stored.val === '6' && (run.stored.max | 0) >= 6,
    JSON.stringify(run.stored));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  ' + run.triad.hint + '\n  ' + run.inv1 + '\n  ' + run.dyad);
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
