// PROBE — a ♪ Line lit on a CHANGE has controls, like one lit on the part.
//
// user: "where are the controls for the melody line that is added per part?"
// — asked alongside "i cleared the content and then re-generated, and it just
// created the same part it had just created". One gap answers both.
//
// A change's three-state ♪ can switch a line on by itself, but the settings
// row (Moves · Notes · Octave · Length % · Level) rendered only off the PART's
// line. So a line lit change by change had no controls anywhere on the card —
// and its `kind` stayed at the default `series`, a deterministic sweep, which
// is precisely why the part regenerated identically. The one knob that gives
// ⛰ Play the changes dice was the one with no door.
//
//   node test/probe-gwline.js        (needs `npm start` on :3001)
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
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    if (card.classList.contains('collapsed')) card.querySelector('.ambient-collapse').click();
  });
  await zz(1000);
  // NO LINE IS LIT HERE — the ♪ press below is the thing under test, and it
  // is also what seeds the line's kind. An earlier cut lit one by writing the
  // store first, which left the press CYCLING IT BACK OFF and every check
  // reading as though the row had never appeared.
  // THE CHANGES PANEL LIVES IN ⚙ DEEP ▸ FINE-TUNE ▸ ♪ LINES (it was under
  // "Repeats" until 2026-09-21). Its row is `.ambient-ctrl v2-ft v2-ft-accomp`
  // inside `.v2-genrows`, so without opening the panel AND selecting that tab
  // the whole block lays out at 0×0 and a control in it measures as missing —
  // the trap this repo names.
  await page.evaluate(() => {
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
  });
  await zz(1400);
  // ✦ GENERATE'S THREE ZONES ARE FOLDED WHEN IT OPENS (2026-09-21), so
  // Fine-tune's tabs are not laid out until its bar is pressed — a control
  // inside a shut zone measures 0×0, which reads as missing.
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const b = card.querySelector('.v2-gzbar[data-gz="3"]');
    if (b && !card.classList.contains('v2-gz-3')) { b.scrollIntoView({ block: 'center' }); b.click(); }
  });
  await zz(700);
  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-fttab[data-ft="accomp"]');
    if (t) { t.scrollIntoView({ block: 'center' }); t.click(); }
  });
  await zz(900);

  const look = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const row = card.querySelector('.v2-gwmelrow');
    const vis = (el) => {
      if (!el) return false;
      let n = el;
      while (n && n !== card) { if (n.style && n.style.display === 'none') return false; n = n.parentElement; }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // THE PART'S kind select — scoped, because each change's own line row
    // carries one too now and a bare `.v2-gwkind select` is the duplicate-class
    // trap waiting to happen.
    const kind = card.querySelector('.v2-gwmelrow:not(.v2-gwclrow) .v2-gwkind select');
    return {
      row: !!row, shown: vis(row),
      kind: kind ? kind.value : null,
      kinds: kind ? [...kind.options].map((o) => o.value) : [],
      fields: row ? [...row.querySelectorAll('[data-f]')].map((e) => e.getAttribute('data-f').split('.').pop()) : [],
      cells: card.querySelectorAll('.v2-gwcell').length,
      // WHICH ANCESTOR IS SHUT — a row can be in the DOM and laid out at 0×0
      // because a container above it is closed, and the tell is the chain.
      chain: (() => {
        const out2 = []; let n = row;
        while (n && n !== card) {
          const r2 = n.getBoundingClientRect();
          out2.push((n.className || n.tagName) + '=' + Math.round(r2.width) + 'x' + Math.round(r2.height));
          n = n.parentElement;
        }
        return out2.slice(0, 6);
      })(),
    };
  });

  // ── LIGHT ONE CHANGE'S LINE WITH ITS OWN ♪, under a real finger ────────
  // NOT by writing the store: the press is what seeds the line's kind, and a
  // test that sets state instead would step straight over the thing it is
  // here to check.
  const before = await look();
  ok('with no line at all, the settings row is not drawn', before.row === false,
    JSON.stringify({ row: before.row }));
  {
    const box = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-gwmel'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    if (box && box.w > 0) await page.touchscreen.tap(box.x, box.y);
    await zz(1200);
  }
  // THE PART'S LINE SETTINGS LIVE ON THE ♪ Line TAB since 2026-09-21 — a part
  // block is two tabs (Chords · ♪ Line) rather than both stacked. Pressed as a
  // person would, so this also proves the tab is a real target and not a 0×0.
  {
    const box = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-gwptab[data-gwt="line"]'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    });
    if (!box || !(box.w > 0 && box.h > 0)) ok('the ♪ Line tab is a real target', false, JSON.stringify(box));
    else { ok('the ♪ Line tab is a real target', box.w >= 44 && box.h >= 28, JSON.stringify(box));
           await page.touchscreen.tap(box.x, box.y); }
    await zz(700);
  }
  const perChange = await look();
  console.log('\n  a ♪ Line lit on ONE change:\n');
  console.log('   settings row shown: ' + perChange.shown);
  console.log('   fields: ' + perChange.fields.join(' · '));
  console.log('   Moves = ' + perChange.kind + '   of ' + JSON.stringify(perChange.kinds));
  console.log('   chain: ' + (perChange.chain || []).join('  <  ') + '\n');

  ok('the line’s settings row is now on screen', perChange.shown === true,
    JSON.stringify({ row: perChange.row, shown: perChange.shown }));
  ok('…and it carries all five of the line’s knobs',
    ['rate', 'kind', 'oct', 'len', 'vel'].every((f) => perChange.fields.indexOf(f) >= 0),
    JSON.stringify(perChange.fields));
  ok('…including Moves, the one that decides whether takes differ',
    !!perChange.kind && perChange.kinds.indexOf('walk') >= 0,
    JSON.stringify({ kind: perChange.kind, kinds: perChange.kinds }));
  // A LINE THAT ONLY SWEEPS IS AN ARPEGGIO. Lighting one used to leave Moves
  // on `series`, deterministic, so the part it belonged to replayed
  // identically for ever — reported three times running.
  ok('…and a newly lit line arrives on a kind that MOVES',
    perChange.kind === 'walk', JSON.stringify(perChange.kind));

  // ── AND SETTING IT REACHES THE CHANGE'S OWN LINE ────────────────────────
  const dice = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    // …and measured on the DRAFT too, which is what the panel is editing
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const distinct = () => {
      const s = new Set();
      for (let t = 0; t < 5; t++) {
        const L = Lat();
        E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
        s.add((V.withEdit(() => V.withTake(t, () => V.notesFor(L,
          { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 }))) || [])
          .map((n) => Math.round(n.at * 1000) + ':' +
            Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).join(' '));
      }
      return s.size;
    };
    const out = {};
    const melAt = () => ((((Lat().part.ground || {}).parts || {})['0'] || {}).mel || {});
    out.stored = melAt().kind || null;
    // the part rung carries the KIND ONLY — never `on`, or every other change
    // in the part would sprout a line nobody asked for
    out.partOn = melAt().on;
    out.walk = distinct();
    // …and the row can put it back to the deterministic sweep, through its
    // own select, as a person would
    const sel = document.querySelector('.v2-layer .v2-gwmelrow:not(.v2-gwclrow) .v2-gwkind select');
    if (sel) {
      sel.value = 'series';
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    out.series = distinct();
    return out;
  });
  await zz(600);
  console.log('   distinct takes out of 5 — walk ' + dice.walk + ', series ' + dice.series +
              '   (part rung: kind=' + dice.stored + ', on=' + dice.partOn + ')\n');

  ok('the press seeds the PART’s kind, which the change inherits',
    dice.stored === 'walk', JSON.stringify(dice.stored));
  ok('…and only the KIND — the part gains no line of its own',
    dice.partOn === undefined, JSON.stringify(dice.partOn));
  ok('…so the part rolls: five takes, five different',
    dice.walk === 5, dice.walk + ' distinct takes');
  ok('…and the row can still put it back to the sweep',
    dice.series === 1, dice.series + ' distinct takes on series');

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
