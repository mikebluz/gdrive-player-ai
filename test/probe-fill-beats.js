// PROBE — ◫ Fill puts its onsets on beats, at any part length.
//
// user, 2026-09-22: "why is default generated bass content not lined up with
// whole beats".
//
// Because the grid divided the CYCLE. ◢ Bass is a euclid of 4 pulses over 16
// steps, so on an 8.13-bar part one step is 8.13/16 = 0.508 bars ≈ 2.03 beats:
// no onset can land on a beat, and the four notes sit two bars apart. The
// Characters are written in per-BAR units ("Roots" is four to the bar,
// "Pumping" eighths) exactly as ♦ Beat's lanes are, and they only mean what
// their names say when the pattern is solved over ONE BAR and tiled.
//
// Gated on `barsMode === 'fill'` — the layer asking for this in its own words.
// A `stretch` part wants one pattern over the whole cycle and must not move.
//
//   node test/probe-fill-beats.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1500);

  // ONSET POSITIONS IN BEATS, over the part — the unit the question was asked
  // in. A cycle fraction cannot answer "is this on a beat"; bars and beats can.
  const beatsFor = (bars, mode, spec) => page.evaluate(async (bars, mode, spec) => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    L.instrument = L.instrument || {}; L.instrument.voice = 'synth';
    L.part.kind = 'live';
    delete L.part.form;
    L.part.bars = bars;
    if (mode) L.part.barsMode = mode; else delete L.part.barsMode;
    L.part.rhythm = JSON.parse(JSON.stringify(spec));
    L.part.pitch = Object.assign({}, L.part.pitch, { kind: 'fixed', degree: 1 });
    E.getCfg();
    const l = (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(l, E.getCfg());
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
      { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [];
    const perBar = cyc / Math.max(0.001, +l.part.bars || 1);
    // beat index from the start of the part, 4 beats to the bar
    const beats = ns.map((x) => Math.round((x.at / perBar) * 4 * 1000) / 1000);
    return { bars: +l.part.bars, n: ns.length, beats: beats.slice(0, 40) };
  }, bars, mode, spec);

  const BASS = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
  const onBeat = (b) => Math.abs(b - Math.round(b)) < 0.02;

  // ── THE REPORTED CASE ───────────────────────────────────────────────────
  const rep = await beatsFor(8.13, 'fill', BASS);
  const off = rep.beats.filter((b) => !onBeat(b));
  console.log('\n  ◢ Bass, fill, 8.13 bars: ' + rep.n + ' onsets, first beats ' +
    JSON.stringify(rep.beats.slice(0, 8)));
  ok('a filled euclid puts every onset on a whole beat',
    rep.n > 0 && off.length === 0,
    off.length + ' off-beat of ' + rep.n + ' — e.g. ' + JSON.stringify(off.slice(0, 5)));
  // FOUR TO THE BAR, which is what "Roots" means. Eight whole bars of it plus a
  // fractional ninth that truncates.
  ok('…four to the bar, tiled across the part',
    rep.n === Math.floor(8.13 * 4) + 1 || rep.n === Math.floor(8.13 * 4),
    rep.n + ' onsets over 8.13 bars — wanted about ' + Math.floor(8.13 * 4));
  ok('…starting on beat 1', rep.beats[0] === 0, JSON.stringify(rep.beats[0]));

  // ── AND AT OTHER LENGTHS, WHOLE AND FRACTIONAL ──────────────────────────
  for (const bars of [1, 4, 8, 2.5]) {
    const r = await beatsFor(bars, 'fill', BASS);
    const bad = r.beats.filter((b) => !onBeat(b));
    console.log('  ' + String(bars).padEnd(5) + ' bars: ' + String(r.n).padStart(3) +
      ' onsets, ' + bad.length + ' off-beat');
    ok('…and at ' + bars + ' bar' + (bars === 1 ? '' : 's') + ' too',
      r.n > 0 && bad.length === 0, bad.length + ' off-beat of ' + r.n);
  }

  // ── A STRETCH PART IS NOT TOUCHED ───────────────────────────────────────
  // It is asking for the opposite — ONE pattern spread over the whole cycle —
  // so the fix must not reach it. Four onsets over 8 bars, off the beat, is
  // CORRECT here and the check says so.
  const st = await beatsFor(8, 'stretch', BASS);
  console.log('  stretch, 8 bars: ' + st.n + ' onsets, beats ' + JSON.stringify(st.beats) + '\n');
  ok('a stretch part still spreads one pattern over the whole cycle',
    st.n === 4, st.n + ' onsets — wanted the 4 the pattern states');

  // ── THE PULSE RHYTHM FILLS THE SAME WAY ─────────────────────────────────
  // ▪ Repeat one note is `pulse n:4` with fill, and "an ostinato" means four a
  // bar however long the part is.
  const pu = await beatsFor(6, 'fill', { kind: 'pulse', n: 4, steps: 16 });
  const puBad = pu.beats.filter((b) => !onBeat(b));
  console.log('  pulse 4, fill, 6 bars: ' + pu.n + ' onsets, ' + puBad.length + ' off-beat');
  ok('a filled pulse is that many per bar, on the beat',
    pu.n === 24 && puBad.length === 0, pu.n + ' onsets, ' + puBad.length + ' off-beat');

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
