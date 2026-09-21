// PROBE — ✦ Generate opens on Material, each zone wears its own colour, and a
// recipe change lands somewhere usable.
//
// user: "Material should be expanded by default, also should be different
// color highlighting, each section should have its own coloring highlight;
// also these params don't really make sense right now … changing them doesn't
// seem to do anything useful or rational"
//
// The third was measured rather than taken on faith, and the selects were NOT
// dead: every rule reads knobs the MATERIAL tuned for the rule it replaced, so
// the new one arrived with nothing to work with. On a default layer (pulse ×
// chord, n:1) one onset per cycle made all nine pitch rules produce the same
// single hit — nine options, four outcomes. Raising only what would be inert
// is what makes them distinguishable.
//
//   node test/probe-zonehue.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
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
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1500);

  // ── 1. MATERIAL IS OPEN ─────────────────────────────────────────────────
  const zones = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !!e.offsetParent; };
    const bars = [...card.querySelectorAll('.v2-gzbar')].map((x) => {
      const cs = getComputedStyle(x), num = x.querySelector('.v2-zonen');
      return { gz: x.getAttribute('data-gz'), edge: cs.borderLeftColor,
               chip: num ? getComputedStyle(num).color : null,
               w: Math.round(x.getBoundingClientRect().width) };
    });
    return {
      cls: [...card.classList].filter((k) => k.indexOf('v2-gz-') === 0),
      bars,
      bodies: [...card.querySelectorAll('.v2-gzbody')].map((x) => ({
        gz: x.getAttribute('data-gz'), shown: vis(x) })),
      // `.v2-shapepick` INSIDE zone 1's body — a bare `select` finds whichever
      // comes first in the DOM, and the panel is full of gated-off ones, so
      // that measured 0x0 and read as "the picker is missing" when it is
      // plainly on screen.
      picker: (() => { const p = card.querySelector('.v2-gzbody[data-gz="1"] .v2-shapepick');
        if (!p) return null; const r = p.getBoundingClientRect();
        return { w: Math.round(r.width), off: !!p.offsetParent }; })(),
    };
  });
  console.log('\n  zone classes: ' + JSON.stringify(zones.cls));
  console.log('  bodies: ' + JSON.stringify(zones.bodies));
  zones.bars.forEach((b) => console.log('  zone ' + b.gz + '  edge ' + b.edge + '  chip ' + b.chip));

  ok('✦ Generate opens with Material expanded',
    zones.cls.indexOf('v2-gz-1') >= 0 &&
    (zones.bodies.find((b) => b.gz === '1') || {}).shown === true, JSON.stringify(zones));
  // …and ONLY it — the other two are tuning, and the panel folding to three
  // shut bars was the complaint before this one.
  ok('…and the other two still folded',
    zones.bodies.filter((b) => b.gz !== '1').every((b) => b.shown === false),
    JSON.stringify(zones.bodies));
  ok('…so the material picker is on screen',
    !!zones.picker && zones.picker.off && zones.picker.w > 100, JSON.stringify(zones.picker));

  // ── 2. A HUE PER ZONE ───────────────────────────────────────────────────
  ok('all three zone bars are present', zones.bars.length === 3,
    JSON.stringify(zones.bars.map((b) => b.gz)));
  // ZONE 1's BAR IS NOT IN `.v2-genrows` — it is a child of `.v2-genpop`, so a
  // rule scoped to the rows colours 2 and 3 and silently misses MATERIAL, the
  // one zone this was asked about. Caught exactly this way: three bars, two
  // colours.
  const edges = [...new Set(zones.bars.map((b) => b.edge))];
  const chips = [...new Set(zones.bars.map((b) => b.chip))];
  ok('…each with its OWN edge colour, Material included',
    edges.length === 3, JSON.stringify(zones.bars.map((b) => b.gz + '=' + b.edge)));
  ok('…and its numeral chip in the same hue',
    chips.length === 3 && zones.bars.every((b) => b.chip === b.edge),
    JSON.stringify(zones.bars.map((b) => b.gz + ' edge=' + b.edge + ' chip=' + b.chip)));

  // ── 3. A RECIPE CHANGE LANDS SOMEWHERE USABLE ───────────────────────────
  const recipe = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const sig = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 6 }))) || [];
      return ns.map((n) => Math.round(n.at * 1000) + ':' +
        Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).join(' ');
    };
    // a deliberately inert starting point: one onset a cycle, which is what a
    // fresh layer has and what makes every pitch rule look the same
    { const l = Lat(); l.part.kind = 'live'; l.part.rhythm.kind = 'pulse';
      l.part.rhythm.n = 1; l.part.pitch.kind = 'chord'; E.getCfg(); }
    const before = { n: Lat().part.rhythm.n, sigs: new Set() };
    ['series', 'walk', 'mixed', 'chord'].forEach((k) => {
      const l = Lat(); l.part.pitch.kind = k; E.getCfg(); before.sigs.add(sig());
    });
    // …now through the REAL select, which is what seeds the companion knob
    const drive = (path, v) => {
      const sel = document.querySelector('.v2-layer .v2-genwrap .v2-f[data-f="' + path + '"]');
      if (!sel) return false;
      sel.value = v;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const drove = drive('part.rhythm.kind', 'pulse');
    const after = { n: Lat().part.rhythm.n, sigs: new Set() };
    ['series', 'walk', 'mixed', 'chord'].forEach((k) => {
      const l = Lat(); l.part.pitch.kind = k; E.getCfg(); after.sigs.add(sig());
    });
    return { drove, beforeN: before.n, afterN: after.n,
             beforeDistinct: before.sigs.size, afterDistinct: after.sigs.size };
  });
  console.log('\n  one onset a cycle → ' + recipe.beforeDistinct + ' distinct outcomes from 4 pitch rules');
  console.log('  after the select seeded Pulses ' + recipe.beforeN + '→' + recipe.afterN +
              ' → ' + recipe.afterDistinct + ' distinct\n');

  ok('the recipe select is reachable in the panel', recipe.drove === true, 'no select found');
  ok('…and choosing a rhythm lifts the knob that rule reads',
    recipe.afterN > recipe.beforeN && recipe.afterN >= 2,
    JSON.stringify({ before: recipe.beforeN, after: recipe.afterN }));
  // THE POINT OF THE LIFT: with one onset the pitch rules are indistinguishable.
  ok('…which is what makes the pitch rules tell each other apart',
    recipe.afterDistinct > recipe.beforeDistinct && recipe.afterDistinct >= 3,
    JSON.stringify({ before: recipe.beforeDistinct, after: recipe.afterDistinct }));

  // ── 4. SILENCE EXPLAINS ITSELF ──────────────────────────────────────────
  // ♮ Chance at 40% over 8 steps rolls every slot silent about once in sixty —
  // legitimately — and a take never re-rolls itself, so that one draw is the
  // part for ever. Indistinguishable from a dead control unless it says so.
  const silent = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.rhythm.kind = 'chance';
    L.part.rhythm.chance = 40; L.part.rhythm.steps = 8; L.part.rhythm.syncop = 0;
    E.getCfg();
    try { V.render(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    const s = document.querySelector('.v2-layer .v2-recipesays');
    const sum = document.querySelector('.v2-layer .v2-recipesum');
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const L2 = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const n = (V.withEdit(() => V.withTake(0, () => V.notesFor(L2,
      { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 6 }))) || []).length;
    return { says: s ? s.textContent : '', sum: sum ? sum.textContent : '', n };
  });
  console.log('  a take that rolled empty: ' + silent.n + ' notes, fold says "' + silent.sum + '"');
  ok('a take that comes out silent is actually silent', silent.n === 0, silent.n + ' notes');
  ok('…and the panel says so rather than looking broken',
    /SILENT/i.test(silent.says) && /new take/i.test(silent.says), JSON.stringify(silent.says));
  ok('…with the fold naming it from outside', /silent/i.test(silent.sum), JSON.stringify(silent.sum));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
