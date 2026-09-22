// PROBE — the content drawing pans under the finger.
//
// user: "user needs to be able to navigate the entire part, so have the content
// visualization sidescrollable by user"
//
// The window already panned — `vnav.bar0`, moved by the ◀ ▶ pair — but only a
// third of a screen per press, which is no way to read a long part.
//
// THE GESTURE IS CLAIMED ONLY WHEN THERE IS SOMEWHERE TO GO. With the whole
// part on screen a swipe over the canvas must still scroll the PAGE, because
// the drawing is ~150px tall and taking every vertical swipe over it would trap
// the finger on a phone. That conditional claim is the half most likely to go
// wrong silently, so it is checked in both states.
//
//   node test/probe-vizpan.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(900);

  const geo = () => page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    if (!cv) return null;
    const r = cv.getBoundingClientRect(), bg = cv._barsGeo;
    return { bg: bg ? { barsF: bg.barsF, vbars: bg.vbars, bar0: bg.bar0, w: bg.w, x0: bg.x0 } : null,
             box: { x: r.left, y: r.top, w: r.width, h: r.height },
             top: (cv._pitchGeo || {}).top };
  });

  // ── 1. A SHORT PART: NOTHING TO PAN, SO THE PAGE STILL SCROLLS ──────────
  const short = await geo();
  console.log('\n  short part: ' + JSON.stringify(short && short.bg));
  ok('the drawing reports its own window', !!short && !!short.bg,
    JSON.stringify(short));
  const fits = !!short.bg && (short.bg.barsF - short.bg.vbars) <= 1e-6;
  ok('…and with the whole part on screen there is nothing to pan',
    fits, JSON.stringify(short.bg));

  const swipe = async (dx) => {
    // SCROLL IT INTO VIEW AND RE-READ. With a progression the card is taller
    // and the canvas sits further down; geometry read before that reflow put
    // the touch outside the element entirely (measured: pointerdown count 0,
    // then a pointercancel as the browser took the gesture as a page scroll) —
    // which reads exactly like a pan that does not work.
    await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      if (cv) cv.scrollIntoView({ block: 'center' });
    });
    await zz(350);
    const g = await geo();
    // start inside the PLOT, below the ruler — the keyboard gutter and the
    // ruler strip are other controls
    const x = g.box.x + g.bg.x0 + Math.min(60, g.bg.w * 0.4);
    const y = g.box.y + Math.max((g.top || 0) + 12, g.box.h * 0.6);
    await page.touchscreen.touchStart(x, y);
    for (let i = 1; i <= 6; i++) await page.touchscreen.touchMove(x + (dx * i) / 6, y);
    await page.touchscreen.touchEnd();
    await zz(500);
    return (await geo()).bg.bar0;
  };

  // MEASURE THE CLAIM, NOT THE OUTCOME. Checking `bar0` here cannot fail: with
  // nothing to pan the clamp is [0,0], so the window reads 0 whether the
  // gesture was refused or taken and panned into a wall. (Found by poisoning:
  // removing the `maxBP <= 0` guard left this check green.) `_dragged` is the
  // tell — the pan sets it only once it has actually installed itself and
  // moved, so its absence is the refusal, which is what keeps the page
  // scrollable under a finger on a phone.
  await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv'); if (cv) cv._dragged = 0;
  });
  const b0short = await swipe(-120);
  const claimed = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    return !!(cv && cv._dragged);
  });
  ok('…so the gesture is left to the page, not taken',
    claimed === false && Math.abs(b0short) < 1e-6,
    JSON.stringify({ claimed: claimed, bar0: b0short }));

  // ── 2. A LONG PART: THE PICTURE MOVES UNDER THE FINGER ──────────────────
  await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live';
    L.part.bars = 16;                       // far wider than the window
    L.part.rhythm = { kind: 'euclid', steps: 32, pulses: 19, rotate: 0, n: 1 };
    L.part.pitch = { kind: 'walk', span: 6, degree: 1 };
    L.part.barsMode = 'fill';
    E.getCfg();
    try { V.render(E); } catch (e) {}
  });
  await zz(1100);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);

  const long = await geo();
  console.log('  long part:  ' + JSON.stringify(long && long.bg) + '\n');
  ok('a 16-bar part shows only part of itself',
    !!long.bg && long.bg.barsF > long.bg.vbars + 0.5, JSON.stringify(long.bg));

  const b0a = await swipe(-140);
  console.log('  swipe left  → bar0 ' + Math.round(b0a * 100) / 100);
  // DRAG THE CONTENT, NOT THE WINDOW: pulling left brings LATER bars in, the
  // way a map moves under the hand.
  ok('dragging left brings later bars in', b0a > 0.2, 'bar0 = ' + b0a);

  const b0b = await swipe(140);
  console.log('  swipe right → bar0 ' + Math.round(b0b * 100) / 100 + '\n');
  ok('…and dragging right brings them back', b0b < b0a - 0.1,
    JSON.stringify({ after: b0b, before: b0a }));

  // …and it cannot be dragged off the end in either direction.
  const b0lo = await swipe(600);
  const b0hi = await swipe(-3000);
  console.log('  clamped: low ' + Math.round(b0lo * 100) / 100 +
              ', high ' + Math.round(b0hi * 100) / 100 +
              ' (max ' + Math.round((long.bg.barsF - long.bg.vbars) * 100) / 100 + ')\n');
  ok('the window stops at the start', Math.abs(b0lo) < 1e-6, 'bar0 = ' + b0lo);
  ok('…and at the end', b0hi <= (long.bg.barsF - long.bg.vbars) + 1e-6 && b0hi > 0,
    JSON.stringify({ bar0: b0hi, max: long.bg.barsF - long.bg.vbars }));

  // ── 3. A PAN IS NOT ALSO A BAR SELECT ───────────────────────────────────
  // The click handler already honours `_dragged` for the note drag; a pan ends
  // the same way and must be refused the same way, or every swipe also picks
  // the bar it happened to finish over.
  const sel = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    return { dragged: !!cv._dragged && Date.now() - cv._dragged < 2000 };
  });
  ok('a pan marks itself so the release is not also a bar select',
    sel.dragged === true, JSON.stringify(sel));

  // ── 4. THE TRACKPAD PATH ────────────────────────────────────────────────
  // BACKWARDS, because the clamp check above left the window pinned at the far
  // end — wheeling further right there moves nothing, and the check would fail
  // for the one reason that has nothing to do with the wheel.
  const wheeled = await page.evaluate(async () => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const before = cv._barsGeo.bar0;
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new WheelEvent('wheel', { deltaX: -160, deltaY: 0, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise((x) => setTimeout(x, 500));
    const cv2 = document.querySelector('.v2-layer .v2-vizcv');
    return { before, after: cv2._barsGeo.bar0 };
  });
  console.log('  wheel deltaX -160: bar0 ' + Math.round(wheeled.before * 100) / 100 +
              ' → ' + Math.round(wheeled.after * 100) / 100 + '\n');
  ok('a two-finger horizontal swipe pans it too',
    Math.abs(wheeled.after - wheeled.before) > 0.1, JSON.stringify(wheeled));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
