// PROBE — the drawing's hollow outlines have a name on the card.
//
// The roll draws every note the NEXT PASSES play behind the take you are
// looking at, hollow. Nothing on the card said so, and it was asked outright:
// "what are all these shadow notes". `.v2-vizlab` now ends with
// `· outlines: notes other takes play`.
//
// The invariant is the BICONDITIONAL, not the presence: the clause is there
// exactly when outlines are drawn (`.v2-vizcv._ghostN`), and never while the
// drawing is hidden — Hide keeps the readout and takes the picture away, and a
// legend for a picture that is not on screen is noise. Saying it on a FIXED
// part (which has no outlines by construction) would be the lie; staying
// silent on a part with 24 of them is the bug that prompted this.
//
// Needs a server on :3001 (or PROBE_PORT).
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.PROBE_PORT || '3001';
const URL = process.env.BLOOPS_URL || `http://localhost:${PORT}/bloops.html`;
const LEGEND = 'outlines: notes other takes play';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);

  const open = () => page.evaluate(() => { document.querySelector('.v2-layer')?.classList.remove('collapsed'); });

  // ---- a v2 layer, through the real door (as test/ui-lifecycle.js does) ----
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer')?.click(); });
  await zz(600);
  const picked = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    const t = bs.find((x) => x.textContent.trim() === 'Layer');
    if (!t) return 'no "Layer": ' + bs.map((x) => x.textContent.trim()).join(' | ');
    t.click(); return null;
  });
  await zz(700);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(700);
  await open();
  const haveCard = await page.evaluate(() => !!document.querySelector('.v2-layer'));
  ok('a v2 layer card exists to drive', haveCard, picked || '');
  if (!haveCard) { console.log('\nprobe: ' + pass + ' passed, ' + (fail + 1) + ' failed'); await browser.close(); process.exit(1); }

  // ---- MATERIAL, then VARY — both through the card's own doors ------------
  // A NEW LAYER STARTS EMPTY (an empty `recorded` part), and a recorded part
  // is excluded from the pass sampling, so there is nothing to draw outlines
  // for until a Material door has made it live.
  const mat = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.v2-layer .v2-autopick')];
    const mel = bs.find((x) => /Melody/.test(x.textContent));
    if (!mel) return 'no Melody door: ' + bs.map((x) => x.textContent.trim().slice(0, 12)).join(' | ');
    mel.click(); return null;
  });
  await zz(1400);
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('.v2-layer .v2-autox')].find((x) => /Done/.test(x.textContent) && x.offsetParent);
    if (d) d.click();
  });
  await zz(1000); await open();
  ok('a Material door made the part live', !mat &&
     (await page.evaluate(() => (_masterEng.getCfg().layers || [])[0]?.part?.kind)) === 'live', mat || '');

  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-varytoggle');
    if (t && !t.classList.contains('on')) t.click();   // 🎲 Roll again
  });
  await zz(1100); await open();

  // What the picture actually drew, beside what the readout actually says.
  const read = () => page.evaluate((LEGEND) => {
    const card = document.querySelector('.v2-layer');
    const cv = card?.querySelector('.v2-vizcv');
    const lab = card?.querySelector('.v2-vizlab');
    const L = (_masterEng.getCfg().layers || [])[0];
    return {
      ghostN: cv ? (cv._ghostN | 0) : -1,
      vary: !!L?.part?.vary, kind: L?.part?.kind,
      says: !!(lab && lab.textContent.includes(LEGEND)),
      text: (lab?.textContent || '').trim().slice(0, 200),
      // Rule 2: text wraps and stays inside its box — measured on the leaf,
      // never on documentElement (html/body carry overflow-x:hidden, so an
      // overflowing readout is silently CLIPPED and reads as zero overflow).
      overflows: lab ? (lab.scrollWidth > lab.clientWidth + 1) : true,
      rightOut: lab ? (lab.getBoundingClientRect().right >
                       lab.parentElement.getBoundingClientRect().right + 1) : true,
    };
  }, LEGEND);

  // ---- 1. VARYING: outlines drawn, and the readout names them -------------
  let v = await read();
  // A take can happen to agree with its neighbours; re-roll until the picture
  // actually has outlines to explain (bounded — never an endless loop).
  for (let i = 0; i < 6 && v.ghostN <= 0; i++) {
    await page.evaluate(() => { document.querySelector('.v2-layer .v2-barroll')?.click(); });
    await zz(900); await open();
    v = await read();
  }
  console.log('\nvarying part');
  ok('the part varies', v.vary === true && v.kind === 'live', JSON.stringify(v));
  ok('the drawing put outlines behind the take', v.ghostN > 0, JSON.stringify(v));
  ok('the readout names them', v.says === true, v.text);
  ok('and names them LAST, after the take', /take \d[\s\S]*outlines:/.test(v.text), v.text);
  ok('readout does not overflow its box', !v.overflows && !v.rightOut, JSON.stringify(v));

  // ---- 2. HIDDEN drawing: the readout stays, the legend must not ----------
  console.log('\ndrawing hidden (Hide keeps the readout)');
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-viztog')?.click(); });
  await zz(800); await open();
  const h = await read();
  ok('the readout is still there', h.text.length > 10, h.text);
  ok('no legend for a picture that is not on screen', h.says === false, h.text);
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-viztog')?.click(); });
  await zz(900); await open();
  const back = await read();
  ok('showing it again brings the legend back', back.says === true, back.text);

  // ---- 3. FIXED: no outlines by construction, so no clause ----------------
  console.log('\nfixed part (one take, sampled eight times)');
  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-varytoggle');
    if (t && t.classList.contains('on')) t.click();     // ✓ Play this take
  });
  await zz(1100); await open();
  const f = await read();
  ok('the part no longer varies', f.vary === false, JSON.stringify(f));
  ok('no outlines are drawn', f.ghostN === 0, JSON.stringify(f));
  ok('and the readout stays silent about them', f.says === false, f.text);

  // ---- the invariant, stated once ----------------------------------------
  const shown = [v, back, f];                    // the three states with the picture up
  ok('said exactly when outlines are drawn', shown.every((s) => s.says === (s.ghostN > 0)),
     JSON.stringify(shown.map((s) => ({ g: s.ghostN, says: s.says }))));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
