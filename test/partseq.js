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
      // A width-only grid must NOT engage the clock — that is what makes the
      // migration safe to apply on its own.
      eq('migrate/clock untouched', _ambGridOn(c2), false);
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

    // ---- 4. A BLANK CELL PLAYS THE LAYER'S OWN PHRASE -----------------------
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

      // Verse pass 1 — blank — must hand the layer back its own phrase.
      _ambPartSeqSync(E, E._cfg, 4 * barSec + 0.05);
      eq('own/blank cell clears the mapping', !!(E.freeze[key] || {})._partSeqName, false);
      eq('own/blank cell restores the own phrase',
        ((E.freeze[key] || {}).events || []).length, 2);
      eq('own/restored phrase is the layer’s, not the bank’s',
        ((E.freeze[key] || {}).events || []).map(e => Math.round(e.freq)), [440, 550]);
    }
    {
      // A layer with NO phrase of its own was GENERATING; a blank cell must hand
      // it back to the emitter rather than leaving a stale loop frozen on it.
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
      eq('own/generating layer thaws on a blank cell',
        !!(E.freeze.bed && E.freeze.bed.frozen), false);
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
      const at = (pass, ci) => _ambPartSeqResolve(L, 0, pass, ci);
      eq('levels/chord+pass wins', at(2, 0), { name: 'lift', from: 'cell' });
      eq('levels/then the pass', at(1, 0), { name: 'riffB', from: 'pass' });
      eq('levels/then the part', at(0, 1), { name: 'riffA', from: 'all' });
      eq('levels/pass 3, other chord falls to the part', at(2, 1), { name: 'riffA', from: 'all' });
      // A part with NOTHING set falls all the way through to the layer's own.
      eq('levels/other part falls through', _ambPartSeqResolve(L, 1, 0, 0),
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
      // Verse = chords 0-1 (bars 0-2); pass 0 = bars 0-2, pass 1 = bars 4-6.
      const seen = [0, 1, 4, 5].map(bar => {
        const w = _ambPartChordAt(E, E._cfg, bar * barSec + 0.05);
        return w ? (w.pi + '/' + w.pass + '/' + w.ci) : '-';
      });
      eq('chord/where are we', seen, ['0/0/0', '0/0/1', '0/1/0', '0/1/1']);
      const nm = (bar) => _ambPartSeqNameAt(E, E._cfg, E._cfg.bed, bar * barSec + 0.05);
      eq('chord/only that chord on that pass',
        [nm(0), nm(1), nm(4), nm(5)], [null, null, null, 'riffB']);
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
      eq('adopt/blank pass returns the adopted phrase',
        ((E.freeze.bed || {}).events || []).map(e => Math.round(e.freq)), [330]);
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
      // The bank is listed, with the current value ticked.
      // NEWEST FIRST, matching the order the Sequences row lists them in.
      eq('picker/lists the bank', (seen[0] || []).slice(3), ['riffB', '✓ riffA']);

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
