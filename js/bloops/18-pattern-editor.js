// ▦ THE PATTERN EDITOR (2026-10-06) — a Pattern layer's step grid, full screen.
//
// The ⤢ Editor on a Pattern card opens it. It edits what the engine plays, in the
// store's own shapes (no new fields):
//   · a PITCHED pattern — `part.pitch.kind:'grid'`, `part.pitch.rows = { "<midi>": { c:
//     [[start, len], …] } }`: one run per hit, a hold is a longer run (the normalizer
//     derives `rhythm.cells` from the rows). A pattern whose notes come from a pitch RULE
//     is written onto rows the first time it is edited, from what it plays — so the first
//     touch changes nothing you can hear.
//   · a DRUM pattern — `part.rhythm.lanes[lane][step]` 0/1, a lane per drum.
// Gestures (✎ Draw): tap an empty step = a hit (and you hear it); drag right = hold it
// (drums: paint the lane); tap a hit = remove it; press a hit and drag = resize it.
// ⌨ Compose: keys (or drum pads) write at the teal cursor and step it on; keys pressed
// together land on one step; the grid becomes the cursor's ruler.
// Everything goes through window._v2 (the two-IIFE rule), like Generate V2.
(function () {
  'use strict';
  const V2 = window._v2;
  if (!V2) return;
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const NM = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const nameOf = (m) => NM[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const isBlack = (m) => [1, 3, 6, 8, 10].indexOf(((m % 12) + 12) % 12) >= 0;
  const LANE_COL = ['#e5484d', '#f0a35e', '#e9559f', '#16b6e8', '#14d39b', '#9d5fd9', '#e3c46d', '#4a7aa0'];
  const NOTE = '#5b93e0';
  const LANEH = 46;                                     // a lane's height

  let P = null;   // { E, id, root, mode, cur, oct, hist:{u,r}, say, lanes, pins, sel, want, followCur }
  const layer = () => (P && P.E && (P.E.getCfg().layers || []).find((x) => x && x.id === P.id)) || null;
  const isKit = (L) => ((L && L.instrument) || {}).voice === 'kit';
  const cellsOf = (L) => Math.max(1, ((L.part.rhythm || {}).steps | 0) || V2.gridCells(L));
  const spbOf = (L) => Math.max(1, V2.gridPerBar(L) | 0);
  const barsOf = (L) => Math.max(1, Math.ceil(cellsOf(L) / spbOf(L) - 1e-9));
  // HOW MANY STEPS ON SCREEN: a bar (two, wide) — halved until a step is a finger wide
  // (~34 px), so 1/16 on a phone pages by half-bars at ~37 px a step instead of 21
  function pageOf(L) {
    const spb = spbOf(L), gut = isKit(L) ? 92 : 52, avail = Math.max(120, window.innerWidth - gut);
    let n = spb * (window.innerWidth > window.innerHeight && window.innerWidth > 600 ? 2 : 1);
    while (n > 4 && n % 2 === 0 && avail / n < 34) n /= 2;
    return Math.max(1, n);
  }

  // ── what the grid holds, read off the store ─────────────────────────────────
  function rowsOf(L) { const t = L.part.pitch || {}; return (t.kind === 'grid' && t.rows) ? t.rows : null; }
  // a run by pitch and start — in the stored rows, or (a rule-driven pattern, before its
  // first edit writes rows) in what it plays
  const runOf = (L, m, start) => {
    const rw = rowsOf(L);
    if (rw) { const row = rw[String(m)]; return row ? (row.c || []).find((r) => (r[0] | 0) === start) : null; }
    // eslint-disable-next-line no-use-before-define
    const pr = pitchedRuns(L)[m]; return pr ? pr.find((r) => (r[0] | 0) === start) : null;
  };
  // the runs a PITCHED pattern plays, whatever drives it — rows if it has them, else
  // what it actually plays, snapped to the steps (shown, not stored, until you edit)
  function pitchedRuns(L, E0) {
    const rw = rowsOf(L), out = {};
    if (rw) { Object.keys(rw).forEach((k) => { out[k | 0] = ((rw[k] && rw[k].c) || []).map((r) => [r[0] | 0, Math.max(1, r[1] | 0)]); }); return out; }
    const E = E0 || (P && P.E), cfg = E.getCfg(), cells = cellsOf(L);
    let cyc = 4; try { cyc = V2.cycleSec(L, cfg); } catch (e) {}
    let ns = [];
    try { ns = V2.withEdit(() => V2.withTake(V2.pinOf(L), () => V2.notesFor(L, { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || []; } catch (e) { ns = []; }
    ns.forEach((n) => {
      if (!(n && n.freq > 0 && n.at >= 0 && n.at < cyc)) return;
      const m = Math.round(69 + 12 * Math.log2(n.freq / 440));
      const st = clamp(Math.round(n.at / cyc * cells), 0, cells - 1);
      const ln = clamp(Math.max(1, Math.round((n.durMs || 0) / 1000 / cyc * cells)), 1, cells - st);
      const row = out[m] || (out[m] = []);
      if (!row.some((q) => st < q[0] + q[1] && q[0] < st + ln)) row.push([st, ln]);
    });
    return out;
  }
  // FIRST EDIT: a pitch RULE becomes rows, from exactly what it plays
  function ensureRows(L) {
    if (rowsOf(L)) return;
    const runs = pitchedRuns(L), rows = {};
    Object.keys(runs).forEach((m) => { if (runs[m].length) rows[String(m)] = { c: runs[m].map((r) => r.slice()) }; });
    L.part.pitch = Object.assign({}, L.part.pitch || {}, { kind: 'grid', rows });
    L.part.rhythm = Object.assign({}, L.part.rhythm || {}, { kind: 'drawn' });
  }
  function lanesOf(L) {
    const r = L.part.rhythm || (L.part.rhythm = {});
    if (!Array.isArray(r.lanes)) r.lanes = [];
    return r.lanes;
  }

  // ── history and commit ──────────────────────────────────────────────────────
  function snap(L) { return JSON.stringify(L.part); }
  function beginEdit(L) { P.hist.u.push(snap(L)); if (P.hist.u.length > 80) P.hist.u.shift(); P.hist.r = []; }
  function commit(L) {
    const E = P.E;
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    try { E.getCfg(); } catch (e) {}
    // a playing layer hears the edit now, not a cycle later (the Roll editor's re-anchor)
    try {
      if (E.timer && (typeof _ambLiveApplyOK !== 'function' || _ambLiveApplyOK(E))) {
        if (typeof cancelBloomFutureVoices === 'function') cancelBloomFutureVoices('v2:' + (L.id | 0), Tone.now());
        if (E._v2Phase) delete E._v2Phase['v2:' + (L.id | 0)];
      }
    } catch (e) {}
    paint();
  }
  function histStep(dir) {
    const L = layer(); if (!L) return;
    const from = dir < 0 ? P.hist.u : P.hist.r, to = dir < 0 ? P.hist.r : P.hist.u;
    if (!from.length) return;
    to.push(snap(L));
    const j = JSON.parse(from.pop());
    Object.keys(L.part).forEach((k) => { delete L.part[k]; });
    Object.assign(L.part, j);
    commit(L);
  }
  // a short taste of a pitch, in the layer's own sound
  function hear(L, m) {
    try { const hnd = V2.auditionStart(P.E, L, m); if (hnd && hnd.release) setTimeout(() => { try { hnd.release(); } catch (e) {} }, 220); } catch (e) {}
  }

  // ── the picture ─────────────────────────────────────────────────────────────
  function paint() {
    if (!P) return;
    const L = layer(); if (!L) { close(); return; }
    const kit = isKit(L), cells = cellsOf(L), spb = spbOf(L), nb = barsOf(L), page = pageOf(L);
    let keyName = '';
    try { keyName = (V2.keyLabelAt && V2.keyLabelAt(P.E, P.E.getCfg(), 0)) || ''; } catch (e) {}
    let spc = null;
    try { spc = V2.scaleAt(P.E, P.E.getCfg(), 0, L); } catch (e) { spc = null; }
    let h = '';
    // header
    h += '<div class="pe-head"><button type="button" class="pe-done" data-pe="done">Done</button>'
      + '<span class="pe-title"><b>' + esc(L.name || ('Layer ' + L.id)) + '</b><small>▦ Pattern' + (kit ? ' · drums' : (keyName ? ' · Key: ' + esc(keyName) : '')) + '</small></span>'
      + '<button type="button" class="pe-ib' + (P.hist.u.length ? '' : ' pe-dim') + '" data-pe="undo" aria-label="Undo">↶</button>'
      + '<button type="button" class="pe-ib' + (P.hist.r.length ? '' : ' pe-dim') + '" data-pe="redo" aria-label="Redo">↷</button>'
      + '<button type="button" class="pe-ib pe-play" data-pe="play" aria-label="Preview">▶</button></div>';
    // tools
    h += '<div class="pe-tools"><span class="pe-seg" role="group" aria-label="What a tap does">'
      + '<button type="button" data-pe="mode" data-k="draw" class="' + (P.mode === 'draw' ? 'on' : '') + '" aria-pressed="' + (P.mode === 'draw') + '">✎ Draw</button>'
      + '<button type="button" data-pe="mode" data-k="edit" class="' + (P.mode === 'edit' ? 'on' : '') + '" aria-pressed="' + (P.mode === 'edit') + '">◎ Edit</button>'
      + '<button type="button" data-pe="mode" data-k="compose" class="' + (P.mode === 'compose' ? 'on' : '') + '" aria-pressed="' + (P.mode === 'compose') + '">⌨ Compose</button></span>'
      + '<label class="pe-gridsel">⊞ <select data-pe="grid" aria-label="Steps a bar">'
      + (V2.GRIDS || []).map(([v, lab]) => '<option value="' + v + '"' + (v === spb ? ' selected' : '') + '>' + esc(lab) + '</option>').join('') + '</select></label></div>';
    // compose panel
    if (P.mode === 'compose') {
      h += '<div class="pe-comp">';
      if (kit) {
        h += '<div class="pe-pads">' + (V2.LANE_NAMES || []).map((nm, li) => '<button type="button" class="pe-pad" data-pe="pad" data-li="' + li + '" style="background:' + LANE_COL[li % LANE_COL.length] + '">' + esc(nm) + '</button>').join('') + '</div>';
      } else {
        h += '<div class="pe-keys"><div class="pe-krows">';
        [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]].forEach((row) => {
          h += '<div class="pe-krow">' + row.map((pc) => '<button type="button" class="pe-key' + (isBlack(pc) ? ' blk' : '') + '" data-pe="key" data-pc="' + pc + '">' + NM[pc] + '</button>').join('') + '</div>';
        });
        h += '</div><div class="pe-oct"><button type="button" class="pe-ib" data-pe="oct" data-d="1" aria-label="Octave up">▲</button><span>' + P.oct + '</span><button type="button" class="pe-ib" data-pe="oct" data-d="-1" aria-label="Octave down">▼</button></div></div>';
      }
      h += '<div class="pe-crow"><button type="button" class="pe-cb" data-pe="rest">Rest ▸</button><button type="button" class="pe-cb" data-pe="back">◂ Back</button>'
        + '<button type="button" class="pe-cb" data-pe="nbar">⤸ Bar</button><button type="button" class="pe-cb pe-del" data-pe="clrstep" aria-label="Clear this step">⌫ Clear</button></div></div>';
    }
    // ── THE GRID, ONE BLOCK PER CHANGE (2026-10-06, user: "lay out the Pattern editor one
    // row per change too") — or per bar with no changes, the card's own layout, scrolling
    // DOWN instead of paging sideways. A change longer than a finger-sized row (`page`
    // steps) wraps onto more rows inside its block; every row shares one step width, so a
    // step lines up down the page. Each row is its own `.pe-grid` (`data-c0`), and a hold
    // that crosses a row edge carries on in the next.
    const lanes = kit ? null : laneSplit(pitchedRuns(L));
    const nLanes = kit ? (V2.LANE_NAMES || []).length : Math.max(1, lanes.length, P.want | 0);
    P.lanes = lanes;
    const lanesK = kit ? lanesOf(L) : null;
    const cw = 100 / page;
    let segs = null;
    try { const cm = V2.changeSpans ? V2.changeSpans(P.E, L) : null; if (cm && cm.length > 1) segs = cm.map((c) => ({ a: Math.round(c.f0 * cells), z: Math.round(c.f1 * cells), nm: c.nm })).filter((g) => g.z > g.a); } catch (e) { segs = null; }
    if (!segs || !segs.length) segs = Array.from({ length: nb }, (_, i) => ({ a: i * spb, z: Math.min(cells, (i + 1) * spb), nm: 'Bar ' + (i + 1) }));
    const where = (st) => (Math.floor(st / spb) + 1) + '.' + (Math.floor((st % spb) / Math.max(1, spb / 4)) + 1);
    h += '<div class="pe-body">';
    segs.forEach((g, gi) => {
      for (let a0 = g.a; a0 < g.z; a0 += page) {
        const z0 = Math.min(g.z, a0 + page), cols = z0 - a0;
        h += '<div class="pe-blk">' + (a0 === g.a ? '<div class="pe-seghd"><b>' + esc(g.nm || ('Change ' + (gi + 1))) + '</b><span>' + where(a0) + '</span></div>' : '<div class="pe-seghd pe-segcont"><span>' + where(a0) + '</span></div>');
        h += '<div class="pe-segrow"><div class="pe-gutcol' + (kit ? ' kit' : ' v') + '">';
        for (let li = 0; li < nLanes; li++) {
          h += kit ? '<span class="pe-lane" style="height:' + LANEH + 'px"><i style="background:' + LANE_COL[li % LANE_COL.length] + '"></i>' + esc((V2.LANE_NAMES || [])[li] || '') + '</span>'
            : '<span class="pe-lane" style="height:' + LANEH + 'px" title="Voice ' + (li + 1) + '"><i style="background:' + NOTE + '"></i>' + (li + 1) + '</span>';
        }
        h += '</div><div class="pe-grid" data-c0="' + a0 + '" data-cols="' + cols + '" data-rows="' + nLanes + '" data-rowh="' + LANEH + '" style="height:' + (nLanes * LANEH) + 'px">' + gridBg(nLanes, LANEH, page, a0, spb, null, null, cols);
        for (let li = 0; li < nLanes; li++) {
          const col = kit ? LANE_COL[li % LANE_COL.length] : NOTE;
          for (let k = 0; k < cols; k++) {
            const st = a0 + k; let x = 'left:calc(' + (k * cw) + '% + 2px);width:calc(' + cw + '% - 4px);top:' + (li * LANEH + 5) + 'px;height:' + (LANEH - 10) + 'px';
            let cls = 'pe-st0', lab = '', bg = '';
            if (kit) {
              if ((lanesK[li] || [])[st]) {
                cls = 'pe-st1'; bg = col;
                const fx = (((L.part.rhythm || {}).cellFx) || {})[li + ':' + st];
                if (fx && Number.isFinite(fx.c) && fx.c < 100) cls += ' pe-chance';
                if (fx && fx.t) lab = (fx.t > 0 ? '+' : '') + fx.t;
                if (P.sel && P.sel.kit && P.sel.li === li && P.sel.col === st) cls += ' pe-sel';
              }
            } else {
              const n = (lanes[li] || []).find((q) => st >= q.s && st < q.s + q.l);
              if (n) {
                bg = col;
                const first = st === n.s || k === 0, last = st === n.s + n.l - 1 || k === cols - 1;
                // a HOLD is one bar of joined chips: no gap where it continues
                if (n.l > 1 && !(first && last)) {
                  const L0 = first ? 2 : 0, R0 = last ? 2 : 0;
                  x = 'left:calc(' + (k * cw) + '% + ' + L0 + 'px);width:calc(' + cw + '% - ' + (L0 + R0) + 'px);top:' + (li * LANEH + 5) + 'px;height:' + (LANEH - 10) + 'px';
                }
                cls = 'pe-st1' + (n.l > 1 ? (first ? ' cs' : (last ? ' ce' : ' cm')) : '') + (spc && !spc[((n.m % 12) + 12) % 12] ? ' ook' : '');   // outside the key: amber edge
                if (first) lab = nameOf(n.m) + (st !== n.s ? '…' : '');
                if (P.sel && !P.sel.kit && P.sel.m === n.m && P.sel.start === n.s) cls += ' pe-sel';
              }
            }
            h += '<span class="pe-st ' + cls + '" style="' + x + (bg ? ';background:' + bg : '') + '">' + esc(lab) + '</span>';
          }
        }
        if (P.mode === 'compose' && P.cur >= a0 && P.cur < z0) h += '<span class="pe-cursor" style="left:' + ((P.cur - a0) * cw) + '%;width:' + cw + '%"></span>';
        h += '</div></div></div>';
      }
    });
    if (!kit) h += '<button type="button" class="pe-addlane" data-pe="addlane">＋ Lane</button>';
    h += '</div>';
    // ── THE STEP PANEL: the selected step's own controls ──
    if (P.mode === 'edit') h += stepPanelHTML(L, kit);
    else if (P.sel) P.sel = null;
    // the foot: what just happened
    h += '<div class="pe-foot"><span class="pe-where">' + nb + ' bar' + (nb === 1 ? '' : 's') + ' · ' + spb + ' steps a bar' + (P.say ? ' · <b>' + esc(P.say) + '</b>' : '') + '</span></div>';
    const sc = P.root.querySelector('.pe-body'), top = sc ? sc.scrollTop : null;
    P.root.innerHTML = '<div class="pe">' + h + '</div>';
    const sc2 = P.root.querySelector('.pe-body');
    if (sc2 && top != null) sc2.scrollTop = top;
    // the compose cursor stays in view as it walks down the page
    if (P.mode === 'compose' && P.followCur) {
      P.followCur = false;
      const cu = P.root.querySelector('.pe-cursor');
      if (cu && sc2) { const r1 = cu.getBoundingClientRect(), r0 = sc2.getBoundingClientRect(); if (r1.top < r0.top || r1.bottom > r0.bottom) sc2.scrollTop += (r1.top - r0.top) - sc2.clientHeight / 3; }
    }
  }
  // ✎ ONE STEP (2026-10-06, user: "user needs to be able to edit individual steps (notes,
  // length, etc)"). A tap on a sounding chip SELECTS it; this panel edits it. Pitched: its
  // note (scale step / half-step), its length, its place, ⧉ and 🗑 — all in the rows the
  // pattern already stores. Drums: how often it sounds and its tune (the kit's `cellFx`).
  function selValid(L) {
    const s0 = P.sel; if (!s0) return false;
    if (s0.kit) return !!((lanesOf(L)[s0.li] || [])[s0.col]);
    return !!runOf(L, s0.m, s0.start);
  }
  function stepPanelHTML(L, kit) {
    if (!selValid(L)) { P.sel = null; return ''; }
    const s0 = P.sel, spb = spbOf(L);
    const where = 'bar ' + (Math.floor((kit ? s0.col : s0.start) / spb) + 1) + ' · step ' + (((kit ? s0.col : s0.start) % spb) + 1);
    const b = (a, lab, aria, extra) => '<button type="button" class="pe-sb' + (extra || '') + '" data-pe="' + a + '"' + (aria ? ' aria-label="' + aria + '"' : '') + '>' + lab + '</button>';
    let h = '<div class="pe-step"><div class="pe-sthead"><b>' + esc(kit ? ((V2.LANE_NAMES || [])[s0.li] || 'Drum') : nameOf(s0.m)) + '</b><span>' + where + '</span>'
      + b('sx', '✕', 'Done with this step', ' pe-sx') + '</div>';
    if (kit) {
      const fx = (((L.part.rhythm || {}).cellFx) || {})[s0.li + ':' + s0.col] || {}, c = Number.isFinite(fx.c) ? fx.c : 100, t = fx.t | 0;
      h += '<div class="pe-strow"><span>Plays</span>' + [100, 75, 50, 25].map((v) => '<button type="button" class="pe-sb pe-seg1' + (c === v ? ' on' : '') + '" data-pe="kchance" data-v="' + v + '">' + (v === 100 ? 'always' : v + '%') + '</button>').join('') + '</div>'
        + '<div class="pe-strow"><span>Tune</span>' + b('ktune', '−', 'Tune down a semitone', '" data-d="-1') + '<b class="pe-num">' + (t > 0 ? '+' : '') + t + '</b>' + b('ktune', '+', 'Tune up a semitone', '" data-d="1') + '<i>semitones</i></div>'
        + '<div class="pe-strow">' + b('sdel', '🗑 Remove', null, ' pe-del') + '</div>';
    } else {
      const run = runOf(L, s0.m, s0.start);
      h += '<div class="pe-strow"><span>Note</span>' + b('snote', '▼', 'Down a scale step', '" data-d="-1') + b('snote', '▲', 'Up a scale step', '" data-d="1')
        + b('shalf', '−½', 'Down a half-step', '" data-d="-1') + b('shalf', '+½', 'Up a half-step', '" data-d="1') + '</div>'
        + '<div class="pe-strow"><span>Length</span>' + b('slen', '−', 'Shorter', '" data-d="-1') + '<b class="pe-num">' + run[1] + ' step' + (run[1] === 1 ? '' : 's') + '</b>' + b('slen', '+', 'Longer', '" data-d="1') + '</div>'
        + '<div class="pe-strow"><span>Move</span>' + b('smove', '◀', 'A step earlier', '" data-d="-1') + b('smove', '▶', 'A step later', '" data-d="1')
        + b('sdup', '⧉ Dup', 'Copy it to right after itself') + b('sdel', '🗑', 'Remove it', ' pe-del') + '</div>';
    }
    return h + '</div>';
  }
  // one edit of the selected PITCHED run: take it out, change it, put it back (by value)
  function editSel(L, fn) {
    const s0 = P.sel, run = runOf(L, s0.m, s0.start); if (!run) return;
    beginEdit(L);
    ensureRows(L);
    // THE CHANGE FIRST, THE ROWS AFTER: working it out can read the config (a scale step
    // asks the key), and that normalize REPLACES `rows` — a copy taken before it is stale
    const nx = fn({ m: s0.m, start: s0.start, len: run[1] }, cellsOf(L)); if (!nx) return;
    const rows = L.part.pitch.rows;
    const pin = P.pins[s0.m + ':' + s0.start];
    const a = rows[String(s0.m)];
    if (a) { a.c = a.c.filter((r) => (r[0] | 0) !== s0.start); if (!a.c.length) delete rows[String(s0.m)]; }
    if (!nx.remove) {
      const b = rows[String(nx.m)] || (rows[String(nx.m)] = { c: [] });
      b.c = b.c.filter((r) => !(nx.start < r[0] + r[1] && r[0] < nx.start + nx.len));
      b.c.push([nx.start, nx.len]);
      if (Number.isFinite(pin)) { delete P.pins[s0.m + ':' + s0.start]; P.pins[nx.m + ':' + nx.start] = pin; }
      P.sel = { m: nx.m, start: nx.start };
      if (nx.m !== s0.m) hear(L, nx.m);
      P.say = nameOf(nx.m) + ' · ' + nx.len + ' step' + (nx.len === 1 ? '' : 's') + ' at step ' + (nx.start + 1);
    } else { P.sel = null; P.say = nameOf(s0.m) + ' removed'; }
    commit(L);
  }
  function gridBg(n, rh, cols, c0, spb, shade, ms, used) {   // (shade / ms: unused by lanes, kept for the row tint)
    let s = '';
    const wPct = (Number.isFinite(used) ? used / cols : 1) * 100;   // a short last row tints only its own steps
    for (let i = 0; i < n; i++) {
      const cls = shade ? (shade[i] === 'out' ? ' out' : ' in') : (ms && isBlack(ms[i]) ? ' blk' : (!ms && i % 2 ? ' alt' : ''));
      s += '<span class="pe-row' + cls + '" style="top:' + (i * rh) + 'px;height:' + rh + 'px;right:auto;width:' + wPct + '%"></span>';
    }
    const q = Math.max(1, spb / 4);
    for (let k = 1; k < (Number.isFinite(used) ? used : cols); k++) {
      const st = c0 + k;
      s += '<span class="pe-vl' + (st % spb === 0 ? ' bar' : (st % q === 0 ? ' beat' : '')) + '" style="left:' + (k / cols * 100) + '%"></span>';
    }
    return s;
  }

  // ── where a pointer is, in steps and rows ───────────────────────────────────
  // the ROW under the pointer (by height, so a hold dragged down a row edge carries on),
  // else the one the gesture started in; a point past a short row's last step is nothing
  function cellAt(ev, g0) {
    const L = layer(); if (!L) return null;
    let g = null;
    const gs = [...P.root.querySelectorAll('.pe-grid')];
    for (let i = 0; i < gs.length; i++) { const r = gs[i].getBoundingClientRect(); if (ev.clientY >= r.top && ev.clientY < r.bottom) { g = gs[i]; break; } }
    if (!g) g = g0 || (ev.target && ev.target.closest && ev.target.closest('.pe-grid'));
    if (!g) return null;
    const r = g.getBoundingClientRect(), page = pageOf(L);
    const c0 = +g.getAttribute('data-c0') || 0, cols = +g.getAttribute('data-cols') || page;
    const rh = +g.getAttribute('data-rowh') || LANEH, nr = +g.getAttribute('data-rows') || 1;
    const k = Math.floor((ev.clientX - r.left) / Math.max(1, r.width) * page);
    if (k >= cols && !g0) return null;
    const col = clamp(k, 0, cols - 1) + c0;
    const ri = clamp(Math.floor((ev.clientY - r.top) / rh), 0, nr - 1);
    return { col, ri, g };
  }

  // ── THE LANES, worked out from the rows (nothing new is stored) ─────────────
  // Every run, earliest first and — at one step — HIGHEST first, into the first lane
  // it does not overlap: a chord's voices stack top-down, a line keeps its lane.
  // A NOTE STAYS IN THE LANE YOU PUT IT IN (`P.pins`, "midi:start" → lane, for the
  // session): placed or re-pitched notes are seated first, the rest fill in around them.
  function laneSplit(runs) {
    const all = [], pins = (P && P.pins) || {};
    Object.keys(runs).forEach((m) => (runs[m] || []).forEach((r) => all.push({ m: m | 0, s: r[0] | 0, l: Math.max(1, r[1] | 0) })));
    all.sort((a, b) => a.s - b.s || b.m - a.m);
    const lanes = [], free = (li, n) => !(lanes[li] || []).some((q) => n.s < q.s + q.l && q.s < n.s + n.l);
    const rest = [];
    all.forEach((n) => {
      const pl = pins[n.m + ':' + n.s];
      if (Number.isFinite(pl) && free(pl, n)) { while (lanes.length <= pl) lanes.push([]); lanes[pl].push(n); } else rest.push(n);
    });
    rest.forEach((n) => {
      let li = lanes.findIndex((ln, i) => free(i, n));
      if (li < 0) { lanes.push([]); li = lanes.length - 1; }
      lanes[li].push(n);
    });
    lanes.forEach((ln) => ln.sort((a, b) => a.s - b.s));
    return lanes;
  }
  // a pitch step: by the key's scale when there is one, else a semitone
  function stepPitch(L, m, n) {
    let spc = null; try { spc = V2.scaleAt(P.E, P.E.getCfg(), 0, L); } catch (e) { spc = null; }
    let x = m;
    for (let i = 0; i < Math.abs(n); i++) {
      x += Math.sign(n);
      if (spc) { let g = 0; while (!spc[((x % 12) + 12) % 12] && g++ < 12) x += Math.sign(n); }
    }
    return clamp(x, 12, 115);
  }
  // what a new chip in lane `li` at step `col` plays: its lane's nearest note, else the
  // lane above's less a third, else the layer's register on the key's root
  function pitchFor(L, li, col) {
    const ln = (P.lanes || [])[li] || [];
    const prev = ln.filter((q) => q.s <= col).pop() || ln.find((q) => q.s > col);
    if (prev) return prev.m;
    const up = (P.lanes || [])[li - 1];
    if (up && up.length) { const q = up.filter((x) => x.s <= col).pop() || up[0]; return stepPitch(L, q.m, -2); }
    let root = 0; try { const ks = V2.keyScaleAt(P.E, P.E.getCfg(), 0); if (ks) root = ks.root | 0; } catch (e) {}
    return clamp(12 * ((((L.instrument && L.instrument.register) | 0) || 4) + 1) + root, 12, 115);
  }
  function moveRun(L, from, to, start) {
    const rows = L.part.pitch.rows, a = rows[String(from)];
    if (!a) return;
    const run = (a.c || []).find((r) => (r[0] | 0) === start); if (!run) return;
    a.c = a.c.filter((r) => r !== run); if (!a.c.length) delete rows[String(from)];
    const b = rows[String(to)] || (rows[String(to)] = { c: [] });
    b.c = b.c.filter((r) => !(start < r[0] + r[1] && r[0] < start + run[1]));      // the chip lands on its own step
    b.c.push([start, run[1]]);
  }

  // ── ✎ DRAW: tap = on/off · drag ↕ = pitch · drag → = hold (kit: paint) ───────
  let DR = null, DRG = null;
  function onDown(ev) {
    if (!P || !ev.target.closest('.pe-grid')) return;
    const L = layer(); if (!L) return;
    const at = cellAt(ev); if (!at) return;
    DRG = at.g;          // the row the gesture started in (a drag may leave it)
    if (P.mode === 'compose') { P.cur = at.col; P.say = 'cursor → step ' + (at.col % spbOf(L) + 1) + ' of bar ' + (Math.floor(at.col / spbOf(L)) + 1); paint(); return; }
    // ◎ EDIT (2026-10-06, user: "clicking steps should add/remove note events, there
    // should be a separate Edit mode to edit each step"): a tap SELECTS a sounding step
    // for the Step panel and changes nothing; a tap on an empty step lets go.
    if (P.mode === 'edit') {
      if (isKit(L)) {
        const on = !!((lanesOf(L)[at.ri] || [])[at.col]);
        P.sel = on && !(P.sel && P.sel.kit && P.sel.li === at.ri && P.sel.col === at.col) ? { kit: true, li: at.ri, col: at.col } : null;
      } else {
        const n = ((P.lanes || [])[at.ri] || []).find((q) => at.col >= q.s && at.col < q.s + q.l);
        if (n) P.pins[n.m + ':' + n.s] = at.ri;
        P.sel = n && !(P.sel && !P.sel.kit && P.sel.m === n.m && P.sel.start === n.s) ? { m: n.m, start: n.s } : null;
      }
      P.say = P.sel ? '' : 'Tap a sounding step to edit it'; paint(); return;
    }
    beginEdit(L);
    if (isKit(L)) {
      const lanes = lanesOf(L), row = lanes[at.ri] || (lanes[at.ri] = []);
      if (row[at.col]) {                    // a lit step: a tap (or a drag) turns it off
        row[at.col] = 0;
        DR = { kit: true, ri: at.ri, val: 0, last: at.col, moved: false };
        P.say = (V2.LANE_NAMES || [])[at.ri] + ' off at step ' + (at.col + 1);
        paintLite();
      } else {
        row[at.col] = 1;
        DR = { kit: true, ri: at.ri, val: 1, last: at.col, moved: false };
        P.say = (V2.LANE_NAMES || [])[at.ri] + ' on at step ' + (at.col + 1);
        paintLite();
      }
    } else {
      const lanes0 = P.lanes || [];
      const n = (lanes0[at.ri] || []).find((q) => at.col >= q.s && at.col < q.s + q.l);
      ensureRows(L);
      // BY PITCH AND START, never by reference: every redraw reads the config, and the
      // normalizer REPLACES the rows (the orphan trap) — a held run object goes stale
      if (n) { DR = { kit: false, m: n.m, m0: n.m, start: n.s, existed: true, moved: false, axis: null, x0: ev.clientX, y0: ev.clientY }; P.pins[n.m + ':' + n.s] = at.ri; }
      else {
        const m = pitchFor(L, at.ri, at.col), rows = L.part.pitch.rows, row = rows[String(m)] || (rows[String(m)] = { c: [] });
        row.c = row.c.filter((r) => !(at.col >= r[0] && at.col < r[0] + r[1]));
        row.c.push([at.col, 1]);
        DR = { kit: false, m, m0: m, start: at.col, existed: false, moved: false, axis: null, x0: ev.clientX, y0: ev.clientY };
        P.pins[m + ':' + at.col] = at.ri;
        hear(L, m);
      }
      P.say = nameOf(DR.m) + ' at step ' + (DR.start + 1) + (DR.existed ? ' — drag ↕ for pitch, → to hold, tap to remove' : '');
      paintLite();
    }
    // FOLLOWED ON THE DOCUMENT, never by capture: the redraw replaces the grid element
    // mid-gesture, and a detached target's moves and release go nowhere
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }
  function onMove(ev) {
    if (!DR || !P) return;
    const L = layer(); if (!L) return;
    if (DR.kit) {
      const at = cellAt(ev, DRG); if (!at || at.col === DR.last) return;
      const row = lanesOf(L)[DR.ri];
      const a = Math.min(DR.last, at.col), z = Math.max(DR.last, at.col);
      for (let k = a; k <= z; k++) row[k] = DR.val;
      DR.last = at.col; DR.moved = true; paintLite(); return;
    }
    const dx = ev.clientX - DR.x0, dy = ev.clientY - DR.y0;
    if (!DR.axis) { if (Math.hypot(dx, dy) < 9) return; DR.axis = Math.abs(dx) > Math.abs(dy) ? 'len' : 'pitch'; }
    if (DR.axis === 'pitch') {
      const want = stepPitch(L, DR.m0, Math.round(-dy / 18));
      if (want !== DR.m) { const pl = P.pins[DR.m + ':' + DR.start]; delete P.pins[DR.m + ':' + DR.start]; moveRun(L, DR.m, want, DR.start); if (Number.isFinite(pl)) P.pins[want + ':' + DR.start] = pl; DR.m = want; DR.moved = true; hear(L, want); P.say = nameOf(want) + ' at step ' + (DR.start + 1); paintLite(); }
      return;
    }
    const at = cellAt(ev, DRG); if (!at) return;
    const len = Math.max(1, at.col - DR.start + 1), run = runOf(L, DR.m, DR.start);
    if (run && len !== run[1]) { run[1] = len; DR.moved = true; P.say = nameOf(DR.m) + ' holds ' + len + ' step' + (len === 1 ? '' : 's'); paintLite(); }
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    if (!DR || !P) return;
    const L = layer(); const d = DR; DR = null;
    if (!L) return;
    if (!d.kit && d.existed && !d.moved) {        // ✎ Draw: a tap on a sounding chip removes it
      const row = L.part.pitch.rows[String(d.m)];
      if (row) { row.c = row.c.filter((r) => (r[0] | 0) !== d.start); if (!row.c.length) delete L.part.pitch.rows[String(d.m)]; }
      P.say = nameOf(d.m) + ' removed';
    }
    commit(L);
  }
  // a redraw mid-gesture (the commit and its normalize wait for the release)
  function paintLite() { const sc = P.root.querySelector('.pe-body'); const t = sc ? sc.scrollTop : 0; paint(); const s2 = P.root.querySelector('.pe-body'); if (s2) s2.scrollTop = t; }

  // ── ⌨ COMPOSE ───────────────────────────────────────────────────────────────
  function advance(L, n) { const cells = cellsOf(L); P.cur = ((P.cur + n) % cells + cells) % cells; follow(L); }
  function follow() { P.followCur = true; }
  let chordAt = 0, chordCol = -1;
  function writeAtCursor(L, fn) {
    const now = Date.now(), together = now - chordAt < 90 && chordCol >= 0;
    const col = together ? chordCol : P.cur;
    beginEdit(L); fn(col);
    chordAt = now; chordCol = col;
    if (!together) advance(L, 1);
    commit(L);
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  function onClick(ev) {
    const b = ev.target.closest && ev.target.closest('[data-pe]'); if (!b || !P) return;
    const a = b.getAttribute('data-pe'), L = layer(); if (!L) return;
    if (a === 'done') { close(); return; }
    if (a === 'undo') { histStep(-1); return; }
    if (a === 'redo') { histStep(1); return; }
    if (a === 'play') { try { V2.preview(P.E, L); } catch (e) {} return; }
    if (a === 'mode') { P.mode = b.getAttribute('data-k'); P.say = P.mode === 'compose' ? 'Keys write at the teal cursor — tap the grid to move it' : (P.mode === 'edit' ? 'Tap a step to edit it — its note, length and place' : ''); if (P.mode === 'compose') follow(L); paint(); return; }
    if (a === 'sx') { P.sel = null; paint(); return; }
    if (a === 'snote' || a === 'shalf') { const d = +b.getAttribute('data-d'); editSel(L, (n) => ({ m: a === 'snote' ? stepPitch(L, n.m, d) : clamp(n.m + d, 12, 115), start: n.start, len: n.len })); return; }
    if (a === 'slen') { const d = +b.getAttribute('data-d'); editSel(L, (n, cells) => ({ m: n.m, start: n.start, len: clamp(n.len + d, 1, cells - n.start) })); return; }
    if (a === 'smove') { const d = +b.getAttribute('data-d'); editSel(L, (n, cells) => ({ m: n.m, start: clamp(n.start + d, 0, cells - n.len), len: n.len })); return; }
    if (a === 'sdup') {
      const s0 = P.sel, run = runOf(L, s0.m, s0.start); if (!run) return;
      const at2 = s0.start + run[1]; if (at2 + run[1] > cellsOf(L)) { P.say = 'no room after it'; paint(); return; }
      beginEdit(L);
      const row = L.part.pitch.rows[String(s0.m)];
      row.c = row.c.filter((r) => !(at2 < r[0] + r[1] && r[0] < at2 + run[1])); row.c.push([at2, run[1]]);
      const pl = P.pins[s0.m + ':' + s0.start]; if (Number.isFinite(pl)) P.pins[s0.m + ':' + at2] = pl;
      P.sel = { m: s0.m, start: at2 }; P.say = nameOf(s0.m) + ' copied to step ' + (at2 + 1); commit(L); return;
    }
    if (a === 'sdel') {
      if (P.sel && P.sel.kit) { beginEdit(L); lanesOf(L)[P.sel.li][P.sel.col] = 0; P.say = (V2.LANE_NAMES || [])[P.sel.li] + ' removed'; P.sel = null; commit(L); return; }
      editSel(L, () => ({ remove: true })); return;
    }
    if (a === 'kchance' || a === 'ktune') {
      const s0 = P.sel; if (!s0 || !s0.kit) return;
      beginEdit(L);
      const r = L.part.rhythm, k = s0.li + ':' + s0.col, fx = Object.assign({}, (r.cellFx || {})[k] || {});
      if (a === 'kchance') { const v = +b.getAttribute('data-v'); if (v >= 100) delete fx.c; else fx.c = v; }
      else { const t = clamp((fx.t | 0) + (+b.getAttribute('data-d')), -24, 24); if (t) fx.t = t; else delete fx.t; }
      r.cellFx = Object.assign({}, r.cellFx || {}); if (Object.keys(fx).length) r.cellFx[k] = fx; else delete r.cellFx[k];
      commit(L); return;
    }
    if (a === 'addlane') { P.want = Math.max(P.want | 0, (P.lanes || []).length) + 1; P.say = 'a new lane — tap a step in it'; paint(); return; }
    if (a === 'oct') { P.oct = clamp(P.oct + (+b.getAttribute('data-d')), 1, 7); paint(); return; }
    if (a === 'rest') { advance(L, 1); P.say = 'rest'; paint(); return; }
    if (a === 'back') { advance(L, -1); paint(); return; }
    if (a === 'nbar') { const spb = spbOf(L); P.cur = (Math.floor(P.cur / spb) + 1) * spb % cellsOf(L); follow(L); paint(); return; }
    if (a === 'clrstep') {
      beginEdit(L);
      if (isKit(L)) lanesOf(L).forEach((row) => { if (row) row[P.cur] = 0; });
      else if (rowsOf(L)) Object.keys(L.part.pitch.rows).forEach((k) => { const rw = L.part.pitch.rows[k]; rw.c = rw.c.filter((r) => r[0] !== P.cur); if (!rw.c.length) delete L.part.pitch.rows[k]; });
      P.say = 'step ' + (P.cur + 1) + ' cleared'; commit(L); return;
    }
    if (a === 'key') {
      const m = clamp((P.oct + 1) * 12 + (+b.getAttribute('data-pc')), 0, 127);
      hear(L, m);
      writeAtCursor(L, (col) => {
        ensureRows(L);
        const rows = L.part.pitch.rows, row = rows[String(m)] || (rows[String(m)] = { c: [] });
        row.c = row.c.filter((r) => !(col >= r[0] && col < r[0] + r[1]));
        row.c.push([col, 1]);
        P.say = nameOf(m) + ' at step ' + (col + 1);
      });
      return;
    }
    if (a === 'pad') {
      const li = +b.getAttribute('data-li');
      writeAtCursor(L, (col) => { const row = lanesOf(L)[li] || (lanesOf(L)[li] = []); row[col] = 1; P.say = (V2.LANE_NAMES || [])[li] + ' at step ' + (col + 1); });
    }
  }
  function onChange(ev) {
    const el = ev.target; if (!el || !P || el.getAttribute('data-pe') !== 'grid') return;
    const L = layer(); if (!L) return;
    beginEdit(L);
    const v = el.value | 0;
    if (v === 16) delete L.part.grid; else L.part.grid = v;     // the card's own rule (`.v2-gridpick`)
    commit(L);
  }

  const css = `
  .pe-ov{position:fixed;inset:0;z-index:10340;background:#0b0b18;display:flex !important}
  .pe{display:flex;flex-direction:column;width:100%;height:100%;color:#e6e3f5;font-family:'Segoe UI',system-ui,sans-serif;padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);box-sizing:border-box}
  .pe button{font:inherit;cursor:pointer}
  .pe-head{flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;background:#14142a;border-bottom:1px solid #2d2d4a}
  .pe-done{height:40px;padding:0 16px;border:0;border-radius:10px;background:#8b5cf6;color:#fff;font-weight:700}
  .pe-title{flex:1;min-width:0;display:flex;flex-direction:column;text-align:left;align-items:flex-start}.pe-title b{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pe-title small{font:700 11.5px 'Segoe UI',sans-serif;color:#7ef0dc}
  .pe-ib{width:40px;height:38px;border-radius:10px;border:1px solid #2d2d3f;background:#11111f;color:#c9c4ee;font-size:16px;padding:0;flex:none}
  .pe-ib:disabled,.pe-ib.pe-dim{opacity:.35}
  .pe-play{border-color:#2f8f80;background:#0f2a28;color:#cffaf3}
  .pe-tools{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px}
  .pe-seg{display:inline-flex;border:1px solid #2d2d3f;border-radius:18px;overflow:hidden;background:#11111f}
  .pe-seg button{height:36px;padding:0 12px;border:0;background:transparent;color:#a9a6c7;font-weight:700;font-size:13px}
  .pe-seg button.on{background:#17463f;color:#e6fffa}
  .pe-chip{height:36px;padding:0 12px;border-radius:18px;border:1px solid #2d2d3f;background:#11111f;color:#a9a6c7;font-weight:700;font-size:12.5px}
  .pe-chip.on{border-color:#2f8f80;background:#0f2a28;color:#cffaf3}
  .pe-gridsel{display:inline-flex;align-items:center;gap:4px;color:#8d8ab0;font-size:13px}
  .pe-gridsel select{height:36px;border-radius:10px;border:1px solid #2d2d3f;background:#0b0b18;color:#e6e3f5;font:inherit;font-size:13px;padding:0 6px}
  .pe-comp{flex:none;display:flex;flex-direction:column;gap:6px;padding:0 10px 8px}
  .pe-keys{display:flex;gap:6px}.pe-krows{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.pe-krow{display:flex;gap:4px}
  .pe-key{flex:1 1 0;min-width:0;height:40px;border:0;border-radius:7px;background:#e8e4f2;color:#2a2350;font-weight:800;font-size:12.5px;padding:0;touch-action:manipulation}
  .pe-key.blk{background:#26243a;color:#e9e3ff}
  .pe-oct{flex:0 0 40px;display:flex;flex-direction:column;align-items:center;gap:2px}.pe-oct span{font:800 12px 'Segoe UI',sans-serif;color:#c9c4ee}.pe-oct .pe-ib{height:32px}
  .pe-pads{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
  .pe-pad{height:42px;border:0;border-radius:9px;color:rgba(0,0,0,.66);font-weight:800;font-size:12px;padding:0 4px;touch-action:manipulation;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .pe-crow{display:flex;gap:6px}.pe-cb{flex:1 1 0;min-width:0;height:36px;overflow:hidden;text-overflow:ellipsis;border-radius:10px;border:1px solid #2d2d3f;background:#11111f;color:#c9c4ee;font-weight:700;font-size:12.5px;padding:0 4px;white-space:nowrap}
  .pe-del{color:#ff9c9c}
  .pe-ruler{flex:none;display:flex;height:30px;background:#141428;border-bottom:1px solid #2d2d4a}
  .pe-gut{flex:0 0 52px}.pe-gut.kit{flex-basis:92px}
  .pe-rcols{flex:1;min-width:0;display:flex;position:relative}
  .pe-rc{position:relative;box-sizing:border-box;overflow:visible;white-space:nowrap}
  .pe-rc.bar{border-left:1px solid rgba(200,190,240,.75)}
  .pe-rc.beat::before{content:'';position:absolute;left:0;bottom:0;height:7px;border-left:1px solid rgba(200,190,240,.4)}
  .pe-rc b{position:absolute;left:4px;top:6px;font-size:13px;color:#ece8f8}.pe-rc i{position:absolute;left:3px;top:9px;font:600 9.5px 'Segoe UI',sans-serif;color:#8d8ab0;font-style:normal}
  .pe-curtri{position:absolute;bottom:0;width:0;height:0;margin-left:-7px;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid #7ef0dc}
  .pe-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:4px 0 10px;overscroll-behavior:contain}
  .pe-blk{display:flex;flex-direction:column;flex:none}
  .pe-seghd{display:flex;align-items:baseline;gap:8px;padding:8px 10px 3px}.pe-seghd b{font:800 14px 'Segoe UI',sans-serif;color:#c9a0ff}.pe-seghd span{font:600 11px 'Segoe UI',sans-serif;color:#8d8ab0}
  .pe-seghd.pe-segcont{padding-top:2px}
  .pe-segrow{display:flex}
  .pe-gutcol.v{flex-basis:30px;background:#14142a;border-right:1px solid #2d2d4a}.pe-gutcol.v .pe-lane{padding:0 4px;justify-content:center;font-size:11px;color:#a9a6c7}.pe-gutcol.v .pe-lane i{display:none}
  .pe-gutcol{flex:0 0 52px;display:flex;flex-direction:column;background:#f4f2f8;align-self:flex-start}
  .pe-gutcol.kit{flex-basis:92px;background:#14142a;border-right:1px solid #2d2d4a}
  .pe-pk{position:relative;flex:none;box-sizing:border-box;border-bottom:1px solid rgba(20,20,35,.12)}
  .pe-pk em{position:absolute;left:5px;top:50%;transform:translateY(-50%);font:700 11.5px 'Segoe UI',sans-serif;color:#2a2350;font-style:normal;z-index:1}
  .pe-pk.blk::before{content:'';position:absolute;left:0;top:1px;bottom:1px;width:62%;background:#17161f}
  .pe-pk.blk em{color:#e9e3ff;font-size:10px;left:3px}
  .pe-pk.out::after{content:'';position:absolute;inset:0;background:rgba(40,38,60,.38)}
  .pe-lane{display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;font:700 12px 'Segoe UI',sans-serif;color:#ece8f8;white-space:nowrap;overflow:hidden;border-bottom:1px solid #1d1d33}
  .pe-lane i{flex:none;width:9px;height:9px;border-radius:5px}
  .pe-grid{position:relative;flex:1;min-width:0;touch-action:none;align-self:flex-start;-webkit-user-select:none;user-select:none}
  .pe-row{position:absolute;left:0;right:0;background:#12121f;border-bottom:1px solid #1d1d33;box-sizing:border-box;pointer-events:none}
  .pe-row.alt,.pe-row.blk{background:#0e0e1a}.pe-row.in{background:#17152b}.pe-row.out{background:#0a0a12}
  .pe-vl{position:absolute;top:0;bottom:0;width:1px;background:rgba(159,122,234,.07);pointer-events:none}
  .pe-vl.beat{background:rgba(159,122,234,.18)}.pe-vl.bar{background:rgba(159,122,234,.5)}
  .pe-st{position:absolute;border-radius:7px;box-sizing:border-box;pointer-events:none;display:flex;align-items:center;padding:0 5px;font:800 11px 'Segoe UI',sans-serif;color:#0b0b18;white-space:nowrap;overflow:hidden}
  .pe-st0{border:1px solid #2a2a44;background:#141426}
  .pe-st1{box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
  .pe-st1.cs{border-top-right-radius:0;border-bottom-right-radius:0}
  .pe-st1.cm{border-radius:0}.pe-st1.ce{border-top-left-radius:0;border-bottom-left-radius:0}
  .pe-st1.ook{box-shadow:inset 0 0 0 2px #f5b04a}
  .pe-st1.pe-sel{outline:3px solid #fff;outline-offset:-1px;z-index:2}
  .pe-st1.pe-chance{opacity:.5;background-image:repeating-linear-gradient(135deg,rgba(0,0,0,.25) 0 4px,transparent 4px 8px)}
  .pe-step{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:#17172b;border-top:1px solid #3a3a5c}
  .pe-sthead{display:flex;align-items:center;gap:8px}.pe-sthead b{font-size:15px}.pe-sthead span{flex:1;min-width:0;font:600 12px 'Segoe UI',sans-serif;color:#a9a6c7}
  .pe-strow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.pe-strow>span{width:52px;flex:none;font:600 12px 'Segoe UI',sans-serif;color:#a9a6c7}
  .pe-strow i{font:600 11px 'Segoe UI',sans-serif;color:#8d8ab0;font-style:normal}
  .pe-sb{min-width:40px;height:36px;padding:0 10px;border-radius:10px;border:1px solid #2d2d3f;background:#11111f;color:#c9c4ee;font-weight:700;font-size:13px}
  .pe-sb.on{border-color:#a78bfa;background:#2a2150;color:#fff}.pe-sx{min-width:36px;padding:0}
  .pe-num{min-width:64px;text-align:center;font-size:13px}
  .v2-patthumb{position:relative;display:flex;flex-direction:column;gap:3px;width:100%;margin:4px 0 0;padding:6px 6px 30px;border:1px solid #26264a;border-radius:10px;background:#0f0f1d;cursor:pointer;text-align:left;box-sizing:border-box}
  .v2-patthumb .pt-seg{display:flex;flex-direction:column;gap:3px}
  .v2-patthumb .pt-nm{font:700 10.5px 'Segoe UI',sans-serif;color:#c9a0ff;padding-left:1px}
  .v2-patthumb .pt-lane{display:grid;column-gap:2px;height:20px}
  .v2-patthumb .pt-c{min-width:0;border-radius:3px;background:#1a1a30;border:1px solid #26264a;box-sizing:border-box;overflow:visible;white-space:nowrap;position:relative;font:800 9.5px 'Segoe UI',sans-serif;color:#0b0b18;line-height:18px;padding-left:2px}
  .v2-patthumb .pt-c.bar{box-shadow:-2px 0 0 #4a4a6e}
  .v2-patthumb .pt-c.on{background:#5b93e0;border-color:#5b93e0;z-index:1}
  .v2-patthumb .pt-c.cs{border-top-right-radius:0;border-bottom-right-radius:0;margin-right:-2px}
  .v2-patthumb .pt-c.cm{border-radius:0;margin-left:-2px;margin-right:-2px}.v2-patthumb .pt-c.ce{border-top-left-radius:0;border-bottom-left-radius:0;margin-left:-2px}
  .v2-patthumb em{position:absolute;right:6px;bottom:5px;padding:2px 8px;border-radius:8px;border:1px solid #2f8f80;background:rgba(15,42,40,.92);color:#cffaf3;font:700 11px 'Segoe UI',sans-serif;font-style:normal}
  .pe-addlane{display:block;width:84px;margin:6px 4px;height:34px;border-radius:9px;border:1px dashed #3a3a5c;background:transparent;color:#a9a6c7;font-weight:700;font-size:12px}
  .pe-hit{position:absolute;border-radius:5px;box-sizing:border-box;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
  .pe-hit i{position:absolute;top:6px;bottom:6px;width:1px;background:rgba(255,255,255,.3)}
  .pe-cursor{position:absolute;top:0;bottom:0;background:rgba(126,240,220,.10);border-left:2px solid #7ef0dc;box-sizing:border-box;pointer-events:none}
  .pe-foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;background:#14142a;border-top:1px solid #2d2d4a}
  .pe-where{flex:1;min-width:0;text-align:center;font:600 12.5px 'Segoe UI',sans-serif;color:#a9a6c7;overflow-wrap:anywhere}.pe-where b{color:#cffaf3}
  `;

  const injectCss = () => { if (!document.getElementById('pe-css')) { const st = document.createElement('style'); st.id = 'pe-css'; st.textContent = css; document.head.appendChild(st); } };
  // ▭ THE CARD'S PICTURE OF A PITCHED PATTERN (2026-10-06, user: the card showed a row per
  // note and the editor collapsed them into lanes — "inconsistent"). The SAME lanes, the
  // whole part, read-only; a tap opens the editor (it carries `.v2-patedit`, the door).
  function thumbHtml(L) {
    injectCss();
    const E = (typeof _masterEng !== 'undefined') ? _masterEng : null; if (!E) return '';
    const cells = cellsOf(L), spb = spbOf(L), nb = barsOf(L);
    let lanes = [];
    try { lanes = laneSplit(pitchedRuns(L, E)); } catch (e) { lanes = []; }
    const cardW = Math.min(472, Math.max(240, window.innerWidth - 48));
    // A STEP GRID, not floating notes (2026-10-06, user: "it still should be a pattern
    // grid"), and ONE ROW PER CHANGE — or per bar when there are no changes (user: "each
    // Lane should have 1 row per change … or per bar if no changes"). Each row is that
    // stretch's steps for every lane, under its chord name; a hold crossing a row edge
    // continues on the next. Rows share one cell size, so a step lines up down the page.
    let segs = null;
    try { const cm = V2.changeSpans ? V2.changeSpans(E, L) : null; if (cm && cm.length > 1) segs = cm.map((c) => ({ a: Math.round(c.f0 * cells), z: Math.round(c.f1 * cells), nm: c.nm })); } catch (e) { segs = null; }
    if (segs) segs = segs.filter((g) => g.z > g.a);
    if (!segs || !segs.length) segs = Array.from({ length: nb }, (_, i) => ({ a: i * spb, z: Math.min(cells, (i + 1) * spb), nm: 'Bar ' + (i + 1) }));
    const wide = Math.max(...segs.map((g) => g.z - g.a));
    const cellW = cardW / wide;
    const rowsN = Math.max(1, lanes.length);
    let h = '<button type="button" class="v2-patedit v2-patthumb" aria-label="Open the pattern editor">';
    segs.forEach((g, gi) => {
      h += '<span class="pt-seg"><span class="pt-nm">' + esc(g.nm || ('Change ' + (gi + 1))) + '</span>';
      for (let li = 0; li < rowsN; li++) {
        const ln = lanes[li] || [];
        h += '<span class="pt-lane" style="grid-template-columns:repeat(' + wide + ',minmax(0,1fr))">';
        for (let k = g.a; k < g.z; k++) {
          const n = ln.find((q) => k >= q.s && k < q.s + q.l);
          let cls = 'pt-c';
          if (n) {
            const first = k === n.s || k === g.a, last = k === n.s + n.l - 1 || k === g.z - 1;
            cls += ' on' + ((first && last) ? '' : first ? ' cs' : last ? ' ce' : ' cm');
          }
          if (k > g.a && k % spb === 0) cls += ' bar';
          const lab = (n && (k === n.s || k === g.a) && cellW * Math.min(n.s + n.l, g.z) - cellW * k >= 22) ? nameOf(n.m) : '';
          h += '<span class="' + cls + '">' + lab + '</span>';
        }
        h += '</span>';
      }
      h += '</span>';
    });
    h += '<em>⤢ Edit</em></button>';
    return h;
  }
  V2.patternThumbHtml = thumbHtml;
  function open(E, L) {
    if (!E || !L || V2.formOf(L) !== 'steps') return false;
    if (P) close();
    injectCss();
    const root = document.createElement('div');
    // `.sm-overlay` IS LOAD-BEARING: each view hides every <body> child not on its allow-list
    root.className = 'sm-overlay pe-ov';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Pattern editor');
    document.body.appendChild(root);
    P = { E, id: L.id, root, mode: 'draw', cur: 0, oct: clamp(((L.instrument && L.instrument.register) | 0) || 4, 1, 7), hist: { u: [], r: [] }, say: '', want: 0, pins: {}, sel: null };
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('pointerdown', onDown);
    paint();
    return true;
  }
  function close() {
    if (!P) return;
    const E = P.E;
    try { V2.previewKill && V2.previewKill(E, { id: P.id }); } catch (e) {}
    try { P.root.remove(); } catch (e) {}
    P = null;
    try { V2.render(E); } catch (e) {}
  }
  if (!window.__pePatDoor) {
    window.__pePatDoor = true;
    document.addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest('.v2-patedit'); if (!b) return;
      const card = b.closest('.v2-layer[data-v2id]'); if (!card) return;
      const E = (typeof _masterEng !== 'undefined') ? _masterEng : null; if (!E) return;
      const id = card.getAttribute('data-v2id') | 0;
      const L = (E.getCfg().layers || []).find((x) => x && (x.id | 0) === id);
      if (L) { ev.preventDefault(); ev.stopPropagation(); open(E, L); }
    }, true);
    document.addEventListener('keydown', (e2) => {
      if (!P) return;
      if (e2.key === 'Escape') { close(); return; }
      const tg = e2.target, typing = tg && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || '');
      if (!typing && (e2.metaKey || e2.ctrlKey) && /^[zZyY]$/.test(e2.key)) { e2.preventDefault(); histStep((e2.key === 'y' || e2.key === 'Y' || e2.shiftKey) ? 1 : -1); }
    });
    window.addEventListener('resize', () => { if (P) paint(); });
  }
  V2.openPatternEditor = open;
  V2._patternEditorState = () => P;     // for probes: the open editor's state
})();
