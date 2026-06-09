    // ---- Build grid ----

    let cellSounds = [];
    let cellParams = [];

    const DEFAULT_PALETTE = [
      '#e63946', '#f4a261', '#e9c46a', '#2a9d8f',
      '#457b9d', '#9b5de5', '#f15bb5', '#00bbf9',
      '#06d6a0', '#ffbe0b', '#fb5607', '#8338ec',
    ];
    let palette = [...DEFAULT_PALETTE];
    // chipPalette is declared/used below for note-coloured step chips. Start
    // it in sync with the visible grid palette so chips and cells line up
    // on first render. Duotone presets (Piano) swap chipPalette to a
    // separate random palette so chips don't collapse to two colours.
    // (Re-initialised whenever palette is reassigned via load/reset/preset.)

    // Scale catalog — chromatic plus everything Tonal.js ships (~100+ named scales).
    // Each value is an array of semitone offsets [0..11] (the in-scale pitch classes).
    function buildScaleCatalog() {
      const out = { 'chromatic': [0,1,2,3,4,5,6,7,8,9,10,11] };
      if (typeof Tonal !== 'undefined' && Tonal.Scale && Tonal.Interval) {
        Tonal.Scale.names().forEach(name => {
          const intervals = Tonal.Scale.get(name).intervals;
          if (!intervals || intervals.length === 0) return;
          const semis = intervals
            .map(iv => Tonal.Interval.semitones(iv))
            .filter(n => typeof n === 'number' && n >= 0 && n < 12);
          const uniq = [...new Set(semis)].sort((a,b) => a - b);
          if (uniq.length > 0) out[name] = uniq;
        });
      }
      return out;
    }
    const SCALES = buildScaleCatalog();

    // Chord catalog — hand-rolled so extended jazz chords (9 / 11 / 13)
    // carry every voicing tone faithfully. Tonal.Chord.get(quality)
    // without a root prefix returns an empty intervals array for many
    // qualities, so we drive this from a hard-coded table instead.
    // Each entry: { semis: [0,4,7,...], label: 'Major 7' }. Semis can
    // exceed 12 (e.g. dom13's 13th = 21) — _gameRefresh derives its
    // freq directly from baseFreq * 2^(semi/12), so chord notes above
    // the active octave count still show up as polygon sides.
    function buildChordCatalog() {
      const TYPES = [
        ['maj',     'Major',           [0, 4, 7]],
        ['min',     'Minor',           [0, 3, 7]],
        ['dim',     'Diminished',      [0, 3, 6]],
        ['aug',     'Augmented',       [0, 4, 8]],
        ['sus2',    'Sus2',            [0, 2, 7]],
        ['sus4',    'Sus4',            [0, 5, 7]],
        ['maj7',    'Major 7',         [0, 4, 7, 11]],
        ['7',       'Dominant 7',      [0, 4, 7, 10]],
        ['min7',    'Minor 7',         [0, 3, 7, 10]],
        ['dim7',    'Diminished 7',    [0, 3, 6, 9]],
        ['m7b5',    'Half-Diminished 7', [0, 3, 6, 10]],
        ['minMaj7', 'Minor-Major 7',   [0, 3, 7, 11]],
        ['6',       'Major 6',         [0, 4, 7, 9]],
        ['m6',      'Minor 6',         [0, 3, 7, 9]],
        ['6/9',     '6/9',             [0, 4, 7, 9, 14]],
        ['add9',    'Add 9',           [0, 4, 7, 14]],
        ['madd9',   'Minor Add 9',     [0, 3, 7, 14]],
        ['9',       'Dominant 9',      [0, 4, 7, 10, 14]],
        ['maj9',    'Major 9',         [0, 4, 7, 11, 14]],
        ['min9',    'Minor 9',         [0, 3, 7, 10, 14]],
        ['7sus4',   'Dominant 7 Sus4', [0, 5, 7, 10]],
        ['7b9',     'Dominant 7b9',    [0, 4, 7, 10, 13]],
        ['7#9',     'Dominant 7#9',    [0, 4, 7, 10, 15]],
        ['7b5',     'Dominant 7b5',    [0, 4, 6, 10]],
        ['7#11',    'Dominant 7#11',   [0, 4, 7, 10, 14, 18]],
        ['11',      'Dominant 11',     [0, 4, 7, 10, 14, 17]],
        ['min11',   'Minor 11',        [0, 3, 7, 10, 14, 17]],
        ['maj11',   'Major 11',        [0, 4, 7, 11, 14, 17]],
        ['13',      'Dominant 13',     [0, 4, 7, 10, 14, 17, 21]],
        ['maj13',   'Major 13',        [0, 4, 7, 11, 14, 17, 21]],
        ['min13',   'Minor 13',        [0, 3, 7, 10, 14, 17, 21]],
      ];
      const out = {};
      for (const [key, label, semis] of TYPES) out[key] = { semis, label };
      return out;
    }
    const CHORDS = buildChordCatalog();
    let currentChord = ''; // '' = no chord override; fall back to scale
    // Progression-related globals act as the *active mode's view* of the
    // per-mode stash below. _stashCurrentMode saves these back to the
    // outgoing mode on a Grid↔Game flip; _loadModeState pulls the
    // incoming mode's values in. So Chords + Hits are independent per
    // mode while every read site stays using the same variable names.
    let currentProgression = [];
    let _gameProgressionIdx = 0;
    let _gameProgressionHits = 0;
    let _gameUserHitsPerChord = 1;
    const _modeStash = {
      grid: { progression: [], progressionIdx: 0, progressionHits: 0, hitsPerChord: 1 },
      game: { progression: [], progressionIdx: 0, progressionHits: 0, hitsPerChord: 1 },
    };
    function _stashCurrentMode(modeKey) {
      const s = _modeStash[modeKey];
      if (!s) return;
      s.progression = currentProgression.slice();
      s.progressionIdx = _gameProgressionIdx;
      s.progressionHits = _gameProgressionHits;
      s.hitsPerChord = _gameUserHitsPerChord;
    }
    function _loadModeState(modeKey) {
      const s = _modeStash[modeKey];
      if (!s) return;
      currentProgression = s.progression.slice();
      _gameProgressionIdx = s.progressionIdx;
      _gameProgressionHits = s.progressionHits;
      _gameUserHitsPerChord = s.hitsPerChord;
    }
    function _parseProgression(text) {
      if (typeof text !== 'string' || !text.trim()) return [];
      return text.split(/[,\s]+/)
        .map(s => s.trim())
        .filter(s => s && CHORDS && CHORDS[s]);
    }
    // Progression chips may be a bare string (legacy = use grid root) or
    // { rootPC, quality } now that each chord carries its own root.
    function _normalizeChip(chip) {
      if (typeof chip === 'string') {
        return { rootPC: (typeof rootIdx === 'number' ? rootIdx : 0), quality: chip };
      }
      if (chip && typeof chip === 'object' && typeof chip.quality === 'string') {
        const pc = (typeof chip.rootPC === 'number') ? ((chip.rootPC % 12) + 12) % 12 : (typeof rootIdx === 'number' ? rootIdx : 0);
        return { rootPC: pc, quality: chip.quality };
      }
      return null;
    }
    function _activeChordEntry() {
      if (currentProgression.length > 0) {
        const len = currentProgression.length;
        const i = ((_gameProgressionIdx % len) + len) % len;
        return _normalizeChip(currentProgression[i]);
      }
      if (currentChord && CHORDS && CHORDS[currentChord]) {
        return { rootPC: (typeof rootIdx === 'number' ? rootIdx : 0), quality: currentChord };
      }
      return null;
    }
    function _chipLabel(chip) {
      const c = _normalizeChip(chip);
      if (!c) return '';
      const q = (CHORDS && CHORDS[c.quality] && CHORDS[c.quality].label) || c.quality;
      // In Grid mode, the cell press picks the root — chips show just
      // the quality. Game mode renders the chip's own root too.
      if (!gameMode) return q;
      const root = (typeof CHROMATIC !== 'undefined' && CHROMATIC[c.rootPC]) || '';
      return root ? (root + ' ' + q) : q;
    }

    // Old hardcoded names → Tonal canonical names, so saved sequences still load.
    const LEGACY_SCALE_MAP = {
      'Chromatic':      'chromatic',
      'Major':          'major',
      'Minor':          'minor',
      'Harmonic Minor': 'harmonic minor',
      'Pentatonic Maj': 'major pentatonic',
      'Pentatonic Min': 'minor pentatonic',
      'Blues':          'blues',
      'Dorian':         'dorian',
      'Mixolydian':     'mixolydian',
    };
    function normalizeScaleName(name) {
      if (!name) return 'chromatic';
      if (SCALES[name]) return name;
      if (LEGACY_SCALE_MAP[name] && SCALES[LEGACY_SCALE_MAP[name]]) return LEGACY_SCALE_MAP[name];
      return 'chromatic';
    }
    function prettyScaleName(name) {
      return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    let currentScale = 'chromatic';

    function applyScale() {
      const intervals = SCALES[currentScale] || SCALES['chromatic'];
      // Compute the SCALE's absolute pitch-class set (relative to
      // _scaleTonic, not rootIdx). When the grid view is shifted by
      // 1 scale degree, only rootIdx moves — _scaleTonic stays put,
      // so the dim pattern stays anchored on the SAME notes even as
      // the view scrolls through them. Falls back to rootIdx when
      // _scaleTonic is null (default state for chromatic + initial
      // boot), preserving byte-for-byte backward compat.
      const tonic = _effectiveScaleTonic();
      const scalePCs = new Set(
        intervals.map(semi => (((tonic + semi) % 12) + 12) % 12)
      );
      cells.forEach((cell, i) => {
        const cellPC = (((rootIdx + i) % 12) + 12) % 12;
        cell.classList.toggle('out-of-scale', !scalePCs.has(cellPC));
      });
      updateScaleBanner();
      try { if (typeof _gameRefresh === 'function' && _gameInited) _gameRefresh(); } catch (e) {}
    }
    // The "current" tone: every cell's tone if they're all the same,
    // otherwise "Mixed" — happens when the user has hand-tuned individual
    // cells via the Sound Editor or chord per-note panel.
    function cellSoundsAreUniform() {
      if (!Array.isArray(cellSounds) || cellSounds.length === 0) return true;
      const first = cellSounds[0];
      return cellSounds.every(s => s === first);
    }
    function prettyToneValue(value) {
      // Friendly fallback when an option isn't yet in getAllSoundOptions
      // (e.g. the remote piano sampler hasn't been registered yet on
      // first paint). Strips the 'sample:' prefix and capitalizes so
      // the banner shows 'Piano' instead of the raw 'sample:piano'.
      if (typeof value !== 'string') return value;
      if (value.startsWith('sample:')) {
        const id = value.slice(7);
        const inst = REMOTE_INSTRUMENTS.find(i => i.id === id);
        if (inst?.label) return inst.label;
        return id.charAt(0).toUpperCase() + id.slice(1);
      }
      return value.charAt(0).toUpperCase() + value.slice(1);
    }
    function getCurrentToneLabel() {
      if (!Array.isArray(cellSounds) || cellSounds.length === 0) return null;
      // "Custom" — at least one cell's tone differs from the rest. Means
      // the global tone banner doesn't represent the whole grid; the
      // per-cell .cell-tone labels surface what each cell is actually
      // using.
      if (!cellSoundsAreUniform()) return 'Custom';
      const opt = getAllSoundOptions().find(o => o.value === cellSounds[0]);
      return opt?.label || prettyToneValue(cellSounds[0]);
    }
    function shortToneLabelForValue(value) {
      if (!value) return '';
      const opt = getAllSoundOptions().find(o => o.value === value);
      let label = opt?.label || prettyToneValue(value);
      if (label.length > 8) label = label.slice(0, 7) + '…';
      return label;
    }
    function refreshAllCellToneLabels() {
      const custom = !cellSoundsAreUniform();
      cells.forEach((cell, idx) => {
        let tag = cell.querySelector('.cell-tone');
        if (!tag) {
          tag = document.createElement('span');
          tag.className = 'cell-tone';
          cell.appendChild(tag);
        }
        if (custom) {
          tag.textContent = shortToneLabelForValue(cellSounds[idx]);
          tag.classList.add('show');
        } else {
          tag.textContent = '';
          tag.classList.remove('show');
        }
      });
    }
    // For drum-kit cells, surface the drum role (Kick / Snare / Hat / …)
    // in place of the chromatic note name. Pitch class → role mirrors the
    // C2-B2 mapping used by every kit's urls map.
    const DRUM_ROLE_BY_PC = [
      'Kick', 'Rim', 'Snare', 'Clap',
      'Hat',  'Open Hat', 'Low Tom', 'Mid Tom',
      'Cowbell', 'Crash', 'High Tom', 'Perc',
    ];
    function isCellDrumKit(idx) {
      const t = cellSounds[idx];
      if (typeof t !== 'string' || !t.startsWith('sample:')) return false;
      const meta = sampleSamplers.get(t.slice(7));
      return !!(meta && meta.drumKit);
    }
    function pitchClassForCell(idx) {
      // Mirror snapDrumKitFreq / the kit urls map: each cell's pitch class
      // (rooted at C) is what determines which drum it plays.
      const note = notes[idx];
      if (!note) return 0;
      try {
        const midi = Math.round(Tone.Frequency(note.freq).toMidi());
        return ((midi % 12) + 12) % 12;
      } catch (e) {
        return 0;
      }
    }
    function refreshAllCellNameLabels() {
      cells.forEach((cell, idx) => {
        const span = cell.querySelector('span');
        if (!span) return;
        if (isCellDrumKit(idx)) {
          const pc = pitchClassForCell(idx);
          span.textContent = DRUM_ROLE_BY_PC[pc] || (notes[idx] && notes[idx].label) || '';
          span.classList.add('cell-name-drum');
        } else {
          span.textContent = (notes[idx] && notes[idx].label) || '';
          span.classList.remove('cell-name-drum');
        }
      });
    }
    function updateScaleBanner() {
      const scaleHalf = document.getElementById('scale-banner-half');
      const root = (typeof CHROMATIC !== 'undefined' && CHROMATIC[rootIdx]) || 'C';
      const tone = getCurrentToneLabel();
      // The Sounds banner replaces the old Scale + Tone pair. Show a
      // compact readout: scale info, then the current tone in parens.
      // Tone-banner-half/fx-banner are kept in DOM as hidden anchors for
      // initToneMenu / initFxMenu — no longer user-visible.
      if (scaleHalf) {
        // Static label — root / scale / tone live inside the Sounds
        // dropdown itself, so the banner button just shows "Sounds".
        // The chevron is rendered by .banner-half::after, which flips
        // direction automatically via the .open class toggled by
        // initSoundsMenu. Hover title preserves the previous detail
        // readout for discoverability without burning row width.
        scaleHalf.textContent = 'Sounds';
        const tonePart = tone ? ` · ${tone}` : '';
        scaleHalf.title = `Sounds — ${root} ${prettyScaleName(currentScale)}${tonePart}`;
      }
      refreshAllCellToneLabels();
      refreshAllCellNameLabels();
      if (typeof refreshRadialToneAvailability === 'function') refreshRadialToneAvailability();
    }

    function applyPalette() {
      cells.forEach((cell, i) => {
        const pitchClass = (rootIdx + i) % 12;
        cell.style.background = palette[pitchClass];
      });
      try { if (typeof _gameRefresh === 'function' && _gameInited) _gameRefresh(); } catch (e) {}
    }

    // Chip-side palette — one colour per pitch class. Stays in sync with the
    // grid palette during a normal Color shuffle, but during Piano (which is
    // intentionally duotone) we keep the chips colourful by giving them
    // their own freshly-shuffled palette.
    let chipPalette = [...palette];

    const PITCH_CLASS_MAP = {
      'C': 0, 'B#': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3,
      'E': 4, 'Fb': 4, 'F': 5, 'E#': 5, 'F#': 6, 'Gb': 6, 'G': 7,
      'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11, 'Cb': 11,
    };
    function labelToPitchClass(label) {
      if (typeof label !== 'string') return null;
      const m = label.match(/^([A-G][#b]?)/);
      if (!m) return null;
      const pc = PITCH_CLASS_MAP[m[1]];
      return (typeof pc === 'number') ? pc : null;
    }
    // Pick the pitch class to colour a chip by — single-note steps use
    // their own pitch, chords colour by the first note, subsequences
    // colour by their first playable child (skipping rests). Returns
    // null for empty / pure-rest steps.
    function stepColorPitchClass(step) {
      if (!step) return null;
      if (step.isSub && Array.isArray(step.subSteps)) {
        for (const s of step.subSteps) {
          const pc = stepColorPitchClass(s);
          if (pc != null) return pc;
        }
        return null;
      }
      if (step.chord && step.chord[0]) return labelToPitchClass(step.chord[0].label);
      if (step.freq != null) return labelToPitchClass(step.label);
      return null;
    }
    // Map a step-div size (1/32 … 4/1) to a hue so the step-div
    // modal buttons and rest chips read at a glance which length
    // each slot is. Sorted shortest → longest across the rainbow.
    const _STEP_DIV_HUE_TABLE = {
      0.08333333333333333: 15,   // 1/32t — deep red-orange
      0.125:               0,    // 1/32  — red
      0.16666666666666666: 25,   // 1/16t — orange-red
      0.25:                35,   // 1/16  — orange
      0.3333333333333333:  50,   // 1/8t  — yellow-orange
      0.5:                 60,   // 1/8   — yellow
      1:                   110,  // 1/4   — green
      2:                   170,  // 1/2   — teal
      4:                   210,  // 1/1   — blue
      8:                   260,  // 2/1   — indigo
      12:                  300,  // 3/1   — purple
      16:                  330,  // 4/1   — magenta
    };
    function _stepDivHue(sub) {
      const v = Number(sub);
      if (!Number.isFinite(v) || v <= 0) return null;
      // Snap to the nearest known entry — accommodates floats from
      // saved snapshots that aren't byte-exact (e.g. 0.50000001).
      let best = null, bestDelta = Infinity;
      for (const k of Object.keys(_STEP_DIV_HUE_TABLE)) {
        const d = Math.abs(parseFloat(k) - v);
        if (d < bestDelta) { bestDelta = d; best = k; }
      }
      return best != null ? _STEP_DIV_HUE_TABLE[best] : null;
    }
    function _stepDivColor(sub, sat = 70, light = 60) {
      const h = _stepDivHue(sub);
      return (h == null) ? null : `hsl(${h}, ${sat}%, ${light}%)`;
    }
    function tintHsl(color, alpha) {
      // Accept either "hsl(h, s%, l%)" or "#rgb"/"#rrggbb" and return a
      // low-opacity variant so chips can wash a tinted background.
      if (typeof color !== 'string') return color;
      if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
      if (color.startsWith('#')) {
        let hex = color.slice(1);
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (hex.length !== 6) return color;
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if ([r, g, b].some(Number.isNaN)) return color;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
      return color;
    }

    function generateRandomPalette(offset) {
      offset = (offset == null) ? Math.random() * 360 : offset;
      const out = Array.from({ length: 12 }, (_, i) => {
        const h = (offset + i * 30) % 360;
        const s = 55 + Math.floor(Math.random() * 25);
        const l = 50 + Math.floor(Math.random() * 15);
        return `hsl(${h.toFixed(0)}, ${s}%, ${l}%)`;
      });
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }

    function shuffleColors() {
      const offset = Math.random() * 360;
      palette = generateRandomPalette(offset);
      chipPalette = [...palette]; // chips share the grid colours during a normal shuffle
      // Pick a rest color that's distinct from the palette: put its hue in the
      // middle of the gap between two adjacent palette hues (each gap is 15°
      // wide with 12 hues equally spaced around the wheel), and use a pastel
      // saturation/lightness so it doesn't blend in even if hues happen close.
      const restHue = (offset + 15) % 360;
      const restSat = 50 + Math.floor(Math.random() * 20);
      const restLight = 72 + Math.floor(Math.random() * 13);
      restColor = `hsl(${restHue.toFixed(0)}, ${restSat}%, ${restLight}%)`;
      applyRestColor();
      applyPalette();
      if (typeof renderSequence === 'function') renderSequence();
    }

    const DEFAULT_REST_COLOR = 'hsl(280, 55%, 78%)';
    let restColor = DEFAULT_REST_COLOR;

    function applyRestColor() {
      document.documentElement.style.setProperty('--rest-color', restColor);
    }

    // Effective frequency for a cell after applying its detune (cents).
    // Used by the cell-freq label so users see what they'll actually hear,
    // not the untuned base frequency.
    function tunedCellFreq(idx) {
      const base = notes[idx]?.freq;
      if (base == null) return null;
      const cents = cellParams[idx]?.detune || 0;
      return base * Math.pow(2, cents / 1200);
    }
    function updateCellFreqLabel(idx) {
      const cell = cells[idx];
      if (!cell) return;
      const freq = tunedCellFreq(idx);
      if (freq == null) return;
      const label = cell.querySelector('.cell-freq');
      if (label) label.textContent = `${Math.round(freq)} Hz`;
    }
    function refreshAllCellFreqLabels() {
      cells.forEach((_, idx) => updateCellFreqLabel(idx));
    }

    function _defaultCellParams() {
      return { type: 'sawtooth', attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0, reverb: 0, reverbSize: 70, reverbTone: 50, delay: 0, delayTime: 250, delayFeedback: 40, delaySync: null, distortion: 0, chorus: 0, chorusFreq: 4, chorusDepth: 70, vibrato: 0, vibratoFreq: 5, vibratoDepth: 30, tremolo: 0, tremoloFreq: 5, tremoloDepth: 70, phaser: 0, phaserFreq: 0.5, phaserOctaves: 3, autoFilter: 0, autoFilterFreq: 1, autoFilterDepth: 100, autoFilterBaseFreq: 200, pingPong: 0, pingPongTime: 250, pingPongFeedback: 30, pingPongSync: null, autoPan: 0, autoPanFreq: 1, autoPanDepth: 100 };
    }

    function rebuildGrid(opts) {
      // Snapshot pre-rebuild tones so they survive root/octave/scale/A4
      // changes — without this every grid setting tweak resets every
      // cell back to piano. resetTones=true skips preservation for the
      // explicit-reset paths (Reset button / New project).
      const resetTones = !!(opts && opts.resetTones);
      const prevSounds = resetTones ? [] : cellSounds.slice();
      const prevParams = resetTones ? [] : cellParams.map(p => ({ ...p }));
      // For new cells beyond the previous grid size (octave count grew),
      // fall back to the last existing cell's tone so the user's pick
      // extends across the new range instead of injecting piano cells
      // mid-grid.
      const fallbackParams = (!resetTones && prevParams.length > 0)
        ? prevParams[prevParams.length - 1]
        : null;

      notes = computeNotes();
      const grid = document.getElementById('grid');
      grid.innerHTML = '';
      cells.length = 0;
      cellParams = notes.map((_, i) => {
        if (prevParams[i]) return { ...prevParams[i] };
        if (fallbackParams) return { ...fallbackParams };
        return _defaultCellParams();
      });
      cellSounds = cellParams.map(p => p.type || 'sawtooth');

      notes.forEach((note, i) => {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.innerHTML = `<button type="button" class="cell-edit-carrot" title="Open sound editor for ${note.label}" aria-label="Open sound editor">▾</button><span>${note.label}</span><span class="cell-freq">${Math.round(note.freq)} Hz</span><span class="cell-tone"></span>`;
        const editBtn = cell.querySelector('.cell-edit-carrot');
        if (editBtn) {
          // Prevent the carrot from triggering the cell's sustain / wrap /
          // run-mode pointerdown logic. stopPropagation on pointerdown +
          // click covers both the sustain bookkeeping and the synthetic
          // click that follows touch.
          editBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showSoundEditor(i);
          });
        }

        // Sustain + polyphony + drag-to-play — every press routes through
        // the shared poly session below. Pointers can drag across cells
        // (each crossed cell starts its own sustain) and multi-touch
        // presses build a chord step at the end of the press session.
        cell.addEventListener('pointerdown', (e) => {
          if (e.target.closest('.cell-sound-select, .cell-edit-carrot')) return;
          // Fluid pitch mode owns the gesture — the grid-level pointer
          // handler at bindFluidGridHandlers handles press / move /
          // release as a continuous bend.
          if (fluidGridMode) return;
          // Chord-progression (Grid mode) — when one or more chords are
          // queued in Chords, each cell press plays the current chord
          // rooted on the pressed note and advances the progression
          // (cycling with the Hits count). Takes precedence over jump /
          // wrap / fixed-seq paths; clearing the chord list restores
          // normal single-note behavior.
          if (currentProgression.length > 0) {
            if (_gridChordPlayAt(i)) return;
          }
          // Jump mode — takes precedence over every other press behavior.
          // The handler fires audio for the pressed note and then shifts
          // the grid so that note becomes the lowest (or, on a repeat
          // press, the highest) cell. Wrap, Keep, Fixed, etc. all yield.
          if (jumpMode && notes[i]) {
            if (handleJumpModePress(i)) return;
          }
          // Fixed-mode sequential write — when Fixed + Keep is on, a
          // cell press writes the pressed note into the currently
          // selected slot and advances. Fires audio first so the
          // press still sounds while the lane writes, then bails out
          // of the regular wrap / poly handlers below.
          if (_fixedSeqActive && stepMode && keepMode && notes[i]) {
            try {
              const params = { ...cellParams[i] };
              const prev = _suppressCellFlash;
              _suppressCellFlash = true;
              try { playNote(notes[i].freq, params); }
              finally { _suppressCellFlash = prev; }
            } catch (err) {}
            const step = {
              freq: notes[i].freq,
              label: notes[i].label,
              cellIndex: i,
              sound: cellParams[i].type,
              params: { ...cellParams[i] },
            };
            _fixedSeqWrite(step);
            return;
          }
          // Wrap (chordMode) takes precedence over the note-mode click
          // routing so accumulating notes works the same way regardless
          // of whether the user is in Spell, Run, or Stack. Toggling
          // Wrap off commits the accumulated notes per gridMode (sub
          // for Run, chord otherwise) — see chord-btn click handler.
          if (chordMode) {
            // Tapping an already-pending cell removes it from the wrap
            // (notes shift left because pendingChord is just an array).
            const existing = pendingChord.findIndex(n => n.cellIndex === i);
            if (existing !== -1) {
              pendingChord.splice(existing, 1);
              cell.classList.remove('wrap-pending');
              renderSequence();
              updateChordDisplay();
              return;
            }
            // Smart wrap: on the FIRST press of a fresh stack-shaped
            // wrap with key mode active and a 7-note scale, auto-build
            // the diatonic triad rooted on the pressed pitch's scale
            // degree. Subsequent presses fall through to the standard
            // single-note add — they're already in-key (out-of-key
            // cells are non-interactive via .out-of-scale CSS) and
            // extend whatever chord type they form (Dm → Dm7 → Dm9
            // etc. via the existing Tonal chord detection in
            // updateKeepLabel). Run wraps skip the auto-triad since
            // they're sequences, not chords.
            const _isRunWrap = (_wrapShape === 'run')
              || (_wrapShape == null && gridMode === 'arpeggio');
            const _keyOn = currentScale && currentScale !== 'chromatic';
            // Smart-triad is opt-in via the △ Triad pill in the Sounds
            // sub-row. Default OFF so the first wrap press is a single
            // note (matches a MIDI keyboard's "one key = one note"
            // expectation); turning it ON brings back the auto-triad
            // behavior for users who liked it.
            const _smartTriadOn = (typeof wrapSmartTriad !== 'undefined') && !!wrapSmartTriad;
            let _smartCells = null;
            if (_smartTriadOn && pendingChord.length === 0 && !_isRunWrap && _keyOn) {
              try { _smartCells = _diatonicTriadCellIndices(i); }
              catch (e) { _smartCells = null; }
            }
            if (_smartCells && _smartCells.length > 0) {
              for (let _t = 0; _t < _smartCells.length; _t++) {
                const _sci = _smartCells[_t];
                const _n = notes[_sci];
                if (!_n) continue;
                const _p = { ...cellParams[_sci] };
                pendingChord.push({
                  freq: _n.freq, label: _n.label, cellIndex: _sci,
                  sound: _p.type, params: _p,
                });
                if (cells[_sci]) cells[_sci].classList.add('wrap-pending');
              }
              // Fire every triad voice with a single suppressed-flash
              // block so the chord sounds simultaneous (not arpeggiated).
              const _prevSuppress = _suppressCellFlash;
              _suppressCellFlash = true;
              try {
                for (let _t = 0; _t < _smartCells.length; _t++) {
                  const _sci = _smartCells[_t];
                  const _n = notes[_sci];
                  if (_n) playNote(_n.freq, { ...cellParams[_sci] });
                }
              } finally { _suppressCellFlash = _prevSuppress; }
              renderSequence();
              updateChordDisplay();
              return;
            }
            const params = { ...cellParams[i] };
            // Wrap accumulation always builds the pending form (the
            // committed step becomes wrapTemplate regardless of Keep).
            // Keep only gates the sequence-append at commit time.
            pendingChord.push({
              freq: notes[i].freq,
              label: notes[i].label,
              cellIndex: i,
              sound: params.type,
              params,
            });
            // Fire audio first — DOM work (renderSequence,
            // updateChordDisplay) on a sequence that's getting long can
            // push the audio call past 10–20 ms after the press, which
            // adds up with Tone's lookAhead. wrap-pending goes on
            // immediately so the cell colour-changes alongside the sound.
            // Suppress the per-note active-loop flash so its white outline
            // doesn't fight the wrap-pending purple outline; wrap-pending
            // is the dominant visual cue for "this note is in the wrap."
            cell.classList.add('wrap-pending');
            const _prevSuppress = _suppressCellFlash;
            _suppressCellFlash = true;
            try { playNote(notes[i].freq, params); }
            finally { _suppressCellFlash = _prevSuppress; }
            renderSequence();
            updateChordDisplay();
            return;
          }
          // Wrap template — once Wrap has been used to build a chord
          // or sub, cell clicks audition that form transposed so the
          // pressed note becomes its first note. Overrides whichever
          // note mode is active. With Keep on, the transposed copy is
          // also appended to the sequence; with Keep off, audition only.
          if (wrapTemplate) {
            cell.classList.add('flash');
            setTimeout(() => cell.classList.remove('flash'), 80);
            // Engage the poly session so chord-shaped wraps sustain for
            // the duration of the press and release on pointerup. Sub
            // wraps fall through inside polyStartWrapCell to a one-shot.
            _polySession.pointerStartedOnCell.set(e.pointerId, true);
            // Radial Tone applies to wrap auditions too — sample the
            // press position and seed all chord voices with the same
            // detune offset; pointermove keeps it updated.
            let _wrapOpts = {};
            if (radialTone) {
              const rect = cell.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                const xFrac = (e.clientX - rect.left) / rect.width;
                const yFrac = (e.clientY - rect.top)  / rect.height;
                const cents = radialBendCents(xFrac, yFrac);
                _radialBendInit(i, cents);
                _wrapOpts.detune = cents;
                setCellFreqDisplayCents(i, cents);
              }
            } else {
              _radialBend.delete(i);
            }
            polyStartWrapCell(i, e.pointerId, _wrapOpts);
            // Cycling: this press used the armed wrap. Flag it so the
            // matching pointerup advances to the next wrap once this
            // sound event is over.
            if (wrapCycleMode) _wrapCyclePendingAdvance = true;
            return;
          }
          // Arpeggio / Chord modes don't sustain — they fire a one-shot
          // transposed playback of the saved sequence and bail.
          if (gridMode === 'arpeggio') {
            cell.classList.add('flash');
            setTimeout(() => cell.classList.remove('flash'), 80);
            runModeOnCell(i);
            return;
          }
          if (gridMode === 'chord') {
            cell.classList.add('flash');
            setTimeout(() => cell.classList.remove('flash'), 80);
            chordModeOnCell(i);
            return;
          }
          // Default Sequencer mode — track origin for drag-to-play, start
          // sustain.
          _polySession.pointerStartedOnCell.set(e.pointerId, true);
          // Radial Tone: sample the press position and seed the sustain
          // with a position-derived detune. The pointermove handler keeps
          // this updated as the user slides; the click handler applies
          // the final value to the saved step (when Keep is on).
          let _initOpts = {};
          if (radialTone) {
            const rect = cell.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const xFrac = (e.clientX - rect.left) / rect.width;
              const yFrac = (e.clientY - rect.top)  / rect.height;
              const cents = radialBendCents(xFrac, yFrac);
              _radialBendInit(i, cents);
              _initOpts.detune = cents;
              setCellFreqDisplayCents(i, cents);
            }
          } else {
            _radialBend.delete(i);
          }
          polyStartCell(i, e.pointerId, _initOpts);
        });
        // Suppress right-click / iOS long-press native context menu so the
        // press-and-hold radial bend gesture isn't interrupted by the
        // browser's "Copy / Look Up / Share" callout.
        cell.addEventListener('contextmenu', (e) => e.preventDefault());
        // Drag-to-play, drag-handoff, and live Radial Tone bend are all
        // handled by the document-level pointermove handler — touch
        // implicit pointer capture would otherwise silently drop those
        // events on the original cell only. See the listener installed
        // alongside document.pointerup above.
        cell.addEventListener('click', () => {
          // Variance edit: cell presses go into the active step's
          // variance pool instead of becoming new steps. Captured here
          // BEFORE any of the other gates so it works regardless of
          // Keep / wrap / Spell mode (the user is editing one step's
          // alternates, not appending to the sequence).
          if (_captureVarianceNote(i)) {
            _cellTapAdded = true;
            return;
          }
          // Clicks that ride a multi-press session get folded into a
          // chord at session-end — skip the per-cell single-note path
          // here so we don't double-add. Single presses fall through
          // normally.
          if (polyShouldSuppressClick()) return;
          // Active multi-press detect: clicks from a chord press fire
          // before polyFinalizeSession runs (and before
          // suppressClickUntil is set), so polyShouldSuppressClick
          // above doesn't catch them. _polySession.pressed still
          // carries every cell in the gesture until the 60 ms
          // finalize-timer fires, so a size >= 2 here means this
          // click is one of N from a chord press — bail and let
          // polyFinalizeSession emit a single chord step (plus its
          // step-div modal) instead of each cell stamping its own
          // single-note step and dragging the modal along with it.
          if (_polySession.pressed.size >= 2) {
            _cellTapAdded = true;
            return;
          }
          // Arpeggio / Chord modes already played their audio on
          // pointerdown — don't append to the workspace sequence.
          if (gridMode !== 'sequencer') return;
          // Keep off: Spell-mode click event also bails out here. The
          // sustained-tap audio from pointerdown still played; this
          // gate just prevents the workspace mutation.
          if (!keepMode) return;
          // Wrap template — pointerdown already auditioned the form
          // and (with Keep on) appended a transposed copy. Bail so
          // we don't also tack on a single-note step here.
          if (wrapTemplate) return;
          const params = { ...cellParams[i] };
          // Audio already played via pointerdown/pointerup sustain. The
          // click handler only runs the workspace-mutation work.
          cell.classList.add('flash');
          setTimeout(() => cell.classList.remove('flash'), 80);
          if (stepMode) {
            // In step-sequencer mode the grid arms the current note instead
            // of appending. Empty/filled chip clicks then toggle this note.
            armStepModeNote({
              freq: notes[i].freq,
              label: notes[i].label,
              cellIndex: i,
              sound: params.type,
              params,
              duration: noteLength,
              subdivision: stepSubdivision,
            });
          } else if (chordMode) {
            // No-op here — Wrap (chordMode) is handled in the cell's
            // pointerdown so it fires consistently across note modes
            // and doesn't get a double-push from the click event.
          } else if (selectedStepRefs.length > 0) {
            // Retune the selected step(s) in place — preserves duration,
            // subdivision, and bend so the click is just a re-pitch. Skips
            // sub-wrappers and chord steps (those have their own editors).
            const targets = (multiSelectMode ? selectedStepRefs : [lastSelectedStep()]).filter(Boolean);
            // Rests are editable too — clicking a cell turns a selected rest
            // into that note. Sub-wrappers and chord steps are skipped since
            // they have dedicated editors.
            const editable = targets.filter(s => s && !s.isSub && !s.chord);
            if (editable.length > 0) {
              snapshotForUndo('Re-pitch');
              editable.forEach(s => {
                s.freq      = notes[i].freq;
                s.label     = notes[i].label;
                s.cellIndex = i;
                s.sound     = params.type;
                s.params    = { ...params };
              });
              renderSequence();
              _cellTapAdded = true; // covered — keep polyFinalizeSession out
            } else {
              // Nothing editable in the selection (e.g. only sub/chord steps);
              // fall back to the normal append behavior so the click does
              // something useful instead of silently no-opping.
              const _holdMs = _holdMsForCell(i);
              const _heldParams = _holdAdjustedParams(params, _holdMs);
              addToSequence(_radialBendApplyToStep(i, { freq: notes[i].freq, label: notes[i].label, cellIndex: i, sound: _heldParams.type, params: _heldParams, duration: _holdStepDurationForCell(i), subdivision: stepSubdivision }));
              _cellTapAdded = true;
            }
          } else {
            const _holdMs = _holdMsForCell(i);
            const _heldParams = _holdAdjustedParams(params, _holdMs);
            const _newStep = _radialBendApplyToStep(i, { freq: notes[i].freq, label: notes[i].label, cellIndex: i, sound: _heldParams.type, params: _heldParams, duration: _holdStepDurationForCell(i), subdivision: stepSubdivision });
            addToSequence(_newStep);
            _cellTapAdded = true;
            maybePromptStepDiv(_newStep, { heldMs: _holdMs });
          }
        });
        // Editor opens via the .cell-edit-carrot button installed above —
        // double-tap edit gesture removed (replaced by the carrot for a
        // visible affordance and to free the double-tap from the sustain
        // gesture).
        grid.appendChild(cell);
        cells.push(cell);
      });
      applyPalette();
      applyScale();
      // Publish the grid's natural rendered height as a CSS variable
      // so the XY pad (#xy-pad / .xy-surface) can size to the same
      // pixel footprint when Graph mode is active — no visible
      // resize on Grid ↔ Graph toggle. Grid uses 4 columns with
      // grid-auto-rows: minmax(70px, 1fr), so rows = ceil(cells / 4)
      // and each row is at least 70 px tall.
      try {
        const expander = document.getElementById('lane-expander');
        if (expander) {
          const rows = Math.max(1, Math.ceil(cells.length / 4));
          expander.style.setProperty('--grid-natural-h', (rows * 70) + 'px');
        }
      } catch (e) {}
      if (typeof persistWorkspace === 'function') persistWorkspace();
      try { if (typeof _gameRefresh === 'function' && _gameInited) _gameRefresh(); } catch (e) {}
    }

    rebuildGrid();
    refreshHoldEnabled();
    // Render any persisted Wrap-bank entries from a previous session.
    try { renderWrapBank(); } catch (e) { console.warn('renderWrapBank failed:', e); }
    // Always-poly invariant: ensure lanes[] has at least one lane on
    // boot so the very first render / playback path doesn't hit empty
    // lane state. applyProjectSnapshot may overwrite this with a
    // restored snapshot moments later — that's fine, the snapshot
    // path also calls into the same invariant.
    ensureLanesInitialized();
    loadSampleManifest();
    loadImportedSamples();
    loadRemoteInstruments();

    // Hold the loading gate up until the default Piano sampler (used by
    // every cell out of the box) has finished its network fetch — so the
    // first tap actually produces sound rather than silently dropping
    // into the unloaded-sampler fallback. 8s safety timeout in case
    // Tone.loaded() never resolves (offline mode, asset 404, etc.).
    const _bloopsRevealTimer = setTimeout(() => {
      document.body.classList.remove('bloops-loading');
    }, 8000);
    Tone.loaded().then(() => {
      clearTimeout(_bloopsRevealTimer);
      document.body.classList.remove('bloops-loading');
      // Run a safeguard tick the moment the gate lifts — on mobile the
      // initial rebuildGrid + asset-restore race had ~1.5 s to play out
      // before the original safeguard window expired; on a slow network
      // Tone.loaded() can resolve later than that and find the grid
      // still empty.
      _safeguardGridRebuild();
    }, () => {
      clearTimeout(_bloopsRevealTimer);
      document.body.classList.remove('bloops-loading');
      _safeguardGridRebuild();
    });

    // Mobile-Safari fallback: a few iOS reloads land with the page laid
    // out but the grid empty — usually because a transient parse / Tone
    // hiccup, an async applyProjectSnapshot whose await window outlives
    // the safeguard window, or a corrupt octaveCount in a restored
    // workspace produced zero cells. Re-check on a generous schedule
    // (RAF + every 500 ms for the first 10 s) and rebuild if cells are
    // missing. Cheap when the grid is already populated (length check
    // + return). If rebuildGrid still produces zero cells, fall back to
    // a known-good default (octaveCount=1, rootIdx=0, baseOctave=4) so
    // the user isn't stuck staring at an empty surface.
    function _safeguardGridRebuild() {
      try {
        const g = document.getElementById('grid');
        if (!g) return;
        if (g.children.length > 0 && cells.length > 0) return;
        rebuildGrid();
        // Rebuild attempted but still empty — corrupt state somewhere
        // upstream (saved workspace with octaveCount=0, mid-snapshot
        // race, etc.). Force defaults and retry once.
        if (g.children.length === 0 || cells.length === 0) {
          octaveCount = 1;
          if (!Number.isFinite(rootIdx))    rootIdx    = 0;
          if (!Number.isFinite(baseOctave)) baseOctave = 4;
          if (!Number.isFinite(masterFreqA) || masterFreqA <= 0) masterFreqA = 440;
          rebuildGrid();
        }
      } catch (e) {
        console.warn('Safeguard rebuildGrid failed:', e);
      }
    }
    requestAnimationFrame(_safeguardGridRebuild);
    // Roll a tighter polling cadence over the first 10 s so a slow
    // applyProjectSnapshot (Drive asset fetches on a flaky connection
    // can push the restore well past the prior 1500 ms cutoff) still
    // gets caught.
    [250, 750, 1500, 2500, 4000, 6000, 8000, 10000].forEach(ms => {
      setTimeout(_safeguardGridRebuild, ms);
    });

    // ---- Top-right Tone dropdown: applies a tone to every grid cell ----
    function applyToneToAllCells(type) {
      // Cell sounds/params live outside the undo stack (matching Sound
      // Editor → Apply), so don't snapshot — it would push an entry that
      // can't actually roll the change back.
      cellParams.forEach((p, idx) => {
        p.type = type;
        cellSounds[idx] = type;
      });
      // Also retune every step that's already in the workspace so picking
      // a tone changes both what new clicks will produce AND the existing
      // sequence — including chord voices and any nested subsequences.
      // Rests have no audio, so skip them.
      const retuneStep = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) {
          s.subSteps.forEach(retuneStep);
          return;
        }
        if (s.chord) {
          s.chord.forEach(n => {
            n.sound = type;
            if (n.params) n.params.type = type;
            else n.params = { type };
          });
          return;
        }
        if (s.freq == null) return; // rest
        s.sound = type;
        if (s.params) s.params.type = type;
        else s.params = { type };
      };
      sequence.forEach(retuneStep);
      // Tone changes are scoped to the active lane only — each lane
      // owns its own voice (cellSounds / cellParams) on lane.voice,
      // so picking a new tone on lane A must not silently retune
      // lane B's steps. The previous behavior fanned out across every
      // lane regardless of voice ownership.
      pendingChord.forEach(n => {
        n.sound = type;
        if (n.params) n.params.type = type;
        else n.params = { type };
      });
      // Wrap template — the saved transposable form an Unwrap-able wrap
      // auditions on cell taps. Without this, picking a new tone from
      // the menu would change every other voice but leave the active
      // wrap auditioning the old tone.
      if (wrapTemplate) retuneStep(wrapTemplate);
      renderSequence();
      updateScaleBanner();
      // Persist so the tone selection survives any later workspace
      // restore — without this, an Unwrap or any path that reloads
      // workspace state would revert every cell back to piano.
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // ---- Tone families -- two-level menu (top: family list, drilldown:
    // family's tones). Keeps the panel short and lets us add more
    // instruments without scrolling forever.
    const TONE_FAMILY_ORDER = ['synths', 'keys', 'mallets', 'strings', 'winds', 'leads', 'drums', 'imports', 'samples', 'other'];
    const TONE_FAMILY_LABELS = {
      synths:  'Synths',
      keys:    'Keys',
      mallets: 'Mallets',
      strings: 'Strings',
      winds:   'Winds',
      leads:   'Leads & Pads',
      drums:   'Drums',
      imports: 'Imports',
      samples: 'Samples',
      other:   'Other',
    };
    const _SYNTH_KEYS = new Set(['sine', 'square', 'triangle', 'sawtooth', 'pulse', 'fat', 'wavetable', 'fm', 'am', 'mono', 'duo', 'bass', 'pad', 'xylo']);
    const _SAMPLE_KEYS_IDS    = new Set([
      // Originals
      'piano', 'organ', 'rhodes', 'epiano2', 'harpsichord', 'clavinet',
      // GM batch — pianos
      'pianobr', 'pianoeg', 'honkytonk',
      // GM batch — organs / accordions / harmonica
      'organdrawbar', 'organperc', 'organrock', 'organchurch', 'organreed',
      'accordion', 'harmonica', 'tangoaccord',
    ]);
    const _SAMPLE_MALLETS_IDS = new Set([
      'celesta', 'vibraphone', 'marimba',
      // GM batch — pitched percussion / mallets
      'glockenspiel', 'musicbox', 'xylophone', 'tubularbells', 'dulcimer',
      'steeldrums', 'kalimba', 'timpani',
      'tinklebell', 'agogo', 'woodblock', 'taikodrum', 'melodictom',
      'synthdrum', 'revcymbal',
    ]);
    const _SAMPLE_STRINGS_IDS = new Set([
      'guitar', 'violin', 'cello', 'eguitar',
      // GM batch — guitars
      'guitnylon', 'guitsteel', 'guitjazz', 'guitclean', 'guitmute',
      'guitod', 'guitdist', 'guitharm',
      // GM batch — basses
      'bassacoustic', 'bassefinger', 'bassepick', 'bassfret',
      'bassslap1', 'bassslap2', 'basssynth1', 'basssynth2',
      // GM batch — orchestral strings
      'viola', 'contrabass', 'tremolostr', 'pizzstr', 'harp',
      'strens1', 'strens2', 'synstr1', 'synstr2',
    ]);
    const _SAMPLE_WINDS_IDS = new Set([
      'flute',
      // GM batch — saxes
      'saxsop', 'saxalto', 'saxtenor', 'saxbari',
      // GM batch — other reeds
      'oboe', 'enghorn', 'bassoon', 'clarinet',
      // GM batch — pipes
      'piccolo', 'recorder', 'panflute', 'blownbottle',
      'shakuhachi', 'whistle', 'ocarina',
      // GM batch — brass
      'trumpet', 'trombone', 'tuba', 'trumpetmute', 'frenchhorn',
      'brasssec', 'brasssyn1', 'brasssyn2',
    ]);
    const _SAMPLE_LEADS_IDS   = new Set([
      'leadsquare', 'padpoly',
      // GM batch — additional leads
      'leadsaw', 'leadcal', 'leadchiff', 'leadchar',
      'leadvoice', 'leadfifths', 'leadbass',
      // GM batch — additional pads
      'padnew', 'padwarm', 'padchoir', 'padbowed',
      'padmetal', 'padhalo', 'padsweep',
    ]);
    const _SAMPLE_DRUM_IDS    = new Set(['tr808', 'drumtraks', 'drumkit', 'dr55']);
    function toneFamilyFor(value) {
      if (typeof value !== 'string') return 'other';
      if (value.startsWith('sample:')) {
        const id = value.slice(7);
        if (_SAMPLE_KEYS_IDS.has(id))    return 'keys';
        if (_SAMPLE_MALLETS_IDS.has(id)) return 'mallets';
        if (_SAMPLE_STRINGS_IDS.has(id)) return 'strings';
        if (_SAMPLE_WINDS_IDS.has(id))   return 'winds';
        if (_SAMPLE_LEADS_IDS.has(id))   return 'leads';
        if (_SAMPLE_DRUM_IDS.has(id))    return 'drums';
        if (id.startsWith('imported-'))  return 'imports';
        // Everything else (FX, ethnic, voice, orchestra hit, sound
        // effects) falls into the generic Samples bucket — keeps the
        // family-grouped menu readable instead of inventing a
        // sub-family for every long-tail GM voice.
        return 'samples';
      }
      if (_SYNTH_KEYS.has(value)) return 'synths';
      if (value === 'kick' || value === 'metal') return 'drums';
      if (value === 'pluck' || value === 'bell') return 'strings';
      return 'other';
    }
    // Top-level bucket: 'synths' (oscillator-based, no sample buffer)
    // or 'samples' (sample-buffer based, played via Tone.Sampler /
    // GrainPlayer). The string 'sample:' prefix is the discriminator.
    const _toneTopBucketFor = (value) =>
      (typeof value === 'string' && value.startsWith('sample:')) ? 'samples' : 'synths';
    let _toneMenuView = 'top'; // 'top' | 'synths' | 'samples'
    function populateTonePanel() {
      const panel = document.getElementById('tone-panel');
      if (!panel) return;
      panel.innerHTML = '';
      // Sculpt — opens the full sound editor (envelope / level / effects) in
      // apply-to-all mode so the chosen tone can be shaped grid-wide.
      const sculpt = document.createElement('button');
      sculpt.type = 'button';
      sculpt.className = 'tone-sculpt-btn';
      sculpt.id = 'tone-sculpt-btn';
      sculpt.textContent = '⚙ Sculpt sound…';
      panel.appendChild(sculpt);
      // Surface the current "Custom" state as a non-clickable marker at the
      // top of the panel, mirroring the Tone banner label. Picking any of
      // the regular options below applies that tone to every cell, which
      // exits the custom state.
      if (!cellSoundsAreUniform()) {
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'tone-opt tone-opt-custom';
        marker.textContent = 'Custom';
        marker.disabled = true;
        marker.tabIndex = -1;
        panel.appendChild(marker);
      }
      // Bucket every available tone first by Synths / Samples (top
      // axis the user picks) and then by family (the existing sub-
      // categorization, used as section headers within each bucket).
      const allOpts = getAllSoundOptions();
      const byBucket = { synths: [], samples: [] };
      allOpts.forEach(opt => byBucket[_toneTopBucketFor(opt.value)].push(opt));
      const groupByFamily = (opts) => {
        const m = new Map();
        opts.forEach(opt => {
          const fam = toneFamilyFor(opt.value);
          if (!m.has(fam)) m.set(fam, []);
          m.get(fam).push(opt);
        });
        return m;
      };
      const renderRow = (opt) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tone-opt';
        b.textContent = opt.label;
        b.dataset.tone = opt.value;
        panel.appendChild(b);
      };
      const renderHeader = (text) => {
        const h = document.createElement('div');
        h.className = 'tone-subhead';
        h.textContent = text;
        panel.appendChild(h);
      };
      if (_toneMenuView === 'top') {
        // Two top-level buttons. Each shows the count of tones in
        // that bucket so the user can see at a glance how many synth
        // vs sample voices the workspace knows about.
        [
          { id: 'synths',  label: 'Synths',  count: byBucket.synths.length },
          { id: 'samples', label: 'Samples', count: byBucket.samples.length },
        ].forEach(b => {
          if (b.count === 0) return;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tone-opt tone-opt-family';
          btn.innerHTML = `<span>${b.label}</span><span class="tone-opt-count">${b.count} ▸</span>`;
          btn.addEventListener('click', (e) => {
            // Re-rendering removes the click target before the document
            // click-outside handler runs — stopPropagation keeps the
            // menu open while we drill in.
            e.stopPropagation();
            _toneMenuView = b.id;
            populateTonePanel();
            const trigger = document.getElementById('tone-banner-half');
            if (trigger && panel.classList.contains('open')) pinPanelToButton(trigger, panel);
          });
          panel.appendChild(btn);
        });
      } else {
        const bucket = _toneMenuView === 'synths' ? byBucket.synths : byBucket.samples;
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'tone-opt tone-opt-back';
        back.textContent = _toneMenuView === 'synths' ? '← Synths' : '← Samples';
        back.addEventListener('click', (e) => {
          e.stopPropagation();
          _toneMenuView = 'top';
          populateTonePanel();
          const trigger = document.getElementById('tone-banner-half');
          if (trigger && panel.classList.contains('open')) pinPanelToButton(trigger, panel);
        });
        panel.appendChild(back);
        const grouped = groupByFamily(bucket);
        // Walk the existing family order; any family with zero tones
        // in this bucket is skipped. The header text falls back to
        // the canonical family label.
        TONE_FAMILY_ORDER.forEach(fam => {
          const items = grouped.get(fam);
          if (!items || items.length === 0) return;
          if (fam === 'drums' && _toneMenuView === 'synths') {
            // Synths-side drums: kick / metal are the only one-shot
            // synth drums; render under a "Drums" subhead.
            renderHeader('Drums');
            items.forEach(renderRow);
            return;
          }
          if (fam === 'drums' && _toneMenuView === 'samples') {
            renderHeader('Drum kits');
            items.forEach(renderRow);
            return;
          }
          renderHeader(TONE_FAMILY_LABELS[fam] || fam);
          items.forEach(renderRow);
        });
      }
    }
    (function initToneMenu() {
      // Right half of the scale banner — its label shows the live current
      // tone (or "Mixed"), and clicking opens the same Tone panel that the
      // old menubar pill used.
      const btn = document.getElementById('tone-banner-half');
      const panel = document.getElementById('tone-panel');
      if (!btn || !panel) return;
      const TRIGGER_ID = 'tone-banner-half';
      const setOpen = (open) => {
        if (open) {
          // Always start at the family list when re-opening, and pick up
          // freshly-loaded samples / instruments.
          _toneMenuView = 'top';
          populateTonePanel();
        }
        panel.classList.toggle('open', open);
        btn.classList.toggle('open', open);
        if (open) pinPanelToButton(btn, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(btn, panel);
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panel.classList.contains('open');
        if (willOpen) document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: TRIGGER_ID } }));
        setOpen(willOpen);
      });
      // Close when any sibling menubar panel announces itself.
      document.addEventListener('menubar-panel-open', (e) => {
        if (e.detail?.id !== TRIGGER_ID && panel.classList.contains('open')) setOpen(false);
      });
      panel.addEventListener('click', (e) => {
        // Sculpt — open the sound editor (ADSR / level / effects) in
        // apply-to-all mode so the user can shape the current tone.
        if (e.target.closest('.tone-sculpt-btn')) {
          setOpen(false);
          if (typeof showSoundEditor === 'function') showSoundEditor(0, { applyAll: true });
          return;
        }
        const opt = e.target.closest('.tone-opt');
        if (!opt || !opt.dataset.tone) return; // skip family / back / custom marker
        const tone = opt.dataset.tone;
        // Wavetable picks open a partials editor — the user defines
        // the harmonic series before the tone is applied. Cancelling
        // the editor leaves the previous tone in place.
        if (tone === 'wavetable') {
          setOpen(false);
          showWavetableEditor((mix) => {
            applyToneToAllCells('wavetable');
            // Stash the oscillator mix amplitudes on every cell so
            // playNote builds the right osc stack.
            cellParams.forEach(p => { p.wavetableMix = [...mix]; });
            renderSequence();
            if (typeof persistWorkspace === 'function') persistWorkspace();
          });
          return;
        }
        if (tone === 'sample:grain') {
          setOpen(false);
          showGrainEditor((settings) => {
            applyToneToAllCells('sample:grain');
            // Stash the grain settings on every cell so playNote
            // reads them when building each GrainPlayer.
            cellParams.forEach(p => {
              p.grainSize    = settings.grainSize;
              p.grainOverlap = settings.grainOverlap;
              p.grainRate    = settings.grainRate;
            });
            renderSequence();
            if (typeof persistWorkspace === 'function') persistWorkspace();
          });
          return;
        }
        applyToneToAllCells(tone);
        setOpen(false);
      });
      document.addEventListener('click', (e) => {
        if (!panel.classList.contains('open')) return;
        if (panel.contains(e.target) || e.target === btn) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });
    })();

    // Re-parent the menubar dropdowns to <body> so the menubar's overflow
    // can't clip them on mobile. position: fixed via pinPanelToButton then
    // anchors them under their trigger buttons regardless of menubar state.
    (function detachPanelsFromMenubar() {
      const colors  = document.getElementById('colors-panel');
      const grid    = document.getElementById('grid-settings-panel');
      const tone    = document.getElementById('tone-panel');
      const fx      = document.getElementById('fx-panel');
      const project = document.getElementById('project-panel');
      const mvol    = document.getElementById('master-vol-panel');
      if (colors  && colors.parentNode  !== document.body) document.body.appendChild(colors);
      if (grid    && grid.parentNode    !== document.body) document.body.appendChild(grid);
      if (tone    && tone.parentNode    !== document.body) document.body.appendChild(tone);
      if (fx      && fx.parentNode      !== document.body) document.body.appendChild(fx);
      if (project && project.parentNode !== document.body) document.body.appendChild(project);
      if (mvol    && mvol.parentNode    !== document.body) document.body.appendChild(mvol);
    })();

    // Master-volume popover — opens from the 🔊 button on the right
    // side of the lane banner row. Toggles open/close; outside click
    // and Escape close it. Uses pinPanelToButton so position handling
    // mirrors every other dropdown.
    (function initMasterVolMenu() {
      const btn   = document.getElementById('master-vol-btn');
      const panel = document.getElementById('master-vol-panel');
      if (!btn || !panel) return;
      const TRIGGER_ID = 'master-vol-btn';
      const setOpen = (open) => {
        panel.classList.toggle('open', open);
        btn.classList.toggle('open', open);
        if (open) pinPanelToButton(btn, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(btn, panel);
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panel.classList.contains('open');
        if (willOpen) document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: TRIGGER_ID } }));
        setOpen(willOpen);
      });
      document.addEventListener('menubar-panel-open', (e) => {
        if (e.detail?.id !== TRIGGER_ID && panel.classList.contains('open')) setOpen(false);
      });
      document.addEventListener('click', (e) => {
        if (!panel.classList.contains('open')) return;
        if (panel.contains(e.target) || e.target === btn) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });
    })();

    (function initFxMenu() {
      // Now triggered by the FX banner row beneath the scale/tone strip
      // instead of the old menubar pill.
      const btn   = document.getElementById('fx-banner');
      const panel = document.getElementById('fx-panel');
      if (!btn || !panel) return;
      const TRIGGER_ID = 'fx-banner';

      // Reflect persisted values into the inputs and update the live audio.
      // Each entry is [inputId, valueLabelId, globalFx key, unit suffix].
      const sliders = [
        ['fx-rev',         'fx-rev-v',         'reverb',             '%'],
        ['fx-rev-size',    'fx-rev-size-v',    'reverbSize',         '%'],
        ['fx-rev-tone',    'fx-rev-tone-v',    'reverbTone',         '%'],
        ['fx-dly',         'fx-dly-v',         'delay',              '%'],
        ['fx-dly-time',    'fx-dly-time-v',    'delayTime',          ' ms'],
        ['fx-dly-fb',      'fx-dly-fb-v',      'delayFeedback',      '%'],
        ['fx-dst',         'fx-dst-v',         'distortion',         '%'],
        ['fx-cho',         'fx-cho-v',         'chorus',             '%'],
        ['fx-cho-freq',    'fx-cho-freq-v',    'chorusFreq',         ' Hz'],
        ['fx-cho-depth',   'fx-cho-depth-v',   'chorusDepth',        '%'],
        ['fx-vib',         'fx-vib-v',         'vibrato',            '%'],
        ['fx-vib-freq',    'fx-vib-freq-v',    'vibratoFreq',        ' Hz'],
        ['fx-vib-depth',   'fx-vib-depth-v',   'vibratoDepth',       '%'],
        ['fx-trm',         'fx-trm-v',         'tremolo',            '%'],
        ['fx-trm-freq',    'fx-trm-freq-v',    'tremoloFreq',        ' Hz'],
        ['fx-trm-depth',   'fx-trm-depth-v',   'tremoloDepth',       '%'],
        ['fx-phs',         'fx-phs-v',         'phaser',             '%'],
        ['fx-phs-freq',    'fx-phs-freq-v',    'phaserFreq',         ' Hz'],
        ['fx-phs-oct',     'fx-phs-oct-v',     'phaserOctaves',      ''],
        ['fx-af',          'fx-af-v',          'autoFilter',         '%'],
        ['fx-af-freq',     'fx-af-freq-v',     'autoFilterFreq',     ' Hz'],
        ['fx-af-depth',    'fx-af-depth-v',    'autoFilterDepth',    '%'],
        ['fx-af-base',     'fx-af-base-v',     'autoFilterBaseFreq', ' Hz'],
        ['fx-pp',          'fx-pp-v',          'pingPong',           '%'],
        ['fx-pp-time',     'fx-pp-time-v',     'pingPongTime',       ' ms'],
        ['fx-pp-fb',       'fx-pp-fb-v',       'pingPongFeedback',   '%'],
        ['fx-apan',        'fx-apan-v',        'autoPan',            '%'],
        ['fx-apan-freq',   'fx-apan-freq-v',   'autoPanFreq',        ' Hz'],
        ['fx-apan-depth',  'fx-apan-depth-v',  'autoPanDepth',       '%'],
      ];
      // Send/return: "Mix" sliders (key === one of the FX names) write
      // per-lane send levels; shape sliders (size, time, rate, depth,
      // etc.) write the shared globalFx params. `activeLaneChanged`
      // refreshes the Mix sliders so swapping lanes reads the new lane's
      // sends; shape sliders stay constant.
      const _isLaneSendKey = (k) => FX_NAMES.indexOf(k) !== -1;
      const _activeLane = () => lanes[activeLaneIdx] || null;
      const _activeSends = () => {
        const l = _activeLane();
        if (!l) return null;
        if (!l.sends) l.sends = _defaultLaneSends();
        return l.sends;
      };
      sliders.forEach(([id, valId, key, unit]) => {
        const input = panel.querySelector('#' + id);
        const label = panel.querySelector('#' + valId);
        if (!input || !label) return;
        const readVal = () => _isLaneSendKey(key)
          ? ((_activeSends() && _activeSends()[key]) || 0)
          : globalFx[key];
        input.value = String(readVal());
        label.textContent = readVal() + unit;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value) || 0;
          if (_isLaneSendKey(key)) {
            // Mix-key sliders dual-write: the value lands on the active
            // lane's per-lane sends (drives lane FX nodes) AND on
            // globalFx (drives globalSendTap's wet for cell presses,
            // untracked sequence playback, and any other non-lane audio
            // path). Without the globalFx write, dialing in reverb in
            // the FX panel was silent on note presses since the live-
            // press path bypasses lane.sends entirely.
            const sends = _activeSends();
            if (sends) sends[key] = v;
            label.textContent = v + unit;
            const lane = _activeLane();
            if (lane) {
              if (!lane._volume) getLaneBus(activeLaneIdx);
              applyLaneSends(lane);
            }
            globalFx[key] = v;
            try { applyGlobalSendGains(); } catch (e) {}
            if (typeof persistWorkspace === 'function') persistWorkspace();
            try { persistGlobalFx(); } catch (e) {}
          } else {
            globalFx[key] = v;
            label.textContent = v + unit;
            applyGlobalFx();
            persistGlobalFx();
          }
        });
      });
      // Bypass toggles: per-lane for FX mix keys (zero the lane send),
      // shared for params (no-op for sends architecture). All 10 toggles
      // are mix-keyed, so they're all per-lane in practice.
      const bypassToggles = [
        ['fx-rev-on',  'reverb',     'reverbOn'],
        ['fx-dly-on',  'delay',      'delayOn'],
        ['fx-dst-on',  'distortion', 'distortionOn'],
        ['fx-cho-on',  'chorus',     'chorusOn'],
        ['fx-vib-on',  'vibrato',    'vibratoOn'],
        ['fx-trm-on',  'tremolo',    'tremoloOn'],
        ['fx-phs-on',  'phaser',     'phaserOn'],
        ['fx-af-on',   'autoFilter', 'autoFilterOn'],
        ['fx-pp-on',   'pingPong',   'pingPongOn'],
        ['fx-apan-on', 'autoPan',    'autoPanOn'],
      ];
      // Per-lane bypass memo so each lane has its own restore-state.
      const _fxBypassByLane = new WeakMap();
      const refreshFxBypassUI = () => {
        const lane = _activeLane();
        const memo = lane ? (_fxBypassByLane.get(lane) || {}) : {};
        bypassToggles.forEach(([id, , onKey]) => {
          const tgl = panel.querySelector('#' + id);
          if (!tgl) return;
          const on = !memo[onKey];
          tgl.classList.toggle('off', !on);
          tgl.textContent = on ? 'ON' : 'OFF';
        });
      };
      bypassToggles.forEach(([id, fxKey, onKey]) => {
        const tgl = panel.querySelector('#' + id);
        if (!tgl) return;
        tgl.addEventListener('click', () => {
          const lane = _activeLane();
          if (!lane) return;
          const sends = _activeSends();
          if (!sends) return;
          let memo = _fxBypassByLane.get(lane);
          if (!memo) { memo = {}; _fxBypassByLane.set(lane, memo); }
          if (memo[onKey]) {
            // Un-bypass: restore stashed mix to BOTH the lane bus and
            // the global send tap. Cell-presses route via
            // globalSendTap (driven by globalFx[fxKey]) while lane
            // playback routes via lane.sends — both have to come back
            // for un-bypass to feel correct. Also flips
            // globalFx[onKey] so the offline WAV export's wetOf() gate
            // re-opens.
            const restored = memo[onKey + '_mix'] ?? 0;
            sends[fxKey]     = restored;
            globalFx[fxKey]  = restored;
            globalFx[onKey]  = true;
            delete memo[onKey];
            delete memo[onKey + '_mix'];
          } else {
            // Bypass: stash the current mix and zero BOTH paths so
            // cell-press, lane playback, and offline export all go
            // silent for this FX. sends and globalFx are kept in sync
            // by the slider's dual-write, so either is a fine source
            // for the stash.
            memo[onKey + '_mix'] = sends[fxKey] || 0;
            memo[onKey] = true;
            sends[fxKey]     = 0;
            globalFx[fxKey]  = 0;
            globalFx[onKey]  = false;
          }
          if (!lane._volume) getLaneBus(activeLaneIdx);
          applyLaneSends(lane);
          try { applyGlobalSendGains(); } catch (e) {}
          refreshFxBypassUI();
          // Mix slider may need a refresh to reflect the new zero / restored value.
          const slider = sliders.find(s => s[2] === fxKey);
          if (slider) {
            const inp = panel.querySelector('#' + slider[0]);
            const lbl = panel.querySelector('#' + slider[1]);
            if (inp) inp.value = String(sends[fxKey] || 0);
            if (lbl) lbl.textContent = (sends[fxKey] || 0) + slider[3];
          }
          try { persistGlobalFx(); } catch (e) {}
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
      });
      refreshFxBypassUI();

      // Effect-order list — renders globalFx.fxOrder as a stack of rows
      // with ↑ / ↓ buttons. A move re-runs rebuildMasterChain so the
      // master signal flow follows immediately; per-note chains pick up
      // the new order on each subsequent playNote call.
      const orderListEl = panel.querySelector('#fx-order-list');
      const renderFxOrder = () => {
        if (!orderListEl) return;
        orderListEl.innerHTML = '';
        const order = (Array.isArray(globalFx.fxOrder) && globalFx.fxOrder.length === FX_NAMES.length)
          ? globalFx.fxOrder
          : FX_NAMES;
        order.forEach((name, idx) => {
          const row = document.createElement('div');
          row.className = 'fx-order-row';
          row.innerHTML = `
            <span class="fx-order-pos">${idx + 1}.</span>
            <span class="fx-order-name">${FX_LABELS[name] || name}</span>
            <button type="button" class="fx-order-arrow" data-dir="up"   title="Move earlier in chain"${idx === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="fx-order-arrow" data-dir="down" title="Move later in chain"${idx === order.length - 1 ? ' disabled' : ''}>↓</button>
          `;
          row.querySelectorAll('.fx-order-arrow').forEach(btn => {
            btn.addEventListener('click', () => {
              const dir = btn.dataset.dir;
              const swapWith = (dir === 'up') ? idx - 1 : idx + 1;
              if (swapWith < 0 || swapWith >= order.length) return;
              const next = order.slice();
              [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
              globalFx.fxOrder = next;
              persistGlobalFx();
              rebuildMasterChain();
              renderFxOrder();
            });
          });
          orderListEl.appendChild(row);
        });
      };
      renderFxOrder();

      const refreshFxSliderUI = () => {
        const sends = _activeSends();
        sliders.forEach(([id, valId, key, unit]) => {
          const input = panel.querySelector('#' + id);
          const label = panel.querySelector('#' + valId);
          const v = _isLaneSendKey(key)
            ? (sends ? (sends[key] || 0) : 0)
            : globalFx[key];
          if (input) input.value = String(v);
          if (label) label.textContent = v + unit;
        });
        refreshFxBypassUI();
        renderFxOrder();
      };
      // Reload Mix sliders + bypass UI whenever the user switches lanes.
      document.addEventListener('activeLaneChanged', refreshFxSliderUI);
      // Bypass — toggle. First click stashes the three mix levels and zeros
      // them; second click restores them. Size/tone/time/feedback are never
      // touched, so the underlying character of each effect is preserved
      // across the round-trip.
      // Bypass — zero the mix levels (keep size/tone/time/feedback) and
      // restore on a second click. The audible mix lives in BOTH globalFx
      // (cell-press audition via globalSendTap) AND the active lane's sends
      // (lane playback), so both must be zeroed/restored — the old version
      // only touched globalFx, leaving lane FX still playing.
      const MIX_KEYS = ['reverb', 'delay', 'distortion', 'chorus', 'vibrato', 'tremolo', 'phaser', 'autoFilter', 'pingPong', 'autoPan'];
      let _fxBypassMemo = null;
      panel.querySelector('#fx-reset').addEventListener('click', () => {
        const lane = _activeLane();
        const sends = _activeSends();
        const allZero = MIX_KEYS.every(k => (globalFx[k] || 0) === 0 && (!sends || (sends[k] || 0) === 0));
        if (allZero && _fxBypassMemo) {
          MIX_KEYS.forEach(k => {
            globalFx[k] = _fxBypassMemo.global[k] ?? 0;
            if (_fxBypassMemo.lane && _fxBypassMemo.lane.sends) _fxBypassMemo.lane.sends[k] = (_fxBypassMemo.sends && _fxBypassMemo.sends[k]) ?? 0;
          });
          if (_fxBypassMemo.lane) { try { applyLaneSends(_fxBypassMemo.lane); } catch (e) {} }
          _fxBypassMemo = null;
        } else {
          _fxBypassMemo = { lane, global: {}, sends: sends ? {} : null };
          MIX_KEYS.forEach(k => {
            _fxBypassMemo.global[k] = globalFx[k] || 0;
            globalFx[k] = 0;
            if (sends) { _fxBypassMemo.sends[k] = sends[k] || 0; sends[k] = 0; }
          });
          if (lane) { try { applyLaneSends(lane); } catch (e) {} }
        }
        try { applyGlobalSendGains(); } catch (e) {}
        refreshFxSliderUI();
        applyGlobalFx();
        persistGlobalFx();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
      // Reset — restore every FX parameter to its default AND clear the mix
      // sends on every lane (the mix is per-lane, so resetting only globalFx
      // left lane FX untouched). Clears per-FX bypass memos too so the
      // ON/OFF toggles all read ON again.
      panel.querySelector('#fx-reset-all').addEventListener('click', () => {
        Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => {
          const v = GLOBAL_FX_DEFAULTS[k];
          globalFx[k] = Array.isArray(v) ? v.slice() : v;
        });
        _fxBypassMemo = null;
        (lanes || []).forEach(l => {
          if (!l) return;
          try { _fxBypassByLane.delete(l); } catch (e) {}
          if (typeof _defaultLaneSends === 'function') l.sends = _defaultLaneSends();
          try { applyLaneSends(l); } catch (e) {}
        });
        rebuildMasterChain();
        try { applyGlobalSendGains(); } catch (e) {}
        refreshFxSliderUI();
        applyGlobalFx();
        persistGlobalFx();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
      // Save / Load — round-trip the current globalFx through Google Drive
      // so users can reuse their setups across projects and devices.
      panel.querySelector('#fx-save-btn').addEventListener('click', saveEffectsToDrive);
      panel.querySelector('#fx-load-btn').addEventListener('click', () => loadEffectsFromDrive(refreshFxSliderUI));

      const setOpen = (open) => {
        panel.classList.toggle('open', open);
        btn.classList.toggle('open', open);
        if (open) pinPanelToButton(btn, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(btn, panel);
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panel.classList.contains('open');
        if (willOpen) document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: TRIGGER_ID } }));
        setOpen(willOpen);
      });
      document.addEventListener('menubar-panel-open', (e) => {
        if (e.detail?.id !== TRIGGER_ID && panel.classList.contains('open')) setOpen(false);
      });
      document.addEventListener('click', (e) => {
        if (!panel.classList.contains('open')) return;
        if (panel.contains(e.target) || e.target === btn) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });
    })();

