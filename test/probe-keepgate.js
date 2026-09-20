// PROBE — 🎲 New take asks only when there is something a PERSON made.
//
// Reported: "I just generated some chords to follow changes … when I hit the
// new take button, I get hit with a confirmation modal; I never chose it to be
// FIXED, I want it to be in a fluid state so I can just hit new take at will".
//
// Measured before the fix: all five Material doors leave the part LIVE, and
// every one of them armed the gate — because `keepGate` tested "does the take
// have notes", and for a live part that is the notes the RULES are producing
// right now. Nothing stored, nothing at risk, and re-rolling is the button's
// whole job. Its own comment already promised "silent when there is nothing to
// lose"; the code just disagreed with it.
//
// BOTH DIRECTIONS ARE PINNED. The gate going quiet is only safe if it still
// fires for a WRITTEN part — failing open costs a tap, failing closed costs
// somebody's work.
//
//   node test/probe-keepgate.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
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
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] },
                       { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);
  await page.evaluate(() => { const c = document.querySelector('.v2-layer'); if (c) {
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); } });
  await zz(500);

  await page.evaluate(() => {
    window.__E = () => _masterEng;
    window.__L = () => (_masterEng.getCfg().layers || [])[0];
    // PRESS THE REAL BUTTON and see whether a gate popover appears. The gate is
    // built synchronously inside the click handler, so it is in the DOM by the
    // time click() returns.
    window.__press = () => {
      const b = document.querySelector('.v2-newtake, .v2-reroll, [data-v2act="newtake"]') ||
        [...document.querySelectorAll('button')].find((x) => /New take|Replace with a new take/i.test(x.textContent || ''));
      if (!b) return { err: 'no dice button' };
      const before = (window.__L().part.notes || []).length;
      const kindBefore = window.__L().part.kind;
      b.click();
      const pop = document.querySelector('.ambient-addpop');
      const gated = !!pop;
      const labels = pop ? [...pop.querySelectorAll('.addpop-btn')].map((x) => x.textContent.trim()) : [];
      if (pop) { const ov = pop.closest('.sm-overlay'); if (ov) ov.remove(); }
      return { gated, labels, before, kindBefore };
    };
    window.__gen = (fn) => { const p = window.__L().part;
      p.kind = 'live'; p.notes = []; p.bars = 3;
      delete p.made; delete p.tf; delete p.preset; delete p.mem;
      window.__E().getCfg();
      try { window._v2[fn](window.__E(), window.__L()); } catch (e) {}
      window.__E().getCfg(); };
    window.__freeze = () => { try { window._v2.capture(window.__E(), window.__L(), {}); } catch (e) {}
      window.__E().getCfg(); };
    window.__compose = () => { const p = window.__L().part;
      p.kind = 'recorded'; p.made = 'compose';
      p.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
      window.__E().getCfg(); };
    window.__empty = () => { const p = window.__L().part;
      p.kind = 'recorded'; p.made = 'compose'; p.notes = [];
      window.__E().getCfg(); };
  });

  console.log('\n  a GENERATED (live) part — nothing is stored, so nothing can be lost:\n');
  for (const [fn, nm] of [['makeSustain', '▬ Sustain a chord'], ['makeArp', '⟳ Arpeggiate'],
                          ['makeMixed', '⚇ Mix chords + notes'], ['makeGround', '⛰ Play the changes'],
                          ['rollRun', '🎲 Roll a line']]) {
    await page.evaluate((f) => window.__gen(f), fn);
    await zz(200);
    const r = await page.evaluate(() => window.__press());
    ok(nm + ' — 🎲 rolls straight away, no dialog',
      r.gated === false, JSON.stringify(r));
    await zz(150);
  }

  console.log('\n  a WRITTEN part — still asks, every time:\n');
  await page.evaluate(() => { window.__gen('makeGround'); window.__freeze(); });
  await zz(250);
  const froz = await page.evaluate(() => window.__press());
  ok('a FROZEN take still asks before it is rolled over',
    froz.gated === true && froz.kindBefore === 'recorded', JSON.stringify(froz));
  ok('…and offers Save as well as Roll over it',
    (froz.labels || []).some((x) => /Save/i.test(x)) &&
    (froz.labels || []).some((x) => /Roll over it/i.test(x)), JSON.stringify(froz.labels));

  await page.evaluate(() => window.__compose());
  await zz(250);
  const comp = await page.evaluate(() => window.__press());
  ok('notes you DREW still ask', comp.gated === true, JSON.stringify(comp));

  await page.evaluate(() => window.__empty());
  await zz(250);
  const emp = await page.evaluate(() => window.__press());
  ok('…but an EMPTY written part does not — there is nothing there',
    emp.gated === false, JSON.stringify(emp));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
