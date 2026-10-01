// ✦ GENERATE V2 (beta, 2026-10-01) — the redesigned Generate sheet, built beside the old
// one so it can be played with on the real layer while the old sheet stays as it is.
//
// The design was settled in a mockup (claude.ai artifact U5BrtdDRv35NTqL84qBdho) and the
// decisions are recorded in the generate-sheet-redesign memory: Style first and collapsible,
// the result next (tap a bar to re-roll it, ↶ Undo), then tabs — Basics (Movement with its
// own settings inside the selected card; the Rhythm block you tap) · Rhythm · Pitch ·
// Variation · More. 🎲 marks a control a re-roll responds to.
//
// HOW IT EDITS: the REAL layer, live, so the transport plays every change as it is made.
// Opening snapshots the layer; ✕ puts the snapshot back, Done keeps the edits; every edit
// pushes a snapshot onto ↶ Undo. Restoring a snapshot replaces the layer's keys in place —
// the same move `draftCommit` makes — so nothing holding the layer object is orphaned.
// Everything goes through window._v2: the builders (make*), notesFor/withTake/pinOf for
// the drawing, newTake / preview. Nothing here reaches into the other IIFEs' privates.
(function () {
  'use strict';
  const V2 = window._v2;
  if (!V2) return;

  const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ── STYLES: the existing material doors, each with its colour ─────────────
  const STYLES = [
    { k: 'bass', name: 'Bass', col: '#60a5fa', icon: 'M4 18h4V9h4v9h4V6h4', make: (E, L) => V2.makeSimple(E, L, 'bass') },
    { k: 'line', name: 'Line', col: '#f472b6', icon: 'M3 16c3-8 6-8 9 0s6 8 9 0', make: (E, L) => V2.makeLine(E, L) },
    { k: 'arp', name: 'Arp', col: '#fb923c', icon: 'M4 18l4-6 4 4 4-8 4 4', make: (E, L) => V2.makeArp(E, L) },
    { k: 'pulse', name: 'Pulse', col: '#a3e635', icon: 'M4 12h3l2-6 3 12 2-6h6', make: (E, L) => V2.makeSimple(E, L, 'one') },
    { k: 'chords', name: 'Chords', col: '#e879f9', icon: 'M6 6v12M12 6v12M18 6v12', make: (E, L) => V2.makeMixed(E, L) },
    { k: 'drone', name: 'Drone', col: '#94a3b8', icon: 'M3 12h18', make: (E, L) => V2.makeSustain(E, L, true) },
    { k: 'beat', name: 'Beat', col: '#f87171', icon: 'M5 18V9M10 18V13M15 18V6M20 18V11', make: (E, L) => V2.makeBeat(E, L) },
    { k: 'ambience', name: 'Ambience', col: '#d6b98c', icon: 'M4 16c2-2 4-2 6 0s4 2 6 0 3-2 4-1', make: (E, L) => V2.makeSimple(E, L, 'scatter') },
  ];
  // A NEW LAYER (＋ Layer) is dressed by its first style the way the old "What kind of
  // layer?" sheet did (`V2.addStyled`'s recipes): its name and an instrument to match.
  const DRESS = { line: { tone: 'user:f-mallfountain', register: 5 }, arp: { tone: 'user:f-mallfountain', register: 5 },
    chords: { tone: 'user:f-velvet', register: 4 }, bass: { tone: 'user:f-undertow' }, ambience: { tone: 'user:f-glasscath', level: 45 },
    drone: { tone: 'user:f-meadow', register: 3 }, pulse: {}, beat: {} };
  function dress(E, L, s) {
    const taken = new Set((E.getCfg().layers || []).filter((x) => x && x.id !== L.id).map((x) => String(x.name || '')));
    let nm = s.name, k = 2; while (taken.has(nm)) nm = s.name + ' ' + (k++);
    L.name = nm;
    const d = DRESS[s.k] || {};
    L.instrument = L.instrument || {};
    if (d.tone) L.instrument.tone = d.tone;
    if (d.register) L.instrument.register = d.register;
    if (d.level) L.instrument.level = d.level;
  }
  // which style a layer IS, read back from its rules (best effort — a hand-tuned layer
  // may match none, and then no chip is lit)
  // `part.mat` is the material the layer was BUILT from — the same field the card's own
  // material row reads — so it wins; the rule-shape guesses below are only the fallback
  // for a layer tuned by hand away from any material (measured: a Drone guessed as Beat).
  const MAT_STYLE = { bass: 'bass', line: 'line', roll: 'line', melody: 'line', arp: 'arp', one: 'pulse', onenote: 'pulse',
    mixed: 'chords', confug: 'chords', ground: 'chords', sustain: 'drone', anchor: 'drone', beat: 'beat', scatter: 'ambience' };
  function styleOf(L) {
    const p = (L && L.part) || {}, r = p.rhythm || {}, t = p.pitch || {};
    if (p.kind !== 'live') return null;
    const m = (typeof p.mat === 'string') ? p.mat.replace(/^v1:/, '') : '';
    if (MAT_STYLE[m]) return MAT_STYLE[m];
    if (L.voice === 'kit' || (L.instrument && L.instrument.voice === 'kit')) return 'beat';
    if (t.kind === 'anchor' || p.sustain || (p.shape && p.shape.ring)) return 'drone';
    if (t.kind === 'mixed' || t.kind === 'chord') return 'chords';
    if (t.kind === 'series') return 'arp';
    if (t.kind === 'walk') return 'line';
    if (t.kind === 'chance') return 'ambience';
    if (t.kind === 'fixed' && (L.instrument && (L.instrument.register | 0) <= 2)) return 'bass';
    if (t.kind === 'fixed') return 'pulse';
    return null;
  }

  // ── MOVEMENT: one list for every style, written onto the real pitch fields ─
  const MOVES = [
    { k: 'same', label: 'Follow the chords', icon: 'M3 15h5M9.5 11h5M16 7h5' },
    { k: 'climb', label: 'Climb', icon: 'M3 19l4.5-3.5 4.5-3.5 4.5-3.5 4.5-3.5' },
    { k: 'fall', label: 'Fall', icon: 'M3 5l4.5 3.5 4.5 3.5 4.5 3.5 4.5 3.5' },
    { k: 'updown', label: 'Up & down', icon: 'M3 18l4.5-9 4.5 9 4.5-9 4.5 9' },
    { k: 'wander', label: 'Wander', icon: 'M3 14l3-3 3 2 3-5 3 4 3-2 3 1' },
    { k: 'any', label: 'Any chord tone', icon: 'M5 8h.01M12 17h.01M19 10h.01M9 13h.01M16 6h.01' },
    { k: 'pedal', label: 'One held note (pedal)', icon: 'M3 12h18' },
  ];
  function moveOf(L) {
    const t = ((L && L.part) || {}).pitch || {};
    if (t.kind === 'anchor') return 'pedal';
    if (t.kind === 'walk') return 'wander';
    if (t.kind === 'chance') return 'any';
    if (t.kind === 'series') return t.dir === 'down' ? 'fall' : (t.dir === 'updown' || t.dir === 'downup') ? 'updown' : 'climb';
    if (t.kind === 'fixed') {
      const mv = t.move || 'root';
      if (mv === 'up') return 'climb';
      if (mv === 'down') return 'fall';
      if (mv === 'updown') return 'updown';
      if (mv === 'any') return 'any';
      return 'same';
    }
    return null;
  }
  // the setting that lives INSIDE the selected Movement card
  const SUB = {
    same: { label: 'Plays the', suffix: 'of each chord', opts: ['Root', '3rd', '5th', '7th'],
      get: (L) => clamp(((L.part.pitch || {}).degree | 0) - 1, 0, 3),
      set: (L, i) => { L.part.pitch.degree = i + 1; } },
    climb: { label: 'Across', opts: ['1 octave', '2 octaves', '3 octaves'],
      get: (L) => clamp(((L.part.pitch || {}).octaves | 0) - 1, 0, 2), set: (L, i) => { L.part.pitch.octaves = i + 1; } },
    wander: { label: 'Range', opts: ['Narrow', 'Medium', 'Wide'],
      get: (L) => { const s = (L.part.pitch || {}).span | 0; return s >= 7 ? 2 : s >= 4 ? 1 : 0; },
      set: (L, i) => { L.part.pitch.span = [3, 5, 8][i]; } },
    any: { label: 'Leaps', opts: ['Small', 'Any size'],
      get: (L) => ((L.proximity | 0) > 30 ? 0 : 1), set: (L, i) => { L.proximity = i === 0 ? 70 : 0; } },
  };
  SUB.fall = SUB.climb; SUB.updown = SUB.climb;
  function applyMove(L, k) {
    const t = L.part.pitch = Object.assign({}, L.part.pitch || {});
    if (k === 'same') { t.kind = 'fixed'; t.move = 'root'; if (!(t.degree >= 1)) t.degree = 1; }
    else if (k === 'climb' || k === 'fall' || k === 'updown') { t.kind = 'series'; t.dir = (k === 'climb') ? 'up' : (k === 'fall') ? 'down' : 'updown'; if (!(t.octaves >= 1)) t.octaves = 2; }
    else if (k === 'wander') { t.kind = 'walk'; if (!(t.span >= 1)) t.span = 5; }
    else if (k === 'any') { t.kind = 'chance'; }
    else if (k === 'pedal') { t.kind = 'anchor'; }
  }

  // ── RHYTHM: figures as pictures, the bar you tap ──────────────────────────
  // The engine's own figure table (18-layer-v2 `FIGURES`), each written on a 16-step bar.
  const FIGS = [
    ['straight', 'Straight', [0, 4, 8, 12]], ['eighths', 'Eighths', [0, 2, 4, 6, 8, 10, 12, 14]],
    ['offbeat', 'Off-beat', [2, 6, 10, 14]], ['gallop', 'Gallop', [0, 3, 4, 8, 11, 12]],
    ['tresillo', 'Tresillo', [0, 3, 6, 8, 11, 14]], ['clave', 'Clave', [0, 3, 6, 10, 12]],
    ['bossa', 'Bossa', [0, 3, 6, 10, 13]], ['charleston', 'Charleston', [0, 6]],
    ['dotted', 'Dotted', [0, 3, 6, 9, 12, 15]], ['fourfloor', 'Four + pickup', [0, 4, 8, 12, 15]],
  ];
  const GRIDS = [[4, 'Quarters'], [8, 'Eighths'], [12, 'Triplets'], [16, 'Sixteenths'], [32, '32nds']];
  const barsOf = (L) => Math.max(0.25, +((L.part || {}).bars) || 1);
  const bpmOf = (cfg) => ((cfg && cfg.bpm > 0) ? cfg.bpm : ((typeof _ambBpm === 'function') ? _ambBpm() : 120));
  function spbOf(L) {
    const r = (L.part || {}).rhythm || {};
    if (r.kind === 'fig') return 16;
    return clamp(Math.round((r.steps | 0) / barsOf(L)) || 16, 1, 64);
  }

  // ── the 🎲 controls (a re-roll changes them) and the tab contents ─────────
  const S_ = (path, label, min, max, dice, unit) => ({ path, label, min, max, dice: !!dice, unit: unit || '' });
  const TABS = [
    { id: 'basics', label: 'Basics' },
    { id: 'rhythm', label: 'Rhythm', secs: [
      ['Rhythm feel', [S_('part.rhythm.figSync', 'Syncopation', 0, 100, 1), S_('part.rhythm.figGrp', 'Grouping', 0, 100, 1), S_('part.rhythm.figVar', 'Bar variation', 0, 100, 1),
        S_('part.rhythm.syncop', 'Syncopate', 0, 100), S_('restProb', 'Rests', 0, 100, 1, '%'), S_('ghosts', 'Ghosts', 0, 100, 1, '%'), S_('startVary', 'Start', 0, 100, 1)]],
      ['Note lengths', [S_('part.shape.lenRatio', 'Note length', 1, 400, 0, '%'), S_('lenVary', 'Length vary', 0, 100, 1),
        S_('part.shape.lenDepth', 'Shape depth', 0, 100), S_('part.shape.lenWeight', 'Shape weight', 0, 100)]],
    ] },
    { id: 'pitch', label: 'Pitch', secs: [
      ['Pitch', [S_('instrument.register', 'Register', 1, 8), S_('part.pitch.contour', 'Contour', -100, 100), S_('proximity', 'Proximity', 0, 100),
        S_('part.pitch.roam', 'Roam', 0, 100, 1), S_('part.pitch.randomness', 'Scatter', 0, 100, 1), S_('part.pitch.drift', 'Pitch vary', 0, 100, 1),
        S_('part.pitch.variety', 'Variety', 0, 100, 1)]],
    ] },
    { id: 'vary', label: 'Variation', secs: [
      ['Space & flourishes', [S_('breath.amount', '⏸ Breath', 0, 100, 1), S_('flourish.amount', '✦ Flourish', 0, 100, 1), S_('flourish.wild', 'Flourish size', 0, 100)]],
      ['Change over time', [S_('chg.ev', 'Evolve (passes)', 0, 64), S_('part.rhythm.vary', 'Vary', 0, 100, 1), S_('part.rhythm.rateVar', 'Rate var', 0, 100, 1),
        S_('phrasing', 'Phrasing', 0, 100, 1), S_('twist', 'Twist', 0, 100, 1)]],
    ] },
    { id: 'more', label: 'More', secs: [] },
  ];
  const getPath = (o, path) => path.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), o);
  function setPath(o, path, v) {
    const ks = path.split('.'); let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (!a[ks[i]] || typeof a[ks[i]] !== 'object') a[ks[i]] = {}; a = a[ks[i]]; }
    a[ks[ks.length - 1]] = v;
  }

  // ── the sheet ──────────────────────────────────────────────────────────────
  let G = null;   // { E, id, snap, hist, styleOpen, bar, tab, note }
  const layer = () => (G && G.E && (G.E.getCfg().layers || []).find((x) => x && x.id === G.id)) || null;
  function persist() {
    const E = G.E;
    try { E.getCfg(); } catch (e) {}
    try { if (E._v2Phase) delete E._v2Phase['v2:' + G.id]; } catch (e) {}
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    try { V2.render(E); } catch (e) {}
  }
  function snapNow() { const L = layer(); return L ? JSON.stringify(L) : null; }
  function edit(fn, note) {
    const L = layer(); if (!L) return;
    const before = JSON.stringify(L);
    try { fn(L); } catch (e) { try { console.warn('[genV2]', e); } catch (x) {} }
    persist();
    if (snapNow() !== before) G.hist.push(before);
    if (note !== undefined) G.note = note;
    paint();
  }
  function restore(json) {
    const R = layer(); if (!R || !json) return;
    Object.keys(R).forEach((k) => { delete R[k]; });
    Object.assign(R, JSON.parse(json));
    persist();
  }

  // the layer's REAL notes for one cycle — what the preview draws
  function notesNow(L) {
    const E = G.E, cfg = E.getCfg();
    const cyc = barsOf(L) * 240 / bpmOf(cfg);
    let ns = [];
    try {
      const ask = () => V2.notesFor(L, { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc });
      ns = V2.withEdit ? V2.withEdit(() => V2.withTake(V2.pinOf(L), ask)) : V2.withTake(V2.pinOf(L), ask);
    } catch (e) { ns = []; }
    return { ns: ns || [], cyc };
  }
  const midiOf = (f) => 69 + 12 * Math.log2(Math.max(1, f) / 440);

  // which steps of bar 0 sound, read off the real notes
  function barHits(L, ns, cyc) {
    const spb = spbOf(L), barSec = cyc / barsOf(L), lit = new Set();
    ns.forEach((n) => { if (n.at < barSec - 1e-6) lit.add(clamp(Math.round(n.at / barSec * spb), 0, spb - 1)); });
    return { spb, lit };
  }
  // write one bar's pattern as a DRAWN rhythm repeated across the part
  function writeBar(L, spb, lit) {
    const bars = Math.max(1, Math.round(barsOf(L)));
    const cells = [];
    for (let b = 0; b < bars; b++) for (let i = 0; i < spb; i++) cells.push(lit.has(i) ? 1 : 0);
    const r = L.part.rhythm = Object.assign({}, L.part.rhythm || {});
    r.kind = 'drawn'; r.steps = spb * bars; r.cells = cells; delete r.fig;
  }

  const css = `
  .g2-ov{position:fixed;inset:0;z-index:10350;background:rgba(5,5,12,.6);display:flex;align-items:flex-end;justify-content:center}
  .g2{width:100%;max-width:520px;max-height:94vh;display:flex;flex-direction:column;background:#12121f;color:#ece8f8;border:1px solid #2d2d4a;border-radius:20px 20px 0 0;overflow:hidden;font-size:15px}
  @media (min-width:700px){.g2-ov{align-items:center}.g2{border-radius:20px}}
  .g2 button{font:inherit;cursor:pointer}
  .g2-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 14px 12px 18px;border-bottom:1px solid #262640}
  .g2-body{flex:1;overflow-y:auto;padding:14px 14px 18px;display:flex;flex-direction:column;gap:16px;overscroll-behavior:contain}
  .g2-body>*{flex-shrink:0}
  .g2-foot{flex:none;display:flex;gap:8px;padding:10px 14px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid #262640}
  .g2-cap{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#a9a6c7}
  .g2-hint{font-size:13px;line-height:1.4;color:#a9a6c7}
  .g2-btn{min-height:44px;padding:0 14px;border-radius:12px;border:1px solid #3a3a5c;background:#1b1b30;color:#ece8f8;font-weight:600}
  .g2-btn.pri{flex-grow:1;border:0;background:#8b5cf6;color:#fff;font-weight:700}
  .g2-pill{min-height:38px;padding:0 10px;border-radius:10px;border:1px solid #3a3a5c;background:#1b1b30;color:#c9c5e3;font-size:13px;font-weight:600;min-width:0}
  .g2-pill.on{border:2px solid #a78bfa;background:#2a2150;color:#fff}
  .g2-grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
  .g2-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
  .g2-chip{min-width:0;height:62px;padding:0 4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-radius:14px;border:1px solid #3a3a5c;background:#1b1b30;color:#c9c5e3;font-size:12px;font-weight:600}
  .g2-roll{position:relative;height:150px;border-radius:14px;background:#0c0c18;border:1px solid #262640;overflow:hidden}
  .g2-mv{min-height:46px;padding:6px 10px;display:flex;align-items:center;gap:8px;border-radius:12px;border:1px solid #3a3a5c;background:#1b1b30;color:#c9c5e3;font-size:13px;font-weight:600;text-align:left}
  .g2-mvcard{grid-column:1/-1;border-radius:14px;border:2px solid #a78bfa;background:#211a40;overflow:hidden}
  .g2-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:4px;border-radius:14px;background:#15152a;border:1px solid #262640}
  .g2-tab{min-height:50px;padding:4px 2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:10px;border:0;background:transparent;color:#c9c5e3;font-size:13px;font-weight:600}
  .g2-tab.on{background:#8b5cf6;color:#fff}
  .g2-die{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:#0f3a36;color:#5eead4}
  .g2-row input[type=range]{width:100%;height:30px;accent-color:#9f7aea}
  .g2-row.dice input[type=range]{accent-color:#2dd4bf}
  .g2-step{height:22px;border-radius:5px;border:0;padding:0;background:#23233c}
  .g2-step.on{background:#a78bfa}
  `;
  const DIE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="2"></rect><circle cx="8.5" cy="8.5" r="1.7" fill="currentColor"></circle><circle cx="15.5" cy="8.5" r="1.7" fill="currentColor"></circle><circle cx="12" cy="12" r="1.7" fill="currentColor"></circle><circle cx="8.5" cy="15.5" r="1.7" fill="currentColor"></circle><circle cx="15.5" cy="15.5" r="1.7" fill="currentColor"></circle></svg>';
  const ico = (d, w) => '<svg width="' + (w || 22) + '" height="' + (w ? Math.round(w * 0.72) : 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"></path></svg>';

  function paint() {
    if (!G || !G.root) return;
    const L = layer();
    if (!L) { close(false); return; }
    const sk = styleOf(L), sty = STYLES.find((s) => s.k === sk);
    const live = L.part && L.part.kind === 'live';
    const { ns, cyc } = notesNow(L);
    const bars = barsOf(L), nb = Math.max(1, Math.ceil(bars));
    let h = '';
    // header
    h += '<div class="g2-head"><div style="flex-grow:1;min-width:0"><div style="font-size:20px;font-weight:700">' + (G.fresh ? 'New layer' : 'Generate') + ' <span style="font-size:12px;font-weight:700;color:#5eead4;vertical-align:middle">V2 beta</span></div>'
      + '<div class="g2-hint">for <b style="color:#ece8f8">' + esc(L.name || ('Layer ' + L.id)) + '</b></div></div>'
      + '<button type="button" class="g2-btn" data-a="cancel" aria-label="' + (G.fresh ? 'Remove this new layer and close' : 'Cancel and close') + '" style="width:44px;padding:0">✕</button></div>';
    h += '<div class="g2-body">';
    // 1. STYLE (collapsed once chosen)
    if (!G.styleOpen && sty) {
      h += '<div style="display:flex;align-items:center;gap:10px"><span class="g2-cap">Style</span>'
        + '<span style="display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:16px;font-size:13px;font-weight:700;border:1px solid ' + sty.col + ';background:' + sty.col + '26">' + ico(sty.icon, 16) + esc(sty.name) + '</span>'
        + '<button type="button" class="g2-btn" data-a="styleopen" style="margin-left:auto;min-height:40px">Change ▾</button></div>';
    } else {
      h += '<div style="display:flex;align-items:center;justify-content:space-between"><span class="g2-cap">Style</span>'
        + (sty ? '<button type="button" class="g2-btn" data-a="styleclose" style="min-height:36px">Close ▴</button>' : '') + '</div>'
        + '<div class="g2-grid4">' + STYLES.map((s) => '<button type="button" class="g2-chip" data-a="style" data-k="' + s.k + '"'
          + (s.k === sk ? ' style="border:2px solid ' + s.col + ';background:' + s.col + '26;color:#fff"' : '') + '>' + ico(s.icon) + '<span>' + esc(s.name) + '</span></button>').join('') + '</div>';
      if (!sty) h += '<div class="g2-hint">Pick a style — it builds this layer’s rules with generated content.</div>';
      if (G.fresh && !sty) h += '<button type="button" class="g2-btn" data-a="keepempty" style="align-self:flex-start;min-height:40px;color:#c9c5e3">Keep it empty — write it yourself</button>';
    }
    if (G.note) h += '<div class="g2-hint" style="color:#c9c5e3">' + esc(G.note) + '</div>';
    // 2. THE RESULT — the layer's real notes, tap a bar to re-roll it
    const mids = ns.map((n) => midiOf(n.freq));
    const lo = mids.length ? Math.min(...mids) - 1 : 48, hi = mids.length ? Math.max(...mids) + 1 : 72;
    const col = sty ? sty.col : '#a78bfa';
    h += '<div class="g2-roll">';
    for (let b = 0; b < nb; b++) {
      h += '<button type="button" data-a="bar" data-b="' + b + '" aria-label="Re-roll bar ' + (b + 1) + '" style="position:absolute;top:0;bottom:0;left:' + (b / bars * 100) + '%;width:' + (100 / bars) + '%;border:0;border-right:1px solid #2a2a46;background:' + (G.flash === b ? 'rgba(167,139,250,.18)' : 'transparent') + ';padding:0">'
        + '<span style="position:absolute;top:4px;left:6px;font-size:11px;color:#8d8ab0">' + (b + 1) + '</span></button>';
    }
    ns.forEach((n) => {
      const x = n.at / cyc * 100, w = Math.max(0.8, (n.durMs / 1000) / cyc * 100);
      const y = 16 + (1 - (midiOf(n.freq) - lo) / Math.max(1, hi - lo)) * 118;
      h += '<div style="position:absolute;pointer-events:none;left:' + x.toFixed(2) + '%;width:calc(' + w.toFixed(2) + '% - 1px);top:' + y.toFixed(1) + 'px;height:7px;border-radius:3px;background:' + col + '"></div>';
    });
    if (!ns.length) h += '<div class="g2-hint" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">' + (live ? 'Silent — these rules make no notes.' : 'Empty — pick a style to generate.') + '</div>';
    h += '</div>';
    h += '<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#a9a6c7"><span>' + ns.length + ' notes · ' + (Math.round(bars * 100) / 100) + ' bar' + (bars === 1 ? '' : 's') + (live ? ' · tap a bar to re-roll it' : '') + '</span>'
      + (G.hist.length ? '<button type="button" class="g2-btn" data-a="undo" style="margin-left:auto;min-height:34px;font-size:13px">↶ Undo' + (G.hist.length > 1 ? ' (' + G.hist.length + ')' : '') + '</button>' : '') + '</div>';
    if (G.rollNote) h += '<div class="g2-hint" style="padding:10px 12px;border-radius:12px;background:#0f2a28;border:1px solid #155e57;color:#b8f0e6">' + esc(G.rollNote) + '</div>';
    // 3. TABS
    h += '<div class="g2-tabs" role="tablist">' + TABS.map((t) => {
      const ctls = (t.secs || []).reduce((a, s) => a.concat(s[1]), []);
      const dice = ctls.some((c) => c.dice);
      const nCh = ctls.filter((c) => (+getPath(L, c.path) || 0) !== 0 && c.path !== 'instrument.register' && c.path !== 'part.shape.lenRatio').length;
      return '<button type="button" role="tab" class="g2-tab' + (G.tab === t.id ? ' on' : '') + '" data-a="tab" data-t="' + t.id + '" aria-selected="' + (G.tab === t.id) + '">' + esc(t.label)
        + '<span style="display:flex;gap:3px;height:14px;align-items:center">' + (dice ? '<span style="display:inline-flex;color:#5eead4">' + DIE + '</span>' : '')
        + (nCh ? '<span style="min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#a78bfa;color:#160f2e;font-size:11px;font-weight:800;line-height:16px;text-align:center">' + nCh + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
    if (!live) {
      h += '<div class="g2-hint">This part plays notes written by hand. Pick a style above to hand it to generated rules — ↶ Undo or ✕ brings the written notes back.</div>';
    } else if (G.tab === 'basics') {
      h += basicsHTML(L, ns, cyc);
    } else {
      h += tabHTML(L, TABS.find((t) => t.id === G.tab));
    }
    h += '</div>';
    // footer
    h += '<div class="g2-foot"><button type="button" class="g2-btn" data-a="take"' + (live ? '' : ' disabled') + '>🎲 New take</button>'
      + '<button type="button" class="g2-btn" data-a="preview" aria-label="Preview" style="width:48px;padding:0">▶</button>'
      + '<button type="button" class="g2-btn pri" data-a="done">Done</button></div>';
    const sc = G.root.querySelector('.g2-body'), top = sc ? sc.scrollTop : 0;
    G.box.innerHTML = h;
    const sc2 = G.root.querySelector('.g2-body'); if (sc2) sc2.scrollTop = top;
  }

  function basicsHTML(L, ns, cyc) {
    let h = '';
    // MOVEMENT — the selected option is a card holding its own setting
    const mv = moveOf(L);
    if (styleOf(L) === 'beat') {
      h += '<div style="display:flex;flex-direction:column;gap:6px"><b>Movement</b><div class="g2-hint">Beat plays drums, so there is no pitch to move — shape it with Rhythm below.</div></div>';
    } else {
    // COLLAPSES LIKE STYLE: once an option is chosen only its card shows (with its own
    // setting still inside it — the thing you reach for most) and "Change ▾" opens the list
    const openList = G.moveOpen || !mv;
    h += '<div style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;align-items:center;gap:8px"><b>Movement</b>'
      + (mv ? '<button type="button" class="g2-btn" data-a="' + (openList ? 'moveclose' : 'moveopen') + '" style="margin-left:auto;min-height:36px">' + (openList ? 'Close ▴' : 'Change ▾') + '</button>' : '')
      + '</div><div class="g2-grid2">';
    MOVES.forEach((m) => {
      if (m.k !== mv) { if (openList) h += '<button type="button" class="g2-mv" data-a="move" data-k="' + m.k + '">' + ico(m.icon, 26) + '<span>' + esc(m.label) + '</span></button>'; return; }
      const sb = SUB[m.k];
      h += '<div class="g2-mvcard"><div style="min-height:46px;padding:6px 12px;display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700">' + ico(m.icon, 26) + '<span>' + esc(m.label) + '</span><span style="margin-left:auto;color:#a78bfa">✓</span></div>'
        + '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px 12px;border-top:1px solid #3b2f6e;background:#1a1534">';
      if (sb) {
        const cur = sb.get(L);
        h += '<span class="g2-hint" style="color:#c9c5e3">' + esc(sb.label) + '</span><div style="display:grid;grid-template-columns:repeat(' + sb.opts.length + ',minmax(0,1fr));gap:4px;flex-grow:1;min-width:170px">'
          + sb.opts.map((o, i) => '<button type="button" class="g2-pill' + (i === cur ? ' on' : '') + '" data-a="sub" data-k="' + m.k + '" data-i="' + i + '">' + esc(o) + '</button>').join('') + '</div>'
          + (sb.suffix ? '<span class="g2-hint" style="color:#c9c5e3">' + esc(sb.suffix) + '</span>' : '');
      } else {
        h += '<span class="g2-hint" style="color:#c9c5e3">Holds the one note that fits the most chords in the part.</span>';
      }
      h += '</div></div>';
    });
    h += '</div></div>';
    }
    // RHYTHM — figures as pictures, the bar you tap, the grid
    const r = (L.part.rhythm || {});
    const { spb, lit } = barHits(L, ns, cyc);
    h += '<div style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;align-items:center;gap:8px"><b>Rhythm</b>'
      + '<span class="g2-hint" style="margin-left:auto">' + lit.size + ' hit' + (lit.size === 1 ? '' : 's') + ' a bar</span>'
      + '<button type="button" class="g2-btn" data-a="hits" data-d="-1" aria-label="Fewer hits" style="width:40px;min-height:36px;padding:0">−</button>'
      + '<button type="button" class="g2-btn" data-a="hits" data-d="1" aria-label="More hits" style="width:40px;min-height:36px;padding:0">+</button></div>';
    h += '<div class="g2-hint">Tap a step to add or remove a hit — every bar plays this pattern.</div>';
    // the bar, beat-grouped
    const per = Math.max(1, Math.round(spb / 4));
    h += '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px">';
    for (let b = 0; b < 4; b++) {
      const a = Math.round(b * spb / 4), z = Math.round((b + 1) * spb / 4);
      h += '<div style="display:flex;flex-direction:column;gap:3px;min-width:0"><span style="font-size:11px;color:#8d8ab0">' + (b + 1) + '</span><div style="display:grid;grid-template-columns:repeat(' + Math.max(1, z - a) + ',minmax(0,1fr));gap:' + (spb > 24 ? 2 : 3) + 'px">';
      for (let i = a; i < z; i++) h += '<button type="button" class="g2-step' + (lit.has(i) ? ' on' : '') + '" data-a="step" data-i="' + i + '" aria-label="Step ' + (i + 1) + (lit.has(i) ? ', on' : ', off') + '"></button>';
      h += '</div></div>';
    }
    void per;
    h += '</div>';
    // figure presets as pictures
    h += '<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:2px">' + FIGS.map(([id, nm, st]) => {
      const on = r.kind === 'fig' && r.fig === id;
      const dots = Array.from({ length: 16 }, (_, i) => '<span style="width:4px;height:8px;border-radius:2px;background:' + (st.indexOf(i) >= 0 ? (on ? '#fff' : '#a78bfa') : '#33334f') + '"></span>').join('');
      return '<button type="button" class="g2-pill' + (on ? ' on' : '') + '" data-a="fig" data-k="' + id + '" style="flex:none;display:flex;flex-direction:column;gap:4px;padding:6px 8px;min-height:52px"><span>' + esc(nm) + '</span><span style="display:flex;gap:1px">' + dots + '</span></button>';
    }).join('') + '</div>';
    h += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px"><span class="g2-hint">Grid</span>' + GRIDS.map(([n, nm]) =>
      '<button type="button" class="g2-pill' + (spb === n && r.kind !== 'fig' ? ' on' : '') + '" data-a="grid" data-n="' + n + '">' + esc(nm) + '</button>').join('')
      + '<label class="g2-hint" style="display:flex;align-items:center;gap:6px">Steps <input type="number" inputmode="numeric" min="1" max="64" value="' + spb + '" data-a="gridn" style="width:58px;height:36px;border-radius:9px;border:1px solid #3a3a5c;background:#1b1b30;color:#fff;text-align:center;font:inherit"></label></div>';
    h += '</div>';
    return h;
  }

  function tabHTML(L, t) {
    let h = '';
    if (t.id === 'more') {
      const hm = L.harmony || 'fixed';
      h += '<div style="display:flex;flex-direction:column;gap:8px"><span class="g2-cap">Chords moving under written notes</span><div style="display:flex;gap:6px;flex-wrap:wrap">'
        + [['fixed', 'Play as written'], ['diatonic', 'Stay in key'], ['chordlock', 'Lock to chord']].map(([k, nm]) =>
          '<button type="button" class="g2-pill' + (hm === k ? ' on' : '') + '" data-a="harm" data-k="' + k + '">' + esc(nm) + '</button>').join('') + '</div>'
        + '<div class="g2-hint">Answer another layer, Key & notes and the full Recipe are still in the classic Generate for now.</div></div>';
      return h;
    }
    if ((t.secs || []).some((s) => s[1].some((c) => c.dice))) {
      h += '<div style="display:flex;align-items:center;gap:8px" class="g2-hint"><span style="display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px 0 6px;border-radius:11px;background:#0f3a36;color:#5eead4;font-size:12px;font-weight:700">' + DIE + 're-rolls</span>these change every time you re-roll</div>';
    }
    t.secs.forEach(([nm, ctls]) => {
      h += '<div style="display:flex;flex-direction:column;gap:12px"><span class="g2-cap">' + esc(nm) + '</span>';
      ctls.forEach((c) => {
        const v = +getPath(L, c.path) || (c.path === 'instrument.register' ? 4 : 0);
        h += '<div class="g2-row' + (c.dice ? ' dice' : '') + '" style="display:flex;flex-direction:column;gap:2px"><div style="display:flex;align-items:center;gap:6px;font-size:14px"><b>' + esc(c.label) + '</b>'
          + (c.dice ? '<span class="g2-die" title="Changes when you re-roll">' + DIE + '</span>' : '')
          + '<span class="g2-hint g2-val" style="margin-left:auto">' + v + esc(c.unit) + '</span></div>'
          + '<input type="range" min="' + c.min + '" max="' + c.max + '" value="' + v + '" data-a="ctl" data-p="' + esc(c.path) + '" data-u="' + esc(c.unit) + '" aria-label="' + esc(c.label) + '"></div>';
      });
      h += '</div>';
    });
    return h;
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function onClick(ev) {
    const b = ev.target.closest && ev.target.closest('[data-a]'); if (!b || !G) return;
    const a = b.getAttribute('data-a'), E = G.E;
    if (a === 'cancel') { close(true); return; }
    if (a === 'keepempty') { close(false); return; }
    if (a === 'done') { close(false); return; }
    if (a === 'styleopen') { G.styleOpen = true; paint(); return; }
    if (a === 'styleclose') { G.styleOpen = false; paint(); return; }
    if (a === 'tab') { G.tab = b.getAttribute('data-t'); paint(); return; }
    if (a === 'undo') { const j = G.hist.pop(); restore(j); G.note = 'Undone.'; G.rollNote = ''; paint(); return; }
    if (a === 'preview') { try { V2.preview(E, layer()); } catch (e) {} return; }
    if (a === 'style') {
      const s = STYLES.find((x) => x.k === b.getAttribute('data-k')); if (!s) return;
      const was = styleOf(layer());
      const dressIt = G.fresh && !G.dressed;
      edit((L) => { if (dressIt) dress(E, L, s); s.make(E, L); }, 'Now ' + s.name + ' — its own rules, with your sound unchanged.' + (was && was !== s.k ? ' ↶ Undo goes back to ' + (STYLES.find((x) => x.k === was) || {}).name + '.' : ''));
      if (dressIt) G.dressed = true;
      G.styleOpen = false; G.rollNote = ''; paint(); return;
    }
    if (a === 'moveopen') { G.moveOpen = true; paint(); return; }
    if (a === 'moveclose') { G.moveOpen = false; paint(); return; }
    if (a === 'move') { const k = b.getAttribute('data-k'); G.moveOpen = false; edit((L) => applyMove(L, k), ''); return; }
    if (a === 'sub') { const k = b.getAttribute('data-k'), i = +b.getAttribute('data-i'); edit((L) => { applyMove(L, k); SUB[k].set(L, i); }, ''); return; }
    if (a === 'harm') { const k = b.getAttribute('data-k'); edit((L) => { if (k === 'fixed') delete L.harmony; else L.harmony = k; }, ''); return; }
    if (a === 'take') { edit((L) => { V2.newTake(L); }, 'A new take of the same rules.'); return; }
    if (a === 'fig') { const id = b.getAttribute('data-k'); edit((L) => { const r = L.part.rhythm = Object.assign({}, L.part.rhythm || {}); r.kind = 'fig'; r.fig = id; }, ''); return; }
    if (a === 'grid') {
      const n = +b.getAttribute('data-n');
      edit((L) => {
        const { ns, cyc } = notesNow(L), cur = barHits(L, ns, cyc), lit = new Set();
        cur.lit.forEach((i) => lit.add(clamp(Math.round(i * n / cur.spb), 0, n - 1)));
        writeBar(L, n, lit);
      }, ''); return;
    }
    if (a === 'step' || a === 'hits') {
      edit((L) => {
        const { ns, cyc } = notesNow(L), cur = barHits(L, ns, cyc), lit = new Set(cur.lit);
        if (a === 'step') { const i = +b.getAttribute('data-i'); if (lit.has(i)) lit.delete(i); else lit.add(i); }
        else {
          const want = clamp(lit.size + (+b.getAttribute('data-d')), 1, cur.spb);
          lit.clear(); for (let k = 0; k < want; k++) lit.add(Math.floor(k * cur.spb / want));
        }
        writeBar(L, cur.spb, lit);
      }, ''); return;
    }
    if (a === 'bar') {
      const L = layer(); if (!L || !(L.part && L.part.kind === 'live')) return;
      const bi = +b.getAttribute('data-b');
      const before = notesNow(L).ns.map((n) => Math.round(n.at * 1000) + ':' + Math.round(midiOf(n.freq))).join(',');
      edit((L2) => {
        const p = L2.part, key = V2.regBarKey(bi);
        p.takeb = Object.assign({}, p.takeb || {});
        const cur = Number.isFinite(p.takeb[key]) ? p.takeb[key] : ((V2.takeOf ? V2.takeOf(L2) : (p.take | 0)) | 0);
        p.takeb[key] = (cur + 1) % 1000000;
      }, '');
      const after = notesNow(layer()).ns.map((n) => Math.round(n.at * 1000) + ':' + Math.round(midiOf(n.freq))).join(',');
      if (after === before) {
        // NOTHING RANDOM HERE: the same rules give the same bar. Move its hits to new
        // steps instead (a seeded rotation of this bar), and say so — never a silent no-op.
        G.hist.pop();   // the no-op pin is not worth an undo step
        edit((L3) => {
          const { ns, cyc } = notesNow(L3), spb = spbOf(L3), bars = Math.max(1, Math.round(barsOf(L3))), barSec = cyc / barsOf(L3);
          const cells = [];
          for (let k = 0; k < bars; k++) for (let i = 0; i < spb; i++) cells.push(0);
          ns.forEach((n) => { cells[clamp(Math.round(n.at / barSec * spb), 0, cells.length - 1)] = 1; });
          const sl = cells.slice(bi * spb, (bi + 1) * spb), rot = 1 + ((G.hist.length * 5 + bi * 3) % Math.max(1, spb - 1));
          for (let i = 0; i < spb; i++) cells[bi * spb + ((i + rot) % spb)] = sl[i];
          const r = L3.part.rhythm = Object.assign({}, L3.part.rhythm || {});
          r.kind = 'drawn'; r.steps = spb * bars; r.cells = cells; delete r.fig;
        }, '');
        G.rollNote = 'Nothing here is random yet, so bar ' + (bi + 1) + ' kept its notes and moved them to new steps. Turn up a 🎲 control (Rhythm or Variation tab) to get new notes.';
      } else {
        G.rollNote = 'Bar ' + (bi + 1) + ' re-rolled.';
      }
      G.flash = bi; paint();
      setTimeout(() => { if (G && G.flash === bi) { G.flash = -1; paint(); } }, 450);
    }
  }
  function onInput(ev) {
    const el = ev.target; if (!el || el.getAttribute('data-a') !== 'ctl') return;
    const v = el.closest('.g2-row') && el.closest('.g2-row').querySelector('.g2-val');
    if (v) v.textContent = el.value + (el.getAttribute('data-u') || '');
  }
  function onChange(ev) {
    const el = ev.target; if (!el || !G) return;
    const a = el.getAttribute('data-a');
    if (a === 'ctl') { const p = el.getAttribute('data-p'), val = +el.value; edit((L) => setPath(L, p, val), ''); }
    if (a === 'gridn') {
      const n = clamp(parseInt(el.value, 10) || 16, 1, 64);
      edit((L) => {
        const { ns, cyc } = notesNow(L), cur = barHits(L, ns, cyc), lit = new Set();
        cur.lit.forEach((i) => lit.add(clamp(Math.round(i * n / cur.spb), 0, n - 1)));
        writeBar(L, n, lit);
      }, '');
    }
  }

  function close(cancel) {
    if (!G) return;
    if (cancel && G.fresh) {
      // ✕ on a layer made a moment ago by ＋ Layer = "never mind": remove it, the same way
      // the card's ✕ Remove layer does (by id — the captured object may be an orphan)
      const E = G.E, id = G.id;
      try { const c2 = E.getCfg(); c2.layers = (c2.layers || []).filter((x) => !(x && x.id === id)); } catch (e) {}
      try { if (E._v2Phase) delete E._v2Phase['v2:' + id]; } catch (e) {}
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      try { V2.render(E); } catch (e) {}
    } else if (cancel && G.snap) { restore(G.snap); }
    try { G.root.remove(); } catch (e) {}
    G = null;
  }

  // ── THE DOOR, where Generate already is ───────────────────────────────────
  // The card's section grid (Instrument · Generate · Tweaks · Mix · FX · Bank) is drawn
  // by 18-layer-v2 and rebuilt whenever the card is; rather than reach into that, this
  // finds the grid by its Bank button and puts one full-width button under it, styled
  // as the Generate button it sits beneath. Re-placed after every rebuild (observer,
  // coalesced to one pass a frame). The ⋯ menu item stays as the second way in.
  function placeDoors() {
    document.querySelectorAll('.v2-layer[data-v2id]').forEach((card) => {
      const btns = Array.from(card.querySelectorAll('button'));
      const bank = btns.find((x) => x.textContent.trim() === 'Bank');
      const gen = btns.find((x) => x.textContent.trim() === 'Generate');
      if (!bank || !bank.parentElement) return;
      const grid = bank.parentElement;
      const next = grid.nextElementSibling;
      if (next && next.classList && next.classList.contains('g2-door')) return;
      const d = document.createElement('button');
      d.type = 'button';
      d.className = (gen ? gen.className : 'ambient-seg') + ' g2-door';
      d.textContent = '\u2726 Generate V2 (beta)';
      d.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:8px 0 0;color:#5eead4';
      d.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const id = card.getAttribute('data-v2id') | 0;
        const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
        const L = E && (E.getCfg().layers || []).find((x) => x && (x.id | 0) === id);
        if (L) window._genV2Open(E, L);
      });
      grid.insertAdjacentElement('afterend', d);
    });
  }
  try {
    // ONLY ELEMENT ADDITIONS (a card rebuilt), never text: the live readouts rewrite text
    // every frame while playing, and a door scan per frame is a cost an old phone feels.
    let timer = 0;
    new MutationObserver((recs) => {
      if (timer) return;
      let grew = false;
      for (let i = 0; i < recs.length && !grew; i++) {
        const an = recs[i].addedNodes;
        for (let j = 0; j < an.length; j++) { if (an[j].nodeType === 1 && !(an[j].classList && an[j].classList.contains('g2-door'))) { grew = true; break; } }
      }
      if (!grew) return;
      timer = setTimeout(() => { timer = 0; try { placeDoors(); } catch (e) {} }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) {}

  window._genV2Open = function (E, L, opts) {
    if (!E || !L) return false;
    if (G) close(false);
    if (!document.getElementById('g2-css')) {
      const st = document.createElement('style'); st.id = 'g2-css'; st.textContent = css; document.head.appendChild(st);
    }
    const root = document.createElement('div');
    // `.sm-overlay` IS LOAD-BEARING: each view hides every <body> child not on an
    // allow-list (bloops.css `body.view-mix > *:not(.sm-overlay)…`), so a new overlay
    // without it measures 0×0 — "reported as missing, not as hidden".
    root.className = 'sm-overlay g2-ov';
    root.style.setProperty('display', 'flex', 'important');
    root.innerHTML = '<div class="g2" role="dialog" aria-modal="true" aria-label="Generate V2"></div>';
    document.body.appendChild(root);
    G = { E, id: L.id, fresh: !!(opts && opts.fresh), snap: JSON.stringify(L), hist: [], styleOpen: !styleOf(L), tab: 'basics', note: '', rollNote: '', flash: -1, root, box: root.querySelector('.g2') };
    root.addEventListener('click', (ev) => { if (ev.target === root) { close(false); return; } onClick(ev); });
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    paint();
    return true;
  };
})();
