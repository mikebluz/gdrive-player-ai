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
  // NAMED, NOT COUNTED. This check is about a synth seeing PITCHED materials,
  // not about how many there are — keyed on the length it broke twice as the
  // list was consolidated, each time pointing at the wrong feature.
  ok('a synth layer offers the pitched materials',
    synthOpts.indexOf('sustain') >= 0 && synthOpts.indexOf('ground') >= 0 &&
    synthOpts.indexOf('one') >= 0 && synthOpts.length >= 5,
    JSON.stringify(synthOpts));
  // LISTED ON A SYNTH TOO (2026-09-21, user: "where is Beat option?" - asked of
  // a synth layer, where it was hidden). It can be, because `makeBeat` sets the
  // voice itself, so picking it there is a complete action; hiding it made it
  // undiscoverable, since the only thing that would have told you to switch the
  // instrument was behind that switch.
  ok('…and ♦ Beat too, which brings its own instrument',
    synthOpts.indexOf('beat') >= 0, JSON.stringify(synthOpts));

  // PICKING IT ON A SYNTH IS A COMPLETE ACTION - it brings the kit with it.
  // That is what lets the door be listed everywhere, so it is checked here
  // rather than assumed.
  const conv = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'beat';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1600));
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    return { voice: (L.instrument || {}).voice, mat: L.part.mat,
             hasRules: !!(L.part.rhythm || {}).beat };
  });
  console.log('  picking Beat on a SYNTH: ' + JSON.stringify(conv) + '\n');
  ok('picking ♦ Beat on a synth turns the layer into a kit',
    conv.voice === 'kit' && conv.mat === 'beat' && conv.hasRules, JSON.stringify(conv));

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
  // THE ASYMMETRY IS THE POINT: the pitched materials cannot return the favour,
  // because on a kit they write a `pitch` nothing reads.
  ok('…and NOT the pitched ones, which write a pitch it cannot play',
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

  // ── 7. THE GROOVE HOLDS ITS TEMPO AT ANY CYCLE LENGTH ───────────────────
  // Reported 2026-09-22: "Beat content gen seems weird, preview only plays the
  // first 4 bars of the visualized content, it's also much slower than it
  // should be". `makeBeat` sized the cycle to the whole arrangement part and
  // `rhythm.steps` is a grid per CYCLE, so a 16-step pattern over an 8-bar
  // part was TWO STEPS PER BAR — a kick every two bars, eight times too slow.
  // Both halves of the fix are measured here: the cycle is one bar, and the
  // euclid is solved per bar and tiled so nothing that later moves `bars`
  // (◫ Per part refits it on every normalize) can take the tempo with it.
  const tempo = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L = () => (E.getCfg().layers || [])[0];
    // THE PART THAT WAS REPORTED: three changes, eight bars. The whole bug
    // needs a LONG part to show itself — on a short one a beat that wrongly
    // mirrors the part is still roughly in tempo and still previews whole, so
    // a probe on a 2-bar part would watch the fix fail and call it a pass.
    { const cfg = E.getCfg();
      cfg.prog.on = true;
      cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 3 },
        { root: 4, intervals: [0, 3, 7], bars: 3 },
        { root: 5, intervals: [0, 4, 7], bars: 2 }];
      delete cfg.prog.parts; delete cfg.prog.chain;
      delete cfg.prog.arrGrid; delete cfg.prog.grid;
      E.getCfg(); }
    V.makeBeat(E, L());
    const fresh = (L().part.bars);
    // MEASURED BEFORE `run` MOVES `bars` — this is the cycle a press of ▶
    // would actually audition.
    const freshCyc = V.cycleSec(L(), E.getCfg());
    const run = (bars) => {
      L().part.bars = bars; E.getCfg();
      const l = L();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const cyc = V.cycleSec(l, E.getCfg());
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [];
      const spb = cyc / Math.max(0.001, l.part.bars);
      const k = ns.filter((x) => x.lane === 0).map((x) => x.at / spb).sort((a, b) => a - b);
      const gaps = k.slice(1).map((v, i) => v - k[i]);
      return { bars: l.part.bars, cyc,
        perBar: k.length / Math.max(0.001, l.part.bars),
        // the widest spacing between two kicks, in bars — 0.25 is four to the bar
        maxGap: gaps.length ? Math.max.apply(null, gaps) : 0 };
    };
    return { fresh, freshCyc, one: run(1), eight: run(8), frac: run(2.5) };
  });
  console.log('  fresh bars=' + tempo.fresh + ' (' +
    (Math.round(tempo.freshCyc * 100) / 100) + 's, part is 8 bars)  |  ' +
    [tempo.one, tempo.eight, tempo.frac].map((r) =>
      r.bars + 'bar:' + (Math.round(r.perBar * 100) / 100) + '/bar').join('  ') + '\n');

  // A GROOVE IS A LOOP, not a phrase — it does not take the part's length, and
  // that is also what keeps its cycle inside the 8s preview cap, so the preview
  // plays the whole of what it drew instead of the first four bars of it.
  ok('a fresh ♦ Beat is a one-bar loop', tempo.fresh === 1, 'bars=' + tempo.fresh);
  ok('…and its cycle previews whole (under the 8s cap)', tempo.freshCyc <= 8,
    (Math.round(tempo.freshCyc * 100) / 100) + 's');
  // FOUR TO THE BAR AT EVERY LENGTH. Before the fix an 8-bar cycle gave 0.5.
  ok('the kick stays four to the bar on a long cycle',
    Math.abs(tempo.eight.perBar - 4) < 0.01 && Math.abs(tempo.eight.maxGap - 0.25) < 0.01,
    tempo.eight.perBar + '/bar, widest gap ' + (Math.round(tempo.eight.maxGap * 1000) / 1000) + ' bars');
  // A FRACTIONAL CYCLE truncates its last bar rather than stretching the grid.
  ok('…and on a fractional one', Math.abs(tempo.frac.perBar - 4) < 0.01 &&
    Math.abs(tempo.frac.maxGap - 0.25) < 0.01,
    tempo.frac.perBar + '/bar, widest gap ' + (Math.round(tempo.frac.maxGap * 1000) / 1000) + ' bars');

  // ── 8. ⊞ RESOLUTION — THE GROOVE'S SPEED, AND A DOOR ONTO IT ────────────
  // user, 2026-09-22: "default generated beat should be 2x as dense … also
  // there should be a Resolution parameter so the user can adjust that scaling
  // of the beat". It is the per-bar grid, and it moves the whole beat's speed:
  // the lane pulses scale with it, so ⊞ 32 plays the same pattern double-time.
  // A quantiser that left the pulses alone would be the same beat on a finer
  // grid — no change in speed at all, which is what was asked for.
  await page.evaluate(() => {
    const x = document.querySelector('.v2-layer .v2-gencancel, .v2-layer .v2-genclose');
    if (x) x.click();
  });
  await zz(900);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const x = c.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !c.classList.contains('v2-gz-2')) x.click();
  });
  await zz(800);

  const resDoor = await page.evaluate(() => {
    const sel = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.beat.per"]');
    if (!sel) return { there: false };
    // MEASURED, not merely found — a `querySelector` hit proves nothing and a
    // 0×0 rect is the tell (the house rule for every new control).
    const r = sel.getBoundingClientRect();
    const lane = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.beat.lanes.0.p"]');
    return { there: true, w: Math.round(r.width), h: Math.round(r.height),
             reachable: r.width > 0 && r.height > 0 && !!sel.offsetParent,
             opts: [...sel.options].map((o) => o.value), value: sel.value,
             laneMax: lane ? lane.getAttribute('max') : null,
             inView: r.right <= document.documentElement.clientWidth + 1 };
  });
  console.log('  ⊞ Resolution: ' + JSON.stringify(resDoor) + '\n');
  ok('⊞ Resolution is on screen and a real target',
    resDoor.there && resDoor.reachable && resDoor.w > 40, JSON.stringify(resDoor));
  ok('…offering musical divisions of a bar, sixteenths by default',
    JSON.stringify(resDoor.opts) === JSON.stringify(['4', '8', '12', '16', '24', '32', '48', '64']) &&
    resDoor.value === '16', JSON.stringify({ opts: resDoor.opts, v: resDoor.value }));
  // NO HORIZONTAL SCROLLING, EVER — the row is a plain `.ambient-ctrl`, so it
  // shrinks with its neighbours rather than pushing the card wide.
  ok('…and it fits the card at 390px', resDoor.inView === true, 'w=' + resDoor.w);
  // THE LANE STEPPERS COUNT IN THE GRID, so their ceiling is it.
  ok('…with the per-drum knobs capped at the grid, not a fixed 32',
    resDoor.laneMax === '16', 'max=' + resDoor.laneMax);

  const scale = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    { const l = Lat(); l.part.bars = 2; if (l.part.rhythm.beat) delete l.part.rhythm.beat.vary; E.getCfg(); }
    const read = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const cyc = V.cycleSec(l, E.getCfg());
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: cyc }))) || [];
      const spb = cyc / Math.max(0.001, l.part.bars);
      const k = ns.filter((x) => x.lane === 0).map((x) => x.at / spb).sort((a, b) => a - b);
      const gaps = k.slice(1).map((v, i) => v - k[i]);
      const by = {}; ns.forEach((x) => { if (Number.isFinite(x.lane)) by[x.lane] = (by[x.lane] || 0) + 1; });
      return { per: V.beatPerOf(l.part.rhythm.beat),
               lanes: (l.part.rhythm.beat.lanes || []).map((e) => (e && e.p | 0) || 0).slice(0, 3),
               kickPerBar: Math.round((k.length / l.part.bars) * 100) / 100,
               minGap: gaps.length ? Math.round(Math.min.apply(null, gaps) * 1000) / 1000 : 0,
               total: ns.length, by,
               says: (document.querySelector('.v2-layer .v2-gensays') || {}).textContent || '' };
    };
    const set = async (v) => {
      const sel = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.beat.per"]');
      sel.value = String(v);
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      return read();
    };
    const at16 = read();
    const at32 = await set(32);
    const at8 = await set(8);
    const back = await set(16);
    // SAVE-COMPAT: sixteenths is ABSENT from the store, so a project that
    // never touched the knob is written byte for byte as it was.
    const stored16 = JSON.stringify(Lat().part.rhythm.beat.per === undefined);
    const at24 = await set(24);
    // …AND A GRID THAT WAS MOVED SURVIVES THE MIGRATION CHOKEPOINT.
    // Asked of the CFG layer, not the draft: ⚙ Deep is a sandbox and its edits
    // are not in cfg until ✓ Done, so reading cfg here would measure the
    // sandbox working rather than the field persisting.
    const cl = (E.getCfg().layers || [])[0];
    cl.part.rhythm.beat.per = 24; E.getCfg();
    const cfgHasPer = ((E.getCfg().layers || [])[0].part.rhythm.beat || {}).per;
    // A GRID NOBODY OFFERS IS NOT ONE: normalize drops it back to the default
    // rather than letting a hand-edited save state a resolution the panel
    // cannot show and the Characters are not written in.
    cl.part.rhythm.beat.per = 13; E.getCfg();
    const cfgOdd = ((E.getCfg().layers || [])[0].part.rhythm.beat || {}).per;
    return { at16, at32, at8, back, at24, stored16, cfgHasPer, cfgOdd };
  });
  console.log('  ⊞ 16: ' + JSON.stringify(scale.at16.lanes) + ' → ' + scale.at16.kickPerBar +
    ' kicks/bar, gap ' + scale.at16.minGap + ' bars');
  console.log('  ⊞ 32: ' + JSON.stringify(scale.at32.lanes) + ' → ' + scale.at32.kickPerBar +
    ' kicks/bar, gap ' + scale.at32.minGap + ' bars');
  console.log('  ⊞  8: ' + JSON.stringify(scale.at8.lanes) + ' → ' + scale.at8.kickPerBar +
    ' kicks/bar, gap ' + scale.at8.minGap + ' bars');
  console.log('  says at 16: ' + JSON.stringify(scale.at16.says));
  console.log('  says at 24: ' + JSON.stringify(scale.at24.says) + '\n');

  // TWICE THE GRID IS TWICE THE SPEED — the whole point of the knob.
  ok('⊞ 32 plays the same beat twice as fast',
    scale.at32.kickPerBar === scale.at16.kickPerBar * 2 &&
    Math.abs(scale.at32.minGap - scale.at16.minGap / 2) < 0.002,
    JSON.stringify({ at16: scale.at16.kickPerBar, at32: scale.at32.kickPerBar }));
  ok('…because the pattern scales with the grid, not just the quantising',
    JSON.stringify(scale.at32.lanes) === JSON.stringify([8, 4, 16]),
    JSON.stringify(scale.at32.lanes));
  ok('…and ⊞ 8 plays it half-time', scale.at8.kickPerBar === scale.at16.kickPerBar / 2,
    JSON.stringify({ at8: scale.at8.kickPerBar, at16: scale.at16.kickPerBar }));
  // ROUND TRIP: back to sixteenths is the beat you started with, not a
  // pattern quietly eroded by two roundings.
  ok('…and coming back to ⊞ 16 is the beat you started with',
    JSON.stringify(scale.back.lanes) === JSON.stringify(scale.at16.lanes) &&
    scale.back.kickPerBar === scale.at16.kickPerBar,
    JSON.stringify({ back: scale.back.lanes, was: scale.at16.lanes }));
  // ADDITIVE AND ABSENT BY DEFAULT — the one rule every new field here obeys.
  ok('sixteenths stores nothing, so an untouched project is byte-identical',
    scale.stored16 === 'true', scale.stored16);
  ok('…and a grid that was moved is stored and survives normalize',
    scale.cfgHasPer === 24, JSON.stringify(scale.cfgHasPer));
  ok('…while a grid nobody offers falls back to sixteenths',
    scale.cfgOdd === undefined, JSON.stringify(scale.cfgOdd));
  // THE READOUT THAT MISREPORTED THE DENSITY. It divided the per-bar pulses by
  // the CYCLE's length and announced "14 onsets over 8.13 bars (≈1.7 a bar)"
  // for a backbeat playing fourteen to the bar — which is how a slow-beat bug
  // came to be reported as a density one.
  ok('the readout counts a beat per BAR, not spread over the cycle',
    /\(14 a bar\)/.test(scale.at16.says) && /\bonsets over\b/.test(scale.at16.says), JSON.stringify(scale.at16.says));
  // A FOLDED CHANGE IS NEVER INVISIBLE: a grid away from sixteenths is named.
  ok('…and it names the grid when it is not sixteenths',
    /⊞ 24 a bar/.test(scale.at24.says), JSON.stringify(scale.at24.says));

  // A CHARACTER IS WRITTEN IN SIXTEENTHS and must arrive on the grid the layer
  // is actually on — Motorik's hat "never stops", which is 16 a bar at ⊞ 16 and
  // 32 at ⊞ 32. Written raw it would be a half-speed hat and the card would
  // still call the Character untouched, so both ends are checked.
  const chr = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const set = async (sel, v) => {
      const el = document.querySelector('.v2-layer ' + sel);
      if (!el) return false;
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      return true;
    };
    await set('.v2-f[data-f="part.rhythm.beat.per"]', 32);
    const had = await set('.v2-presetpick', 'motorik');
    const l = Lat();
    return { had, per: V.beatPerOf(l.part.rhythm.beat),
             lanes: (l.part.rhythm.beat.lanes || []).map((e) => (e && e.p | 0) || 0).slice(0, 3),
             tuned: (V.presetState(l) || {}).tuned, id: (V.presetState(l) || {}).id };
  });
  console.log('  Motorik at ⊞ 32: ' + JSON.stringify(chr) + '\n');
  ok('a Character picked at ⊞ 32 keeps its shape, at the grid it landed on',
    chr.had && chr.per === 32 && JSON.stringify(chr.lanes) === JSON.stringify([8, 4, 32]),
    JSON.stringify(chr));
  ok('…and the card does not call it tuned for values it wrote itself',
    chr.id === 'motorik' && chr.tuned === false, JSON.stringify({ id: chr.id, tuned: chr.tuned }));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
