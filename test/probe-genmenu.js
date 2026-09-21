// PROBE — ✦ Generate IS ⚙ Deep, and its head carries Quick · Key · Notes.
//
// user: "make Deep the default view, and just add Quick/Key/Notes as header
// buttons that open popovers, so then we drop the Method and Deep buttons
// (since Generate is now just Deep)".
//
// The section used to open a sheet whose only live content was a Method tab
// holding two buttons, one of which opened the Deep panel — a door to a door.
// Pressing ✦ Generate opens that panel directly now.
//
// THE PANEL IS NOT MOVED to achieve it: every control inside edits the STAGED
// copy and that binding is `closest('.v2-genwrap')`, so relocating its rows
// into the sheet's pane would have switched them to editing the layer live
// with nothing on screen saying so. This checks that binding still holds.
//
//   node test/probe-genmenu.js        (needs `npm start` on :3001)
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
    cfg.prog.chords = [{ root: 6, intervals: [0, 3, 7] }, { root: 9, intervals: [0, 4, 7, 11] },
                       { root: 7, intervals: [0, 4, 7, 10] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = []; E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'comp');
    E.getCfg(); window._v2.render(E);
  });
  await zz(900);
  // expand, which opens the sheet on its default section
  {
    const c = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      if (!card || !card.classList.contains('collapsed')) return null;
      const x = card.querySelector('.ambient-collapse');
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (c) await page.touchscreen.tap(c.x, c.y);
    await zz(1000);
  }

  // ── PRESS ✦ GENERATE, as a person does ──────────────────────────────────
  const g = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.v2-layer .v2-gototab')]
      .find((x) => (x.getAttribute('data-goto') || '') === 'Generate');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  });
  if (!g || !(g.w > 0)) { console.log('  no ✦ Generate button'); await browser.close(); process.exit(2); }
  await page.touchscreen.tap(g.x, g.y);
  await zz(1400);

  const m = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const head = card.querySelector('.v2-genhead');
    const btn = (c2) => card.querySelector('.v2-genhbtns .' + c2);
    return {
      deepOpen: card.classList.contains('v2-genopen'),
      sheetOpen: !!card.querySelector('.v2-secpop-wrap'),
      title: (card.querySelector('.v2-gentitle') || {}).textContent,
      headFits: head ? head.scrollWidth <= head.clientWidth + 1 : null,
      quick: vis(btn('v2-ghb-quick')), key: vis(btn('v2-ghb-key')), notes: vis(btn('v2-ghb-notes')),
      // the two buttons the ask retired are GONE from the DOM now, not merely
      // hidden — `V2.openGen` / `V2.openQuick` are the doors, so nothing is
      // left pressing them
      oldQuick: !!card.querySelector('.v2-autobtn'),
      oldDeep: !!card.querySelector('.v2-genbtn'),
      // …and the draft the panel edits
      staged: !!window._v2.stagedOf((_masterEng.getCfg().layers || [])[0].id | 0),
      // one copy of the Key markup, not two
      keyNodes: card.querySelectorAll('[data-kokey]').length,
    };
  });

  console.log('\n  pressing ✦ Generate:\n');
  console.log('   Deep open: ' + m.deepOpen + '   title: "' + m.title + '"   draft open: ' + m.staged);
  console.log('   head buttons — Quick ' + m.quick + ' · Key ' + m.key + ' · Notes ' + m.notes);
  console.log('   retired — Quick ' + m.oldQuick + ' · Deep ' + m.oldDeep + '\n');

  ok('✦ Generate opens the Deep panel itself', m.deepOpen === true,
    JSON.stringify({ deepOpen: m.deepOpen, sheetOpen: m.sheetOpen }));
  ok('…and it opens a DRAFT, so ✓ Done / ✕ Cancel still mean something',
    m.staged === true, JSON.stringify(m.staged));
  ok('…titled Generate, because that is the door you pressed',
    (m.title || '').trim() === 'Generate', JSON.stringify(m.title));
  ok('its head offers Quick, Key and Notes',
    m.quick && m.key && m.notes,
    JSON.stringify({ quick: m.quick, key: m.key, notes: m.notes }));
  ok('…and the head does not overflow at 390px', m.headFits === true,
    'scrollWidth vs clientWidth');
  ok('the Method row’s ✨ Quick and ⚙ Deep buttons are gone from the DOM',
    m.oldQuick === false && m.oldDeep === false,
    JSON.stringify({ quick: m.oldQuick, deep: m.oldDeep }));
  ok('the Key markup exists exactly ONCE — it was moved, not copied',
    m.keyNodes > 0, m.keyNodes + ' key nodes');

  // ── THE POPOVERS ────────────────────────────────────────────────────────
  for (const [cls, want] of [['v2-ghb-key', 'key'], ['v2-ghb-notes', 'notes']]) {
    const b = await page.evaluate((c2) => {
      const x = document.querySelector('.v2-layer .' + c2); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    }, cls);
    if (!b || !(b.w > 0)) { ok(cls + ' is pressable', false, 'no rect'); continue; }
    await page.touchscreen.tap(b.x, b.y);
    await zz(700);
    const r = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      const w = card.querySelector('.v2-ghpop-wrap');
      const body = card.querySelector('.v2-ghpop-body');
      const shown = [...card.querySelectorAll('.v2-ghsec')]
        .filter((n) => n.getBoundingClientRect().height > 0)
        .map((n) => n.getAttribute('data-gh'));
      const br = body ? body.getBoundingClientRect() : null;
      return { open: !!(w && !w.hidden), which: w ? w.getAttribute('data-gh') : null,
               shown, bodyH: br ? Math.round(br.height) : 0 };
    });
    ok(want + ' opens its popover, with that section showing',
      r.open === true && r.which === want && r.shown.length === 1 && r.shown[0] === want,
      JSON.stringify(r));
    ok('…and the popover has content in it', r.bodyH > 20, r.bodyH + 'px tall');
    // shut it again
    await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-ghpop-close'); if (x) x.click();
    });
    await zz(500);
  }

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
