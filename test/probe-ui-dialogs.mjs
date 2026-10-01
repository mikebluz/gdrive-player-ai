// PROBE — dialogs must not freeze the page.
//
// The bug (2026-10-01, on the phone: "playback glitches and gets distorted when
// these popovers open"): native `prompt`/`confirm`/`alert` block the main
// thread until dismissed, and on the phone that thread carries every frame of
// the mix to the native speaker and runs the note scheduler. They are now
// in-page dialogs (`uiPrompt`/`uiConfirm`/`uiAlert`, js/bloops/02-wraps.js) that
// return promises; `window.alert` is routed to one.
//
// Measured: each dialog is ON SCREEN at a real size; OK / Cancel / Enter give
// the right answers; and — the point — a timer keeps firing WHILE a dialog is
// open (a native dialog would hold it until dismissed). The layer-rename door
// from the user's screenshot is driven for real and must open no native dialog.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';

const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else fail++; console.log('  ' + (c ? '✓' : '✗') + ' ' + n + (d ? '  · ' + d : '')); };

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
// a NATIVE dialog is the failure: count any that open, and dismiss them
let native = 0;
page.on('dialog', async (d) => { native++; try { await d.dismiss(); } catch (e) {} });
// this probe is ABOUT the in-page dialog, so opt out of the automation fallback
await page.evaluateOnNewDocument(() => { window.__uiNativeDialogs = false; });
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(2000);

console.log('\nNon-blocking dialogs');
const box = () => page.evaluate(() => {
  const m = document.querySelector('.ui-dialog'); if (!m) return null;
  const r = m.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
});

// prompt: type + OK, and a timer must tick while it is open
await page.evaluate(() => {
  window.__ticks = 0; window.__tk = setInterval(() => { window.__ticks++; }, 50);
  window.__p = uiPrompt('Name this layer:', 'piano');
});
await zz(400);
const b1 = await box();
ok('uiPrompt is on screen at a real size, inside the viewport', !!b1 && b1.w > 200 && b1.h > 60 && b1.right <= 390, JSON.stringify(b1));
const ticks = await page.evaluate(() => window.__ticks);
ok('…and the page keeps running while it is open (timers fire)', ticks >= 5, ticks + ' ticks in 400 ms');
await page.evaluate(() => { const i = document.querySelector('.ui-dialog-inp'); i.value = 'keys'; document.querySelector('.ui-dialog-ok').click(); });
ok('…OK returns what was typed', (await page.evaluate(() => window.__p)) === 'keys');
ok('…and the dialog is gone', (await box()) === null);

// prompt: cancel → null; Enter → value
await page.evaluate(() => { window.__p = uiPrompt('x', 'y'); });
await zz(150);
await page.evaluate(() => document.querySelector('.ui-dialog-cancel').click());
ok('Cancel returns null', (await page.evaluate(() => window.__p)) === null);
await page.evaluate(() => { window.__p = uiPrompt('x', 'enter-me'); });
await zz(150);
await page.keyboard.press('Enter');
ok('Enter submits', (await page.evaluate(() => window.__p)) === 'enter-me');

// confirm
await page.evaluate(() => { window.__c = uiConfirm('Delete?'); });
await zz(150);
await page.evaluate(() => document.querySelector('.ui-dialog-ok').click());
const c1 = await page.evaluate(() => window.__c);
await page.evaluate(() => { window.__c = uiConfirm('Delete?'); });
await zz(150);
await page.evaluate(() => document.querySelector('.ui-dialog-cancel').click());
const c2 = await page.evaluate(() => window.__c);
ok('uiConfirm: OK → true, Cancel → false', c1 === true && c2 === false, c1 + ' / ' + c2);

// alert returns at once
const t = await page.evaluate(() => { const t0 = performance.now(); window.alert('hello'); return performance.now() - t0; });
ok('window.alert returns immediately (in-page, not native)', t < 50 && !!(await box()), Math.round(t) + ' ms');
await page.evaluate(() => { const b = document.querySelector('.ui-dialog-ok'); if (b) b.click(); clearInterval(window.__tk); });

// THE DOOR FROM THE REPORT: a layer card's ⋯ → ✎ Rename… — in-page, renames
console.log('\n  the layer-rename door, for real');
const ren = await page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  document.body.classList.add('view-mix'); try { _ambInitMaster(); } catch (e) {} await w(800);
  const L = window._v2.addDefault(_masterEng); await w(400);
  const m = document.querySelector('.v2-layer[data-v2id="' + L.id + '"] .v2-menu');
  if (!m) return { err: 'no ⋯ on the card' };
  m.scrollIntoView({ block: 'center' }); m.click(); await w(350);
  const it = Array.from(document.querySelectorAll('.ctx-menu button')).find((b) => /Rename/.test(b.textContent));
  if (!it) return { err: 'no Rename item' };
  it.click(); await w(350);
  const dlg = document.querySelector('.ui-dialog');
  if (!dlg) return { err: 'no in-page dialog' };
  const r = dlg.getBoundingClientRect();
  dlg.querySelector('.ui-dialog-inp').value = 'piano';
  dlg.querySelector('.ui-dialog-ok').click(); await w(300);
  const L2 = (_masterEng.getCfg().layers || []).find((x) => x.id === L.id);
  return { w: Math.round(r.width), h: Math.round(r.height), name: L2 && L2.name };
});
ok('⋯ → Rename opens the in-page dialog and renames the layer', !ren.err && ren.w > 200 && ren.name === 'piano', JSON.stringify(ren));
ok('no native dialog opened', native === 0, native + ' native');
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
