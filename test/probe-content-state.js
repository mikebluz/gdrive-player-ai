// PROBE — CONTENT STATE: does pressing Play or Preview edit a layer's notes?
//
// Reported as "pressing play and/or preview seems to edit the notes (changes
// length, adds new notes that weren't there before)".
//
// TWO HALVES, because the answer is different for each:
//
//   1 · THE STORE NEVER MOVES. `L.part.notes` survives Preview, Play and Stop
//       byte-for-byte in every configuration measured — Everywhere, per-part,
//       barsMode fill, a free clock, a lenSync binding. Nothing in the
//       playback path writes the note list. Pinned here so a future change
//       that DOES write it fails loudly instead of being reported as this.
//
//   2 · THE NOTES STILL CHANGE, and the card says they do not. A GENERATED
//       part with no vary and no Evolve is what `liveness()` calls FIXED. If
//       its cycle does not DIVIDE the changes (the readout's own "repeats
//       1.5x over the 3-bar part"), every pass sits over different chords and
//       the pitch rules re-resolve against them — so every note moves, pass
//       to pass, for ever. Measured through `notesFor`, which is the ONE seam
//       the emitter, the drawing and the outlines all pass through, so this
//       is what SOUNDS, not a drawing artefact.
//       Aligning the cycle to the changes collapses it to one note set, which
//       is what makes the cause unambiguous.
//       `liveness()` counts three ways the changes can move (salt, prog.vary,
//       alternates) and not this one — so the badge reads FIXED with NO tags
//       while the thing it describes is the only thing moving.
//
//   node test/probe-content-state.js     (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
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
  // A REAL ARRANGEMENT: four chords, two parts of DIFFERENT lengths (3 + 1).
  // A 2-bar layer cannot divide a 3-bar part, which is the whole point.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [
      { root: 0, intervals: [0, 4, 7] },
      { root: 5, intervals: [0, 4, 7, 10] },
      { root: 7, intervals: [0, 3, 7] },
      { root: 9, intervals: [0, 4, 7, 11] },
    ];
    cfg.prog.parts = [{ name: 'A', len: 3 }, { name: 'B', len: 1 }];
    delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer'); b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);

  await page.evaluate(() => {
    window.__E = () => _masterEng;
    window.__L = () => (_masterEng.getCfg().layers || [])[0];
    window.__store = () => { const p = window.__L().part;
      return 'bars' + p.bars + ' ' + (p.notes || []).length + 'n [' + (p.notes || []).map(n =>
        n.midi + '@' + (Math.round(n.t * 1e4) / 1e4) + 'd' + (Math.round(n.dur * 1e4) / 1e4)).join(' ') + ']'; };
    window.__state = () => { const lv = window._v2.liveness(window.__L(), window.__E().getCfg());
      return { state: lv.state, tags: lv.tags || [] }; };
    // WHAT PLAYS, pass by pass. `notesFor` is the part INTERFACE — the emitter,
    // the drawing and the outlines all come through it — so a difference here
    // is a difference in the audio, not in the picture.
    window.__passes = (n) => {
      const E = window.__E(), cfg = E.getCfg(), L = window.__L();
      // PIN THE CLOCKS (the `partseq` idiom). `cycleStart: 0` only means "the
      // top of the progression" if the anchors say so — after a play they hold
      // real Tone times, and pass 1 then lands wherever the transport stopped,
      // which silently re-orders every chord this walk sees.
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const bpm = cfg.bpm || 120, cyc = L.part.bars * (60 / bpm) * 4;
      const out = [];
      for (let i = 0; i < n; i++) {
        const cs = i * cyc;
        let ns = [];
        try { ns = window._v2.withEdit(() => window._v2.notesFor(L,
          { E, cfg, key: 'v2:' + L.id, cycleStart: cs, cycleSec: cyc })) || []; } catch (e) {}
        out.push(ns.map(x => Math.round(69 + 12 * Math.log2((x.freq || 440) / 440)) +
          '@' + Math.round((x.at - cs) * 1000) + 'd' + Math.round(x.durMs))
          .sort().join(' '));
      }
      return out;
    };
    window.__NOTES = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.25, midi: 64, dur: 0.2 },
                      { t: 0.5, midi: 67, dur: 0.2 }, { t: 0.75, midi: 72, dur: 0.2 }];
  });

  // ── 1 · THE STORE NEVER MOVES ─────────────────────────────────────────
  console.log('\n1 · the stored note list, across Preview and Play\n');
  const configs = [
    ['Everywhere', () => { const L = window.__L(), p = L.part;
      delete p.barsMode; delete p.clock; delete p.ms;
      delete L.partFor; delete L.parts; delete L.partAll; delete L.lenSync; }],
    ['barsMode fill', () => { window.__L().part.barsMode = 'fill'; }],
    ['per-part (partFor 0)', () => { const L = window.__L();
      if (!Number.isFinite(L.partFor)) { L.partAll = JSON.parse(JSON.stringify(L.part)); L.partFor = 0; } }],
    ['free clock', () => { const L = window.__L(), p = L.part;
      delete L.partFor; delete L.parts; delete L.partAll;
      p.clock = 'free'; p.ms = 3000; }],
    ['lenSync bound', () => { const L = window.__L(), p = L.part;
      delete p.clock; delete p.ms; L.lenSync = { part: -1, passes: 1 }; }],
  ];
  for (const [name, tweak] of configs) {
    await page.evaluate((fn) => {
      const L = window.__L(), p = L.part;
      p.kind = 'recorded'; p.made = 'compose'; p.bars = 2;
      p.notes = JSON.parse(JSON.stringify(window.__NOTES));
      // eslint-disable-next-line no-new-func
      (new Function('return ' + fn))()();
      window.__E().getCfg();
    }, tweak.toString());
    await zz(250);
    const before = await page.evaluate(() => window.__store());
    // normalize on its own
    const idem = await page.evaluate(() => { const E = window.__E();
      for (let i = 0; i < 30; i++) E.getCfg(); return window.__store(); });
    ok(name + ' — 30 × getCfg moves nothing', idem === before, before + ' → ' + idem);
    // preview
    await page.evaluate(() => { try { window._v2.preview(window.__E(), window.__L()); } catch (e) {} });
    await zz(2200);
    await page.evaluate(() => { try { window._v2.previewKill(window.__E(), window.__L()); } catch (e) {} });
    await zz(300);
    const afterPv = await page.evaluate(() => window.__store());
    ok(name + ' — ▶ Preview moves nothing', afterPv === before, before + ' → ' + afterPv);
    // play
    await page.evaluate(() => { const b = document.getElementById('mix-bloom-play') || document.querySelector('.ambient-play'); if (b) b.click(); });
    await zz(6000);
    const during = await page.evaluate(() => window.__store());
    await page.evaluate(() => { const b = document.getElementById('mix-bloom-play') || document.querySelector('.ambient-play'); if (b) b.click(); });
    await zz(1200);
    const after = await page.evaluate(() => window.__store());
    ok(name + ' — Play moves nothing, during or after',
      during === before && after === before, before + ' → ' + during + ' → ' + after);
  }

  // ── 2 · A "FIXED" PART WHOSE NOTES CHANGE EVERY PASS ──────────────────
  console.log('\n2 · a GENERATED part the card calls FIXED, over changes it does not divide\n');
  await page.evaluate(() => {
    const L = window.__L(), p = L.part;
    p.kind = 'live'; p.bars = 2; p.notes = []; delete p.vary; delete L.chg;
    p.rhythm = { kind: 'euclid', steps: 8, pulses: 5, rotate: 0, n: 1 };
    p.pitch = { kind: 'walk', voices: 1, degree: 1, span: 4, home: 'center', dir: 'up' };
    delete p.barsMode; delete p.clock; delete p.ms; delete L.harmony;
    delete L.partFor; delete L.parts; delete L.partAll; delete L.lenSync;
    window.__E().getCfg();
  });
  await zz(300);
  const st2 = await page.evaluate(() => window.__state());
  const un = await page.evaluate(() => window.__passes(8));
  const unN = new Set(un).size;
  // RE-BASELINED 2026-09-20. This used to assert the LIE: the card called this
  // FIXED with no tags while every note moved every pass. ⏻ Fixed is a MODE
  // now (`L.fixed`) and VARIES is the floor, so the zero case reads VARIES —
  // which is honest here, because the notes do change. The measurement below
  // is unchanged and still the point.
  ok('an untouched generated layer reads VARIES — nobody set anything',
    st2.state === 'varies', JSON.stringify(st2));
  ok('…and its notes change pass to pass anyway (a 2-bar cycle over a 3-bar part)',
    unN > 1, unN + ' distinct note sets over 8 passes');
  console.log('        pass 1: ' + un[0]);
  console.log('        pass 2: ' + un[1]);

  await page.evaluate(() => { window.__L().part.bars = 4; window.__E().getCfg(); });
  await zz(300);
  const al = await page.evaluate(() => window.__passes(8));
  const alN = new Set(al).size;
  ok('ALIGNING the cycle to the changes is what makes it fixed — one note set',
    alN === 1, alN + ' distinct note sets over 8 passes');
  const st3 = await page.evaluate(() => window.__state());
  // Both read VARIES, and that is now CORRECT rather than a failure to tell
  // them apart: VARIES means "this may change", which is true of both. What
  // separates them is whether the notes actually move, which the two checks
  // above measure directly. ⏻ Fixed is how you say "it may not".
  ok('…and both read VARIES — a permission, not a claim about the notes',
    st3.state === 'varies' && st2.state === 'varies',
    JSON.stringify(st2) + ' vs ' + JSON.stringify(st3));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
