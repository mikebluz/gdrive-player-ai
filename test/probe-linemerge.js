// PROBE — ♪ Play a line: three materials become one door and a Moves knob.
//
// user: "can we consolidate some of these materials?"
//
// Arpeggiate, Roll a line and Scatter tones are all ONE NOTE AT A TIME; they
// differ only in how the next pitch is chosen — series steps through the chord
// in order, walk wanders, chance takes any tone. That is exactly the axis the
// ♪ Lines panel already calls MOVES, so it becomes a knob and they become one
// material, with all fourteen of their Characters behind it.
//
// NOTHING IS MIGRATED, and that is the risky half: a saved part keeps the
// `arp` / `roll` / `melody` / `scatter` stamp it already has, and `matDoorOf`
// resolves it at every boundary that turns a stamp into a door. A provenance
// mismatch fails SILENTLY — a part quietly reporting the wrong material, or a
// picker showing the first option because none matched — so the old stamps are
// checked here as carefully as the new one.
//
//   node test/probe-linemerge.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }];
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
  await zz(1400);

  // ── 1. ONE DOOR WHERE THERE WERE THREE ──────────────────────────────────
  const offered = await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    return sp ? [...sp.options].map((o) => o.value).filter(Boolean) : [];
  });
  console.log('\n  materials offered: ' + JSON.stringify(offered) + '\n');
  ok('♪ Play a line is one door', offered.indexOf('line') >= 0, JSON.stringify(offered));
  ok('…and the three it replaces are gone from the menu',
    ['arp', 'roll', 'scatter'].every((k) => offered.indexOf(k) < 0), JSON.stringify(offered));
  // THE ARITHMETIC, so a future change to the list has to think about it:
  // the nine it started with, plus Bass, minus the three merged here, plus
  // Play a line = EIGHT on a synth. (Beat is kit-only and not in this list.)
  ok('…leaving the menu at eight entries rather than ten',
    offered.length === 8, offered.length + ' entries: ' + JSON.stringify(offered));

  // ── 2. IT BUILDS, AND MOVES IS A REAL KNOB ──────────────────────────────
  const built = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'line';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1600));
    const card = document.querySelector('.v2-layer');
    const x = card.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !card.classList.contains('v2-gz-2')) x.click();
    await new Promise((r) => setTimeout(r, 700));
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !!e.offsetParent; };
    // `.v2-moves` SPECIFICALLY: `part.pitch.kind` has two controls now - this
    // one, and Advanced: recipe's full-grain copy behind a fold. A bare
    // `[data-f]` query finds whichever comes first in the DOM (the recipe's,
    // shut, measuring 0x0) and reads as Moves being missing.
    const mv = card.querySelector('.v2-genwrap .v2-moves');
    const l = Lat();
    return {
      mat: l.part.mat, pk: l.part.pitch.kind,
      movesShown: vis(mv), moves: mv ? [...mv.options].map((o) => o.value) : null,
    };
  });
  console.log('  built: mat=' + built.mat + ' pitch=' + built.pk);
  console.log('  Moves on screen: ' + built.movesShown + '  ' + JSON.stringify(built.moves) + '\n');
  ok('picking it stamps the merged material', built.mat === 'line', JSON.stringify(built.mat));
  // THE MERGE HAS TO BE REACHABLE AS A CONTROL, not only as a side effect of
  // picking a Character — otherwise it has hidden two materials, not combined
  // them.
  ok('…and Moves is on screen, offering all three',
    built.movesShown && !!built.moves && ['series', 'walk', 'chance'].every((k) => built.moves.indexOf(k) >= 0),
    JSON.stringify({ shown: built.movesShown, opts: built.moves }));

  // …and each setting actually changes the notes.
  const moves = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const sig = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      return (V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 8 }))) || [])
        .map((n) => Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).join(',');
    };
    const out = {};
    for (const k of ['series', 'walk', 'chance']) {
      const el = document.querySelector('.v2-layer .v2-genwrap .v2-moves');
      el.value = k;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      out[k] = sig();
    }
    return out;
  });
  const distinct = new Set(Object.values(moves).filter(Boolean)).size;
  console.log('  Run:     ' + moves.series);
  console.log('  Wander:  ' + moves.walk);
  console.log('  Scatter: ' + moves.chance);
  console.log('  -> ' + distinct + ' distinct lines of 3\n');
  ok('each Moves setting gives a different line', distinct === 3,
    JSON.stringify(moves));

  // ── 3. ALL FOURTEEN CHARACTERS LIVE BEHIND THE ONE DOOR ─────────────────
  const chars = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const ps = () => document.querySelector('.v2-layer .v2-presetpick');
    const list = ps() ? [...ps().options].map((o) => o.value).filter(Boolean) : [];
    // RE-QUERY EACH TIME: applying one re-renders the card and detaches the
    // select, so a cached reference silently no-ops on the next apply.
    const apply = async (cid) => {
      const el = ps(); if (!el) return null;
      el.value = cid;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const l = Lat();
      return { pk: l.part.pitch.kind, rk: l.part.rhythm.kind, mat: l.part.mat };
    };
    return { list, up: await apply('arpup'), riff: await apply('riff'),
             scat: await apply('linescatter') };
  });
  console.log('  Characters: ' + JSON.stringify(chars.list));
  console.log('  Up → ' + JSON.stringify(chars.up));
  console.log('  Riff → ' + JSON.stringify(chars.riff));
  console.log('  Scattered → ' + JSON.stringify(chars.scat) + '\n');

  ok('every Character from all three materials is behind the one door',
    chars.list.length >= 14 && chars.list.indexOf('arpup') >= 0 &&
    chars.list.indexOf('riff') >= 0 && chars.list.indexOf('linescatter') >= 0,
    chars.list.length + ': ' + JSON.stringify(chars.list));
  // AN ARPEGGIO MUST STILL BE AN ARPEGGIO. `setSpeedFn` keeps whatever rhythm
  // kind is already there, so without the Character stating `pulse` an "Up"
  // applied over the roll's euclid came out syncopated — which is not an
  // arpeggio, and reproducing Arpeggiate exactly is the promise of the merge.
  ok('…an arp Character still gives an even arpeggio',
    !!chars.up && chars.up.pk === 'series' && chars.up.rk === 'pulse',
    JSON.stringify(chars.up));
  ok('…a roll Character still wanders', !!chars.riff && chars.riff.pk === 'walk',
    JSON.stringify(chars.riff));
  ok('…and Scatter finally has one of its own',
    !!chars.scat && chars.scat.pk === 'chance', JSON.stringify(chars.scat));

  // ── 4. THE OLD STAMPS STILL RESOLVE ─────────────────────────────────────
  // The silent-failure case: nothing on disk is rewritten, so a part saved as
  // `arp` must still find its door, its name and its Characters.
  const legacy = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const out = {};
    for (const old of ['arp', 'roll', 'melody', 'scatter']) {
      const l = Lat();
      l.part.kind = 'live'; l.part.mat = old; E.getCfg();
      try { V.render(E); } catch (e) {}
      await new Promise((r) => setTimeout(r, 800));
      const sp = document.querySelector('.v2-layer .v2-shapepick');
      const ps = document.querySelector('.v2-layer .v2-presetpick');
      out[old] = {
        picked: sp ? sp.value : null,
        chars: ps ? [...ps.options].map((o) => o.value).filter(Boolean).length : 0,
      };
    }
    return out;
  });
  console.log('  a part still stamped…');
  Object.keys(legacy).forEach((k) => console.log('    ' + k.padEnd(8) + ' → picker shows "' +
    legacy[k].picked + '", ' + legacy[k].chars + ' Characters'));
  console.log('');
  ok('every old stamp selects the merged door',
    Object.keys(legacy).every((k) => legacy[k].picked === 'line'),
    JSON.stringify(legacy));
  ok('…and still finds its Characters',
    Object.keys(legacy).every((k) => legacy[k].chars >= 14), JSON.stringify(legacy));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
