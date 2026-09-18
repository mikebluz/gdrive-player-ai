// PROBE — the layer FX sheet: a dropdown of stages, Wet only on its own button,
// and every stage's parameters visible the moment that stage is selected.
//
// Reported as "where are the other effects params (distortion type, eq, delay
// feedback…)": an effect's own rows were gated on the effect being ENGAGED
// (mix > 0), so a Drive tab at rest showed one knob and no way to learn that a
// Drive type or a Focus existed — the documented conditionally-rendered-control
// trap, which this project's own rule predicts will be read as missing.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};
const labelsOf = () => {
  const pane = document.querySelector('.v2-layer .v2-pop-pane');
  if (!pane) return [];
  return [...pane.querySelectorAll('.ambient-ctrl')]
    .filter((n) => getComputedStyle(n).display !== 'none' && n.offsetParent)
    .map((n) => { const l = n.querySelector(':scope > label');
      return ((l && l.childNodes[0] && l.childNodes[0].textContent) || '').trim(); })
    .filter(Boolean);
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
  await zz(600);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);
  await page.evaluate(() => { window.__labelsOf = () => {
    const pane = document.querySelector('.v2-layer .v2-pop-pane');
    if (!pane) return [];
    return [...pane.querySelectorAll('.ambient-ctrl')]
      .filter((n) => getComputedStyle(n).display !== 'none' && n.offsetParent)
      .map((n) => { const l = n.querySelector(':scope > label');
        return ((l && l.childNodes[0] && l.childNodes[0].textContent) || '').trim(); })
      .filter(Boolean);
  }; });

  // EXPAND THROUGH THE REAL DOOR. `classList.remove('collapsed')` looks like
  // expanding and is not: the head's own handler is what calls `popOpen`, so
  // stripping the class gives a card with no sheet at all and every section
  // door missing. (That cost a round here \u2014 the probe reported "no FX door"
  // against working code.)
  const opened = await page.evaluate(async () => {
    const c = document.querySelector('.v2-layer');
    const hd = c.querySelector('.ambient-layer-head');
    if (!hd) return 'no card head';
    if (c.classList.contains('collapsed')) hd.click();
    await new Promise((r) => setTimeout(r, 600));
    const b = c.querySelector('.v2-gototab[data-goto="FX"]');
    if (!b) return 'no FX door';
    b.click();
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelector('.v2-layer .v2-pop-tabs') ? null : 'no tab strip';
  });
  await zz(600);
  ok('the FX sheet opens from the card', !opened, String(opened));

  const shape = await page.evaluate(() => {
    const tabs = document.querySelector('.v2-layer .v2-pop-tabs');
    if (!tabs) return { err: 'no strip' };
    const sel = tabs.querySelector('.v2-fxpick');
    const wet = tabs.querySelector('.v2-pop-tab.v2-wetonly');
    const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
      return { w: Math.round(b.width), vis: !!n.offsetParent }; };
    const hit = (n) => { if (!n) return false; const b = n.getBoundingClientRect();
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === n; };
    return {
      chips: tabs.querySelectorAll('.v2-pop-tab:not(.v2-wetonly)').length,
      opts: sel ? [...sel.options].map((o) => o.textContent) : [],
      sel: r(sel), wet: r(wet), wetFace: wet ? wet.textContent.trim() : null,
      selHit: hit(sel), wetHit: hit(wet),
      wetTint: wet ? getComputedStyle(wet).borderColor : null,
      overflow: tabs.scrollWidth - tabs.clientWidth,
    };
  });
  ok('the effect stages are ONE dropdown — no chip per effect',
    shape.chips === 0 && shape.opts.length >= 7 &&
    shape.opts.some((o) => /Delay/.test(o)) && shape.opts.some((o) => /Drive/.test(o)),
    JSON.stringify({ chips: shape.chips, opts: shape.opts }));
  ok('Wet only keeps its own button, in its own colour',
    /Wet only/.test(shape.wetFace || '') && !!shape.wet && shape.wet.vis &&
    !shape.opts.some((o) => /Wet only/.test(o)) &&
    /56,\s*217,\s*169/.test(shape.wetTint || ''),
    JSON.stringify({ face: shape.wetFace, tint: shape.wetTint, inList: shape.opts }));
  ok('both are reachable — a tap lands on the control itself, and the row fits',
    shape.selHit && shape.wetHit && shape.overflow <= 0,
    JSON.stringify({ selHit: shape.selHit, wetHit: shape.wetHit, overflow: shape.overflow }));

  // ---- THE POINT OF THE REPORT: params show AT REST ------------------------
  await page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    // THE STORE IS `L.dist`, not `L.fx.dist` — `fx(L,k)` reads `L[k]`. Written
    // the wrong way this read as mix 0 because the object never existed, which
    // is a check passing for the wrong reason.
    L.dist = Object.assign({}, L.dist, { mix: 0 });
    E.getCfg();
  });
  await page.select('.v2-layer .v2-pop-tabs .v2-fxpick', 'Drive');
  await zz(700);
  const driveRows = await page.evaluate(() => ({
    vis: window.__labelsOf(),
    mix: (((_masterEng.getCfg().layers || [])[0]).dist || {}).mix || 0,
  }));
  ok('Drive at mix 0 still shows its OWN parameters — type, amount, focus, tone',
    driveRows.mix === 0 &&
    driveRows.vis.some((x) => /Drive type/.test(x)) &&
    driveRows.vis.some((x) => /Drive amt/.test(x)) &&
    driveRows.vis.some((x) => /Focus/.test(x)) &&
    driveRows.vis.some((x) => /Drive tone/.test(x)),
    JSON.stringify(driveRows));

  await page.select('.v2-layer .v2-pop-tabs .v2-fxpick', 'Delay');
  await zz(700);
  const delayRows = await page.evaluate(() => window.__labelsOf());
  ok('…and Delay shows feedback, time, sync, ping-pong and width at rest',
    delayRows.some((x) => /Delay fb/.test(x)) && delayRows.some((x) => /Delay time/.test(x)) &&
    delayRows.some((x) => /Delay sync/.test(x)) && delayRows.some((x) => /Ping-pong/.test(x)) &&
    delayRows.some((x) => /Delay width/.test(x)),
    JSON.stringify(delayRows));
  ok('picking a stage in the dropdown navigates the sheet',
    delayRows.some((x) => /Delay/.test(x)) && !delayRows.some((x) => /Drive type/.test(x)),
    JSON.stringify(delayRows));

  const wetPress = await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-pop-tabs .v2-pop-tab.v2-wetonly');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(wetPress.x, wetPress.y);
  await zz(700);
  const wetOpen = await page.evaluate(() => ({
    on: document.querySelector('.v2-layer .v2-pop-tabs .v2-pop-tab.v2-wetonly').classList.contains('on'),
    rows: window.__labelsOf(),
  }));
  ok('a real press on Wet only opens its row and lights the button',
    wetOpen.on && wetOpen.rows.some((x) => /Wet only/.test(x)), JSON.stringify(wetOpen));

  // ── THE HEAD'S SUMMARY NAMES CONTROLS, NOT STORAGE KEYS ──────────────
  // It printed `now.on`, which is the DATA KEYS — so a layer with Drive engaged
  // read "dist" in the head, a word that appears nowhere else on the card
  // (reported: "what does this dist readout mean"). Data keys stay for
  // save-compat; every SURFACE says the control's own name.
  const summ = await page.evaluate(async () => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.dist = Object.assign({}, L.dist, { mix: 40 });        // Drive
    L.autopan = Object.assign({}, L.autopan, { mix: 25 });  // Auto-pan
    // `true`, NOT `1` — `_ambNormalizeFx` does `pe.on = pe.on === true`, so a
    // truthy 1 flattens to false and the stage reads as off (documented).
    L.pecho = Object.assign({}, L.pecho, { on: true });     // Pitch echo
    L.wetOnly = 1;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 600));
    const el = document.querySelector('.v2-layer [data-grp="FX"].v2-grpsum') ||
               document.querySelector('.v2-layer .v2-grpsum[data-grp="FX"]');
    const txt = el ? el.textContent.trim() : null;
    // put it back — one page, one state
    delete L.dist; delete L.autopan; delete L.pecho; delete L.wetOnly;
    E.getCfg();
    return txt;
  });
  ok('the FX summary names the CONTROLS — Drive, not the `dist` storage key',
    !!summ && /Drive/.test(summ) && !/\bdist\b/.test(summ) &&
    /Auto-pan/.test(summ) && !/\bautopan\b/.test(summ) &&
    /Pitch echo/.test(summ) && !/\bpecho\b/.test(summ) && /Wet only/.test(summ),
    JSON.stringify(summ));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
