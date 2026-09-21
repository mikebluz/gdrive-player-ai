// PROBE — ♦ Beat: drums generate.
//
// user: "what about drums? we should probably have a Beat material type"
//
// Drums were the ONE layer type with no generator. The kit emitter read only
// the drawn `lanes`, so a beat had to be built cell by cell and 🎲 New take,
// Evolve and Salt had nothing to re-decide — a drum layer was permanently
// "recorded" while every pitched layer generated. And because every material
// in the menu writes `pitch`, which a kit answers with the lane, picking one on
// a drum layer changed nothing audible: nine dead doors and no live one.
//
// The generator existed one version back — v1's Beat was a euclid per lane
// (`euclidKit`/`euclidPattern`), and this file's own v1 importer still fills
// lanes with `euclidCells`. v2 kept the data and dropped the rules.
//
//   node test/probe-beat.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);

  const matOpts = () => page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    return sp ? [...sp.options].map((o) => o.value).filter(Boolean) : [];
  });

  // ── 1. EACH VOICE SEES ONLY THE MATERIALS IT CAN PLAY ───────────────────
  const synthOpts = await matOpts();
  console.log('\n  a SYNTH layer offers: ' + JSON.stringify(synthOpts));
  ok('a synth layer offers the pitched materials',
    synthOpts.indexOf('sustain') >= 0 && synthOpts.indexOf('ground') >= 0 && synthOpts.length >= 8,
    JSON.stringify(synthOpts));
  ok('…and not ♦ Beat, which it has no lanes for', synthOpts.indexOf('beat') < 0,
    JSON.stringify(synthOpts));

  // SHUT ⚙ DEEP BEFORE CHANGING THE INSTRUMENT, which is the order a person
  // works in anyway (pick the sound, then generate for it). Deep holds a STAGED
  // copy of the layer; switching the voice on the card underneath rebuilds it
  // and the draft goes stale, so the material press lands on a part that is
  // still a frozen synth — measured, and it reads exactly like the door being
  // broken.
  await page.evaluate(() => {
    const x = document.querySelector('.v2-layer .v2-gencancel, .v2-layer .v2-genclose');
    if (x) x.click();
  });
  await zz(900);
  await page.evaluate(() => {
    const sel = document.querySelector('.v2-layer .v2-f[data-f="instrument.voice"]');
    sel.value = 'kit';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1300);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  const kitOpts = await matOpts();
  console.log('  a KIT layer offers:   ' + JSON.stringify(kitOpts) + '\n');
  ok('a drum layer offers ♦ Beat', kitOpts.indexOf('beat') >= 0, JSON.stringify(kitOpts));
  // THE DEAD-DOOR BUG: all nine write `pitch`, which the kit emitter never
  // reads — picking one changed nothing audible.
  ok('…and NOT the nine that write a pitch it cannot play',
    kitOpts.length === 1 && kitOpts[0] === 'beat', JSON.stringify(kitOpts));

  // ── 2. PICKING IT BUILDS A REAL BEAT ────────────────────────────────────
  await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'beat';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1600);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const x = c.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !c.classList.contains('v2-gz-2')) x.click();
  });
  await zz(800);

  const built = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const card = document.querySelector('.v2-layer');
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !!e.offsetParent; };
    const row = card.querySelector('.v2-beatrow');
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 8 }))) || [];
    const by = {}; ns.forEach((x) => { if (Number.isFinite(x.lane)) by[x.lane] = (by[x.lane] || 0) + 1; });
    const at = (ln) => ns.filter((x) => x.lane === ln).map((x) => Math.round(x.at * 100) / 100);
    return {
      mat: L.part.mat, voice: (L.instrument || {}).voice,
      beat: JSON.parse(JSON.stringify(L.part.rhythm.beat || null)),
      n: ns.length, by, kickAt: at(0), snareAt: at(1), hatAt: at(2),
      rowShown: vis(row), rowW: row ? Math.round(row.getBoundingClientRect().width) : 0,
      labs: [...card.querySelectorAll('.v2-beatrow .v2-mini-lab')].map((x) => x.textContent),
      varyShown: vis(card.querySelector('.v2-f[data-f="part.rhythm.beat.vary"]')),
      // the pitched euclid row must be gone — a kit never reads `pulses`
      pulsesShown: vis(card.querySelector('.v2-genwrap .v2-f[data-f="part.rhythm.pulses"]')),
      says: (card.querySelector('.v2-gensays') || {}).textContent || '',
    };
  });
  console.log('  ' + built.n + ' hits: ' + JSON.stringify(built.by));
  console.log('  kick at  ' + JSON.stringify(built.kickAt));
  console.log('  snare at ' + JSON.stringify(built.snareAt));
  console.log('  lanes: ' + built.labs.join(' · '));
  console.log('  says: ' + JSON.stringify(built.says) + '\n');

  ok('picking ♦ Beat makes it a kit part with rules',
    built.mat === 'beat' && built.voice === 'kit' && !!built.beat,
    JSON.stringify({ mat: built.mat, voice: built.voice }));
  // A BACKBEAT, not merely "some notes": kick on every beat, snare on 2 and 4,
  // eighths on the hat. Over an 8s cycle of 16 steps a beat is 2s.
  ok('…and what it generates is a backbeat',
    built.by[0] === 4 && built.by[1] === 2 && built.by[2] === 8,
    JSON.stringify(built.by));
  ok('…with the snare on 2 and 4, not on 1 and 3',
    JSON.stringify(built.snareAt) === JSON.stringify([2, 6]), JSON.stringify(built.snareAt));
  ok('…and the kick on every beat',
    JSON.stringify(built.kickAt) === JSON.stringify([0, 2, 4, 6]), JSON.stringify(built.kickAt));

  // ── 3. AND IT IS REACHABLE ──────────────────────────────────────────────
  ok('the per-drum row is a real target', built.rowShown && built.rowW > 100,
    JSON.stringify({ shown: built.rowShown, w: built.rowW }));
  ok('…one knob per lane, each named after its drum',
    built.labs.length === 8 && built.labs[0] === 'Kick' && built.labs[1] === 'Snare' &&
    built.labs[2] === 'Hat', JSON.stringify(built.labs));
  ok('…with Vary beside them, which is what gives a beat a take', built.varyShown === true,
    'Vary not on screen');
  ok('…and the euclid row a kit never reads is gone', built.pulsesShown === false,
    'part.rhythm.pulses still showing on a drum layer');
  // THE READOUT COUNTED `pulses` — a leftover euclid default — and announced
  // "3 onsets" over a bar with fourteen.
  ok('…and the readout counts the drums, not a number nothing plays',
    /\b14 onsets\b/.test(built.says), JSON.stringify(built.says));

  // ── 4. THE KNOBS DRIVE IT ───────────────────────────────────────────────
  const knob = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const hits = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 8 }))) || [];
      const by = {}; ns.forEach((x) => { if (Number.isFinite(x.lane)) by[x.lane] = (by[x.lane] || 0) + 1; });
      return by;
    };
    const before = hits();
    const set = (li, v) => {
      const el = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.beat.lanes.' + li + '.p"]');
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(2, 16); await new Promise((r) => setTimeout(r, 600));
    const busyHat = hits();
    set(0, 0); await new Promise((r) => setTimeout(r, 600));
    const noKick = hits();
    set(0, 4); set(2, 8); await new Promise((r) => setTimeout(r, 600));
    return { before, busyHat, noKick, back: hits() };
  });
  console.log('  hat 8→16: ' + JSON.stringify(knob.busyHat) + '   kick→0: ' + JSON.stringify(knob.noKick) + '\n');
  ok('turning a drum up plays it more', knob.busyHat[2] === 16, JSON.stringify(knob.busyHat));
  ok('…and only that drum — the others are untouched',
    knob.busyHat[0] === knob.before[0] && knob.busyHat[1] === knob.before[1],
    JSON.stringify({ before: knob.before, after: knob.busyHat }));
  ok('…and 0 sits a drum out', !knob.noKick[0], JSON.stringify(knob.noKick));

  // ── 5. A BEAT HAS TAKES ─────────────────────────────────────────────────
  // A euclid is a FORMULA, so a fresh seed changes nothing about it — without
  // Vary, 🎲 New take would redraw the same bar for ever, which is the whole
  // reason drums felt inert.
  const takes = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const sig = (t) => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(t, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 8 }))) || [];
      return ns.map((x) => Math.round(x.at * 1000) + ':' + x.lane).join(' ');
    };
    const off = new Set([sig(0), sig(1), sig(2)]).size;
    { const l = Lat(); if (!l.part.rhythm.beat) return { off, on: -1, kept: -1 };
      l.part.rhythm.beat.vary = 45; E.getCfg(); }
    const s0 = sig(0), s1 = sig(1), s2 = sig(2);
    const a = new Set(s0.split(' ')), c = new Set(s1.split(' '));
    let same = 0; a.forEach((x) => { if (c.has(x)) same++; });
    return { off, on: new Set([s0, s1, s2]).size, kept: Math.round(same * 100 / Math.max(1, a.size)) };
  });
  console.log('  takes — Vary 0: ' + takes.off + ' distinct of 3;  Vary 45: ' + takes.on +
              ' distinct, ' + takes.kept + '% of take 0 kept\n');
  ok('with Vary at 0 a beat plays the same bar every take', takes.off === 1,
    takes.off + ' distinct');
  ok('…and with Vary up, 🎲 New take gives a different one', takes.on === 3,
    takes.on + ' distinct');
  // THINS MORE THAN IT THICKENS, so the pattern stays recognisable as itself.
  ok('…still recognisably the same beat, not a fresh one',
    takes.kept >= 30 && takes.kept <= 85, takes.kept + '% kept');

  // ── 6. CHARACTERS, AND THE DRAWN GRID STILL WORKS ───────────────────────
  const rest = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const hits = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 8 }))) || [];
      const by = {}; ns.forEach((x) => { if (Number.isFinite(x.lane)) by[x.lane] = (by[x.lane] || 0) + 1; });
      return by;
    };
    // VARY OFF FIRST. The take test above left it at 45, and a Character is a
    // set of PULSES — measuring it through live dice measures the dice, not the
    // Character (Half-time read 3/3/3 instead of 2/1/8). A probe that leaves
    // the dice on is testing something else.
    { const l = Lat(); if (l.part.rhythm.beat) delete l.part.rhythm.beat.vary; E.getCfg(); }
    const ps = document.querySelector('.v2-layer .v2-presetpick');
    const chars = ps ? [...ps.options].map((o) => o.value).filter(Boolean) : [];
    let half = null;
    if (chars.indexOf('halftime') >= 0) {
      ps.value = 'halftime';
      ps.dispatchEvent(new Event('input', { bubbles: true }));
      ps.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      half = hits();
    }
    const says = window._v2.rulesTextOf ? '' : '';
    // …and a kit with NO rules still plays what was drawn, byte for byte
    { const l = Lat(); delete l.part.rhythm.beat;
      l.part.rhythm.lanes[0] = l.part.rhythm.lanes[0].map((_, i) => (i % 4 === 0 ? 1 : 0));
      E.getCfg(); }
    return { chars, half, drawn: hits(), says };
  });
  console.log('  Characters: ' + JSON.stringify(rest.chars));
  console.log('  Half-time:  ' + JSON.stringify(rest.half));
  console.log('  drawn grid, no rules: ' + JSON.stringify(rest.drawn) + '\n');

  ok('♦ Beat has Characters of its own', rest.chars.length >= 6 &&
    rest.chars.indexOf('backbeat') >= 0 && rest.chars.indexOf('halftime') >= 0,
    JSON.stringify(rest.chars));
  // HALF-TIME IS THE SNARE WAITING FOR 3 — one hit, not two.
  ok('…and picking one changes the beat', !!rest.half && rest.half[1] === 1 && rest.half[0] === 2,
    JSON.stringify(rest.half));
  // ADDITIVE AND ABSENT BY DEFAULT: every kit made before this keeps playing
  // its drawn grid, untouched.
  ok('a kit with no rules still plays what was drawn',
    rest.drawn[0] === 4 && !rest.drawn[1] && !rest.drawn[2], JSON.stringify(rest.drawn));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
