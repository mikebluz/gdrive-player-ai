// PROBE — ✦ Generate's Pitch / Harmony / Voicing tabs are DUPLICATES of
// controls that already live in ⚙ Deep, and removing them must leave nothing
// unreachable.
//
// user: "it seems like these 3 param groups (Pitch/Harmony/Voicing) belong in
// Deep". They already do — every field those tabs carry has a row in ⚙ Deep.
// So the change is a delete, and the only question that matters is the one
// this repo keeps paying for: does some shape lose its last door to a field?
//
// So for EVERY shape, this asks both surfaces the same question — which of
// these fields has a row whose gate is open — and reports the difference.
// Run it BEFORE the delete to see the overlap, and AFTER to prove the Deep
// column never lost to the sheet column.
//
//   node test/probe-deepdup.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

// the fields the three sheet tabs carry — the whole of what is at stake
const FIELDS = ['part.pitch.kind', 'part.pitch.voices', 'part.pitch.mix', 'part.pitch.lines',
  'part.pitch.degree', 'part.pitch.dir', 'part.pitch.span', 'part.pitch.home',
  'part.pitch.contour', 'part.pitch.octaves', 'proximity', 'part.pitch.chordMode',
  'part.pitch.spread', 'part.pitch.variety', 'part.pitch.subdiv', 'part.pitch.phraseLen',
  'part.pitch.repeats', 'part.pitch.voiceCap'];
const SHAPES = [['ground', 'held'], ['arp', 'arpwide'], ['roll', 'rollpulse'],
                ['sustain', 'pad'], ['mixed', 'mixarch']];

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
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] }, { root: 6, intervals: [0, 3, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);

  // ── THE TAB STRIP THE ASK POINTED AT ────────────────────────────────────
  // "these 3 param groups (Pitch/Harmony/Voicing)" was a photograph of ✦
  // Generate's chips, so the most direct proof is to read those chips. The
  // card is expanded by its own handler (which opens the sheet) and the
  // section is chosen with the sheet's own navigator.
  {
    // A KNOWN LAYER, AND BEFORE THE LOOPS BELOW. `popOpen` MOVES the group
    // body's rows into the sheet, so a card that has been re-rendered with a
    // sheet open has none left to offer — read after the loops, this strip
    // came back empty and read as "the tabs are gone" when they were merely
    // somewhere else.
    await page.evaluate(() => {
      const E = _masterEng, L = (E.getCfg().layers || [])[0];
      L.part.kind = 'live'; L.part.notes = []; E.getCfg();
      window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'pad');
      E.getCfg(); window._v2.render(E);
    });
    await zz(1000);
    // THE SHEET OPENS ON THE EXPAND TRANSITION, not on being expanded — so a
    // card that is already open has no sheet, and the header press is a
    // TOGGLE. Tap until there is a `.v2-pop-wrap`: at most one tap to shut it
    // and one to open it again. (Guessing wrong here reads as "the section
    // has no tabs" rather than as "there is no sheet".)
    const head = async () => {
      const c = await page.evaluate(() => {
        const x = document.querySelector('.v2-layer .ambient-collapse'); if (!x) return null;
        x.scrollIntoView({ block: 'center' });
        const r = x.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (c) await page.touchscreen.tap(c.x, c.y);
      await zz(900);
    };
    for (let i = 0; i < 3; i++) {
      const got = await page.evaluate(() => !!document.querySelector('.v2-layer .v2-pop-wrap'));
      if (got) break;
      await head();
    }
    const g = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.v2-layer .v2-gototab')]
        .find((x) => x.textContent.trim().indexOf('Generate') >= 0);
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (g) await page.touchscreen.tap(g.x, g.y);
    await zz(800);
    const tabs = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      const wrap = card && card.querySelector('.v2-pop-wrap');
      if (!wrap) return { err: 'the sheet did not open', cls: card && card.className };
      // SCOPED TO THE CARD, not to `.v2-pop-wrap`: the tab strip is not a
      // child of the wrap, and a wrap-scoped query answers "(none)" for a
      // strip that is on screen — a 0-length NodeList reads exactly like a
      // deleted tab, which is the trap this repo names about `querySelector`.
      return { names: [...card.querySelectorAll('.v2-pop-tab[data-tab]')]
        .map((b) => b.getAttribute('data-tab')),
        on: [...card.querySelectorAll('.v2-gototab')]
          .filter((x) => x.classList.contains('on')).map((x) => x.textContent.trim()),
        fams: [...card.querySelectorAll('.v2-fambtn')].map((x) => x.textContent.trim()) };
    });
    console.log('  ✦ Generate now offers these tabs:\n   ' +
      (tabs.names ? (tabs.names.join(' · ') || '(none)') : tabs.err) +
      '\n   [section on: ' + JSON.stringify(tabs.on) + '  families: ' +
      JSON.stringify(tabs.fams) + '  ' + (tabs.cls || '') + ']\n');
    const has = (n) => (tabs.names || []).indexOf(n) >= 0;
    ok('✦ Generate no longer shows Pitch, Harmony or Voicing',
      !!tabs.names && !has('Pitch') && !has('Harmony') && !has('Voicing'),
      JSON.stringify(tabs.names || tabs.err));
    ok('…and it kept what a part is made OF',
      !!tabs.names && has('Key') && has('Notes'),
      JSON.stringify(tabs.names || tabs.err));
  }

  const rows = [];
  for (const [shape, preset] of SHAPES) {
    await page.evaluate((pid) => {
      const E = _masterEng, L = (E.getCfg().layers || [])[0];
      L.part.kind = 'live'; L.part.notes = [];
      E.getCfg();
      window._v2.applyPreset(E, (E.getCfg().layers || [])[0], pid);
      E.getCfg();
      window._v2.render(E);
    }, preset);
    await zz(800);
    const r = await page.evaluate((FIELDS) => {
      const card = document.querySelector('.v2-layer');
      // A ROW IS REACHABLE when it exists and `gateRow` has not hidden it for
      // this shape. Tab membership is navigation, not reachability — the tab
      // strip is right there and 🔍 Find opens it — so the test is the GATE.
      const open = (el) => {
        if (!el) return false;
        let n = el;
        while (n && n !== card) {
          if (n.style && n.style.display === 'none') return false;
          n = n.parentElement;
        }
        return true;
      };
      const rowOf = (el) => el && el.closest('.ambient-ctrl');
      const seen = { sheet: {}, deep: {} };
      FIELDS.forEach((f) => {
        const all = [...card.querySelectorAll('[data-f="' + f + '"]')];
        all.forEach((el) => {
          const row = rowOf(el); if (!row) return;
          // ⚙ Deep's rows live inside `.v2-genwrap`; the sheet's do not
          const where = el.closest('.v2-genwrap') ? 'deep' : 'sheet';
          if (open(row)) seen[where][f] = true;
        });
      });
      // Harmony and Salt are not `data-f` rows — they are class-delegated
      const harm = [...card.querySelectorAll('.v2-harmopt, [data-v2tab="Harmony"]')];
      harm.forEach((el) => {
        const where = el.closest('.v2-genwrap') ? 'deep' : 'sheet';
        if (open(el)) seen[where]['~harmony'] = true;
      });
      const salt = [...card.querySelectorAll('.v2-salttoggle, .v2-gensalt')];
      salt.forEach((el) => {
        const row = rowOf(el); if (!row) return;
        const where = el.closest('.v2-genwrap') ? 'deep' : 'sheet';
        if (open(row)) seen[where]['~salt'] = true;
      });
      return seen;
    }, FIELDS);
    rows.push({ shape, ...r });
  }

  console.log('\n  which fields have an OPEN row, per shape — sheet vs ⚙ Deep:\n');
  const ALL = FIELDS.concat(['~harmony', '~salt']);
  console.log('   ' + 'field'.padEnd(24) + SHAPES.map(([s]) => s.slice(0, 7).padEnd(9)).join(''));
  ALL.forEach((f) => {
    console.log('   ' + f.replace('part.pitch.', '').padEnd(24) +
      rows.map((r) => {
        const s = !!r.sheet[f], d = !!r.deep[f];
        return ((s ? 'S' : '·') + (d ? 'D' : '·')).padEnd(9);
      }).join(''));
  });
  console.log('\n   S = the ✦ Generate sheet offers it · D = ⚙ Deep offers it\n');

  // ── THE ONE FIELD THE SHEET OFFERS MORE WIDELY: Proximity ───────────────
  // The sheet gates it `kind:live` (every shape); ⚙ Deep gates it to the
  // pitch kinds that READ it. Deleting the sheet's row therefore takes the
  // control away on some shapes — so the question is whether it did anything
  // there. `prox` is consumed in exactly one branch of `pitchesBase` (the
  // `chance` kind), so the claim is that it is INERT elsewhere; a claim like
  // that is worth measuring rather than reading.
  const prox = await page.evaluate((SHAPES) => {
    const E = _masterEng, V = window._v2;
    const Lat = () => (E.getCfg().layers || [])[0];
    const out = {};
    SHAPES.forEach(([shape, pid]) => {
      const L0 = Lat(); L0.part.kind = 'live'; L0.part.notes = []; E.getCfg();
      V.applyPreset(E, Lat(), pid); E.getCfg();
      const sigAt = (v) => {
        const L = Lat(); L.proximity = v; E.getCfg();
        const L2 = Lat();
        E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
        return (V.withEdit(() => V.withTake(V.pinOf(L2),
          () => V.notesFor(L2, { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 8 }))) || [])
          .map((n) => Math.round(n.at * 1000) + ':' +
            Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).join(' ');
      };
      const a = sigAt(0), b = sigAt(100);
      out[shape] = { moved: a !== b, n: a.split(' ').length };
    });
    return out;
  }, SHAPES);

  console.log('  does Proximity change what plays?\n');
  Object.keys(prox).forEach((s) => console.log('   ' + s.padEnd(10) +
    (prox[s].moved ? 'YES — 0 and 100 play differently' : 'no — 0 and 100 are identical')));
  console.log('');

  // Nothing the sheet offers may be missing from Deep, or deleting the sheet's
  // tabs takes away the last door for that shape — UNLESS the control did
  // nothing there, which is a dead control and not a door at all.
  const gaps = [];
  rows.forEach((r) => ALL.forEach((f) => {
    if (r.sheet[f] && !r.deep[f]) {
      const dead = f === 'proximity' && prox[r.shape] && !prox[r.shape].moved;
      if (!dead) gaps.push(r.shape + ' · ' + f);
    }
  }));
  ok('every field the sheet offers is ALSO offered by ⚙ Deep — or was dead there',
    gaps.length === 0, gaps.join('\n      '));

  // …and NO field may have two homes. This is the guard that keeps the
  // duplication from growing back: before the cut every row above read `SD`.
  const dups = [];
  rows.forEach((r) => ALL.forEach((f) => { if (r.sheet[f] && r.deep[f]) dups.push(r.shape + ' · ' + f); }));
  ok('no field is offered by BOTH surfaces at once', dups.length === 0,
    dups.join('\n      '));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
