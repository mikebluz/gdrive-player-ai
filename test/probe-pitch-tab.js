// PROBE — everything that depends on the Pitch choice lives under it.
//
// "move any params that are dependent on a Pitch selection into the Pitch tab".
// Each of these was an untabbed row, so each became a CHIP OF ITS OWN — and
// because they are gated per kind, the strip changed shape every time Pitch
// changed: a row of siblings that were really its children.
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
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);

  const run = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    const c = E.getCfg();
    c.prog = { on: true, name: 'P', chords: [{ root: 0, intervals: [0, 4, 7], bars: 1 }] };
    E._progAnchor = 0; E._barGridAnchor = 0;
    L().on = true; L().present = true; L().part.kind = 'live';
    L().instrument.voice = 'synth';
    E.getCfg();
    const repaint = async () => {
      const h = document.getElementById('bloom-v2-layers');
      const un = () => { const q = document.querySelector('.v2-layer'); if (q) q.classList.remove('collapsed'); };
      if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
      if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(140);
    };
    const openInstr = async () => {
      const d = document.querySelector('.v2-layer .v2-gototab[data-goto="Instrument"]');
      if (d) { d.click(); await wait(460); }
      return !!d;
    };
    const chips = () => [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')]
      .filter((x) => x.getBoundingClientRect().height > 0)
      .map((x) => x.getAttribute('data-tab'));
    const toTab = async (nm) => {
      const b = document.querySelector('.v2-layer .v2-pop-tabs [data-tab="' + nm + '"]');
      if (b) { b.click(); await wait(320); }
      return !!b;
    };
    const rowsNow = () => [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')]
      .filter((x) => x.getBoundingClientRect().height > 0)
      .map((x) => (((x.querySelector('label') || {}).textContent) || '?').trim());
    const look = async (pitch) => {
      L().part.pitch = pitch; E.getCfg();
      await repaint(); await openInstr();
      const strip = chips();
      const onPitch = await toTab('Pitch') ? rowsNow() : null;
      return { strip, onPitch };
    };
    const o = {};
    o.walk   = await look({ kind: 'walk', span: 7 });
    o.series = await look({ kind: 'series', dir: 'up', octaves: 2 });
    o.chord  = await look({ kind: 'chord', voices: 3 });
    o.mixed  = await look({ kind: 'mixed', voices: 3, mix: 50 });
    // …and a row still COMMITS from its new home
    L().part.pitch = { kind: 'walk', span: 7 }; E.getCfg();
    await repaint(); await openInstr(); await toTab('Pitch');
    { const el = document.querySelector('.v2-pop-pane .v2-f[data-f="part.pitch.span"]');
      o.spanThere = !!el;
      if (el) { el.value = '9'; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    await wait(360);
    o.spanWrote = (L().part.pitch.span | 0);
    return o;
  });

  const GONE = ['Voices', 'Note', 'Direction', 'Span', 'Home', 'Contour', 'Octaves', 'Mix', 'Lines'];
  const strips = ['walk', 'series', 'chord', 'mixed'].map((k) => run[k].strip);
  ok('none of the pitch sub-params is a chip of its own any more',
    strips.every((st) => GONE.every((g) => st.indexOf(g) < 0)),
    JSON.stringify(strips.map((st, i) => ['walk', 'series', 'chord', 'mixed'][i] + ': ' + st.join(' '))));
  ok('…Walk puts Lines, Note, Span, Home and Contour under Pitch',
    ['Pitch', 'Lines', 'Note', 'Span', 'Home', 'Contour'].every((r) => run.walk.onPitch.indexOf(r) >= 0),
    JSON.stringify(run.walk.onPitch));
  ok('…Series puts Note, Direction and Octaves there',
    ['Pitch', 'Note', 'Direction', 'Octaves'].every((r) => run.series.onPitch.indexOf(r) >= 0),
    JSON.stringify(run.series.onPitch));
  ok('…Chord puts Voices there',
    run.chord.onPitch.indexOf('Voices') >= 0 && run.chord.onPitch.indexOf('Pitch') >= 0,
    JSON.stringify(run.chord.onPitch));
  ok('…and Mixed puts Voices and Mix there',
    ['Pitch', 'Voices', 'Mix'].every((r) => run.mixed.onPitch.indexOf(r) >= 0),
    JSON.stringify(run.mixed.onPitch));
  // The tab shows only what THIS kind reads — that was true before and must stay true.
  ok('each kind shows only its own sub-params, not every kind\'s',
    run.walk.onPitch.indexOf('Direction') < 0 && run.series.onPitch.indexOf('Contour') < 0 &&
    run.chord.onPitch.indexOf('Span') < 0, JSON.stringify({ walk: run.walk.onPitch, series: run.series.onPitch }));
  // Deliberately left alone.
  ok('Harmony, Length and Voicing keep their own chips',
    strips.every((st) => st.indexOf('Harmony') >= 0 && st.indexOf('Length') >= 0) &&
    run.chord.strip.indexOf('Voicing') >= 0,
    JSON.stringify(run.chord.strip));
  ok('…and a row still commits from its new home',
    run.spanThere && run.spanWrote === 9, JSON.stringify(run.spanWrote));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  walk   strip: ' + run.walk.strip.join(' · '));
  console.log('  walk   Pitch: ' + run.walk.onPitch.join(' · '));
  console.log('  series Pitch: ' + run.series.onPitch.join(' · '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
