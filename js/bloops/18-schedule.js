// ============================================================
// 18-schedule.js — ▦ SCHEDULE: who plays where, in one grid
// ============================================================
// One surface for "does this layer play here": it replaces the Scheduler's
// Coarse modal, the ▦ Passes grid, v1's per-card When and v2's Time ▸ Plays
// (decided 2026-09-16; mockup https://claude.ai/artifact/HFshERzuscLu43wnwNeCbZ).
//
// IT IS A VIEW, NOT A STORE. Every cell reads and writes an existing store
// through that store's own accessor in 17-ambient.js, so the Schedule cannot
// disagree with playback or with any other surface still standing:
//   layer cell, Plays      → chordMask.passes   (_ambChordPassGet/_ambChordPassSet)
//   layer cell, every pass → chordMask.steps    (_ambMaskStore / _ambMaskRead)
//   layer cell, Phrase     → partSeqs           (_ambPartSeqCellGet/_ambPartSeqCellSet)
//   chord row              → the part's pass grid (_ambPartGridSeq / _ambPassWrite)
//   cell widths            → per-pass lengths   (_ambPassBarsAt)
//   layer cell, Salt       → saltMask           (_ambMaskStore 'salt')
//   pass label             → passSalt, order, lengths (+ the typed-order modal)
//   round header / cells   → prog.arrGrid / L.iterGate
//
// ▦ Passes, Coarse, v1 When and v2 Plays are retired into this; every edit
// they made has a door here. ⚙ Fine is untouched.
//
// Loaded after 17-ambient.js, whose top-level functions and consts are
// globals; everything here is guarded with `typeof` so a missing helper
// degrades to "not drawn" rather than throwing into a caller's catch.
(function () {
  const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const has = (fn) => typeof fn === 'function';

  // TRANSIENT VIEW STATE on the host element — nothing about the music.
  function stOf(el) {
    if (!el._st) el._st = { view: 'part', part: 0, mode: 'plays', tool: 'on', chance: 50, level: 'cell', phrase: 'gen',
      rounds: 0, ref: 'round', open: '', passOpen: -1, units: 8, slice: { s: 0, l: 0, f: 'loop' } };
    return el._st;
  }

  function bankNames() {
    try {
      if (typeof savedSequences === 'undefined' || !Array.isArray(savedSequences)) return [];
      return savedSequences.map((s2, i) => (s2 && s2.name) || ('#' + (i + 1)));
    } catch (e) { return []; }
  }

  function chordName(E, cfg, abs) {
    try {
      const chs = cfg.prog.chords, ch = chs[abs];
      if (!ch) return '?';
      if (has(_ambIsTransition) && _ambIsTransition(ch)) return '⇝';
      const shift = has(_ambProgViewShift) ? _ambProgViewShift(E, cfg, chs) : 0;
      return (has(_ambChordShort) && has(_ambChordShift)) ? (_ambChordShort(_ambChordShift(ch, shift)) || '?') : '?';
    } catch (e) { return '?'; }
  }

  const fmtBars = (b) => {
    const n = Math.round(b * 1000) / 1000;
    const frac = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
    const w = Math.floor(n), f = Math.round((n - w) * 100) / 100;
    const s = (f && frac[f]) ? ((w ? w : '') + frac[f]) : String(n);
    return s + (n === 1 ? ' bar' : ' bars');
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  function render(E) {
    if (!E || !has(_ambGet)) return;
    const el = _ambGet(E, 'ambient-schedgrid'); if (!el) return;
    wire(E, el);
    const cfg = E.getCfg && E.getCfg(); if (!cfg) return;
    const st = stOf(el);
    const prog = cfg.prog;
    const progOn = !!(prog && prog.on && Array.isArray(prog.chords) && prog.chords.length);
    const ranges = (progOn && has(_ambGridRanges)) ? (_ambGridRanges(cfg) || []) : [];
    const rows = has(_ambChordMatrixRows) ? (_ambChordMatrixRows(cfg) || []) : [];
    if (st.part >= ranges.length) st.part = 0;
    const r = ranges[st.part];
    const bank = bankNames();
    const phone = (typeof window.matchMedia === 'function') && window.matchMedia('(max-width: 560px)').matches;

    // THE SIGNATURE — everything the markup reads, or an edit repaints nothing
    // (the documented `_sig` trap).
    let sig = '';
    try {
      sig = JSON.stringify([st, phone, !!E.timer, (el._temp || []).length, E._passLock ? [E._passLock.pi, E._passLock.pass] : 0, progOn, ranges, rows.map((x) => [x.key, x.label, x.L.chordMask || 0, x.L.partSeqs || 0]),
        bank, r ? [_ambPartPassCols(cfg, r.pi), JSON.stringify(has(_ambGridStore) ? _ambGridStore(cfg, r.pi, false) : 0)] : 0,
        rows.map((x) => [x.L.iterGate || 0, x.L.gateMode || '', x.L.unitGate || 0, x.L.when || '', x.L.write || 0, x.L.sectionMask || 0, x.L.saltMask || 0]),
        (Array.isArray(cfg.sections) ? cfg.sections.map((q) => q && q.name) : 0),
        (prog && prog.arrGrid) || 0, (prog && prog.chain) || 0,
        ranges.map((x) => (prog.parts && prog.parts[x.pi] && prog.parts[x.pi].plays) || 1), plotOK(),
        progOn ? prog.chords.map((c) => [c.root, c.bars, (c.intervals || []).join('.')]) : 0,
        progOn && has(_ambPartLabel) ? ranges.map((x) => _ambPartLabel(cfg, x.pi)) : 0, cfg.barsPerChord,
        r && has(_ambPassSaltStore) ? [_ambPassSaltStore(cfg, r.pi, false) || 0, (prog.parts && prog.parts[r.pi] && prog.parts[r.pi].salt) || 0, prog.salt || 0] : 0]);
    } catch (e) { sig = String(Math.random()); }
    if (el._sig === sig) return;
    el._sig = sig;

    let h = '';
    // VIEW + MODE. Across rounds is next; render it and DISABLE it with the
    // reason (a control that is absent cannot be found or asked about).
    h += '<div class="sch-head">' +
      '<div class="sch-view" role="tablist" aria-label="View">' +
        '<button type="button" class="sch-viewbtn' + (st.view === 'part' ? ' on' : '') + '" data-sch="view:part">By part</button>' +
        '<button type="button" class="sch-viewbtn' + (st.view === 'round' ? ' on' : '') + '" data-sch="view:round">Across rounds</button>' +
      '</div>' +
      // ⏺ TEMP — a live punch-in: while playing, a cell you tap changes for ONE
      // time through, then goes back (v1 When's Temp, on the Schedule's cells)
      '<button type="button" class="ambient-seg sch-temp' + (st.temp ? ' on' : '') + '" data-sch="temp" aria-pressed="' + (st.temp ? 'true' : 'false') + '"' +
        ' title="Temp \u2014 while playing, a Plays or round cell you tap changes for one time through, then goes back. Stopping puts every temp edit back.">\u23fa Temp' +
        ((el._temp && el._temp.length) ? ' <b class="sch-n">' + el._temp.length + '</b>' : '') + '</button>' +
      '<div class="ambient-seg-row sch-modes"' + (st.view === 'round' ? ' hidden' : '') + '>' +
        '<button type="button" class="ambient-seg' + (st.mode === 'plays' ? ' on' : '') + '" data-sch="mode:plays">Plays</button>' +
        '<button type="button" class="ambient-seg' + (st.mode === 'phrase' ? ' on' : '') + '" data-sch="mode:phrase">Phrase</button>' +
        '<button type="button" class="ambient-seg' + (st.mode === 'salt' ? ' on' : '') + '" data-sch="mode:salt" title="How much of the Salt (recolouring) each layer takes on each chord">Salt</button>' +
      '</div></div>';

    if (!progOn || !r) {
      el.innerHTML = h + (rows.length ? unitsHtml(E, cfg, st, rows) + optionsHtml(E, cfg, st, rows)
        : '<div class="ambient-hint sch-empty">No layers yet \u2014 add one and it gets a row here.</div>');
      return;
    }
    if (!rows.length) {
      el.innerHTML = h + '<div class="ambient-hint sch-empty">No layers yet — add one and it gets a row here.</div>';
      return;
    }

    if (st.view === 'round') { el.innerHTML = h + roundHtml(E, cfg, st, ranges, rows) + optionsHtml(E, cfg, st, rows); return; }

    // PART TABS
    h += '<div class="ambient-seg-row sch-tabs">' + ranges.map((x, k) =>
      '<button type="button" class="ambient-seg sch-tab' + (k === st.part ? ' on' : '') + '" data-sch="part:' + k + '"' +
        (has(_ambPartAttr) ? _ambPartAttr(x.pi) : '') + '>' + esc(has(_ambPartLabel) ? _ambPartLabel(cfg, x.pi) : ('Part ' + (x.pi + 1))) + '</button>').join('') + '</div>';

    // TAP SETS — what a tap paints, and how far it reaches
    h += '<div class="sch-brush"><span class="sch-lbl">Tap sets</span>';
    const tool = (id, lab, sw) => '<button type="button" class="ambient-seg sch-tool' + (st.tool === id ? ' on' : '') +
      '" data-sch="tool:' + id + '"><i class="sch-sw ' + sw + '"></i>' + lab + '</button>';
    if (st.mode === 'salt') {
      // SALT FOLLOW — per layer, per chord, the same on every pass (L.saltMask);
      // how MUCH salt a pass has is set on its label
      h += tool('on', 'Takes it', 'sw-on') + tool('off', 'Stays plain', 'sw-off') +
        '<span class="ambient-seg sch-tool sch-chance' + (st.tool === 'chance' ? ' on' : '') + '" data-sch="tool:chance" role="button" tabindex="0">' +
          '<i class="sch-sw sw-pct" style="--p:' + st.chance + '%"></i>Partly ' +
          '<input type="number" class="sch-chancein" inputmode="numeric" min="1" max="99" step="1" value="' + st.chance + '" aria-label="How much of the Salt, percent"><span class="sch-pc">%</span></span>' +
        '<span class="ambient-hint">on that chord, every pass</span>';
    } else if (st.mode === 'plays') {
      h += tool('on', 'Plays', 'sw-on') + tool('off', 'Silent', 'sw-off') +
        '<span class="ambient-seg sch-tool sch-chance' + (st.tool === 'chance' ? ' on' : '') + '" data-sch="tool:chance" role="button" tabindex="0">' +
          '<i class="sch-sw sw-pct" style="--p:' + st.chance + '%"></i>Chance ' +
          '<input type="number" class="sch-chancein" inputmode="numeric" min="1" max="99" step="1" value="' + st.chance + '" aria-label="Chance percent"><span class="sch-pc">%</span></span>' +
        tool('clear', 'Follow default', 'sw-clear');
      h += '<span class="sch-sep"></span><span class="sch-lbl">on</span>' +
        ['cell', 'every', 'layers'].map((lv) => '<button type="button" class="ambient-seg sch-level' + (st.level === lv ? ' on' : '') +
          '" data-sch="level:' + lv + '" title="' + esc({ cell: 'The one cell you tap — this layer, this chord, this pass',
            every: 'This layer on that chord on EVERY pass — the default a cell with no setting of its own follows',
            layers: 'Every layer on that chord on this pass' }[lv]) + '">' +
          ({ cell: 'This cell', every: 'Every pass', layers: 'All layers' }[lv]) + '</button>').join('');
    } else {
      if (st.tool !== 'on' && st.tool !== 'off' && st.tool !== 'chance') st.tool = 'on';
      const ph = (id, lab, cls) => '<button type="button" class="ambient-seg sch-tool' + (st.phrase === id ? ' on' : '') +
        '" data-sch="phrase:' + esc(id) + '"><i class="sch-sw ' + cls + '"></i>' + esc(lab) + '</button>';
      h += ph('gen', 'Generated', 'sw-gen') + bank.map((b) => ph(b, b, 'sw-ph')).join('') + ph('clear', 'Inherit', 'sw-clear');
      if (!bank.length) h += '<span class="ambient-hint">the Bank is empty — save a phrase to place it here</span>';
      // A SLICE — which bars of the phrase, and how it fits the chord (the
      // `{n, s, l, f}` spec; a whole phrase looped stores as its bare name)
      if (st.phrase !== 'gen' && st.phrase !== 'clear') {
        h += '<span class="sch-sep"></span><span class="sch-lbl">from bar</span>' +
          '<input type="number" class="sch-barsin" data-schslice="s" inputmode="numeric" min="1" max="65" step="1" value="' + ((st.slice.s | 0) + 1) + '" aria-label="First bar of the phrase">' +
          '<span class="sch-lbl">for</span>' +
          '<input type="number" class="sch-barsin" data-schslice="l" inputmode="numeric" min="0" max="64" step="1" value="' + (st.slice.l | 0) + '" aria-label="How many bars (0 = to the end)">' +
          '<span class="sch-lbl">bars</span>' +
          [['loop', 'Loop'], ['stretch', 'Stretch'], ['once', 'Once']].map(([v, lab]) =>
            '<button type="button" class="ambient-seg' + (st.slice.f === v ? ' on' : '') + '" data-sch="fitph:' + v + '" title="' +
            esc({ loop: 'Loop it to fill the chord', stretch: 'Stretch it to fit the chord', once: 'Play it once, then rest' }[v]) + '">' + lab + '</button>').join('') +
          '<span class="ambient-hint">0 bars = to the end</span>';
      }
      h += '<span class="sch-sep"></span><span class="sch-lbl">on</span>' +
        ['cell', 'pass', 'part'].map((lv) => '<button type="button" class="ambient-seg sch-level' + (st.level === lv ? ' on' : '') +
          '" data-sch="level:' + lv + '">' + ({ cell: 'This chord', pass: 'Whole pass', part: 'Whole part' }[lv]) + '</button>').join('');
    }
    h += '</div>';

    // PASSES — one block each; a chord's width is how long it lasts on THAT pass
    const cols = Math.max(1, _ambPartPassCols(cfg, r.pi));
    const bpc = Math.max(0.01, cfg.barsPerChord || 1);
    let total = 0;
    const passes = [];
    for (let c = 0; c < cols; c++) {
      const seq = has(_ambPartGridSeq) ? _ambPartGridSeq(cfg, r.pi, c, r.len) : Array.from({ length: r.len }, (_, i) => i);
      const cells = seq.map((k, q) => {
        let b = bpc;
        // `_ambPassBarsAt` answers {bars, own} — the length this position WILL
        // sound at on this pass, override or not
        try { const o = has(_ambPassBarsAt) ? _ambPassBarsAt(cfg, r.pi, c, q, seq) : null; if (o && o.bars > 0) b = o.bars; } catch (e) {}
        if (!(b > 0)) { const ch = prog.chords[r.from + k]; b = (ch && ch.bars > 0) ? ch.bars : bpc; }
        return { k, b, in: true };
      });
      // DROPPED chords stay on the row, dimmed, so putting one back is a tap
      for (let k = 0; k < r.len; k++) {
        if (seq.indexOf(k) < 0) { const ch = prog.chords[r.from + k]; cells.push({ k, b: (ch && ch.bars > 0) ? ch.bars : bpc, in: false }); }
      }
      passes.push({ c, cells });
      if (c === 0) total = cells.filter((x) => x.in).reduce((n, x) => n + x.b, 0);
    }
    h += '<div class="ambient-hint sch-cap">' + esc((has(_ambPartLabel) ? _ambPartLabel(cfg, r.pi) : 'Part') + ' · ' +
      r.len + ' change' + (r.len === 1 ? '' : 's') + ' · ' + cols + ' pass' + (cols === 1 ? '' : 'es') +
      ' · widths follow each change’s length on that pass') + '</div>';

    // THE PART'S PASSES — how many, and whether its cadence is a template
    const gst = has(_ambGridStore) ? _ambGridStore(cfg, r.pi, false) : null;
    const fit = !!(gst && gst.fit);
    h += '<div class="sch-brush sch-passbar"><span class="sch-lbl">Passes</span>' +
      '<button type="button" class="ambient-seg" data-sch="cols:-1" aria-label="Fewer passes"' + (cols <= 1 ? ' disabled' : '') + '>\u2212</button>' +
      '<b class="sch-n">' + cols + '</b>' +
      '<button type="button" class="ambient-seg" data-sch="cols:1" aria-label="More passes">+</button>' +
      '<span class="ambient-hint">each pass is one time through this part; it runs them all before the next part</span>' +
      '<span class="sch-sep"></span>' +
      '<button type="button" class="ambient-seg' + (fit ? ' on' : '') + '" data-sch="fit" title="' + esc(fit
        ? 'On \u2014 the written cadence is a rhythm the chords fill, so dropping one shifts the rest into the gap'
        : 'Off \u2014 each chord keeps its own length, so dropping one makes the pass shorter') + '">\u21e5 Fill cadence</button>' +
      // ↻ HOLD PASS — repeat the pass that is playing so an edit is heard next time round
      (has(_ambPassHoldBtnHtml) ? String(_ambPassHoldBtnHtml(E)).replace('data-pmx="hold"', 'data-sch="hold"') : '') +
      '</div>';
    h += '<div class="sch-passes">';
    passes.forEach((P) => {
      h += '<div class="sch-pass" data-schpass="' + P.c + '"><button type="button" class="sch-passlab' + (st.passOpen === P.c ? ' on' : '') + '" data-sch="pass:' + P.c + '"' +
        ' title="Pass ' + (P.c + 1) + ' \u2014 its Salt, its chord lengths and their order">Pass ' + (P.c + 1) +
        saltFace(cfg, r.pi, P.c) + ' \u25be</button>' + (st.passOpen === P.c ? passPanelHtml(E, cfg, r, P) : '') +
        '';
      // ONE CHORD BUTTON and ONE CELL, drawn in either orientation — `size` is
      // the change's length as a flex width (across) or a row height (down)
      const chordBtn = (x, size) =>
        '<button type="button" class="sch-chord' + (x.in ? '' : ' dropped') + '" style="' + size + '" data-sch="chord:' + P.c + ':' + x.k + '"' +
          (has(_ambPartAttr) ? _ambPartAttr(r.pi) : '') +
          ' title="' + esc(chordName(E, cfg, r.from + x.k) + ' \u00b7 ' + fmtBars(x.b) + ' \u2014 ' +
            (x.in ? 'tap to drop it from this pass' : 'dropped from this pass \u2014 tap to put it back')) + '">' +
          '<b>' + esc(chordName(E, cfg, r.from + x.k)) + '</b><span>' + (x.in ? esc(fmtBars(x.b)) : 'dropped') + '</span></button>';
      const cellBtn = (row, x, size) => {
        const L = row.L, abs = r.from + x.k;
        const attrs = ' data-sch="cell:' + esc(row.key) + ':' + P.c + ':' + x.k + '"' + (has(_ambPartAttr) ? _ambPartAttr(r.pi) : '');
        const where = row.label + ' \u00b7 ' + chordName(E, cfg, abs) + ' \u00b7 pass ' + (P.c + 1);
        if (!x.in) return '<button type="button" class="sch-cell na" style="' + size + '"' + attrs + ' disabled title="' + esc(where + ' \u2014 this chord is dropped from the pass') + '"></button>';
        if (st.mode === 'salt') {
          const fv = has(_ambMaskRead) ? _ambMaskRead(L, 'salt', abs) : 100;
          return '<button type="button" class="sch-cell ' + (fv >= 100 ? 'on' : fv <= 0 ? 'off' : 'pct') + '" style="' + size + ';--p:' + fv + '%"' + attrs +
            ' title="' + esc(row.label + ' \u00b7 ' + chordName(E, cfg, abs) + ' \u2014 ' + (fv >= 100 ? 'takes the Salt' : fv <= 0 ? 'stays plain' : ('takes ' + fv + '% of the Salt')) + ' (every pass)') + '">' +
            (fv >= 100 ? '' : (fv <= 0 ? 'plain' : (fv + '%'))) + '</button>';
        }
        if (st.mode === 'phrase') {
          const res = has(_ambPartSeqResolve) ? _ambPartSeqResolve(L, r.pi, P.c, x.k) : { name: '', from: '' };
          const inh = res.from && res.from !== 'cell';
          const face = res.gen ? '\u26a1 gen' : ((res.spec && has(_ambPsqLabel)) ? _ambPsqLabel(res.spec) : (res.name || 'generated'));
          const cls = (res.name || res.gen) ? 'ph' : 'phgen';
          return '<button type="button" class="sch-cell ' + cls + (inh ? ' inh' : '') + '" style="' + size + '"' + attrs +
            ' title="' + esc(where + ' \u2014 ' + (res.name ? ('plays ' + res.name) : 'plays its own generated part') +
              (inh ? (' (set on the whole ' + res.from + ')') : '')) + '">' + (inh ? '\u21b3 ' : '') + esc(face) + '</button>';
        }
        const own = has(_ambChordPassGet) ? _ambChordPassGet(L, P.c, abs) : null;
        const dflt = has(_ambMaskRead) ? _ambMaskRead(L, 'chord', abs) : 100;
        const v = (own == null) ? dflt : own;
        const cls = v >= 100 ? 'on' : (v <= 0 ? 'off' : 'pct');
        return '<button type="button" class="sch-cell ' + cls + (own == null ? ' inh' : '') + '" style="' + size + ';--p:' + v + '%"' + attrs +
          ' title="' + esc(where + ' \u2014 ' + (v >= 100 ? 'plays' : v <= 0 ? 'silent' : (v + '% chance')) +
            (own == null ? ' (the chord\u2019s default for every pass)' : '')) + '">' +
          (v >= 100 ? '' : (v <= 0 ? 'off' : (v + '%'))) + '</button>';
      };
      if (phone) {
        // PHONE: THE GRID TURNS — chords run DOWN (a row's height follows the
        // change's length, never under a 44px target), layers run ACROSS
        h += '<div class="sch-vgrid" style="--nl:' + rows.length + '"><span></span>' +
          rows.map((row) => rowLabHtml(row, st)).join('');
        P.cells.forEach((x) => {
          const hp = 'height:' + Math.max(44, Math.round(x.b * 40)) + 'px';
          h += chordBtn(x, hp) + rows.map((row) => cellBtn(row, x, hp)).join('');
        });
        h += '</div></div>';
      } else {
        h += '<div class="sch-grid"><div class="sch-rowlab sch-arr">Chords</div><div class="sch-lane">' +
          P.cells.map((x) => chordBtn(x, 'flex:' + x.b)).join('') + '</div>';
        rows.forEach((row) => {
          h += rowLabHtml(row, st) + '<div class="sch-lane">' + P.cells.map((x) => cellBtn(row, x, 'flex:' + x.b)).join('') + '</div>';
        });
        h += '</div></div>';
      }
    });
    h += '</div>';
    h += '<div class="ambient-hint sch-foot">' + (st.mode === 'salt'
      ? 'How much of each pass\u2019s Salt this layer takes on each chord \u2014 the same on every pass. Set a pass\u2019s Salt on its label.'
      : st.mode === 'plays'
      ? 'Dashed cells follow the chord’s default for every pass. <b>Plays</b>, <b>Silent</b> and <b>Chance</b> give a cell its own; tapping a cell that already has it puts it back.'
      : '<b>↳</b> is inherited from the whole pass or the whole part. <b>Generated</b> is the layer’s own part, made by its rules.') +
      ' Tap a layer’s name for its options.</div>';
    el.innerHTML = h + optionsHtml(E, cfg, st, rows);
  }

  // ── NO CHORD CHANGES: UNITS ───────────────────────────────────────────────
  // Without a progression there are no chords or passes to schedule against,
  // so a cell is one of the layer's own UNITS (its cycle, the block the
  // Scheduler lane draws) — the Coarse modal's fallback, on the same store:
  // `unitGate`, a unit OFF = every slice of it off, repeating every N units.
  function unitsHtml(E, cfg, st, rows) {
    const N = Math.max(2, Math.min(32, st.units | 0));
    let h = '<div class="sch-brush"><span class="sch-lbl">Pattern of</span>' +
      '<button type="button" class="ambient-seg" data-sch="units:-1" aria-label="Fewer">\u2212</button><b class="sch-n">' + N + '</b>' +
      '<button type="button" class="ambient-seg" data-sch="units:1" aria-label="More">+</button>' +
      '<span class="ambient-hint">units, then it repeats</span>' +
      '<span class="sch-sep"></span><span class="sch-lbl">Tap sets</span>' +
      '<button type="button" class="ambient-seg sch-tool' + (st.tool !== 'off' ? ' on' : '') + '" data-sch="tool:on"><i class="sch-sw sw-on"></i>Plays</button>' +
      '<button type="button" class="ambient-seg sch-tool' + (st.tool === 'off' ? ' on' : '') + '" data-sch="tool:off"><i class="sch-sw sw-off"></i>Silent</button></div>' +
      '<div class="ambient-hint sch-cap">No chord changes here, so a cell is one of the layer\u2019s own units (its cycle). Turn on a progression to schedule per chord and per pass.</div>' +
      '<div class="sch-rgrid" style="--n:' + N + '">';
    rows.forEach((row) => {
      h += rowLabHtml(row, st) + '<div class="sch-rounds">';
      for (let u = 0; u < N; u++) {
        const off = has(_ambUnitWholeOff) ? _ambUnitWholeOff(row.L, u) : false;
        h += '<button type="button" class="sch-cell ' + (off ? 'off' : 'on') + '" data-sch="unit:' + esc(row.key) + ':' + u + '"' +
          ' title="' + esc(row.label + ' \u00b7 unit ' + (u + 1) + ' \u2014 ' + (off ? 'silent' : 'plays')) + '">' + (u + 1) + '</button>';
      }
      h += '</div>';
    });
    return h + '</div>';
  }
  function paintUnit(E, el, cfg, key, u) {
    const st = stOf(el);
    const L = has(_ambLayerByKey) ? _ambLayerByKey(E, key) : null; if (!L) return;
    const N = Math.max(2, Math.min(32, st.units | 0));
    const old = (L.unitGate && typeof L.unitGate === 'object') ? L.unitGate : null;
    const div = old ? Math.max(2, old.div | 0) : 2;
    // every unit carries what it plays today (a per-unit slot, else the shared
    // slice mask, else fully on) before the tapped one changes
    const slots = {};
    for (let i = 0; i < N; i++) {
      const own = old && old.slots && old.slots[String(i % Math.max(1, old.period | 0 || 1))];
      slots[String(i)] = Array.isArray(own) ? own.slice(0, div) : Array.from({ length: div }, () => 1);
    }
    const wantOff = st.tool === 'off';
    const isOff = !slots[String(u)].some((v) => v);
    const off = wantOff ? !isOff : false;
    slots[String(u)] = Array.from({ length: div }, () => (off ? 0 : 1));
    if (!wantOff && isOff) slots[String(u)] = Array.from({ length: div }, () => 1);
    L.unitGate = { div, period: N, slots, mode: (old && old.mode) || 'skip' };
    if (has(_ambNormalizeUnitGate)) { try { _ambNormalizeUnitGate(L); } catch (e) {} }
    try { if (has(_ambUnitGateBump)) _ambUnitGateBump(); } catch (e) {}
    commit(E, key);
  }

  // ── A PASS ────────────────────────────────────────────────────────────────
  // Salt at the PASS rung (colours · scatter — length is not set per pass, the
  // store's own rule), each chord's length on this pass, and their order.
  function saltFace(cfg, pi, c) {
    const stq = has(_ambPassSaltStore) ? _ambPassSaltStore(cfg, pi, false) : null;
    const v = stq && stq[String(c)];
    if (!v) return '';
    return (v.colors | 0) || (v.scatter | 0)
      ? ' <span class="sch-salt">salt ' + (v.colors | 0) + '\u00b7' + (v.scatter | 0) + '</span>'
      : ' <span class="sch-salt">no salt</span>';
  }
  function passPanelHtml(E, cfg, r, P) {
    const stq = has(_ambPassSaltStore) ? _ambPassSaltStore(cfg, r.pi, false) : null;
    const own = stq && stq[String(P.c)];
    let inh = { salt: null, from: '' };
    try { if (has(_ambPassSaltInherited)) inh = _ambPassSaltInherited(cfg, r.pi, cfg.prog.parts); } catch (e) {}
    const v = own || inh.salt || { colors: 0, scatter: 0 };
    let h = '<div class="sch-opts sch-passpanel">';
    h += '<div class="sch-optrow"><span class="sch-lbl">Salt on this pass</span>' +
      '<span class="sch-lbl">colours</span><button type="button" class="ambient-seg" data-sch="salt:' + P.c + ':colors:-1">\u2212</button>' +
      '<b class="sch-n">' + (v.colors | 0) + '</b><button type="button" class="ambient-seg" data-sch="salt:' + P.c + ':colors:1">+</button>' +
      '<span class="sch-lbl">scatter</span><button type="button" class="ambient-seg" data-sch="salt:' + P.c + ':scatter:-10">\u2212</button>' +
      '<b class="sch-n">' + (v.scatter | 0) + '</b><button type="button" class="ambient-seg" data-sch="salt:' + P.c + ':scatter:10">+</button>' +
      (own ? '<button type="button" class="ambient-seg" data-sch="saltclear:' + P.c + '">Follow ' + esc(inh.from || 'the area') + '</button>'
           : '<span class="ambient-hint">following ' + esc(inh.from || 'nothing \u2014 no salt') + '</span>') + '</div>';
    const played = P.cells.filter((x) => x.in);
    h += '<div class="sch-optrow sch-lens"><span class="sch-lbl">Order &amp; lengths</span>' + played.map((x, q) => {
      const o = has(_ambPassBarsAt) ? _ambPassBarsAt(cfg, r.pi, P.c, q, played.map((y) => y.k)) : null;
      return '<span class="sch-lenitem">' +
        '<button type="button" class="ambient-seg" data-sch="move:' + P.c + ':' + q + ':-1"' + (q === 0 ? ' disabled' : '') + ' aria-label="Earlier">\u25c0</button>' +
        '<b>' + esc(chordName(E, cfg, r.from + x.k)) + '</b>' +
        '<input type="number" class="sch-barsin" inputmode="decimal" min="0.25" max="8" step="0.25" value="' + ((o && o.own) ? o.bars : '') + '"' +
          ' placeholder="' + (o ? o.bars : '') + '" data-schbars="' + P.c + ':' + q + '" aria-label="' + esc(chordName(E, cfg, r.from + x.k)) + ' length in bars on this pass">' +
        '<button type="button" class="ambient-seg" data-sch="move:' + P.c + ':' + q + ':1"' + (q === played.length - 1 ? ' disabled' : '') + ' aria-label="Later">\u25b6</button>' +
        '</span>';
    }).join('') + '<span class="ambient-hint">bars \u2014 blank uses the chord\u2019s own length</span>' +
      // A CHORD MORE THAN ONCE in a pass is an order the ◀▶ swaps cannot make
      '<button type="button" class="ambient-seg" data-sch="seqmodal:' + P.c + '" title="Type this pass\u2019s order \u2014 a chord can play more than once">\u270e Order &amp; repeats</button></div>';
    return h + '</div>';
  }
  function partEdit(E, fn) {
    const cfg = E.getCfg(); if (!cfg) return;
    fn(cfg);
    try { if (has(_ambRenderProgOverview)) _ambRenderProgOverview(E); } catch (e) {}
    commit(E, null);
  }

  // ── A LAYER'S OPTIONS ─────────────────────────────────────────────────────
  // Tap a layer's name. Everything here is per LAYER rather than per cell:
  //   when a cell is off  → L.gateMode ('mute' | absent = skip)
  //   slices of each unit → L.unitGate {div, period: 1, slots: {0: mask}, mode}
  //   plays               → L.when ('always' | 'sec:<name>' | '1st')
  //   evolve              → L.write {on, lock} (the Scheduler's own three-way)
  // A When pattern or a per-unit gate from the OLD surfaces keeps playing; it is
  // shown read-only with Clear rather than silently rewritten.
  function rowLabHtml(row, st, note) {
    return '<button type="button" class="sch-rowlab' + (st.open === row.key ? ' on' : '') + '" data-sch="opt:' + esc(row.key) + '"' +
      ' title="' + esc(row.label + ' \u2014 options') + '"><b>' + esc(row.label) + '</b>' +
      (row.L.gateMode === 'mute' ? '<span class="sch-note sch-mute">mute</span>' : '') +
      (note ? '<span class="sch-note">' + esc(note) + '</span>' : '') + '</button>';
  }
  function optionsHtml(E, cfg, st, rows) {
    const row = rows.find((x) => x.key === st.open); if (!row) return '';
    const L = row.L, k = esc(row.key);
    const btn = (on, act, lab, title, dis) => '<button type="button" class="ambient-seg' + (on ? ' on' : '') + '" data-sch="' + act + ':' + k + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + (dis ? ' disabled' : '') + '>' + lab + '</button>';
    let h = '<div class="sch-opts" role="group" aria-label="' + esc(row.label) + ' options">' +
      '<div class="sch-optshead"><b>' + esc(row.label) + '</b><button type="button" class="ambient-seg" data-sch="opt:' + k + '" aria-label="Close">\u2715</button></div>';
    const mute = L.gateMode === 'mute';
    h += '<div class="sch-optrow"><span class="sch-lbl">When a cell is off</span>' +
      btn(!mute, 'gm:skip', 'Skip', 'The notes there are never made \u2014 nothing is captured, nothing sounds') +
      btn(mute, 'gm:mute', 'Mute', 'The notes are made, then silenced \u2014 works on a frozen loop') + '</div>';
    const ug = L.unitGate;
    const legacy = !!(ug && ((ug.period | 0) > 1 || Object.keys(ug.slots || {}).some((q) => q !== '0')));
    const div = ug ? Math.max(2, ug.div | 0) : 4;
    const mask = (ug && !legacy && Array.isArray((ug.slots || {})['0'])) ? ug.slots['0'] : Array.from({ length: div }, () => 1);
    h += '<div class="sch-optrow"><span class="sch-lbl">Slices of each unit</span>';
    if (legacy) {
      h += '<span class="ambient-hint">a per-unit pattern from the old Scheduler is playing</span>' + btn(false, 'ugclear', 'Clear');
    } else {
      h += '<button type="button" class="ambient-seg" data-sch="ugdiv:' + k + ':-1" aria-label="Fewer slices">\u2212</button><b class="sch-n">' + div + '</b>' +
        '<button type="button" class="ambient-seg" data-sch="ugdiv:' + k + ':1" aria-label="More slices">+</button>' +
        '<span class="sch-slices">' + mask.map((v, i) => '<button type="button" class="sch-slice' + (v ? ' on' : '') + '" data-sch="ugslice:' + k + ':' + i + '" aria-label="Slice ' + (i + 1) + (v ? ' plays' : ' silent') + '"></button>').join('') + '</span>' +
        btn((ug && ug.mode) !== 'chop', 'ugmode:skip', 'Ring out', 'A note already sounding rings across an off slice') +
        btn((ug && ug.mode) === 'chop', 'ugmode:chop', 'Chop', 'The layer\u2019s output is cut across an off slice \u2014 a hard gate');
    }
    h += '</div>';
    const w = (typeof L.when === 'string') ? L.when : 'always';
    const secNm = has(_ambWhenSecName) ? _ambWhenSecName(w) : null;
    const secs = Array.isArray(cfg.sections) ? cfg.sections.filter((q) => q && q.name) : [];
    const pattern = /^[01]+$/.test(w) || /^\d+$/.test(w) || /^\d+:\d+$/.test(w);
    h += '<div class="sch-optrow"><span class="sch-lbl">Plays</span>' +
      btn(w === 'always' || w === '', 'when:always', 'Anywhere') +
      '<select class="ambient-select sch-secsel" data-schsec="' + k + '"' + (secs.length ? '' : ' disabled title="No sections in this area yet"') + '>' +
        '<option value="">Only in section\u2026</option>' +
        secs.map((q) => '<option value="' + esc(q.name) + '"' + (secNm === q.name ? ' selected' : '') + '>' + esc(q.name) + '</option>').join('') +
      '</select>' +
      btn(w === '1st', 'when:1st', 'First round only', 'Plays the first time through, then stays silent') +
      (pattern ? ('<span class="ambient-hint">an every-cycle pattern (' + esc(w) + ') from the old When is playing</span>' + btn(false, 'when:always', 'Clear')) : '') +
      '</div>';
    // HOW MUCH OF EACH CHORD — a duration, not a chance (chordMask.part)
    const cp = (L.chordMask && L.chordMask.part) || null;
    const wsz = cp ? (cp.size | 0) : 100, wpl = cp ? (cp.place || 'start') : 'start';
    h += '<div class="sch-optrow"><span class="sch-lbl">Of each chord it plays</span>' +
      [[100, 'All'], [75, '\u00be'], [50, '\u00bd'], [25, '\u00bc']].map(([v, lab]) => btn(wsz === v, 'win:' + v, lab)).join('') +
      '<span class="sch-sep"></span>' +
      [['start', 'Start'], ['center', 'Middle'], ['end', 'End'], ['random', 'Random']].map(([v, lab]) =>
        btn(wpl === v, 'place:' + v, lab, v === 'random' ? 'A different window on every chord' : '', wsz >= 100)).join('') + '</div>';
    // PER SECTION — how often this layer plays in each section (sectionMask)
    const secs2 = Array.isArray(cfg.sections) ? cfg.sections : [];
    if (secs2.length) {
      h += '<div class="sch-optrow"><span class="sch-lbl">In each section</span>' + secs2.map((q, i) => {
        const pv = has(_ambMaskRead) ? _ambMaskRead(L, 'section', i) : 100;
        return '<button type="button" class="sch-cell sch-seccell ' + (pv >= 100 ? 'on' : pv <= 0 ? 'off' : 'pct') + '" style="--p:' + pv + '%"' +
          ' data-sch="sec:' + i + ':' + k + '" title="' + esc(((q && q.name) || ('Section ' + (i + 1))) + ' \u2014 ' +
            (pv >= 100 ? 'plays' : pv <= 0 ? 'silent' : pv + '% chance') + '. Tap to paint with Tap sets.') + '">' +
          esc((q && q.name) || ('S' + (i + 1))) + (pv > 0 && pv < 100 ? ' ' + pv + '%' : '') + '</button>';
      }).join('') + '</div>';
    }
    const wr = L.write || {};
    const ev = wr.lock ? 'lock' : (wr.on ? 'every' : 'cont');
    const na = has(_ambEvolveInertWhy) ? _ambEvolveInertWhy(L) : null;
    h += '<div class="sch-optrow"><span class="sch-lbl">Evolve</span>' +
      btn(ev === 'cont', 'ev:cont', '\u21bb Re-roll', 'Fresh material every cycle', !!na) +
      btn(ev === 'every', 'ev:every', '\u27f3 Loop', 'Freeze a pattern, repeat it, then evolve a fresh one', !!na) +
      btn(ev === 'lock', 'ev:lock', '\ud83d\udd12 Hold', 'Freeze one roll and keep it forever', !!na) +
      (na ? '<span class="ambient-hint">doesn\u2019t apply here \u2014 ' + esc(na) + '</span>' : '') + '</div>';
    return h + '</div>';
  }
  function layerCommit(E, key, how) {
    try { if (how === 'reanchor' && E.timer && has(_ambReanchorLayer)) _ambReanchorLayer(E, key); } catch (e) {}
    try { if (how === 'gate' && has(_ambUnitGateBump)) _ambUnitGateBump(); } catch (e) {}
    try { if (how === 'loop' && has(_ambLoopSyncAll)) _ambLoopSyncAll(E); } catch (e) {}
    commit(E, key);
  }
  function applyOption(E, el, cfg, act, key, arg) {
    const L = has(_ambLayerByKey) ? _ambLayerByKey(E, key) : null; if (!L) return;
    if (act === 'gm') { if (arg === 'mute') L.gateMode = 'mute'; else delete L.gateMode; layerCommit(E, key, 'reanchor'); return; }
    if (act === 'when') { L.when = arg; layerCommit(E, key, 'reanchor'); return; }
    if (act === 'ev') {
      if (!L.write || typeof L.write !== 'object') L.write = { on: true, bars: 2, times: 4 };
      if (arg === 'cont') { L.write.on = false; delete L.write.lock; }
      else if (arg === 'every') { L.write.on = true; delete L.write.lock; }
      else { L.write.on = true; L.write.lock = true; }
      try { if (E.timer && has(_ambReanchorLayer)) _ambReanchorLayer(E, key); } catch (e) {}
      layerCommit(E, key, 'loop'); return;
    }
    if (act === 'ugclear') { delete L.unitGate; layerCommit(E, key, 'gate'); return; }
    if (act === 'win' || act === 'place') {
      const cm = (L.chordMask && typeof L.chordMask === 'object') ? L.chordMask : (L.chordMask = {});
      const cur = cm.part || { size: 100, place: 'start' };
      if (act === 'win') cur.size = arg | 0; else cur.place = arg;
      if ((cur.size | 0) >= 100) delete cm.part; else cm.part = { size: cur.size | 0, place: cur.place || 'start' };
      if (has(_ambNormalizeChordMask)) { try { _ambNormalizeChordMask(L); } catch (e) {} }
      layerCommit(E, key, 'reanchor'); return;
    }
    if (act === 'sec') {
      const st = stOf(el);
      const want = st.tool === 'off' ? 0 : st.tool === 'chance' ? st.chance : 100;
      const m = _ambMaskStore(cfg, L, 'section');
      const i = arg | 0, cur = Number.isFinite(m.steps[i]) ? m.steps[i] : 100;
      m.steps[i] = (cur === want) ? 100 : want;
      layerCommit(E, key, 'reanchor'); return;
    }
    const ug = (L.unitGate && typeof L.unitGate === 'object') ? L.unitGate : { div: 4, period: 1, slots: {} };
    const div = Math.max(2, (ug.div | 0) || 4);
    let mask = (ug.slots && Array.isArray(ug.slots['0'])) ? ug.slots['0'].slice() : Array.from({ length: div }, () => 1);
    if (act === 'ugdiv') {
      const nd = Math.max(2, Math.min(16, div + (arg | 0)));
      mask = Array.from({ length: nd }, (_, i) => mask[Math.floor(i * mask.length / nd)] ? 1 : 0);
      ug.div = nd;
    } else if (act === 'ugslice') {
      const i = arg | 0; if (i < mask.length) mask[i] = mask[i] ? 0 : 1;
      ug.div = mask.length;
    } else if (act === 'ugmode') {
      ug.mode = arg === 'chop' ? 'chop' : 'skip';
    }
    ug.period = 1; ug.slots = { 0: mask };
    L.unitGate = ug;
    layerCommit(E, key, 'gate');
  }

  // ── ACROSS ROUNDS ─────────────────────────────────────────────────────────
  // A ROUND is one trip through the arrangement (a PLOT, when 2+ areas run in
  // sequence, is one trip through the area sequence). Two stores meet here:
  //   the header — which parts play in that round, in order → prog.arrGrid
  //     (`_ambArrGridSeq` gives one entry per PASS, so a run of one part is a
  //     chip and its length is the number of passes that visit plays)
  //   a layer row — does this layer play that round → L.iterGate {len, steps, ref}
  // The grid shows N rounds and repeats; N is a VIEW length, and a painted
  // layer's pattern is resized to N (the Coarse modal's own rule).
  function plotOK() {
    try {
      const s2 = (typeof _masterBloomState === 'function') ? _masterBloomState() : null;
      return !!(s2 && Array.isArray(s2.areas) && s2.areas.length >= 2 && s2.orch && s2.orch.mode === 'sequence');
    } catch (e) { return false; }
  }
  const MAXR = (typeof _AMB_ITER_MAXLEN === 'number') ? _AMB_ITER_MAXLEN : 32;
  function roundsOf(cfg, st, rows) {
    if (st.rounds > 0) return st.rounds;
    let n = has(_ambArrCols) ? _ambArrCols(cfg) : 1;
    rows.forEach((x) => { const g = x.L.iterGate; if (g && Array.isArray(g.steps)) n = Math.max(n, g.steps.length); });
    return Math.max(1, Math.min(MAXR, n > 1 ? n : 4));
  }
  function runsOf(seq) {
    const out = [];
    seq.forEach((v, i) => { const last = out[out.length - 1]; if (last && last.k === v) last.n++; else out.push({ k: v, n: 1, at: i }); });
    return out;
  }
  function roundHtml(E, cfg, st, ranges, rows) {
    if (st.ref === 'plot' && !plotOK()) st.ref = 'round';
    const N = roundsOf(cfg, st, rows);
    const refWord = st.ref === 'plot' ? 'plot' : 'round';
    let h = '<div class="sch-brush">' +
      '<span class="sch-lbl">Pattern of</span>' +
      '<button type="button" class="ambient-seg" data-sch="rounds:-1" aria-label="Fewer">\u2212</button>' +
      '<b class="sch-n">' + N + '</b>' +
      '<button type="button" class="ambient-seg" data-sch="rounds:1" aria-label="More">+</button>' +
      '<span class="ambient-hint">' + refWord + 's, then it repeats</span>' +
      '<span class="sch-sep"></span><span class="sch-lbl">A cell is one</span>' +
      '<button type="button" class="ambient-seg' + (st.ref === 'round' ? ' on' : '') + '" data-sch="ref:round" title="One trip through this area\u2019s arrangement">round</button>' +
      '<button type="button" class="ambient-seg' + (st.ref === 'plot' ? ' on' : '') + '" data-sch="ref:plot"' +
        (plotOK() ? ' title="One trip through the whole AREA sequence"' : ' disabled title="Plots need 2 or more areas playing in sequence"') + '>plot</button>' +
      '<span class="sch-sep"></span><span class="sch-lbl">Tap sets</span>' +
      '<button type="button" class="ambient-seg sch-tool' + (st.tool !== 'off' ? ' on' : '') + '" data-sch="tool:on"><i class="sch-sw sw-on"></i>Plays</button>' +
      '<button type="button" class="ambient-seg sch-tool' + (st.tool === 'off' ? ' on' : '') + '" data-sch="tool:off"><i class="sch-sw sw-off"></i>Silent</button>' +
      '</div>';
    const names = ranges.map((x) => has(_ambPartLabel) ? _ambPartLabel(cfg, x.pi) : ('Part ' + (x.pi + 1)));
    const orderTxt = (seq) => runsOf(seq).map((u) => names[u.k] + ' \u00d7' + u.n).join(' \u2192 ');
    h += '<div class="ambient-hint sch-cap">' + (st.ref === 'plot'
      ? 'A cell is one trip through the whole area sequence \u2014 the song keeps going and this pattern of ' + N + ' repeats.'
      : ('A round is one trip through the arrangement: ' + esc(orderTxt(has(_ambArrGridSeq) ? _ambArrGridSeq(cfg, 0, ranges.length, ranges) : [])) +
         '. The song keeps going; this pattern of ' + N + ' rounds repeats. Tap a part chip to take that visit out; \uff0b adds one.')) + '</div>';
    h += '<div class="sch-rgrid" style="--n:' + N + '">';
    // THE ARRANGEMENT ROW — rounds only; a plot is the area sequence, not this area's parts
    if (st.ref === 'round' && has(_ambArrGridSeq)) {
      h += '<div class="sch-rowlab sch-arr">Parts</div><div class="sch-rounds">';
      for (let r = 0; r < N; r++) {
        const seq = _ambArrGridSeq(cfg, r, ranges.length, ranges);
        const bars = (k) => { try { return Math.max(0.25, +_ambLenPartBars(cfg, ranges[k].pi) || 1); } catch (e) { return 1; } };
        h += '<div class="sch-round" data-schround="' + r + '" title="' + esc('Round ' + (r + 1) + ': ' + orderTxt(seq)) + '">' +
          runsOf(seq).map((u) => '<button type="button" class="sch-visit" style="flex:' + (u.n * bars(u.k)) + '" data-sch="visit:' + r + ':' + u.at + ':' + u.n + '"' +
            (has(_ambPartAttr) ? _ambPartAttr(ranges[u.k].pi) : '') + ' title="' + esc(names[u.k] + ' \u00d7' + u.n + ' \u2014 tap to take this visit out of round ' + (r + 1)) + '">' + u.n + '</button>').join('') +
          '<select class="ambient-select sch-addvisit" data-schadd="' + r + '" aria-label="Add a part to round ' + (r + 1) + '">' +
            '<option value="">\uff0b</option>' + names.map((nm, k) => '<option value="' + k + '">' + esc(nm) + '</option>').join('') +
          '</select>' +
          '<button type="button" class="ambient-seg sch-addvisit" data-sch="mseqmodal:' + r + '" aria-label="Set the order of round ' + (r + 1) + '" title="Set this round\u2019s order">\u270e</button></div>';
      }
      h += '</div>';
    }
    rows.forEach((row) => {
      const g = row.L.iterGate;
      const gOk = !!(g && Array.isArray(g.steps) && g.steps.length);
      const other = gOk && (g.ref || 'round') !== st.ref;
      h += rowLabHtml(row, st, other ? ('counts ' + (g.ref || 'round') + 's') : '') + '<div class="sch-rounds">';
      for (let r = 0; r < N; r++) {
        const on = !gOk || other ? true : !!g.steps[r % g.steps.length];
        h += '<button type="button" class="sch-cell ' + (other ? 'inh' : (on ? 'on' : 'off')) + '" data-sch="round:' + esc(row.key) + ':' + r + '"' +
          (other ? ' disabled' : '') + ' title="' + esc(row.label + ' \u00b7 ' + refWord + ' ' + (r + 1) + ' \u2014 ' + (on ? 'plays' : 'silent')) + '">' + (r + 1) + '</button>';
      }
      h += '</div>';
    });
    return h + '</div>';
  }
  function paintRound(E, el, cfg, key, r) {
    const st = stOf(el);
    const L = has(_ambLayerByKey) ? _ambLayerByKey(E, key) : null; if (!L) return;
    const rows = has(_ambChordMatrixRows) ? (_ambChordMatrixRows(cfg) || []) : [];
    const N = roundsOf(cfg, st, rows);
    let g = L.iterGate;
    const old = (g && Array.isArray(g.steps) && g.steps.length) ? g.steps : null;
    tempNote(E, el, { kind: 'round', key, r, prev: g ? JSON.parse(JSON.stringify(g)) : null });
    const steps = Array.from({ length: N }, (_, q) => old ? (old[q % old.length] ? 1 : 0) : 1);
    const want = st.tool === 'off' ? 0 : 1;
    steps[r] = (steps[r] === want) ? (want ? 0 : 1) : want;
    if (steps.every((v) => v)) delete L.iterGate;
    else L.iterGate = { len: N, ref: st.ref, steps };
    try { if (has(_ambUnitGateBump)) _ambUnitGateBump(); } catch (e) {}
    commit(E, null);
  }
  function editRound(E, el, cfg, r, fn) {
    const ranges = _ambGridRanges(cfg) || [];
    const cur = _ambArrGridSeq(cfg, r, ranges.length, ranges).slice();
    const next = fn(cur);
    // AN EDIT TO ONE ROUND MUST ONLY CHANGE THAT ROUND. The stored pattern
    // repeats every `width` rounds, so a width narrower than the rounds on screen
    // (1, by default) makes round 3 the SAME column as round 1 — editing one
    // edited both. Widen to what is shown first, copying what each round already
    // plays (`seq[q % width]`), then write the one column.
    const rows = has(_ambChordMatrixRows) ? (_ambChordMatrixRows(cfg) || []) : [];
    const want = Math.max(r + 1, roundsOf(cfg, stOf(el), rows));
    const w0 = _ambArrCols(cfg);
    if (want > w0) {
      const copies = [];
      for (let q = 0; q < want; q++) copies.push([q, _ambArrGridSeq(cfg, q, ranges.length, ranges).slice()]);
      _ambArrColsSet(cfg, want);
      copies.forEach(([q, sq]) => { if (q !== r) _ambArrWrite(cfg, q, sq); });
    }
    _ambArrWrite(cfg, r, next);
    try { if (has(_ambRenderProgOverview)) _ambRenderProgOverview(E); } catch (e) {}
    commit(E, null);
  }

  // ── WRITE ─────────────────────────────────────────────────────────────────
  // After any arrangement edit: normalize, repaint every surface that draws the
  // same stores, retrigger what plays, persist (the ▦ Passes commit's own order).
  function commit(E, key) {
    try { E.getCfg(); } catch (e) {}
    try { if (key && has(_ambMaskEditPoke)) _ambMaskEditPoke(E, key); } catch (e) {}
    try { if (has(_ambRenderPassMatrix)) _ambRenderPassMatrix(E); } catch (e) {}
    try { if (has(_ambProgChainLenSync)) _ambProgChainLenSync(E); } catch (e) {}
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    const el = has(_ambGet) ? _ambGet(E, 'ambient-schedgrid') : null;
    if (el) el._sig = '';
    render(E);
  }

  function paintPlays(E, el, cfg, key, pass, k) {
    const st = stOf(el);
    const ranges = _ambGridRanges(cfg) || [], r = ranges[st.part]; if (!r) return;
    const abs = r.from + k;
    const want = st.tool === 'on' ? 100 : st.tool === 'off' ? 0 : st.tool === 'chance' ? st.chance : null;
    const rows = _ambChordMatrixRows(cfg) || [];
    const targets = (st.level === 'layers') ? rows : rows.filter((x) => x.key === key);
    targets.forEach((row) => {
      const L = row.L;
      tempNote(E, el, { kind: st.level === 'every' ? 'every' : 'cell', key: row.key, pi: r.pi, pass, ci: k, abs,
        prev: st.level === 'every' ? _ambMaskRead(L, 'chord', abs) : _ambChordPassGet(L, pass, abs) });
      if (st.level === 'every') {
        const m = _ambMaskStore(cfg, L, 'chord');
        const cur = Number.isFinite(m.steps[abs]) ? m.steps[abs] : 100;
        m.steps[abs] = (want == null || cur === want) ? 100 : want;
        return;
      }
      const own = _ambChordPassGet(L, pass, abs);
      const dflt = _ambMaskRead(L, 'chord', abs);
      // tapping the value a cell already has hands it back to the default
      let nv = (want == null || own === want) ? null : want;
      if (nv != null && nv === dflt) nv = null;
      _ambChordPassSet(L, pass, abs, nv);
    });
    commit(E, st.level === 'layers' ? null : key);
    if (st.level === 'layers') { try { rows.forEach((x) => _ambMaskEditPoke(E, x.key)); } catch (e) {} }
  }

  function paintPhrase(E, el, cfg, key, pass, k) {
    const st = stOf(el);
    const ranges = _ambGridRanges(cfg) || [], r = ranges[st.part]; if (!r) return;
    const L = has(_ambLayerByKey) ? _ambLayerByKey(E, key) : null; if (!L) return;
    const cellKey = st.level === 'part' ? _AMB_PARTSEQ_ALL
      : st.level === 'pass' ? _ambPartSeqCellKey(pass, '*') : _ambPartSeqCellKey(pass, k);
    const want = st.phrase === 'clear' ? null
      : st.phrase === 'gen' ? _AMB_PARTSEQ_GEN
      : _ambPsqStore(_ambPsqSpec({ n: st.phrase, s: st.slice.s | 0, l: st.slice.l | 0, f: st.slice.f }));
    // the SAME phrase AND slice again hands the cell back to what it inherits
    // (`_ambPartSeqCellGet` answers the NAME only — compare the whole spec)
    const curSp = has(_ambPartSeqCellSpec) ? _ambPartSeqCellSpec(L, r.pi, cellKey) : null;
    const cur = curSp ? _ambPsqStore(curSp) : null;
    const same = JSON.stringify(cur) === JSON.stringify(want);
    _ambPartSeqCellSet(L, r.pi, cellKey, (want == null || same) ? null : want);
    commit(E, key);
  }
  function paintSalt(E, el, cfg, key, k) {
    const st = stOf(el);
    const ranges = _ambGridRanges(cfg) || [], r = ranges[st.part]; if (!r) return;
    const L = has(_ambLayerByKey) ? _ambLayerByKey(E, key) : null; if (!L) return;
    const want = st.tool === 'off' ? 0 : st.tool === 'chance' ? st.chance : 100;
    const m = _ambMaskStore(cfg, L, 'salt');
    const abs = r.from + k, cur = Number.isFinite(m.steps[abs]) ? m.steps[abs] : 100;
    m.steps[abs] = (cur === want) ? 100 : want;
    if (m.steps.every((v) => v >= 100)) delete L.saltMask;
    commit(E, key);
  }

  function toggleChord(E, el, cfg, pass, k) {
    const st = stOf(el);
    const ranges = _ambGridRanges(cfg) || [], r = ranges[st.part]; if (!r) return;
    const seq = _ambPartGridSeq(cfg, r.pi, pass, r.len);
    const next = seq.indexOf(k) >= 0 ? seq.filter((v) => v !== k)
      : (has(_ambSeqInsertRowOrder) ? _ambSeqInsertRowOrder(seq, k) : seq.concat([k]).sort((a, b) => a - b));
    _ambPassWrite(cfg, r.pi, pass, next);
    try { if (has(_ambRenderProgOverview)) _ambRenderProgOverview(E); } catch (e) {}
    commit(E, null);
  }

  // ── WIRING — one delegated handler; the cells are rebuilt on every edit ───
  function wire(E, el) {
    if (el._schWired) return;
    el._schWired = 1;
    // the orientation is chosen at render — re-render when the width crosses it
    try {
      const mq = window.matchMedia('(max-width: 560px)');
      const onMq = () => { el._sig = ''; render(E); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    } catch (e) {}
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.sch-chancein')) return;              // the field is for typing
      const b = ev.target.closest('[data-sch]'); if (!b || b.disabled) return;
      const st = stOf(el);
      const a = b.getAttribute('data-sch').split(':');
      const cfg = E.getCfg(); if (!cfg) return;
      if (a[0] === 'temp') {
        st.temp = !st.temp;
        if (!st.temp) el._temp = [];          // turning it off KEEPS what was punched in
        el._sig = ''; render(E); return;
      }
      if (a[0] === 'view') { st.view = a[1]; el._sig = ''; render(E); return; }
      if (a[0] === 'mode') { st.mode = a[1]; st.level = 'cell'; if (st.mode === 'salt' && st.tool === 'clear') st.tool = 'on'; el._sig = ''; render(E); return; }
      if (a[0] === 'fitph') { st.slice.f = a[1]; el._sig = ''; render(E); return; }
      if (a[0] === 'part') { st.part = a[1] | 0; el._sig = ''; render(E); return; }
      if (a[0] === 'tool') { st.tool = a[1]; el._sig = ''; render(E); return; }
      if (a[0] === 'level') { st.level = a[1]; el._sig = ''; render(E); return; }
      if (a[0] === 'phrase') { st.phrase = a.slice(1).join(':'); el._sig = ''; render(E); return; }
      if (a[0] === 'chord') { toggleChord(E, el, cfg, a[1] | 0, a[2] | 0); return; }
      if (a[0] === 'hold') {
        if (_ambPassLockOn(E)) {
          _ambPassLockRelease(E);
          let hadLoop = false;
          if (Number.isFinite(E._partLoop)) { hadLoop = true; E._partLoop = null; }
          try { if (hadLoop && has(_ambRenderCurPart)) { const c9 = _ambGet(E, 'ambient-curpart'); if (c9) c9._sig = ''; _ambRenderCurPart(E); } } catch (e) {}
          try { showToast('Released \u2014 this pass finishes, then the next one runs.' + (hadLoop ? ' \u21bb Loop is off.' : '')); } catch (e) {}
        } else {
          const now2 = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
          const got = _ambPassLockEngage(E, E._cfg || cfg, now2);
          try {
            if (got) showToast('Holding ' + _ambPartLabel(cfg, got.pi) + ' \u00b7 pass ' + ((got.pass | 0) + 1) +
              ' \u2014 edits are heard on the next time round. Press again to release.');
            else showToast('Nothing is playing on a pass right now.', { warn: true });
          } catch (e) {}
        }
        el._sig = ''; render(E); return;
      }
      if (a[0] === 'pass') { const c = a[1] | 0; st.passOpen = (st.passOpen === c) ? -1 : c; el._sig = ''; render(E); return; }
      if (a[0] === 'cols' || a[0] === 'fit' || a[0] === 'salt' || a[0] === 'saltclear' || a[0] === 'move') {
        const ranges0 = _ambGridRanges(cfg) || [], r0 = ranges0[st.part]; if (!r0) return;
        partEdit(E, (c2) => {
          if (a[0] === 'cols') _ambPassColsSet(c2, r0.pi, Math.max(1, _ambPartPassCols(c2, r0.pi) + (a[1] | 0)));
          else if (a[0] === 'fit') { const g0 = _ambGridStore(c2, r0.pi, false); _ambPassFitSet(c2, r0.pi, !(g0 && g0.fit)); }
          else if (a[0] === 'saltclear') _ambPassSaltSet(c2, r0.pi, a[1] | 0, null);
          else if (a[0] === 'salt') {
            const c = a[1] | 0, fld = a[2], d = a[3] | 0;
            const stq = _ambPassSaltStore(c2, r0.pi, false);
            let base = stq && stq[String(c)];
            if (!base) { try { base = (_ambPassSaltInherited(c2, r0.pi, c2.prog.parts).salt) || null; } catch (e) { base = null; } }
            const v = { len: 0, colors: (base && base.colors) | 0, scatter: (base && base.scatter) | 0 };
            v[fld] = Math.max(0, Math.min(fld === 'colors' ? 7 : 100, (v[fld] | 0) + d));
            _ambPassSaltSet(c2, r0.pi, c, v);
          } else if (a[0] === 'move') {
            const c = a[1] | 0, q = a[2] | 0, d = a[3] | 0;
            const seq = _ambPartGridSeq(c2, r0.pi, c, r0.len).slice();
            const j = q + d; if (j < 0 || j >= seq.length) return;
            const t = seq[q]; seq[q] = seq[j]; seq[j] = t;
            _ambPassWrite(c2, r0.pi, c, seq);
          }
        });
        return;
      }
      if (a[0] === 'opt') { const key = a.slice(1).join(':'); st.open = (st.open === key) ? '' : key; el._sig = ''; render(E); return; }
      // option actions — data-sch="<act>:<arg>:<layer key>", the key last because it may hold ':'
      if (a[0] === 'gm' || a[0] === 'when' || a[0] === 'ev' || a[0] === 'ugmode' || a[0] === 'win' || a[0] === 'place' || a[0] === 'sec') { applyOption(E, el, cfg, a[0], a.slice(2).join(':'), a[1]); return; }
      if (a[0] === 'ugclear') { applyOption(E, el, cfg, 'ugclear', a.slice(1).join(':')); return; }
      if (a[0] === 'ugdiv' || a[0] === 'ugslice') { const arg = a.pop(); applyOption(E, el, cfg, a[0], a.slice(1).join(':'), arg); return; }
      if (a[0] === 'units') { st.units = Math.max(2, Math.min(32, (st.units | 0) + (a[1] | 0))); el._sig = ''; render(E); return; }
      if (a[0] === 'unit') { const u = a.pop() | 0; paintUnit(E, el, cfg, a.slice(1).join(':'), u); return; }
      if (a[0] === 'rounds') {
        const rows = _ambChordMatrixRows(cfg) || [];
        st.rounds = Math.max(1, Math.min(MAXR, roundsOf(cfg, st, rows) + (a[1] | 0)));
        el._sig = ''; render(E); return;
      }
      if (a[0] === 'ref') { st.ref = a[1]; el._sig = ''; render(E); return; }
      if (a[0] === 'seqmodal' && has(_ambPassSeqModal)) { _ambPassSeqModal(E, st.part, a[1] | 0); return; }
      if (a[0] === 'mseqmodal' && has(_ambPassSeqModal)) {
        // widen the pattern to this round first, or the edit lands on a column
        // every round shares (the editRound rule)
        const r = a[1] | 0;
        const rows = _ambChordMatrixRows(cfg) || [];
        if (Math.max(r + 1, roundsOf(cfg, st, rows)) > _ambArrCols(cfg)) editRound(E, el, cfg, r, (cur) => cur);
        _ambPassSeqModal(E, -1, r, true);
        return;
      }
      if (a[0] === 'visit') {
        const r = a[1] | 0, at = a[2] | 0, n = a[3] | 0;
        editRound(E, el, cfg, r, (cur) => cur.slice(0, at).concat(cur.slice(at + n)));
        return;
      }
      if (a[0] === 'round') {
        const r = a.pop() | 0, key = a.slice(1).join(':');
        paintRound(E, el, cfg, key, r);
        return;
      }
      if (a[0] === 'cell') {
        // key may itself contain ':' (e.g. 'v2:3', 'arp:2') — pass and chord are the last two
        const k = a.pop() | 0, pass = a.pop() | 0, key = a.slice(1).join(':');
        if (st.mode === 'plays') paintPlays(E, el, cfg, key, pass, k);
        else if (st.mode === 'salt') paintSalt(E, el, cfg, key, k);
        else paintPhrase(E, el, cfg, key, pass, k);
      }
    });
    // TYPING A CHANCE ACTIVATES IT — without a redraw under the caret
    el.addEventListener('input', (ev) => {
      const f = ev.target.closest('.sch-chancein'); if (!f) return;
      const n = Math.round(+f.value);
      if (!(n >= 1 && n <= 99)) return;
      const st = stOf(el);
      st.chance = n; st.tool = 'chance';
      el.querySelectorAll('.sch-tool').forEach((t) => t.classList.toggle('on', t.classList.contains('sch-chance')));
      const sw = el.querySelector('.sch-chance .sch-sw'); if (sw) sw.style.setProperty('--p', n + '%');
    });
    el.addEventListener('change', (ev) => {
      if (ev.target.closest('.sch-chancein')) { el._sig = ''; render(E); return; }
      // ＋ ADD A PART TO A ROUND — one pass of it, at the end (adding the same
      // part again beside itself grows that visit's count)
      const sl = ev.target.closest('[data-schslice]');
      if (sl) {
        const st2 = stOf(el), n = Math.max(0, Math.round(+sl.value) || 0);
        if (sl.getAttribute('data-schslice') === 's') st2.slice.s = Math.min(64, Math.max(0, n - 1)); else st2.slice.l = Math.min(64, n);
        el._sig = ''; render(E); return;
      }
      const bi = ev.target.closest('.sch-barsin');
      if (bi) {
        const [c, q] = bi.getAttribute('data-schbars').split(':').map((x) => x | 0);
        const st2 = stOf(el);
        const cfg0 = E.getCfg(); const r0 = (_ambGridRanges(cfg0) || [])[st2.part]; if (!r0) return;
        const v = parseFloat(bi.value);
        partEdit(E, (c2) => _ambPassBarsSet(c2, r0.pi, c, q, (v > 0) ? v : 0));
        return;
      }
      const secSel = ev.target.closest('.sch-secsel');
      if (secSel) {
        const cfg = E.getCfg(); if (!cfg) return;
        applyOption(E, el, cfg, 'when', secSel.getAttribute('data-schsec'), secSel.value ? ('sec:' + secSel.value) : 'always');
        return;
      }
      const add = ev.target.closest('.sch-addvisit');
      if (add && add.value !== '') {
        const r = add.getAttribute('data-schadd') | 0, k = add.value | 0;
        const cfg = E.getCfg(); if (!cfg) return;
        editRound(E, el, cfg, r, (cur) => cur.concat([k]));
      }
    });
    el.addEventListener('keydown', (ev) => {
      const t = ev.target.closest('.sch-chance');
      if (t && ev.target === t && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); stOf(el).tool = 'chance'; el._sig = ''; render(E); }
    });
  }

  // ── ⏺ TEMP PUNCH-INS ──────────────────────────────────────────────────────
  // Each temp edit remembers what the cell held. It is ARMED when the playhead
  // reaches its place and put back when the playhead LEAVES it — so an edit to
  // a cell that has not played yet is heard once. Only the first edit to a place
  // is kept (a second tap must not make the edited value the "original").
  // Transient (on the host element): a reload plays what is stored.
  function tempNote(E, el, rec) {
    const st = stOf(el);
    if (!st.temp || !E.timer) return;
    const list = el._temp || (el._temp = []);
    const id = rec.kind + '|' + rec.key + '|' + (rec.kind === 'round' ? rec.r : (rec.pi + ':' + rec.pass + ':' + rec.ci));
    if (list.some((x) => x.id === id)) return;
    rec.id = id; rec.armed = false;
    list.push(rec);
  }
  function tempRevert(E, el, rec) {
    const L = has(_ambLayerByKey) ? _ambLayerByKey(E, rec.key) : null; if (!L) return;
    const cfg = E.getCfg(); if (!cfg) return;
    if (rec.kind === 'round') { if (rec.prev) L.iterGate = rec.prev; else delete L.iterGate; try { _ambUnitGateBump(); } catch (e) {} }
    else if (rec.kind === 'every') { const m = _ambMaskStore(cfg, L, 'chord'); m.steps[rec.abs] = rec.prev; }
    else _ambChordPassSet(L, rec.pass, rec.abs, rec.prev == null ? null : rec.prev);
  }
  function tempFlush(E, el, pred) {
    const list = el._temp; if (!list || !list.length) return;
    const keep = [], done = [];
    list.forEach((x) => (pred(x) ? done : keep).push(x));
    if (!done.length) return;
    el._temp = keep;
    done.forEach((x) => { try { tempRevert(E, el, x); } catch (e) {} });
    const keys = new Set(done.map((x) => x.key));
    keys.forEach((k) => { try { _ambMaskEditPoke(E, k); } catch (e) {} });
    commit(E, null);
  }
  function tempRestoreAll(E) {
    const el = has(_ambGet) ? _ambGet(E, 'ambient-schedgrid') : null;
    if (el) tempFlush(E, el, () => true);
  }
  // per frame: arm what the playhead is on, revert what it has left
  function tempTick(E, el, cfg, now) {
    const list = el._temp; if (!list || !list.length) return;
    let w = null; try { w = _ambPartChordAt(E, cfg, now); } catch (e) {}
    let ri = -1; try { ri = _ambIterIndexAt(E, cfg, 'round', now); } catch (e) {}
    const on = (x) => {
      if (x.kind === 'round') {
        const L = _ambLayerByKey(E, x.key), g = L && L.iterGate;
        const n = (g && g.steps && g.steps.length) || 1;
        let r2 = ri; try { if (g && g.ref === 'plot') r2 = _ambIterIndexAt(E, cfg, 'plot', now); } catch (e) {}
        return r2 >= 0 && (r2 % n) === (x.r % n);
      }
      if (!w || w.pi !== x.pi) return false;
      const cols = Math.max(1, _ambPartPassCols(cfg, w.pi));
      return (x.kind === 'every' || ((w.pass % cols) + cols) % cols === x.pass) && (w.ci | 0) === x.ci;
    };
    list.forEach((x) => { if (on(x)) x.armed = true; else if (x.armed) x.left = true; });
    tempFlush(E, el, (x) => !!x.left);
  }

  // ── PLAYHEAD — per frame from the view tick, beside the old grid's own ────
  // By part: the running PASS block is tinted and the chord sounding in it lit
  // (only when the part on screen is the one playing). Across rounds: the round
  // column. Classes only — never a re-render, so a tap mid-play is not eaten.
  function clearPh(el) {
    el._phKey = '';
    el.querySelectorAll('.sch-playing, .sch-incol').forEach((n) => n.classList.remove('sch-playing', 'sch-incol'));
  }
  function playhead(E) {
    const el = has(_ambGet) ? _ambGet(E, 'ambient-schedgrid') : null; if (!el || !el._st) return;
    const cfg = E && (E._cfg || (E.getCfg && E.getCfg()));
    if (!E.timer || !cfg) { if (el._temp && el._temp.length) tempRestoreAll(E); }
    if (!E.timer || !cfg || (has(_ambViewIsPlaying) && !_ambViewIsPlaying(E))) { if (el._phKey) clearPh(el); return; }
    const st = el._st;
    const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    try { tempTick(E, el, cfg, now); } catch (e) {}
    let key = '';
    if (st.view === 'round') {
      const ri = has(_ambIterIndexAt) ? _ambIterIndexAt(E, cfg, st.ref, now) : -1;
      if (!(ri >= 0)) { if (el._phKey) clearPh(el); return; }
      const N = roundsOf(cfg, st, _ambChordMatrixRows(cfg) || []);
      key = 'r' + (ri % N);
      if (el._phKey === key && el.querySelector('.sch-incol')) return;
      clearPh(el); el._phKey = key;
      const col = ri % N;
      el.querySelectorAll('[data-schround="' + col + '"]').forEach((n) => n.classList.add('sch-incol'));
      el.querySelectorAll('[data-sch^="round:"]').forEach((n) => {
        if ((String(n.getAttribute('data-sch')).split(':').pop() | 0) === col) n.classList.add('sch-playing');
      });
      return;
    }
    let w = null; try { w = has(_ambPartChordAt) ? _ambPartChordAt(E, cfg, now) : null; } catch (e) { w = null; }
    const ranges = has(_ambGridRanges) ? (_ambGridRanges(cfg) || []) : [];
    const shown = ranges[st.part];
    if (!w || w.pi < 0 || !shown || shown.pi !== w.pi) { if (el._phKey) clearPh(el); return; }
    const cols = Math.max(1, _ambPartPassCols(cfg, w.pi));
    const pass = ((w.pass % cols) + cols) % cols, ci = w.ci | 0;
    key = 'p' + pass + ':' + ci;
    if (el._phKey === key && el.querySelector('.sch-incol')) return;
    clearPh(el); el._phKey = key;
    const blk = el.querySelector('[data-schpass="' + pass + '"]'); if (blk) blk.classList.add('sch-incol');
    el.querySelectorAll('[data-sch^="chord:' + pass + ':"], [data-sch^="cell:"]').forEach((n) => {
      const a = String(n.getAttribute('data-sch')).split(':');
      const k = a[a.length - 1] | 0, c = a[a.length - 2] | 0;
      if (c === pass && k === ci) n.classList.add('sch-playing');
    });
  }

  try { window._ambRenderSchedule = render; window._ambScheduleTick = playhead; window._ambScheduleTempRestore = tempRestoreAll; } catch (e) {}
})();
