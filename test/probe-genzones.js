// PROBE — ⚙ Deep's three step bars say what each step HOLDS.
//
// user: "what does 'The Knobs that Matter' mean, doesn't say anything
// descriptive of why they are grouped". It was a boast rather than a
// description, and it implied step 3 held knobs that do not matter. The rule
// it was hiding is the SHAPE: every row in step 2 is gated to the material in
// force, so the step is the handful of knobs that material uses.
//
// What this holds the bars to:
//   · step 2 names the material in force, and re-names it when the shape changes
//   · it never goes blank (the old caption did, with no material)
//   · no bar claims some knobs "matter" and others do not
//   · the captions wrap rather than running off a 390px screen
//
//   node test/probe-genzones.js        (needs `npm start` on :3001)
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
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] }, { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  // EXPAND, then open ⚙ Deep — it lives in the card body, so opening it on a
  // collapsed card lays the whole panel out at 0×0.
  {
    const c = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      if (!card || !card.classList.contains('collapsed')) return null;
      const x = card.querySelector('.ambient-collapse'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (c) await page.touchscreen.tap(c.x, c.y);
    await zz(900);
  }

  // CLOSE ⚙ DEEP BEFORE SWITCHING SHAPE, then reopen. `genSync` is called
  // twice — from the gate pass with the LAYER and from `stagePass` with the
  // DRAFT — and both write these same bars, so editing a shape with the panel
  // open leaves it ambiguous which one the caption is describing. Opening
  // fresh on each shape is also what a person does, and it is the flow the
  // caption has to be right for.
  const read = async (pid) => {
    await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      const x = card.querySelector('.v2-gencancel');
      if (x && card.classList.contains('v2-genopen')) x.click();
    });
    await zz(600);
    await page.evaluate((id) => {
      const E = _masterEng, L = (E.getCfg().layers || [])[0];
      L.part.kind = 'live'; L.part.notes = []; E.getCfg();
      window._v2.applyPreset(E, (E.getCfg().layers || [])[0], id);
      E.getCfg();
      window._v2.render(E);
    }, pid);
    await zz(900);
    await page.evaluate(() => {
      window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
    });
    await zz(1300);
    return page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      const bars = [...card.querySelectorAll('.v2-genrows .v2-genzone')];
      return bars.map((b) => {
        const r = b.getBoundingClientRect();
        const pr = b.parentElement.getBoundingClientRect();
        return {
          text: b.textContent.replace(/\s+/g, ' ').trim(),
          fits: b.scrollWidth <= b.clientWidth + 1 && r.right <= pr.right + 1,
          over: b.scrollWidth - b.clientWidth,
        };
      });
    });
  };

  const roll = await read('rollpulse');
  console.log('\n  ⚙ Deep’s step bars, on a Roll:\n');
  roll.forEach((b) => console.log('   ' + JSON.stringify(b.text)));
  const ground = await read('held');
  console.log('\n  …and on Groundwork:\n');
  ground.forEach((b) => console.log('   ' + JSON.stringify(b.text)));
  console.log('');

  const all = roll.concat(ground);
  const step2 = (bars) => bars.find((b) => /^2/.test(b.text));

  ok('no bar claims some knobs "matter" and others do not',
    !all.some((b) => /matter/i.test(b.text)),
    JSON.stringify(all.map((b) => b.text).filter((t) => /matter/i.test(t))));
  ok('step 2 says WHICH knobs it holds, not just that it holds knobs',
    !!step2(roll) && /the ones .* uses/i.test(step2(roll).text),
    JSON.stringify(step2(roll) && step2(roll).text));
  ok('…and it names the material in force',
    !!step2(roll) && /roll a line/i.test(step2(roll).text),
    JSON.stringify(step2(roll) && step2(roll).text));
  ok('…and re-names it when the shape changes',
    !!step2(ground) && /play the changes/i.test(step2(ground).text),
    JSON.stringify(step2(ground) && step2(ground).text));
  ok('every step bar fits at 390px — no horizontal scroll',
    all.every((b) => b.fits),
    all.filter((b) => !b.fits).map((b) => b.text + ' overflows ' + b.over + 'px').join('\n      '));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
