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
    // A SET GENERATE BUILT FOLLOWS THE NEW SOUND — its related voices were picked
    // for the old one. A hand-edited set is the user's and is left as it is.
    try {
      const gm = (d.tone && typeof _ambToneSetGenOf === 'function') ? _ambToneSetGenOf(L) : '';
      if (gm && gm !== 'own') { const q = _ambToneSetBuild(L, gm, E._cfg); if (q) L.toneSeq = q; }
    } catch (e) {}
    if (d.register) L.instrument.register = d.register;
    if (d.level) L.instrument.level = d.level;
    // THE SOUND'S OWN ENVELOPE. A layer's Attack/Decay/Sustain/Release always
    // override the sound's (they are caller-owned in `_sdMergeUserPatch`), and a
    // new layer starts on pad defaults (400 ms in, 1200 ms out) — so a Bass of
    // 350 ms notes never finished fading in while 1.2 s tails piled up: the
    // level pumped (reported 2026-10-01, "weird volume changes with Bass").
    adoptEnv(L, d.tone, s.k);
  }
  const STYLE_ENV = { pulse: { attack: 5, decay: 180, sustain: 60, release: 260 } };
  function adoptEnv(L, tone, k) {
    let env = null;
    try { const up = (tone && typeof _resolveUserPatch === 'function') ? _resolveUserPatch(tone) : null; if (up && up.params) env = up.params; } catch (e) {}
    env = env || STYLE_ENV[k]; if (!env) return;
    ['attack', 'decay', 'sustain', 'release'].forEach((x) => { if (Number.isFinite(env[x])) L.instrument[x] = env[x]; });
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
    // A FROZEN TAKE (⋯ Lock, a pencil edit) keeps its rules beside the notes —
    // name the style it was made in; only notes written from scratch have none.
    if (p.kind !== 'live' && !(p.kind === 'recorded' && p.made === 'take')) return null;
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
  const KEYW = 34;   // the preview's key column — the Pattern rows indent by it so steps line up
  const GRIDS = [[4, 'Quarters'], [8, 'Eighths'], [12, 'Triplets'], [16, 'Sixteenths'], [32, '32nds']];
  const barsOf = (L) => Math.max(0.25, +((L.part || {}).bars) || 1);
  const bpmOf = (cfg) => ((cfg && cfg.bpm > 0) ? cfg.bpm : ((typeof _ambBpm === 'function') ? _ambBpm() : 120));
  // ◫ FILL = PER BAR: with `barsMode: 'fill'` the engine solves a euclid/pulse
  // rule over ONE bar and tiles it (18-layer-v2 onsets), so its steps ARE a bar
  const perBarRule = (L) => { const p = L.part || {}, k = (p.rhythm || {}).kind; return p.barsMode === 'fill' && barsOf(L) > 1 + 1e-9 && (k === 'euclid' || k === 'pulse'); };
  function spbOf(L) {
    const r = (L.part || {}).rhythm || {};
    if (r.kind === 'fig') return 16;
    if (perBarRule(L)) {
      if (r.kind === 'euclid') return clamp((r.steps | 0) || 16, 1, 64);
      const n = Math.max(1, r.n | 0); return (16 % n === 0) ? 16 : clamp(n, 1, 64);
    }
    return clamp(Math.round((r.steps | 0) / barsOf(L)) || 16, 1, 64);
  }

  // ── the 🎲 controls (a re-roll changes them) and the tab contents ─────────
  const S_ = (path, label, min, max, dice, unit, w) => ({ path, label, min, max, dice: !!dice, unit: unit || '', w: w || '' });
  // a CHOICE tile: a menu shown as a tile; the popover lists the options.
  // `opts` is [[key, label, tip?], …] (or a function of the layer); keys are
  // strings, `num` stores them as numbers, '' clears the field.
  const C_ = (path, label, opts, w, x) => Object.assign({ path, label, choice: true, opts, w: w || '' }, x || {});
  // ── THE DIALS (2026-10-01, user: "these seemingly endless lists of sliders are
  // totally unwieldy and inscrutable"): each control is a TILE with a small gauge;
  // a tap opens one large dial with what it does and what each end means. A
  // control that does nothing for this rhythm/pitch is dimmed and says why —
  // half the list was inert on a Line and looked exactly like the live half.
  // `def` is what an ABSENT value means to the engine (Shape depth/weight are
  // 100 when absent — the old sliders read absent as 0).
  const getPath = (o, path) => path.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), o);
  const rk = (L) => ((L.part || {}).rhythm || {}).kind, pk = (L) => ((L.part || {}).pitch || {}).kind;
  const straightOn = (L) => !!(((L.part || {}).rhythm || {}).straight);
  const lenShapeOn = (L) => !!((L.part || {}).shape && L.part.shape.lenShape);
  const only = (ok, why) => (L) => (ok(L) ? null : why);
  const META = {
    'part.rhythm.figSync': { what: 'How often a hit that falls on a beat is pushed off it, onto the off-beat.', lo: 'every hit where the figure puts it', hi: 'pushed off the beat whenever it can be' },
    'part.rhythm.figGrp': { what: 'Moves the hits from evenly spaced toward clusters: this is where 3 + 3 + 2 and every gallop come from.', lo: 'evenly spaced', hi: 'tightly clustered' },
    'part.rhythm.figVar': { what: 'How much the later bars differ from the first. Bar 1 always plays the figure as named.', lo: 'every bar the same', hi: 'every bar different' },
    'part.rhythm.syncop': { what: 'Weights the off-beat steps, so a chance rhythm lands off the beat more often.', lo: 'every step equally likely', hi: 'strongly favours the off-beats' },
    restProb: { what: 'Drops some hits on each pass, so the line breathes.', lo: 'every hit plays', hi: 'every hit dropped' },
    ghosts: { what: 'Adds quiet extra hits between the notes, like a drummer’s ghost notes.', lo: 'no extra hits', hi: 'extra quiet hits wherever they fit' },
    'part.rhythm.rateVar': { what: 'Each hit lands a little early or late, differently on every pass.', lo: 'every hit on its step', hi: 'hits drift up to 40% of the gap', gate: only((L) => !straightOn(L), 'off: Straight'), long: 'The Step grid plays Straight, so this is switched off. Set it to Loose to use it.' },
    startVary: { what: 'The chance that a whole pass starts late. The pattern slides as one block; the hits keep their spacing.', lo: 'every pass starts on the 1', hi: 'every pass starts somewhere else', gate: only((L) => !straightOn(L), 'off: Straight'), long: 'The Step grid plays Straight, so this is switched off. Set it to Loose to use it.' },
    'part.shape.lenShape': { choice: true, what: 'A figure of length and accent, repeated every bar. It takes over Note length and Length wobble.' },
    'part.shape.lenRatio': { def: 100, what: 'How long each note holds, as a share of the gap to the next hit.', lo: 'very short, staccato', hi: 'four times the gap, overlapping',
      gate: (L) => (lenShapeOn(L) ? 'the length shape takes over' : (((L.part.shape || {}).holdSteps | 0) > 0 ? 'set by Length in the Step grid' : null)), long: 'Not used right now: a length shape, or the Step grid’s Length, decides how long the notes are.' },
    lenVary: { what: 'Each note comes out a little longer or shorter, differently on every pass.', lo: 'every note its set length', hi: 'up to 60% longer or shorter',
      gate: (L) => (lenShapeOn(L) ? 'the length shape takes over' : (straightOn(L) ? 'off: Straight' : null)), long: 'Not used right now: a length shape takes it over, or the Step grid plays Straight.' },
    'part.shape.lenDepth': { def: 100, what: 'How strongly the length shape is applied. 100 is as written.', lo: 'no shape at all', hi: 'twice as exaggerated as written', gate: only(lenShapeOn, 'needs a length shape'), long: 'Pick a Length shape (the tile beside it) to use this.' },
    'part.shape.lenWeight': { def: 100, what: 'How the length shape is split between loudness and length.', lo: 'shapes length only', hi: 'all of it goes into loudness', gate: only(lenShapeOn, 'needs a length shape'), long: 'Pick a Length shape (the tile beside it) to use this.' },
    'instrument.register': { def: 4, what: 'The octave the notes sit in.', lo: 'the lowest octave', hi: 'the highest octave' },
    'part.pitch.contour': { what: 'Tilts the line downward or upward over the part.', lo: 'falls', hi: 'rises' },
    proximity: { what: 'How close each note stays to the one before.', lo: 'free to leap', hi: 'small steps only' },
    'part.pitch.roam': { what: 'How often a note is built on a neighbouring chord tone instead of the one set.', lo: 'always the set tone', hi: 'often a neighbour' },
    'part.pitch.randomness': { what: 'Breaks the order of a run so it jumps about.', lo: 'in order', hi: 'jumps about' },
    'part.pitch.drift': { what: 'Sends some notes up or down an octave.', lo: 'every note in its octave', hi: 'octaves drift freely' },
    'part.pitch.variety': { what: 'Colours the chords with extra tones.', lo: 'plain', hi: 'colourful' },
    'breath.amount': { what: 'How much of the time the layer holds back and rests: whole stretches, not single hits.', lo: 'never rests', hi: 'rests most of the time' },
    'flourish.amount': { what: 'How much of the time the rate suddenly jumps: a quick run or doubled notes.', lo: 'never', hi: 'most of the time' },
    'flourish.wild': { def: 50, what: 'How far a flourish jumps.', lo: 'doubles the rate', hi: 'long fast runs', gate: (L) => ((+getPath(L, 'flourish.amount') || 0) > 0 ? null : 'needs Flourish'), long: 'Turn Flourish up first.' },
    'chg.ev': { what: 'How many passes play before the rules decide again.', lo: 'never: this take plays on', hi: 'a new take every 64 passes' },
    'part.rhythm.vary': { what: 'Drops or adds hits off the pattern, differently on each pass.', lo: 'the pattern exactly', hi: 'hits dropped and added freely' },
    'part.rhythm.chance': { def: 50, what: 'How often each step sounds.', lo: 'never', hi: 'every step' },
    'part.rhythm.voices': { def: 1, what: 'Interlocking rows of the same rhythm, each on its own note.', lo: 'one row', hi: 'eight rows' },
    'part.shape.lenTurn': { what: 'Starts the length shape later in the bar, by this many hits.', lo: 'from the first hit', hi: '15 hits later', gate: only(lenShapeOn, 'needs a length shape'), long: 'Pick a Length shape to use this.' },
    'part.rhythm.beat.vary': { what: 'How much the drum pattern re-decides on each take.', lo: 'the same bar every time', hi: 'a new bar every take' },
    pitchVary: { what: 'Each drum hit wanders up or down in pitch, by up to this many semitones.', lo: 'in tune', hi: '±12 semitones' },
    'part.pitch.voices': { def: 3, what: 'How many notes sound together.', lo: 'one note', hi: 'nine notes' },
    'part.pitch.inv': { what: 'Turns the chord over: which of its tones is at the bottom. 0 is root position.', lo: 'turned down', hi: 'turned up' },
    'part.pitch.spread': { what: 'Spreads the chord’s notes across up to this many octaves either way.', lo: 'close together', hi: '±3 octaves' },
    'part.pitch.voiceCap': { what: 'The most notes a chord may use. 0 means no limit.', lo: 'no limit', hi: 'twelve notes' },
    'part.pitch.subdiv': { def: 1, what: 'Plays each chord as this many hits.', lo: 'once', hi: '16 hits' },
    'part.pitch.phraseLen': { def: 4, what: 'How many chords make one phrase.', lo: 'one chord', hi: '16 chords' },
    'part.pitch.repeats': { def: 4, what: 'How many cycles a voicing holds before a fresh one.', lo: 'a new voicing every cycle', hi: '16 cycles' },
    'part.pitch.mix': { def: 50, what: 'The balance between chords and single notes.', lo: 'all single notes', hi: 'all chords' },
    'part.pitch.lines': { def: 1, what: 'How many melodies play at once.', lo: 'one line', hi: 'six lines' },
    'part.pitch.stutter': { what: 'How often a note is played again straight away.', lo: 'never', hi: 'very often' },
    'part.pitch.span': { def: 5, what: 'How far the line may wander, in scale steps.', lo: 'one step', hi: '12 steps' },
    'part.pitch.octaves': { def: 1, what: 'How many octaves a run covers.', lo: 'one octave', hi: 'four octaves' },
    'chg.am': { def: 100, what: 'How much of the material each change touches. The rest is kept.', lo: 'nothing changes', hi: 'all of it changes', gate: (L) => (((L.chg || {}).ev | 0) > 0 ? null : 'needs Evolve'), long: 'Turn Evolve up first.' },
    'part.transpose': { what: 'Moves every written note up or down.', lo: 'two octaves down', hi: 'two octaves up' },
    'part.ops.arp': { what: 'Spreads each chord (or note) into a run through its tones: this many notes in each hit’s time.', lo: 'off', hi: '16 notes a hit' },
    'part.ops.scale': { def: 100, what: 'Fits the notes into a share of their span, lengths included. Past 100% they run on into what follows.', lo: 'squeezed into a tenth', hi: 'stretched to twice' },
    phrasing: { what: 'From even notes to shaped figures.', lo: 'even', hi: 'shaped figures' },
    // ── FROM ♯ TWEAKS (2026-10-06): the feel, the per-pass dice, ratchet, spread
    swing: { what: 'Delays every second note of each pair, from straight to a shuffle.', lo: 'straight', hi: 'a heavy shuffle' },
    'part.timing.lean': { what: 'Moves every note the same amount behind or ahead of the beat. A feel, not a wobble.', lo: '60 ms ahead', hi: '60 ms behind' },
    'part.shape.holdSteps': { def: 4, what: 'Each note holds this many grid steps, whatever the gap to the next.', lo: 'one step', hi: '16 steps', gate: (L) => ((((L.part || {}).shape || {}).holdSteps | 0) > 0 ? null : 'needs Size by: Hold') },
    'part.timing.ratchet.chance': { what: 'How often a hit repeats as a fast burst instead of sounding once.', lo: 'never', hi: 'every hit' },
    __spread: { what: 'How far apart the notes of one chord land, like a strum.', lo: 'all at once', hi: 'a slow strum' },
    humanize: { what: 'Each hit lands a little early or late. Never the same twice.', lo: 'on the grid', hi: 'loose' },
    velVar: { what: 'Each note comes out a little louder or softer, differently every pass.', lo: 'every note the same', hi: 'wide level scatter' },
    accent: { what: 'Some notes are leaned on harder — a new pattern of accents each pass.', lo: 'flat', hi: 'very dynamic' },
    strumFidelity: { what: 'How much the strum order shuffles. Heard only with Spread order: Wandering.', lo: 'in order', hi: 'any order', gate: (L) => ((V2.spreadGet ? V2.spreadGet(L).mode : '') === 'wander' ? null : 'needs Spread order: Wandering') },
    slide: { what: 'Glides into a note across a leap, now and then.', lo: 'never', hi: 'often' },
    ornament: { what: 'Adds quick grace-note flicks into some notes.', lo: 'never', hi: 'often' },
    motion: { what: 'A slow detune wobble on the notes.', lo: 'in tune', hi: 'a strong wobble' },
    twist: { what: 'From a steady flow to bursts.', lo: 'steady', hi: 'bursts' },
  };
  const metaOf = (c) => META[c.path] || {};
  const defOf = (c) => (Number.isFinite(metaOf(c).def) ? metaOf(c).def : 0);
  const valOf = (L, c) => { const v = (c.get && !c.choice) ? c.get(L) : getPath(L, c.path); return Number.isFinite(+v) && v !== undefined && v !== null && v !== '' ? +v : defOf(c); };

  const isMine = (r) => !!r && (r.kind === 'drawn' || r.kind === 'fig');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let G = null;   // { E, id, snap, hist, styleOpen, bar, tab, note }
  const RHYTHM_K = [['pulse', 'Pulse', 'Evenly spaced hits.'], ['euclid', 'Euclid', 'Hits spread as evenly as possible over a step count.'], ['fig', 'Figure', 'A named rhythm, like a gallop or a tresillo.'], ['chance', 'Chance', 'Each step sounds by chance.'], ['ground', 'Groundwork', 'Hits on every chord change.']];
  const PITCH_K = [['chord', 'Chord', 'The harmony itself.'], ['stack', 'Stack', 'Notes stacked up from one note.'], ['fixed', 'One note', 'The same degree of each chord, every time.'], ['series', 'Series', 'Sweeps through the chord.'], ['anchor', 'Anchor', 'A pedal point that holds.'], ['walk', 'Walk', 'A line that wanders.'], ['chance', 'Chance', 'Any tone of the chord.'], ['mixed', 'Mixed', 'Chords and single notes together.'], ['confug', 'ConFugued', 'N notes at stated intervals.'], ['drawn', 'Drawn', 'A note written for each step.']];
  // ── ♯ TWEAKS DISSOLVED (2026-10-06, user: Tweaks is better served per note, with the
  // layer-wide values as "apply to all") — the RULES and the per-pass dice moved here;
  // the per-note versions live in the Editor. FEEL and the basic per-pass dice also
  // apply to WRITTEN notes, so they appear in that view too (see WRITTEN).
  const FEEL = ['Feel', [S_('swing', 'Swing', 0, 100),
    C_('part.timing.swingDiv', 'Swing grid', [['', 'The part’s own grid'], ['8', '8ths'], ['16', '16ths']], '', { num: true, what: 'Which pairs of notes swing counts in.', gate: (L) => (((+L.swing) | 0) > 0 ? null : 'needs Swing') }),
    S_('part.timing.lean', 'Lean', -60, 60, 0, ' ms'),
    C_('__tight', 'Tight', [['', 'Off', 'Notes keep their length.'], ['1', 'On — clipped', 'Each note is cut short of the next.']], '', {
      what: 'Cuts each note short of the next one, so nothing overlaps.',
      get: (L) => (L.tight ? '1' : ''), set: (L, k) => { if (k) L.tight = 1; else delete L.tight; }, reset: (L) => { delete L.tight; } })]];
  const PASS_BASIC = [S_('humanize', 'Humanize', 0, 100, 1), S_('velVar', 'Vel var', 0, 100, 1), S_('accent', 'Accent', 0, 100, 1)];
  const SPREAD_W = 'kind:live;voice:synth;pitch:chord,stack,mixed';
  const ODDS_STEPS = [100, 75, 50, 25, 0];
  // ⏱ ODDS — a probability per STEP, one row per bar so 64 steps stay finger-sized
  function oddsHTML(L) {
    const p = L.part || {}, n = clamp(((p.rhythm || {}).steps | 0) || 8, 1, 64), odds = (p.timing && p.timing.odds) || {};
    const per = clamp(Math.round(n / barsOf(L)) || n, 1, 32);
    let h = '<div class="g2-odds" style="display:flex;flex-direction:column;gap:3px;width:100%;min-width:0">';
    for (let r0 = 0; r0 < n; r0 += per) {
      h += '<div style="display:grid;grid-template-columns:repeat(' + per + ',1fr);gap:2px;min-width:0">';
      for (let i = r0; i < Math.min(n, r0 + per); i++) {
        const v = Number.isFinite(odds[String(i)]) ? (odds[String(i)] | 0) : 100;
        h += '<button type="button" class="g2-odd" data-a="odd" data-i="' + i + '" aria-label="Step ' + (i + 1) + ', ' + v + '%" style="min-width:0;min-height:34px;padding:0;border-radius:6px;border:1px solid #2d2d3f;font:700 11px system-ui;'
          + (v === 100 ? 'background:#1d1a33;color:#c4b5fd' : v === 0 ? 'background:rgba(45,45,63,.5);color:#6b6b8a' : 'background:rgba(246,173,85,.22);color:#f6ad55') + '">'
          + (v === 100 ? '●' : v === 0 ? '·' : v) + '</button>';
      }
      h += '</div>';
    }
    return h + '<span class="g2-hint" style="margin:0">How likely each step is to play — tap to step it down. Per note in the Editor.</span></div>';
  }
  const TABS = [
    { id: 'rhythm', label: 'Rhythm', secs: [
      ['Rhythm feel', [C_('part.rhythm.kind', 'Rhythm type', RHYTHM_K, 'kind:live;voice:synth', { what: 'How the hits are placed.', get: (L) => rk(L) || '', set: (L, k) => { const r0 = L.part.rhythm || {}; if (isMine(r0) && k !== r0.kind) L.part.rhythmAlt = clone(r0); L.part.rhythm = Object.assign({}, r0, { kind: k }); }, show: (L) => (rk(L) === 'drawn' ? 'Step grid' : null) }),
        S_('part.rhythm.figSync', 'Syncopation', 0, 100, 1, '', 'rhythm:fig'), S_('part.rhythm.figGrp', 'Grouping', 0, 100, 1, '', 'rhythm:fig'), S_('part.rhythm.figVar', 'Bar variation', 0, 100, 1, '', 'rhythm:fig'),
        S_('part.rhythm.chance', 'Chance', 0, 100, 0, '%', 'rhythm:chance'), S_('part.rhythm.syncop', 'Syncopate', 0, 100, 0, '', 'rhythm:chance'),
        S_('part.rhythm.voices', 'Rows', 1, 8, 0, '', 'voice:synth;rhythm:euclid'),
        S_('restProb', 'Rests', 0, 100, 1, '%'), S_('ghosts', 'Ghosts', 0, 100, 1, '%'),
        S_('part.rhythm.rateVar', 'Timing wobble', 0, 100, 1), S_('startVary', 'Start', 0, 100, 1)]],
      FEEL,
      ['Ratchet', [S_('part.timing.ratchet.chance', 'Ratchet', 0, 100, 0, '%', 'kind:live'),
        C_('part.timing.ratchet.hits', 'Ratchet hits', [['2', '2'], ['3', '3'], ['4', '4']], 'kind:live', { num: true, def: '2', what: 'How many fast hits, when it fires.', gate: (L) => ((((L.part.timing || {}).ratchet || {}).chance | 0) > 0 ? null : 'needs Ratchet') }),
        C_('part.timing.ratchet.spread', 'Ratchet spacing', [['even', 'Even'], ['accel', 'Accelerating'], ['decel', 'Decelerating']], 'kind:live', { def: 'even', what: 'How the fast hits are spaced.', gate: (L) => ((((L.part.timing || {}).ratchet || {}).chance | 0) > 0 ? null : 'needs Ratchet') })]],
      ['Odds', [{ path: 'part.timing.odds', label: 'Odds', html: oddsHTML, w: 'kind:live;rhythm:euclid,drawn,chance' }]],
      ['On the changes', [C_('part.rhythm.strike', 'Strike', [['', 'Once per change'], ['half', 'Every half bar'], ['bar', 'Every bar'], ['comp', 'Comp: the 1 and the & of 2']], 'rhythm:ground', { what: 'How often each chord is struck.' }),
        C_('part.rhythm.antic', 'Arrive', [['0', 'On the change'], ['1', 'An 8th early']], 'rhythm:ground', { num: true, what: 'Each change can land an 8th before its bar line and ring through it.', get: (L) => (((L.part.rhythm || {}).antic) ? '1' : '0') })]],
      ['Note lengths', [C_('part.shape.lenShape', 'Length shape', () => [['', 'Off', 'Note length and Length wobble decide the lengths.']].concat(Object.keys(V2.LEN_SHAPES || {}).map((k) => [k, V2.LEN_SHAPES[k].lab, V2.LEN_SHAPES[k].tip])), 'rhythm:pulse,euclid,drawn,chance', { what: 'A figure of length and accent, repeated every bar. It takes over Note length and Length wobble.' }),
        C_('__size', 'Size by', [['', 'Length', 'A share of the gap to the next hit.'], ['hold', 'Hold', 'A fixed number of grid steps, whatever the gaps.']], 'kind:live', {
          what: 'Whether a note’s length follows the gap to the next hit, or holds a fixed number of steps.',
          get: (L) => (((((L.part || {}).shape || {}).holdSteps | 0) > 0) ? 'hold' : ''),
          set: (L, k) => { const sh = L.part.shape || (L.part.shape = {}); if (k) { if (!((sh.holdSteps | 0) > 0)) sh.holdSteps = 4; } else sh.holdSteps = 0; },
          reset: (L) => { if (L.part.shape) L.part.shape.holdSteps = 0; } }),
        S_('part.shape.holdSteps', 'Hold', 1, 16, 0, ' steps', 'kind:live'),
        S_('part.shape.lenRatio', 'Note length', 1, 400, 0, '%'), S_('lenVary', 'Length wobble', 0, 100, 1),
        S_('part.shape.lenDepth', 'Shape depth', 0, 200, 0, '%', 'rhythm:pulse,euclid,drawn,chance'), S_('part.shape.lenWeight', 'Shape weight', 0, 100, 0, '%', 'rhythm:pulse,euclid,drawn,chance'),
        S_('part.shape.lenTurn', 'Shape turn', 0, 15, 0, '', 'rhythm:pulse,euclid,drawn,chance')]],
      ['Drums', [C_('part.rhythm.beat.per', 'Resolution', () => (V2.BEAT_PERS || [4, 8, 12, 16, 24, 32, 48, 64]).map((n) => [String(n), n + ' a bar']), 'voice:kit', { num: true, def: '16', what: 'How finely a bar is cut. The pattern scales with it, so twice the grid is twice the speed.' }),
        S_('part.rhythm.beat.vary', 'Beat vary', 0, 100, 0, '', 'voice:kit'), S_('pitchVary', 'Pitch vary', 0, 12, 0, '', 'voice:kit')]],
    ] },
    { id: 'pitch', label: 'Pitch', secs: [
      ['Pitch', [C_('part.pitch.kind', 'Pitch type', PITCH_K, 'kind:live;voice:synth', { what: 'How each hit’s note is chosen. Movement above sets the common ones.', show: (L) => (pk(L) === 'grid' ? 'Piano grid' : null),
          // a SERIES with no Octaves climbs for ever (the engine keeps that for its gate):
          // reached from here it gets a bounded range, as ⟳ Arpeggiate gives it
          set: (L, k) => { L.part.pitch = Object.assign({}, L.part.pitch, { kind: k }); if (k === 'series' && !Number.isFinite(L.part.pitch.octaves)) L.part.pitch.octaves = 2; } }),
        S_('instrument.register', 'Register', 1, 8, 0, '', 'voice:synth'), S_('part.pitch.contour', 'Contour', -100, 100, 0, '', 'voice:synth;pitch:walk,mixed'), S_('proximity', 'Proximity', 0, 100, 0, '', 'voice:synth;pitch:walk'),
        S_('part.pitch.roam', 'Roam', 0, 100, 1, '', 'voice:synth;pitch:fixed,stack,chord'), S_('part.pitch.randomness', 'Scatter', 0, 100, 1, '', 'voice:synth;pitch:series'),
        S_('part.pitch.drift', 'Pitch vary', 0, 100, 1, '', 'voice:synth;pitch:fixed,series,walk,chance')]],
      ['Chords', [Object.assign(S_('__spread', 'Spread', 0, 100, 0, '', SPREAD_W), {
          get: (L) => V2.spreadGet(L).amt, set: (L, v) => { V2.spreadSet(L, { amt: v }); }, reset: (L) => { V2.spreadSet(L, { amt: 0, mode: 'up' }); } }),
        C_('__spreadMode', 'Spread order', () => (V2.SPREAD_MODES || []).map((m) => [m[0], m[1]]), SPREAD_W, {
          what: 'Which note of the chord is struck first.', get: (L) => V2.spreadGet(L).mode, set: (L, k) => { V2.spreadSet(L, { mode: k }); },
          gate: (L) => (V2.spreadGet(L).amt > 0 ? null : 'needs Spread') }),
        S_('part.pitch.voices', 'Notes at once', 1, 9, 0, '', 'voice:synth;pitch:chord,stack,mixed'), S_('part.pitch.inv', 'Inversion', -12, 12, 0, '', 'voice:synth;pitch:chord,stack'),
        // RECOLOUR (2026-10-05) — were only in the old per-bar re-roll panel; the part has them too
        C_('part.pitch.qual', 'Chord', [['', 'The change’s own'], ['maj', 'Major'], ['min', 'Minor'], ['dim', 'Diminished °'], ['dim7', 'Diminished 7th °7'], ['aug', 'Augmented +'], ['sus2', 'Sus2'], ['sus4', 'Sus4']], 'voice:synth',
          { what: 'Recolours the chords it plays — or keeps each change’s own.', gate: (L) => (/^(drawn|grid)$/.test(pk(L) || '') ? 'not for written pitches' : null) }),
        C_('part.pitch.ext', 'Extension', [['', 'None'], ['6', '6th'], ['7', '7th ♭7'], ['maj7', 'Major 7th ♮7'], ['9', '9th'], ['11', '11th'], ['13', '13th']], 'voice:synth',
          { what: 'Stacks a 6th, 7th, 9th… on top of each chord.', gate: (L) => (/^(drawn|grid)$/.test(pk(L) || '') ? 'not for written pitches' : null) }),
        S_('part.pitch.spread', 'Spread', 0, 3, 0, '', 'voice:synth;pitch:chord'), S_('part.pitch.variety', 'Variety', 0, 100, 1, '', 'voice:synth;pitch:chord'),
        C_('part.pitch.chordMode', 'Voicing', [['', 'Simple', 'Stack the tones.'], ['chaos', 'Chaos'], ['chords', 'Chords'], ['chordsplus', 'Chords+'], ['monk', 'Monk']], 'voice:synth;pitch:chord', { what: 'How the chord’s notes are arranged.' }),
        C_('part.pitch.feel', 'Voicing feel', [['', 'In order', 'The same voicing each pass.'], ['stochastic', 'Stochastic', 'A new voicing each pass.']], 'voice:synth;pitch:chord', { what: 'Whether the voicing stays the same or changes each pass.' }),
        S_('part.pitch.voiceCap', 'Voice cap', 0, 12, 0, '', 'voice:synth;pitch:chord'), S_('part.pitch.subdiv', 'Subdivide', 1, 16, 0, '', 'voice:synth;pitch:chord'),
        S_('part.pitch.phraseLen', 'Phrase', 1, 16, 0, '', 'voice:synth;pitch:chord'), S_('part.pitch.repeats', 'Hold for', 1, 16, 0, '', 'voice:synth;pitch:chord'),
        S_('part.pitch.mix', 'Chords vs notes', 0, 100, 0, '', 'voice:synth;pitch:mixed'),
        C_('part.pitch.mixAt', 'Chords land', [['arch', 'Changes + strong beats'], ['change', 'On each change'], ['strong', 'On beats 1 and 3'], ['any', 'Anywhere', 'A coin flip.']], 'voice:synth;pitch:mixed', { def: 'arch', what: 'Where the chords fall among the single notes.' }),
        C_('part.pitch.lineUp', 'Line sits', [['1', 'An octave above the chords'], ['0', 'In the same register']], 'voice:synth;pitch:mixed', { num: true, def: '1', what: 'Where the single-note line sits against the chords.', get: (L) => (((L.part.pitch || {}).lineUp === 0) ? '0' : '1') })]],
      ['Line', [C_('part.pitch.home', 'Home', [['floor', 'Floor', 'Walks up from Register.'], ['center', 'Centre', 'Register is in the middle.'], ['ceiling', 'Ceiling', 'Walks down from Register.']], 'voice:synth;pitch:walk', { def: 'floor', what: 'Where the line lives relative to Register.' }),
        C_('part.pitch.walkMode', 'Line moves', [['step', 'Steps from the last note'], ['scatter', 'Scatters in Range']], 'voice:synth;pitch:walk,mixed', { what: 'Whether each note steps from the last or lands anywhere in the range.', get: (L) => (L.part.pitch || {}).walkMode || (pk(L) === 'mixed' ? 'step' : 'scatter') }),
        S_('part.pitch.span', 'Range', 1, 12, 0, '', 'voice:synth;pitch:walk,mixed'), S_('part.pitch.lines', 'Lines', 1, 6, 0, '', 'voice:synth;pitch:walk,chance,mixed'),
        C_('part.pitch.motif', 'Motif', [['', 'Off'], ['bar', 'Repeat bar 1', 'A A B A.'], ['notes', 'Repeat its notes', 'A A B A.']], 'voice:synth;pitch:walk,chance,mixed', { what: 'Repeats an idea so the line has a shape you can follow.' }),
        S_('part.pitch.stutter', 'Repeat', 0, 100, 0, '', 'voice:synth;pitch:walk,mixed'),
        C_('part.pitch.dir', 'Direction', [['up', 'Up'], ['down', 'Down'], ['updown', 'Up & down'], ['downup', 'Down & up'], ['converge', 'Outside in']], 'voice:synth;pitch:series', { def: 'up', what: 'Which way a run sweeps through the chord.' }),
        S_('part.pitch.octaves', 'Octaves', 1, 4, 0, '', 'voice:synth;pitch:series'),
        C_('part.pitch.tones', 'Notes from', [['', 'Chord tones', 'Sweeps the notes of each chord.'], ['triad', 'Triad only', 'Root, third and fifth of each chord.'], ['scale', 'The scale', 'A run through the key’s scale, starting from each chord’s root.']], 'voice:synth;pitch:series', { what: 'Which notes a run steps through.' }),
        C_('part.pitch.restart', 'On a change', [['', 'Keep going'], ['1', 'Start again']], 'voice:synth;pitch:series', { what: 'Whether a run restarts on each chord change.', get: (L) => (((L.part.pitch || {}).restart) ? '1' : ''), set: (L, k) => { L.part.pitch = Object.assign({}, L.part.pitch); if (k) L.part.pitch.restart = true; else delete L.part.pitch.restart; } })]],
    ] },
    { id: 'vary', label: 'Variation', secs: [
      ['Each pass', PASS_BASIC.concat([S_('strumFidelity', 'Spread wander', 0, 100, 1, '', SPREAD_W),
        S_('slide', 'Slide', 0, 100, 1, '', 'kind:live;voice:synth'), S_('ornament', 'Ornament', 0, 100, 1, '', 'kind:live;voice:synth'),
        S_('motion', 'Wobble', 0, 100, 1, '', 'kind:live;voice:synth')])],
      ['Space & flourishes', [S_('breath.amount', '⏸ Breath', 0, 100, 1),
        C_('breath.len', 'Breath length', [['beat', 'A beat'], ['bar', 'A bar'], ['chg', 'A change'], ['pass', 'A whole pass']], '', { def: 'bar', what: 'How long one held-back stretch is.' }),
        C_('breath.where', 'Breath where', [['', 'Anywhere'], ['end', 'Phrase ends'], ['chg', 'Into a change']], '', { what: 'Where it is most likely to rest.' }),
        S_('flourish.amount', '✦ Flourish', 0, 100, 1), S_('flourish.wild', 'Flourish size', 0, 100),
        C_('flourish.where', 'Flourish where', [['', 'Anywhere'], ['end', 'Phrase ends'], ['chg', 'Into a change']], '', { what: 'Where a flourish is most likely.' }),
        C_('breath.pair', 'Pair them', [['', 'Independent'], ['fill', 'Flourish, then rest'], ['enter', 'Rest, then a flourish']], '', { what: 'A fill and the silence after it can be one gesture.' })]],
      // ⟳ / ⬡ OPERATIONS (2026-10-05) — run on what the rules made; for the whole part
      // (`part.ops`) or, opened on a bar, for that stretch
      ['Operations', [S_('part.ops.arp', '⟳ Arpeggiate', 0, 16),
        C_('part.ops.arpDir', 'Arp direction', [['up', 'Up'], ['down', 'Down'], ['updown', 'Up & down']], '', { def: 'up', what: 'Which way the arpeggio runs.', gate: (L) => (((+getPath(L, 'part.ops.arp')) | 0) > 0 ? null : 'needs Arpeggiate') }),
        S_('part.ops.scale', '⬡ Scale', 10, 200, 0, '%')]],
      ['Change over time', [S_('chg.ev', 'Evolve (passes)', 0, 64), S_('chg.am', 'How much', 0, 100, 0, '%'),
        C_('chg.clock', 'Against', [['', 'Passes of this part'], ['round', 'Rounds of the arrangement']], '', { what: 'What a pass counts. With no progression, the layer’s own cycle is the pass.' }),
        S_('part.rhythm.vary', 'Vary', 0, 100, 1, '', 'rhythm:euclid,drawn'),
        S_('phrasing', 'Phrasing', 0, 100, 1), S_('twist', 'Twist', 0, 100, 1)]],
      // ♫ SOUND OVER TIME (2026-10-06) — builds the layer's Tone set (Instrument ▸
      // Tone set) from its sound and two related ones. Voice 1 is always the layer's
      // own Tone, so a Style picked later is heard; a set you edited by hand reads
      // as your own and is left alone.
      ['Sound over time', [C_('__toneSet', 'Sound changes', (L) => {
        const o = [['', 'Off', 'One sound throughout.'], ['bars', 'Every 4 bars', 'This sound and two related ones, 4 bars each.'],
          ['chg', 'On each change', 'A new sound on every chord change, cycling three.']];
        try { const c0 = G && G.E && G.E._cfg; if (c0 && c0.prog && c0.prog.on && (_ambGridRanges(c0) || []).length > 1) o.push(['part', 'A sound per part', 'Each arrangement part gets its own sound.']); } catch (e) {}
        try { if (typeof _ambToneSetGenOf === 'function' && _ambToneSetGenOf(L) === 'own') o.push(['own', 'Your own set', 'Edited in Instrument ▸ Tone set — pick another here to replace it.']); } catch (e) {}
        return o;
      }, 'voice:synth', {
        what: 'Swaps the layer between related sounds as it plays. Fine-tune the sounds and lengths in Instrument ▸ Tone set.',
        get: (L) => { try { return (typeof _ambToneSetGenOf === 'function') ? _ambToneSetGenOf(L) : ''; } catch (e) { return ''; } },
        set: (L, k) => {
          if (k === 'own') return;
          if (!k) { if (!L.toneSeq) return; if (_ambToneSetGenOf(L) === 'own') L.toneSeq.on = 0; else delete L.toneSeq; return; }
          const q = (typeof _ambToneSetBuild === 'function') ? _ambToneSetBuild(L, k, G.E._cfg) : null;
          if (q) L.toneSeq = q;
        } })]],
    ] },
    { id: 'more', label: 'More', secs: [
      // ◈ CHARACTER — a named set of rules, for the whole part or (opened on a bar) that stretch
      ['Character', [C_('__char', 'Character', () => [['', G && G.scope ? '— the part’s own rules' : '— none']].concat((V2.presets || []).map((pr) => [pr.id, pr.label])), '', {
        what: 'A named set of rules. Picking one writes them; change any control afterwards to tune it.',
        get: (L) => { try { if (G && G.scope) return (V2.charState(G.E, layer(), G.scope.bars[0]) || {}).id || ''; return (V2.presetState(L) || {}).id || ''; } catch (e) { return ''; } } })]],
      ['Answer another layer', [C_('part.answer.src', 'Answer', (L) => [['', 'Off', 'Plays on its own.']].concat(((G && G.E && G.E.getCfg().layers) || []).filter((x) => x && x.id !== L.id).map((x) => [String(x.id | 0), x.name || ('Layer ' + (x.id | 0))])), '', {
          what: 'Plays off another layer: this one is filtered against what that one plays.', get: (L) => String(((L.part.answer || {}).src | 0) || ''),
          set: (L, k) => { if (!k) delete L.part.answer; else L.part.answer = Object.assign({ mode: 'gaps' }, L.part.answer || {}, { src: +k }); } }),
        C_('part.answer.mode', 'Answer mode', () => Object.keys(V2.ANSWER_MODES || {}).map((k) => [k, V2.ANSWER_MODES[k]]), '', { what: 'Where this layer may sound, measured against the other one.', get: (L) => (((L.part.answer || {}).mode === 'hits') ? 'hits' : 'gaps'),
          set: (L, k) => { if (L.part.answer) L.part.answer = Object.assign({}, L.part.answer, { mode: k }); }, gate: (L) => ((((L.part.answer || {}).src) | 0) ? null : 'needs Answer') })]],
    ] },
  ];
  // WRITTEN NOTES (a recorded part) get their own two
  const WRITTEN = [['Written notes', [S_('part.transpose', 'Transpose', -24, 24)]], FEEL, ['Each pass', PASS_BASIC]];
  function setPath(o, path, v) {
    const ks = path.split('.'); let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (!a[ks[i]] || typeof a[ks[i]] !== 'object') a[ks[i]] = {}; a = a[ks[i]]; }
    a[ks[ks.length - 1]] = v;
  }

  // ── the sheet ──────────────────────────────────────────────────────────────
  const layer = () => (G && G.E && (G.E.getCfg().layers || []).find((x) => x && x.id === G.id)) || null;
  function persist() {
    const E = G.E;
    try { E.getCfg(); } catch (e) {}
    // ▦ a PATTERN layer plays its grid — write what the rules make onto it
    try { const L0 = layer(); if (L0 && V2.bakeSteps) V2.bakeSteps(E, L0); } catch (e) {}
    try { if (E._v2Phase && _ambLiveApplyOK(E)) delete E._v2Phase['v2:' + G.id]; } catch (e) {}
    try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    try { V2.render(E); } catch (e) {}
  }
  function snapNow() { const L = layer(); return L ? JSON.stringify(L) : null; }
  // ◫ OPENED ON A BAR (2026-10-05, user: the re-roll panel should be "like the latest
  // Generate menu"). `G.scope = {bars, nm}` and every control reads a VIEW: the layer
  // with that stretch's EFFECTIVE rules (`V2.barRules`, the part's with the bar's own on
  // top) as its part. An edit runs on the view and only the fields that changed are
  // written back through `V2.setBarRule` — which stores just what DIFFERS from the part,
  // so a value set back to the part's is dropped. A field a bar cannot hold is reported.
  const scoped = () => !!(G && G.scope && G.scope.bars && G.scope.bars.length);
  const GRPS = ['rhythm', 'pitch', 'shape', 'ops'];
  function viewOf(R) {
    if (!scoped() || !R || !R.part) return R;
    const v = clone(R), br = V2.barRules(R.part, G.scope.bars[0]) || {};
    GRPS.forEach((g) => { v.part[g] = clone(br[g] || {}); });
    if (!Object.keys(v.part.ops).length) delete v.part.ops;
    delete v.part.ruleb; delete v.part.takeb;
    if (br.own) delete v.part.mat;            // a stretch with rules of its own is named by them
    return v;
  }
  function scopable(path) {
    if (path === '__char') return true;
    const m = /^part\.(rhythm|pitch|shape|ops)\.([A-Za-z0-9]+)$/.exec(String(path || ''));
    return !!(m && ((V2.barFields || {})[m[1]] || {})[m[2]]);
  }
  const SCOPE_QUIET = { move: 1 };            // Movement's own bookkeeping: the kind carries it
  function scopeWrite(R, a, b) {
    const F = V2.barFields || {}, bars = G.scope.bars, lost = [];
    const J = (x) => JSON.stringify(x === undefined ? null : x);
    GRPS.forEach((g) => {
      const A = (a.part && a.part[g]) || {}, B = (b.part && b.part[g]) || {};
      new Set(Object.keys(A).concat(Object.keys(B))).forEach((f) => {
        if (J(A[f]) === J(B[f])) return;
        if (!(F[g] && F[g][f])) { if (!SCOPE_QUIET[f]) { const c = ctlOf('part.' + g + '.' + f); lost.push(c ? c.label : f); } return; }
        let v = B[f];
        if (v === undefined) {
          const base = (R.part[g] || {})[f];
          if (base !== undefined) { V2.setBarRule(R, bars, g, f, base); return; }
          bars.forEach((k) => { const ov = R.part.ruleb && R.part.ruleb[String(k)]; if (ov && ov[g]) { delete ov[g][f]; if (!Object.keys(ov[g]).length) delete ov[g]; } });
          return;
        }
        if (typeof v === 'boolean') v = v ? 1 : 0;
        if (!V2.setBarRule(R, bars, g, f, v) && J((R.part[g] || {})[f]) !== J(v)) { const c = ctlOf('part.' + g + '.' + f); lost.push(c ? c.label : f); }
      });
    });
    const top = (x) => { const o = clone(x); delete o.part; return JSON.stringify(o); };
    if (top(a) !== top(b)) lost.push('settings outside the rules');
    return lost;
  }
  function edit(fn, note) {
    if (!scoped()) { editReal(fn, note); return; }
    const R = layer(); if (!R) return;
    const before = JSON.stringify(R), v = viewOf(R), v0 = clone(v);
    try { fn(v); } catch (e) { try { console.warn('[genV2]', e); } catch (x) {} }
    let lost = [];
    try { lost = scopeWrite(R, v0, v); } catch (e) { try { console.warn('[genV2 scope]', e); } catch (x) {} }
    persist();
    if (snapNow() !== before) { G.hist.push(before); G.pick = -1; }
    G.note = lost.length ? ('Only the whole part can set ' + lost.join(', ') + ' — switch to Whole part above to change ' + (lost.length > 1 ? 'them' : 'it') + '.') : (note !== undefined ? note : G.note);
    paint();
  }
  function editReal(fn, note) {
    const L = layer(); if (!L) return;
    const before = JSON.stringify(L);
    try { fn(L); } catch (e) { try { console.warn('[genV2]', e); } catch (x) {} }
    persist();
    if (snapNow() !== before) { G.hist.push(before); G.pick = -1; }
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


  // GRID = THE SIZE OF ONE STEP. The pattern keeps its step positions and the
  // steps get shorter or longer: a finer grid repeats it to fill the bar, a
  // coarser one cuts it short. (Re-spreading the hits evenly on the new grid
  // put them back on the same beats, so the change was silent.)
  // ── TWO RHYTHMS SIDE BY SIDE (2026-10-01, user: "Pattern should be a parallel
  // ruleset … or return from Pattern to one generated like it was initially").
  // The STYLE'S RULE (euclid/pulse/… — what picking a Style writes) and MY PATTERN
  // (a drawn or figure rhythm). One plays in `part.rhythm`; the other waits in
  // `part.rhythmAlt` (additive, absent until you switch — the engine never reads
  // it), so neither switching, a Style pick nor a bar re-roll throws one away.
  // the steps the rhythm sounds over the WHOLE part, read off the notes with the
  // extras off (rests, breath, flourish, ghosts, stutter doubles) — the bare rule
  // THE THREE WOBBLES (what bends a take off its steps): Timing wobble = per-hit
  // onset jitter (`rhythm.rateVar`), Length wobble = per-note length scatter
  // (`lenVary`), Start = the whole pass starting late (`startVary`).
  const WOB = [['part.rhythm.rateVar', 'Timing', '#f5b04a'], ['lenVary', 'Length', '#f9a8d4'], ['startVary', 'Start', '#f5b04a']];
  function unwobbled(L) { const t = clone(L); if (t.part && t.part.rhythm) delete t.part.rhythm.rateVar; delete t.lenVary; delete t.startVary; return t; }
  function partHits(L) {
    const bare = unwobbled(L); delete bare.restProb; delete bare.breath; delete bare.flourish; delete bare.ghosts;
    if (bare.part && bare.part.pitch) bare.part.pitch.stutter = 0;
    const { ns, cyc } = notesNow(bare), spb = spbOf(L), nb = Math.max(1, Math.round(barsOf(L))), tot = spb * nb, lit = new Set();
    const span = cyc * nb / barsOf(L);
    ns.forEach((n) => { if (n.at < span - 1e-6) lit.add(clamp(Math.round(n.at / span * tot), 0, tot - 1)); });
    return { spb, nb, tot, lit };
  }
  function writePart(L, spb, nb, lit) {
    const cells = []; for (let i = 0; i < spb * nb; i++) cells.push(lit.has(i) ? 1 : 0);
    const r = L.part.rhythm = Object.assign({}, L.part.rhythm || {});
    r.kind = 'drawn'; r.steps = spb * nb; r.cells = cells; delete r.fig;
  }
  // make MY PATTERN the one playing: the stashed one if there is one, else an
  // exact copy of what the rule plays now (so the switch itself changes nothing)
  function toMine(L) {
    const p = L.part; if (isMine(p.rhythm)) return;
    const alt = p.rhythmAlt, rule = clone(p.rhythm);
    if (isMine(alt)) { p.rhythm = clone(alt); }
    else { const h = partHits(L); writePart(L, h.spb, h.nb, h.lit); L.part.rhythm.straight = true; }
    p.rhythmAlt = rule;
  }
  function toRule(L) {
    const p = L.part; if (!isMine(p.rhythm)) return false;
    const mine = clone(p.rhythm);
    const rule = ruleOf(L); if (!rule) return false;
    p.rhythm = rule.rhythm;
    if (rule.barsMode) p.barsMode = rule.barsMode;
    p.rhythmAlt = mine; return true;
  }
  // the style's rule: the kept one, or — when none was kept (a pattern drawn
  // before rules were kept) — built on a scratch copy, taking ONLY its rhythm,
  // so the pitch, sound and everything else stay as they are
  function ruleOf(L) {
    const p = L.part;
    if (p.rhythmAlt && !isMine(p.rhythmAlt)) return { rhythm: clone(p.rhythmAlt) };
    const s = STYLES.find((x) => x.k === styleOf(L)); if (!s) return null;
    const t = clone(L);
    try { s.make(G.E, t); } catch (e) { return null; }
    if (!t.part || isMine(t.part.rhythm)) return null;
    return { rhythm: clone(t.part.rhythm), barsMode: t.part.barsMode };
  }
  const styleName = (L) => ((STYLES.find((x) => x.k === styleOf(L)) || {}).name || 'The style');

  function regrid(n) {
    let msg = '';
    edit((L) => {
      toMine(L);
      const cur = partHits(L), lit = new Set();
      for (let b = 0; b < cur.nb; b++) for (let j = 0; j < n; j++) if (cur.lit.has(b * cur.spb + (j % cur.spb))) lit.add(b * n + j);
      if (!lit.size) lit.add(0);
      writePart(L, n, cur.nb, lit);
      msg = n === cur.spb ? '' : (n > cur.spb
        ? 'Shorter steps: the pattern plays faster and repeats to fill the bar.'
        : 'Longer steps: the pattern plays slower; steps past ' + n + ' are cut.');
    }, '');
    if (msg) { G.note = msg; paint(); }
  }

  // RE-ROLL ONE BAR: bump its take pin until the bar comes out DIFFERENT and
  // NOT EMPTY. A sparse style (Line, Ambience) can roll a bar of all rests,
  // which reads as "it deleted my bar", so an empty result is never accepted
  // while another take could give notes.
  function rerollBar(bi) {
    const L = layer(); if (!L) return;
    const sig = (ns) => ns.map((n) => Math.round(n.at * 1000) + ':' + Math.round(midiOf(n.freq))).join(',');
    const inBar = (L2, ns, cyc) => { const bs = cyc / barsOf(L2); return ns.filter((n) => n.at >= bi * bs - 1e-6 && n.at < (bi + 1) * bs - 1e-6).length; };
    const before = sig(notesNow(L).ns);
    editReal((L2) => {
      const p = L2.part, key = V2.regBarKey(bi);
      p.takeb = Object.assign({}, p.takeb || {});
      let cur = Number.isFinite(p.takeb[key]) ? p.takeb[key] : ((V2.takeOf ? V2.takeOf(L2) : (p.take | 0)) | 0);
      for (let tries = 0; tries < 24; tries++) {
        cur = (cur + 1) % 1000000; p.takeb[key] = cur;
        const { ns, cyc } = notesNow(L2);
        if (sig(ns) !== before && inBar(L2, ns, cyc) > 0) break;
      }
    }, '');
    const L1 = layer(), now = notesNow(L1), after = sig(now.ns);
    if (after === before && !inBar(L1, now.ns, now.cyc)) {
      // SILENCED BY A SETTING, NOT BY THE TAKE: ⏸ Breath / Rests rest this bar
      // whatever the take, so no re-roll can fill it — say so and change nothing.
      G.hist.pop();
      G.rollNote = 'Bar ' + (bi + 1) + ' is resting because of ⏸ Breath (Variation) or Rests (Rhythm), so a re-roll can’t fill it. Turn those down to hear it.';
    } else if (after === before) {
      // NOTHING RANDOM HERE: the same rules give the same bar. Move its hits to new
      // steps instead (a seeded rotation of this bar), and say so — never a silent no-op.
      G.hist.pop();   // the no-op pin is not worth an undo step
      editReal((L3) => {
        // the PATTERN, not the notes heard: with rests/breath/flourish on, the heard
        // notes have holes, and drawing those in would make the silence permanent
        const bare = JSON.parse(JSON.stringify(L3)); delete bare.restProb; delete bare.breath; delete bare.flourish; delete bare.ghosts;
        const { ns, cyc } = notesNow(bare), spb = spbOf(L3), bars = Math.max(1, Math.round(barsOf(L3))), barSec = cyc / barsOf(L3);
        const cells = [];
        for (let k = 0; k < bars; k++) for (let i = 0; i < spb; i++) cells.push(0);
        ns.forEach((n) => { cells[clamp(Math.round(n.at / barSec * spb), 0, cells.length - 1)] = 1; });
        const sl = cells.slice(bi * spb, (bi + 1) * spb), rot = 1 + ((G.hist.length * 5 + bi * 3) % Math.max(1, spb - 1));
        for (let i = 0; i < spb; i++) cells[bi * spb + ((i + rot) % spb)] = sl[i];
        if (!isMine(L3.part.rhythm)) L3.part.rhythmAlt = clone(L3.part.rhythm);
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

  // WHAT A PICKED NOTE IS AND WHERE IT LANDS on the Grid: bar · beat · step, and
  // how far off the grid it sits when it does not land on a line (swing, nudge).
  // measured from where the note was WRITTEN (`home`: the take with the wobbles
  // off), so a deliberate part-step Shift reads as shifted, not as off the grid
  function noteInfoHTML(L, n, cyc, spb, bpb, nameOf, home) {
    const barSec = cyc / barsOf(L), m = Math.round(midiOf(n.freq)), h0 = Number.isFinite(home) ? home : n.at;
    const bar = Math.floor(h0 / barSec + 1e-6), inBarSteps = (h0 - bar * barSec) / barSec * spb;
    const st = Math.floor(inBarSteps + 0.05), sfr = inBarSteps - st;
    const off = (n.at - h0) / barSec * spb;
    const gname = (GRIDS.find((g) => g[0] === spb) || [0, spb + ' steps a bar'])[1].toLowerCase();
    const where = 'bar ' + (bar + 1) + (bpb < spb ? ' · beat ' + (Math.floor(st / bpb) + 1) : '')
      + ' · step ' + (st + 1) + ' of ' + spb + ' (' + gname + ')' + (sfr > 0.05 ? ' · shifted ' + Math.round(sfr * 100) + '% of a step later' : '');
    const offTxt = Math.abs(off) < 0.05 ? (sfr > 0.05 ? 'no wobble' : 'on the grid') : '<span style="color:#f5b04a">' + Math.round(Math.abs(off) * 100) + '% of a step ' + (off > 0 ? 'late' : 'early') + '</span>';
    const lenSteps = (n.durMs / 1000) / barSec * spb;
    const lenTxt = Math.round(lenSteps * 10) / 10;
    return '<div class="g2-hint" style="padding:10px 12px;border-radius:12px;background:#1b1b30;border:1px solid #3a3a5c;color:#ece8f8">'
      + '<b style="font-size:16px">' + nameOf(m) + '</b> · ' + esc(where) + ' · ' + offTxt + ' · lasts ' + lenTxt + ' step' + (lenTxt === 1 ? '' : 's') + '</div>';
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
  .g2{position:relative}
  .g2-sec{display:flex;flex-direction:column;gap:8px}
  .g2-sechead{display:flex;align-items:baseline;gap:8px}
  .g2-setn{font-size:12px;color:#a78bfa}
  .g2-rsall{margin-left:auto;font-size:12px;color:#a9a6c7;background:none;border:0;padding:4px 0}
  .g2-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .g2-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px 8px;border-radius:14px;border:1px solid #262640;background:#181830;min-width:0;color:#ece8f8}
  .g2-tile.set{border-color:#a78bfa;background:#1d1838}
  .g2-tile.na{opacity:.45}
  .g2-tnm{font-size:12.5px;font-weight:700;line-height:1.2;text-align:center;min-height:2.4em;display:flex;align-items:center;overflow-wrap:anywhere}
  .g2-tch{font-size:13px;font-weight:700;color:#c4b5fd;min-height:44px;display:flex;align-items:center;text-align:center}
  .g2-tdie{position:absolute;top:5px;right:5px;width:15px;height:15px;color:#5eead4;display:flex}
  .g2-tdie svg{width:15px;height:15px}
  .g2-ttag{font-size:10.5px;color:#8d8ab0;line-height:1.2;text-align:center}
  .g2-gauge{width:52px;height:44px}
  .g2-gauge text{font-size:15px;fill:#ece8f8;font-variant-numeric:tabular-nums}
  .g2-scrim{position:absolute;inset:0;z-index:20;background:rgba(5,5,12,.62);display:flex;align-items:flex-end}
  .g2-pop{width:100%;max-height:92%;overflow-y:auto;box-sizing:border-box;background:#17172b;border-top:1px solid #3a3a5c;border-radius:20px 20px 0 0;padding:14px 16px 16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 -10px 30px rgba(0,0,0,.45)}
  .g2-pophd{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .g2-pophd b{font-size:18px}
  .g2-bdg{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:11px;font-size:11.5px;font-weight:700}
  .g2-bdg svg{width:13px;height:13px}
  .g2-bdg.d{background:#0f3a36;color:#5eead4}.g2-bdg.na{background:#2a2112;color:#f5b04a}
  .g2-dialrow{display:flex;align-items:center;justify-content:center;gap:12px}
  .g2-pm{width:48px;height:48px;border-radius:24px;border:1px solid #3a3a5c;background:#1b1b30;color:#ece8f8;font-size:22px;font-weight:700;flex:none}
  .g2-dial{width:200px;height:181px;touch-action:none;cursor:grab;flex:none}
  .g2-ends{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px;color:#a9a6c7;line-height:1.35}
  .g2-ends span:last-child{text-align:right}.g2-ends b{color:#ece8f8}
  .g2-what{font-size:14px;line-height:1.5}
  .g2-chs{display:flex;flex-wrap:wrap;gap:6px}
  .g2-eucp{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-height:44px;padding:4px 10px}
  .g2-eucp small{font-size:11px;color:#a9a6c7;font-variant-numeric:tabular-nums}.g2-eucp.on small{color:#e9e3ff}
  .g2-popft{display:flex;gap:8px}.g2-popft .g2-btn{flex:1}
  .g2-stack{display:flex;flex-direction:column;gap:12px}
  .g2-ctl{display:grid;grid-template-columns:52px minmax(0,1fr);align-items:center;gap:8px;min-width:0}
  .g2-lab{font-size:13px;color:#a9a6c7}
  .g2-r{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
  .g2-sq{width:36px;min-height:36px;padding:0}
  .g2-num{min-width:1.3em;text-align:center;font-variant-numeric:tabular-nums}
  .g2-seg-s button{padding:0 7px;font-size:12px}
  .g2-chip2{height:26px;padding:0 9px;border-radius:13px;border:1px solid var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);color:var(--c);font-size:12px;font-weight:700}
  .g2-gw{position:relative;margin:7px 0}
  .g2-gut{position:absolute;left:0;top:0;width:${34}px;height:28px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#8d8ab0}
  .g2-strip{display:grid;margin:0 1px;padding-left:${34}px}
  .g2-sc{height:28px;box-sizing:border-box;border:0;padding:0;border-radius:0;border-right:1px solid #12121f;background:#26263f}
  .g2-sc.odd{background:#1c1c33}.g2-sc.bar{border-left:2px solid #4a4a6e}.g2-sc.on{background:#a78bfa}
  .g2-gov{position:absolute;top:0;bottom:0;left:${35}px;right:1px;pointer-events:none}
  .g2-gov span{position:absolute}
  .g2-tail{top:9px;height:10px;background:#a78bfa99;border-radius:0 3px 3px 0}
  .g2-haze{bottom:-7px;height:5px;border-radius:3px;background:#f5b04a;opacity:.75}
  .g2-fade{top:-7px;height:5px;border-radius:0 3px 3px 0;background:linear-gradient(90deg,#f9a8d4,#f9a8d400)}
  .g2-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:#a9a6c7;padding-left:${35}px}
  .g2-legend i{display:inline-block;width:18px;height:5px;border-radius:3px;margin-right:5px;vertical-align:middle}
  .g2-flash{animation:g2fl 1.1s ease}
  @keyframes g2fl{0%{background:#3a2a10}100%{background:transparent}}
  .g2-mk{position:absolute;width:0;border-left:2px dotted #f5b04a;pointer-events:none;z-index:2}
  .g2-mg{position:absolute;height:2px;background:#f5b04a;border-radius:1px;pointer-events:none;z-index:2}
  .g2-pill{min-height:38px;padding:0 10px;border-radius:10px;border:1px solid #3a3a5c;background:#1b1b30;color:#c9c5e3;font-size:13px;font-weight:600;min-width:0}
  .g2-pill.on{border:2px solid #a78bfa;background:#2a2150;color:#fff}
  .g2-grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
  .g2-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
  .g2-chip{min-width:0;height:62px;padding:0 4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-radius:14px;border:1px solid #3a3a5c;background:#1b1b30;color:#c9c5e3;font-size:12px;font-weight:600}
  .g2-seg{display:inline-flex;padding:2px;gap:2px;border-radius:17px;border:1px solid #3a3a5c;background:#15152a}
  .g2-seg button{min-height:32px;padding:0 10px;border-radius:15px;border:0;background:transparent;color:#c9c5e3;font-size:13px;font-weight:600}
  .g2-seg button.on{background:#8b5cf6;color:#fff}
  .g2-nt{cursor:pointer}.g2-nt::before{content:'';position:absolute;inset:-5px -4px}
  .g2-roll{position:relative;height:150px;flex-shrink:0;border-radius:14px;background:#0c0c18;border:1px solid #262640;overflow:hidden}
  .g2-mv{min-height:46px;padding:6px 10px;display:flex;align-items:center;gap:8px;border-radius:12px;border:1px solid #3a3a5c;background:#1b1b30;color:#c9c5e3;font-size:13px;font-weight:600;text-align:left}
  .g2-mvcard{grid-column:1/-1;border-radius:14px;border:2px solid #a78bfa;background:#211a40;overflow:hidden}
  .g2-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:4px;border-radius:14px;background:#15152a;border:1px solid #262640}
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
    // ◫ the CONTROLS read the stretch's view when opened on a bar; the picture is the real part
    const V = viewOf(L), sk = styleOf(V), sty = STYLES.find((s) => s.k === sk);
    const live = L.part && L.part.kind === 'live';
    const { ns, cyc } = notesNow(L);
    const bars = barsOf(L), nb = Math.max(1, Math.ceil(bars));
    let h = '';
    // header
    h += '<div class="g2-head"><div style="flex-grow:1;min-width:0"><div style="font-size:20px;font-weight:700">' + (G.fresh ? 'New layer' : 'Generate') + '</div>'
      + '<div class="g2-hint">for <b style="color:#ece8f8">' + esc(L.name || ('Layer ' + L.id)) + '</b></div></div>'
      // ⏱ TIME — the part's Cycle · Bars · Speed (♯ Tweaks' old Time rows), over this sheet
      + '<button type="button" class="g2-btn" data-a="time" title="Length & speed — Cycle, Bars, Speed" aria-label="Length and speed" style="padding:0 10px;white-space:nowrap">⏱ Length</button>'
      + '<button type="button" class="g2-btn" data-a="cancel" aria-label="' + (G.fresh ? 'Remove this new layer and close' : 'Cancel and close') + '" style="width:44px;padding:0">✕</button></div>';
    h += '<div class="g2-body">';
    // ◫ WHAT THIS EDITS — the whole part, or the stretch it was opened on
    if (G.scopeFrom) {
      const own = scoped() && V2.barHasOwn(L, G.scope.bars);
      h += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="g2-cap">For</span><span class="g2-seg" role="group" aria-label="What this edits">'
        + '<button type="button" data-a="scope" data-k="part" class="' + (scoped() ? '' : 'on') + '" aria-pressed="' + !scoped() + '">Whole part</button>'
        + '<button type="button" data-a="scope" data-k="bar" class="' + (scoped() ? 'on' : '') + '" aria-pressed="' + scoped() + '">' + esc(G.scopeFrom.nm) + '</button></span>'
        + (scoped() ? (own ? '<span class="g2-setn">its own rules</span><button type="button" class="g2-rsall" data-a="scopereset">↺ Back to the part’s</button>'
          : '<span class="g2-hint">takes the part’s rules — change anything to give it its own</span>') : '') + '</div>';
    }
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
    // 2. THE RESULT — the layer's real notes on a piano axis, tap a bar to re-roll it.
    // A key column on the left (one row per semitone, black keys drawn, every C named)
    // and a name on every note, so what each event IS can be read at a glance.
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const isBlack = (m) => [1, 3, 6, 8, 10].indexOf(((m % 12) + 12) % 12) >= 0;
    const nameOf = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
    const mids = ns.map((n) => Math.round(midiOf(n.freq)));
    let lo = mids.length ? Math.min(...mids) - 1 : 47, hi = mids.length ? Math.max(...mids) + 1 : 60;
    while (hi - lo < 12) { lo--; if (hi - lo < 12) hi++; }
    const rows = hi - lo + 1;
    const rowH = clamp(Math.floor(240 / rows), 10, 14);   // ≥10px: a 9px name fits its own row
    const TOP = 18, rollH = TOP + rows * rowH + 4;
    const col = sty ? sty.col : '#a78bfa';
    const yOf = (m) => TOP + (hi - m) * rowH;
    // ONE TAP, TWO MEANINGS → a MODE: Re-roll (tap a bar) or Info (tap a note).
    // ▦ A PATTERN LAYER is drawn as its STEP GRID (2026-10-06): the roll is built and
    // then swapped for the grid picture, so the tap-a-bar re-roll still works on both
    const isPat = !!(V2.formOf && V2.formOf(L) === 'steps');
    const info = !isPat && (G.rollMode === 'info' || !live);
    const hRoll0 = h.length;
    h += '<div class="g2-roll" style="height:' + rollH + 'px">';
    // ◫ the stretch being edited, marked on the whole part
    if (scoped()) G.scope.bars.forEach((k) => {
      const rg = V2.regParse(k); if (!rg) return; const tot = (V2.regSlots || 48) * bars;
      h += '<div style="position:absolute;top:0;bottom:0;pointer-events:none;z-index:1;box-sizing:border-box;left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + (rg.a / tot).toFixed(4) + ');width:calc((100% - ' + KEYW + 'px) * ' + ((rg.b - rg.a) / tot).toFixed(4) + ');background:rgba(94,234,212,.08);border:1px solid #2dd4bf;border-radius:4px"></div>';
    });
    // the key column + row shading
    for (let m = hi; m >= lo; m--) {
      const y = yOf(m), blk = isBlack(m);
      h += '<div style="position:absolute;left:0;width:' + KEYW + 'px;top:' + y + 'px;height:' + rowH + 'px;box-sizing:border-box;border-bottom:1px solid #1f1f33;background:' + (blk ? '#0b0b12' : '#d9d6ea') + '">'
        + ((m % 12 === 0) ? '<span style="position:absolute;right:3px;top:50%;transform:translateY(-50%);font-size:9px;font-weight:700;color:#3b3550">' + nameOf(m) + '</span>' : '') + '</div>';
      if (blk) h += '<div style="position:absolute;left:' + KEYW + 'px;right:0;top:' + y + 'px;height:' + rowH + 'px;background:rgba(255,255,255,.025);pointer-events:none"></div>';
      if (m % 12 === 0) h += '<div style="position:absolute;left:' + KEYW + 'px;right:0;top:' + (y + rowH - 1) + 'px;height:1px;background:#2a2a46;pointer-events:none"></div>';
    }
    // THE STEP GRID: a line per step of the Grid, stronger on each beat (4 a bar;
    // Triplets beat every 3). Too dense to read (< 5px a step) → beats only.
    const spb = spbOf(L), bpb = (spb % 4 === 0) ? spb / 4 : (spb % 3 === 0 ? 3 : spb);
    const rollPx = Math.max(200, ((G.box && G.box.clientWidth) || 390) - 28 - KEYW);
    const stepPx = rollPx / (bars * spb);
    for (let k = 1; k < Math.round(bars * spb); k++) {
      if (k % spb === 0) continue;                       // the bar line is the bar button's edge
      const beat = k % bpb === 0;
      if (!beat && stepPx < 5) continue;
      h += '<div style="position:absolute;top:' + TOP + 'px;bottom:0;width:1px;pointer-events:none;left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + (k / (bars * spb)).toFixed(5) + ');background:' + (beat ? '#2c2c4a' : '#1b1b2e') + '"></div>';
    }
    // the bars you tap (offset past the keys)
    for (let b = 0; b < nb; b++) {
      if (info) {   // Info mode: the bar is a number and an edge, not a button
        h += '<div style="position:absolute;top:0;bottom:0;pointer-events:none;left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + (b / bars).toFixed(4) + ');border-left:1px solid #2a2a46"><span style="position:absolute;top:3px;left:6px;font-size:11px;color:#8d8ab0">' + (b + 1) + '</span></div>';
        continue;
      }
      h += '<button type="button" data-a="bar" data-b="' + b + '" aria-label="Re-roll bar ' + (b + 1) + '" style="position:absolute;top:0;bottom:0;left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + (b / bars).toFixed(4) + ');width:calc((100% - ' + KEYW + 'px) * ' + (1 / bars).toFixed(4) + ');border:0;border-left:1px solid #2a2a46;background:' + (G.flash === b ? 'rgba(167,139,250,.18)' : 'transparent') + ';padding:0">'
        + '<span style="position:absolute;top:3px;left:6px;font-size:11px;color:#8d8ab0">' + (b + 1) + '</span></button>';
    }
    // the notes — in Info mode each is a button (with a padded hit area: a note
    // can be 3px wide); the picked one is outlined and read out under the roll
    // WHERE EACH NOTE WAS WRITTEN: the same take with the three wobbles off. A
    // note the wobbles moved gets an amber mark at that spot and a gap bar.
    const wob = WOB.some(([pp]) => +getPath(L, pp) > 0) && !(L.part.rhythm && L.part.rhythm.straight);
    const stepSec = cyc / (barsOf(L) * spbOf(L));
    const homes = ns.map((n) => n.at);
    if (wob && ns.length) {
      const bare = notesNow(unwobbled(L)).ns.map((x) => x.at);
      ns.forEach((n, i) => { let best = n.at, d = Infinity; bare.forEach((t) => { const dd = Math.abs(t - n.at); if (dd < d) { d = dd; best = t; } }); homes[i] = best; });
    }
    G.homes = homes; G.stepSec = stepSec;
    let offN = 0;
    ns.forEach((n, i) => {
      const m = Math.round(midiOf(n.freq));
      const x = n.at / cyc, w = Math.max(0.006, (n.durMs / 1000) / cyc);
      const offS = (n.at - homes[i]) / stepSec;
      if (Math.abs(offS) > 0.06) {
        offN++;
        const hx = homes[i] / cyc, gx = Math.min(homes[i], n.at) / cyc, gw = Math.abs(n.at - homes[i]) / cyc;
        h += '<span class="g2-mk" style="left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + hx.toFixed(4) + ');top:' + (yOf(m) - 2) + 'px;height:' + (rowH + 3) + 'px"></span>'
          + '<span class="g2-mg" style="left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + gx.toFixed(4) + ');width:calc((100% - ' + KEYW + 'px) * ' + gw.toFixed(4) + ');top:' + (yOf(m) + rowH - 1) + 'px"></span>';
      }
      const pos = 'left:calc(' + KEYW + 'px + (100% - ' + KEYW + 'px) * ' + x.toFixed(4) + ');width:calc((100% - ' + KEYW + 'px) * ' + w.toFixed(4) + ' - 1px);min-width:3px;top:' + (yOf(m) + 1) + 'px;height:' + (rowH - 2) + 'px;border-radius:3px;background:' + col
        + (G.pick === i ? ';outline:2px solid #fff;outline-offset:1px;z-index:4' : '');
      h += info
        ? '<button type="button" class="g2-nt" data-a="note" data-i="' + i + '" aria-label="' + nameOf(m) + '" style="position:absolute;border:0;padding:0;' + pos + '"></button>'
        : '<div style="position:absolute;pointer-events:none;' + pos + '"></div>';
    });
    if (!ns.length) h += '<div class="g2-hint" style="position:absolute;inset:0;left:' + KEYW + 'px;display:flex;align-items:center;justify-content:center">' + (live ? 'Silent — these rules make no notes.' : 'Empty — pick a style to generate.') + '</div>';
    h += '</div>';
    if (isPat) h = h.slice(0, hRoll0) + patPrevHTML(L, ns, cyc, live, col);
    // the mode switch shares the line under the picture — its own row was mostly air
    h += '<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#a9a6c7;flex-wrap:wrap">'
      + (live && !isPat ? '<span class="g2-seg" role="group" aria-label="Tapping the picture">'
        + '<button type="button" data-a="rollmode" data-k="reroll" class="' + (!info ? 'on' : '') + '" aria-pressed="' + !info + '" title="Tap a bar to re-roll it">🎲 Re-roll</button>'
        + '<button type="button" data-a="rollmode" data-k="info" class="' + (info ? 'on' : '') + '" aria-pressed="' + info + '" title="Tap a note to see what it is">ⓘ Info</button></span>' : '')
      + '<span>' + ns.length + (isPat ? ' hits · ' : ' notes · ') + (Math.round(bars * 100) / 100) + ' bar' + (bars === 1 ? '' : 's') + (offN ? ' · <span style="color:#f5b04a">' + offN + ' off the grid</span>' : '') + '</span>'
      + (G.hist.length ? '<button type="button" class="g2-btn" data-a="undo" style="margin-left:auto;min-height:34px;font-size:13px">↶ Undo' + (G.hist.length > 1 ? ' (' + G.hist.length + ')' : '') + '</button>' : '') + '</div>';
    if (info && ns[G.pick]) h += noteInfoHTML(L, ns[G.pick], cyc, spb, bpb, nameOf, homes[G.pick]);
    if (G.rollNote) h += '<div class="g2-hint" style="padding:10px 12px;border-radius:12px;background:#0f2a28;border:1px solid #155e57;color:#b8f0e6">' + esc(G.rollNote) + '</div>';
    // 3. TABS
    h += '<div class="g2-tabs" role="tablist">' + TABS.map((t) => {
      const ctls = (t.secs || []).reduce((a, s) => a.concat(s[1]), []);
      const dice = ctls.some((c) => c.dice);
      const nCh = ctls.filter((c) => (c.choice ? !!getPath(V, c.path) : valOf(V, c) !== defOf(c)) && c.path !== 'instrument.register').length;
      return '<button type="button" role="tab" class="g2-tab' + (G.tab === t.id ? ' on' : '') + '" data-a="tab" data-t="' + t.id + '" aria-selected="' + (G.tab === t.id) + '">' + esc(t.label)
        + '<span style="display:flex;gap:3px;height:14px;align-items:center">' + (dice ? '<span style="display:inline-flex;color:#5eead4">' + DIE + '</span>' : '')
        + (nCh ? '<span style="min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#a78bfa;color:#160f2e;font-size:11px;font-weight:800;line-height:16px;text-align:center">' + nCh + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
    if (!live && sty) {
      h += '<div class="g2-hint">This part plays a frozen take of its ' + esc(sty.name) + ' rules, so the controls are put away. Go back to the live rules to change them — ↶ Undo or ✕ brings the frozen notes back.</div>'
        + '<button type="button" class="g2-btn" data-a="release" style="align-self:flex-start;min-height:40px">⚡ Back to the live rules</button>';
    } else if (!live) {
      h += '<div class="g2-hint">This part plays notes written by hand. Pick a style above to hand it to generated rules — ↶ Undo or ✕ brings the written notes back.</div>';
    }
    if (!live) {   // WRITTEN NOTES keep the two controls the classic panel gave them
      h += tabHTML(L, { id: 'written', secs: WRITTEN }) + harmHTML(L);
    } else {
      // ONE TOPIC, ONE PLACE: each tab opens on its main control (the pattern you tap /
      // Movement), with the finer controls for the same topic beneath it
      if (G.tab === 'rhythm') h += scoped() ? scopedRhythmHTML(V) : rhythmHTML(L);
      if (G.tab === 'pitch') h += movementHTML(V);
      h += tabHTML(V, TABS.find((t) => t.id === G.tab));
    }
    h += '</div>';
    // footer
    h += '<div class="g2-foot"><button type="button" class="g2-btn" data-a="take"' + (live ? '' : ' disabled') + '>🎲 New take</button>'
      + '<button type="button" class="g2-btn" data-a="preview" aria-label="Preview" style="width:48px;padding:0">▶</button>'
      + '<button type="button" class="g2-btn pri" data-a="done">Done</button></div>';
    if (G.dial) h += dialPopHTML(V);
    const sc = G.root.querySelector('.g2-body'), top = sc ? sc.scrollTop : 0;
    G.box.innerHTML = h;
    const sc2 = G.root.querySelector('.g2-body'); if (sc2) sc2.scrollTop = top;
  }

  // ▦ THE PATTERN PICTURE: one row per pitch it plays (or per drum lane), one cell per
  // step, bars set apart; the bar numbers are the tap-to-re-roll targets, as on the roll
  function patPrevHTML(L, ns, cyc, live, col) {
    const r = (L.part || {}).rhythm || {}, cells = Math.max(1, r.steps | 0), nb = Math.max(1, Math.round(barsOf(L)));
    const spb = Math.max(1, Math.round(cells / nb)), kit = (L.instrument || {}).voice === 'kit';
    const NM = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    let rows = [];
    if (kit) {
      (r.lanes || []).forEach((ln, li) => { if ((ln || []).some(Boolean)) rows.push({ nm: (V2.LANE_NAMES || [])[li] || ('Lane ' + (li + 1)), on: Array.from({ length: cells }, (_, k) => !!(ln || [])[k]) }); });
    } else {
      const by = {};
      ns.forEach((n) => { const m = Math.round(midiOf(n.freq)), k = clamp(Math.round(n.at / cyc * cells), 0, cells - 1); (by[m] = by[m] || new Array(cells).fill(false))[k] = true; });
      rows = Object.keys(by).map(Number).sort((a, b) => b - a).map((m) => ({ nm: NM[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1), on: by[m] }));
    }
    const colsT = KEYW + 'px repeat(' + cells + ',minmax(0,1fr))';
    let h = '<div class="g2-roll" style="height:auto;padding:6px 8px 10px 0;display:flex;flex-direction:column;gap:3px">';
    h += '<div style="display:grid;grid-template-columns:' + KEYW + 'px repeat(' + nb + ',minmax(0,1fr));height:22px"><span></span>';
    for (let b = 0; b < nb; b++) {
      h += live ? '<button type="button" data-a="bar" data-b="' + b + '" aria-label="Re-roll bar ' + (b + 1) + '" style="border:0;border-left:1px solid #2a2a46;background:' + (G.flash === b ? 'rgba(167,139,250,.18)' : 'transparent') + ';color:#8d8ab0;font-size:11px;text-align:left;padding:0 0 0 5px">' + (b + 1) + '</button>'
        : '<span style="border-left:1px solid #2a2a46;color:#8d8ab0;font-size:11px;padding-left:5px">' + (b + 1) + '</span>';
    }
    h += '</div>';
    rows.forEach((rw) => {
      h += '<div style="display:grid;grid-template-columns:' + colsT + ';column-gap:1px;align-items:center;height:16px">'
        + '<span style="font-size:10px;font-weight:700;color:#a9a6c7;text-align:right;padding-right:6px;white-space:nowrap;overflow:hidden">' + esc(rw.nm) + '</span>';
      for (let k = 0; k < cells; k++) {
        h += '<span style="height:12px;border-radius:2px;' + (k && k % spb === 0 ? 'margin-left:3px;' : '') + 'background:' + (rw.on[k] ? col : ((Math.floor((k % spb) / Math.max(1, spb / 4)) % 2) ? '#1c1c33' : '#24243e')) + '"></span>';
      }
      h += '</div>';
    });
    if (!rows.length) h += '<div class="g2-hint" style="padding:22px 0;text-align:center">' + (live ? 'Silent — these rules make no hits.' : 'Empty — pick a style to generate a pattern.') + '</div>';
    return h + '</div>';
  }
  function movementHTML(L) {
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
    return h;
  }
  // note-value names for a fraction of a bar (4/4): 1/8 → '8th'
  const NOTE = { 1: 'Bar', 2: 'Half', 4: 'Quarter', 8: '8th', 16: '16th', 32: '32nd', 64: '64th', 128: '128th' };
  // SHIFT = rotate (whole steps; +1 moves the hits EARLIER) + offset (a part step,
  // later). One number in steps, wrapped to ± half the pattern.
  function shiftOf(r) { const st = Math.max(1, r.steps | 0); let s0 = ((-(r.rotate | 0)) % st + st) % st + (Number.isFinite(r.offset) ? r.offset : 0); if (s0 > st / 2) s0 -= st; return s0; }
  function setShift(r, s0) {
    const st = Math.max(1, r.steps | 0), q = Math.round(s0 * 4) / 4, w = Math.floor(q), fr = q - w;
    r.rotate = ((-w) % st + st) % st; if (fr > 1e-6) r.offset = fr; else delete r.offset;
  }
  function chipsHTML(L) {
    let h = '';
    WOB.forEach(([path, nm, col]) => {
      const v = +getPath(L, path) || 0; if (!v) return;
      h += '<button type="button" class="g2-chip2" data-a="jump" data-p="' + path + '" style="--c:' + col + '">' + nm + ' ' + v + ' ↓</button>';
    });
    return h;
  }
  // ── EUCLID PRESETS: the Generate Sequence dialog's own table (`_EUC_PRESETS`,
  // 09-generators-recording.js — one list, so the two can never disagree).
  // Its `rot` is calibrated to `euclideanPattern(k, n, rot)`; the engine adds a
  // phase (`euclidPhase`: the first hit of the unrotated pattern), so the rule's
  // rotate is FOUND by matching the actual hits, not by arithmetic on the numbers.
  const EUC_GROUPS = [[undefined, 'World'], [2, 'Rock / R&B'], [3, 'African'], [4, 'Clave & bell (not Euclidean)'], [5, 'Vapor']];
  const eucPresets = () => ((typeof _EUC_PRESETS !== 'undefined' && Array.isArray(_EUC_PRESETS)) ? _EUC_PRESETS : []);
  const patStr = (k, n, r) => { try { return euclideanPattern(k, n, r).map((x) => (x ? 'x' : '.')).join(''); } catch (e) { return ''; } };
  function rotFor(k, n, rot) {
    const want = patStr(k, n, rot), z = patStr(k, n, 0), ph = Math.max(0, z.indexOf('x'));
    for (let r = 0; r < n; r++) if (patStr(k, n, r + ph) === want) return r;
    return (((rot - ph) % n) + n) % n;
  }
  function presetNow(L) {
    const r = (L.part || {}).rhythm || {};
    if (r.kind === 'euclid' && !r.offset) return eucPresets().find((pz) => !pz.pat && pz.k === (r.pulses | 0) && pz.n === (r.steps | 0) && rotFor(pz.k, pz.n, pz.rot) === (r.rotate | 0)) || null;
    if (r.kind === 'drawn') {
      const nb = Math.max(1, Math.round(barsOf(L))), st = r.steps | 0, cells = (r.cells || []).slice(0, st).map((x) => (x ? 'x' : '.')).join('');
      return eucPresets().find((pz) => pz.pat && st === pz.pat.length * nb && cells === pz.pat.repeat(nb)) || null;
    }
    return null;
  }
  function applyPreset(L, pz) {
    const p = L.part, r0 = p.rhythm || {};
    if (pz.pat) {   // a timeline, not a Euclid: written onto the Step grid, every bar, played straight
      const nb = Math.max(1, Math.round(barsOf(L)));
      if (!isMine(r0)) p.rhythmAlt = clone(r0);
      p.rhythm = Object.assign({}, r0, { kind: 'drawn', steps: pz.pat.length * nb, cells: pz.pat.repeat(nb).split('').map((c) => (c === 'x' ? 1 : 0)), straight: true });
      delete p.rhythm.fig; return;
    }
    const r = p.rhythm = Object.assign({}, isMine(r0) && p.rhythmAlt && !isMine(p.rhythmAlt) ? p.rhythmAlt : r0, { kind: 'euclid', pulses: pz.k, steps: pz.n, rotate: rotFor(pz.k, pz.n, pz.rot) });
    delete r.offset; delete r.shift;
    if (isMine(r0)) p.rhythmAlt = clone(r0);
  }
  function eucPopHTML(L) {
    const cur = presetNow(L);
    let h = '<div class="g2-scrim" data-a="dialx"><div class="g2-pop" role="dialog" aria-modal="true" aria-label="Rhythm presets">'
      + '<div class="g2-pophd"><b>Rhythm presets</b><button type="button" class="g2-btn" data-a="dialx" aria-label="Close" style="margin-left:auto;width:40px;min-height:40px;padding:0">✕</button></div>'
      + '<div class="g2-hint">Hits over steps, from the world’s rhythm traditions. A tap plays it straight away; the numbers are hits, steps.</div>';
    EUC_GROUPS.forEach(([g, nm]) => {
      const list = eucPresets().map((pz, i) => [pz, i]).filter(([pz]) => pz.grp === g); if (!list.length) return;
      h += '<span class="g2-cap">' + esc(nm) + '</span><div class="g2-chs">' + list.map(([pz, i]) => {
        const k = pz.pat ? (pz.pat.match(/x/g) || []).length : pz.k, n = pz.pat ? pz.pat.length : pz.n, on = cur === pz;
        return '<button type="button" class="g2-pill g2-eucp' + (on ? ' on' : '') + '" data-a="eucp" data-i="' + i + '" aria-pressed="' + on + '" title="' + esc(pz.hint || '') + '"><span>' + esc(pz.name) + '</span><small>' + k + ',' + n + '</small></button>';
      }).join('') + '</div>';
    });
    if (cur && cur.hint) h += '<div class="g2-hint" style="color:#ece8f8">' + esc(cur.name) + ': ' + esc(cur.hint) + (cur.pat ? ' — written onto the Step grid' : '') + '.</div>';
    h += '<div class="g2-popft"><button type="button" class="g2-btn pri" data-a="dialx">Done</button></div></div></div>';
    return h;
  }
  function rhythmHTML(L) {
    let h = '';
    const p = L.part, r = p.rhythm || {}, sn = styleName(L);
    let mine = isMine(r);
    const { spb, nb, tot, lit } = partHits(L);
    const bpb = (spb % 4 === 0) ? spb / 4 : (spb % 3 === 0 ? 3 : spb);
    h += '<div class="g2-stack">';
    // WHERE THE RHYTHM COMES FROM: the style's take (generated, bent by the
    // wobbles) or the Step grid (uniform, written by you); the other is kept
    // ▦ A PATTERN LAYER HAS NO "RHYTHM FROM" (2026-10-06, user: "redundant for a Pattern
    // layer … split at the Roll/Pattern type level"). Its grid IS where the rhythm goes —
    // the style's rule is baked onto it after every edit (`V2.bakeSteps`) — so only the
    // rule's own controls show. A layer left on the old Step grid gets a way back.
    const pat = !!(V2.formOf && V2.formOf(L) === 'steps');
    // a DRUM pattern's rhythm is its ♦ Beat lanes — the Drums controls below shape it
    if (pat && (L.instrument || {}).voice === 'kit') return h + '</div>';
    if (pat && r.kind === 'fig') mine = false;           // a named Figure is a rule here, not a hand-written grid
    if (pat && mine) {
      h += '<div class="g2-hint">This pattern’s rhythm was written by hand. Its steps are edited on the layer’s grid.</div>'
        + (ruleOf(L) ? '<button type="button" class="g2-btn" data-a="rsrc" data-k="rule" style="align-self:flex-start;min-height:38px">↺ Use ' + esc(sn) + '’s rule again</button>' : '');
      return h + '</div>';
    }
    if (!pat) h += '<div class="g2-ctl"><b style="grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap">Rhythm from<span class="g2-seg" role="group" aria-label="Where the rhythm comes from">'
      + '<button type="button" data-a="rsrc" data-k="rule" class="' + (!mine ? 'on' : '') + '" aria-pressed="' + !mine + '">🎲 ' + esc(sn) + '’s take</button>'
      + '<button type="button" data-a="rsrc" data-k="mine" class="' + (mine ? 'on' : '') + '" aria-pressed="' + mine + '">▦ Step grid</button></span></b></div>';
    const row = (lab, inner, id) => '<div class="g2-ctl"' + (id ? ' id="' + id + '"' : '') + '><span class="g2-lab">' + lab + '</span><span class="g2-r">' + inner + '</span></div>';
    const sq = (a, k, lab, aria) => '<button type="button" class="g2-btn g2-sq" data-a="' + a + '" data-k="' + k + '" aria-label="' + aria + '">' + lab + '</button>';
    const GSHORT = { 4: 'Quarter', 8: '8th', 12: 'Triplet', 16: '16th', 32: '32nd' };
    const gridRow = row('Grid', '<span class="g2-seg g2-seg-s" role="group" aria-label="Grid">' + GRIDS.map(([n, nm]) => '<button type="button" data-a="grid" data-n="' + n + '" aria-label="' + esc(nm) + '" class="' + (spb === n ? 'on' : '') + '" aria-pressed="' + (spb === n) + '">' + GSHORT[n] + '</button>').join('') + '</span>')
      + (mine ? row('', '<label class="g2-hint" style="display:flex;align-items:center;gap:6px">or <input type="number" inputmode="numeric" min="1" max="64" value="' + spb + '" data-a="gridn" aria-label="Steps a bar" style="width:52px;height:32px;border-radius:9px;border:1px solid #3a3a5c;background:#1b1b30;color:#fff;text-align:center;font:inherit"> steps a bar</label>') : '');
    if (!mine) {
      const chips = chipsHTML(L);
      h += row('Bent by', chips || '<span class="g2-hint">nothing — every hit is on its step</span>');
      if (r.kind === 'euclid' && eucPresets().length) {
        const pz = presetNow(L);
        h += row('Preset', '<button type="button" class="g2-btn" data-a="dial" data-p="__euc" style="min-height:36px">' + esc(pz ? pz.name : 'Custom') + ' ▾</button>');
      }
      if (r.kind === 'euclid' || r.kind === 'pulse') {
        const n = r.kind === 'euclid' ? (r.pulses | 0) : Math.round(V2.speedOf(L) || 0);
        h += row('Hits', '<b class="g2-num">' + n + '</b>' + sq('rule', 'less', '−', 'Fewer hits') + sq('rule', 'more', '+', 'More hits')
          + '<button type="button" class="g2-btn" data-a="take" style="margin-left:auto;min-height:36px">🎲 New take</button>');
      }
      if (r.kind === 'euclid') {
        // SHIFT IN A UNIT YOU PICK: finer than a step (a part-step offset), a step, a beat
        const units = [[0.25, NOTE[spb * 4] || '¼ step'], [0.5, NOTE[spb * 2] || '½ step'], [1, NOTE[spb] || '1 step']];
        if (bpb > 1 && bpb < spb) units.push([bpb, 'Beat']);
        const u = units.some((x) => x[0] === G.sunit) ? G.sunit : 1;
        h += row('Shift', sq('shift', '-1', '◀', 'Shift earlier') + sq('shift', '1', '▶', 'Shift later')
          + '<span class="g2-seg g2-seg-s" role="group" aria-label="Shift by">' + units.map(([v, nm]) => '<button type="button" data-a="sunit" data-u="' + v + '" class="' + (v === u ? 'on' : '') + '" aria-pressed="' + (v === u) + '">' + esc(nm) + '</button>').join('') + '</span>');
        // YOUR shift only (`r.shift`) — the style's own starting rotation is not a shift
        const sh = Number.isFinite(r.shift) ? r.shift : 0, a = Math.abs(sh), w = Math.floor(a + 1e-9), fr = Math.round((a - w) * 4) / 4;
        const nv = (d) => (NOTE[d] || '').toLowerCase(), an = (x) => (/^[8]/.test(x) ? 'an ' : 'a ') + x;
        const qN = nv(spb * 4) || 'quarter step', hN = nv(spb * 2) || 'half step', stepN = nv(spb) || 'step';
        const frN = { 0.25: an(qN), 0.5: an(hN), 0.75: '3 ' + qN + 's' }[fr] || '';
        const wN = w === 1 ? an(stepN) : (w ? w + ' ' + stepN + 's' : '');
        h += row('', !sh ? '<span class="g2-hint">Not shifted.</span>'
          : '<span class="g2-hint">Shifted <b>' + wN + (w && fr ? ' and ' : '') + frN + ' ' + (sh > 0 ? 'later' : 'earlier') + '</b>' + (fr ? ' — every hit sits between steps, together.' : '.') + '</span>'
            + '<button type="button" class="g2-btn" data-a="unshift" style="min-height:30px;font-size:12px">Reset</button>');
        h += gridRow;
      }
      if (r.kind !== 'euclid' && r.kind !== 'pulse') h += '<div class="g2-hint">' + esc(sn) + '’s rhythm has no settings here.' + (pat ? '' : ' Switch to ▦ Step grid to write one.') + '</div>';
    } else {
      // ▦ STEP GRID — uniform: every hit on a step, every hit the same length
      const loose = !r.straight;
      if (eucPresets().length) { const pz = presetNow(L); h += row('Preset', '<button type="button" class="g2-btn" data-a="dial" data-p="__euc" style="min-height:36px">' + esc(pz ? pz.name : 'Custom') + ' ▾</button>'); }
      h += row('Plays', '<span class="g2-seg" role="group" aria-label="How the step grid plays">'
        + '<button type="button" data-a="plays" data-k="straight" class="' + (!loose ? 'on' : '') + '" aria-pressed="' + !loose + '">Straight</button>'
        + '<button type="button" data-a="plays" data-k="loose" class="' + (loose ? 'on' : '') + '" aria-pressed="' + loose + '">Loose</button></span>');
      if (loose) h += row('Bent by', chipsHTML(L) || '<span class="g2-hint">nothing — the wobbles are 0</span>');
      // the strip in the PREVIEW'S GEOMETRY (its key column → a "Steps" gutter)
      const rollPx = Math.max(200, ((G.box && G.box.clientWidth) || 390) - 28 - KEYW);
      const tapStrip = rollPx / tot >= 11;
      const pc = (x) => (x / tot * 100).toFixed(4) + '%';
      let strip = '<div class="g2-gw"><span class="g2-gut">Steps</span><div class="g2-strip" style="grid-template-columns:repeat(' + tot + ',minmax(0,1fr))" role="group" aria-label="Step grid">';
      for (let k = 0; k < tot; k++) {
        const on = lit.has(k), i = k % spb, b = Math.floor(k / spb);
        const cls = 'g2-sc' + (on ? ' on' : '') + (Math.floor(i / bpb) % 2 ? ' odd' : '') + (i === 0 ? ' bar' : '');
        strip += tapStrip ? '<button type="button" class="' + cls + '" data-a="step" data-i="' + k + '" aria-label="Bar ' + (b + 1) + ' step ' + (i + 1) + (on ? ', on' : ', off') + '"></button>'
          : '<span class="' + cls + '"></span>';
      }
      strip += '</div><div class="g2-gov" aria-hidden="true">';
      // held length (a tail), and — Loose — how far a pass may move a hit (amber,
      // under) or stretch it (pink, over)
      const hold = (p.shape && (p.shape.holdSteps | 0)) || 0, hits = [...lit].sort((x, y) => x - y);
      const tv = loose ? (+getPath(L, 'part.rhythm.rateVar') || 0) : 0, lv = loose ? (+L.lenVary || 0) : 0;
      const jit = tv / 100 * 0.4 * (tot / Math.max(1, hits.length));
      hits.forEach((k, j) => {
        const len = hold > 0 ? hold : ((j + 1 < hits.length ? hits[j + 1] : tot) - k) * ((p.shape && p.shape.lenRatio) || 100) / 100;
        if (len > 1.05) strip += '<span class="g2-tail" style="left:' + pc(k + 1) + ';width:' + pc(Math.min(len, tot - k) - 1) + '"></span>';
        if (jit > 0.02) strip += '<span class="g2-haze" style="left:' + pc(Math.max(0, k - jit)) + ';width:' + pc(jit * 2 + 0.05) + '"></span>';
        if (lv > 0) strip += '<span class="g2-fade" style="left:' + pc(k + len * (1 - 0.6 * lv / 100)) + ';width:' + pc(len * 1.2 * lv / 100) + '"></span>';
      });
      strip += '</div></div>';
      h += strip;
      if (jit > 0.02 || lv > 0) h += '<div class="g2-legend">' + (jit > 0.02 ? '<span><i style="background:#f5b04a"></i>where a pass may start it</span>' : '') + (lv > 0 ? '<span><i style="background:linear-gradient(90deg,#f9a8d4,#f9a8d400)"></i>where it may end</span>' : '') + '</div>';
      if (!tapStrip) {
        // too fine to tap: one row a bar for editing
        let rows = '';
        for (let b = 0; b < nb; b++) {
          rows += '<div style="display:flex;align-items:center;min-width:0"><span style="width:' + (KEYW + 1) + 'px;flex:none;font-size:11px;color:#8d8ab0">' + (b + 1) + '</span><div style="flex:1;min-width:0;margin-right:1px;display:grid;grid-template-columns:repeat(' + spb + ',minmax(0,1fr));gap:1px">';
          for (let i = 0; i < spb; i++) { const g = b * spb + i, on = lit.has(g); rows += '<button type="button" class="g2-step' + (on ? ' on' : '') + '" data-a="step" data-i="' + g + '" aria-label="Bar ' + (b + 1) + ' step ' + (i + 1) + (on ? ', on' : ', off') + '"></button>'; }
          rows += '</div></div>';
        }
        h += '<div class="g2-hint">These steps are too small to tap — edit them a bar at a time:</div>' + rows;
      }
      const L4 = [[1, '1 step'], [2, '2 steps'], [4, '4 steps'], [0, 'To next']];
      h += row('Length', '<span class="g2-seg" role="group" aria-label="Length of every hit">' + L4.map(([v, nm]) => '<button type="button" data-a="hold" data-n="' + v + '" class="' + (hold === v ? 'on' : '') + '" aria-pressed="' + (hold === v) + '">' + nm + '</button>').join('') + '</span>');
      h += gridRow;
      h += row('', '<button type="button" class="g2-btn" data-a="recopy" style="min-height:34px;font-size:13px">↺ Copy ' + esc(sn) + '’s take</button>');
      h += row('Start from', '<span style="display:flex;gap:6px;overflow-x:auto;min-width:0;padding-bottom:2px">' + FIGS.map(([id, nm, st]) => {
        const dots = Array.from({ length: 16 }, (_, i) => '<span style="width:3px;height:7px;border-radius:2px;background:' + (st.indexOf(i) >= 0 ? '#a78bfa' : '#33334f') + '"></span>').join('');
        return '<button type="button" class="g2-pill" data-a="fig" data-k="' + id + '" style="flex:none;display:flex;flex-direction:column;gap:3px;padding:5px 7px;min-height:44px"><span>' + esc(nm) + '</span><span style="display:flex;gap:1px">' + dots + '</span></button>';
      }).join('') + '</span>');
    }
    h += '</div>';
    return h;
  }

  // ◫ A STRETCH'S RHYTHM — the rule's own numbers (the Step grid is a whole-part pattern)
  function scopedRhythmHTML(L) {
    const r = (L.part || {}).rhythm || {};
    const row = (lab, inner) => '<div class="g2-ctl"><span class="g2-lab">' + lab + '</span><span class="g2-r">' + inner + '</span></div>';
    const sq = (k, lab, aria) => '<button type="button" class="g2-btn g2-sq" data-a="srh" data-k="' + k + '" aria-label="' + aria + '">' + lab + '</button>';
    let h = '<div class="g2-stack">';
    if (r.kind === 'euclid') {
      h += row('Hits', '<b class="g2-num">' + (r.pulses | 0) + '</b>' + sq('p-', '−', 'Fewer hits') + sq('p+', '+', 'More hits'));
      h += row('Steps', '<b class="g2-num">' + ((r.steps | 0) || 16) + '</b>' + sq('s-', '−', 'Fewer steps') + sq('s+', '+', 'More steps'));
      h += row('Shift', sq('r-', '◀', 'Shift earlier') + sq('r+', '▶', 'Shift later'));
    } else if (r.kind === 'pulse') {
      h += row('Hits', '<b class="g2-num">' + ((r.n | 0) || 4) + '</b>' + sq('n-', '−', 'Fewer hits') + sq('n+', '+', 'More hits'));
    } else {
      h += '<div class="g2-hint">This rhythm has no hit count of its own — pick a Rhythm type below, or switch to Whole part for the step grid.</div>';
    }
    return h + '</div>';
  }
  function tabHTML(L, t) {
    let h = '';
    if (t.id === 'more' && !scoped()) {   // (the layer's harmony rule is whole-layer)
      h += harmHTML(L);
    }
    if (false) {
      const hm = L.harmony || 'fixed';
      h += '<div style="display:flex;flex-direction:column;gap:8px"><span class="g2-cap">Chords moving under written notes</span><div style="display:flex;gap:6px;flex-wrap:wrap">'
        + [['fixed', 'Play as written'], ['diatonic', 'Stay in key'], ['chordlock', 'Lock to chord']].map(([k, nm]) =>
          '<button type="button" class="g2-pill' + (hm === k ? ' on' : '') + '" data-a="harm" data-k="' + k + '">' + esc(nm) + '</button>').join('') + '</div>'
        + '<div class="g2-hint">Answer another layer, Key & notes and the full Recipe are still in the classic Generate for now.</div></div>';
      return h;
    }
    let hidden = 0;
    t.secs.forEach(([nm, ctls0], si) => {
      const ctls = ctls0.filter((c) => { const ok = whenOK(L, c.w); if (!ok) hidden++; return ok || G.showAll; });
      if (!ctls.length) return;
      const n = ctls.filter((c) => (c.choice ? false : valOf(L, c) !== defOf(c))).length;
      h += '<div class="g2-sec"><div class="g2-sechead"><span class="g2-cap">' + esc(nm) + '</span>'
        + (n ? '<span class="g2-setn">' + n + ' set</span><button type="button" class="g2-rsall" data-a="dreset" data-t="' + t.id + '" data-s="' + si + '">Reset all</button>' : '') + '</div><div class="g2-tiles">';
      ctls.forEach((c) => { h += c.html ? c.html(L) : tileHTML(L, c); });
      h += '</div></div>';
    });
    if (hidden) h += '<button type="button" class="g2-rsall" data-a="showall" style="align-self:flex-start;margin:0">' + (G.showAll ? 'Hide the ' + hidden + ' settings that don’t apply' : 'Show all settings (' + hidden + ' more don’t apply to this layer)') + '</button>';
    if (t.id === 'more' && !scoped()) h += classicHTML(L);
    return h;
  }
  // WHAT IS STILL ONLY IN THE CLASSIC PANEL: custom rows with no tile yet. Named,
  // and one tap away — never silently gone.
  function classicHTML() {
    return '<div class="g2-sec"><span class="g2-cap">Still in the classic Generate</span>'
      + '<div class="g2-hint">Per-die controls and the dice taste, Recipe, Key & notes for a part, chance per step, ConFugued intervals, and the drum lane editor.</div>'
      + '<button type="button" class="g2-btn" data-a="classic" style="align-self:flex-start;min-height:38px">Open the classic Generate</button></div>';
  }
  // DOES THIS CONTROL APPLY TO THIS LAYER — the classic panel's `data-v2when`
  // grammar ('kind:live;voice:synth;pitch:chord,stack'), read off the layer.
  // A miss on a STRUCTURAL key (what kind of rhythm/pitch/voice) HIDES the tile;
  // a setting another tile can switch on DIMS it instead (META gates).
  function whenOK(L, w) {
    if (!w) return true;
    const p = L.part || {}, now = {
      kind: (p.kind === 'recorded' && p.made === 'take') ? ['live', 'recorded'] : p.kind,
      voice: (L.instrument && L.instrument.voice) || 'synth', rhythm: rk(L) || '', pitch: pk(L) || '',
      shape: lenShapeOn(L) ? 'on' : 'off', evo: (((L.chg || {}).ev | 0) > 0) ? 'on' : 'off',
    };
    return w.split(';').every((cl) => {
      const [k, vs] = cl.split(':'); if (!(k in now)) return true;
      const want = String(vs || '').split(','), have = now[k];
      return Array.isArray(have) ? have.some((v) => want.indexOf(v) >= 0) : want.indexOf(have) >= 0;
    });
  }
  const optsOf = (L, c) => (typeof c.opts === 'function' ? c.opts(L) : c.opts) || [];
  const choiceGet = (L, c) => (c.get ? c.get(L) : String(getPath(L, c.path) ?? (c.def ?? '')));
  function choiceSet(L, c, k) {
    if (c.set) { c.set(L, k); return; }
    const ks = c.path.split('.'), last = ks.pop();
    let o = L; ks.forEach((x) => { o[x] = Object.assign({}, o[x] || {}); o = o[x]; });
    if (k === '' || k === undefined) delete o[last]; else o[last] = c.num ? +k : k;
  }
  // a tile: name, a small gauge (or the chosen option), 🎲 if a re-roll changes it
  function tileHTML(L, c) {
    const m = metaOf(c), why = (scoped() && !scopable(c.path) ? 'whole part only' : null) || (c.gate ? c.gate(L) : null) || (m.gate ? m.gate(L) : null) || (whenOK(L, c.w) ? null : 'not for this layer');
    if (c.choice) {
      const k = choiceGet(L, c), o = optsOf(L, c).find((x) => x[0] === k), lab = (c.show && c.show(L)) || (o ? o[1] : (k || 'Off'));
      const set = k !== String(c.def ?? '') && k !== '' && !(c.path === 'part.rhythm.kind' || c.path === 'part.pitch.kind');
      return '<button type="button" class="g2-tile' + (set ? ' set' : '') + (why ? ' na' : '') + '" data-a="dial" data-p="' + c.path + '" aria-label="' + esc(c.label + ', ' + lab + (why ? ', ' + why : '')) + '">'
        + '<span class="g2-tnm">' + esc(c.label) + '</span><span class="g2-tch">' + esc(lab) + '</span>' + (why ? '<span class="g2-ttag">' + esc(why) + '</span>' : '') + '</button>';
    }
    const v = valOf(L, c), set = v !== defOf(c);
    return '<button type="button" class="g2-tile' + (set ? ' set' : '') + (why ? ' na' : '') + '" data-a="dial" data-p="' + c.path + '" aria-label="' + esc(c.label + ', ' + v + (c.unit || '') + (why ? ', ' + why : '')) + '">'
      + (c.dice ? '<span class="g2-tdie" title="Changes with every re-roll">' + DIE + '</span>' : '')
      + '<span class="g2-tnm">' + esc(c.label) + '</span>' + gaugeSVG(c, v, set)
      + (why ? '<span class="g2-ttag">' + esc(why) + '</span>' : '') + '</button>';
  }
  // ARCS: −135° … +135° (a 270° sweep, 0 at the top); the fill runs from ZERO
  // (or the bottom of the range) to the value, so Contour fills both ways
  const ptA = (cx, cy, r, deg) => { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  function arcD(cx, cy, r, d0, d1) {
    if (d1 < d0) { const t0 = d0; d0 = d1; d1 = t0; }
    if (d1 - d0 < 0.5) return '';
    const [x0, y0] = ptA(cx, cy, r, d0), [x1, y1] = ptA(cx, cy, r, d1);
    return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (d1 - d0 > 180 ? 1 : 0) + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
  }
  const degAt = (c, v) => -135 + 270 * (v - c.min) / Math.max(1, c.max - c.min);
  const zeroAt = (c) => degAt(c, clamp(0, c.min, c.max));
  function gaugeSVG(c, v, set) {
    const col = set ? '#a78bfa' : '#4a4a6e', fill = arcD(26, 26, 19, zeroAt(c), degAt(c, v));
    return '<svg class="g2-gauge" viewBox="0 0 52 44" aria-hidden="true"><path d="' + arcD(26, 26, 19, -135, 135) + '" stroke="#2c2c48" stroke-width="5" fill="none" stroke-linecap="round"/>'
      + (fill ? '<path d="' + fill + '" stroke="' + col + '" stroke-width="5" fill="none" stroke-linecap="round"/>' : '')
      + '<text x="26" y="31" text-anchor="middle">' + v + '</text></svg>';
  }
  const ctlOf = (path) => { for (const t of TABS.concat([{ secs: WRITTEN }])) for (const s0 of (t.secs || [])) for (const c of s0[1]) if (c.path === path) return c; return null; };
  function dialSVG(c, v) {
    const cx = 105, cy = 100, r = 78, d = degAt(c, v), [kx, ky] = ptA(cx, cy, r, d);
    let ticks = '';
    for (let i = 0; i <= 10; i++) { const dd = -135 + 27 * i, [a1, b1] = ptA(cx, cy, r + 12, dd), [a2, b2] = ptA(cx, cy, r + (i % 5 ? 16 : 20), dd); ticks += '<line x1="' + a1.toFixed(1) + '" y1="' + b1.toFixed(1) + '" x2="' + a2.toFixed(1) + '" y2="' + b2.toFixed(1) + '" stroke="#4a4a6e" stroke-width="' + (i % 5 ? 1.5 : 2.5) + '"/>'; }
    const df = defOf(c), [dx, dy] = ptA(cx, cy, r, degAt(c, df)), fill = arcD(cx, cy, r, zeroAt(c), d);
    return ticks + '<path d="' + arcD(cx, cy, r, -135, 135) + '" stroke="#2a2a46" stroke-width="16" fill="none" stroke-linecap="round"/>'
      + (fill ? '<path d="' + fill + '" stroke="#a78bfa" stroke-width="16" fill="none" stroke-linecap="round"/>' : '')
      + (df !== clamp(0, c.min, c.max) ? '<circle cx="' + dx.toFixed(1) + '" cy="' + dy.toFixed(1) + '" r="3" fill="#ece8f8" opacity=".6"><title>default</title></circle>' : '')
      + '<circle cx="' + kx.toFixed(1) + '" cy="' + ky.toFixed(1) + '" r="13" fill="#fff" stroke="#8b5cf6" stroke-width="4"/>'
      + '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" style="font-size:38px;fill:#ece8f8;font-variant-numeric:tabular-nums">' + v + '</text>'
      + '<text x="' + cx + '" y="' + (cy + 34) + '" text-anchor="middle" style="font-size:13px;fill:#a9a6c7">' + (c.unit === '%' ? 'percent' : (c.min < 0 ? c.min + ' to ' + c.max : 'of ' + c.max)) + '</text>';
  }
  // the popover: one large dial (or, for a choice, its options), what it does, both ends
  function dialPopHTML(L) {
    if (G.dial === '__euc') return eucPopHTML(L);
    const c = ctlOf(G.dial); if (!c) return '';
    const m = metaOf(c), why = (scoped() && !scopable(c.path) ? 'whole part only' : null) || (c.gate ? c.gate(L) : null) || (m.gate ? m.gate(L) : null) || (whenOK(L, c.w) ? null : 'not for this layer');
    let h = '<div class="g2-scrim" data-a="dialx"><div class="g2-pop" role="dialog" aria-modal="true" aria-label="' + esc(c.label) + '" data-stop="1">';
    h += '<div class="g2-pophd"><b>' + esc(c.label) + '</b>' + (c.dice ? '<span class="g2-bdg d">' + DIE + 're-rolls</span>' : '') + (why ? '<span class="g2-bdg na">' + esc(why) + '</span>' : '')
      + '<button type="button" class="g2-btn" data-a="dialx" aria-label="Close" style="margin-left:auto;width:40px;min-height:40px;padding:0">✕</button></div>';
    if (c.choice) {
      const k = choiceGet(L, c), os = optsOf(L, c), cur = os.find((x) => x[0] === k);
      h += '<div class="g2-hint" style="color:#ece8f8;font-size:14px">' + esc(c.what || m.what || '') + '</div><div class="g2-chs">'
        + os.map(([x, nm]) => '<button type="button" class="g2-pill' + (k === x ? ' on' : '') + '" data-a="dchoose" data-k="' + esc(x) + '" aria-pressed="' + (k === x) + '">' + esc(nm) + '</button>').join('') + '</div>'
        + (cur && cur[2] ? '<div class="g2-hint">' + esc(cur[2]) + '</div>' : '') + (why ? '<div class="g2-hint">' + esc(m.long || why) + '</div>' : '');
    } else {
      const v = Number.isFinite(G.dialV) ? G.dialV : valOf(L, c);
      h += '<div class="g2-dialrow"><button type="button" class="g2-pm" data-a="dstep" data-d="-1" aria-label="Less">−</button>'
        + '<svg class="g2-dial" viewBox="0 0 210 190" role="slider" tabindex="0" aria-label="' + esc(c.label) + '" aria-valuemin="' + c.min + '" aria-valuemax="' + c.max + '" aria-valuenow="' + v + '">' + dialSVG(c, v) + '</svg>'
        + '<button type="button" class="g2-pm" data-a="dstep" data-d="1" aria-label="More">+</button></div>'
        + '<div class="g2-ends"><span><b>' + c.min + (c.unit || '') + '</b> · ' + esc(m.lo || '') + '</span><span><b>' + c.max + (c.unit || '') + '</b> · ' + esc(m.hi || '') + '</span></div>'
        + '<div class="g2-what">' + esc(m.what || '') + '</div>'
        + '<div class="g2-hint">' + (why ? esc(m.long || '') + ' ' : '') + (c.dice ? 'A 🎲 re-roll picks a new value for this.' : '') + (defOf(c) !== clamp(0, c.min, c.max) ? ' Default is ' + defOf(c) + (c.unit || '') + ' (the faint dot).' : '') + '</div>';
    }
    h += '<div class="g2-popft">' + (c.choice ? '' : '<button type="button" class="g2-btn" data-a="ddef">Reset</button>') + '<button type="button" class="g2-btn pri" data-a="dialx">Done</button></div></div></div>';
    return h;
  }
  const dialStep = (c) => ((c.max - c.min) > 150 ? 5 : 1);
  function commitDial(path, v) {
    const c = ctlOf(path); if (!c) return;
    const val = clamp(Math.round(v), c.min, c.max);
    if (c.set) { edit((L) => { c.set(L, val); }, ''); return; }
    edit((L) => { if (val === defOf(c) && getPath(L, path) === undefined) return; setPath(L, path, val); }, '');
  }

  function harmHTML(L) {
    const hm = L.harmony || 'fixed';
    return '<div style="display:flex;flex-direction:column;gap:8px"><span class="g2-cap">Chords moving under written notes</span><div style="display:flex;gap:6px;flex-wrap:wrap">'
      + [['fixed', 'Play as written'], ['diatonic', 'Stay in key'], ['chordlock', 'Lock to chord']].map(([k, nm]) =>
        '<button type="button" class="g2-pill' + (hm === k ? ' on' : '') + '" data-a="harm" data-k="' + k + '">' + esc(nm) + '</button>').join('') + '</div></div>';
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
    // ◫ SCOPE — the whole part, or the stretch the sheet was opened on
    if (a === 'scope') { G.scope = (b.getAttribute('data-k') === 'bar') ? G.scopeFrom : null; G.note = ''; G.rollNote = ''; G.dial = null; paint(); return; }
    if (a === 'scopereset' && scoped()) { editReal((R) => { V2.resetBars(R, G.scope.bars); }, G.scope.nm + ' takes the part’s rules again.'); return; }
    if (a === 'take' && scoped()) {
      // a STRETCH'S OWN TAKE (`ruleb[k].take`, an offset on the part's) — playback hears it
      editReal((R) => { R.part.ruleb = R.part.ruleb || {}; G.scope.bars.forEach((k) => { const o = R.part.ruleb[String(k)] || (R.part.ruleb[String(k)] = {}); o.take = (o.take | 0) + 1; }); },
        'A new take of ' + G.scope.nm + ' — the rest of the part kept its notes.'); return;
    }
    if (a === 'srh') {
      const k = b.getAttribute('data-k');
      edit((V) => { const r = V.part.rhythm = Object.assign({}, V.part.rhythm), st = Math.max(2, (r.steps | 0) || 16);
        if (k === 'p-' || k === 'p+') r.pulses = clamp((r.pulses | 0) + (k === 'p+' ? 1 : -1), 1, st);
        if (k === 's-' || k === 's+') { r.steps = clamp(st + (k === 's+' ? 1 : -1), 2, 64); r.pulses = clamp(r.pulses | 0, 1, r.steps); }
        if (k === 'r-' || k === 'r+') r.rotate = (((r.rotate | 0) + (k === 'r+' ? -1 : 1)) % st + st) % st;   // +1 moves the hits earlier
        if (k === 'n-' || k === 'n+') r.n = clamp(((r.n | 0) || 4) + (k === 'n+' ? 1 : -1), 1, 64);
      }, ''); return;
    }
    if (a === 'dchoose' && G.dial === '__char') {
      const k = b.getAttribute('data-k');
      if (scoped()) editReal((R) => { V2.setBarChar(E, R, G.scope.bars.slice(), k || ''); }, k ? '' : G.scope.nm + ' takes the part’s rules again.');
      else editReal((R) => { if (k) V2.applyPreset(E, R, k); else delete R.part.preset; }, '');
      return;
    }
    if (a === 'dial' && scoped() && !scopable(b.getAttribute('data-p'))) {
      const c = ctlOf(b.getAttribute('data-p'));
      G.note = (c ? c.label : 'That') + ' is set for the whole part — switch to Whole part above to change it.'; paint(); return;
    }
    if (a === 'undo') { const j = G.hist.pop(); restore(j); G.note = 'Undone.'; G.rollNote = ''; paint(); return; }
    if (a === 'preview') { try { V2.preview(E, layer()); } catch (e) {} return; }
    if (a === 'style' && scoped()) {
      // ◫ A STYLE FOR ONE STRETCH: the style is built on a scratch copy and its rules
      // become the stretch's own (only what differs from the part is stored)
      const s = STYLES.find((x) => x.k === b.getAttribute('data-k')); if (!s) return;
      editReal((R) => {
        const t = clone(R); s.make(E, t);
        G.scope.bars.forEach((k) => { const o = R.part.ruleb && R.part.ruleb[String(k)]; if (o) { delete o.rhythm; delete o.pitch; delete o.shape; delete o.char; } });
        const F = V2.barFields || {};
        ['rhythm', 'pitch', 'shape'].forEach((g) => Object.keys(F[g] || {}).forEach((f) => {
          const v = ((t.part || {})[g] || {})[f]; if (v !== undefined) V2.setBarRule(R, G.scope.bars, g, f, typeof v === 'boolean' ? (v ? 1 : 0) : v);
        }));
      }, G.scope.nm + ' plays as ' + s.name + ' now — the rest of the part keeps its own.');
      G.styleOpen = false; G.rollNote = ''; paint(); return;
    }
    if (a === 'style') {
      const s = STYLES.find((x) => x.k === b.getAttribute('data-k')); if (!s) return;
      const was = styleOf(layer());
      const dressIt = G.fresh && !G.dressed;
      const p0 = layer().part || {}, mine0 = isMine(p0.rhythm) ? clone(p0.rhythm) : (isMine(p0.rhythmAlt) ? clone(p0.rhythmAlt) : null);
      // LEAVING ♦ BEAT LEAVES THE DRUM KIT (2026-10-06): Beat switches the voice to the kit and
      // nothing switched it back, so every pitched style picked after it played 0 notes
      edit((L) => { if (s.k !== 'beat' && L.instrument && L.instrument.voice === 'kit') L.instrument.voice = 'synth'; if (dressIt) dress(E, L, s); s.make(E, L); if (mine0 && !isMine(L.part.rhythm)) L.part.rhythmAlt = mine0; else if (!mine0) delete L.part.rhythmAlt; }, 'Now ' + s.name + ' — its own rules, with your sound unchanged.' + (was && was !== s.k ? ' ↶ Undo goes back to ' + (STYLES.find((x) => x.k === was) || {}).name + '.' : ''));
      if (dressIt) G.dressed = true;
      G.styleOpen = false; G.rollNote = ''; paint(); return;
    }
    if (a === 'moveopen') { G.moveOpen = true; paint(); return; }
    if (a === 'moveclose') { G.moveOpen = false; paint(); return; }
    if (a === 'move') { const k = b.getAttribute('data-k'); G.moveOpen = false; edit((L) => applyMove(L, k), ''); return; }
    if (a === 'sub') { const k = b.getAttribute('data-k'), i = +b.getAttribute('data-i'); edit((L) => { applyMove(L, k); SUB[k].set(L, i); }, ''); return; }
    if (a === 'harm') { const k = b.getAttribute('data-k'); edit((L) => { if (k === 'fixed') delete L.harmony; else L.harmony = k; }, ''); return; }
    if (a === 'rollmode') { G.rollMode = b.getAttribute('data-k'); G.pick = -1; G.rollNote = ''; paint(); return; }
    if (a === 'note') { const i = +b.getAttribute('data-i'); G.pick = (G.pick === i) ? -1 : i; paint(); return; }
    if (a === 'release') { edit((L) => { V2.release(G.E, L); }, 'Back on the live rules — the frozen notes are gone (↶ Undo keeps them).'); return; }
    if (a === 'take') { edit((L) => { V2.newTake(L); }, 'A new take of the same rules.'); return; }
    if (a === 'fig') {   // START FROM a figure: written onto the Step grid, every bar (stays uniform)
      const f = FIGS.find((x) => x[0] === b.getAttribute('data-k')); if (!f) return;
      edit((L) => { toMine(L); const cur = partHits(L), lit = new Set();
        for (let bb = 0; bb < cur.nb; bb++) f[2].forEach((i16) => lit.add(bb * cur.spb + clamp(Math.round(i16 * cur.spb / 16), 0, cur.spb - 1)));
        writePart(L, cur.spb, cur.nb, lit); }, 'Started from ' + f[1] + '.'); return;
    }
    if (a === 'grid' && !isMine((layer().part || {}).rhythm)) {
      const n = +b.getAttribute('data-n');
      edit((L) => {
        if (!perBarRule(L)) { V2.setSpeed(G.E, L, n); return; }
        const r = L.part.rhythm = Object.assign({}, L.part.rhythm), share = (r.pulses | 0) / Math.max(1, r.steps | 0);
        r.steps = n; r.pulses = clamp(Math.round(share * n), 1, n); r.rotate = ((r.rotate | 0) % n + n) % n;
      }, ''); return;
    }
    if (a === 'grid') {
      const n = +b.getAttribute('data-n');
      regrid(n); return;
    }
    if (a === 'step' || a === 'hits') {
      edit((L) => {
        toMine(L);
        const cur = partHits(L), lit = new Set(cur.lit);
        if (a === 'step') { const i = +b.getAttribute('data-i'); if (lit.has(i)) lit.delete(i); else lit.add(i); }
        else {
          // EVEN HITS IN EVERY BAR: one more/less than the busiest bar, spread evenly
          let most = 0; for (let k = 0; k < cur.nb; k++) { let c = 0; for (let i = 0; i < cur.spb; i++) if (lit.has(k * cur.spb + i)) c++; most = Math.max(most, c); }
          const want = clamp(most + (+b.getAttribute('data-d')), 1, cur.spb);
          lit.clear(); for (let k = 0; k < cur.nb; k++) for (let j = 0; j < want; j++) lit.add(k * cur.spb + Math.floor(j * cur.spb / want));
        }
        writePart(L, cur.spb, cur.nb, lit);
      }, ''); return;
    }
    if (a === 'shift' || a === 'unshift') {
      const d = a === 'unshift' ? 0 : (+b.getAttribute('data-k')) * (G.sunit || 1);
      edit((L) => { const r = L.part.rhythm = Object.assign({}, L.part.rhythm); if (r.kind !== 'euclid') return; const st = Math.max(1, r.steps | 0);
        const mine0 = Number.isFinite(r.shift) ? r.shift : 0, dd = a === 'unshift' ? -mine0 : d;
        let s0 = shiftOf(r) + dd; while (s0 > st / 2) s0 -= st; while (s0 <= -st / 2) s0 += st; setShift(r, s0);
        let u = mine0 + dd; while (u > st / 2) u -= st; while (u <= -st / 2) u += st;
        if (Math.abs(u) > 1e-6) r.shift = Math.round(u * 4) / 4; else delete r.shift; }, ''); return;
    }
    if (a === 'sunit') { G.sunit = +b.getAttribute('data-u'); paint(); return; }
    if (a === 'plays') { const k = b.getAttribute('data-k'); edit((L) => { const r = L.part.rhythm = Object.assign({}, L.part.rhythm); if (k === 'straight') r.straight = true; else delete r.straight; }, ''); return; }
    if (a === 'hold') { const n = +b.getAttribute('data-n'); edit((L) => { L.part.shape = Object.assign({}, L.part.shape); if (n > 0) L.part.shape.holdSteps = n; else delete L.part.shape.holdSteps; }, ''); return; }
    if (a === 'jump' || a === 'dial') { G.dial = b.getAttribute('data-p'); G.dialV = NaN; paint(); const d = G.box.querySelector('.g2-dial, .g2-chs button'); if (d) try { d.focus({ preventScroll: true }); } catch (e) {} return; }
    if (a === 'dialx') { if (b.classList.contains('g2-scrim') && ev.target !== b) return; G.dial = null; G.dialV = NaN; paint(); return; }
    if (a === 'dstep') { const c = ctlOf(G.dial), L = viewOf(layer()); if (c && L) commitDial(G.dial, valOf(L, c) + (+b.getAttribute('data-d')) * dialStep(c)); return; }
    if (a === 'ddef') { const c = ctlOf(G.dial); if (c) edit((L) => { const ks = c.path.split('.'), last = ks.pop(), o = ks.reduce((x, k) => (x ? x[k] : x), L); if (o) delete o[last]; }, ''); return; }
    if (a === 'dchoose') { const k = b.getAttribute('data-k'), c = ctlOf(G.dial); if (c) edit((L) => choiceSet(L, c, k), ''); return; }
    if (a === 'eucp') { const pz = eucPresets()[+b.getAttribute('data-i')]; if (pz) edit((L) => applyPreset(L, pz), pz.name + (pz.pat ? ' — written onto the Step grid (your rule is kept).' : '.')); return; }
    if (a === 'showall') { G.showAll = !G.showAll; paint(); return; }
    if (a === 'classic') {   // the classic panel, for the rows that have no tile yet — this sheet keeps what you did
      const L = layer(), E = G.E; close(false); try { if (L && V2.openGen) V2.openGen(E, L); } catch (e) {} return;
    }
    if (a === 'time') {
      const L = layer(); if (!L) return;
      if (!V2.openTime || !V2.openTime(G.E, L, () => { if (G) paint(); })) { G.note = 'Open the layer’s card to set its length and speed.'; paint(); }
      return;
    }
    if (a === 'odd') {
      if (scoped()) { G.note = 'Odds is set for the whole part — switch to Whole part above to change it.'; paint(); return; }
      const i = b.getAttribute('data-i') | 0;
      edit((L) => {
        const p = L.part; if (!p) return;
        const cur = (p.timing && p.timing.odds && Number.isFinite(p.timing.odds[String(i)])) ? (p.timing.odds[String(i)] | 0) : 100;
        const at = ODDS_STEPS.indexOf(cur), nx = ODDS_STEPS[(at < 0 ? 0 : at + 1) % ODDS_STEPS.length];
        if (!p.timing || typeof p.timing !== 'object') p.timing = {};
        if (!p.timing.odds || typeof p.timing.odds !== 'object') p.timing.odds = {};
        p.timing.odds[String(i)] = nx;                 // 100 is pruned by normalize
      }, '');
      return;
    }
    if (a === 'dreset') {
      const t = TABS.concat([{ id: 'written', secs: WRITTEN }]).find((x) => x.id === b.getAttribute('data-t')), sec = t && t.secs[+b.getAttribute('data-s')]; if (!sec) return;
      edit((L) => sec[1].forEach((c) => { if (c.html) return; if (c.reset) { c.reset(L); return; } const ks = c.path.split('.'), last = ks.pop(), o = ks.reduce((x, k) => (x ? x[k] : x), L); if (o && c.path !== 'instrument.register') delete o[last]; }), sec[0] + ' back to defaults.'); return;
    }
    if (a === 'rsrc') {
      const k = b.getAttribute('data-k');
      edit((L) => { if (k === 'mine') toMine(L); else toRule(L); },
        k === 'mine' ? 'Step grid — ' + styleName(layer()) + '’s take snapped onto the steps. The take is kept: switch back any time.'
          : styleName(layer()) + '’s take again. Your step grid is kept.');
      return;
    }
    if (a === 'recopy') {
      edit((L) => { const rule = ruleOf(L); if (!rule) return; const t = clone(L); t.part.rhythm = rule.rhythm; if (rule.barsMode) t.part.barsMode = rule.barsMode; const h = partHits(t); writePart(L, h.spb, h.nb, h.lit); if (!L.part.rhythmAlt) L.part.rhythmAlt = rule.rhythm; }, 'Your pattern is a fresh copy of the rule (↶ Undo brings your edits back).');
      return;
    }
    if (a === 'rule') {   // the rule's own knobs: hits across the part, shift, new rhythm
      const k = b.getAttribute('data-k');
      edit((L) => {
        const r = L.part.rhythm = Object.assign({}, L.part.rhythm), st = Math.max(1, r.steps | 0);
        if (r.kind === 'pulse') { const sp = V2.speedOf(L) || 1; V2.setSpeed(G.E, L, Math.max(1, Math.round(sp) + (k === 'more' ? 1 : -1))); return; }
        if (k === 'more' || k === 'less') r.pulses = clamp((r.pulses | 0) + (k === 'more' ? 1 : -1), 1, st);
        if (k === 'left' || k === 'right') r.rotate = (((r.rotate | 0) + (k === 'right' ? 1 : -1)) % st + st) % st;
        if (k === 'dice') { r.pulses = clamp(Math.round(st * (0.3 + Math.random() * 0.35)), 1, st); r.rotate = Math.floor(Math.random() * st); }
      }, k === 'dice' ? 'A new rhythm from the same rule.' : '');
      return;
    }
    if (a === 'bar') {
      const L = layer(); if (!L || !(L.part && L.part.kind === 'live')) return;
      const bi = +b.getAttribute('data-b');
      // ASK FIRST — a stray tap on the picture would otherwise throw the bar away
      Promise.resolve(window.uiConfirm ? window.uiConfirm('Re-roll bar ' + (bi + 1) + '? Its notes are replaced with a new take — ↶ Undo brings them back.') : true)
        .then((ok) => { if (ok && G && layer()) rerollBar(bi); }, () => {});
      return;
    }  }
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
      regrid(n);
    }
  }

  function close(cancel) {
    if (!G) return;
    if (cancel && G.fresh) {
      // ✕ on a layer made a moment ago by ＋ Layer = "never mind": remove it, the same way
      // the card's ✕ Remove layer does (by id — the captured object may be an orphan)
      const E = G.E, id = G.id;
      try { const c2 = E.getCfg(); c2.layers = (c2.layers || []).filter((x) => !(x && x.id === id)); } catch (e) {}
      try { if (E._v2Phase && _ambLiveApplyOK(E)) delete E._v2Phase['v2:' + id]; } catch (e) {}
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
  // ✦ RETIRED (2026-10-01): the card's own Generate button opens this sheet now,
  // so the extra door under the grid is gone; the function stays a no-op.
  function placeDoors() {
    if (true) return;
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
    const sc0 = (opts && opts.scope && Array.isArray(opts.scope.bars) && opts.scope.bars.length) ? { bars: opts.scope.bars.map(String), nm: String(opts.scope.nm || 'This stretch').replace(/^./, (c) => c.toUpperCase()) } : null;
    G = { E, id: L.id, fresh: !!(opts && opts.fresh), scope: sc0, scopeFrom: sc0, snap: JSON.stringify(L), hist: [], styleOpen: !sc0 && !styleOf(L), tab: 'rhythm', sunit: 1, note: '', rollNote: '', flash: -1, root, box: root.querySelector('.g2') };
    root.addEventListener('click', (ev) => { if (ev.target === root) { close(false); return; } onClick(ev); });
    // THE DIAL: drag round it (the angle from its centre is the value). It repaints
    // only itself while you drag and commits once on release — one undo step.
    const dialAt = (ev, svg) => {
      const c = ctlOf(G && G.dial); if (!c) return NaN;
      const r = svg.getBoundingClientRect(), x = ev.clientX - (r.left + r.width * 105 / 210), y = ev.clientY - (r.top + r.height * 100 / 190);
      const deg = clamp(Math.atan2(x, -y) * 180 / Math.PI, -135, 135);
      return clamp(Math.round(c.min + (deg + 135) / 270 * (c.max - c.min)), c.min, c.max);
    };
    let dragSvg = null;
    root.addEventListener('pointerdown', (ev) => {
      const svg = ev.target.closest && ev.target.closest('.g2-dial'); if (!svg || !G) return;
      dragSvg = svg; try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault(); G.dialV = dialAt(ev, svg); svg.innerHTML = dialSVG(ctlOf(G.dial), G.dialV); svg.setAttribute('aria-valuenow', G.dialV);
    });
    root.addEventListener('pointermove', (ev) => {
      if (!dragSvg || !G) return; const v = dialAt(ev, dragSvg); if (!Number.isFinite(v) || v === G.dialV) return;
      G.dialV = v; dragSvg.innerHTML = dialSVG(ctlOf(G.dial), v); dragSvg.setAttribute('aria-valuenow', v);
    });
    const endDrag = () => { if (!dragSvg || !G) return; dragSvg = null; const v = G.dialV; G.dialV = NaN; if (Number.isFinite(v)) commitDial(G.dial, v); };
    root.addEventListener('pointerup', endDrag); root.addEventListener('pointercancel', endDrag);
    root.addEventListener('keydown', (ev) => {
      const svg = ev.target.closest && ev.target.closest('.g2-dial'); if (!svg || !G) return;
      const c = ctlOf(G.dial), L = viewOf(layer()); if (!c || !L) return;
      const d = (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') ? 1 : ((ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') ? -1 : 0);
      if (d) { ev.preventDefault(); commitDial(G.dial, valOf(L, c) + d * dialStep(c)); const s2 = G.box.querySelector('.g2-dial'); if (s2) s2.focus({ preventScroll: true }); }
      if (ev.key === 'Escape') { G.dial = null; paint(); }
    });
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    paint();
    return true;
  };
})();
