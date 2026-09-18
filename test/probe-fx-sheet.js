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
    const wet = tabs.querySelector('.v2-wettoggle');
    const chainB = tabs.querySelector('.v2-chainbtn');
    const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
      return { w: Math.round(b.width), vis: !!n.offsetParent }; };
    const hit = (n) => { if (!n) return false; const b = n.getBoundingClientRect();
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === n; };
    return {
      chips: tabs.querySelectorAll('.v2-pop-tab:not(.v2-wetonly):not(.v2-chainbtn)').length,
      chain: chainB ? { w: Math.round(chainB.getBoundingClientRect().width),
                        face: chainB.textContent.trim(), vis: !!chainB.offsetParent } : null,
      wetPressed: wet ? wet.getAttribute('aria-pressed') : null,
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
  // RENAMED and now a real toggle: it says what the press DOES, and it is a
  // switch rather than a tab that opens a pane holding one Off/On button.
  ok('Dry Kill is a toggle in the strip, in its own colour, not in the list',
    /^Dry Kill$/.test(shape.wetFace || '') && !!shape.wet && shape.wet.vis &&
    !shape.opts.some((o) => /Dry Kill|Wet only/.test(o)) &&
    shape.wetPressed === 'false' &&
    /56,\s*217,\s*169/.test(shape.wetTint || ''),
    JSON.stringify({ face: shape.wetFace, pressed: shape.wetPressed, tint: shape.wetTint, inList: shape.opts }));
  ok('Chain is a BUTTON beside the picker, not an entry in it',
    !!shape.chain && shape.chain.vis && shape.chain.w > 40 &&
    /^Chain$/.test(shape.chain.face) && !shape.opts.some((o) => /Chain/.test(o)),
    JSON.stringify({ chain: shape.chain, opts: shape.opts }));
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
    const b = document.querySelector('.v2-layer .v2-pop-tabs .v2-wettoggle');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(wetPress.x, wetPress.y);
  await zz(700);
  const wetOpen = await page.evaluate(() => ({
    on: document.querySelector('.v2-layer .v2-pop-tabs .v2-wettoggle').classList.contains('on'),
    pressed: document.querySelector('.v2-layer .v2-pop-tabs .v2-wettoggle').getAttribute('aria-pressed'),
    store: ((_masterEng.getCfg().layers || [])[0].wetOnly | 0),
    rows: window.__labelsOf(),
  }));
  // IT TOGGLES THE LAYER, it does not open a pane. The old surface was a tab
  // holding one Off/On button; the press itself is the switch now, so the check
  // reads the STORE and asserts no row appeared.
  ok('a real press on Dry Kill mutes the dry — no pane, no second button',
    wetOpen.on && wetOpen.pressed === 'true' && wetOpen.store === 1 &&
    !wetOpen.rows.some((x) => /Wet only/.test(x)), JSON.stringify(wetOpen));
  // …and again brings it back
  const wetBack = await page.evaluate(async () => {
    const b = document.querySelector('.v2-layer .v2-pop-tabs .v2-wettoggle');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(wetBack.x, wetBack.y);
  await zz(700);
  const wetOff = await page.evaluate(() => ({
    on: document.querySelector('.v2-layer .v2-pop-tabs .v2-wettoggle').classList.contains('on'),
    store: ((_masterEng.getCfg().layers || [])[0].wetOnly | 0),
  }));
  ok('…and pressing it again brings the dry back',
    !wetOff.on && wetOff.store === 0, JSON.stringify(wetOff));

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

  // ── THE CHAIN EDITOR ──────────────────────────────────────
  // The order is a real engine fact: `fxChain` → `_ambFxCoreOrder` →
  // `strip_fxorder`, and the node path connects in the same order. So the check
  // asserts the STORE and the CORE ORDER move, not just the labels on screen.
  const chain = await page.evaluate(async () => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    // two in-line stages engaged, in a known order
    L.dist = Object.assign({}, L.dist, { mix: 40 });
    L.delay = Object.assign({}, L.delay, { mix: 40 });
    delete L.fxChain;                       // derived = core index order (dist before delay)
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 600));
    const c = document.querySelector('.v2-layer');
    const hd = c.querySelector('.ambient-layer-head');
    if (c.classList.contains('collapsed')) hd.click();
    await new Promise((r) => setTimeout(r, 600));
    c.querySelector('.v2-gototab[data-goto="FX"]').click();
    await new Promise((r) => setTimeout(r, 500));
    return { order0: _ambFxCoreOrder((_masterEng.getCfg().layers || [])[0]).join(','),
             opts: [...document.querySelector('.v2-fxpick').options].map(o => o.value) };
  });
  ok('Chain is NOT in the dropdown — it has its own button',
    !chain.opts.some((o) => /Chain/.test(o)), JSON.stringify(chain.opts));

  // press the Chain button for real
  const chainBox = await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-pop-tabs .v2-chainbtn');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (chainBox) await page.mouse.click(chainBox.x, chainBox.y);
  await zz(700);
  const chainUi = await page.evaluate(() => {
    const pane = document.querySelector('.v2-layer .v2-pop-pane');
    const flow = pane.querySelector('.v2-fxflow');
    const stages = [...pane.querySelectorAll('.v2-fxstage')]
      .filter((n) => getComputedStyle(n).display !== 'none')
      .map((n) => (n.querySelector(':scope > label') || {}).textContent || '');
    const up = [...pane.querySelectorAll('.v2-fxup')];
    return { flow: flow ? flow.textContent.trim() : null, stages,
             ups: up.length, firstUpDisabled: up.length ? !!up[0].disabled : null };
  });
  ok('the Chain tab shows the signal flow and every movable stage',
    /in/.test(chainUi.flow || '') && /Drive/.test(chainUi.flow || '') &&
    /Delay/.test(chainUi.flow || '') && chainUi.stages.length === 2 &&
    /1\. Drive/.test(chainUi.stages[0]) && /2\. Delay/.test(chainUi.stages[1]) &&
    chainUi.firstUpDisabled === true,
    JSON.stringify(chainUi));

  // MOVE IT FOR REAL — a pointer press on Delay's ▲, then read the ENGINE order.
  const before = await page.evaluate(() =>
    _ambFxCoreOrder((_masterEng.getCfg().layers || [])[0]).join(','));
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.v2-layer .v2-pop-pane .v2-fxup')]
      .find((x) => x.getAttribute('data-fxid') === 'delay');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (btn) await page.mouse.click(btn.x, btn.y);
  await zz(800);
  const after = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const pane = document.querySelector('.v2-layer .v2-pop-pane');
    return { core: _ambFxCoreOrder(L).join(','),
             chain: (L.fxChain || []).join(','),
             flow: (pane.querySelector('.v2-fxflow') || {}).textContent || '',
             stages: [...pane.querySelectorAll('.v2-fxstage')]
               .filter((n) => getComputedStyle(n).display !== 'none')
               .map((n) => (n.querySelector(':scope > label') || {}).textContent || '') };
  });
  // dist is core index 0, delay is 3 — moving Delay up must put 3 before 0
  ok('▲ on Delay moves it EARLIER — the stored chain and the CORE order both follow',
    before === '0,3,1,2,4' && after.core.indexOf('3') < after.core.indexOf('0') &&
    after.chain.indexOf('delay') < after.chain.indexOf('dist'),
    JSON.stringify({ before, after }));
  ok('…and the picture agrees — the flow line and the numbering both flip',
    /Delay/.test(after.flow) && after.flow.indexOf('Delay') < after.flow.indexOf('Drive') &&
    /1\. Delay/.test(after.stages[0] || '') && /2\. Drive/.test(after.stages[1] || ''),
    JSON.stringify(after));

  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    delete L.dist; delete L.delay; delete L.fxChain;
    _masterEng.getCfg();
  });

  // ── THE ✕ MUST NOT SIT ON ANYTHING ─────────────────────────────
  // It is absolutely positioned, and the head never reserved its box — so the
  // group summary ran underneath it and, because the button is 40px tall in a
  // head barely that high, it OVERHUNG the tab strip and landed on whatever
  // control sat at the strip's right edge. Measured as RECT OVERLAP against
  // every sibling, not by eye: an overlap is invisible until the thing
  // underneath is the one you tried to press.
  const closeBox = await page.evaluate(() => {
    const wrap = document.querySelector('.v2-layer .v2-secpop-wrap') ||
                 document.querySelector('.v2-layer .v2-pop-wrap');
    if (!wrap) return { err: 'no sheet' };
    const x = wrap.querySelector('.v2-secpop-close');
    if (!x) return { err: 'no close' };
    const rect = (n) => { const r = n.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const xr = rect(x);
    const hits = (n) => { const r = rect(n);
      return !(r.r <= xr.l || r.l >= xr.r || r.b <= xr.t || r.t >= xr.b); };
    const sum = wrap.querySelector('.v2-grpsum');
    const tabs = wrap.querySelector('.v2-pop-tabs');
    return {
      sumOverlap: sum ? hits(sum) : false,
      tabOverlaps: tabs ? [...tabs.children].filter(hits).length : 0,
      self: document.elementFromPoint((xr.l + xr.r) / 2, (xr.t + xr.b) / 2) === x,
    };
  });
  ok('the \u2715 clashes with nothing \u2014 not the summary, not the strip',
    !closeBox.err && closeBox.sumOverlap === false && closeBox.tabOverlaps === 0 &&
    closeBox.self, JSON.stringify(closeBox));

  // ── CHAIN TOGGLES OFF ─────────────────────────────────────
  // It sits beside the picker rather than inside it, so it reads as a switch —
  // and a switch that will not switch off was the report. A second press goes
  // back to whichever stage the dropdown is showing.
  const chainToggle = await page.evaluate(async () => {
    const press = async () => {
      const b = document.querySelector('.v2-layer .v2-pop-tabs .v2-chainbtn');
      b.scrollIntoView({ block: 'center' });
      b.click();
      await new Promise((r) => setTimeout(r, 450));
    };
    const state = () => {
      const b = document.querySelector('.v2-layer .v2-pop-tabs .v2-chainbtn');
      const pane = document.querySelector('.v2-layer .v2-pop-pane');
      // VISIBLE rows, not present ones. A tab's pane is HIDDEN, never removed,
      // so `querySelectorAll(...).length` is true in every state and the check
      // passes whatever the button does.
      return { on: b.classList.contains('on'),
               chainRows: [...pane.querySelectorAll('.v2-fxstage')]
                 .some((n) => getComputedStyle(n).display !== 'none' && n.offsetParent),
               pick: (document.querySelector('.v2-layer .v2-fxpick') || {}).value || null };
    };
    // make sure it starts CLOSED
    if (state().on) await press();
    const before = state();
    await press();
    const open = state();
    await press();
    const closed = state();
    return { before, open, closed };
  });
  ok('the Chain button toggles — a second press closes it again',
    chainToggle.before.on === false &&
    chainToggle.open.on === true && chainToggle.open.chainRows === true &&
    chainToggle.closed.on === false && chainToggle.closed.chainRows === false,
    JSON.stringify(chainToggle));
  ok('…and closing lands on the stage the dropdown is showing',
    !!chainToggle.closed.pick && chainToggle.closed.pick !== 'Chain',
    JSON.stringify(chainToggle.closed));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
