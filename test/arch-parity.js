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
  { id: 'sections-plays',   chords: [0, 5, 7, 9], parts: [['Verse', 2, 2], ['Chorus', 2, 1]], sections: [['A', 6, 0], ['B', 2, 1]] },
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
      if (c.parts) cfg.prog.parts = c.parts.map(([name, len, plays, key, salt]) => ({
        name, len, ...(plays ? { plays } : {}), ...(key ? { key } : {}), ...(salt ? { salt } : {}) }));
      if (c.salt) cfg.prog.salt = c.salt;
      if (c.sections) cfg.sections = c.sections.map(([name, bars, part, key]) => ({
        name, bars, ...(part != null ? { part } : {}), ...(key != null ? { key } : {}) }));
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
        + (e.changes ? ('[' + e.changes.from + '+' + e.changes.len + '×' + e.changes.plays + ']') : '[open]')
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
        let step = '-', sec = '-', chord = '-', key = '-';
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
        } finally {
          _ambKeyTime = prevT;
          _ambProgStepOverride = prevS;
        }
        rows.push([b.toFixed(2), step, sec, chord, key].join(' '));
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
    fs.writeFileSync(BASELINE, JSON.stringify(result, null, 1) + '\n');
    console.log((fs.existsSync(BASELINE) && !UPDATE ? 'Baseline created' : 'Baseline updated')
      + ': ' + Object.keys(result).length + ' configs × ' + (WALK_BARS / WALK_STEP) + ' samples');
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
