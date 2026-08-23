#!/usr/bin/env node
//
// PER-ITERATION LAYER SEQUENCES — the gate.
//
// `L.partSeqs` maps a PASS of a part to a banked phrase (schema v9). Nothing
// else pins it: golden covers the Rust core, the invariant harness covers note
// generation, and arch-parity covers the chord clock — which this feature
// deliberately does NOT touch, so a break here moves none of them. The whole
// thing is therefore invisible to every existing gate, which is exactly the
// situation that lets a silent regression through.
//
// Unlike the parity gates this is ASSERTION-based rather than baseline-based:
// the cascade rules are decisions with right answers ("cells past the count are
// kept, hidden, and come back"), not measurements that drift. A baseline would
// happily record the wrong answer.
//
// What it pins:
//   migrate  — the v9 conversion off the cycling list, including the LCM pass
//              count and the legacy bare string (which meant "every pass")
//   pass     — _ambPartPassAt: the cumulative visit, incl. a chain that revisits
//              a part inside one cycle
//   cascade  — the four ways the Passes grid can invalidate a mapping
//   own      — a blank cell restores the layer's OWN phrase, and a mapped phrase
//              never overwrites it
//
//   node test/partseq.js
//
// Needs `npm start` running (these are in-page functions with no module
// boundary to import).

const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const pageErrs = [];
  page.on('pageerror', e => pageErrs.push(String(e).slice(0, 200)));

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    console.error('Could not load ' + URL + ' — is `npm start` running?\n  ' + e.message);
    await browser.close(); process.exit(2);
  }
  await new Promise(r => setTimeout(r, 3500));

  const res = await page.evaluate(() => {
    const checks = [];
    const eq = (name, got, want) => checks.push({
      name, ok: JSON.stringify(got) === JSON.stringify(want), got, want,
    });

    // The bank must be seeded BEFORE _ambInitMaster — it builds the PRIMARY
    // cards once, so a bank seeded afterwards renders as "none yet" forever.
    savedSequences.length = 0;
    savedSequences.push({ name: 'riffA', steps: [{ freq: 220 }] },
                        { name: 'riffB', steps: [{ freq: 330 }] });
    document.body.classList.add('view-mix');
    _ambInitMaster();
    const E = _masterEng;

    const baseProg = (parts) => {
      const cfg = E.getCfg();
      cfg.bpm = 120; cfg.barsPerChord = 1;
      cfg.bed.present = true; cfg.prog.on = true;
      cfg.prog.chords = [0, 5, 7, 9].map(r => ({ root: r, intervals: [0, 4, 7] }));
      cfg.prog.parts = parts.map(([name, len]) => ({ name, len }));
      delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
      delete cfg.bed.partSeqs; delete cfg.bed.lockState;
      if (cfg.motif) { delete cfg.motif.partSeqs; delete cfg.motif.lockState; }
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      E.freeze = {}; E.unit = {};
      return cfg;
    };

    // ---- 1. v9 MIGRATION ---------------------------------------------------
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.bed.partSeqs = { 0: ['riffA', 'riffB'] };          // cycling list of 2
      cfg.motif.partSeqs = { 0: ['x', 'y', 'z'], 1: 'solo' };  // list of 3 + bare string
      cfg.schemaVersion = 8;
      const c2 = E.getCfg();
      // LCM(2,3) = 6, so BOTH layers come out exact rather than one rounded.
      eq('migrate/cols is the LCM', (c2.prog.parts[0].grid || {}).cols, 6);
      eq('migrate/list of 2 fills 6', c2.bed.partSeqs[0],
        { '0:*': 'riffA', '1:*': 'riffB', '2:*': 'riffA', '3:*': 'riffB', '4:*': 'riffA', '5:*': 'riffB' });
      eq('migrate/list of 3 fills 6', c2.motif.partSeqs[0],
        { '0:*': 'x', '1:*': 'y', '2:*': 'z', '3:*': 'x', '4:*': 'y', '5:*': 'z' });
      // A BARE STRING was the v1 one-per-part shape and meant "plays under this
      // part", on every pass — which is the PART DEFAULT, not N identical cells.
      eq('migrate/bare string becomes the part default',
        c2.motif.partSeqs[1], { all: 'solo' });
      eq('migrate/stamped v9', c2.schemaVersion, 9);
      // Re-normalising must be a no-op, or the migration is not idempotent.
      eq('migrate/idempotent', E.getCfg().bed.partSeqs[0],
        { '0:*': 'riffA', '1:*': 'riffB', '2:*': 'riffA', '3:*': 'riffB', '4:*': 'riffA', '5:*': 'riffB' });
      // A WIDTH-ONLY GRID NOW ENGAGES THE CLOCK — deliberately reversed. Width
      // was inert so this migration (which widens a part to the LCM of the
      // layers' cycling lists) could be applied silently; the cost was that
      // setting Passes to N drew N columns and changed nothing about what
      // played, reported three times as "it's skipping the second pass". A
      // control that does nothing is the worse of the two, and the migration is
      // long past. The migrated project now genuinely runs those passes.
      eq('migrate/width engages the clock', _ambGridOn(c2), true);
    }

    // ---- 2. WHICH PASS ------------------------------------------------------
    const walk = (chain) => {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      if (chain) cfg.prog.chain = chain.slice();
      E._cfg = E.getCfg();
      const barSec = (60 / 120) * 4;
      const out = [];
      for (let bar = 0; bar < 12; bar += 2) {          // one reading per part run
        const r = _ambPartPassAt(E, E._cfg, bar * barSec + 0.05);
        out.push(r ? ((E._cfg.prog.parts[r.pi] || {}).name || r.pi) + '#' + r.pass : '-');
      }
      return out;
    };
    eq('pass/written order', walk(null),
      ['Verse#0', 'Chorus#0', 'Verse#1', 'Chorus#1', 'Verse#2', 'Chorus#2']);
    // A chain that REVISITS a part must give the two visits DIFFERENT passes.
    // The old list keyed on floor(step/chords), so both played the same phrase.
    eq('pass/chain revisits a part', walk([0, 1, 0]),
      ['Verse#0', 'Chorus#0', 'Verse#1', 'Verse#2', 'Chorus#1', 'Verse#3']);

    // ---- 2b. ONE PART, AND NO PARTS ----------------------------------------
    // The shape of an ordinary project. _ambRepairParts COLLAPSES a single part
    // covering the whole cycle, so "no parts" is the common case — and a
    // progression still has PASSES either way, which is the entire point of the
    // feature. Requiring two parts (the old part→sequence rule) made the whole
    // thing invisible in exactly the project people have. Reported as "there is
    // no matrix or mechanism for mapping sequences to parts".
    {
      const cfg = baseProg([['Verse', 4]]);           // one part -> collapses to none
      E._cfg = E.getCfg();
      eq('one-part/rows are drawn', _ambPartSeqRows(E._cfg).length, 1);
      const barSec = (60 / 120) * 4;
      const seen = [0, 4, 8].map(bar => {
        const r = _ambPartPassAt(E, E._cfg, bar * barSec + 0.05);
        return r ? r.pi + '#' + r.pass : '-';
      });
      eq('one-part/passes still advance', seen, ['0#0', '0#1', '0#2']);

      // …and the cells actually resolve on it.
      cfg.prog.grid = { cols: 2, seq: {} };
      cfg.bed.partSeqs = { 0: { '0:*': 'riffA', '1:*': 'riffB' } };
      E._cfg = E.getCfg();
      const nm = (bar) => _ambPartSeqNameAt(E, E._cfg, E._cfg.bed, bar * barSec + 0.05);
      eq('one-part/pass 1 and 2 differ', [nm(0), nm(4), nm(8)], ['riffA', 'riffB', 'riffA']);

      // And the row renders rather than an excuse about splitting the part.
      E.inited = false; _ambientInit(E); _ambSyncControls(E);
      document.querySelectorAll('.ambient-layer').forEach(c => c.classList.remove('collapsed'));
      document.querySelectorAll('.ambient-grp').forEach(g => g.classList.add('open'));
      const row = document.querySelector('.ambient-partmap .psq-grid .pmx-head');
      eq('one-part/the grid renders', !!row, true);
      eq('one-part/pass headers', row ? [...row.querySelectorAll('.psq-passhdr')]
        .map(c => c.textContent.replace(/^\d+/, '')) : null, ['riffA', 'riffB']);
    }

    // ---- 3. THE FOUR CASCADE RULES -----------------------------------------
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      // Read the PASS HEADER strip — one entry per column, which is what the
      // cascade rules are about (how many passes there are, and which are live).
      const draw = () => {
        E.inited = false; _ambientInit(E); _ambSyncControls(E);
        document.querySelectorAll('.ambient-layer').forEach(c => c.classList.remove('collapsed'));
        document.querySelectorAll('.ambient-grp').forEach(g => g.classList.add('open'));
        const head = document.querySelector('.ambient-partmap .psq-grid .pmx-head');
        return [...head.querySelectorAll('.psq-passhdr')].map(c =>
          c.textContent.replace(/^\d+/, '') + (c.classList.contains('inert') ? '!' : ''));
      };
      cfg.prog.parts[0].grid = { cols: 4, seq: {} };
      cfg.bed.partSeqs = { 0: { '0:*': 'riffA', '1:*': 'riffB', '2:*': 'riffA', '3:*': 'riffB' } };
      eq('cascade/draws every pass', draw(), ['riffA', 'riffB', 'riffA', 'riffB']);

      cfg.prog.parts[0].grid.cols = 2;               // the ± stepper, mis-tapped
      eq('cascade/shrink hides', draw(), ['riffA', 'riffB']);
      eq('cascade/shrink KEEPS the cells', E.getCfg().bed.partSeqs[0],
        { '0:*': 'riffA', '1:*': 'riffB', '2:*': 'riffA', '3:*': 'riffB' });
      cfg.prog.parts[0].grid.cols = 4;
      eq('cascade/raising brings them back', draw(), ['riffA', 'riffB', 'riffA', 'riffB']);

      cfg.prog.parts[0].grid.cols = 6;
      eq('cascade/grow starts empty', draw(), ['riffA', 'riffB', 'riffA', 'riffB', '—', '—']);

      // A pass that plays no chords still RUNS; the mapping is kept and the cell
      // says why, because the user may simply be mid-edit.
      cfg.prog.parts[0].grid = { cols: 4, seq: { 1: [] } };
      eq('cascade/empty pass is inert, not cleared', draw(),
        ['riffA', 'riffB!', 'riffA', 'riffB']);
      eq('cascade/empty pass keeps the mapping',
        E.getCfg().bed.partSeqs[0]['1:*'], 'riffB');
    }
    {
      // partSeqs is keyed by part INDEX, so deleting a part must RE-INDEX it —
      // normalize only clamps, and a clamped index still resolves, to the wrong
      // part. Without this the Chorus would inherit the Verse's phrase.
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.bed.partSeqs = { 0: { all: 'riffA' }, 1: { all: 'riffB' } };
      E._cfg = E.getCfg();
      _ambProgDeletePart(E, 0);
      eq('cascade/delete re-indexes the cells',
        E.getCfg().bed.partSeqs, { 0: { all: 'riffB' } });
    }

    // ---- 4. A BLANK CELL IS SILENT ------------------------------------------
    // A phrase-driven layer plays what the schedule says and NOTHING ELSE: an
    // unmapped pass is a deliberate rest. It used to fall back to the layer's own
    // material, which is why a phrase written for one pass leaked into the rest.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 2, seq: {} };
      const key = 'bed', barSec = (60 / 120) * 4;
      // Give the layer a phrase of its own, the way composing does.
      _ambStepsToLock(E, key, [{ freq: 440 }, { freq: 550 }], false);
      const ownLen = ((E.getCfg().bed.lockState || {}).notes || []).length;
      eq('own/the layer has its own phrase', ownLen, 2);

      // Pass 1 maps a banked phrase; pass 2 is blank.
      cfg.bed.partSeqs = { 0: { '0:*': 'riffA' } };
      E._cfg = E.getCfg();
      _ambPartSeqSync(E, E._cfg, 0.05);                       // inside Verse pass 0
      eq('own/mapped phrase installs', (E.freeze[key] || {})._partSeqName, 'riffA');
      // THE POINT: installing must not consume the layer's own material.
      eq('own/lockState survives the install',
        ((E.getCfg().bed.lockState || {}).notes || []).length, 2);

      // Verse pass 1 — blank — is SILENT, not the layer's own phrase.
      _ambPartSeqSync(E, E._cfg, 4 * barSec + 0.05);
      eq('own/blank cell drops the mapped phrase',
        (E.freeze[key] || {})._partSeqName !== 'riffA', true);
      eq('own/blank cell plays nothing', ((E.freeze[key] || {}).events || []).length, 0);
      eq('own/blank cell stays frozen so the emitter cannot fill it',
        !!(E.freeze[key] || {}).frozen, true);
      eq('own/lockState is NOT consumed by going silent',
        ((E.getCfg().bed.lockState || {}).notes || []).length, 2);
    }
    {
      // A layer that is phrase-driven goes SILENT on a blank cell — it does not
      // hand back to the emitter. Generating there is what made an unmapped pass
      // play something nobody wrote.
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 2, seq: {} };
      cfg.bed.partSeqs = { 0: { '0:*': 'riffA' } };
      E._cfg = E.getCfg();
      const barSec = (60 / 120) * 4;
      _ambPartSeqSync(E, E._cfg, 0.05);
      eq('own/generating layer takes the mapping',
        (E.freeze.bed || {})._partSeqName, 'riffA');
      _ambPartSeqSync(E, E._cfg, 4 * barSec + 0.05);
      // The re-anchor can leave an EMPTY freeze entry behind; what matters is
      // that nothing is frozen on the layer any more, not that the key is gone.
      eq('own/blank cell silences rather than thaws',
        !!(E.freeze.bed && E.freeze.bed.frozen), true);
      eq('own/silenced layer emits nothing',
        ((E.freeze.bed || {}).events || []).length, 0);
    }

    // ---- 4b. FOUR LEVELS: chord -> pass -> part -> the layer's own phrase ---
    // The narrowest axis is a CHORD on a PASS. Without the wider ones, giving a
    // part its own material meant writing it into every chord of every pass and
    // rewriting them whenever either count changed.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 3, seq: {} };
      cfg.bed.partSeqs = { 0: { all: 'riffA', '1:*': 'riffB', '2:0': 'lift' } };
      E._cfg = E.getCfg();
      const stored = E.getCfg().bed.partSeqs[0];
      eq('levels/`all` survives normalize', stored.all, 'riffA');
      // 'all' | 0 === 0, so a numeric coercion anywhere on this path files the
      // part default as a pass. It must NOT have leaked into one.
      eq('levels/`all` is not a pass', stored['0:*'], undefined);
      eq('levels/pass key survives', stored['1:*'], 'riffB');
      eq('levels/chord key survives', stored['2:0'], 'lift');

      const L = E._cfg.bed;
      // PROJECT to what this block is about — which level won, and with what
      // name. The resolver also carries the slice SPEC now; asserting on the
      // whole object would make every additive field a test failure.
      const at = (pass, ci) => { const r = _ambPartSeqResolve(L, 0, pass, ci); return { name: r.name, from: r.from }; };
      eq('levels/chord+pass wins', at(2, 0), { name: 'lift', from: 'cell' });
      eq('levels/then the pass', at(1, 0), { name: 'riffB', from: 'pass' });
      eq('levels/then the part', at(0, 1), { name: 'riffA', from: 'all' });
      eq('levels/pass 3, other chord falls to the part', at(2, 1), { name: 'riffA', from: 'all' });
      // A part with NOTHING set falls all the way through to the layer's own.
      eq('levels/other part falls through', (r => ({ name: r.name, from: r.from }))(_ambPartSeqResolve(L, 1, 0, 0)),
        { name: '', from: '' });

      // …and the matrix must SHOW the inheritance, or the picture contradicts
      // the audio. Row 0 = the part's first chord across its three passes.
      E.inited = false; _ambientInit(E); _ambSyncControls(E);
      document.querySelectorAll('.ambient-layer').forEach(c => c.classList.remove('collapsed'));
      document.querySelectorAll('.ambient-grp').forEach(g => g.classList.add('open'));
      const rows = [...document.querySelectorAll('.ambient-partmap .psq-grid .pmx-row')];
      const head = rows[0], first = rows[1];
      eq('levels/the corner is the part default', head
        ? head.querySelector('.psq-all').textContent : null, 'riffA');
      eq('levels/pass headers', head
        ? [...head.querySelectorAll('.psq-passhdr')].map(c => c.textContent.replace(/^\d+/, ''))
        : null, ['—', 'riffB', '—']);
      eq('levels/first chord row shows what it inherits', first
        ? [...first.querySelectorAll('.psq-cell')].map(c => c.textContent)
        : null, ['↳ riffA', '↳ riffB', 'lift']);
    }
    {
      // A one-per-part legacy value IS a part default — it must migrate to `all`
      // rather than being flattened into a cell per pass.
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.bed.partSeqs = { 0: 'riffA', 1: ['riffB'] };
      cfg.schemaVersion = 8;
      const c2 = E.getCfg();
      eq('levels/bare string migrates to the part default', c2.bed.partSeqs[0], { all: 'riffA' });
      eq('levels/one-entry list migrates to the part default', c2.bed.partSeqs[1], { all: 'riffB' });
    }

    // ---- 4c. A CHORD, IN A PART, ON A PASS ---------------------------------
    // The thing this feature is for: "play lift over the second chord of the
    // Verse, the third time round". Resolved on the CHORD CLOCK, so it moves
    // with the changes rather than only at the pass boundary.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 2, seq: {} };
      cfg.bed.partSeqs = { 0: { '1:1': 'riffB' } };
      E._cfg = E.getCfg();
      const barSec = (60 / 120) * 4;
      // Verse = chords 0-1 (bars 0-2). A part runs its passes BACK TO BACK, so
      // pass 0 = bars 0-2 and pass 1 = bars 2-4; the Chorus follows at bar 4.
      // (It used to interleave — pass 1 sat at bars 4-6, after the Chorus — and
      // these sample points are the only thing about this test that moved: what
      // it asserts, "riffB plays over chord 1 of pass 1 and nowhere else", is
      // unchanged.)
      const seen = [0, 1, 2, 3].map(bar => {
        const w = _ambPartChordAt(E, E._cfg, bar * barSec + 0.05);
        return w ? (w.pi + '/' + w.pass + '/' + w.ci) : '-';
      });
      eq('chord/where are we', seen, ['0/0/0', '0/0/1', '0/1/0', '0/1/1']);
      const nm = (bar) => _ambPartSeqNameAt(E, E._cfg, E._cfg.bed, bar * barSec + 0.05);
      eq('chord/only that chord on that pass',
        [nm(0), nm(1), nm(2), nm(3)], [null, null, null, 'riffB']);
    }

    // ---- 5. ADOPTING FROM THE SEQUENCES ROW RELEASES THE MAPPING ------------
    // Two rows install a phrase: Sequences sets the layer's OWN phrase, Plays
    // schedules one per pass. Tapping a Sequences chip is an explicit adoption,
    // so it must release any live mapping first — otherwise _ambSyncLockState's
    // `_partSeqName` guard files the adopted phrase as runtime material, refuses
    // to persist it, and the confirmation toast is a lie.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 2, seq: {} };
      cfg.bed.partSeqs = { 0: { '0:*': 'riffA' } };
      E._cfg = E.getCfg();
      _ambPartSeqSync(E, E._cfg, 0.05);
      eq('adopt/a mapping is live first', (E.freeze.bed || {})._partSeqName, 'riffA');

      // Adopt riffB the way the Sequences chip does.
      delete _ambFreezeState(E, 'bed')._partSeqName;
      _ambStepsToLock(E, 'bed', _ambBankByName('riffB').steps, true);
      const f = _ambFreezeState(E, 'bed');
      f.frozen = true; f._lock = true; delete f._partSeqName;
      _ambPersistLock(E, 'bed');

      eq('adopt/mapping released', !!(E.freeze.bed || {})._partSeqName, false);
      eq('adopt/lockState IS written', ((E.getCfg().bed.lockState || {}).notes || [])
        .map(n => Math.round(n.freq)), [330]);
      // …and it is now what a blank pass gives back.
      const barSec = (60 / 120) * 4;
      _ambPartSeqSync(E, E._cfg, 0.05);                       // pass 0 re-takes it
      _ambPartSeqSync(E, E._cfg, 4 * barSec + 0.05);          // pass 1 is blank
      eq('adopt/blank pass is silent, adopted phrase or not',
        ((E.freeze.bed || {}).events || []).length, 0);
    }

    // ---- 5b. THE LOOP OVERRIDE ----------------------------------------------
    // `L.phraseLoop` names one phrase the layer loops for the whole piece and it
    // OUTRANKS the schedule — so a mapped pass and a blank pass both play it.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 2, seq: {} };
      const barSec = (60 / 120) * 4;
      cfg.bed.partSeqs = { 0: { '0:*': 'riffA' } };
      cfg.bed.phraseLoop = 'riffB';
      E._cfg = E.getCfg();
      eq('override/survives normalize', E.getCfg().bed.phraseLoop, 'riffB');
      _ambPartSeqSync(E, E._cfg, 0.05);                       // a MAPPED pass
      eq('override/beats a mapped cell', (E.freeze.bed || {})._partSeqName, 'riffB');
      _ambPartSeqSync(E, E._cfg, 4 * barSec + 0.05);          // a BLANK pass
      eq('override/plays on a blank pass too', (E.freeze.bed || {})._partSeqName, 'riffB');
      eq('override/is not silent', ((E.freeze.bed || {}).events || []).length > 0, true);
      // An empty string is not an override — it must not survive normalize, or
      // absence and "no override" become two different states.
      cfg.bed.phraseLoop = '';
      eq('override/empty string is dropped', E.getCfg().bed.phraseLoop, undefined);
    }
    {
      // A layer with NEITHER a mapping nor an override is not phrase-driven and
      // must be left completely alone — otherwise switching a progression on
      // silences every layer in the project.
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      delete cfg.bed.partSeqs; delete cfg.bed.phraseLoop;
      E._cfg = E.getCfg();
      delete E.freeze.bed;
      _ambPartSeqSync(E, E._cfg, 0.05);
      eq('override/un-mapped layer is untouched', !E.freeze.bed || !E.freeze.bed.frozen, true);
    }

    // ---- 5b. GENERATE — the third answer ------------------------------------
    // A cell can say "no composed phrase here". That is a real answer, so it
    // STOPS the cascade at the level that said it — returning it as an absence
    // would be indistinguishable from "nothing set" and the next level up would
    // answer instead, which is the whole bug this exists to fix.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      E._cfg = E.getCfg();
      const L = cfg.bed;
      const GEN = window._ambPartSeqGenSentinel;
      const R = (pass, ci) => { const r = _ambPartSeqResolve(L, 0, pass, ci);
        return r.gen ? ('GEN@' + r.from) : (r.name ? (r.name + '@' + r.from) : '-'); };

      L.partSeqs = { 0: { all: 'riffA', '1:*': GEN } };
      eq('gen/part default still answers', R(0, 0), 'riffA@all');
      eq('gen/a pass can opt out', R(1, 0), 'GEN@pass');
      eq('gen/it does NOT fall through to the part default', R(1, 1), 'GEN@pass');

      L.partSeqs = { 0: { '0:*': 'riffB', '0:1': GEN } };
      eq('gen/a cell outranks its pass', R(0, 1), 'GEN@cell');
      eq('gen/its neighbour is unaffected', R(0, 0), 'riffB@pass');

      // It is a stored value like any other, so it must survive a normalize —
      // getCfg runs one on every call and a dropped sentinel would silently
      // revert the cell to "inherit", i.e. back to playing the phrase.
      L.partSeqs = { 0: { all: GEN } };
      eq('gen/survives normalize', (E.getCfg().bed.partSeqs || {})[0], { all: GEN });
      // ...and a layer holding only a Generate cell is still phrase-driven, or
      // the sync would never run and never hand it back.
      eq('gen/keeps the layer phrase-driven', _ambPhraseDriven(E.getCfg().bed), true);
    }

    // ---- 5c. PASS LOCK + the per-pass Plays key ------------------------------
    // Holding a pass repeats it by pushing the CHORD CLOCK's anchor forward one
    // pass at a time; releasing stops pushing, so the current repetition simply
    // runs on into the next pass. And the per-pass mask has to be reachable
    // WHILE held — that is the whole point of holding one.
    {
      const cfg = baseProg([['A', 2], ['B', 2]]);
      cfg.prog.parts[0].plays = 3;
      cfg.bpm = 240; cfg.barsPerChord = 1;
      E._cfg = E.getCfg(); E._progAnchor = 0; E._barGridAnchor = 0; E._playStartAt = 0;
      const c2 = E._cfg, L = c2.bed;
      const barSec = (60 / 240) * 4, at = (b2) => b2 * barSec;
      const where = (b2) => { const w = _ambPartChordAt(E, c2, at(b2));
        return w ? (c2.prog.parts[w.pi].name + (w.pass + 1)) : '?'; };

      eq('lock/free walk', [0, 2, 4, 6].map(where), ['A1', 'A2', 'A3', 'B1']);

      const held = _ambPassLockEngage(E, c2, at(2));
      eq('lock/engages on the pass playing now', held && held.pass, 1);
      // The span is BISECTED out of the clock, so it carries float noise — an
      // over-long span means the wrap misses the boundary bar and one bar of the
      // NEXT pass plays between repetitions. It must land on the bar grid.
      eq('lock/span is snapped to the grid', Math.round((held.to - held.from) / barSec * 1e6) / 1e6, 2);

      const held6 = [];
      for (let b2 = 2; b2 < 10; b2++) { _ambPassLockSync(E, c2, at(b2), 0); held6.push(where(b2)); }
      eq('lock/repeats that pass and nothing else', [...new Set(held6)], ['A2']);

      // THE KEY THE GATE LOOKS UP MUST BE THE KEY THE GRID WROTE. The gate used
      // to build it from `sp.step` (the raw progression index) while the cell is
      // keyed on `rg.from + w.ci` — under parts those are DIFFERENT numbers for
      // the same sounding chord (measured 2 vs 0), so every lookup missed and the
      // gate silently fell through to the per-chord default.
      _ambChordPassSet(L, held.pass, 0, 0);              // silence chord 0 of the held pass
      _ambPassLockSync(E, c2, at(10), 0);
      eq('lock/a live per-pass edit is heard while held',
        _ambChordGateOK(E, L, at(10), c2, c2.prog, false), false);
      eq('lock/…and only on the chord it names',
        _ambChordGateOK(E, L, at(11), c2, c2.prog, false), true);
      _ambChordPassSet(L, held.pass, 0, null);
      eq('lock/undoing it is heard too',
        _ambChordGateOK(E, L, at(12), c2, c2.prog, false), true);

      // RELEASE IS NOTHING AT ALL — stop pushing the anchor and the current
      // repetition runs on into the next pass.
      _ambPassLockRelease(E);
      eq('lock/released', _ambPassLockOn(E), false);
      // Asserted as a SHAPE, not as hand-guessed labels: the anchor has been
      // pushed forward by each repetition, so which absolute bar lands on which
      // pass is arithmetic nobody should be writing out by hand. What matters is
      // that it stops repeating and walks on.
      const after = [];
      for (let b2 = 13; b2 < 25; b2++) after.push(where(b2));
      eq('lock/stops repeating after release', new Set(after).size > 1, true);
      eq('lock/then walks the chain', after.filter(x => x !== 'A2').length > 0, true);

      // The per-pass store has NO part dimension of its own, so its key is the
      // ABSOLUTE chord index — keyed within the part, pass 1 chord 0 of A and of
      // B were the same cell and an edit to one silenced the other.
      _ambChordPassSet(L, 0, 2, 0);                       // absolute chord 2 = B's first
      eq('perpass/an edit on B does not touch A',
        _ambChordGateOK(E, L, at(0), c2, c2.prog, false), true);
      delete L.chordMask;
    }

    // ---- 6. THE CELL PICKER ------------------------------------------------
    // A cell is set from a LIST, not by rotating: rotation is unusable once the
    // bank grows. The menu must name the SCOPE it is editing and what blank
    // means there, because "—" does something different at each level.
    {
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      cfg.prog.parts[0].grid = { cols: 2, seq: {} };
      cfg.bed.partSeqs = { 0: { all: 'riffA' } };
      E._cfg = E.getCfg();
      E.inited = false; _ambientInit(E); _ambSyncControls(E);
      document.querySelectorAll('.ambient-layer').forEach(c => c.classList.remove('collapsed'));
      document.querySelectorAll('.ambient-grp').forEach(g => g.classList.add('open'));

      const seen = [];
      const real = window.showCtxMenu;
      window.showCtxMenu = (x, y, items) => { seen.push(items.map(i => i === 'hr' ? 'hr' : i.label)); };
      try {
        const grid = document.querySelector('.ambient-partmap .psq-grid');
        const rows = [...grid.querySelectorAll('.pmx-row')];
        rows[0].querySelector('.psq-all').click();                       // the corner
        rows[0].querySelectorAll('.psq-passhdr')[1].click();             // a pass header
        rows[1].querySelectorAll('.psq-cell')[1].click();                // a chord on a pass
      } finally { window.showCtxMenu = real; }

      eq('picker/opens for all three scopes', seen.length, 3);
      eq('picker/corner names the part scope', (seen[0] || [])[0], 'Verse — every chord, every pass');
      eq('picker/pass header names the pass', (seen[1] || [])[0], 'Verse — the whole of pass 2');
      eq('picker/a cell names chord and pass', /pass 2$/.test((seen[2] || [])[0] || ''), true);
      // Blank means something DIFFERENT at each level, and the first entry says so.
      // No tick: the corner IS set (to riffA), so blank is not the current value.
      eq('picker/corner blank = the layer’s own', (seen[0] || [])[2], '— this layer’s own phrase');
      eq('picker/pass blank = each chord decides', (seen[1] || [])[2], '✓ — let each chord decide');
      eq('picker/cell blank = follow the part default',
        (seen[2] || [])[2], '✓ — follow the part default, “riffA”');
      // GENERATE is the third answer, between blank and the bank — a cell that
      // opts out of composed phrases entirely. It sits with the other two
      // meta-choices, above the separator, so the bank stays one flat list.
      eq('picker/offers Generate', (seen[0] || [])[3], '⚡ Generate — no composed phrase here');
      eq('picker/Generate is ticked when set', (seen[1] || [])[3], '⚡ Generate — no composed phrase here');
      // The bank is listed, with the current value ticked.
      // NEWEST FIRST, matching the order the Sequences row lists them in.
      eq('picker/lists the bank', (seen[0] || []).slice(5), ['riffB', '✓ riffA']);

      // And choosing actually writes.
      let picked = null;
      window.showCtxMenu = (x, y, items) => { picked = items; };
      try {
        document.querySelector('.ambient-partmap .psq-grid .pmx-row .psq-all').click();
      } finally { window.showCtxMenu = real; }
      const riffB = (picked || []).find(i => i !== 'hr' && /riffB/.test(i.label));
      if (riffB) riffB.fn();
      eq('picker/choosing writes the cell', E.getCfg().bed.partSeqs[0].all, 'riffB');
    }

    // ---- 7. A DEACTIVATED CHORD SHORTENS THE PASS -------------------------
    // The grid's skip semantics make the played cycle differ from the WRITTEN
    // one, and everything that snaps to "a whole progression cycle" (Write /
    // Evolve phrase length, the Grid harvest window, a hummed take's loop) has
    // to follow the played one — otherwise a 4-bar loop repeats over a 7-bar
    // harmony and only realigns every 28 bars. Heard as jank at the pass
    // boundary where the chord is dropped.
    {
      const cfg = baseProg([['Verse', 4]]);
      delete cfg.prog.parts;
      cfg.prog.grid = { cols: 2, seq: { '1': [0, 2, 3] } };    // pass 2 drops chord 1
      E._cfg = E.getCfg();
      const c = E._cfg;
      eq('skip/the played cycle is shorter', _ambGridPlan(c).cycle, 7);
      eq('skip/cycle bars follow what PLAYS', _ambProgCycleBars(c), 7);
      // The chord clock itself was never wrong — pin it so a fix here cannot
      // quietly move it.
      const barSec = (60 / 120) * 4;
      const walk = [];
      for (let bar = 0; bar < 7; bar++) walk.push(_ambProgStepAt(E, bar * barSec + 0.01) % 4);
      eq('skip/the clock walks the played order', walk, [0, 1, 2, 3, 0, 2, 3]);
    }
    {
      // WITHOUT a grid the written list IS the cycle, and with repeats the played
      // length is a whole MULTIPLE of it — so a loop still lines up and this must
      // stay exactly as it was.
      const cfg = baseProg([['Verse', 2], ['Chorus', 2]]);
      E._cfg = E.getCfg();
      eq('skip/no grid: unchanged', _ambProgCycleBars(E._cfg), 4);
      cfg.prog.parts[0].plays = 2;
      E._cfg = E.getCfg();
      eq('skip/repeats: still the written cycle', _ambProgCycleBars(E._cfg), 4);
    }

    // ---- 8. RE-RULING THE LANE TO A NEW STEP SIZE --------------------------
    // Changing step size must re-rule the paper, not stretch the music: notes
    // keep their POSITION, rests are always exactly one step of the new size and
    // fill the gaps, and the lane ends on a whole number of steps. Setting
    // `subdivision` on every step (the obvious implementation) rescales the
    // RESTS too, so every note slides and the phrase changes length.
    {
      const lenOf = (st) => (st.subdivision != null ? st.subdivision : 0.5) * (st.duration || 1);
      const line = (lane) => {
        let t = 0; const notes = [];
        lane.steps.forEach(st => { const L = lenOf(st);
          if (st.freq != null) notes.push(st.label + '@' + t.toFixed(3) + '+' + L.toFixed(3)); t += L; });
        return { notes, total: +t.toFixed(3) };
      };
      const mk = () => ({ steps: [
        { freq: 220, label: 'A', subdivision: 0.5, duration: 1 },
        { subdivision: 0.5, duration: 1 },
        { freq: 330, label: 'B', subdivision: 0.5, duration: 1 },
        { subdivision: 0.5, duration: 1 } ] });
      const restSizes = (lane) => [...new Set(lane.steps.filter(st => st.freq == null).map(st => st.subdivision))];

      const a = mk(); _ambGridResizeLane(a, 0.25);
      eq('resize/shrink keeps note positions', line(a).notes, ['A@0.000+0.500', 'B@1.000+0.500']);
      eq('resize/shrink keeps the phrase length', line(a).total, 2);
      eq('resize/rests are one step of the new size', restSizes(a), [0.25]);

      const c = mk(); _ambGridResizeLane(c, 1);
      eq('resize/enlarge grows the notes', line(c).notes, ['A@0.000+1.000', 'B@1.000+1.000']);
      eq('resize/enlarge keeps positions', line(c).total, 2);

      // A JOINED note is an arbitrary length and must survive re-ruling verbatim.
      const d = mk(); d.steps[0].duration = 3;            // A = 1.5 beats
      _ambGridResizeLane(d, 0.25);
      eq('resize/a joined note keeps its length', line(d).notes[0], 'A@0.000+1.500');
      eq('resize/rests still one step', restSizes(d), [0.25]);

      // …and a length that does NOT divide the new size is kept exactly, rather
      // than being rounded onto the grid.
      const e2 = { steps: [{ freq: 220, label: 'A', subdivision: 0.3, duration: 1 },
                           { subdivision: 0.5, duration: 1 }] };
      _ambGridResizeLane(e2, 0.25);
      eq('resize/arbitrary length survives', +lenOf(e2.steps[0]).toFixed(3), 0.3);

      // An all-rest lane is simply re-ruled.
      const f = { steps: [{ subdivision: 0.5, duration: 1 }, { subdivision: 0.5, duration: 1 }] };
      _ambGridResizeLane(f, 0.25);
      eq('resize/all-rest lane re-rules', f.steps.length, 4);
      eq('resize/all-rest keeps length', f.steps.reduce((a2, st) => a2 + lenOf(st), 0), 1);
    }

    // ---- 9. APPENDING A PART MUST NOT EAT THE EXISTING CHORDS --------------
    // Parts are contiguous RANGES measured in `len`. If they cover fewer chords
    // than exist, the uncovered ones silently become part of whatever is pushed
    // next — the earlier part appears to shrink to its stated `len`. Reported as
    // "I added a new part and the first part was basically nuked, reduced to a
    // single chord".
    {
      const four = () => [0, 9, 2, 7].map(r => ({ root: r, intervals: [0, 4, 7, 11] }));
      const add = () => [6, 1, 11].map(r => ({ root: r, intervals: [0, 4, 7] }));
      const run = (setup) => {
        const cfg = E.getCfg();
        cfg.prog.on = true; cfg.prog.name = 'Imaj7 — vi7 — ii — V';
        cfg.prog.chords = four();
        delete cfg.prog.parts; delete cfg.prog.grid; delete cfg.prog.chain;
        setup(cfg.prog);
        _ambProgAppendPart(cfg.prog, 'New', add(), null);
        const c = E.getCfg();
        return { chords: c.prog.chords.length,
                 parts: (c.prog.parts || []).map(x => x.len),
                 roots: c.prog.chords.map(x => x.root) };
      };
      const clean = run(() => {});
      eq('append/clean keeps every chord', clean.roots, [0, 9, 2, 7, 6, 1, 11]);
      eq('append/clean part lengths', clean.parts, [4, 3]);
      // The reported state: a part claiming ONE of the four chords.
      const stale = run(pr => { pr.parts = [{ name: 'Imaj7 — vi7 — ii', len: 1 }]; });
      eq('append/a short part is repaired, not eaten', stale.parts, [4, 3]);
      eq('append/chords survive a short part', stale.roots, [0, 9, 2, 7, 6, 1, 11]);
      const two = run(pr => { pr.parts = [{ name: 'A', len: 1 }, { name: 'B', len: 1 }]; });
      eq('append/shortfall goes to the LAST part', two.parts, [1, 3, 3]);
    }

    // ---- 10. THE SEEDED PART IS NAMED AFTER ITS OWN CHORDS ------------------
    // `prog.name` is set when a progression is picked or exported and is NEVER
    // re-derived when the chords change, so it goes stale on the first edit.
    // Seeding the first part from it produced "Imaj7 — vi7 — ii" over a single
    // Cmaj7 — which reads as three chords having been destroyed by adding a
    // part. Nothing was destroyed; the name described a progression that no
    // longer existed.
    {
      const run = (name, roots) => {
        const cfg = E.getCfg();
        cfg.prog.on = true; cfg.prog.name = name;
        cfg.prog.chords = roots.map(r => ({ root: r, intervals: [0, 4, 7, 11] }));
        delete cfg.prog.parts; delete cfg.prog.grid; delete cfg.prog.chain;
        _ambProgAppendPart(cfg.prog, 'New', [6, 1].map(r => ({ root: r, intervals: [0, 4, 7] })), null);
        return (E.getCfg().prog.parts || []).map(x => x.name + ':' + x.len);
      };
      eq('seedname/a stale list name is re-derived', run('Imaj7 — vi7 — ii — V', [0]),
        ['Cmaj7:1', 'New:2']);
      eq('seedname/an accurate list name is kept', run('Imaj7 — vi7 — ii — V', [0, 9, 2, 7]),
        ['Imaj7 — vi7 — ii:4', 'New:2']);
      // A name with no list shape is someone's own title — never second-guessed.
      eq('seedname/a title is left alone', run('Neon Nocturne', [0]),
        ['Neon Nocturne:1', 'New:2']);
      eq('seedname/no name derives one', run('', [0, 9]),
        ['Cmaj7 — Amaj7:2', 'New:2']);
    }
    // …and the ROOT of it: `prog.name` itself goes stale, because it is written
    // once and no chord-editing path updates it. Normalize keeps an auto-generated
    // LIST name honest, so nothing downstream can inherit a lie.
    {
      const nm = (name, roots) => {
        const cfg = E.getCfg();
        cfg.prog.on = true; cfg.prog.name = name;
        cfg.prog.chords = roots.map(r => ({ root: r, intervals: [0, 4, 7, 11] }));
        delete cfg.prog.parts;
        return E.getCfg().prog.name;
      };
      eq('progname/a stale list is re-derived', nm('Imaj7 — vi7 — ii — V', [0]), 'Cmaj7');
      eq('progname/an accurate list is untouched', nm('Cmaj7 — Amaj7', [0, 9]), 'Cmaj7 — Amaj7');
      eq('progname/a chosen title is never rewritten', nm('Neon Nocturne', [0]), 'Neon Nocturne');
      // The reported journey: 4 chords, an edit cuts it to 1, then a part is added.
      const cfg = E.getCfg();
      cfg.prog.on = true; cfg.prog.name = 'Imaj7 — vi7 — ii — V';
      cfg.prog.chords = [0, 9, 2, 7].map(r => ({ root: r, intervals: [0, 4, 7, 11] }));
      delete cfg.prog.parts;
      E.getCfg();
      cfg.prog.chords.splice(1, 3);
      E.getCfg();
      _ambProgAppendPart(cfg.prog, 'New', [6, 1].map(r => ({ root: r, intervals: [0, 4, 7] })), null);
      eq('progname/the seeded part cannot inherit a lie',
        (E.getCfg().prog.parts || []).map(x => x.name + ':' + x.len), ['Cmaj7:1', 'New:2']);
    }

    // ---- 11. A PASSES GRID IS ONLY VALID OVER THE CHORDS IT WAS WRITTEN FOR --
    // `grid.seq` indexes chords BY POSITION within the part, so a length change
    // makes those positions mean something else. Filtering out-of-range indices
    // (the old behaviour) turned an authored pass of [Am7, G7] into [Am7] — a
    // pass silently playing ONE chord where two were written. Reported as "now
    // it's only looping the first 3 chords" after editing parts.
    {
      const chord = (r) => ({ root: r, intervals: [0, 4, 7] });
      const cfg = E.getCfg();
      cfg.prog.on = true; cfg.prog.name = '';
      cfg.prog.chords = [0, 9, 2, 7].map(chord);
      delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid;
      cfg.prog.grid = { cols: 6, seq: { '1': [0, 2], '2': [1, 3] }, fit: 1 };
      const plays = () => { const c = E.getCfg();
        return [0, 1, 2].map(col => _ambPartGridSeq(c, 0, col, c.prog.chords.length).join('')); };
      const grid = () => (E.getCfg().prog.grid || {});
      eq('passgrid/authored passes play as written', plays(), ['0123', '02', '13']);
      eq('passgrid/the authored length is stamped', grid().len, 4);

      cfg.prog.chords.splice(3, 1);                       // a part edit
      eq('passgrid/a length change RESETS, never mangles', plays(), ['012', '012', '012']);
      eq('passgrid/the pass count survives the reset', grid().cols, 6);
      eq('passgrid/fill-cadence survives the reset', !!grid().fit, true);

      cfg.prog.chords.push(chord(5));
      eq('passgrid/still intact after another change', grid().cols, 6);
      E.getCfg(); E.getCfg();
      eq('passgrid/idempotent', grid().cols, 6);
    }

    // ---- SLICES: a cell can name PART of a phrase, and how it fits ----------
    // The cell value grew from a bare name to {n,s,l,f}. Two things have to hold
    // or the growth is not additive: a whole phrase at the default fit must
    // still STORE as a plain string (which is what keeps every older project and
    // every check above unchanged), and the fit must actually change the steps.
    {
      const mk = (n, bars) => ({ name: n, type: 'seq',
        steps: Array.from({ length: bars }, (_, i) => ({ freq: 220 * (i + 1), subdivision: 4, duration: 1 })) });
      savedSequences.length = 0;
      savedSequences.push(mk('four', 4), mk('two', 2));

      eq('slice/a whole phrase still stores as a STRING', _ambPsqStore({ n: 'four', s: 0, l: 0, f: 'loop' }), 'four');
      eq('slice/a slice stores as an object', _ambPsqStore({ n: 'four', s: 1, l: 2, f: 'stretch' }),
         { n: 'four', s: 1, l: 2, f: 'stretch' });
      eq('slice/a bare string reads back as a whole-phrase spec', _ambPsqSpec('four'), { n: 'four', s: 0, l: 0, f: 'loop' });
      eq('slice/an unknown fit falls back to loop', _ambPsqSpec({ n: 'four', f: 'nonsense' }).f, 'loop');

      const four = savedSequences[0].steps;
      eq('slice/phrase length in bars', _ambSeqBars(four), 4);
      eq('slice/whole phrase', _ambSeqSlice(four, 0, 0).length, 4);
      eq('slice/a bar range', _ambSeqBars(_ambSeqSlice(four, 1, 2)), 2);
      eq('slice/len 0 means to the end', _ambSeqSlice(four, 2, 0).length, 2);

      const one = _ambSeqSlice(four, 1, 1);                 // exactly 1 bar
      eq('fit/loop fills the chord', _ambSeqBars(_ambSeqFit(one, 2, 'loop')), 2);
      eq('fit/loop repeats the steps', _ambSeqFit(one, 2, 'loop').length, 2);
      eq('fit/once plays it once and rests', _ambSeqBars(_ambSeqFit(one, 2, 'once')), 1);
      eq('fit/stretch spans the chord', _ambSeqBars(_ambSeqFit(one, 2, 'stretch')), 2);
      eq('fit/stretch does NOT add steps', _ambSeqFit(one, 2, 'stretch').length, 1);
      eq('fit/a long slice is cut at the chord', _ambSeqBars(_ambSeqFit(four, 2, 'loop')), 2);
      eq('fit/same length is left alone', _ambSeqFit(one, 1, 'loop').length, one.length);

      eq('slice/steps for a mapping', (_ambPartSeqStepsFor({ n: 'four', s: 1, l: 1, f: 'loop' }, 2) || []).length, 2);
      eq('slice/an unknown name yields nothing', _ambPartSeqStepsFor({ n: 'nope', s: 0, l: 0, f: 'loop' }, 2), null);

      // The install guard compares the SIG, not the name — re-slicing the same
      // phrase must count as a change or the old one keeps playing.
      eq('slice/sig separates two slices of one phrase',
         _ambPsqSig(_ambPsqSpec({ n: 'four', s: 0, l: 1 })) === _ambPsqSig(_ambPsqSpec({ n: 'four', s: 2, l: 1 })), false);
      eq('slice/sig separates two fits of one slice',
         _ambPsqSig(_ambPsqSpec({ n: 'four', s: 0, l: 1, f: 'loop' })) === _ambPsqSig(_ambPsqSpec({ n: 'four', s: 0, l: 1, f: 'once' })), false);

      // Round trip through normalize, which is where a new value shape usually
      // dies (the documented backfill trap).
      const Lx = E._cfg.bed;
      delete Lx.partSeqs;
      _ambPartSeqCellSet(Lx, 0, '1:2', { n: 'four', s: 1, l: 2, f: 'stretch' });
      _ambPartSeqCellSet(Lx, 0, 'all', 'two');
      E.getCfg(); E.getCfg();
      const back = E.getCfg().bed.partSeqs;
      eq('slice/survives normalize', back['0']['1:2'], { n: 'four', s: 1, l: 2, f: 'stretch' });
      eq('slice/a plain name stays plain through normalize', back['0'].all, 'two');
      eq('slice/resolve carries the spec', _ambPsqSig(_ambPartSeqResolve(E._cfg.bed, 0, 1, 2).spec), 'four#1#2#stretch');
      eq('slice/the name alone is still readable', _ambPartSeqCellGet(E._cfg.bed, 0, '1:2'), 'four');
      eq('slice/label names the range', _ambPsqLabel(_ambPsqSpec({ n: 'four', s: 1, l: 2, f: 'stretch' })), 'four ♪2-3 ⤡');
      delete Lx.partSeqs;
    }

    // ---- DELETING A BANKED PHRASE DROPS THE CELLS THAT NAMED IT -------------
    // A mapping references a phrase BY NAME, so a delete that only splices the
    // bank leaves every cell pointing at nothing and the layer falls back to its
    // own phrase with nothing saying why.
    {
      const mk = (n, bars) => ({ name: n, type: 'seq',
        steps: Array.from({ length: bars }, (_, i) => ({ freq: 220 * (i + 1), subdivision: 4, duration: 1 })) });
      savedSequences.length = 0;
      savedSequences.push(mk('keepme', 2), mk('goner', 4));

      const A = E._cfg.bed, B = E._cfg.motif;
      delete A.partSeqs; delete B.partSeqs;
      _ambPartSeqCellSet(A, 0, 'all', 'goner');
      _ambPartSeqCellSet(A, 0, '1:2', { n: 'goner', s: 1, l: 2, f: 'stretch' });
      _ambPartSeqCellSet(B, 0, '0:*', 'goner');
      _ambPartSeqCellSet(B, 0, 'all', 'keepme');

      eq('del/counts every cell that names it', _ambSeqUses('goner').cells, 3);
      eq('del/counts the layers', _ambSeqUses('goner').layers, 2);
      eq('del/a SLICE of it counts too', _ambSeqUses('goner').cells >= 2, true);
      eq('del/an unused phrase warns about nothing', _ambSeqDeleteWarn('keepme') !== '', true);
      eq('del/an unreferenced name has no warning', _ambSeqDeleteWarn('nobody'), '');

      const dropped = _ambSeqForget('goner');
      eq('del/drops exactly the cells that named it', dropped, 3);
      eq('del/none are left', _ambSeqUses('goner').cells, 0);
      eq('del/the other phrase is untouched', _ambSeqUses('keepme').cells, 1);
      // Pruning must leave "no mapping" with its single representation.
      eq('del/an emptied map is deleted, not left as {}', A.partSeqs, undefined);
      eq('del/a partly-used map keeps what is left', B.partSeqs, { 0: { all: 'keepme' } });
      delete A.partSeqs; delete B.partSeqs;
      savedSequences.length = 0;
    }

    // ---- A MAPPED PHRASE IS FITTED TO ITS CHORD, SO THE CHORD'S LENGTH IS
    //      PART OF WHAT IS INSTALLED ------------------------------------------
    // Field report: chord lengths [0.5, 1, 0.5, 2] bars, one phrase mapped to
    // the whole part, and the layer reported `loop 1.001` — the ½-bar fit —
    // while the 1-bar and 2-bar chords played. The install guard compared the
    // spec (name + slice + fit) and skipped as "already loaded", so the phrase
    // kept the first chord's fit and landed somewhere different at every change.
    {
      const mk = (n, bars) => ({ name: n, type: 'seq',
        steps: Array.from({ length: bars * 2 }, (_, i) => ({ freq: 220 + i, subdivision: 2, duration: 1 })) });
      savedSequences.length = 0;
      savedSequences.push(mk('phr', 1));

      const spec = _ambPsqSpec('phr');
      eq('fit/same chord length is the same install',
         _ambPsqSig(spec, 1) === _ambPsqSig(spec, 1), true);
      eq('fit/a DIFFERENT chord length is a different install',
         _ambPsqSig(spec, 0.5) === _ambPsqSig(spec, 2), false);
      eq('fit/no length still yields a signature', _ambPsqSig(spec) !== '', true);
      eq('fit/the name still leads the signature', _ambPsqSig(spec, 2).indexOf('phr#') === 0, true);
      // The anti-churn guard keys on the part BEFORE the length, so a re-fit is
      // told apart from a re-install of the same thing.
      eq('fit/the spec half is shared across lengths',
         _ambPsqSig(spec, 0.5).split('@')[0] === _ambPsqSig(spec, 2).split('@')[0], true);

      // …and the STEPS really do differ per chord length: a 1-bar phrase looped
      // into 2 bars is twice the steps, cut into ½ a bar is half.
      const half = _ambPartSeqStepsFor(spec, 0.5) || [];
      const one  = _ambPartSeqStepsFor(spec, 1) || [];
      const two  = _ambPartSeqStepsFor(spec, 2) || [];
      eq('fit/cut to half a bar', _ambSeqBars(half), 0.5);
      eq('fit/exact at one bar', _ambSeqBars(one), 1);
      eq('fit/looped to two bars', _ambSeqBars(two), 2);
      eq('fit/two bars is more steps than one', two.length > one.length, true);
      savedSequences.length = 0;
    }

    return checks;
  });

  const bad = res.filter(c => !c.ok);
  res.forEach(c => console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name));
  bad.forEach(c => {
    console.log('\n  ' + c.name);
    console.log('    got  ' + JSON.stringify(c.got));
    console.log('    want ' + JSON.stringify(c.want));
  });
  if (pageErrs.length) {
    console.log('\n  page errors:');
    pageErrs.slice(0, 5).forEach(e => console.log('    ' + e));
  }
  console.log('\nPARTSEQ: ' + (bad.length
    ? ('✗ ' + bad.length + ' of ' + res.length + ' checks failed')
    : ('✓ all ' + res.length + ' checks pass')));
  await browser.close();
  process.exit(bad.length || pageErrs.length ? 1 : 0);
})();
