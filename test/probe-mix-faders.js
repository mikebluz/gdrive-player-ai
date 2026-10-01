// PROBE — the Mixer faders can actually be moved with a finger.
//
// user, 2026-09-30 (phone): "mix faders are finicky and are hard to move".
//
// They are vertical `input[type=range]` in a horizontally-scrolling strip, and they
// never got the pointer handler the card sliders have — so the browser arbitrated
// the gesture and the page scroller usually won. Two things are checked, both by
// driving REAL touch events (a mouse takes the native path and proves nothing):
// that a drag moves the value at all, and that exactly ONE thing is driving it —
// the native range handling ran alongside ours, which measured as more `input`
// events than moves and a value that jumped backwards mid-drag.
//
//   node test/probe-mix-faders.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(400);
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => document.getElementById('mix-bloom-add-layer').click());
    await zz(400);
    await page.evaluate(() => [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click() || void setTimeout(() => { const _e = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60));
    await zz(650);
  }
  const client = await page.target().createCDPSession();
  const touch = (type, x, y) => client.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }] });
  const dragTouch = async (x, y, dx, dy, steps) => {
    await touch('touchStart', x, y);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', x + (dx * i) / steps, y + (dy * i) / steps); await zz(16); }
    await touch('touchEnd', x + dx, y + dy);
    await zz(220);
  };

  // ---- the Mixer fader (vertical) -----------------------------------------
  await page.evaluate(() => { const t = document.querySelector('.ambient-tabsec-tab[data-tab="mixer"]'); if (t) t.click(); });
  await zz(600);
  await page.evaluate(() => { try { _ambSyncControls(_masterEng); } catch (e) {} });
  await zz(400);
  const box = await page.evaluate(() => {
    const m = document.querySelector('.ambient-mixer'); if (m) m.classList.remove('collapsed');
    const f = document.querySelector('.ambient-mix-slider[data-mixkey]'); if (!f) return null;
    f.scrollIntoView({ block: 'center' });
    const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
    window.__ev = [];
    f.addEventListener('input', () => { window.__ev.push(+f.value); });
    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
      w: Math.round(r.width), h: Math.round(r.height), touchAction: cs.touchAction, key: f.dataset.mixkey };
  });
  if (!box) { ok('the Mixer strip has a fader', false, 'none found'); }
  else {
    ok('a fader is a real touch target', box.w >= 30 && box.h >= 100, box.w + '×' + box.h);
    ok('…and the vertical axis is declared as the fader\'s', box.touchAction !== 'auto', box.touchAction);
    const setLvl = (v) => page.evaluate((k, v) => { _ambSetLayerLevel(_masterEng, k, v); window.__ev = []; }, box.key, v);
    const lvl = () => page.evaluate((k) => { const L = _ambLayerByKey(_masterEng, k); return L ? L.level : null; }, box.key);
    const evN = () => page.evaluate(() => (window.__ev || []).length);
    const evs = () => page.evaluate(() => (window.__ev || []).slice());
    await setLvl(50); await dragTouch(box.x, box.y, 0, -30, 10);
    const up = await lvl(), upEv = await evN(), upList = await evs();
    await setLvl(50); await dragTouch(box.x, box.y, 0, 30, 10);
    const down = await lvl();
    await setLvl(50); await dragTouch(box.x, box.y, 0, -200, 16);
    const far = await lvl();
    ok('dragging UP raises it', up > 55, '50 → ' + up);
    ok('…dragging DOWN lowers it by the same amount', down < 45 && Math.abs((up - 50) - (50 - down)) <= 2,
      'up ' + up + ' / down ' + down);
    ok('…the fader\'s own height covers its whole range', far === 100, '50 → ' + far + ' over 200px');
    // ONE DRIVER: the native range handling used to run alongside ours
    const backwards = upList.some((v, i) => i > 0 && v < upList[i - 1]);
    ok('…and exactly one thing is driving it', upEv <= 11 && !backwards,
      upEv + ' input events for 10 moves' + (backwards ? ', and it jumped backwards: ' + upList.join(',') : ''));
    // THE POPUP (2026-10-01, "the input popups get in the way, I'm not sure what
    // triggers them"): a 480 ms timer opened `prompt` whenever a finger RESTED
    // before dragging, and killed the drag. Exact entry is now a deliberate hold,
    // released in place. `prompt` is stubbed to count, never to block.
    await page.evaluate(() => { window.__prompts = 0; window.prompt = () => { window.__prompts++; return null; }; });
    const prompts = () => page.evaluate(() => window.__prompts);
    // rest 600 ms with resting jitter, THEN drag
    await setLvl(50);
    await touch('touchStart', box.x, box.y); await touch('touchMove', box.x + 1, box.y + 1); await zz(600);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', box.x, box.y - 3 * i); await zz(16); }
    await touch('touchEnd', box.x, box.y - 30); await zz(250);
    const restDrag = await lvl(), p1 = await prompts();
    ok('resting before a drag opens NO popup, and the drag still lands', p1 === 0 && restDrag > 55,
      'prompts ' + p1 + ', 50 → ' + restDrag);
    // a quick tap must not jump the fader
    await setLvl(65);
    await touch('touchStart', box.x, box.y + 30); await zz(80); await touch('touchEnd', box.x, box.y + 30); await zz(250);
    const tapped = await lvl(), p2 = await prompts();
    ok('a quick tap neither jumps the fader nor opens the popup', tapped === 65 && p2 === 0,
      '65 → ' + tapped + ', prompts ' + p2);
    // a deliberate hold, released in place, is the door to exact entry
    await touch('touchStart', box.x, box.y); await zz(700); await touch('touchEnd', box.x, box.y); await zz(250);
    const p3 = await prompts();
    ok('…a deliberate hold released in place opens exact entry', p3 === 1, 'prompts ' + p3);
  }

  // ---- the card sliders (horizontal) share that handler --------------------
  // 🕺 Groove's macros are `.ambient-sl` too, and that card opens reachable
  await page.evaluate(() => { const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click(); });
  await zz(500);
  await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp[data-grp="✺ Variation"] > .ambient-grp-head');
    if (g && !g.parentElement.classList.contains('open')) g.click();
    try { _ambRenderVarBar(_masterEng); } catch (e) {}
  });
  await zz(500);
  {
    const b = await page.evaluate(() => {
      const el = document.querySelector('.ambient-pov-varstrip [data-pov="grp:groove"]');
      if (!el) return null; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (b) { await touch('touchStart', b.x, b.y); await touch('touchEnd', b.x, b.y); }
  }
  await zz(800);
  const hb = await page.evaluate(() => {
    // the one a finger would actually land on — a rect alone is not reachability
    const f = [...document.querySelectorAll('input.ambient-sl')]
      .find((x) => {
        const r = x.getBoundingClientRect();
        if (!(r.width > 80 && r.height > 8 && r.top >= 0 && r.bottom <= innerHeight)) return false;
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return h === x || x.contains(h);
      });
    if (!f) return null;
    const r = f.getBoundingClientRect();
    f.value = String(Math.round((parseFloat(f.min) || 0) + ((parseFloat(f.max) || 100) - (parseFloat(f.min) || 0)) * 0.4));
    f.dispatchEvent(new Event('input', { bubbles: true }));
    window.__h = f;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return { x: cx, y: cy, w: Math.round(r.width), before: +f.value,
      inView: r.top >= 0 && r.bottom <= innerHeight, at: hit ? (hit.className || hit.tagName).toString().slice(0, 40) : 'nothing',
      isIt: hit === f };
  });
  if (!hb) ok('a horizontal card slider still drags', false, 'none visible to test');
  else {
    await dragTouch(hb.x, hb.y, 40, 0, 10);
    const after = await page.evaluate(() => +window.__h.value);
    ok('a horizontal card slider still drags', after > hb.before,
      hb.before + ' → ' + after + ' | ' + JSON.stringify({ w: hb.w, inView: hb.inView, at: hb.at, isIt: hb.isIt }));
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
