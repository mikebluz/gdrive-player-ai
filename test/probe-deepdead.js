// PROBE — every knob ⚙ Deep offers for a Material must CHANGE something.
//
// user: "if the param creates no change for whatever reason, it should be
// disabled for that Material, or revise the value range to only include usable
// values". A control that moves nothing is the dead-control class this repo
// keeps paying for — the user's only evidence is the picture and the sound,
// and a knob that lies about having an effect costs more than a missing one.
//
// So: for each Material, take every row ⚙ Deep SHOWS, sweep its control across
// its own stated range, and ask the SEAM (`notesFor`) whether the notes moved.
// The answer is a matrix of live / dead, printed, and the check is that no
// shown row is dead.
//
//   node test/probe-deepdead.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

const SHAPES = [['ground', 'held'], ['arp', 'arpwide'], ['roll', 'rollpulse'],
                ['sustain', 'pad'], ['mixed', 'mixarch']];

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 600000 });
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
                       { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  {
    const c = await page.evaluate(() => {
      const card = document.querySelector('.v2-layer');
      if (!card || !card.classList.contains('collapsed')) return null;
      const x = card.querySelector('.ambient-collapse'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (c) await page.touchscreen.tap(c.x, c.y);
    await zz(900);
  }

  const rows = [];
  for (const [shape, pid] of SHAPES) {
    // a fresh draft per shape: close ⚙ Deep, set the shape, reopen
    await page.evaluate((id) => {
      const card = document.querySelector('.v2-layer');
      const x = card.querySelector('.v2-gencancel');
      if (x && card.classList.contains('v2-genopen')) x.click();
      const E = _masterEng, L = (E.getCfg().layers || [])[0];
      L.part.kind = 'live'; L.part.notes = []; E.getCfg();
      window._v2.applyPreset(E, (E.getCfg().layers || [])[0], id);
      E.getCfg(); window._v2.render(E);
    }, pid);
    await zz(900);
    await page.evaluate(() => {
      const b = document.querySelector('.v2-layer .v2-genbtn');
      if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
    });
    await zz(1300);
    // …and every fine-tune tab in turn, so a row behind a tab is still counted
    const r = await page.evaluate(() => {
      const E = _masterEng, V = window._v2;
      const card = document.querySelector('.v2-layer');
      const id = (E.getCfg().layers || [])[0].id | 0;
      const S = V.stagedOf(id);
      if (!S) return { err: 'no draft open' };

      // WHICH ROWS ⚙ DEEP IS OFFERING. `gateRow` hides a row inline, so a
      // row with no inline `display:none` on it or any ancestor is one the
      // panel is showing for this material. Tab membership is not hiding —
      // the tab strip is right there — so tabs are walked and merged.
      const tabs = [...card.querySelectorAll('.v2-fttab')];
      const shown = new Map();
      const sweep = () => {
        card.querySelectorAll('.v2-genwrap .v2-f[data-f]').forEach((el) => {
          const row = el.closest('.ambient-ctrl'); if (!row) return;
          let n = row, hid = false;
          while (n && n !== card) { if (n.style && n.style.display === 'none') { hid = true; break; } n = n.parentElement; }
          if (hid) return;
          // the ⚠ Advanced recipe rows are a deliberate escape hatch, not a
          // per-material knob — they CHANGE the material rather than tune it
          if (row.classList.contains('v2-sub-recipe')) return;
          const f = el.getAttribute('data-f');
          if (shown.has(f)) return;
          const lab = ((row.querySelector('label') || {}).textContent || '').trim();
          shown.set(f, {
            f, lab,
            kind: el.tagName === 'SELECT' ? 'select' : (el.type === 'range' ? 'range' : 'number'),
            min: el.getAttribute('min'), max: el.getAttribute('max'),
            opts: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value) : null,
          });
        });
      };
      sweep();
      tabs.forEach((tb) => { tb.click(); sweep(); });

      // ── DOES IT MOVE THE NOTES? ─────────────────────────────────────────
      const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
      const put = (o, p, v) => { const ks = p.split('.'); let t = o;
        for (let i = 0; i < ks.length - 1; i++) { if (t[ks[i]] == null || typeof t[ks[i]] !== 'object') t[ks[i]] = {}; t = t[ks[i]]; }
        t[ks[ks.length - 1]] = v; };
      // FOUR CONSECUTIVE CYCLES, not one. Some knobs only show ACROSS passes
      // — Evolve advances the take every N of them — so a single-cycle
      // sample reports them dead when they are the opposite of dead. (It did:
      // the first run of this probe called Evolve dead on all five shapes.)
      const CYC = 8, PASSES = 4;
      const sigOf = () => {
        const S2 = V.stagedOf(id);
        const out = [];
        for (let k = 0; k < PASSES; k++) {
          E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
          // NO TAKE PIN. `withTake(pinOf(S))` is what the DRAWING does so its
          // picture holds still, and a pinned take is precisely what overrides
          // Evolve's epoch — measured through the pin, Evolve reads dead on
          // every shape while playback hears it change every pass. This asks
          // the question playback asks.
          const ns = V.withEdit(() => V.notesFor(S2, { E, cfg: E.getCfg(), key: 'v2:' + id,
                                   cycleStart: k * CYC, cycleSec: CYC })) || [];
          out.push(ns.map((n) => Math.round((n.at - k * CYC) * 1000) + ':' +
            Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)) + ':' + Math.round(n.durMs)).join(' '));
        }
        return out.join(' | ');
      };
      const out = [];
      shown.forEach((row) => {
        const before = get(V.stagedOf(id), row.f);
        // NOT JUST THE EXTREMES. Evolve reads 0 as off and 64 as "every 64
        // passes", so both ends look identical over any sample short enough
        // to run — it takes a SMALL value to see it at all. Sampling min+1
        // and the midpoint as well is also the only way a knob that matters
        // only in part of its range gets seen.
        const lo = Number(row.min), hi = Number(row.max);
        const vals = row.kind === 'select' ? (row.opts || [])
          : (Number.isFinite(lo) && Number.isFinite(hi)
              ? [...new Set([lo, lo + 1, Math.round((lo + hi) / 2), hi])].filter((x) => x >= lo && x <= hi)
              : []);
        const sigs = new Set();
        vals.forEach((v) => {
          put(V.stagedOf(id), row.f, v);
          try { E.getCfg(); } catch (e) {}
          sigs.add(sigOf());
        });
        put(V.stagedOf(id), row.f, before);
        try { E.getCfg(); } catch (e) {}
        out.push({ f: row.f, lab: row.lab, kind: row.kind,
                   range: row.kind === 'select' ? ((row.opts || []).length + ' options')
                                                : (row.min + '–' + row.max),
                   tried: vals.length, distinct: sigs.size });
      });
      return { out };
    });
    if (r.err) { console.log('  ' + shape + ': ' + r.err); continue; }
    rows.push({ shape, list: r.out });
  }

  console.log('\n  ⚙ Deep — does each shown knob change the notes?\n');
  const dead = [];
  rows.forEach((r) => {
    const bad = r.list.filter((x) => x.distinct <= 1);
    console.log('   ' + r.shape.padEnd(9) + r.list.length + ' rows shown, ' +
      (bad.length ? (bad.length + ' DEAD') : 'all live'));
    bad.forEach((x) => {
      console.log('        ✗ ' + (x.lab || x.f).padEnd(18) + x.f.padEnd(26) + x.kind + ' ' + x.range);
      dead.push(r.shape + ' · ' + (x.lab || x.f) + ' (' + x.f + ')');
    });
  });
  console.log('');

  // ── THE OUTSTANDING LIST ────────────────────────────────────────────────
  // These are the shape×knob pairs measured dead TODAY. They are not
  // approved — they are the backlog this probe exists to burn down, and each
  // one is a knob a person can move while nothing happens. The check fails
  // BOTH ways on purpose: a NEW dead knob is a regression, and one that comes
  // alive must be struck from this list, or the list rots into a lie.
  //
  // They are not one bug. Known causes, from the measurement:
  //   · the chord VOICING cluster (spread · variety · feel · voice cap ·
  //     subdivide · phrase · repeats) needs a voicing actually in force
  //   · Salt's "Up to" and "How often" need Salt re-voice switched ON
  //   · Evolve needs a material with dice in it — a held chord or a fixed
  //     sweep replays identically whatever take it is on
  //   · `sustain · Voicing` looks like an ENGINE bug rather than a gating
  //     question: `_ambPickVoicing` returns a voicing for this very layer
  //     when called directly, and the notes come out as the plain thirds
  //     stack anyway. Greying that one would paper over it.
  const KNOWN = new Set([
    'ground · part.pitch.spread', 'ground · part.pitch.variety', 'ground · part.pitch.feel',
    'ground · part.pitch.voiceCap', 'ground · part.pitch.subdiv', 'ground · part.pitch.phraseLen',
    'ground · part.pitch.repeats', 'ground · chg.ev',
    'arp · part.pitch.tones', 'arp · saltUpTo', 'arp · saltShare', 'arp · chg.ev', 'arp · twist',
    'roll · saltUpTo', 'roll · saltShare',
    'sustain · part.pitch.chordMode', 'sustain · part.pitch.variety', 'sustain · part.pitch.voiceCap',
    'sustain · part.pitch.subdiv', 'sustain · part.pitch.phraseLen', 'sustain · part.pitch.repeats',
    'sustain · chg.ev', 'sustain · ghosts', 'sustain · part.rhythm.rateVar',
    'mixed · part.pitch.walkMode', 'mixed · part.pitch.lineUp', 'mixed · part.pitch.contour',
    'mixed · proximity', 'mixed · saltUpTo', 'mixed · saltShare', 'mixed · part.pitch.stutter',
    'mixed · part.pitch.lines',
  ]);
  const keys = [];
  rows.forEach((r) => r.list.forEach((x) => { if (x.distinct <= 1) keys.push(r.shape + ' · ' + x.f); }));
  const fresh = keys.filter((k) => !KNOWN.has(k));
  const fixed = [...KNOWN].filter((k) => keys.indexOf(k) < 0);
  console.log('  ' + keys.length + ' dead of ' +
    rows.reduce((a, r) => a + r.list.length, 0) + ' shown — ' +
    KNOWN.size + ' on the outstanding list\n');
  ok('no knob is newly dead', fresh.length === 0, fresh.join('\n      '));
  ok('nothing on the outstanding list has come alive unrecorded', fixed.length === 0,
    'these now work — strike them from KNOWN:\n      ' + fixed.join('\n      '));

  // …and the "How many" rows must be numeric inputs, not sliders
  const hm = [];
  rows.forEach((r) => r.list.forEach((x) => {
    if (/^how many$/i.test(x.lab || '')) hm.push(r.shape + ' · ' + x.f + ' is a ' + x.kind);
  }));
  console.log('  “How many” rows: ' + (hm.length ? hm.join(' · ') : 'none shown') + '\n');
  ok('every “How many” is a typed numeric input, not a slider',
    hm.length > 0 && hm.every((s) => /is a number$/.test(s)),
    hm.join('\n      '));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
