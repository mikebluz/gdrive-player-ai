// PROBE — the Parts strip: one dropdown for the part, one ✎ Edit toggle.
//
// 👁 View — every layer follows playback: the part being heard is the part you
//          see, with a playhead, and the dropdown is a READOUT of it.
// ✎ Edit — every layer holds the part chosen in the dropdown whatever is
//          playing, so an edit stays put while the arrangement runs on.
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
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
    await zz(600);
    await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click(); });
    await zz(900);
  }
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);

  // AN ARRANGEMENT WITH PARTS — the strip renders nothing without changes, so a
  // fixture without a progression cannot see any of this.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: true, name: 'PARTS',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] }],
      parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }] };
    (cfg.layers || []).forEach((L) => { L.partFor = 0; });
    E.getCfg();
    _ambSyncFxVis(E);
  });
  await zz(800);

  const shape = await page.evaluate(() => {
    const el = document.getElementById('mix-bloom-curpart');
    if (!el) return { err: 'no strip' };
    const q = (s) => el.querySelector(s);
    const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), vis: !!n.offsetParent }; };
    const sel = q('.ambient-curpart-sel'), mode = q('.ambient-curpart-edit'), loop = q('.ambient-curpart-loop');
    return {
      chips: el.querySelectorAll('.ambient-curpart-chip').length,
      sel: r(sel), mode: r(mode), loop: r(loop),
      opts: sel ? [...sel.options].map((o) => o.textContent) : [],
      modeFace: mode ? mode.textContent.trim() : null,
      modeOn: !!(mode && mode.classList.contains('on')),
      modePressed: mode ? mode.getAttribute('aria-pressed') : null,
      stripW: Math.round(el.getBoundingClientRect().width),
      overflow: el.scrollWidth - el.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  ok('the parts are ONE dropdown — no chip per part',
    shape.chips === 0 && shape.opts.length === 2, JSON.stringify(shape).slice(0, 220));
  // A TOGGLE, and its WORD carries the state as well as the fill — `✎ Edit` is
  // an offer, `✎ Editing` is a state. That is how ↻ Loop beside it solves the
  // documented "a ONE-WORD FACE IS READ AS THE CURRENT STATE" trap.
  ok('✎ Edit is a TOGGLE in the Parts strip, off by default',
    /^✎ Edit$/.test(shape.modeFace || '') && shape.modeOn === false &&
    shape.modePressed === 'false', JSON.stringify(shape.modeFace) + ' on=' + shape.modeOn);
  // THE SWALLOW CHECK, measured on the SIBLINGS: `.ambient-select` is width:100%
  // and declared late, so a bare one here would crush the mode select and ↻ Loop
  // to nothing. Their widths are the evidence, not the part select's.
  ok('the part dropdown does not swallow its siblings',
    !!shape.mode && shape.mode.w > 50 && shape.mode.vis &&
    !!shape.loop && shape.loop.w > 40 && shape.loop.vis,
    JSON.stringify({ sel: shape.sel, mode: shape.mode, loop: shape.loop }));
  ok('no horizontal overflow at 390px',
    shape.overflow <= 0 && shape.docOverflow <= 0,
    'strip=' + shape.overflow + ' doc=' + shape.docOverflow);

  // ---- ✎ EDIT: the dropdown is the choice, and it drives every layer -------
  const edit = await page.evaluate(async () => {
    const E = _masterEng;
    const el = document.getElementById('mix-bloom-curpart');
    const md = el.querySelector('.ambient-curpart-edit');
    md.click();
    await new Promise((r) => setTimeout(r, 500));
    const sel = document.getElementById('mix-bloom-curpart').querySelector('.ambient-curpart-sel');
    const before = (E.getCfg().layers || []).map((L) => L.partFor);
    sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const after = (_masterEng.getCfg().layers || []).map((L) => L.partFor);
    const s2 = document.getElementById('mix-bloom-curpart').querySelector('.ambient-curpart-sel');
    return { mode: window._v2.viewMode(), before, after, enabled: !s2.disabled, val: s2.value,
             cur: _masterEng._curPart };
  });
  ok('✎ Edit — the dropdown is a CHOICE and every per-part layer follows it',
    edit.mode === 'edit' && edit.enabled && edit.cur === 1 &&
    edit.after.every((x) => x === 1), JSON.stringify(edit));

  // …and PLAYBACK MUST NOT MOVE IT. The playhead updater is what would: drive it
  // with another part sounding and the selection has to stand.
  const held = await page.evaluate(async () => {
    const E = _masterEng;
    const el = document.getElementById('mix-bloom-curpart');
    el._playPi = undefined;
    E._passLock = { pi: 0 };                 // "part 0 is being heard"
    const sv = E.timer; E.timer = E.timer || 1;
    try { _ambCurPartPlayhead(E); } finally { E.timer = sv; }
    await new Promise((r) => setTimeout(r, 120));
    const s2 = el.querySelector('.ambient-curpart-sel');
    E._passLock = null;
    return { val: s2.value, cur: E._curPart };
  });
  ok('…and playback never moves it — the part you are editing stays put',
    held.val === '1' && held.cur === 1, JSON.stringify(held));

  // ---- 👁 VIEW: the dropdown follows playback ------------------------------
  const view = await page.evaluate(async () => {
    const E = _masterEng;
    const el = document.getElementById('mix-bloom-curpart');
    const md = el.querySelector('.ambient-curpart-edit');
    if (md.classList.contains('on')) md.click();
    await new Promise((r) => setTimeout(r, 500));
    const el2 = document.getElementById('mix-bloom-curpart');
    const s2 = el2.querySelector('.ambient-curpart-sel');
    const disabled = !!s2.disabled;
    el2._playPi = undefined;
    E._passLock = { pi: 0 };
    const sv = E.timer; E.timer = E.timer || 1;
    try { _ambCurPartPlayhead(E); } finally { E.timer = sv; }
    await new Promise((r) => setTimeout(r, 120));
    const s3 = document.getElementById('mix-bloom-curpart').querySelector('.ambient-curpart-sel');
    const followed = s3.value;
    const lit = s3.classList.contains('playing');
    E._passLock = null;
    return { mode: window._v2.viewMode(), disabled, followed, lit };
  });
  // RESTATED with the reason: the first cut asserted the dropdown was DISABLED
  // in View. That shipped as "clicking the dropdown does nothing" — a control
  // that swallows a press and says nothing, which this project has a rule
  // against. What View actually owes is that the dropdown FOLLOWS playback and
  // is marked as sounding; being operable is not a violation of that, it is
  // what makes the readout a door (a pick switches to ✎ Edit — checked below,
  // driven for real).
  ok('👁 View — the dropdown FOLLOWS playback and is marked as sounding',
    view.mode === 'view' && !view.disabled && view.followed === '0' && view.lit,
    JSON.stringify(view));

  // …and the layers follow it too — `vizMode` is the one axis both read
  const axis = await page.evaluate(() => {
    const L0 = (_masterEng.getCfg().layers || [])[0];
    const inView = window._v2.viewMode();
    return { inView, cardPickerDisabled: !!document.querySelector('.v2-modepick[disabled]') };
  });
  ok('…and the card’s own picker stands down — in View a tap selects a bar',
    axis.inView === 'view' && axis.cardPickerDisabled, JSON.stringify(axis));

  // THE AXIS CAN BE MOVED FROM THE CARD TOO (✎ Draw means "I am editing this"),
  // and the strip is its face — a readout with no second writer is a confident
  // wrong answer, which is why the card tells the strip.
  const fromCard = await page.evaluate(async () => {
    const E = _masterEng;
    const L0 = (E.getCfg().layers || [])[0];
    window._v2.setViewMode('view');
    try { window._ambCurPartRefresh(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
    const face = () => { const b2 = document.getElementById('mix-bloom-curpart')
      .querySelector('.ambient-curpart-edit'); return b2.classList.contains('on') ? 'edit' : 'view'; };
    const before = face();
    window._v2.vizMode(L0, 'draw');                 // what ✎ Draw does
    await new Promise((r) => setTimeout(r, 300));
    const after = face();
    return { before, after, axis: window._v2.viewMode() };
  });
  ok('the strip follows the axis when a CARD moves it \u2014 no stale readout',
    fromCard.before === 'view' && fromCard.after === 'edit' && fromCard.axis === 'edit',
    JSON.stringify(fromCard));

  // ── DRIVEN FOR REAL ───────────────────────────────────────
  // Everything above dispatches a synthetic `change`, which proves the HANDLER
  // and nothing about whether a finger can reach the control — the documented
  // reachability rule, and the hole that let a `disabled` select ship as
  // "clicking does nothing". `page.select` is a real user selection, and the
  // hit-test proves nothing is covering the box.
  const reach = await page.evaluate(() => {
    const el = document.getElementById('mix-bloom-curpart');
    const hit = (sq) => {
      const n = el.querySelector(sq); if (!n) return 'missing';
      const b = n.getBoundingClientRect();
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { disabled: !!n.disabled, self: at === n, got: at ? (at.className || at.tagName) : null };
    };
    return { sel: hit('.ambient-curpart-sel'), mode: hit('.ambient-curpart-edit') };
  });
  ok('neither control is disabled, and a tap lands on the control itself',
    reach.sel && !reach.sel.disabled && reach.sel.self &&
    reach.mode && !reach.mode.disabled && reach.mode.self,
    JSON.stringify(reach));

  // A REAL PICK IN 👁 VIEW: it must ACT — hold that part, and say it switched.
  const realPick = await page.evaluate(() => {
    try { window._v2.setViewMode('view'); window._ambCurPartRefresh(_masterEng); } catch (e) {}
    return window._v2.viewMode();
  });
  await zz(400);
  await page.select('#mix-bloom-curpart .ambient-curpart-sel', '1');
  await zz(600);
  const picked = await page.evaluate(() => ({
    mode: window._v2.viewMode(),
    cur: _masterEng._curPart,
    parts: (_masterEng.getCfg().layers || []).map((L) => L.partFor),
    shown: document.getElementById('mix-bloom-curpart').querySelector('.ambient-curpart-sel').value,
    modeShown: document.getElementById('mix-bloom-curpart')
      .querySelector('.ambient-curpart-edit').classList.contains('on') ? 'edit' : 'view',
  }));
  ok('a real pick in 👁 View ACTS — it holds that part and switches to ✎ Edit',
    realPick === 'view' && picked.mode === 'edit' && picked.cur === 1 &&
    picked.shown === '1' && picked.modeShown === 'edit' &&
    picked.parts.every((x) => x === 1), JSON.stringify({ was: realPick, picked }));

  // …and the mode dropdown itself, driven the same way
  // A REAL POINTER PRESS on the toggle — not `.click()`, which skips hit-testing.
  const box = await page.evaluate(() => {
    const b2 = document.getElementById('mix-bloom-curpart').querySelector('.ambient-curpart-edit');
    b2.scrollIntoView({ block: 'center' });
    const r2 = b2.getBoundingClientRect();
    return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await zz(600);
  const realMode = await page.evaluate(() => {
    const b2 = document.getElementById('mix-bloom-curpart').querySelector('.ambient-curpart-edit');
    return { mode: window._v2.viewMode(), on: b2.classList.contains('on'),
             face: b2.textContent.trim(), pressed: b2.getAttribute('aria-pressed') };
  });
  ok('a real POINTER press on ✎ Editing turns it off — and the word changes with it',
    realMode.mode === 'view' && !realMode.on && /^✎ Edit$/.test(realMode.face) &&
    realMode.pressed === 'false', JSON.stringify(realMode));

  // AND AT DESKTOP WIDTH. Everything above is measured at 390px, this project's
  // documented single-viewport blind spot — and the report that prompted the
  // feature came from a ~1400px window. A flex row that behaves at phone width
  // can still let one `width: 100%` select take the line at desktop.
  //
  // A FRESH LOAD, NOT A LIVE RESIZE: resizing from a mobile viewport drops
  // `view-mix` from the body and tears the whole mix panel down — measured
  // identically on the unfixed build, so it is the app's own responsive
  // behaviour and not something this row can be asked about. Reload instead.
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2200);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(500);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(800);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(700);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: true, name: 'WIDE',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] }],
      parts: [{ name: 'Verse', len: 1 }, { name: 'Chorus', len: 1 }] };
    (cfg.layers || []).forEach((L) => { L.partFor = 0; });
    E.getCfg(); _ambSyncFxVis(E);
  });
  await zz(800);
  const wide = await page.evaluate(() => {
    const el = document.getElementById('mix-bloom-curpart');
    if (!el) return { err: 'strip absent at desktop width' };
    const r = (sq) => { const n = el.querySelector(sq); if (!n) return null;
      const bb = n.getBoundingClientRect();
      return { w: Math.round(bb.width), x: Math.round(bb.left), vis: !!n.offsetParent }; };
    return { sel: r('.ambient-curpart-sel'), mode: r('.ambient-curpart-edit'),
             loop: r('.ambient-curpart-loop'),
             overflow: el.scrollWidth - el.clientWidth,
             docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  ok('…and it holds at desktop width too — three controls, in order, no overflow',
    !wide.err && !!wide.sel && wide.sel.w > 120 && wide.sel.vis &&
    !!wide.mode && wide.mode.w > 50 && wide.mode.vis &&
    !!wide.loop && wide.loop.w > 40 && wide.loop.vis &&
    wide.mode.x > wide.sel.x && wide.loop.x > wide.mode.x &&
    wide.overflow <= 0 && wide.docOverflow <= 0,
    JSON.stringify(wide));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
