#!/usr/bin/env node
//
// ARCH PARITY GATE — the arrangement clock, pinned.
//
// Golden-render covers the Rust core and the invariant harness covers note
// generation, but NEITHER has a config with sections, parts, part repeats,
// per-part keys or salt — so the whole ARRANGEMENT layer (which chord is
// sounding at which bar, which section is running, which key is in force) has
// never had a gate. That is exactly the layer the ARCH work moves onto cfg.arch,
// so it needs one before the clock is touched, not after.
//
// What it pins, per config, sampled across bars on a quarter-bar grid:
//   step   — _ambProgStepAt: the chord clock. `step % L` is the chord index and
//            `floor(step / L)` the variation cycle, so BOTH caller contracts are
//            in the number and a break in either shows up here.
//   sec    — _ambSectionAt: which section is running and how far into it.
//   chord  — the SOUNDING chord (root + intervals) resolved through the same
//            funnel the engine uses, so alts, take-reroll, salt colours, the
//            order permutation and every key shift are all in the reading.
//   key    — the key in force at that moment (area / section / part).
//
// A pure display change leaves every one of these untouched. A clock change
// moves them, and the diff names the config, the bar and both values — so an
// intended change is reviewed rather than discovered.
//
//   node test/arch-parity.js            # gate: compare against the baseline
//   node test/arch-parity.js --update   # re-baseline a DELIBERATE change
//
// Needs `npm start` running (it drives the real page in Chrome — these are
// in-page functions with no module boundary to import).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASELINE = path.join(__dirname, 'arch-parity-baseline.json');
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UPDATE = process.argv.includes('--update');
const FORCE = process.argv.includes('--force');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);

// Every config is a plain description the page turns into a cfg. Keeping them
// declarative (rather than as page functions) is what lets the diff report name
// them, and what keeps this list readable as the arrangement model grows.
const CONFIGS = [
  { id: 'plain',            chords: [0, 5, 7, 9] },
  { id: 'prog-off',         chords: [0, 5, 7, 9], on: false },
  { id: 'parts',            chords: [0, 5, 7, 9], parts: [['Verse', 2], ['Chorus', 2]] },
  { id: 'parts-plays',      chords: [0, 5, 7, 9], parts: [['Verse', 2, 2], ['Chorus', 2, 1]] },
  { id: 'parts-plays-3',    chords: [0, 5, 7, 9, 2, 4], parts: [['A', 3, 2], ['B', 1, 1], ['C', 2, 4]] },
  { id: 'parts-key',        chords: [0, 5, 7, 9], parts: [['Verse', 2, 2], ['Chorus', 2, 1, { root: 5, scale: 'major' }]] },
  { id: 'parts-salt',       chords: [0, 5, 7, 9], parts: [['Verse', 2, 2, null, { len: 0, colors: 0, scatter: 0 }], ['Chorus', 2, 1]], salt: { len: 60, colors: 40, scatter: 0 } },
  { id: 'sections',         chords: [0, 5, 7, 9], sections: [['A', 4], ['B', 4]] },
  { id: 'sections-key',     chords: [0, 5, 7, 9], sections: [['A', 4], ['B', 4, null, 2]] },
  { id: 'sections-bound',   chords: [0, 5, 7, 9], parts: [['Verse', 2], ['Chorus', 2]], sections: [['A', 4, 0], ['B', 4, 1]] },
  { id: 'sections-mixed',   chords: [0, 5, 7, 9], parts: [['Verse', 2], ['Chorus', 2]], sections: [['free', 4], ['B', 4, 1]] },
  // Sections present but UNBOUND, with part repeats — the shape where sections
  // and parts are two INDEPENDENT spines. Arch is a flat list and cannot carry
  // both, so this is the case that decides how far slice 3 can reach.
  { id: 'sections-unbound-plays', chords: [0, 5, 7, 9], parts: [['Verse', 2, 2], ['Chorus', 2, 1]], sections: [['A', 4], ['B', 4]] },
  { id: 'sections-plays',   chords: [0, 5, 7, 9], parts: [['Verse', 2, 2], ['Chorus', 2, 1]], sections: [['A', 6, 0], ['B', 2, 1]] },
  // OPEN PARTS (slice 4) — a named block with no changes. The chord clock must
  // HOLD while one runs: time advances, the harmony does not move.
  { id: 'open-mid',    chords: [0, 5, 7, 9], parts: [['Verse', 2], { name: 'Bridge', open: 4 }, ['Chorus', 2]] },
  { id: 'open-first',  chords: [0, 5, 7, 9], parts: [{ name: 'Intro', open: 2 }, ['Verse', 4]] },
  { id: 'open-plays',  chords: [0, 5, 7, 9], parts: [['Verse', 2, 2], { name: 'Bridge', open: 3, plays: 2 }, ['Chorus', 2]] },
  { id: 'open-key',    chords: [0, 5, 7, 9], parts: [['Verse', 2], { name: 'Bridge', open: 4 }, ['Chorus', 2]], key: { root: 9, scale: 'minor' } },
  // A non-holding open part: the changes keep running underneath it. This is
  // what a SECTION is, and it is the shape sections migrate to — so it needs a
  // pin of its own before that migration lands.
  { id: 'open-run',    chords: [0, 5, 7, 9], parts: [['Verse', 2], { name: 'Bridge', open: 4, hold: false }, ['Chorus', 2]] },
  // WHAT A SECTION CARRIES BEYOND ITS LENGTH. None of this had coverage, and
  // all of it has to survive a sections→parts migration — so it is pinned first.
  { id: 'sec-groove',  chords: [0, 5, 7, 9], sections: [['A', 4], ['B', 4, null, null, { swing: 60, accent: 80, density: 30 }]] },
  { id: 'sec-rot',     chords: [0, 5, 7, 9], key: { root: 0, scale: 'major' }, sections: [['A', 4], ['B', 4, null, null, null, 3]] },
  { id: 'sec-mask',    chords: [0, 5, 7, 9], sections: [['A', 4], ['B', 4]], mask: [100, 0] },
  { id: 'sec-mask-pct', chords: [0, 5, 7, 9], sections: [['A', 4], ['B', 4], ['C', 4]], mask: [100, 40, 0] },
  { id: 'salt-len',         chords: [0, 5, 7, 9], salt: { len: 70, colors: 0, scatter: 0 } },
  { id: 'salt-colors',      chords: [0, 5, 7, 9], salt: { len: 0, colors: 80, scatter: 0 } },
  { id: 'salt-both',        chords: [0, 5, 7, 9], salt: { len: 50, colors: 50, scatter: 30 } },
  { id: 'varbars',          chords: [0, 5, 7, 9], bars: [2, 1, 0.5, 1.5] },
  { id: 'bpc-frac',         chords: [0, 5, 7, 9], barsPerChord: 0.5 },
  { id: 'key-on',           chords: [0, 5, 7, 9], key: { root: 9, scale: 'minor' } },
  { id: 'key-parts',        chords: [0, 5, 7, 9], key: { root: 9, scale: 'minor' }, parts: [['Verse', 2, 2], ['Chorus', 2, 1, { root: 5, scale: 'major' }]] },
  { id: 'transition',       chords: [0, 5, -1, 9] },   // -1 marks a transition slot
  { id: 'everything',       chords: [0, 5, 7, 9, 2, 4], key: { root: 9, scale: 'minor' },
    parts: [['Verse', 3, 2], ['Chorus', 3, 1, { root: 5, scale: 'major' }]],
    sections: [['A', 6, 0], ['B', 3, 1]], salt: { len: 40, colors: 40, scatter: 20 } },
];

// The walk: 32 bars at a quarter bar. Long enough that part repeats, section
// loops and the variation cycle all come round more than once; fine enough to
// land inside a half-bar chord.
const WALK_BARS = 32, WALK_STEP = 0.25;

(async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
  } catch (e) {
    console.error('Could not launch Chrome at ' + CHROME + '\n  ' + e.message
      + '\n  Set CHROME_PATH to override.');
    process.exit(2);
  }
  const page = await browser.newPage();
  const pageErrs = [];
  page.on('pageerror', e => pageErrs.push(String(e).slice(0, 200)));

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    console.error('Could not load ' + URL + ' — is `npm start` running?\n  ' + e.message);
    await browser.close(); process.exit(2);
  }
  await new Promise(r => setTimeout(r, 3500));

  const list = ONLY ? CONFIGS.filter(c => c.id === ONLY) : CONFIGS;
  if (!list.length) { console.error('No config matches --only=' + ONLY); await browser.close(); process.exit(2); }

  const result = await page.evaluate(async (list, WALK_BARS, WALK_STEP) => {
    const out = {};
    // The engine resolves everything against the module-global _E, which
    // _ambSyncControls sets — a probe that skips it silently measures a
    // different area (the documented trap).
    const build = (c) => {
      const cfg = _masterEng.getCfg();
      delete cfg.sections;
      cfg.prog = { on: c.on !== false, name: 'P', chords: (c.chords || [0, 5, 7, 9]).map((r, i) => (
        r === -1 ? { transition: true, bars: 1 }
                 : { root: r, intervals: [0, 4, 7], ...(c.bars ? { bars: c.bars[i] } : {}) })) };
      // A part is [name, len, plays, key, salt], or {name, open: <bars>, plays}
      // for an OPEN part — a named block carrying no changes, during which the
      // chord clock holds. That is the slice-4 consolidation: sections were this
      // all along.
      if (c.parts) cfg.prog.parts = c.parts.map((x) => {
        if (!Array.isArray(x)) return { name: x.name, open: 1, bars: x.open, ...(x.hold === false ? {} : { hold: 1 }), ...(x.plays ? { plays: x.plays } : {}) };
        const [name, len, plays, key, salt] = x;
        return { name, len, ...(plays ? { plays } : {}), ...(key ? { key } : {}), ...(salt ? { salt } : {}) };
      });
      if (c.salt) cfg.prog.salt = c.salt;
      if (c.sections) cfg.sections = c.sections.map(([name, bars, part, key, groove, rot]) => ({
        name, bars, ...(part != null ? { part } : {}), ...(key != null ? { key } : {}),
        ...(groove ? { groove } : {}), ...(rot != null ? { keyModeRot: rot } : {}) }));
      // A layer carrying a SECTION MASK, so the per-section gate is measurable.
      if (c.mask) {
        cfg.extras = [];
        try { _ambAddExtra(_masterEng, 'bass'); } catch (e) {}
        const L0 = (_masterEng.getCfg().extras || [])[0];
        if (L0) { L0.sectionMask = { steps: c.mask.slice() }; L0.mute = false; L0.on = true; }
      }
      cfg.barsPerChord = c.barsPerChord || 1;
      cfg.bpm = 120;
      cfg.seed = 12345;                       // salt and alts are seeded — pin it
      // Reset the key EXPLICITLY either way. Leaving keyRoot/keyScale from the
      // previous config leaked a minor key into configs that declare none — the
      // configs must be independent or a diff blames the wrong one.
      cfg.keyFollow = false;
      cfg.keyOn = !!c.key;
      cfg.keyRoot = c.key ? c.key.root : 0;
      cfg.keyScale = c.key ? c.key.scale : 'major';
      const live = _masterEng.getCfg();        // re-read: normalize is the chokepoint
      _ambSyncControls(_masterEng);
      _masterEng._cfg = live;
      _masterEng._progAnchor = 0;
      _masterEng._playStartAt = 0;
      _masterEng._barGridAnchor = 0;
      return live;
    };
    const probe = (fn) => { try { const v = fn(); return (v == null) ? '-' : String(v); } catch (e) { return 'ERR:' + (e && e.message || e).toString().slice(0, 40); } };

    list.forEach((c) => {
      const cfg = build(c);
      const barSec = (60 / 120) * 4;
      const rows = [];
      // The derived arch and the played chain, pinned as the first two rows.
      // This is what makes `prog-off` a real case (the chain must be null when
      // the progression is off — a project with it switched off must not gain
      // harmony the moment arch is read), and it keeps the slice-2 display path
      // under a durable gate now that its one-off equality test has been spent.
      rows.push('arch  ' + probe(() => (cfg.arch || []).map(e => e.name
        + (e.changes ? ('[' + e.changes.from + '+' + e.changes.len + '×' + e.changes.plays + ']') : ('[open' + (e.hold ? ' hold' : '') + (e.len ? ' ' + e.len.num + 'b' : '') + ']'))
        + (e.key ? ('key' + e.key.root + '/' + e.key.scale) : '')
        + (e.salt ? 'salt' : '')).join(' · ')));
      rows.push('chain ' + probe(() => {
        const sl = _ambProgChainSlots(cfg);
        return sl ? sl.map(x => (x.pName || '-') + ':' + x.idx + (x.pFirst ? '*' : '')).join(' ') : 'null';
      }));
      for (let b = 0; b < WALK_BARS; b += WALK_STEP) {
        const t = b * barSec;
        // MEASURE THE WAY THE ENGINE MEASURES. Per-part and per-section keys
        // resolve off _ambKeyTime (the per-note stamp every emitter sets) and
        // _ambProgStepOverride (set by the resolvers around a pitch pick) —
        // read without them, both fall back to the AUDIO clock and report the
        // key at wall-clock zero for every sample, so the whole key axis reads
        // as a constant and a modulation regression would sail through.
        const prevT = (typeof _ambKeyTime !== 'undefined') ? _ambKeyTime : undefined;
        const prevS = (typeof _ambProgStepOverride !== 'undefined') ? _ambProgStepOverride : undefined;
        let step = '-', sec = '-', chord = '-', key = '-', ov = '-', gate = '-';
        try {
          _ambKeyTime = t;
          step = probe(() => _ambProgStepAt(_masterEng, t));
          sec = probe(() => {
            const a = _ambSectionAt(_masterEng, t, cfg);
            if (!a) return '-';
            const s0 = (cfg.sections || [])[a.idx];
            // _ambSectionAt returns {idx, startBar, step} — the NAME lives on the
            // section itself, and reading a.name gave "undefined" for every row.
            return a.idx + ':' + ((s0 && s0.name) || '?') + '@' + (a.startBar | 0) + '/' + (a.step | 0);
          });
          _ambProgStepOverride = +step;
          // The SOUNDING chord, through the engine's own funnel — this is what
          // carries alts, salt colours, reroll and the order permutation.
          chord = probe(() => {
            const n = { type: 'prog', chords: cfg.prog.chords };
            const ch = (typeof _ambProgSoundAt === 'function') ? _ambProgSoundAt(_masterEng, n, +step)
                                                              : _ambProgChordAt(_masterEng, n, +step);
            if (!ch) return '-';
            if (ch.transition) return '~';
            return (ch.root | 0) + '[' + (ch.intervals || []).join(',') + ']';
          });
          // The root the engine would actually SOUND — _ambSrcRootPc is the one
          // chokepoint every pitch resolves through, so it carries the key
          // transpose, the section offset and the part key together.
          const root = probe(() => _ambSrcRootPc({ type: 'prog', chords: cfg.prog.chords }));
          key = probe(() => _ambKeyRootPc(cfg) + '/' + _ambKeyScaleName(cfg)) + '>' + root;
          // Per-section overrides and the per-section layer gate. These resolve
          // off _ambKeyTime like everything else here, which is why the stamp
          // above has to be in place before any of it is read.
          ov = probe(() => {
            const g = (typeof _ambSectionGroove === 'function') ? _ambSectionGroove(cfg, cfg.groove || {}) : null;
            const so = (typeof _ambSectionNowObj === 'function') ? _ambSectionNowObj(cfg) : null;
            const bits = [];
            if (g) ['swing', 'accent', 'density', 'ghost', 'rolls'].forEach(k2 => { if (Number.isFinite(g[k2])) bits.push(k2[0] + g[k2]); });
            if (so && Number.isFinite(so.keyModeRot) && so.keyModeRot) bits.push('rot' + so.keyModeRot);
            return bits.length ? bits.join(',') : '-';
          });
          gate = probe(() => {
            const L0 = (cfg.extras || [])[0];
            if (!L0 || !L0.sectionMask) return '-';
            return _ambSectionGateOK(_masterEng, L0, t, cfg, true) ? 'play' : 'off';
          });
        } finally {
          _ambKeyTime = prevT;
          _ambProgStepOverride = prevS;
        }
        rows.push([b.toFixed(2), step, sec, chord, key, ov, gate].join(' '));
      }
      out[c.id] = rows;
    });
    return out;
  }, list, WALK_BARS, WALK_STEP);

  await browser.close();

  if (pageErrs.length) console.log('page errors: ' + pageErrs.slice(0, 3).join(' | '));

  // Any probe that threw for a WHOLE config means the gate is measuring nothing
  // there — report it loudly rather than baselining a column of ERR: strings.
  const broken = Object.keys(result).filter(id => result[id].every(r => r.includes('ERR:')));
  if (broken.length) {
    console.error('✗ probes failed outright for: ' + broken.join(', ')
      + '\n  ' + (result[broken[0]][0] || '') + '\n  The gate cannot pin what it cannot read — fix the probe before baselining.');
    process.exit(2);
  }

  if (UPDATE || !fs.existsSync(BASELINE)) {
    // ADDING a config is routine and safe; CHANGING a pinned one is the whole
    // thing this gate exists to prevent, so --update will not do it silently.
    // (Written after doing exactly that: running --update in the same breath as
    // a failing check baked a regression straight into the baseline, and the
    // next run then reported the FIX as the drift. --force is the deliberate
    // path, and it names what it is about to overwrite either way.)
    if (fs.existsSync(BASELINE)) {
      const prev = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      const changed = Object.keys(result).filter(id => prev[id]
        && JSON.stringify(prev[id]) !== JSON.stringify(result[id]));
      const added = Object.keys(result).filter(id => !prev[id]);
      const removed = Object.keys(prev).filter(id => !result[id]);
      if (added.length) console.log('  + adding: ' + added.join(', '));
      if (removed.length) console.log('  - removing: ' + removed.join(', '));
      if (changed.length) {
        changed.forEach((id) => {
          const n = prev[id].filter((r, i) => r !== result[id][i]).length;
          console.log('  ! ' + id + ' — ' + n + ' pinned samples would CHANGE');
        });
        if (!FORCE) {
          console.error('\nRefusing to overwrite ' + changed.length + ' pinned config(s).'
            + '\nRun the gate WITHOUT --update first and read the diff. If the change is'
            + '\nintended, re-run with:  node test/arch-parity.js --update --force');
          process.exit(1);
        }
        console.log('  (--force: overwriting them)');
      }
    }
    fs.writeFileSync(BASELINE, JSON.stringify(result, null, 1) + '\n');
    console.log('Baseline written: ' + Object.keys(result).length + ' configs × '
      + (WALK_BARS / WALK_STEP) + ' samples');
    process.exit(0);
  }

  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  let bad = 0, checked = 0;
  Object.keys(result).forEach((id) => {
    const a = base[id], b = result[id];
    if (!a) { console.log('  + ' + id + ' (new — not in baseline)'); return; }
    checked++;
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) diffs.push('      bar ' + (b[i] || a[i]).split(' ')[0]
        + '\n        was ' + (a[i] || '(none)') + '\n        now ' + (b[i] || '(none)'));
    }
    if (diffs.length) {
      bad++;
      console.log('  ✗ ' + id + ' — ' + diffs.length + ' of ' + a.length + ' samples differ');
      diffs.slice(0, 3).forEach(d => console.log(d));
      if (diffs.length > 3) console.log('      … ' + (diffs.length - 3) + ' more');
    } else {
      console.log('  ✓ ' + id);
    }
  });
  const gone = Object.keys(base).filter(id => !result[id]);
  if (gone.length) console.log('  - dropped from this run: ' + gone.join(', '));

  if (bad) {
    console.log('\nARCH PARITY: ✗ ' + bad + ' of ' + checked + ' configs drifted.'
      + '\nThe arrangement clock changed. If that was intended, review the diff above'
      + '\nand re-baseline in the SAME commit: node test/arch-parity.js --update');
    process.exit(1);
  }
  console.log('\nARCH PARITY: ✓ all ' + checked + ' configs identical to baseline');
})().catch((e) => { console.error(e); process.exit(2); });
