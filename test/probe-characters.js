// PROBE — every Character applies, survives normalize, and CHANGES the notes.
//
// "add more Character options." A preset that stores a value the normalizer
// rejects is a dead entry in a dropdown: it reads back as the fallback and the
// card then says "tuned" for a Character nobody tuned. So each one is applied
// and read back field by field, and then asked whether it actually changed
// what the layer plays.
//
//   node test/probe-characters.js        (needs `npm start` on :3001)
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
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] },
                       { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);

  const out = await page.evaluate(() => {
    const E = _masterEng;
    // RE-READ THE LAYER EVERY TIME. `_normalizeAmbientCfg` runs on every
    // `getCfg()` and REPLACES objects, so a reference held across one is an
    // orphan — an earlier cut of this probe generated its notes from a layer
    // captured before `applyPreset`, and reported two obviously-different
    // Characters as sounding identical.
    const Lat = () => (E.getCfg().layers || [])[0];
    const list = window._v2.presets || null;
    if (!list) return { err: 'presets not published' };
    const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    const notes = () => {
      const L = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      return (window._v2.withEdit(() => window._v2.withTake(window._v2.pinOf(L),
        () => window._v2.notesFor(L, { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 }))) || [])
        .map((n) => Math.round((n.at) * 1000) + ':' +
             Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)) + ':' + Math.round(n.durMs))
        .join(' ');
    };
    const byShape = {};
    const rows = [];
    list.forEach((pr) => {
      const L0 = Lat();
      L0.part.kind = 'live'; L0.part.bars = 3; L0.part.notes = [];
      delete L0.part.vary; delete L0.chg; delete L0.part.clock; delete L0.part.ms;
      E.getCfg();
      let applied = false;
      try { applied = !!window._v2.applyPreset(E, Lat(), pr.id); } catch (e) { applied = 'err ' + e; }
      E.getCfg();
      const Lr = Lat();
      // every field the Character states must read back as what it stated
      const bad = Object.keys(pr.set).filter((path) => {
        const want = pr.set[path];
        const got = (path.indexOf('part.') === 0 || path.indexOf('instrument.') === 0)
          ? get(Lr, path) : get(Lr, path);
        // absent-by-default fields legitimately normalize '' / 0 away
        if ((want === '' || want === 0) && (got === undefined || got === '' || got === 0)) return false;
        return got !== want;
      });
      const st = window._v2.presetState ? window._v2.presetState(Lr) : null;
      const sig = notes();
      (byShape[pr.shape] = byShape[pr.shape] || []).push(pr.id);
      rows.push({ id: pr.id, shape: pr.shape, label: pr.label, applied, bad,
                  stateId: st ? st.id : null, tuned: st ? st.tuned : null,
                  n: sig ? sig.split(' ').length : 0, sig });
    });
    return { rows, byShape, total: list.length };
  });

  if (out.err) { console.log('  ' + out.err); await browser.close(); process.exit(2); }

  console.log('\n  ' + out.total + ' Characters across ' + Object.keys(out.byShape).length + ' shapes:\n');
  Object.keys(out.byShape).forEach((s) => console.log('   ' + s.padEnd(9) + out.byShape[s].join(' · ')));
  console.log('');

  out.rows.forEach((r) => {
    ok(r.shape + ' · ' + r.label + ' — applies, and every value it states survives normalize',
      r.applied === true && r.bad.length === 0,
      'applied=' + r.applied + (r.bad.length ? '  rejected: ' + r.bad.join(', ') : ''));
  });
  console.log('');
  out.rows.forEach((r) => {
    ok(r.shape + ' · ' + r.label + ' — the card reads it back as itself, untuned',
      r.stateId === r.id && r.tuned === false,
      JSON.stringify({ stateId: r.stateId, tuned: r.tuned }));
  });

  // …and each one must PLAY differently from its siblings on the same shape.
  console.log('');
  Object.keys(out.byShape).forEach((shape) => {
    const mine = out.rows.filter((r) => r.shape === shape);
    const sigs = new Set(mine.map((r) => r.sig));
    ok(shape + ' — its ' + mine.length + ' Characters all sound different from each other',
      sigs.size === mine.length,
      mine.map((r) => r.label + ':' + r.n).join(' · '));
  });

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
