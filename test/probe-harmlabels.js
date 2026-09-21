// PROBE — the harmony voice row says what its controls are.
//
// user: "these harmony controls need better informational labels and
// tooltips". The row was an interval name and then four unlabelled boxes —
// "Oblique / Rise (+1 +2 +1) / 2 / 0" — with the key underneath as a
// positional list, "motion · series · every · canon", so reading the row meant
// counting along it.
//
// What this holds the row to:
//   · every control has a VISIBLE caption, not a shared legend
//   · every control has a tooltip that is a sentence, not a word
//   · the captions do not push the row into a horizontal scroll at 390px
//   · the sentence under the row is a LIVE readout — change a control and it
//     must follow. It did not before: the four controls commit without a
//     rebuild, so the summary kept whatever it said when the card was drawn.
//
//   node test/probe-harmlabels.js        (needs `npm start` on :3001)
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
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  // a ROLL: a single line, which is what harmony shadows — and light a voice
  // with every control off its default so the sentence has something to say.
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = []; E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'rollpulse');
    E.getCfg();
    const L2 = (E.getCfg().layers || [])[0];
    L2.part.pitch.harm = [{ deg: -2, motion: 'oblique', series: 'rise', every: 2, lag: 0 }];
    E.getCfg();
    window._v2.render(E);
  });
  await zz(1000);
  // EXPAND THE CARD FIRST. ⚙ Deep lives in the card BODY, so opening it on a
  // collapsed card sets `v2-genopen` and lays the whole panel out at 0×0 —
  // every row then measures as hidden and reads as "the control is missing".
  {
    const c = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      if (!card || !card.classList.contains('collapsed')) return null;
      const x = card.querySelector('.ambient-collapse'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (c) await page.touchscreen.tap(c.x, c.y);
    await zz(900);
  }
  // open ⚙ Deep — harmony's only home
  await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-genbtn');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
  });
  await zz(1200);
  // …and onto Fine-tune ▸ Notes. ⚙ Deep opens on Rhythm (`v2-ftt-rhythm`) and
  // CSS shows one tab, so the harmony row is laid out but hidden — a control
  // behind a tab reads as MISSING, which is exactly what this file warns of.
  await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-fttab[data-ft="notes"]');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
  });
  await zz(900);

  const m = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    // the SHOWN copy — harmony is built twice in ⚙ Deep with complementary
    // gates, so a blind `querySelector` can land on the hidden one
    const vis = (el) => {
      let n = el;
      while (n && n !== card) { if (n.style && n.style.display === 'none') return false; n = n.parentElement; }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const row = [...card.querySelectorAll('.ambient-ctrl.v2-harmopt')].find(vis);
    if (!row) return { err: 'no harmony voice row is visible' };
    const cells = [...row.querySelectorAll('.v2-harmcell')].map((c) => {
      const lab = c.querySelector('.v2-mini-lab');
      const ctl = c.querySelector('select, input');
      const lr = lab ? lab.getBoundingClientRect() : null;
      return {
        lab: lab ? lab.textContent.trim() : null,
        labShown: !!(lr && lr.width > 0 && lr.height > 0),
        tip: (c.getAttribute('title') || ''),
        ctl: ctl ? (ctl.tagName === 'SELECT' ? 'select' : 'stepper') : null,
      };
    });
    const says = row.querySelector('.v2-harmsays');
    const sum = card.querySelector('.v2-harmsum');
    // no horizontal overflow at this width, row OR card
    const rr = row.getBoundingClientRect();
    const pr = row.parentElement.getBoundingClientRect();
    return {
      cells,
      says: says ? says.textContent.trim() : null,
      sum: sum ? sum.textContent.trim() : null,
      fits: row.scrollWidth <= row.clientWidth + 1 && rr.right <= pr.right + 1,
      over: row.scrollWidth - row.clientWidth,
    };
  });

  if (m.err) { console.log('  ' + m.err); await browser.close(); process.exit(2); }

  console.log('\n  the harmony voice row:\n');
  m.cells.forEach((c) => console.log('   ' + String(c.lab).padEnd(10) + (c.ctl || '?').padEnd(9) +
    'tip ' + String(c.tip.length).padStart(3) + ' chars'));
  console.log('\n   says  “' + m.says + '”');
  console.log('   sum   “' + (m.sum || '').slice(0, 96) + '…”\n');

  ok('all four controls are captioned', m.cells.length === 4 &&
    m.cells.every((c) => c.lab && c.labShown),
    JSON.stringify(m.cells.map((c) => c.lab)));
  ok('the captions name the four questions, not a positional list',
    ['Motion', 'Interval', 'Every', 'Canon'].every((w, i) => m.cells[i] && m.cells[i].lab === w),
    JSON.stringify(m.cells.map((c) => c.lab)));
  ok('every control has a tooltip that is a SENTENCE',
    m.cells.every((c) => c.tip.length > 60 && /\./.test(c.tip)),
    JSON.stringify(m.cells.map((c) => c.tip.length)));
  ok('the row still fits — no horizontal scroll at 390px', m.fits === true,
    'overflows by ' + m.over + 'px');
  ok('the line under the row says what the voice DOES',
    !!m.says && /below the line/.test(m.says) && !/^motion · series/.test(m.says),
    JSON.stringify(m.says));

  // ── THE READOUT MUST FOLLOW THE KNOB ────────────────────────────────────
  const moved = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const before = (card.querySelector('.v2-harmsays') || {}).textContent;
    const sel = card.querySelector('.v2-harmmo');
    sel.value = 'contrary';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { before };
  });
  await zz(1200);
  const after = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    return {
      says: (card.querySelector('.v2-harmsays') || {}).textContent,
      sum: (card.querySelector('.v2-harmsum') || {}).textContent,
      // ⚙ DEEP EDITS THE STAGED COPY, not the layer — that is the whole
      // point of the panel, so the knob is read back off the DRAFT and the
      // real layer is checked to be untouched until ✓ Done.
      staged: (() => {
        const id = (_masterEng.getCfg().layers || [])[0].id | 0;
        const S = window._v2.stagedOf(id);
        return (((S && S.part.pitch.harm) || [])[0] || {}).motion;
      })(),
      live: (((_masterEng.getCfg().layers || [])[0].part.pitch.harm || [])[0] || {}).motion,
    };
  });
  console.log('   after setting Motion → Contrary:\n   says  “' + after.says + '”\n');
  ok('the knob wrote to the DRAFT', after.staged === 'contrary', JSON.stringify(after.staged));
  ok('…and left the layer alone until \u2713 Done', after.live === 'oblique',
    JSON.stringify(after.live));
  ok('…and the sentence FOLLOWED it (it used to freeze)',
    after.says !== moved.before && /against the line/.test(after.says || ''),
    'was “' + moved.before + '”\n      now “' + after.says + '”');
  ok('…and so did the summary under the chips',
    /contrary/.test(after.sum || ''), JSON.stringify((after.sum || '').slice(0, 90)));

  // ── ONE HOME, FOR EVERY SHAPE ───────────────────────────────────────────
  // user: "why are the harmony params in two places, they should only be in
  // one". ⚙ Deep used to build harmony TWICE with complementary gates, and the
  // gate was spliced in with `.replace('data-v2when="…"', …)` — a STRING
  // pattern, so it replaced only the FIRST match: the chips row. Every VOICE
  // row kept the bare gate and showed in both places at once. Counting the
  // ROWS THAT ARE ON SCREEN is the only form of this check that would have
  // failed then and passes now; counting call sites would not have.
  console.log('\n  harmony rows on screen, per shape:\n');
  const dupes = [];
  for (const [shape, pid] of [['ground', 'held'], ['arp', 'arpwide'], ['roll', 'rollpulse'],
                              ['sustain', 'pad'], ['mixed', 'mixarch']]) {
    const n = await page.evaluate((id) => {
      const E = _masterEng;
      const L = (E.getCfg().layers || [])[0];
      L.part.kind = 'live'; L.part.notes = []; E.getCfg();
      window._v2.applyPreset(E, (E.getCfg().layers || [])[0], id);
      E.getCfg();
      const L2 = (E.getCfg().layers || [])[0];
      L2.part.pitch.harm = [{ deg: -2 }];
      E.getCfg();
      // the STAGED copy is what ⚙ Deep shows, so light the voice there too
      const S = window._v2.stagedOf(L2.id | 0);
      if (S) { S.part.pitch.harm = [{ deg: -2 }]; E.getCfg(); }
      return null;
    }, pid);
    await zz(700);
    // every fine-tune tab in turn: a row hidden behind a tab is still A HOME
    const counts = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      const tabs = [...card.querySelectorAll('.v2-fttab')];
      const seen = { rows: 0, chips: 0 };
      const vis = (el) => {
        let n = el;
        while (n && n !== card) { if (n.style && n.style.display === 'none') return false; n = n.parentElement; }
        return true;
      };
      tabs.forEach((tb) => {
        tb.click();
        seen.rows = Math.max(seen.rows,
          [...card.querySelectorAll('.v2-genwrap .ambient-ctrl.v2-harmopt')].filter(vis).length);
        seen.chips = Math.max(seen.chips,
          [...card.querySelectorAll('.v2-genwrap .v2-harm')].filter(vis).length ? 1 : 0);
      });
      // …plus the rows that are gated on regardless of which tab is showing
      seen.gatedRows = [...card.querySelectorAll('.v2-genwrap .ambient-ctrl.v2-harmopt')]
        .filter((r) => r.style.display !== 'none').length;
      return seen;
    });
    console.log('   ' + shape.padEnd(9) + 'voice rows gated on: ' + counts.gatedRows);
    if (counts.gatedRows > 1) dupes.push(shape + ' shows ' + counts.gatedRows);
  }
  console.log('');
  ok('the harmony voice row has exactly ONE home, for every shape',
    dupes.length === 0, dupes.join(' · '));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
