// PROBE — the DOOR for "a Character over this stretch", measured.
//
// A `querySelector` hit proves nothing: this file's own rule is that a control
// added inside something hidden, collapsed or behind a tab is reported as
// MISSING, not as hidden, and that a 0×0 rect is the tell. So the picker is
// reached the way a person reaches it — tap the bar ruler to select a stretch,
// press 🎲 New take to open that stretch's panel — and then measured
// (`getBoundingClientRect` + `offsetParent`), driven with a real event, and
// read back out of the config.
//
//   node test/probe-charui.js         (needs `npm start` on :3001)
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
                       { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  // a 4-bar roll, so there are bars to select and notes in them
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.bars = 4; L.part.notes = [];
    E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'rollpulse');
    E.getCfg();
    window._v2.render(E);
  });
  await zz(900);

  // EXPAND THE CARD BY ITS OWN HANDLER. A collapsed card lays its canvas out
  // at 0×0 — the documented tell — so a tap computed against it lands
  // nowhere, and `_barsGeo` is left over from an earlier draw. A `classList`
  // poke is not enough either: the panel stays unlaid-out.
  {
    const c = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .ambient-collapse'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (c) await page.touchscreen.tap(c.x, c.y);
    await zz(900);
  }

  // ── TAP THE BAR RULER, exactly where a finger would ─────────────────────
  const tap = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    if (!cv) return { err: 'no part viz' };
    cv.scrollIntoView({ block: 'center' });
    const r = cv.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { err: 'the part viz is laid out 0×0 — the card is still collapsed' };
    const g = cv._barsGeo, pg = cv._pitchGeo, cg = cv._chordGeo;
    if (!g) return { err: 'the viz has no bar geometry' };
    // the ruler strip: below the chord band, above the plot
    const yTop = (cg && cg.top) ? cg.top : 0;
    const yBot = (pg && pg.top) ? pg.top : 15;
    const py = (yTop + yBot) / 2;
    // THE SECOND BAR, in the middle of its own width — read the bar count off
    // the geometry rather than assuming it: the shape builders re-fit a part
    // to the arrangement, so "4 bars" is what was asked for, not what is drawn.
    const nb = Math.max(1, g.barsF || 1);
    const fr = Math.min(nb - 0.5, 1.5) / nb;
    const px = (g.x0 || 0) + ((fr - (g.f0 || 0)) / ((g.vsc > 0) ? g.vsc : 1)) * Math.max(1, g.w);
    return { x: r.left + px, y: r.top + py, bars: nb,
             w: Math.round(r.width), h: Math.round(r.height) };
  });
  if (tap.err) { console.log('  ' + tap.err); await browser.close(); process.exit(2); }
  await page.touchscreen.tap(tap.x, tap.y);
  await zz(500);

  const selN = await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-newtake');
    return b ? b.textContent.trim() : null;
  });
  ok('tapping the bar ruler selected a stretch', !!selN && /bar|stretch|2/i.test(selN),
    '🎲 button now reads: ' + JSON.stringify(selN));

  // ── OPEN THAT STRETCH'S PANEL the way a person does ──────────────────────
  {
    const b = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-newtake'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (b) await page.touchscreen.tap(b.x, b.y);
    await zz(900);
  }

  // ── MEASURE THE DOOR ────────────────────────────────────────────────────
  const m = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const open = card && card.classList.contains('v2-baropen');
    const sel = document.querySelector('.v2-layer .v2-barcharpick');
    if (!sel) return { open, err: 'no Character picker in the DOM at all' };
    const r = sel.getBoundingClientRect();
    const hint = document.querySelector('.v2-layer .v2-barcharsays');
    const hr = hint ? hint.getBoundingClientRect() : null;
    const hp = hint && hint.parentElement ? hint.parentElement.getBoundingClientRect() : null;
    return {
      open,
      w: Math.round(r.width), h: Math.round(r.height),
      onScreen: !!sel.offsetParent,
      opts: sel.options.length,
      chars: (window._v2.presets || []).length,
      groups: sel.querySelectorAll('optgroup').length,
      value: sel.value,
      // the hint must not be squeezed into the grid's `auto` column, and must
      // not run past the row it sits in
      hintFits: !!(hint && hint.scrollWidth <= hint.clientWidth + 1 &&
                   hp && hr.right <= hp.right + 1),
      hintW: hr ? Math.round(hr.width) : 0,
      says: hint ? hint.textContent.slice(0, 40) : '',
    };
  });

  console.log('\n  the stretch panel, measured:\n');
  console.log('   picker      ' + m.w + '×' + m.h + '   onScreen=' + m.onScreen +
              '   ' + m.opts + ' options in ' + m.groups + ' shape groups');
  console.log('   hint        ' + m.hintW + 'px wide · ' + JSON.stringify(m.says) + '…\n');

  ok("the stretch's panel opened", m.open === true, JSON.stringify(m.err || m.open));
  ok('the Character picker is REACHABLE — a real rect, and on screen',
    m.w > 0 && m.h > 0 && m.onScreen === true,
    JSON.stringify({ w: m.w, h: m.h, onScreen: m.onScreen }));
  ok('it is a touch target (≥36px tall)', m.h >= 36, m.h + 'px');
  ok('it offers every Character, grouped by shape, plus the way back',
    m.opts === m.chars + 1 && m.groups === 5,
    m.opts + ' options for ' + m.chars + ' Characters / ' + m.groups + ' groups');
  ok('it starts on "the part’s own rules"', m.value === '', JSON.stringify(m.value));
  ok('its sentence is not squeezed and stays inside its row', m.hintFits === true,
    m.hintW + 'px wide');

  // ── DRIVE IT, and read the config back ──────────────────────────────────
  const drove = await page.evaluate(() => {
    const E = _masterEng;
    const before = JSON.stringify(((E.getCfg().layers || [])[0].part.ruleb) || null);
    const cvBefore = (() => { const c = document.querySelector('.v2-layer .v2-vizcv');
      return c && c._hits ? c._hits.length : -1; })();
    const sel = document.querySelector('.v2-layer .v2-barcharpick');
    const orig = window._v2.setBarChar;
    window.__calls = [];
    window._v2.setBarChar = function (E2, L2, bars, id) {
      const r = orig.apply(this, arguments);
      window.__calls.push({ bars: bars, id: id, r: r, lid: L2 && L2.id });
      return r;
    };
    sel.value = 'arpwide';
    // A REAL PICK FIRES `input` THEN `change`, and this card's controls are
    // delegated on `input` — a synthetic `change` alone reaches nothing and
    // reads as "the handler is not wired" when it is.
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    window._v2.setBarChar = orig;
    const L = (E.getCfg().layers || [])[0];
    const rb = L.part.ruleb || {};
    const k = Object.keys(rb)[0] || null;
    return { before, k, ov: k ? rb[k] : null,
             picked: sel.value, calls: window.__calls,
             cvBefore,
             cvAfter: (() => { const c = document.querySelector('.v2-layer .v2-vizcv');
               return c && c._hits ? c._hits.length : -1; })() };
  });
  await zz(600);

  console.log('');
  ok('picking a Character wrote it to THAT stretch',
    drove.before === 'null' && !!drove.k && drove.ov && drove.ov.char === 'arpwide',
    JSON.stringify({ was: drove.before, key: drove.k, char: drove.ov && drove.ov.char }) +
    '\n      writer calls: ' + JSON.stringify(drove.calls));
  ok('and it stored fields the engine actually reads, not just a name',
    !!(drove.ov && ['rhythm', 'pitch', 'shape'].some((g) => drove.ov[g])),
    JSON.stringify(drove.ov));
  ok('the picture followed the sound (the drawing re-derived)',
    drove.cvAfter > 0 && drove.cvAfter !== drove.cvBefore,
    'hits ' + drove.cvBefore + ' → ' + drove.cvAfter);

  const back = await page.evaluate(() => {
    const E = _masterEng;
    const sel = document.querySelector('.v2-layer .v2-barcharpick');
    const shows = sel.value;
    sel.value = '';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { shows, ruleb: ((E.getCfg().layers || [])[0].part.ruleb) || null };
  });
  await zz(400);
  ok('the panel then NAMES the Character it is on', back.shows === 'arpwide',
    JSON.stringify(back.shows));
  ok('"the part’s own rules" is the way back', back.ruleb === null,
    JSON.stringify(back.ruleb));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
