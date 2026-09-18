// PROBE — a new v2 layer is named with a word, not a number.
//
// The bank is generated from Project Gutenberg and COMMITTED
// (tools/build-wordbank.mjs), so this also guards the thing a build step is
// easy to break: that the list is actually loaded by the page.
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

  const bank = await page.evaluate(() => {
    const b = window.BLOOPS_WORDBANK;
    if (!Array.isArray(b)) return { err: 'not loaded' };
    return { n: b.length, frozen: Object.isFrozen(b),
             allWords: b.every((w) => /^[a-z]{4,9}$/.test(w)),
             unique: new Set(b).size === b.length, sample: b.slice(0, 5) };
  });
  ok('the word bank is loaded by the page', !bank.err && bank.n > 200,
    JSON.stringify(bank));
  ok('…and it is clean — lowercase words only, no duplicates, frozen',
    bank.allWords && bank.unique && bank.frozen, JSON.stringify(bank));

  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);

  // add several layers THROUGH THE REAL DOOR and read the names back
  const names = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
    await zz(500);
    await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click(); });
    await zz(800);
  }
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);
  const got = await page.evaluate(() => ({
    cfg: (_masterEng.getCfg().layers || []).map((L) => L.name),
    shown: [...document.querySelectorAll('.v2-layer .ambient-layer-name')].map((n) => n.textContent.trim()),
  }));

  ok('every new layer is named with a WORD, not "Layer"',
    got.cfg.length >= 4 && got.cfg.every((n) => /^[A-Z][a-z]{3,8}$/.test(n)) &&
    !got.cfg.some((n) => /^Layer/.test(n)), JSON.stringify(got.cfg));
  ok('…the names are DISTINCT — two layers called the same thing is what numbers did badly',
    new Set(got.cfg.map((n) => n.toLowerCase())).size === got.cfg.length, JSON.stringify(got.cfg));
  ok('…and the card shows it', got.shown.length >= 4 &&
    got.shown.every((n) => got.cfg.includes(n)), JSON.stringify(got.shown));
  ok('…and every name came from the bank',
    await page.evaluate((ns) => ns.every((n) => window.BLOOPS_WORDBANK.includes(n.toLowerCase())), got.cfg),
    JSON.stringify(got.cfg));

  // THE FALLBACK: a page without the bank must still name a layer.
  const fallback = await page.evaluate(() => {
    const sv = window.BLOOPS_WORDBANK;
    try {
      delete window.BLOOPS_WORDBANK;
      const L = window._v2.addDefault(_masterEng);
      return L ? L.name : null;
    } finally { window.BLOOPS_WORDBANK = sv; }
  });
  ok('with no bank loaded a layer still gets a name',
    typeof fallback === 'string' && fallback.length > 0, JSON.stringify(fallback));

  // ── THE LABEL FITS THE NAME ─────────────────────────────────
  // The button was a flat 90px — fine while every layer was "Layer 2", and it
  // started truncating the moment they got real names ("Hundred" → "Hundr…").
  // Checked by comparing scrollWidth to clientWidth ON THE LABEL, which is the
  // only way clipping shows: the button looks perfectly fine at any width.
  const fit = await page.evaluate(async (names) => {
    const E = _masterEng, cfg = E.getCfg();
    (cfg.layers || []).forEach((L, i) => { if (names[i]) L.name = names[i]; });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('.v2-layer .ambient-toggle')].map((b) => {
      const sp = b.querySelector('.ambient-layer-name');
      return { name: sp.textContent, w: Math.round(b.getBoundingClientRect().width),
               clipped: sp.scrollWidth > sp.clientWidth + 1 };
    });
    return { rows, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  }, ['Hundred', 'Perpetual']);
  ok('a real layer name is not truncated — the button grows to fit it',
    fit.rows.length >= 2 && fit.rows.every((r) => !r.clipped) &&
    fit.rows.some((r) => r.w > 90) && fit.docOverflow <= 0,
    JSON.stringify(fit));

  // …and a name longer than any word still cannot break the row: the ceiling
  // holds and the ellipsis takes over, which is what it is for.
  const longName = await page.evaluate(async () => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.name = 'Antidisestablishmentarianism and then some';
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 600));
    const b = document.querySelector('.v2-layer .ambient-toggle');
    return { w: Math.round(b.getBoundingClientRect().width),
             docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
             headOverflow: (() => { const hd = b.closest('.ambient-layer-head');
               return hd ? hd.scrollWidth - hd.clientWidth : 0; })() };
  });
  ok('…and an absurd name is capped rather than breaking the row',
    longName.w <= 260 && longName.docOverflow <= 0 && longName.headOverflow <= 0,
    JSON.stringify(longName));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  names: ' + got.cfg.join(' · '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
