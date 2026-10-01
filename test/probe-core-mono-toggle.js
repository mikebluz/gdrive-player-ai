// PROBE — the lead synth's ⚡ Core engine switch is reachable and really routes.
//
// 2026-09-29 audit: `mono` (the lead synth) moved onto the WASM core, calibrated
// against Tone's MonoSynth (test/calib-mono.js). The switch lets the user A/B the
// two BY EAR, so it must be where they look — the layer card's Tone row — and
// only there when the voice IS mono. Driven the way a user does: pick the voice,
// MEASURE the switch (a querySelector hit proves nothing), TAP it with a real
// touch, and read back both the stored choice and the note router's answer.
//
//   node test/probe-core-mono-toggle.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.evaluate(() => {
    try { localStorage.removeItem('bloopsCoreMono'); } catch (e) {}
    document.body.classList.add('view-mix'); _ambInitMaster();
  });
  await zz(500);
  // the user's lead synth is a V2 layer — create one through the door a user uses
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer'); b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(450);
  await page.evaluate(() => { const t = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((x) => x.textContent.trim() === 'Layer'); t.click(); setTimeout(() => { const _e = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60), undefined; });
  await zz(600);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(500);

  // the v2 card's Tone select, set the way the card does it (an `input` event)
  const pick = async (voice) => page.evaluate((voice) => {
    const sel = document.querySelector('.v2-layer [data-f="instrument.tone"]');
    if (!sel) return null;
    if (!sel.querySelector('option[value="' + voice + '"]')) {   // a family filter may hide it
      const fam = document.querySelector('.v2-layer .v2-tonefam');
      if (fam) { fam.value = 'all'; fam.dispatchEvent(new Event('input', { bubbles: true })); fam.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const s2 = document.querySelector('.v2-layer [data-f="instrument.tone"]');
    s2.value = voice; s2.dispatchEvent(new Event('input', { bubbles: true }));
    return s2.value === voice ? s2.id : ('not offered: ' + voice);
  }, voice);
  const measure = async (selId) => page.evaluate((selId) => {
    const b = document.getElementById(selId.replace(/-tone$/, '-coremono'));
    if (!b) return { found: false };
    // open whatever holds it, like a user would (the card, its group)
    const card = b.closest('.v2-layer, .ambient-layer'); if (card) card.classList.remove('collapsed');
    const grp = b.closest('.ambient-grp'); if (grp && !grp.classList.contains('open')) grp.classList.add('open');
    b.scrollIntoView({ block: 'center' });
    const q = b.getBoundingClientRect(), pr = b.parentElement.getBoundingClientRect();
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    return { found: true, w: q.width, h: q.height, x: q.left + q.width / 2, y: q.top + q.height / 2,
      shown: !!b.offsetParent, inside: q.right <= pr.right + 0.5 && q.left >= pr.left - 0.5,
      uncovered: hit === b || b.contains(hit), active: b.classList.contains('active'), text: b.textContent };
  }, selId);

  const selId = await pick('sine');
  ok('the v2 card has a Tone select', !!selId && !/^not/.test(selId), selId);
  let m = await measure(selId);
  ok('on a non-mono voice the switch is NOT shown', m.found && !m.shown && m.w === 0, JSON.stringify(m));

  await pick('mono');
  await zz(300);
  m = await measure(selId);
  ok('on the lead synth (mono) the switch is shown, with a real size', m.shown && m.w > 20 && m.h > 16, JSON.stringify(m));
  ok('…inside its row (no overflow), nothing covering it', m.inside && m.uncovered, JSON.stringify(m));
  ok('…and reads ON (the core) by default', m.active === true, JSON.stringify(m));
  const r0 = await page.evaluate(() => ({ stored: window.bloopsCoreMono(), elig: _coreVoices.eligible('mono', {}) }));
  ok('the router sends mono to the core by default', r0.stored === true && r0.elig === true, JSON.stringify(r0));

  await page.touchscreen.tap(m.x, m.y);
  await zz(300);
  m = await measure(selId);
  const r1 = await page.evaluate(() => ({ stored: window.bloopsCoreMono(), elig: _coreVoices.eligible('mono', {}),
    ls: localStorage.getItem('bloopsCoreMono'), sawStillCore: _coreVoices.eligible('sawtooth', {}) }));
  ok('a tap turns it OFF (button reads off)', m.active === false, JSON.stringify(m));
  ok('…and mono now routes to Tone\'s MonoSynth, stored across reloads',
    r1.stored === false && r1.elig === false && r1.ls === '0', JSON.stringify(r1));
  ok('…while every OTHER core voice is untouched', r1.sawStillCore === true, JSON.stringify(r1));

  await page.touchscreen.tap(m.x, m.y);
  await zz(300);
  m = await measure(selId);
  const r2 = await page.evaluate(() => ({ stored: window.bloopsCoreMono(), elig: _coreVoices.eligible('mono', {}) }));
  ok('a second tap puts it back on the core', m.active === true && r2.stored === true && r2.elig === true, JSON.stringify([m, r2]));

  // reading must never write — the bloopsCoreStrips() setter trap
  const r3 = await page.evaluate(() => { window.bloopsCoreMono(); window.bloopsCoreMono(); return localStorage.getItem('bloopsCoreMono'); });
  ok('calling bloopsCoreMono() with no argument only READS', r3 === '1', r3);

  await pick('sine');
  await zz(200);
  m = await measure(selId);
  ok('back on a non-mono voice the switch hides again', !m.shown, JSON.stringify(m));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await page.evaluate(() => { try { localStorage.removeItem('bloopsCoreMono'); } catch (e) {} });
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
