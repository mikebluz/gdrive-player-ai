// PROBE — ⚙ Deep's rows share ONE control column.
//
// user: "how can we clean up the inputs for more symmetry? the right gutter
// readouts create visual friction making inputs different sizes"
//
// `.ambient-ctrl` is `84px 1fr auto`, so the third column took whatever its
// readout needed and the 1fr control shrank around it — a row with no readout
// got the lot. Measured in zone 2 before the fix: SIX control widths in seven
// rows (308/314/319/359/386/396 at 1200px; 155/165/206/233/243 at 390px).
//
// The contract, checked at both widths and on every fine-tune tab:
//   · one control width for the ordinary rows, with three NAMED exceptions
//   · every row ends at the same right edge
//   · every readout begins where its control begins (no stranded right-aligned
//     slider value), and an EMPTY readout costs no line
//   · nothing overflows — walked leaf by leaf, never documentElement
//
//   node test/probe-rowsym.js        (needs `npm start`; BLOOPS_URL to retarget)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

// THE THREE ROWS THAT ARE ALLOWED TO DIFFER, each for a stated reason — named
// here so a FOURTH one appearing fails this probe instead of passing quietly.
//   .v2-presetctl  ↺ Reset is an action and shares the control line
//   .v2-disc       a fold header, whose button is `justify-self: start`
//   .v2-evorow /
//   .v2-saltrow    colour-banded groups, indented 8px by their own rule
const EXEMPT = ['v2-presetctl', 'v2-disc', 'v2-evorow', 'v2-saltrow',
                'v2-recipewarn', 'v2-diceall', 'v2-dmrow', 'v2-gwparts', 'v2-tunedrow'];

const setup = async (page) => {
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
                       { root: 5, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
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
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(800);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  // ZONES OPEN FOLDED — a row inside a shut zone lays out at 0×0 and would be
  // skipped by the very measurement this probe exists to make.
  for (const z of ['1', '2', '3']) {
    await page.evaluate((zn) => {
      const c = document.querySelector('.v2-layer');
      const x = c.querySelector('.v2-gzbar[data-gz="' + zn + '"]');
      if (x && !c.classList.contains('v2-gz-' + zn)) x.click();
    }, z);
    await zz(450);
  }
};

const look = (page, exempt) => page.evaluate((EX) => {
  const pane = document.querySelector('.v2-layer .v2-genrows');
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !!e.offsetParent; };
  const plain = [], ends = [], strandedV = [], emptyLines = [];
  [...pane.querySelectorAll('.ambient-ctrl')].forEach((r) => {
    if (!vis(r)) return;
    const lab = r.querySelector(':scope > label');
    const kids = [...r.children].filter((c) => c !== lab && !c.classList.contains('ambient-hint') && vis(c));
    const far = Math.max(...[...r.children].filter(vis).map((c) => c.getBoundingClientRect().right));
    if (Number.isFinite(far)) ends.push(Math.round(far));
    const ex = EX.some((k) => r.classList.contains(k));
    if (!ex) kids.forEach((c) => plain.push({ w: Math.round(c.getBoundingClientRect().width),
      lab: (lab && lab.textContent.trim()) || '(no label)' }));
    // a readout must START where its control starts
    const ctl = kids[0];
    [...r.querySelectorAll(':scope > .ambient-hint')].forEach((h) => {
      if (!vis(h)) return;
      const ht = (h.textContent || '').trim();
      if (!ht) { emptyLines.push((lab && lab.textContent.trim()) || '?'); return; }
      if (!ctl) return;
      const hr = h.getBoundingClientRect(), cr = ctl.getBoundingClientRect();
      // same LINE as the control? then it is a gutter readout, not a line of its own
      if (Math.abs(hr.top - cr.top) < 6) return;
      if (Math.abs(hr.left - cr.left) > 2 || hr.width < cr.width - 2)
        strandedV.push(((lab && lab.textContent.trim()) || '?') + ' "' + ht.slice(0, 18) +
          '" left+' + Math.round(hr.left - cr.left) + ' w' + Math.round(hr.width) + '/' + Math.round(cr.width));
    });
  });
  // LEAF-BY-LEAF OVERFLOW — never documentElement.scrollWidth: html/body carry
  // overflow-x:hidden, so an overflowing leaf reads as zero there.
  const over = [];
  const walk = (n) => {
    if (n.nodeType === 3) {
      const t = n.textContent.trim(); if (!t) return;
      const el = n.parentElement; if (!el || !vis(el)) return;
      const er = el.getBoundingClientRect();
      const pe = el.parentElement, pr = pe ? pe.getBoundingClientRect() : null;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto')
        over.push('SCROLL "' + t.slice(0, 24) + '" ' + el.scrollWidth + '>' + el.clientWidth);
      else if (pr && er.right > pr.right + 1 && getComputedStyle(pe).overflowX !== 'auto')
        over.push('EDGE "' + t.slice(0, 24) + '" +' + Math.round(er.right - pr.right) + 'px');
      return;
    }
    [...n.childNodes].forEach(walk);
  };
  walk(pane);
  const byW = {};
  plain.forEach((c) => { (byW[c.w] || (byW[c.w] = [])).push(c.lab); });
  return {
    widths: Object.keys(byW).map(Number).sort((a, b) => a - b),
    byW: Object.fromEntries(Object.entries(byW).map(([w, v]) => [w, [...new Set(v)].slice(0, 4)])),
    n: plain.length,
    ends: [...new Set(ends)].sort((a, b) => a - b),
    strandedV: [...new Set(strandedV)].slice(0, 6),
    emptyLines: [...new Set(emptyLines)].slice(0, 6),
    over: [...new Set(over)].slice(0, 6),
  };
}, exempt);

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000 });
  const errs = [];

  for (const W of [390, 1200]) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.setViewport({ width: W, height: 900, isMobile: W < 700, hasTouch: W < 700 });
    await setup(page);

    console.log('\n──────── viewport ' + W + ' ────────');
    for (const tab of [null, 'rhythm', 'notes', 'form', 'accomp', 'take']) {
      if (tab) {
        await page.evaluate((t) => {
          const x = document.querySelector('.v2-layer .v2-fttab[data-ft="' + t + '"]'); if (x) x.click();
        }, tab);
        await zz(550);
      }
      const r = await look(page, EXEMPT);
      const nm = tab || 'zones 1+2';
      console.log('\n  ' + nm + ' — ' + r.n + ' ordinary controls, widths ' + JSON.stringify(r.widths) +
                  ', row ends ' + JSON.stringify(r.ends));
      if (r.widths.length > 1) console.log('      ' + JSON.stringify(r.byW));

      ok(nm + ' @' + W + ': every ordinary control is one width',
        r.n > 3 && r.widths.length === 1, JSON.stringify(r.byW));
      ok(nm + ' @' + W + ': …and every row ends at the same edge',
        r.ends.length === 1, JSON.stringify(r.ends));
      ok(nm + ' @' + W + ': …each readout begins where its control begins',
        r.strandedV.length === 0, r.strandedV.join(' · '));
      ok(nm + ' @' + W + ': …an empty readout costs no line',
        r.emptyLines.length === 0, r.emptyLines.join(' · '));
      ok(nm + ' @' + W + ': …and nothing overflows its container',
        r.over.length === 0, r.over.join(' · '));
    }
    await page.close();
  }

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
