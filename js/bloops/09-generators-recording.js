    // ---- Random sequence generator ----

    function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    const _RAND_SUBS = [4, 2, 1, 1, 0.5, 0.5, 0.5, 0.25, 0.25, 0.125];

    function sampleWithoutReplacement(sourceLen, k) {
      const pool = [];
      for (let i = 0; i < sourceLen; i++) pool.push(i);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, Math.min(k, sourceLen));
    }

    function randomStepParams(type) {
      return { type, attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0, reverb: 0, reverbSize: 70, reverbTone: 50, delay: 0, delayTime: 250, delayFeedback: 40, delaySync: null, distortion: 0, chorus: 0, chorusFreq: 4, chorusDepth: 70, vibrato: 0, vibratoFreq: 5, vibratoDepth: 30, tremolo: 0, tremoloFreq: 5, tremoloDepth: 70, phaser: 0, phaserFreq: 0.5, phaserOctaves: 3, autoFilter: 0, autoFilterFreq: 1, autoFilterDepth: 100, autoFilterBaseFreq: 200, pingPong: 0, pingPongTime: 250, pingPongFeedback: 30, pingPongSync: null, autoPan: 0, autoPanFreq: 1, autoPanDepth: 100 };
    }

    // Text → sequence translation. Mapping rules:
    //   letters       → scale-tone note. Letter index (a=0, …, z=25) wraps
    //                   over the available scale cells of the chosen scale.
    //   tone          → deterministic by letter (tonePool[letterIdx % len])
    //                   so every 'a' uses the same sound.
    //   vowels        → +1 to duration (held longer)
    //   uppercase     → +1 to duration (combines with vowel rule)
    //   consonant run → groups of 2+ consecutive consonants flush as one
    //                   chord (capped at MAX_CHORD voices, deduped by pitch).
    //                   Vowels and non-letters break the run.
    //   non-letters   → rest if includeRests, otherwise skipped (also flush
    //                   any pending chord run first).
    function generateTextSequence(text, scaleName, tones, includeRests, octavesToUse = null) {
      const intervals = (scaleName && SCALES[scaleName]) || SCALES['chromatic'];
      const octCap = Math.max(1, Math.min(7, Number.isFinite(octavesToUse) ? octavesToUse : octaveCount));
      const pickNotes = (octCap <= octaveCount) ? notes : computeNotesForOctaves(octCap);
      const visibleCount = notes.length;
      const scaleCells = [];
      for (let i = 0; i < pickNotes.length; i++) {
        if (Math.floor(i / 12) >= octCap) break;
        if (intervals.includes(i % 12)) scaleCells.push(i);
      }
      if (scaleCells.length === 0) return [];
      const tonePool = (Array.isArray(tones) && tones.length > 0) ? tones : SOUNDS;
      const VOWELS = new Set(['a','e','i','o','u']);
      const MAX_CHORD = 5;
      const subdivision = 1;
      const out = [];

      const letterCellIdx = (ch) => {
        const i = ch.toLowerCase().charCodeAt(0) - 97;
        return scaleCells[i % scaleCells.length];
      };
      const letterTone = (ch) => {
        const i = ch.toLowerCase().charCodeAt(0) - 97;
        return tonePool[i % tonePool.length];
      };
      const makeVoice = (letter) => {
        const cellIdx = letterCellIdx(letter);
        const sound = letterTone(letter);
        return {
          freq: pickNotes[cellIdx].freq,
          label: pickNotes[cellIdx].label,
          cellIndex: (cellIdx < visibleCount) ? cellIdx : null,
          sound,
          params: randomStepParams(sound),
        };
      };

      let run = [];
      let runHasUpper = false;
      const flushRun = () => {
        if (run.length === 0) return;
        const dur = 1 + (runHasUpper ? 1 : 0);
        if (run.length === 1) {
          const v = makeVoice(run[0]);
          out.push({ ...v, duration: dur, subdivision });
        } else {
          const voices = [];
          const seenCells = new Set();
          for (const letter of run.slice(0, MAX_CHORD)) {
            const v = makeVoice(letter);
            if (seenCells.has(v.cellIndex)) continue;
            seenCells.add(v.cellIndex);
            voices.push(v);
          }
          if (voices.length === 1) {
            out.push({ ...voices[0], duration: dur, subdivision });
          } else {
            out.push({
              chord: voices,
              label: voices.map(n => n.label).join('·'),
              duration: dur, subdivision,
            });
          }
        }
        run = [];
        runHasUpper = false;
      };

      for (const ch of String(text)) {
        if (/[a-zA-Z]/.test(ch)) {
          const lower = ch.toLowerCase();
          const isUpper = ch !== lower;
          if (VOWELS.has(lower)) {
            flushRun();
            const dur = 2 + (isUpper ? 1 : 0);
            const v = makeVoice(ch);
            out.push({ ...v, duration: dur, subdivision });
          } else {
            run.push(ch);
            if (isUpper) runHasUpper = true;
          }
        } else {
          flushRun();
          if (includeRests) {
            out.push({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision });
          }
        }
      }
      flushRun();
      return out;
    }

    // Generated accent pattern: a per-step volume (0..100) giving the sequence
    // dynamics instead of every note at full velocity. Picks a metric period
    // (2/3/4), marks downbeats strong + a secondary mid accent in 4, weak
    // elsewhere, with light random jitter so it feels played, not stamped.
    function _genAccentPattern(n) {
      const period = randomFrom([2, 3, 4]);
      const STRONG = 100, MID = 74, WEAK = 52;
      const out = [];
      for (let s = 0; s < n; s++) {
        const pos = s % period;
        let v = (pos === 0) ? STRONG : (period >= 4 && pos === 2) ? MID : WEAK;
        v = Math.max(22, Math.min(100, Math.round(v + (Math.random() * 2 - 1) * 8)));
        out.push(v);
      }
      return out;
    }
    function generateRandomSequence(numSteps, maxChordSize, includeRests = true, includeChords = true, scaleName = null, tones = null, octavesToUse = null, accentPattern = false) {
      // Filter the chromatic note grid down to scale tones — `pool` holds
      // the cell indices we're allowed to sample from. octavesToUse caps the
      // pool to the bottom N octaves (1 = lowest octave only). Notes beyond
      // the visible grid are computed on the fly so the slider can request
      // more octaves than the grid currently shows; their cellIndex is set
      // to null since there's no on-screen cell to highlight.
      const intervals = (scaleName && SCALES[scaleName]) || SCALES['chromatic'];
      const octCap = Math.max(1, Math.min(7, Number.isFinite(octavesToUse) ? octavesToUse : octaveCount));
      const pickNotes = (octCap <= octaveCount) ? notes : computeNotesForOctaves(octCap);
      const visibleCount = notes.length;
      const pool = [];
      for (let i = 0; i < pickNotes.length; i++) {
        if (Math.floor(i / 12) >= octCap) break;
        if (intervals.includes(i % 12)) pool.push(i);
      }
      const poolSize = pool.length;
      if (poolSize === 0) return [];
      const tonePool = (Array.isArray(tones) && tones.length > 0) ? tones : SOUNDS;
      const cellIdxFor = (i) => (i < visibleCount) ? i : null;
      const out = [];
      const chordAllowed = includeChords && maxChordSize > 1 && poolSize > 1;
      const accents = accentPattern ? _genAccentPattern(numSteps) : null;
      for (let s = 0; s < numSteps; s++) {
        const roll = Math.random();
        const subdivision = randomFrom(_RAND_SUBS);
        const duration    = 1;
        if (includeRests && roll < 0.18) {
          out.push({ freq: null, label: '—', cellIndex: null, duration, subdivision });
          continue;
        }
        if (chordAllowed && roll < 0.45) {
          const size = 2 + Math.floor(Math.random() * (maxChordSize - 1));
          const picked = sampleWithoutReplacement(poolSize, size);
          const chord = picked.map(p => {
            const idx = pool[p];
            const sound = randomFrom(tonePool);
            const params = randomStepParams(sound);
            if (accents) params.volume = accents[s];
            return {
              freq: pickNotes[idx].freq,
              label: pickNotes[idx].label,
              cellIndex: cellIdxFor(idx),
              sound,
              params,
            };
          });
          out.push({
            chord,
            label: chord.map(n => n.label).join('·'),
            duration, subdivision,
          });
          continue;
        }
        const idx = pool[Math.floor(Math.random() * poolSize)];
        const sound = randomFrom(tonePool);
        const params = randomStepParams(sound);
        if (accents) params.volume = accents[s];
        out.push({
          freq: pickNotes[idx].freq,
          label: pickNotes[idx].label,
          cellIndex: cellIdxFor(idx),
          sound,
          params,
          duration, subdivision,
        });
      }
      return out;
    }

    // Tones currently in use across the grid — Random's tone selector only
    // surfaces these, so the generated sequence stays in sync with the
    // active voice. If the grid is uniform, only that one tone is offered.
    function tonesUsedInVoice() {
      const seen = new Set();
      const ordered = [];
      (cellSounds || []).forEach(t => {
        if (!t) return;
        if (seen.has(t)) return;
        seen.add(t);
        ordered.push(t);
      });
      if (ordered.length === 0) ordered.push('sine');
      return ordered;
    }

    function showRandomDialog() {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Random sequence</div>
        <div class="sm-param">
          <div class="sm-param-row">Number of steps <span class="sm-val" id="rand-steps-v">16</span></div>
          <input type="range" id="rand-steps" min="1" max="64" value="16" />
        </div>
        <div class="sm-param">
          <div class="sm-param-row">Max chord size <span class="sm-val" id="rand-chord-v">3</span></div>
          <input type="range" id="rand-chord" min="1" max="8" value="3" />
        </div>
        <div class="sm-section-label" style="margin-top:0;">Tones to use <span style="font-weight:400;letter-spacing:0;text-transform:none;color:#4a4a6a;">(from current voice)</span></div>
        <div class="sm-waves" id="rand-tones"></div>
        <div style="display:flex;gap:8px;padding:4px 0 4px;">
          <button type="button" id="rand-tones-all" class="sm-preview" style="padding:3px 10px;font-size:0.72rem;">All</button>
          <button type="button" id="rand-tones-none" class="sm-preview" style="padding:3px 10px;font-size:0.72rem;">None</button>
        </div>
        <label style="display:flex;align-items:center;gap:8px;padding:6px 0 4px;color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.85rem;cursor:pointer;">
          <input type="checkbox" id="rand-rests" />
          Include rests
        </label>
        <label style="display:flex;align-items:center;gap:8px;padding:0 0 4px;color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.85rem;cursor:pointer;">
          <input type="checkbox" id="rand-chords" />
          Include chords
        </label>
        <label style="display:flex;align-items:center;gap:8px;padding:0 0 4px;color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.85rem;cursor:pointer;">
          <input type="checkbox" id="rand-accent" />
          Accent pattern (dynamics)
        </label>
        <div style="color:#4a4a6a;font-family:'Segoe UI',sans-serif;font-size:0.72rem;padding:4px 0 10px;">
          Uses the grid's current scale and octave range. Replaces the in-progress sequence — save first to keep the existing one.
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="rand-cancel">Cancel</button>
          <button type="button" class="sm-apply" id="rand-generate">Generate</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const stepsIn = modal.querySelector('#rand-steps');
      const stepsOut = modal.querySelector('#rand-steps-v');
      const chordIn = modal.querySelector('#rand-chord');
      const chordOut = modal.querySelector('#rand-chord-v');
      const chordsCheck = modal.querySelector('#rand-chords');
      stepsIn.addEventListener('input', () => stepsOut.textContent = stepsIn.value);
      chordIn.addEventListener('input', () => chordOut.textContent = chordIn.value);

      // Max-chord-size slider only matters when chords are enabled.
      const syncChordSlider = () => {
        const on = chordsCheck.checked;
        chordIn.disabled = !on;
        chordIn.style.opacity = on ? '' : '0.4';
        chordOut.style.opacity = on ? '' : '0.4';
      };
      chordsCheck.addEventListener('change', syncChordSlider);
      syncChordSlider();

      // Tone selector — only tones currently used in the voice are shown.
      // All start selected so generating immediately produces something
      // audible from every cell type the user has set up.
      const tonesRow = modal.querySelector('#rand-tones');
      const allOpts = getAllSoundOptions();
      const labelFor = (val) => allOpts.find(o => o.value === val)?.label || val;
      const voiceTones = tonesUsedInVoice();
      const selectedTones = new Set(voiceTones);
      const toneButtons = new Map();
      voiceTones.forEach(value => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sm-wave active';
        btn.textContent = labelFor(value);
        btn.addEventListener('click', () => {
          if (selectedTones.has(value)) {
            selectedTones.delete(value);
            btn.classList.remove('active');
          } else {
            selectedTones.add(value);
            btn.classList.add('active');
          }
        });
        tonesRow.appendChild(btn);
        toneButtons.set(value, btn);
      });
      modal.querySelector('#rand-tones-all').addEventListener('click', () => {
        voiceTones.forEach(v => {
          selectedTones.add(v);
          toneButtons.get(v)?.classList.add('active');
        });
      });
      modal.querySelector('#rand-tones-none').addEventListener('click', () => {
        selectedTones.clear();
        toneButtons.forEach(btn => btn.classList.remove('active'));
      });

      modal.querySelector('#rand-cancel').addEventListener('click', () => overlay.remove());
      modal.querySelector('#rand-generate').addEventListener('click', () => {
        const n = Math.max(1, Math.min(64, parseInt(stepsIn.value) || 16));
        const c = Math.max(1, Math.min(8,  parseInt(chordIn.value) || 3));
        const includeRests  = !!modal.querySelector('#rand-rests').checked;
        const includeChords = !!modal.querySelector('#rand-chords').checked;
        const accentPattern = !!modal.querySelector('#rand-accent').checked;
        const tones         = Array.from(selectedTones);
        snapshotForUndo('Random sequence');
        stopSequence();
        // Use the grid's current scale + octaveCount so generation stays
        // anchored to the active voice instead of forcing user choices.
        const generated = generateRandomSequence(n, c, includeRests, includeChords, currentScale, tones, octaveCount, accentPattern);
        // Keep on: append; Keep off: replace (original behavior).
        sequence = keepMode ? sequence.concat(generated) : generated;
        pendingChord = [];
        insertionPoint = null;
        renderSequence();
        document.getElementById('save-btn').disabled = sequence.length === 0;
        overlay.remove();
      });
    }

    // ---- Euclidean rhythm generator ----
    // Spread K hits as evenly as possible across N steps (Bjorklund-style
    // bresenham) — the classic generative rhythm engine. Optional rotation
    // shifts the pattern's starting point. Because lanes loop at their own
    // length, generating e.g. 5-over-8 in one lane and 3-over-8 in another
    // gives instant polymeter/polyrhythm.
    function euclideanPattern(k, n, rot) {
      n = Math.max(1, n | 0);
      k = Math.max(0, Math.min(n, k | 0));
      const p = [];
      let bucket = 0;
      for (let i = 0; i < n; i++) {
        bucket += k;
        if (bucket >= n) { bucket -= n; p.push(1); } else { p.push(0); }
      }
      const r = (((rot | 0) % n) + n) % n;
      return r ? p.slice(r).concat(p.slice(0, r)) : p;
    }
    // The current grid tone for a chosen note — so generated hits play the
    // active voice (piano, etc.) instead of a bare sine. Uses the note's own
    // cell tone when it maps to a grid cell, else the root cell's tone.
    function _euclidToneFor(note) {
      let cp = null;
      if (typeof cellParams !== 'undefined') {
        if (note && Number.isFinite(note.cellIndex) && cellParams[note.cellIndex]) cp = cellParams[note.cellIndex];
        else if (cellParams[0]) cp = cellParams[0];
      }
      return cp ? { sound: cp.type || 'sine', params: { ...cp } } : {};
    }
    // Step div catalog. `eu` = duration in eighth-note units (1/8 = 1), the
    // unit the dialog reasons about length in; the engine subdivision is
    // eu × 0.5. Includes triplet (T) values.
    const _EUC_DIVS = [
      ['1/32', 0.25], ['1/16T', 1 / 3], ['1/16', 0.5], ['1/8T', 2 / 3],
      ['1/8', 1], ['1/4T', 4 / 3], ['1/4', 2], ['1/2', 4], ['1/1', 8],
    ];
    // Build the lane from the editable step list. Each step carries hit/
    // noteIdxs/eu; subdivision = eu × 0.5 so step lengths match their divs.
    function _buildEuclidSteps(steps, gridNotes, wrapSteps) {
      const noteFor = (idx) => gridNotes[idx] || gridNotes[0] || { freq: 261.63, label: 'C4', cellIndex: 0 };
      const voice = (nt) => ({ freq: nt.freq, label: nt.label, cellIndex: Number.isFinite(nt.cellIndex) ? nt.cellIndex : null, ..._euclidToneFor(nt) });
      // Stack a CHORDS structure on a root note: each semitone in the
      // chord becomes a voice rooted on the selected note, inheriting the
      // root's grid tone. The root voice keeps its cellIndex; stacked
      // voices clear it (they may not map to a grid cell).
      const chordVoices = (rootNt, chordKey) => {
        const def = (typeof CHORDS !== 'undefined') ? CHORDS[chordKey] : null;
        const semis = (def && Array.isArray(def.semis) && def.semis.length) ? def.semis : [0];
        const tone = _euclidToneFor(rootNt);
        return semis.map(semi => {
          const f = rootNt.freq * Math.pow(2, semi / 12);
          let label = rootNt.label;
          try { label = Tone.Frequency(f).toNote(); } catch (e) {}
          return { freq: f, label, cellIndex: (semi === 0 && Number.isFinite(rootNt.cellIndex)) ? rootNt.cellIndex : null, ...tone };
        });
      };
      return steps.map(s => {
        const sub = Math.max(0.0001, (s.eu || 1) * 0.5);
        if (!s.hit) return { freq: null, label: '—', cellIndex: null, duration: 1, subdivision: sub };
        // Wraps mode: this circle plays a wrap from the selected wrap sequence
        // (cloned so the generated step is independent of the bank).
        if (Array.isArray(wrapSteps) && wrapSteps.length && Number.isFinite(s.wrapIdx)) {
          const wr = wrapSteps[((s.wrapIdx % wrapSteps.length) + wrapSteps.length) % wrapSteps.length];
          if (wr && wr.step) {
            const ws = (typeof cloneStep === 'function') ? cloneStep(wr.step) : JSON.parse(JSON.stringify(wr.step));
            ws.duration = 1; ws.subdivision = sub;
            return ws;
          }
        }
        // Chord mode: the selected note is the chord root; the chosen
        // CHORDS shape is stacked on it.
        if (s.noteMode === 'chord' && s.chordKey) {
          const root = noteFor((Array.isArray(s.noteIdxs) && s.noteIdxs.length) ? s.noteIdxs[0] : 0);
          const cv = chordVoices(root, s.chordKey);
          if (cv.length === 1) return { ...cv[0], duration: 1, subdivision: sub };
          return { chord: cv, label: cv.map(v => v.label).join('·'), duration: 1, subdivision: sub };
        }
        const idxs = (Array.isArray(s.noteIdxs) && s.noteIdxs.length) ? s.noteIdxs : [0];
        if (idxs.length === 1) return { ...voice(noteFor(idxs[0])), duration: 1, subdivision: sub };
        return { chord: idxs.map(ix => voice(noteFor(ix))), label: idxs.map(ix => noteFor(ix).label).join('·'), duration: 1, subdivision: sub };
      });
    }
    function showEuclidDialog() {
      const gridNotes = (typeof notes !== 'undefined' && Array.isArray(notes) && notes.length)
        ? notes : [{ freq: 261.63, label: 'C4', cellIndex: 0 }];
      const EPS = 1e-6;
      const DEFAULTS = { k: 5, n: 8, rot: 0, length: 8 };
      // steps: [{ hit, noteIdxs, eu }] whose eu sum is held at `length`.
      // applyMode: how Generate commits — replace / append / prepend the
      // active lane's steps. Seeds from the old keepMode behavior (append
      // when Keep is on, else replace) so existing muscle memory holds.
      const state = { ...DEFAULTS, sel: -1, steps: [], applyMode: keepMode ? 'append' : 'replace',
        // Content mode: 'hits' (notes/chords, the default) or 'wraps' (each
        // circle plays a wrap from a selected wrap sequence, looping).
        contentMode: 'hits', wrapSeqKey: null, wrapSteps: [] };
      const _eucWrapOptions = () => (typeof _wrapSequenceOptions === 'function') ? _wrapSequenceOptions() : [];
      // Resolve the selected wrap sequence → state.wrapSteps, and size the node
      // count (Hits) to its length (bumping Steps/Length if needed).
      const applyWrapSeq = () => {
        const opt = _eucWrapOptions().find(o => o.key === state.wrapSeqKey);
        state.wrapSteps = (opt && Array.isArray(opt.items)) ? opt.items.slice() : [];
        const wc = state.wrapSteps.length;
        if (wc > 0) {
          if (state.n < wc) state.n = Math.min(32, wc);
          if (state.length < state.n) state.length = state.n;
          state.k = Math.min(state.n, wc);
        }
      };
      // After seeding, assign each circle (hit) the next wrap in the sequence,
      // looping. Per-circle overrides (set in the editor) are lost on reseed,
      // matching how note selections reset.
      const assignWraps = () => {
        if (state.contentMode !== 'wraps' || !state.wrapSteps.length) return;
        let h = 0;
        state.steps.forEach(s => { if (s.hit) { s.wrapIdx = h % state.wrapSteps.length; h++; } });
      };

      // Seed the step list from the Euclidean spread. `Steps` (n) is the
      // resolution of the rhythm cycle E(K,N,rot); `Length` is how many
      // steps to actually lay down. The n-step cycle repeats (and truncates
      // on the final partial cycle) to fill `Length` steps, so raising
      // Length lengthens the sequence and lowering it shortens it — what
      // the control name implies. Each step is one 1/8 unit (eu = 1); the
      // per-step Div editor / global subdivision change individual lengths
      // after seeding. When Length === N (the default 8/8) this is byte-for-
      // byte the old single-cycle behavior. Re-run on K/N/Rotate/Length.
      const seed = () => {
        const pat = euclideanPattern(state.k, state.n, state.rot);
        const L = Math.max(1, state.length | 0);
        state.steps = [];
        for (let i = 0; i < L; i++) {
          state.steps.push({ hit: !!pat[i % state.n], noteIdxs: [0], eu: 1 });
        }
        state.sel = -1;
        assignWraps();
      };
      // Change step i's div while preserving total length: shrinking spawns a
      // rest of the freed time right after; growing consumes (shrinks/removes)
      // the following steps, clamping if it runs off the end.
      const setStepDiv = (i, newEu) => {
        const s = state.steps[i]; if (!s) return;
        const delta = newEu - s.eu;
        s.eu = newEu;
        if (delta < -EPS) {
          state.steps.splice(i + 1, 0, { hit: false, noteIdxs: [], eu: -delta });
        } else if (delta > EPS) {
          let need = delta, j = i + 1;
          while (need > EPS && j < state.steps.length) {
            if (state.steps[j].eu <= need + EPS) { need -= state.steps[j].eu; state.steps.splice(j, 1); }
            else { state.steps[j].eu -= need; need = 0; }
          }
          if (need > EPS) s.eu -= need;
        }
      };
      const applyDivToAll = (isHit, newEu) => {
        state.steps.filter(s => s.hit === isHit).forEach(t => {
          const idx = state.steps.indexOf(t);
          if (idx >= 0) setStepDiv(idx, newEu);
        });
      };

      // A labelled numeric input flanked by large −/+ steppers (− left,
      // + right). The stepper buttons carry data-target / data-d so a
      // single delegated handler drives all four.
      const _numRow = (label, id, min, max, val) =>
        '<div class="euc-num"><div class="euc-num-label">' + label + '</div><div class="euc-num-ctl">' +
          '<button type="button" class="euc-step-btn" data-target="' + id + '" data-d="-1">−</button>' +
          '<input type="number" class="euc-num-input" id="' + id + '" min="' + min + '" max="' + max + '" value="' + val + '" />' +
          '<button type="button" class="euc-step-btn" data-target="' + id + '" data-d="1">+</button>' +
        '</div></div>';

      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal euc-modal';
      modal.innerHTML =
        '<div class="sm-title">Generate Sequence</div>' +
        '<div class="euc-nums">' +
          // Hits row: the label is a toggle (Hits ↔ Wraps). In Wraps mode the
          // numeric entry is swapped for a wrap-sequence dropdown; −/+ still
          // adjust the node (circle) count.
          '<div class="euc-num euc-hits-row" id="euc-hits-row">' +
            '<button type="button" class="euc-num-label euc-mode-toggle" id="euc-mode-toggle" title="Toggle Hits (dot count) ↔ Wraps (a wrap sequence)">Hits</button>' +
            '<div class="euc-num-ctl">' +
              '<button type="button" class="euc-step-btn" data-target="euc-k" data-d="-1">−</button>' +
              '<input type="number" class="euc-num-input" id="euc-k" min="1" max="16" value="5" />' +
              '<select class="euc-num-input euc-wrapseq" id="euc-wrapseq" style="display:none;"></select>' +
              '<button type="button" class="euc-step-btn" data-target="euc-k" data-d="1">+</button>' +
            '</div>' +
          '</div>' +
          _numRow('Steps',  'euc-n', 2, 32, 8) +
          _numRow('Rotate', 'euc-r', 0, 31, 0) +
          _numRow('Length', 'euc-l', 1, 32, 8) +
        '</div>' +
        '<button type="button" class="euc-surprise" id="euc-surprise">✨ Surprise me</button>' +
        '<div class="sm-section-label" style="margin-top:0;">Pattern — tap a step to edit (tap again to close)</div>' +
        '<div class="euc-strip" id="euc-strip"></div>' +
        '<div class="euc-stepedit" id="euc-stepedit"></div>' +
        '<div class="sm-section-label" style="margin-top:0;">On Generate</div>' +
        '<div class="sm-waves euc-apply" id="euc-apply">' +
          '<button type="button" class="sm-wave" data-apply="replace">Replace</button>' +
          '<button type="button" class="sm-wave" data-apply="append">Append</button>' +
          '<button type="button" class="sm-wave" data-apply="prepend">Prepend</button>' +
        '</div>' +
        '<div class="sm-footer euc-footer">' +
          '<div class="euc-gen-alt">' +
            '<button type="button" class="euc-altbtn" id="euc-reset" title="Reset all values to default">Reset</button>' +
            '<button type="button" class="euc-altbtn" id="euc-random" title="Generate a random sequence from the current voice">Random</button>' +
            '<button type="button" class="euc-altbtn" id="euc-seed" title="Seed the sequence from a built-in song or text">Seed</button>' +
          '</div>' +
          '<div class="euc-gen-main">' +
            '<button type="button" class="sm-preview" id="euc-cancel">Cancel</button>' +
            '<button type="button" class="sm-preview" id="euc-preview">Preview</button>' +
            '<button type="button" class="sm-apply" id="euc-go">Generate</button>' +
          '</div>' +
        '</div>';
      overlay.appendChild(modal); document.body.appendChild(overlay);

      const kEl = modal.querySelector('#euc-k'), nEl = modal.querySelector('#euc-n'),
            rEl = modal.querySelector('#euc-r'), lEl = modal.querySelector('#euc-l');
      const stripEl = modal.querySelector('#euc-strip'), editEl = modal.querySelector('#euc-stepedit');

      const renderStrip = () => {
        stripEl.innerHTML = '';
        state.steps.forEach((s, i) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'euc-cell' + (s.hit ? ' hit' : ' rest') + (i === state.sel ? ' sel' : '');
          // Grow proportional to the step's div so widths stay relative and
          // the strip always fills the row (8 even steps → equal eighths).
          btn.style.flexGrow = String(Math.max(0.05, s.eu || 1));
          btn.style.flexBasis = '0';
          btn.textContent = s.hit ? '●' : '·';
          btn.addEventListener('click', () => {
            state.sel = (state.sel === i) ? -1 : i;  // tap toggles the editor
            renderStrip(); renderEditor();
          });
          stripEl.appendChild(btn);
        });
      };
      // Chord types in musical order (triads → 7ths → extensions).
      const _EUC_CHORD_ORDER = ['maj','min','dim','aug','sus2','sus4','maj7','7',
        'min7','dim7','m7b5','minMaj7','6','m6','6/9','add9','madd9','9','maj9',
        'min9','7sus4','7b9','7#9','7b5','7#11','11','min11','maj11','13','maj13','min13'];
      const renderEditor = () => {
        const i = state.sel;
        if (i < 0 || i >= state.steps.length) { editEl.innerHTML = ''; return; }
        const s = state.steps[i];
        const isHit = !!s.hit;
        const wrapsMode = isHit && state.contentMode === 'wraps' && state.wrapSteps.length > 0;
        const chordMode = isHit && !wrapsMode && s.noteMode === 'chord';
        let html = '<div class="euc-step-head">' +
            '<div class="euc-step-title">Step ' + (i + 1) + ' — ' + (isHit ? 'Circle ●' : 'Dot ·') + '</div>' +
            '<button type="button" class="euc-convert" id="euc-convert">' + (isHit ? 'Make Dot ·' : 'Make Circle ●') + '</button>' +
          '</div>' +
          '<div class="sm-section-label" style="margin-top:0;">Step div</div><select class="euc-sel" id="euc-div"></select>';
        if (isHit && wrapsMode) {
          // Per-circle wrap override — pick which wrap from the sequence plays here.
          html += '<div class="sm-section-label">Wrap</div><select class="euc-sel" id="euc-wrappick"></select>';
        } else if (isHit) {
          html += '<div class="sm-section-label">Notes</div>' +
            '<div class="sm-waves" id="euc-notemode">' +
              '<button type="button" class="sm-wave' + (!chordMode ? ' active' : '') + '" data-mode="notes">Notes</button>' +
              '<button type="button" class="sm-wave' + (chordMode ? ' active' : '') + '" data-mode="chord">Chord</button>' +
            '</div>';
          if (chordMode) {
            html += '<div class="sm-section-label">Chord type</div><select class="euc-sel" id="euc-chordkey"></select>' +
              '<div class="sm-section-label">Root</div><select class="euc-sel" id="euc-notes"></select>';
          } else {
            html += '<div class="sm-section-label">Pitches (select one or more)</div>' +
              '<select class="euc-sel euc-sel-multi" id="euc-notes" multiple size="' + Math.min(Math.max(gridNotes.length, 2), 8) + '"></select>';
          }
        }
        html += '<div class="euc-allrow"><button type="button" class="euc-all" id="euc-all-div">Apply div to all ' + (isHit ? '●' : '·') + '</button>' +
          (isHit && wrapsMode ? '<button type="button" class="euc-all" id="euc-all-wrap">Apply wrap to all ●</button>'
            : (isHit ? '<button type="button" class="euc-all" id="euc-all-notes">Apply notes to all ●</button>' : '')) + '</div>';
        editEl.innerHTML = html;

        // Convert this step between Dot (rest) and Circle (hit).
        editEl.querySelector('#euc-convert').addEventListener('click', () => {
          if (s.hit) {
            s.hit = false;
          } else {
            s.hit = true;
            if (!Array.isArray(s.noteIdxs) || !s.noteIdxs.length) s.noteIdxs = [0];
            if (!s.noteMode) s.noteMode = 'notes';
            // Newly-made circle gets the next wrap in the sequence when in
            // Wraps mode (so it isn't blank).
            if (state.contentMode === 'wraps' && state.wrapSteps.length && !Number.isFinite(s.wrapIdx)) {
              const hits = state.steps.filter(t => t.hit).length;
              s.wrapIdx = (hits - 1 + state.wrapSteps.length) % state.wrapSteps.length;
            }
          }
          renderStrip(); renderEditor();
        });

        // Per-circle wrap picker (Wraps mode).
        if (isHit && wrapsMode) {
          const wsel = editEl.querySelector('#euc-wrappick');
          const curIdx = Number.isFinite(s.wrapIdx) ? ((s.wrapIdx % state.wrapSteps.length) + state.wrapSteps.length) % state.wrapSteps.length : 0;
          state.wrapSteps.forEach((it, wi) => {
            const opt = document.createElement('option');
            opt.value = String(wi);
            opt.textContent = (it.name || ('#' + (wi + 1))) + ' · ' + (typeof wrapBankChipLabel === 'function' ? wrapBankChipLabel(it.step) : '');
            if (wi === curIdx) opt.selected = true;
            wsel.appendChild(opt);
          });
          wsel.addEventListener('change', () => { s.wrapIdx = parseInt(wsel.value, 10) || 0; renderStrip(); });
          const allWrap = editEl.querySelector('#euc-all-wrap');
          if (allWrap) allWrap.addEventListener('click', () => {
            // Re-distribute starting from THIS circle's wrap, looping.
            let h = 0; const start = s.wrapIdx | 0;
            state.steps.forEach(t => { if (t.hit) { t.wrapIdx = (start + h) % state.wrapSteps.length; h++; } });
            renderStrip(); renderEditor();
          });
        }

        const divSel = editEl.querySelector('#euc-div');
        let _divMatched = false;
        _EUC_DIVS.forEach(([label, eu]) => {
          const opt = document.createElement('option');
          opt.value = String(eu); opt.textContent = label;
          if (Math.abs((s.eu || 1) - eu) < 1e-3) { opt.selected = true; _divMatched = true; }
          divSel.appendChild(opt);
        });
        // Seeded steps can carry a non-catalog length (length / N). Surface
        // it as a leading read-only option so the dropdown reflects reality;
        // picking any catalog div re-quantizes via setStepDiv.
        if (!_divMatched) {
          const opt = document.createElement('option');
          opt.value = ''; opt.textContent = 'Custom (' + (s.eu || 1).toFixed(2) + '/8)';
          opt.selected = true;
          divSel.insertBefore(opt, divSel.firstChild);
        }
        divSel.addEventListener('change', () => {
          const eu = parseFloat(divSel.value);
          if (!Number.isFinite(eu)) return;
          setStepDiv(i, eu); renderStrip(); renderEditor();
        });

        if (isHit && !wrapsMode) {
          // Notes ↔ Chord mode toggle. Switching to Chord collapses any
          // multi-note selection down to a single root.
          editEl.querySelector('#euc-notemode').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-mode]'); if (!btn) return;
            const mode = btn.getAttribute('data-mode');
            if (mode === 'chord') {
              s.noteMode = 'chord';
              if (!s.chordKey) s.chordKey = 'maj';
              s.noteIdxs = [(Array.isArray(s.noteIdxs) && s.noteIdxs.length) ? s.noteIdxs[0] : 0];
            } else {
              s.noteMode = 'notes';
            }
            renderStrip(); renderEditor();
          });

          if (chordMode) {
            const csel = editEl.querySelector('#euc-chordkey');
            _EUC_CHORD_ORDER.filter(k => CHORDS[k]).forEach(k => {
              const opt = document.createElement('option');
              opt.value = k; opt.textContent = CHORDS[k].label;
              if ((s.chordKey || 'maj') === k) opt.selected = true;
              csel.appendChild(opt);
            });
            csel.addEventListener('change', () => { s.chordKey = csel.value; renderStrip(); });
          }

          const notesSel = editEl.querySelector('#euc-notes');
          const cur = new Set((s.noteIdxs && s.noteIdxs.length) ? s.noteIdxs : [0]);
          const rootIdx0 = (Array.isArray(s.noteIdxs) && s.noteIdxs.length) ? s.noteIdxs[0] : 0;
          gridNotes.forEach((nt, ni) => {
            const opt = document.createElement('option');
            opt.value = String(ni); opt.textContent = nt.label;
            // Chord mode = single-select root; Notes mode = multi-select.
            if (chordMode ? (ni === rootIdx0) : cur.has(ni)) opt.selected = true;
            notesSel.appendChild(opt);
          });
          notesSel.addEventListener('change', () => {
            if (chordMode) {
              s.noteIdxs = [parseInt(notesSel.value, 10) || 0];
            } else {
              let picked = [...notesSel.selectedOptions].map(o => parseInt(o.value, 10)).filter(Number.isFinite);
              if (!picked.length) picked = [0]; // keep at least one pitch
              s.noteIdxs = picked.sort((a, b) => a - b);
            }
            renderStrip();
          });
          const allNotes = editEl.querySelector('#euc-all-notes');
          if (allNotes) allNotes.addEventListener('click', () => {
            const mode = s.noteMode || 'notes';
            const v = [...(s.noteIdxs || [0])];
            const ck = s.chordKey;
            state.steps.forEach(st => {
              if (!st.hit) return;
              st.noteMode = mode;
              st.noteIdxs = [...v];
              if (mode === 'chord') st.chordKey = ck;
            });
            renderStrip();
          });
        }
        const allDiv = editEl.querySelector('#euc-all-div');
        if (allDiv) allDiv.addEventListener('click', () => {
          applyDivToAll(isHit, s.eu);
          state.sel = -1; renderStrip(); renderEditor();
        });
      };

      const refreshTopVals = () => {
        // Steps bounds Hits + Rotate; keep their max attrs + values in sync.
        kEl.max = String(state.n);
        rEl.max = String(Math.max(0, state.n - 1));
        kEl.value = String(state.k);
        nEl.value = String(state.n);
        rEl.value = String(state.rot);
        lEl.value = String(state.length);
      };
      const onTop = () => {
        state.n = Math.max(2, Math.min(32, parseInt(nEl.value, 10) || 2));
        state.length = Math.max(1, Math.min(32, parseInt(lEl.value, 10) || 1));
        state.k = Math.max(1, Math.min(state.n, parseInt(kEl.value, 10) || 1));
        state.rot = Math.max(0, Math.min(state.n - 1, parseInt(rEl.value, 10) || 0));
        seed(); refreshTopVals(); renderStrip(); renderEditor();
      };
      [kEl, nEl, rEl, lEl].forEach(el => el.addEventListener('input', onTop));
      // Large −/+ steppers nudge their target input by ±1, then re-derive.
      modal.querySelectorAll('.euc-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = modal.querySelector('#' + btn.getAttribute('data-target'));
          if (!input) return;
          const d = parseInt(btn.getAttribute('data-d'), 10) || 0;
          input.value = String((parseInt(input.value, 10) || 0) + d);
          onTop();
        });
      });
      // ---- Hits ↔ Wraps mode ----
      const modeToggle = modal.querySelector('#euc-mode-toggle');
      const wrapSeqSel = modal.querySelector('#euc-wrapseq');
      const refreshModeUI = () => {
        const wraps = state.contentMode === 'wraps';
        modeToggle.textContent = wraps ? 'Wraps' : 'Hits';
        modeToggle.classList.toggle('wraps-on', wraps);
        kEl.style.display = wraps ? 'none' : '';
        wrapSeqSel.style.display = wraps ? '' : 'none';
        if (wraps) {
          wrapSeqSel.innerHTML = '';
          _eucWrapOptions().forEach(o => {
            const op = document.createElement('option');
            op.value = o.key;
            op.textContent = o.label;
            if (o.key === state.wrapSeqKey) op.selected = true;
            wrapSeqSel.appendChild(op);
          });
        }
      };
      modeToggle.addEventListener('click', () => {
        if (state.contentMode === 'hits') {
          const opts = _eucWrapOptions();
          if (!opts.length) { if (typeof showToast === 'function') showToast('No wrap sequences yet — save some wraps first'); return; }
          state.contentMode = 'wraps';
          if (!state.wrapSeqKey || !opts.find(o => o.key === state.wrapSeqKey)) state.wrapSeqKey = opts[0].key;
          applyWrapSeq();
        } else {
          state.contentMode = 'hits';
        }
        refreshModeUI(); seed(); refreshTopVals(); renderStrip(); renderEditor();
      });
      wrapSeqSel.addEventListener('change', () => {
        state.wrapSeqKey = wrapSeqSel.value;
        applyWrapSeq();
        refreshModeUI(); seed(); refreshTopVals(); renderStrip(); renderEditor();
      });

      // Surprise me — random-but-valid values for all four controls.
      modal.querySelector('#euc-surprise').addEventListener('click', () => {
        const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
        state.n = ri(3, 16);
        state.length = ri(2, 16);
        state.k = ri(1, state.n);
        state.rot = ri(0, state.n - 1);
        seed(); refreshTopVals(); renderStrip(); renderEditor();
      });
      // Prepend / Append / Replace selector — how Generate commits.
      const applyHost = modal.querySelector('#euc-apply');
      const refreshApply = () => {
        applyHost.querySelectorAll('[data-apply]').forEach(btn =>
          btn.classList.toggle('active', btn.getAttribute('data-apply') === state.applyMode));
      };
      applyHost.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-apply]'); if (!btn) return;
        state.applyMode = btn.getAttribute('data-apply');
        refreshApply();
      });
      refreshApply();

      seed(); refreshTopVals(); renderStrip(); renderEditor(); refreshModeUI();

      // ---- Looping preview ----
      // Preview is a toggle: first press starts an audition that loops the
      // current pattern until pressed again (or the dialog closes). Each
      // cycle rebuilds the steps from live state, so edits to hits / notes /
      // divs while it's running are heard on the next pass. Cycles are
      // pinned to the running audio clock (_eucPreviewAt advances by the
      // pattern's exact duration) so the loop stays gapless instead of
      // drifting with setTimeout jitter.
      const previewBtn = modal.querySelector('#euc-preview');
      let _eucPreviewTimer = null;
      let _eucPreviewAt = 0;
      const _eucTotalMs = (steps) => {
        const bpm = parseInt(tempoInput?.value, 10) || 120;
        let t = 0;
        const add = (s) => {
          if (!s) return;
          if (s.isSub && Array.isArray(s.subSteps)) { s.subSteps.forEach(add); return; }
          const dur = s.duration || 1;
          const sub = (s.subdivision != null) ? s.subdivision : stepSubdivision;
          t += Math.round(60000 / bpm * sub) * dur;
        };
        steps.forEach(add);
        return t;
      };
      const stopEucPreview = () => {
        if (_eucPreviewTimer) { clearTimeout(_eucPreviewTimer); _eucPreviewTimer = null; }
        _eucPreviewAt = 0;
        if (previewBtn) { previewBtn.classList.remove('active'); previewBtn.textContent = 'Preview'; }
      };
      const _eucPreviewTick = () => {
        const steps = _buildEuclidSteps(state.steps, gridNotes, state.wrapSteps);
        if (!steps.length || typeof playSubStepsAtTime !== 'function') { stopEucPreview(); return; }
        const now = (typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0;
        // First cycle fires at `now` (interactive press — no cushion); later
        // cycles use the pinned, contiguous time so playback is seamless.
        if (!_eucPreviewAt || _eucPreviewAt < now) _eucPreviewAt = now;
        try { playSubStepsAtTime(steps, _eucPreviewAt); } catch (e) {}
        const periodMs = Math.max(60, _eucTotalMs(steps));
        _eucPreviewAt += periodMs / 1000;
        // Re-arm ~40 ms before the next cycle's audio time so the next pass
        // is scheduled in advance; clamp so a tiny pattern can't busy-loop.
        const leadMs = (_eucPreviewAt - now) * 1000 - 40;
        _eucPreviewTimer = setTimeout(_eucPreviewTick, Math.max(10, leadMs));
      };

      const close = () => { stopEucPreview(); overlay.remove(); };
      modal.querySelector('#euc-cancel').addEventListener('click', close);
      modal.querySelector('#euc-reset').addEventListener('click', () => {
        Object.assign(state, DEFAULTS, { sel: -1 });
        kEl.value = String(DEFAULTS.k); nEl.value = String(DEFAULTS.n);
        rEl.value = String(DEFAULTS.rot); lEl.value = String(DEFAULTS.length);
        seed(); refreshTopVals(); renderStrip(); renderEditor();
      });
      // Preview — toggle a looping audition of the current pattern (no commit).
      previewBtn.addEventListener('click', () => {
        if (_eucPreviewTimer) { stopEucPreview(); return; }
        try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
        previewBtn.classList.add('active');
        previewBtn.textContent = 'Stop';
        _eucPreviewAt = 0;
        _eucPreviewTick();
      });
      modal.querySelector('#euc-random').addEventListener('click', () => { close(); if (typeof showRandomDialog === 'function') showRandomDialog(); });
      modal.querySelector('#euc-seed').addEventListener('click', () => { close(); if (typeof showSeedDialog === 'function') showSeedDialog(); });
      modal.querySelector('#euc-go').addEventListener('click', () => {
        const generated = _buildEuclidSteps(state.steps, gridNotes, state.wrapSteps);
        snapshotForUndo('Euclid');
        try { stopSequence(); } catch (e) {}
        if (state.applyMode === 'append')       sequence = sequence.concat(generated);
        else if (state.applyMode === 'prepend') sequence = generated.concat(sequence);
        else                                    sequence = generated; // replace
        pendingChord = []; insertionPoint = null;
        renderSequence();
        const sb = document.getElementById('save-btn'); if (sb) sb.disabled = sequence.length === 0;
        if (typeof persistWorkspace === 'function') persistWorkspace();
        close();
      });
      requestAnimationFrame(() => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      });
    }
    document.getElementById('euclid-btn')?.addEventListener('click', showEuclidDialog);

    // Seed sequence dialog — built-in song presets and text-to-sequence
    // moved out of the Random dialog so each entry point stays focused.
    function showSeedDialog() {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Seed sequence</div>
        <div class="sm-section-label" style="margin-top:0;">Built-in song</div>
        <div class="sm-waves" id="seed-songs"></div>
        <div class="sm-section-label">Text to sequence</div>
        <input type="text" id="seed-text" placeholder="Type here to seed from text…" style="width:100%;padding:6px 10px;background:#0a0a14;border:1px solid #2d2d3f;color:#e2e8f0;border-radius:6px;font-family:inherit;font-size:0.85rem;" />
        <div style="color:#4a4a6a;font-family:'Segoe UI',sans-serif;font-size:0.7rem;padding:4px 0 8px;line-height:1.5;">
          Letters → scale tones from the current voice. Vowels and uppercase are held longer. Runs of 2+ consonants become chords. Spaces &amp; punctuation become rests.
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="seed-cancel">Cancel</button>
          <button type="button" class="sm-apply" id="seed-generate">Seed from text</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const songsRow = modal.querySelector('#seed-songs');
      const SONG_PRESETS = [
        { key: 'vivaldi',        label: 'Vivaldi' },
        { key: 'bach',           label: 'Bach' },
        { key: 'mozart',         label: 'Mozart' },
        { key: 'beethoven',      label: 'Beethoven' },
        { key: 'miles',          label: 'Miles Davis' },
        { key: 'takeiteasy',     label: 'Take It Easy' },
        { key: 'margaritaville', label: 'Margaritaville' },
        { key: 'likeaprayer',    label: 'Like a Prayer' },
      ];
      SONG_PRESETS.forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sm-wave sm-wave--song';
        btn.textContent = p.label;
        btn.title = `Replace the workspace with the ${p.label} preset`;
        btn.addEventListener('click', () => {
          loadSongPreset(p.key);
          overlay.remove();
        });
        songsRow.appendChild(btn);
      });

      modal.querySelector('#seed-cancel').addEventListener('click', () => overlay.remove());
      modal.querySelector('#seed-generate').addEventListener('click', () => {
        const text = modal.querySelector('#seed-text').value.trim();
        if (!text) { overlay.remove(); return; }
        const tones = tonesUsedInVoice();
        snapshotForUndo('Text → sequence');
        stopSequence();
        // Punctuation / spaces become rests by default — the prior dialog
        // exposed this as an opt-in checkbox, but the typical expectation
        // of "text to sequence" is that whitespace is silence, so rests
        // are now always on.
        const generated = generateTextSequence(text, currentScale, tones, true, octaveCount);
        sequence = keepMode ? sequence.concat(generated) : generated;
        pendingChord = [];
        insertionPoint = null;
        renderSequence();
        document.getElementById('save-btn').disabled = sequence.length === 0;
        overlay.remove();
      });
    }

    function showPostSaveDialog() {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Sequence saved</div>
        <div style="color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.85rem;padding:8px 0 16px;">
          Reset the UI to default, or keep your current settings?
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-keep">Keep current</button>
          <button type="button" class="sm-reset">Reset to default</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      modal.querySelector('.sm-keep').addEventListener('click', () => overlay.remove());
      modal.querySelector('.sm-reset').addEventListener('click', () => {
        resetUIToDefault();
        overlay.remove();
      });
    }

    // Deep-clone a saved-bank entry and pick a unique ".N" name so the
    // duplicate shares zero references with the source. The previous
    // shallow-spread clone left nested arrays (lanes, lane.steps,
    // cellParams, globalFx, palette, sends, etc.) aliased — editing
    // the duplicate after loading it back into the workspace could
    // mutate the original's bank entry on save and inflate the step
    // count via the spread-merge in the Save handler. JSON round-trip
    // is safe here because saved entries are pure data (no functions
    // or DOM refs).
    function _cloneSavedSequence(seq) {
      if (!seq) return null;
      let copy;
      try { copy = JSON.parse(JSON.stringify(seq)); }
      catch (e) { return null; }
      const base = (seq.name || '').replace(/\.\d+$/, '');
      let n = 1;
      while (savedSequences.some(s => s.name === `${base}.${n}`)) n++;
      copy.name = `${base}.${n}`;
      return copy;
    }
    function currentSequenceSnapshot(extra = {}) {
      const snap = {
        // Deep-clone every step so saved bank entries don't share
        // references with the live workspace — without this, editing
        // a step after saving silently mutates the saved sequence too,
        // and any other lane that later loads the same bank entry
        // inherits the same shared refs.
        steps: sequence.map(cloneStep),
        bpm: parseInt(tempoInput.value) || 120,
        rootIdx,
        baseOctave,
        octaveCount,
        masterFreqA,
        scale: currentScale,
        palette: [...palette],
        cellSounds: [...cellSounds],
        cellParams: cellParams.map(p => ({ ...p })),
        loopMode,
        subdivision: stepSubdivision,
        restColor,
        // Grid layout — rows drive the lane count when this entry is
        // loaded back into a poly workspace. Saving them means a
        // multi-lane bank entry restores with its lanes intact (not
        // collapsed to gridRows=1). Default cols=8 so a Mono-saved
        // entry still loads cleanly.
        gridColumns: Math.max(1, Math.min(8, gridColumns | 0) || 8),
        gridRows:    Math.max(1, Math.min(8, gridRows    | 0) || 1),
        // Per-saved-sequence FX state: capture the live globalFx so
        // reloading this entry restores its FX shape and live-press
        // send levels. Lane sends are captured separately in the
        // poly snap below. Deep clone so future edits to globalFx
        // don't mutate the snapshot.
        globalFx: (typeof globalFx === 'object' && globalFx) ? JSON.parse(JSON.stringify(globalFx)) : null,
      };
      // Poly-mode entries carry the full lane array so reloading a
      // saved sequence restores every lane's steps + per-lane state
      // (mute / solo / drift / pan / volume / slip), not just the
      // active lane. `steps` above stays for backward-compat with
      // the Mono-only bank format and with track items that read
      // steps directly. Loaders fall back to it when `lanes` is
      // absent (Mono-saved entries).
      if (polyMode && Array.isArray(lanes) && lanes.length > 0) {
        snap.polyMode = true;
        snap.activeLaneIdx = Number.isFinite(activeLaneIdx) ? activeLaneIdx : 0;
        snap.lanes = lanes.map(l => ({
          name: l.name,
          steps: (l.steps || []).map(cloneStep),
          muted: !!l.muted,
          solo:  !!l.solo,
          driftMs:        Number.isFinite(l.driftMs)        ? l.driftMs        : 0,
          driftLocked:    !!l.driftLocked,
          driftOffsetSec: Number.isFinite(l.driftOffsetSec) ? l.driftOffsetSec : 0,
          pan:    Number.isFinite(l.pan)    ? l.pan    : 0,
          volume: Number.isFinite(l.volume) ? l.volume : 100,
          slip:   Number.isFinite(l.slip)   ? l.slip   : 0,
          collapsed: !!l.collapsed,
          fluidGridMode: !!l.fluidGridMode,
          ambientMode: !!l.ambientMode,
          ambient: l.ambient ? JSON.parse(JSON.stringify({ ...l.ambient, playing: false })) : null,
          textMode: !!l.textMode,
          text: l.text ? JSON.parse(JSON.stringify(l.text)) : null,
          // Per-lane FX send levels — deep clone so future mutations on
          // the live lane.sends don't bleed into the snapshot.
          sends: l.sends ? { ...l.sends } : null,
        }));
      }
      return Object.assign(snap, extra);
    }

    // ---- Subsequence editor mode ----

    let subEditState = null; // { parentStepIndex, parentSequence, parentActiveSeqIndex }

    function enterSubEditMode(parentStepIndex) {
      if (subEditState) return; // No nesting
      stopSequence();
      const parentStep = sequence[parentStepIndex];
      let initialSubSteps;
      if (parentStep && parentStep.isSub && Array.isArray(parentStep.subSteps)) {
        initialSubSteps = parentStep.subSteps.map(s => ({ ...s }));
      } else if (parentStep) {
        // Carry the existing step into the subsequence so the user starts
        // from what was there instead of an empty workspace.
        initialSubSteps = [{ ...parentStep }];
      } else {
        initialSubSteps = [];
      }
      subEditState = {
        parentStepIndex,
        parentSequence: sequence.map(s => ({ ...s })),
        parentActiveSeqIndex: activeSeqIndex,
        parentInsertionPoint: insertionPoint,
      };
      sequence = initialSubSteps;
      pendingChord = [];
      activeSeqIndex = null;
      insertionPoint = null;
      document.getElementById('subedit-banner').classList.add('open');
      document.getElementById('save-btn').classList.add('sub-edit');
      document.getElementById('save-btn').disabled = sequence.length === 0;
      renderSequence();
    }

    function exitSubEditMode(parentSequence) {
      sequence = parentSequence;
      pendingChord = [];
      activeSeqIndex = subEditState.parentActiveSeqIndex;
      insertionPoint = subEditState.parentInsertionPoint ?? null;
      subEditState = null;
      document.getElementById('subedit-banner').classList.remove('open');
      document.getElementById('save-btn').classList.remove('sub-edit');
      document.getElementById('save-btn').disabled = sequence.length === 0;
      renderSequence();
      renderSavedSequences();
    }

    function commitSubEditAndExit() {
      if (!subEditState) return;
      const subSteps = sequence.map(s => ({ ...s }));
      const parent = subEditState.parentSequence;
      if (subSteps.length > 0) {
        parent[subEditState.parentStepIndex] = {
          isSub: true,
          subSteps,
          label: '▤',
          duration: 1,
        };
      } else {
        parent.splice(subEditState.parentStepIndex, 1);
      }
      exitSubEditMode(parent);
    }

    function cancelSubEdit() {
      if (!subEditState) return;
      stopSequence();
      exitSubEditMode(subEditState.parentSequence);
    }

    document.getElementById('subedit-cancel').addEventListener('click', cancelSubEdit);

    function flashSaveConfirm(label = 'Saved') {
      const btn = document.getElementById('save-btn');
      const original = btn.textContent;
      btn.textContent = label;
      btn.classList.add('flash-confirm');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('flash-confirm');
      }, 1100);
    }

    // Save also resets the selection state and unchecks Multi so a fresh
    // edit session starts from a clean slate.
    function _resetSaveSelectionAndMulti() {
      clearSelection();
      multiSelectMode = false;
      const multiCb = document.getElementById('multi-select-toggle');
      if (multiCb) multiCb.checked = false;
    }

    // Overwrite the currently-selected saved sequence in place (preserving its
    // name) and leave the workspace alone so the user can keep iterating.
    function saveOverwriteActiveSeq() {
      const existing = activeSeqIndex !== null ? savedSequences[activeSeqIndex] : null;
      if (!existing || existing.type === 'audio') return false;
      const updated = {
        ...existing,
        ...currentSequenceSnapshot({ name: existing.name }),
      };
      savedSequences[activeSeqIndex] = updated;
      persistSaved();
      // Reflect into master Shapes as an independent copy (saves never change
      // the saved sequence; edits to the copy never change the save).
      try { if (typeof _shapeReflectSavedSeq === 'function') _shapeReflectSavedSeq(updated); } catch (e) {}
      // Propagate to any track items that came from this saved sequence so
      // edits show up everywhere the sequence appears, not just in the bank.
      propagateSavedToTracks(existing.name, updated);
      renderSavedSequences();
      flashSaveConfirm();
      _resetSaveSelectionAndMulti();
      renderSequence();
      return true;
    }

    // Push a brand-new saved sequence under `name`, then KEEP it loaded in the
    // workspace (select it as the active saved entry so a later Save offers
    // Overwrite). Previously this cleared the workspace, which wiped the active
    // lane out from under the user right after saving.
    function saveAsNewSeq(name) {
      name = (name && name.trim()) || seqName(savedSequences.length);
      const _entry = { name, ...currentSequenceSnapshot() };
      savedSequences.push(_entry);
      persistSaved();
      // Reflect into master Shapes as an independent copy (see saveOverwrite…).
      try { if (typeof _shapeReflectSavedSeq === 'function') _shapeReflectSavedSeq(_entry); } catch (e) {}

      // Leave the sequence loaded in full — just mark the new entry active so the
      // bank highlights it and the next Save can overwrite it.
      activeSeqIndex = savedSequences.length - 1;
      _resetSaveSelectionAndMulti();

      renderSequence();
      renderSavedSequences();
      flashSaveConfirm();
      // Persist the post-save workspace state. Without this the user's
      // most recent edits across lanes (which may not have triggered a
      // persist on their own — addToSequence aside, many mutation
      // paths don't auto-persist) would be lost on reload, since
      // persistSaved only writes the bank, not the workspace snapshot.
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Save workflow: ask whether to overwrite the currently-selected sequence
    // or create a new one (prompting for a name). With no active selection the
    // popover offers just the named "Save as new" path.
    function showSavePopover() {
      const existing = activeSeqIndex !== null ? savedSequences[activeSeqIndex] : null;
      const canOverwrite = !!(existing && existing.type !== 'audio');
      const defName = seqName(savedSequences.length);
      const escName = canOverwrite ? String(existing.name).replace(/[<>&"]/g, '') : '';

      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal save-seq-modal';
      modal.innerHTML =
        '<div class="sm-title">Save sequence</div>' +
        (canOverwrite
          ? '<button type="button" class="sm-apply save-seq-overwrite">Overwrite “' + escName + '”</button>' +
            '<div class="save-seq-or">— or create a new one —</div>'
          : '') +
        '<label class="ee-field ee-name"><span>New sequence name</span>' +
          '<input type="text" id="save-seq-name" placeholder="' + defName.replace(/"/g, '&quot;') + '"></label>' +
        '<div class="se-wave-actions">' +
          '<button type="button" class="sm-wave save-seq-cancel">Cancel</button>' +
          '<button type="button" class="sm-apply save-seq-new">Save as new</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const close = () => { try { overlay.remove(); } catch (e) {} };
      const nameInput = modal.querySelector('#save-seq-name');
      setTimeout(() => { try { nameInput.focus(); } catch (e) {} }, 0);
      const doNew = () => { const n = nameInput.value; close(); saveAsNewSeq(n); };
      if (canOverwrite) {
        modal.querySelector('.save-seq-overwrite').addEventListener('click', () => { close(); saveOverwriteActiveSeq(); });
      }
      modal.querySelector('.save-seq-new').addEventListener('click', doNew);
      modal.querySelector('.save-seq-cancel').addEventListener('click', close);
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doNew(); } });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    document.getElementById('save-btn').addEventListener('click', () => {
      if (subEditState) {
        commitSubEditAndExit();
        return;
      }
      if (sequence.length === 0) return;
      showSavePopover();
    });

    // ---- Audio recording (mic → saved as an 'audio' sequence) ----

    let mediaRecorder = null;
    let recordingStream = null;
    let recordingStartMs = 0;
    let recordingChunks = [];
    let recordingCountingIn = false;

    async function toggleRecording() {
      const btn = document.getElementById('rec-btn');
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        return;
      }
      if (recordingCountingIn) {
        // Cancel the in-flight count-in: drop the prepared mic stream and
        // recorder so the count-in branch in the start path bails out.
        recordingCountingIn = false;
        if (recordingStream) {
          try { recordingStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        }
        recordingStream = null;
        mediaRecorder = null;
        btn.classList.remove('counting');
        btn.textContent = '●';
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        alert('This browser does not support audio recording.');
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert(location.protocol !== 'https:' && location.hostname !== 'localhost'
          ? 'Audio recording requires HTTPS. Open this page over https:// to enable the microphone.'
          : 'This browser does not support microphone access.');
        return;
      }
      try {
        // Raw stereo for sampling (2 channels, no echo-cancel / noise-suppress / AGC);
        // fall back to plain audio if the device rejects the constraints.
        const _recChEl = document.getElementById('rec-ch');
        const _recCh = (_recChEl && _recChEl.value === '1') ? 1 : 2;   // user-chosen mono / stereo
        const rawStereo = { channelCount: { ideal: _recCh }, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        try { recordingStream = await navigator.mediaDevices.getUserMedia({ audio: rawStereo }); }
        catch (e2) { recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      } catch (e) {
        alert('Microphone access was denied or unavailable.');
        return;
      }
      const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      const mimeType = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
      mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
      recordingChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordingChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const durationSec = (performance.now() - recordingStartMs) / 1000;
        recordingStream.getTracks().forEach(t => t.stop());
        recordingStream = null;
        const type = mediaRecorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(recordingChunks, { type });
        mediaRecorder = null;
        recordingChunks = [];
        btn.classList.remove('recording');
        btn.classList.remove('counting');
        btn.textContent = '●';
        const reader = new FileReader();
        reader.onload = () => saveRecordingToLibrary(reader.result, durationSec);
        reader.readAsDataURL(blob);
      };

      // Optional 4-beat count-in at the workspace tempo before the recorder
      // actually starts. The Rec button shows "…" while counting and the
      // user can click it again to abort.
      if (countInEnabled) {
        recordingCountingIn = true;
        btn.classList.add('counting');
        btn.textContent = '… Count';
        try { await playCountIn(); } finally {
          recordingCountingIn = false;
          btn.classList.remove('counting');
        }
        // If user cancelled (mediaRecorder cleared / stream stopped), bail.
        if (!mediaRecorder || !recordingStream) {
          btn.textContent = '●';
          return;
        }
      }

      mediaRecorder.start();
      recordingStartMs = performance.now();
      btn.classList.add('recording');
      btn.textContent = '⏹';
    }

    // Cross-view bridge: the Player's long-press menu calls into Bloops
    // to copy a Drive audio track into the sequencer bank as an audio
    // chip and onto a fresh stereo track. Returns the chip's saved entry
    // so the caller can read its name back into a confirmation toast.
    async function importAudioBlobToBloops(blob, suggestedName) {
      if (!blob) throw new Error('No audio blob provided');
      // Decode just enough to read duration. Use the live Tone context
      // so the decode runs on the same AudioContext the rest of Bloops
      // uses (avoids creating an orphan context on iOS).
      let durationSec = 0;
      try {
        const ab = await blob.arrayBuffer();
        const ctx = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
          ? Tone.context.rawContext
          : (window.AudioContext ? new AudioContext() : null);
        if (ctx) {
          const decoded = await new Promise((resolve, reject) => {
            const p = ctx.decodeAudioData(ab.slice(0), resolve, reject);
            if (p && typeof p.then === 'function') p.then(resolve, reject);
          });
          durationSec = decoded?.duration || 0;
        }
      } catch (e) {
        console.warn('Could not decode imported audio for duration:', e);
      }
      const dataUrl = await blobToDataUrl(blob);
      const name = (suggestedName && suggestedName.trim()) || seqName(savedSequences.length);
      const entry = {
        name,
        type: 'audio',
        audioDataUrl: dataUrl,
        durationSec,
        bpm: parseInt(tempoInput.value) || 120,
        subdivision: stepSubdivision,
        steps: [],
      };
      savedSequences.push(entry);
      try {
        persistSaved();
      } catch (e) {
        savedSequences.pop();
        throw new Error('Audio is too large to save in browser storage. Delete some sequences and try again.');
      }
      renderSavedSequences();
      // Stereo track — Player audio is downloaded from Drive in its
      // original stereo file format, so a mono track would collapse the
      // image unnecessarily.
      const trackIdx = addTrack({ stereo: true });
      addSavedToTrack(trackIdx, entry);
      return entry;
    }
    // Bridge for the Player's playlist long-press menu, defined on
    // window so playlist-manager.js (a separate module) can reach it.
    window.bloopsImportAudio = importAudioBlobToBloops;

    function saveRecordingToLibrary(dataUrl, durationSec) {
      const name = seqName(savedSequences.length);
      const entry = {
        name,
        type: 'audio',
        audioDataUrl: dataUrl,
        durationSec,
        bpm: parseInt(tempoInput.value) || 120,
        subdivision: stepSubdivision,
        steps: [], // keep for compatibility with anything that iterates
      };
      savedSequences.push(entry);
      activeSeqIndex = savedSequences.length - 1;
      try {
        persistSaved();
      } catch (e) {
        savedSequences.pop();
        activeSeqIndex = null;
        alert('Recording is too large to save in browser storage. Delete some sequences and try again, or shorten the clip.');
        return;
      }
      renderSavedSequences();
    }

    document.getElementById('rec-btn').addEventListener('click', toggleRecording);
    // Random / Seed now live in the Generate Sequence (Gen) dialog; these
    // legacy Riff-panel triggers are gone, so guard against their absence.
    document.getElementById('random-btn')?.addEventListener('click', showRandomDialog);
    document.getElementById('seed-btn')?.addEventListener('click', showSeedDialog);

    // ---- Song presets ----
    // Each entry is one of:
    //   null               → rest at the preset's subdivision
    //   'NoteName'         → note at the preset's subdivision (duration 1)
    //   { n, d }           → note with custom duration (in subdivision units)
    // Themes are reductions, not strict transcriptions — the goal is a
    // contour the listener recognizes within the first few bars.
    const VIVALDI_SPRING_NOTES = [
      'E5', 'E5', null, 'E5',
      'E5', null, 'F#5', 'E5',
      'D#5', 'E5', null, 'E5',
      'F#5', 'E5', 'D#5', 'E5',
    ];
    // Bach — Toccata and Fugue in D minor (BWV 565), opening flourish:
    // mordent on A, then the descending D-minor cadence.
    const BACH_TOCCATA_NOTES = [
      'A5', 'G5', { n: 'A5', d: 3 }, null,
      'G5', 'F5', 'E5', 'D5',
      'C#5', { n: 'D5', d: 3 }, null, null,
    ];
    // Mozart — Eine kleine Nachtmusik, K. 525, opening violin theme:
    // ascending G-major arpeggio + answering descent in D.
    const MOZART_NACHTMUSIK_NOTES = [
      'G5', 'D5', 'G5', 'D5',
      'G5', 'D5', 'G5', 'B5',
      'A5', 'D5', 'A5', 'D5',
      'A5', 'D5', 'A5', 'C6',
    ];
    // Beethoven — Symphony No. 5, Op. 67, opening "fate motif":
    // three short notes + one long, transposed down a step on the repeat.
    // sub=0.5 so the three "shorts" are eighth notes against the half-note hold.
    const BEETHOVEN_5TH_NOTES = [
      'G4', 'G4', 'G4', { n: 'Eb4', d: 4 }, null,
      'F4', 'F4', 'F4', { n: 'D4', d: 4 }, null,
    ];
    // Miles Davis — "So What" (Kind of Blue, 1959): D Dorian bass call,
    // Em7 chord-arpeggio response. Captures the famous two-chord shape
    // that defines the head.
    const MILES_SO_WHAT_NOTES = [
      { n: 'D4', d: 2 }, null, 'A4', 'G4', null, null, null, null,
      'E4', 'G4', 'A4', { n: 'D5', d: 2 }, null, null, null, null,
    ];
    // The Eagles — "Take It Easy" (1972) opening vocal melody: the
    // "well, I'm running down the road tryin' to loosen my load" phrase,
    // contoured around the G-major triad with a step-down on "load".
    const TAKE_IT_EASY_NOTES = [
      'G4', 'G4', 'G4', 'G4', 'G4', 'G4',
      'A4', 'G4', 'F#4', 'E4',
      { n: 'D4', d: 2 }, null,
      'E4', 'E4', 'D4', 'C4', { n: 'D4', d: 4 },
    ];
    // Jimmy Buffett — "Margaritaville" (1977) chorus opener:
    // "wastin' away again in Margaritaville", the descending D-major line.
    const MARGARITAVILLE_NOTES = [
      'D5', 'D5', 'D5',
      'C#5', 'B4',
      'A4', 'B4',
      'A4', 'G4',
      'F#4', 'E4', { n: 'D4', d: 4 },
    ];
    // Madonna — "Like a Prayer" (1989) chorus hook:
    // "life is a mystery, everyone must stand alone" — Am→F→G feel.
    const LIKE_A_PRAYER_NOTES = [
      'E5', 'E5', 'E5', 'F5',
      { n: 'E5', d: 2 }, 'D5',
      'C5', 'D5', { n: 'E5', d: 2 }, null,
      'A4', 'C5', 'D5', 'E5', { n: 'D5', d: 4 },
    ];
    function defaultStepParams(type) {
      return { type, attack: 10, decay: 100, sustain: 50, release: 1400, volume: 100, detune: 0, reverb: 0, reverbSize: 70, reverbTone: 50, delay: 0, delayTime: 250, delayFeedback: 40, delaySync: null, distortion: 0, chorus: 0, chorusFreq: 4, chorusDepth: 70, vibrato: 0, vibratoFreq: 5, vibratoDepth: 30, tremolo: 0, tremoloFreq: 5, tremoloDepth: 70, phaser: 0, phaserFreq: 0.5, phaserOctaves: 3, autoFilter: 0, autoFilterFreq: 1, autoFilterDepth: 100, autoFilterBaseFreq: 200, pingPong: 0, pingPongTime: 250, pingPongFeedback: 30, pingPongSync: null, autoPan: 0, autoPanFreq: 1, autoPanDepth: 100 };
    }
    function loadSongPreset(name) {
      let src;
      // BPM and Step Div tuned so each preset plays at a tempo that feels
      // close to the original recording rather than the early "halftime"
      // pace. Most of these now use eighth-note pulse (sub=0.5) so a 16-step
      // pattern lasts about a single bar.
      if      (name === 'vivaldi')        src = { notes: VIVALDI_SPRING_NOTES,    bpm: 140, sub: 0.5, sound: 'sawtooth' };
      else if (name === 'bach')           src = { notes: BACH_TOCCATA_NOTES,      bpm: 130, sub: 0.5, sound: 'square'   };
      else if (name === 'mozart')         src = { notes: MOZART_NACHTMUSIK_NOTES, bpm: 150, sub: 0.5, sound: 'sawtooth' };
      else if (name === 'beethoven')      src = { notes: BEETHOVEN_5TH_NOTES,     bpm: 132, sub: 0.5, sound: 'sawtooth' };
      else if (name === 'miles')          src = { notes: MILES_SO_WHAT_NOTES,     bpm: 140, sub: 0.5, sound: 'sine'     };
      else if (name === 'takeiteasy')     src = { notes: TAKE_IT_EASY_NOTES,      bpm: 138, sub: 0.5, sound: 'pluck'    };
      else if (name === 'margaritaville') src = { notes: MARGARITAVILLE_NOTES,    bpm: 100, sub: 0.5, sound: 'pluck'    };
      else if (name === 'likeaprayer')    src = { notes: LIKE_A_PRAYER_NOTES,     bpm: 116, sub: 0.5, sound: 'sawtooth' };
      else return;
      snapshotForUndo('Load ' + name);
      stopSequence();
      const params = defaultStepParams(src.sound);
      const generated = src.notes.map(n => {
        if (n == null) return { freq: null, label: '—', cellIndex: null, duration: 1, subdivision: src.sub };
        const noteName = (typeof n === 'object') ? n.n : n;
        const dur      = (typeof n === 'object') ? (n.d || 1) : 1;
        return {
          freq: Tone.Frequency(noteName).toFrequency(),
          label: noteName,
          cellIndex: null,
          sound: src.sound,
          params: { ...params },
          duration: dur,
          subdivision: src.sub,
        };
      });
      // Keep on: append the song to the current sequence; Keep off: replace
      // (original behavior). BPM / subdivision are only re-tuned to the
      // song's settings when replacing — appending should leave the user's
      // current tempo/grid alone.
      if (keepMode) {
        sequence = sequence.concat(generated);
      } else {
        sequence = generated;
        tempoInput.value = src.bpm;
        tempoSlider.value = src.bpm;
        stepSubdivision = src.sub;
        const subSel = document.getElementById('subdivision-select');
        if (subSel) subSel.value = String(src.sub);
      }
      pendingChord = [];
      insertionPoint = null;
      activeSeqIndex = null;
      refreshHoldEnabled();
      renderSequence();
      renderSavedSequences();
      document.getElementById('save-btn').disabled = false;
    }

    // Preview a bank audio entry through an HTMLAudioElement (no Tone graph needed).
    let _previewAudio = null;
    function previewSavedAudio(saved) {
      if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
      _previewAudio = new Audio(saved.audioDataUrl);
      _previewAudio.play().catch(() => {});
    }

    document.getElementById('loop-btn').addEventListener('click', () => {
      loopMode = !loopMode;
      document.getElementById('loop-btn').classList.toggle('active', loopMode);
      persistWorkspace();
    });

    // ---- Reset Audio --------------------------------------------------
    // Recovery path for the "sound trails behind chip highlight" symptom.
    // Causes are usually some mix of: AudioContext underrun on a busy
    // browser tab, voices piling up past the live cap, or a long JS-thread
    // stall pushing the scheduler past notes that then fire in a catch-up
    // burst. This button is the user-visible escape hatch — it stops
    // playback, force-disposes every tracked voice, clears pending visual
    // timers, resumes the AudioContext if it suspended, and zeros the
    // slip meter. _slipMs is driven by schedulerTick (slip = how far past
    // its intended audio time a note was when scheduled); the button's
    // .warn / .alarm classes glow when slip crosses thresholds.
    function resetAudioEngine() {
      // Force-stop regardless of sequenceTimer state — mobile sometimes
      // leaves the timer null while the worklet still has queued
      // dispatches, so gating on the timer let stuck audio survive a
      // reset.
      try { stopSequence(); } catch (e) {}
      // Wipe pending dispatches a second time defensively — stopSequence
      // already does this, but resetAudioEngine is the user's panic
      // button and being explicit here makes the contract obvious.
      try {
        if (typeof _clearAllScheduledDispatches === 'function') {
          _clearAllScheduledDispatches();
        }
      } catch (e) {}
      // Snapshot + clear the active-voice list so _stealVoice can dispose
      // each entry without re-entering through _activeVoices mutation.
      const victims = _activeVoices.splice(0, _activeVoices.length);
      victims.forEach(v => { try { _stealVoice(v); } catch (e) {} });
      // Tear down per-lane Tone.Sampler / volume / panner / FX nodes.
      // Tone.Sampler queues triggerAttackRelease calls internally —
      // when the AudioContext clock drifts behind wall clock on mobile
      // (a tab going background-then-foreground is the common cause),
      // a backed-up sampler keeps firing notes against stale audioTimes
      // long after the user expected silence. Dispose every lane bus +
      // sampler so the next press / play tick rebuilds them fresh.
      // getLaneBus + getOrCreateLaneSampler are lazy-init so the next
      // tap reuses the existing slow path with no setup cost beyond a
      // single Tone.Sampler constructor.
      try {
        if (typeof disposeAllLaneAudio === 'function' && Array.isArray(lanes)) {
          disposeAllLaneAudio(lanes);
        }
      } catch (e) {}
      // Cancel any events Tone has scheduled directly against its
      // context. tonejs ≥14 exposes cancel on the context (drops every
      // scheduled event at audioTime ≥ now), which evicts anything we
      // queued outside the worklet path.
      try {
        if (typeof Tone !== 'undefined' && Tone.context
            && typeof Tone.context.cancel === 'function') {
          Tone.context.cancel(0);
        }
      } catch (e) {}
      try { clearVisualTimers(); } catch (e) {}
      try {
        const ac = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
          ? Tone.context.rawContext : null;
        if (ac && ac.state === 'suspended') ac.resume();
      } catch (e) {}
      _playBaseTime = 0;
      _playOffsetSec = 0;
      _slipMs = 0;
      refreshAudioResetUI();
      // Visible confirmation — the button used to do its work silently,
      // which made it feel like nothing happened when stuck audio took
      // a second or two to clear.
      try {
        if (typeof showHistoryToast === 'function') {
          showHistoryToast('Audio reset.');
        }
      } catch (e) {}
    }
    function refreshAudioResetUI() {
      const btn = document.getElementById('audio-reset-btn');
      if (!btn) return;
      const slip = Math.round(_slipMs);
      const voices = _activeVoices.length;
      btn.classList.toggle('warn',  slip >= SLIP_WARN_MS  && slip < SLIP_ALARM_MS);
      btn.classList.toggle('alarm', slip >= SLIP_ALARM_MS);
      btn.title = `Reset audio engine — slip ${slip} ms, ${voices}/${VOICE_CAP} voices. `
                + `Click to dispose stuck voices and re-sync.`;
    }
    document.getElementById('audio-reset-btn')?.addEventListener('click', resetAudioEngine);
    refreshAudioResetUI();

    // ---- Drift button (Poly only) -------------------------------------
    // Picks a millisecond factor for the active lane and applies it on
    // every loop wrap, so iteration N is delayed by factor × N. Clicking
    // a drifting lane's button clears the drift and re-syncs the lane
    // at the next iteration boundary. Each lane carries its own factor,
    // so multiple lanes can drift by different amounts.
    document.getElementById('drift-btn')?.addEventListener('click', () => {
      const lane = (activeLaneIdx >= 0 && activeLaneIdx < lanes.length) ? lanes[activeLaneIdx] : null;
      if (!lane) return;
      // State C → A: Reset. Drop offset entirely and re-sync the live
      // stream (if any) at its next iteration boundary.
      if (lane.driftLocked) {
        lane.driftLocked = false;
        lane.driftOffsetSec = 0;
        lane.driftMs = 0;
        const stream = _schedStreams.find(s => s.laneIdx === activeLaneIdx);
        if (stream) stream.pendingClearDrift = true;
        renderSequence();
        refreshDriftBtn();
        if (typeof persistWorkspace === 'function') persistWorkspace();
        return;
      }
      // State B → C: Lock. Capture the current accumulated drift on
      // the live stream (or the persisted offset if not playing) so
      // future plays start with the same lag, then stop adding more.
      if (Number.isFinite(lane.driftMs) && lane.driftMs > 0) {
        const stream = _schedStreams.find(s => s.laneIdx === activeLaneIdx);
        const liveOffset = stream ? (stream.driftAccumSec || 0) : 0;
        lane.driftOffsetSec = liveOffset || (lane.driftOffsetSec || 0);
        lane.driftLocked = true;
        lane.driftMs = 0;
        renderSequence();
        refreshDriftBtn();
        if (typeof persistWorkspace === 'function') persistWorkspace();
        return;
      }
      // State A → B: prompt for factor and start drifting.
      const raw = prompt(`Drift factor for lane ${lane.name} (ms per iteration). Iteration N will be delayed by factor × N.`, '10');
      if (raw == null) return;
      const ms = parseFloat(raw);
      if (!Number.isFinite(ms) || ms <= 0) return;
      lane.driftMs = ms;
      lane.driftLocked = false;
      const stream = _schedStreams.find(s => s.laneIdx === activeLaneIdx);
      if (stream) stream.pendingClearDrift = false;
      renderSequence();
      refreshDriftBtn();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    });

    // ---- Merge lanes (Riff menu) -------------------------------------
    // Combines the active lane with another lane into a NEW lane whose
    // steps are position-by-position chord merges of the two sources.
    // Both source lanes are kept and muted so the user doesn't lose
    // their work and the merged lane plays cleanly without doubling.
    // The new lane inherits the active lane's voice so playback uses a
    // familiar instrument out of the gate.
    function refreshMergeLanesBtn() {
      const btn = document.getElementById('merge-lanes-btn');
      if (!btn) return;
      const hasSiblings = Array.isArray(lanes) && lanes.length >= 2;
      const atCap = Array.isArray(lanes) && lanes.length >= 8;
      btn.disabled = !hasSiblings || atCap;
      if (atCap) {
        btn.title = 'Merge unavailable — already at the 8-lane cap.';
      } else if (!hasSiblings) {
        btn.title = 'Merge needs at least 2 lanes — add another lane first.';
      } else {
        const active = (activeLaneIdx >= 0 && activeLaneIdx < lanes.length)
          ? lanes[activeLaneIdx] : null;
        btn.title = active
          ? `Merge lane ${active.name} with another lane into a new chord-step lane (sources muted).`
          : 'Merge the active lane with another lane into a new chord-step lane (sources muted).';
      }
    }
    // Combine two same-position steps into a single chord step. Rests
    // contribute nothing; subsequence steps pass through whole (mixing
    // a sub's children into a chord doesn't have a clean musical
    // interpretation). Returns a fresh step — never mutates inputs.
    // Merge two lanes on an ABSOLUTE timeline (ticks, 96/quarter — handles
    // binary divs down to 1/32 and triplets). Each lane's steps are flattened
    // to note events with exact start/end ticks (chords → simultaneous events,
    // subsequences → their sub-steps at the right offsets, rests → gaps). The
    // union of every event boundary slices the timeline into segments; each
    // segment becomes one step holding the notes sounding in it (single, or a
    // chord when 2+ overlap), with its duration = the segment length. So a note
    // that starts midway through another's sustain lands in its own segment at
    // exactly that point, and both lanes' step-div resolutions survive (the
    // segment grid is the GCD of all boundaries). Sustained notes re-articulate
    // at each new boundary — the mono step model can't overlap independent
    // envelopes, so an onset is added wherever the other lane changes.
    const _MERGE_TPQ = 96;
    function _laneToTickEvents(steps) {
      const events = [];
      const ticksOf = (s) => Math.max(1, Math.round(stepLengthFactor(s) * 4 * _MERGE_TPQ));
      const push = (n, start, len) => {
        if (n && Number.isFinite(n.freq)) events.push({
          start, end: start + len,
          note: { freq: n.freq, label: n.label, cellIndex: n.cellIndex, sound: n.sound, params: n.params ? { ...n.params } : {} },
        });
      };
      const walk = (s, start) => {
        if (!s) return 0;
        if (s.isSub && Array.isArray(s.subSteps)) {
          let t = start; s.subSteps.forEach(ss => { t += walk(ss, t); }); return t - start;
        }
        const len = ticksOf(s);
        if (Array.isArray(s.chord)) s.chord.forEach(n => push(n, start, len));
        else if (Number.isFinite(s.freq)) push(s, start, len); // single note (rest: freq null → skipped)
        return len;
      };
      let t = 0;
      (steps || []).forEach(s => { t += walk(s, t); });
      return { events, total: t };
    }
    const _mergeGcd = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) { [x, y] = [y, x % y]; } return x; };
    function _mergeLaneSteps(stepsA, stepsB, squareUp) {
      const A = _laneToTickEvents(stepsA), B = _laneToTickEvents(stepsB);
      let evA = A.events, evB = B.events, total = Math.max(A.total, B.total);
      // Square up: repeat each lane to their common multiple length so both
      // end together (a resolving polyrhythm). A repeats lcm/la times, B
      // repeats lcm/lb times.
      if (squareUp && A.total > 0 && B.total > 0 && A.total !== B.total) {
        const g = _mergeGcd(A.total, B.total), lcm = (A.total / g) * B.total;
        const tile = (ev, period, n) => {
          const out = [];
          for (let r = 0; r < n; r++) ev.forEach(e => out.push({ start: e.start + r * period, end: e.end + r * period, note: e.note }));
          return out;
        };
        evA = tile(A.events, A.total, lcm / A.total);
        evB = tile(B.events, B.total, lcm / B.total);
        total = lcm;
      }
      const events = evA.concat(evB);
      if (total <= 0 || events.length === 0) {
        // Nothing pitched — fall back to a single rest spanning the longer lane.
        return [{ freq: null, label: '—', cellIndex: null, duration: Math.max(1, total || 1), subdivision: 0.125 }];
      }
      const bset = new Set([0, total]);
      events.forEach(e => { if (e.start >= 0 && e.start <= total) bset.add(e.start); if (e.end >= 0 && e.end <= total) bset.add(e.end); });
      const bounds = Array.from(bset).sort((a, b) => a - b);
      const _gcd = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) { [x, y] = [y, x % y]; } return x; };
      let g = 0;
      for (let k = 1; k < bounds.length; k++) g = _gcd(g, bounds[k] - bounds[k - 1]);
      if (!(g > 0)) g = _MERGE_TPQ;
      const subdivision = g / _MERGE_TPQ; // one dur unit = g ticks (model: sub=1 ⇒ a quarter)
      const out = [];
      for (let k = 0; k < bounds.length - 1; k++) {
        const t0 = bounds[k], segLen = bounds[k + 1] - t0;
        if (segLen <= 0) continue;
        const dur = Math.max(1, Math.round(segLen / g));
        const active = events.filter(e => e.start <= t0 && e.end > t0);
        // De-dupe identical pitches sounding from both lanes at once.
        const seen = new Set(); const voices = [];
        active.forEach(e => { const key = Math.round(e.note.freq * 100); if (!seen.has(key)) { seen.add(key); voices.push(e.note); } });
        if (voices.length === 0) {
          out.push({ freq: null, label: '—', cellIndex: null, duration: dur, subdivision });
        } else if (voices.length === 1) {
          const v = voices[0];
          out.push({ freq: v.freq, label: v.label, cellIndex: v.cellIndex, sound: v.sound, params: v.params, duration: dur, subdivision });
        } else {
          out.push({ freq: null, label: voices.map(v => v.label).join('·'), chord: voices.map(v => ({ ...v })), duration: dur, subdivision, params: voices[0].params ? { ...voices[0].params } : {} });
        }
      }
      return out;
    }
    // Warn that the two lanes are different lengths and offer to square them up
    // (repeat each to the common multiple so the merged lane ends cleanly).
    function _showMergeLengthDialog(srcAIdx, srcBIdx, laneA, laneB, la, lb) {
      const g = _mergeGcd(la, lb), lcm = (la / g) * lb;
      const repA = lcm / la, repB = lcm / lb;
      const beats = (t) => (t / _MERGE_TPQ);
      const fmt = (t) => { const b = beats(t); return (Math.abs(b - Math.round(b)) < 0.01 ? String(Math.round(b)) : b.toFixed(2)) + ' beat' + (Math.round(b) === 1 ? '' : 's'); };
      const nameA = laneA.name || 'A', nameB = laneB.name || 'B';
      const overlay = document.createElement('div'); overlay.className = 'sm-overlay';
      const modal = document.createElement('div'); modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Lanes are different lengths</div>
        <div style="color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.82rem;padding:2px 0 12px;line-height:1.5;">
          <b>${nameA}</b> is ${fmt(la)}, <b>${nameB}</b> is ${fmt(lb)}.<br>
          Square up so both end together? <b>${nameA}</b> repeats <b>${repA}×</b> and
          <b>${nameB}</b> repeats <b>${repB}×</b>, ending at ${fmt(lcm)}.
        </div>
        <div class="sm-footer" style="flex-wrap:wrap;gap:8px;">
          <button type="button" class="sm-preview" id="merge-len-cancel">Cancel</button>
          <button type="button" class="sm-preview" id="merge-len-asis">Merge as-is</button>
          <button type="button" class="sm-apply"   id="merge-len-square">Square up &amp; merge</button>
        </div>`;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const close = () => { try { document.body.removeChild(overlay); } catch (e) {} };
      modal.querySelector('#merge-len-cancel').addEventListener('click', close);
      modal.querySelector('#merge-len-asis').addEventListener('click', () => { close(); _doMergeLanes(srcAIdx, srcBIdx, false); });
      modal.querySelector('#merge-len-square').addEventListener('click', () => { close(); _doMergeLanes(srcAIdx, srcBIdx, true); });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }
    function _doMergeLanes(srcAIdx, srcBIdx, squareUp) {
      if (srcAIdx === srcBIdx) return;
      if (srcAIdx < 0 || srcAIdx >= lanes.length) return;
      if (srcBIdx < 0 || srcBIdx >= lanes.length) return;
      if (lanes.length >= 8) {
        try { showHistoryToast('Already at 8-lane cap.'); } catch (e) {}
        return;
      }
      const laneA = lanes[srcAIdx];
      const laneB = lanes[srcBIdx];
      if (!laneA || !laneB) return;
      // Flush `sequence` back to its lane so the merged step array
      // reads the latest edits even if the user just touched a step in
      // the active lane without triggering a lane-switch / persist.
      if (activeLaneIdx >= 0 && activeLaneIdx < lanes.length) {
        lanes[activeLaneIdx].steps = sequence;
      }
      // captureSnapshot only saves the active lane's `sequence` (not
      // the full lanes array), so an undo wouldn't cleanly reverse
      // the new lane + mute flips. Skip the snapshot to avoid leaving
      // a misleading entry in the undo stack — Drift does the same.
      const stepsA = Array.isArray(laneA.steps) ? laneA.steps : [];
      const stepsB = Array.isArray(laneB.steps) ? laneB.steps : [];
      // Different-length lanes: warn once and offer to "square up" (repeat each
      // to their common multiple so both end together). squareUp undefined =
      // first call → prompt; true/false = the user's choice → proceed.
      if (squareUp === undefined) {
        const la = _laneToTickEvents(stepsA).total, lb = _laneToTickEvents(stepsB).total;
        if (la > 0 && lb > 0 && la !== lb) {
          _showMergeLengthDialog(srcAIdx, srcBIdx, laneA, laneB, la, lb);
          return;
        }
        squareUp = false;
      }
      // Absolute-timeline merge: preserves both lanes' step-div resolution and
      // every note's exact start/stop; overlaps become chords sliced at event
      // boundaries (a midway onset lands at its real position).
      const merged = _mergeLaneSteps(stepsA, stepsB, squareUp);
      const newIdx = lanes.length;
      const newLane = _makeLane(newIdx, merged);
      // Seed the merged lane's voice from the active lane so playback
      // uses a familiar instrument straight away (the user can swap it
      // later via the voice editor like any other lane).
      const activeVoice = (lanes[activeLaneIdx] && lanes[activeLaneIdx].voice)
        ? lanes[activeLaneIdx].voice
        : (typeof _captureVoiceGlobals === 'function' ? _captureVoiceGlobals() : null);
      if (activeVoice) {
        try { newLane.voice = JSON.parse(JSON.stringify(activeVoice)); } catch (e) {}
      }
      // If playback is running, stop it first — the scheduler builds
      // _schedStreams from `lanes` only at play-start, so a mid-play
      // push won't add a stream for the new lane (silent merged lane)
      // and any already-dispatched events from the sources keep firing
      // even after we mute them (audible source lanes). Restart below
      // after the lane state settles.
      const wasPlaying = (typeof sequenceTimer !== 'undefined') && sequenceTimer !== null;
      if (wasPlaying) { try { stopSequence(); } catch (e) {} }
      lanes.push(newLane);
      laneA.muted = true;
      laneB.muted = true;
      // Grow gridRows so the new lane has a visible row and
      // _resizeLanesToGridRows won't trim it on the next sync.
      gridRows = Math.min(8, Math.max(gridRows, lanes.length));
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.value = String(gridRows);
      activateLane(newIdx);
      if (wasPlaying) {
        // Rebuild streams with the new lane present + updated mute
        // flags. Tiny pause (~one tick) but the play state continues
        // so the user keeps their flow.
        try { playSequence(); } catch (e) {}
      }
      try { showHistoryToast(`Merged ${laneA.name} + ${laneB.name} → ${newLane.name}`); } catch (e) {}
      try { refreshMergeLanesBtn(); } catch (e) {}
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _openMergeLaneMenu() {
      if (!Array.isArray(lanes) || lanes.length < 2) return;
      const others = lanes
        .map((l, i) => ({ lane: l, idx: i }))
        .filter(({ idx }) => idx !== activeLaneIdx);
      if (others.length === 0) return;
      // Modal picker — more obvious than a dropdown that gets visually
      // detached when the Riff panel collapses on the button click.
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      const activeName = (lanes[activeLaneIdx] && lanes[activeLaneIdx].name) || '?';
      modal.innerHTML = `
        <div class="sm-title">Merge lane ${activeName} with…</div>
        <div class="sm-fold-body" id="merge-lane-list" style="display:flex;flex-direction:column;gap:6px;padding-top:8px;"></div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="merge-cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const list = modal.querySelector('#merge-lane-list');
      others.forEach(({ lane, idx }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sm-wave';
        btn.textContent = `Lane ${lane.name}${lane.muted ? ' (muted)' : ''}`;
        btn.addEventListener('click', () => {
          overlay.remove();
          _doMergeLanes(activeLaneIdx, idx);
        });
        list.appendChild(btn);
      });
      modal.querySelector('#merge-cancel')?.addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }
    document.getElementById('merge-lanes-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!Array.isArray(lanes) || lanes.length < 2) {
        try { showHistoryToast('Merge needs at least 2 lanes — add another lane first.'); } catch (err) {}
        return;
      }
      if (lanes.length >= 8) {
        try { showHistoryToast('Already at the 8-lane cap.'); } catch (err) {}
        return;
      }
      try { _openMergeLaneMenu(); }
      catch (err) { console.error('[merge] open menu threw:', err); }
    });

    // Modal: ask the user whether multi-selected notes should be wrapped
    // as a chord (Stack, simultaneous) or a subsequence (Run, sequential).
    // Resolves the choice via callback so the calling code stays linear.
    function showRunStackPrompt(onPick) {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay wrap-as-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal wrap-as-modal';
      modal.innerHTML = `
        <div class="wrap-as-title">Wrap as…</div>
        <div class="wrap-as-grid">
          <button type="button" class="wrap-as-opt wrap-as-stack" id="rs-stack">
            <span class="wrap-as-glyph" aria-hidden="true">▦</span>
            <span class="wrap-as-name">Stack</span>
            <span class="wrap-as-sub">Chord — all at once</span>
          </button>
          <button type="button" class="wrap-as-opt wrap-as-run" id="rs-run">
            <span class="wrap-as-glyph" aria-hidden="true">▤</span>
            <span class="wrap-as-name">Run</span>
            <span class="wrap-as-sub">Subsequence — one after another</span>
          </button>
        </div>
        <div class="wrap-as-footer">
          <button type="button" class="wrap-as-cancel" id="rs-cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const dismiss = (choice) => {
        overlay.remove();
        if (choice != null && typeof onPick === 'function') onPick(choice);
      };
      modal.querySelector('#rs-stack').addEventListener('click', () => dismiss('stack'));
      modal.querySelector('#rs-run').addEventListener('click',   () => dismiss('run'));
      modal.querySelector('#rs-cancel').addEventListener('click', () => dismiss(null));
      // Bind the click-outside-to-dismiss handler on the next frame
      // so the click that opened this modal (the Wrap button or the
      // multi-select wrap path) can't ride its own bubble straight
      // into the overlay's dismiss handler and close the modal the
      // instant it lands. Same pattern as showStepDivPicker —
      // without this guard the modal "appears then immediately
      // disappears" for the chord-wrap flow.
      requestAnimationFrame(() => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(null); });
      });
    }

    // Modal: fork a fresh Wrap into Manual (hand-pick notes, then Close) or
    // Auto (pick a standard chord structure). Resolves 'manual' | 'auto' |
    // null via callback. Reuses the .wrap-as-* layout from the Stack/Run
    // prompt it replaces.
    function showManualAutoPrompt(onPick) {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay wrap-as-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal wrap-as-modal';
      modal.innerHTML = `
        <div class="wrap-as-title">Build wrap…</div>
        <div class="wrap-as-grid">
          <button type="button" class="wrap-as-opt" id="ma-manual">
            <span class="wrap-as-glyph" aria-hidden="true">✋</span>
            <span class="wrap-as-name">Manual</span>
            <span class="wrap-as-sub">Tap notes, then Close</span>
          </button>
          <button type="button" class="wrap-as-opt" id="ma-auto">
            <span class="wrap-as-glyph" aria-hidden="true">✨</span>
            <span class="wrap-as-name">Auto</span>
            <span class="wrap-as-sub">Pick a chord type</span>
          </button>
        </div>
        <div class="wrap-as-footer">
          <button type="button" class="wrap-as-cancel" id="ma-cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const dismiss = (choice) => {
        overlay.remove();
        if (choice != null && typeof onPick === 'function') onPick(choice);
      };
      modal.querySelector('#ma-manual').addEventListener('click', () => dismiss('manual'));
      modal.querySelector('#ma-auto').addEventListener('click',   () => dismiss('auto'));
      modal.querySelector('#ma-cancel').addEventListener('click', () => dismiss(null));
      requestAnimationFrame(() => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(null); });
      });
    }

    // Modal: pick a standard chord structure for an Auto wrap. Lists the
    // shared CHORDS catalog (Major, Minor, …). Resolves the chosen key via
    // callback; Cancel / click-outside resolves null.
    function showAutoChordPicker(onPick) {
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay wrap-auto-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal wrap-auto-modal';
      modal.innerHTML = `
        <div class="sm-title">Auto chord</div>
        <div class="wrap-auto-hint">Pick a chord shape — grid presses play it transposed to the pressed note.</div>
        <div class="wrap-auto-grid" id="wrap-auto-grid"></div>
        <div class="sm-footer"><button type="button" class="sm-preview" id="wa-cancel">Cancel</button></div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const dismiss = (key) => {
        overlay.remove();
        if (key != null && typeof onPick === 'function') onPick(key);
      };
      const grid = modal.querySelector('#wrap-auto-grid');
      const catalog = (typeof CHORDS !== 'undefined') ? CHORDS : {};
      // Musical display order — basic triads first, then 7ths, extensions.
      // (Object key order alone floats numeric keys like '7'/'9' to the top.)
      const ORDER = ['maj','min','dim','aug','sus2','sus4','maj7','7','min7',
        'dim7','m7b5','minMaj7','6','m6','6/9','add9','madd9','9','maj9','min9',
        '7sus4','7b9','7#9','7b5','7#11','11','min11','maj11','13','maj13','min13'];
      const keys = ORDER.filter(k => catalog[k])
        .concat(Object.keys(catalog).filter(k => !ORDER.includes(k)));
      keys.forEach((key) => {
        const def = catalog[key];
        if (!def || !Array.isArray(def.semis)) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wrap-auto-opt';
        btn.innerHTML =
          `<span class="wrap-auto-name">${def.label}</span>` +
          `<span class="wrap-auto-count">${def.semis.length} notes</span>`;
        btn.addEventListener('click', () => dismiss(key));
        grid.appendChild(btn);
      });
      modal.querySelector('#wa-cancel').addEventListener('click', () => dismiss(null));
      requestAnimationFrame(() => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(null); });
      });
    }

    // Build a Stack (chord) wrap from a CHORDS structure and commit it just
    // like a hand-built Close: arm wrapTemplate, save to the bank, and (with
    // Keep on) drop the root-position chord into the sequence. The chord is
    // built at the grid's root note; grid presses transpose it so the pressed
    // note becomes the chord root.
    function buildAutoWrap(chordKey) {
      const def = (typeof CHORDS !== 'undefined') ? CHORDS[chordKey] : null;
      if (!def || !Array.isArray(def.semis) || def.semis.length === 0) return;
      const base = (typeof notes !== 'undefined' && notes[0]) ? notes[0] : { freq: 261.63, label: 'C4' };
      const voices = def.semis.map(semi => {
        const f = base.freq * Math.pow(2, semi / 12);
        let label = base.label;
        try { label = Tone.Frequency(f).toNote(); } catch (e) {}
        return { freq: f, label, cellIndex: null };
      });
      const newStep = {
        chord: voices,
        label: voices.map(v => v.label).join('·'),
        duration: noteLength,
        subdivision: stepSubdivision,
      };
      if (typeof snapshotForUndo === 'function') { try { snapshotForUndo('Auto wrap'); } catch (e) {} }
      // Leave any in-progress build state behind so the auto shape stands alone.
      chordMode = false;
      pendingChord = [];
      _wrapShape = null;
      if (typeof clearWrapPendingHighlights === 'function') clearWrapPendingHighlights();
      wrapTemplate = newStep;
      try { pushWrapToBank(newStep); } catch (e) { console.warn('pushWrapToBank failed:', e); }
      if (keepMode) {
        addToSequence(newStep);
        if (typeof maybePromptStepDiv === 'function') {
          const _toPrompt = newStep;
          setTimeout(() => { try { maybePromptStepDiv(_toPrompt); } catch (e) {} }, 0);
        }
      }
      refreshWrapVisuals();
      renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    document.getElementById('chord-btn').addEventListener('click', () => {
      // Multi-select grouping: when 2+ steps are selected, fold them into a
      // single chord/sub at the earliest selected slot and drop the rest.
      // This wins over the toggle behavior so the user doesn't accidentally
      // enter chord-mode while their intent is to combine an existing
      // selection. With 2+ voices we PROMPT for Stack vs Run instead of
      // inferring from gridMode — the multi-select wrap is the inverse of
      // the dissolve-sub flow below, so the user gets to pick the shape
      // each time without having to flip the Spell/Run/Stack banner first.
      if (multiSelectMode && selectedStepRefs.length >= 2) {
        const indices = selectedStepRefs
          .map(ref => sequence.indexOf(ref))
          .filter(i => i >= 0)
          .sort((a, b) => a - b);
        if (indices.length >= 2) {
          const voices = [];
          const seen = new Set();
          const pushVoice = (n) => {
            if (n == null || n.freq == null || seen.has(n.freq)) return;
            seen.add(n.freq);
            voices.push({
              freq: n.freq,
              label: n.label,
              cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
              sound: n.sound,
              params: n.params ? { ...n.params } : undefined,
            });
          };
          indices.forEach(i => {
            const s = sequence[i];
            if (!s || s.isSub) return;
            if (Array.isArray(s.chord)) s.chord.forEach(pushVoice);
            else                        pushVoice(s);
          });
          if (voices.length === 0) return;
          const commitWrap = (shape) => {
            snapshotForUndo('Wrap');
            stopSequence();
            const firstIdx  = indices[0];
            const firstStep = sequence[firstIdx];
            const baseDur = firstStep.duration || 1;
            const baseSub = (firstStep.subdivision != null) ? firstStep.subdivision : stepSubdivision;
            let newStep;
            if (voices.length === 1) {
              newStep = { ...voices[0], duration: baseDur, subdivision: baseSub };
            } else if (shape === 'run') {
              newStep = {
                isSub: true,
                subSteps: voices.map(v => ({
                  freq: v.freq, label: v.label,
                  cellIndex: v.cellIndex,
                  sound: v.sound,
                  params: v.params ? { ...v.params } : undefined,
                  duration: 1,
                  subdivision: baseSub,
                })),
                label: '▤',
                duration: baseDur,
                subdivision: 1,
              };
            } else {
              newStep = {
                chord: voices,
                label: voices.map(n => n.label).join('·'),
                duration: baseDur,
                subdivision: baseSub,
              };
            }
            indices.slice(1).reverse().forEach(i => sequence.splice(i, 1));
            sequence[firstIdx] = newStep;
            selectedStepRefs = [newStep];
            insertionPoint = null;
            pendingChord = [];
            wrapTemplate = newStep;
            multiSelectMode = false;
            const multiCb = document.getElementById('multi-select-toggle');
            if (multiCb) multiCb.checked = false;
            // Save the just-committed wrap to the bank so the user can
            // recall it later. pushWrapToBank also sets activeWrapBankId
            // → the new chip gets the active highlight automatically.
            try { pushWrapToBank(newStep); } catch (e) { console.warn('pushWrapToBank failed:', e); }
            refreshWrapVisuals();
            renderSequence();
            if (typeof persistWorkspace === 'function') persistWorkspace();
          };
          // Single-voice case: no shape ambiguity, just commit.
          if (voices.length === 1) { commitWrap('stack'); return; }
          showRunStackPrompt(commitWrap);
          return;
        }
      }

      // Unwrap: button shows "Unwrap" when there's a committed wrapTemplate
      // and we're not in build mode. Two behaviours:
      //   (a) If the wrapTemplate is the currently-SELECTED sub step in
      //       the sequence, DISSOLVE it: splice the step out and replace
      //       in place with its constituent subSteps. All resulting steps
      //       are selected (multi-select on) so the inverse "Wrap" press
      //       re-groups them via the multi-select branch above.
      //   (b) Otherwise just clear the wrapTemplate (legacy unwrap).
      if (wrapTemplate && !chordMode) {
        // Dissolve path: when a sub step in the sequence is the current
        // selection AND a wrap is active (chip click captured it), Unwrap
        // splits the sub in place. The chip-click handler stored a CLONE
        // in wrapTemplate, so identity won't match the selected step —
        // check via the sequence array instead.
        const selectedSub = selectedStepRefs[0];
        const idx = (selectedSub && selectedSub.isSub && Array.isArray(selectedSub.subSteps))
          ? sequence.indexOf(selectedSub) : -1;
        if (idx >= 0) {
          snapshotForUndo('Dissolve subsequence');
          // Splice in the constituent steps. Clone to break refs.
          const dissolved = selectedSub.subSteps.map(s => ({
            ...s,
            params: s.params ? { ...s.params } : undefined,
          }));
          sequence.splice(idx, 1, ...dissolved);
          // Select all the new chips and arm multi-select so the next
          // Wrap press re-groups them via the multi-select branch.
          selectedStepRefs = dissolved.slice();
          multiSelectMode = true;
          const multiCb = document.getElementById('multi-select-toggle');
          if (multiCb) multiCb.checked = true;
          wrapTemplate = null;
          activeWrapBankId = null;
          pendingChord = [];
          clearWrapPendingHighlights();
          refreshWrapVisuals();
          renderWrapBank();
          renderSequence();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          return;
        }
        wrapTemplate = null;
        activeWrapBankId = null;
        pendingChord = [];
        clearWrapPendingHighlights();
        refreshWrapVisuals();
        renderWrapBank();
        renderSequence();
        return;
      }

      // Entering a fresh wrap: fork Manual vs Auto. Manual is the classic
      // hand-built flow — default the shape to Stack (chord) and enter build
      // mode; the user can still flip to Run via the Wrap Edit menu. Auto
      // pops a chord-structure picker and commits the chosen chord straight
      // away. Cancel closes without entering chord mode.
      if (!chordMode) {
        showManualAutoPrompt((choice) => {
          if (choice === 'manual') {
            _wrapShape = 'stack';
            chordMode = true;
            refreshWrapVisuals();
          } else if (choice === 'auto') {
            showAutoChordPicker((chordKey) => { if (chordKey) buildAutoWrap(chordKey); });
          }
        });
        return;
      }

      // Exiting an active wrap — commit accumulated notes (if any) using
      // the shape picked at entry. The gridMode fallback handles any
      // state-restore path that re-enters chordMode without going
      // through the picker.
      chordMode = false;
      refreshWrapVisuals();
      clearWrapPendingHighlights();
      if (pendingChord.length > 0) {
        const useRun = (_wrapShape === 'run') || (_wrapShape == null && gridMode === 'arpeggio');
        const useSet = (_wrapShape === 'set');
        let newStep;
        if (useSet) {
          // SET: the collected notes become a variance pool the step cycles
          // through across loop passes (first note is the step's primary).
          const notes = pendingChord.map(n => ({
            freq: n.freq, label: n.label, cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
            sound: n.sound, params: n.params ? { ...n.params } : undefined,
          }));
          newStep = Object.assign({}, notes[0], {
            duration: noteLength, subdivision: stepSubdivision,
            variance: { mode: 'linear', itersPerVariant: 1, randomEachIter: false, notes },
          });
        } else if (useRun) {
          const subSteps = pendingChord.map(n => ({
            freq: n.freq,
            label: n.label,
            cellIndex: n.cellIndex,
            sound: n.sound,
            params: n.params ? { ...n.params } : undefined,
            duration: 1,
            subdivision: stepSubdivision,
          }));
          newStep = {
            isSub: true,
            subSteps,
            label: '▤',
            duration: noteLength,
            subdivision: 1,
          };
        } else {
          const label = pendingChord.map(n => n.label).join('·');
          newStep = { chord: [...pendingChord], label, duration: noteLength, subdivision: stepSubdivision };
        }
        wrapTemplate = newStep;
        // Mirror the multi-select commit path: every freshly closed
        // Wrap lands in the bank for later recall. activeWrapBankId is
        // set by pushWrapToBank so the new chip lights up.
        try { pushWrapToBank(newStep); } catch (e) { console.warn('pushWrapToBank failed:', e); }
        if (keepMode) {
          addToSequence(newStep);
          // Mirror the Keep-flow note-add prompt: after a wrap commits
          // into the sequence with Keep on, ask the user to pick a
          // step-div size for the new step (or apply the session-lock
          // value if one's set). Without this, wrapped chord / sub
          // steps inherit whatever stepSubdivision was active and the
          // user has to retune them via the step Edit menu instead.
          //
          // Defer the prompt to the next macrotask so the Wrap-off
          // click that triggered the commit is fully done bubbling
          // before the modal mounts — otherwise the same gesture's
          // follow-up events (the iOS-synthesised second click,
          // pointermove on touchend, etc.) can land on the freshly-
          // mounted overlay and close it before the user can pick.
          if (typeof maybePromptStepDiv === 'function') {
            const _toPrompt = newStep;
            setTimeout(() => { try { maybePromptStepDiv(_toPrompt); } catch (e) {} }, 0);
          }
        }
        pendingChord = [];
        refreshWrapVisuals();
        renderSequence();
      } else {
        // Wrap toggled off with no notes accumulated → clear any
        // existing template so cell clicks fall back to the active
        // note-mode handlers.
        pendingChord = [];
        wrapTemplate = null;
        activeWrapBankId = null;
        refreshWrapVisuals();
        renderWrapBank();
        renderSequence();
      }
      _wrapShape = null;
    });

    // ---- Wrap Edit menu ------------------------------------------------
    // Pulls together the in-flight-wrap operations the user needs without
    // having to unwrap-and-recommit: invert the voicing up/down, switch
    // the wrap's shape between chord (Stack) and subsequence (Run), and
    // pop the existing step editor on the wrap's contents.

    // Returns the live note list for the active wrap, plus a tag that
    // tells the caller which structure it came from so callers can refresh
    // the right surface. Pending (chordMode in-progress) and committed
    // chord wraps share the chord-style invert math; sub wraps invert
    // their subSteps array directly.
    function _activeWrapNoteList() {
      if (chordMode && Array.isArray(pendingChord) && pendingChord.length > 0) {
        return { kind: 'pending', notes: pendingChord };
      }
      if (wrapTemplate) {
        if (wrapTemplate.variance && Array.isArray(wrapTemplate.variance.notes)) {
          return { kind: 'set', notes: wrapTemplate.variance.notes };
        }
        if (Array.isArray(wrapTemplate.chord)) {
          return { kind: 'chord', notes: wrapTemplate.chord };
        }
        if (wrapTemplate.isSub && Array.isArray(wrapTemplate.subSteps)) {
          return { kind: 'sub', notes: wrapTemplate.subSteps };
        }
      }
      return null;
    }
    function _wrapNoteHasFreq(n) { return n && Number.isFinite(n.freq) && n.freq > 0; }
    // Invert up: lowest note jumps an octave above the current top and the
    // previous lowest disappears. Mutates the passed array in place so
    // wrapTemplate / pendingChord references stay valid.
    function _invertNotesUp(notes) {
      if (!Array.isArray(notes) || notes.length < 2) return false;
      const playable = notes.filter(_wrapNoteHasFreq);
      if (playable.length < 2) return false;
      const sorted = [...notes].sort((a, b) => (a.freq || 0) - (b.freq || 0));
      const lowest = sorted.find(_wrapNoteHasFreq);
      if (!lowest) return false;
      const newFreq = lowest.freq * 2;
      let newLabel = lowest.label;
      try { newLabel = Tone.Frequency(newFreq).toNote(); } catch (e) {}
      const newTop = {
        ...lowest,
        freq:      newFreq,
        label:     newLabel,
        cellIndex: null,
        params:    lowest.params ? { ...lowest.params } : undefined,
      };
      // Rewrite the array in place: drop the original lowest, append
      // newTop. Re-sort so the result stays freq-ascending — keeps
      // playback ordering consistent with the visual readout.
      const next = sorted.filter(n => n !== lowest);
      next.push(newTop);
      next.sort((a, b) => (a.freq || 0) - (b.freq || 0));
      notes.length = 0;
      next.forEach(n => notes.push(n));
      return true;
    }
    function _invertNotesDown(notes) {
      if (!Array.isArray(notes) || notes.length < 2) return false;
      const playable = notes.filter(_wrapNoteHasFreq);
      if (playable.length < 2) return false;
      const sorted = [...notes].sort((a, b) => (a.freq || 0) - (b.freq || 0));
      const highest = [...sorted].reverse().find(_wrapNoteHasFreq);
      if (!highest) return false;
      const newFreq = highest.freq / 2;
      let newLabel = highest.label;
      try { newLabel = Tone.Frequency(newFreq).toNote(); } catch (e) {}
      const newBottom = {
        ...highest,
        freq:      newFreq,
        label:     newLabel,
        cellIndex: null,
        params:    highest.params ? { ...highest.params } : undefined,
      };
      const next = sorted.filter(n => n !== highest);
      next.unshift(newBottom);
      next.sort((a, b) => (a.freq || 0) - (b.freq || 0));
      notes.length = 0;
      next.forEach(n => notes.push(n));
      return true;
    }
    // After invert, the wrapTemplate's display label needs to track the
    // new voicing so the Keep readout / sequence chip stay accurate.
    function _refreshWrapLabel() {
      if (!wrapTemplate) return;
      if (Array.isArray(wrapTemplate.chord)) {
        wrapTemplate.label = wrapTemplate.chord.map(n => n.label).join('·');
      }
      // Sub wraps keep their "▤" badge — the subStep labels render
      // separately when the sub-chip expands.
    }
    function invertActiveWrap(direction) {
      const ref = _activeWrapNoteList();
      if (!ref) return;
      const ok = (direction > 0) ? _invertNotesUp(ref.notes) : _invertNotesDown(ref.notes);
      if (!ok) return;
      snapshotForUndo(direction > 0 ? 'Invert wrap up' : 'Invert wrap down');
      _refreshWrapLabel();
      refreshWrapVisuals();
      if (typeof syncActiveWrapToBank === 'function') syncActiveWrapToBank();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Convert wrapTemplate between chord (simultaneous) and sub
    // (sequential) shapes in place. Pending (uncommitted) wraps are
    // controlled by gridMode at commit time — toggle a flag there so
    // the next Close lands in the chosen shape.
    // The active wrap's current shape: stack (chord), run (sub), or set
    // (variance pool). Works on a committed wrapTemplate or a pending build.
    function _wrapCurrentShape() {
      if (wrapTemplate) {
        if (wrapTemplate.variance && Array.isArray(wrapTemplate.variance.notes)) return 'set';
        if (wrapTemplate.isSub) return 'run';
        return 'stack';
      }
      if (chordMode) {
        if (_wrapShape === 'set') return 'set';
        if (_wrapShape === 'run' || (_wrapShape == null && gridMode === 'arpeggio')) return 'run';
        return 'stack';
      }
      return 'stack';
    }
    // Set the active wrap to a specific shape.
    function setWrapShape(target) {
      if (wrapTemplate) {
        snapshotForUndo('Wrap shape');
        wrapTemplate = _wrapStepToShape(wrapTemplate, target);
        refreshWrapVisuals();
        if (typeof syncActiveWrapToBank === 'function') syncActiveWrapToBank();
        if (typeof persistWorkspace === 'function') persistWorkspace();
        return;
      }
      if (chordMode) {
        _wrapShape = target;            // commit path reads this on Close
        refreshWrapVisuals();
      }
    }
    // Cycle Stack → Run → Set → Stack. (Bound to the Wrap Edit "Shape" button.)
    function toggleWrapRunStack() {
      const order = ['stack', 'run', 'set'];
      const cur = _wrapCurrentShape();
      setWrapShape(order[(Math.max(0, order.indexOf(cur)) + 1) % order.length]);
    }
    function _wrapIsSet() {
      if (wrapTemplate) return !!(wrapTemplate.variance && Array.isArray(wrapTemplate.variance.notes));
      return chordMode && _wrapShape === 'set';
    }
    function _wrapIsSubLike() {
      if (chordMode) return _wrapShape === 'run' || (_wrapShape == null && gridMode === 'arpeggio');
      return !!(wrapTemplate && wrapTemplate.isSub);
    }
    // Open the existing step editor on the wrap by parking a deep copy
    // of wrapTemplate at the end of `sequence` (flagged _wrapEditing so
    // renderSequence skips drawing a chip for it). When the editor's
    // overlay is removed, copy any edits back to wrapTemplate and
    // unstash. Sub-wraps that don't have a chord/freq fall through to
    // the note editor on the first subStep — a constraint of the
    // existing editor, not this code.
    // Per-note wrap editor. Cloned from the step editor's Note / Sound
    // fields but reshaped around the wrap's structure: a chord wrap has
    // one tab per chord voice, a subsequence wrap has one tab per sub-
    // step, a single-note wrap has one tab. Each tab is its own self-
    // contained note editor (pitch + octave + wave + ADSR + vol/tune/pan)
    // operating on a working copy; Save commits the working copies back
    // to wrapTemplate, Cancel discards.
    function openWrapEditor() {
      if (!wrapTemplate) return;
      let notes, kind;
      if (Array.isArray(wrapTemplate.chord)) {
        notes = wrapTemplate.chord.map(n => ({
          ...n,
          params: n.params ? { ...n.params } : {},
        }));
        kind = 'chord';
      } else if (wrapTemplate.isSub && Array.isArray(wrapTemplate.subSteps)) {
        notes = wrapTemplate.subSteps.map(s => ({
          ...s,
          params: s.params ? { ...s.params } : {},
        }));
        kind = 'sub';
      } else {
        notes = [{
          ...wrapTemplate,
          params: wrapTemplate.params ? { ...wrapTemplate.params } : {},
        }];
        kind = 'single';
      }
      if (notes.length === 0) return;
      // activeNoteIdx === -1 selects the wrap-level "All" tab (edits the
      // wrap's own override tone); 0..n-1 select individual notes.
      let activeNoteIdx = 0;
      // Wrap-level override working state (committed to wrapTemplate on Save).
      let wrapOverrideWorking = !!wrapTemplate.wrapToneOverride;
      let wrapToneWorking = wrapTemplate.wrapToneParams ? { ...wrapTemplate.wrapToneParams } : null;
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay wrap-notes-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal wrap-notes-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const _parseOct = (lbl) => {
        const m = (lbl || '').match(/(-?\d+)$/);
        return m ? parseInt(m[1], 10) : baseOctave;
      };
      const OCT_MIN = 0, OCT_MAX = 8;
      const notesForOctaveAt = (oct) => {
        const out = [];
        for (let i = 0; i < 12; i++) {
          const semi = rootIdx + i;
          const noteIdx = semi % 12;
          const octaveNum = oct + Math.floor(semi / 12);
          const midi = 12 * (octaveNum + 1) + noteIdx;
          const freq = masterFreqA * Math.pow(2, (midi - 69) / 12);
          out.push({ freq, label: CHROMATIC[noteIdx] + octaveNum });
        }
        return out;
      };

      // The grid's current (master-lane) tone — what a non-overridden note
      // plays. Used to populate the disabled controls so they show the real
      // sound, and as the starting point when the user flips Override on.
      const masterToneParams = () =>
        (typeof cellParams !== 'undefined' && cellParams[0]) ? cellParams[0] : null;
      const render = () => {
        const master = masterToneParams();
        const onWrapTab = (activeNoteIdx === -1);
        // `n` is the per-note working copy on note tabs; null on the wrap
        // tab. `p` is whichever params object the Sound controls edit, and
        // `overridden` whether those controls are active.
        let n = null, p, overridden;
        if (onWrapTab) {
          overridden = wrapOverrideWorking;
          // Off → mirror the master tone so the disabled controls show what
          // plays and enabling starts from it. On → edit the wrap's own tone.
          if (!overridden) {
            wrapToneWorking = master ? { ...master } : (wrapToneWorking || {});
          } else if (!wrapToneWorking) {
            wrapToneWorking = master ? { ...master } : {};
          }
          p = wrapToneWorking;
        } else {
          n = notes[activeNoteIdx];
          overridden = !!n.toneOverride;
          if (!n.params) n.params = {};
          // A non-overridden note follows the wrap-level tone when that
          // override is on, otherwise the master tone. Mirror that base into
          // the working copy so the (disabled) controls show what will play
          // and so enabling the per-note override starts from it.
          const base = wrapOverrideWorking ? wrapToneWorking : master;
          if (!overridden && base) {
            n.params = { ...base };
            n.sound = base.type || n.sound;
          }
          p = n.params;
        }
        // Fill defaults so sliders always have a starting value.
        if (!Number.isFinite(p.attack))  p.attack  = 10;
        if (!Number.isFinite(p.decay))   p.decay   = 100;
        if (!Number.isFinite(p.sustain)) p.sustain = 50;
        if (!Number.isFinite(p.release)) p.release = 1400;
        if (!Number.isFinite(p.volume))  p.volume  = 100;
        if (!Number.isFinite(p.detune))  p.detune  = 0;
        if (!Number.isFinite(p.pan))     p.pan     = 0;
        if (!p.type) p.type = (n && n.sound) || (master && master.type) || 'sine';

        // "All" tab edits the wrap-level override tone; the rest are notes.
        const tabsHtml =
          `<button type="button" class="wn-tab${onWrapTab ? ' active' : ''}" data-idx="-1" title="Wrap-level tone — applies to every note that doesn't have its own override">All</button>` +
          notes.map((nn, i) =>
            `<button type="button" class="wn-tab${i === activeNoteIdx ? ' active' : ''}" data-idx="${i}">${(nn.label || ('Note ' + (i+1)))}</button>`
          ).join('');
        const titleLabel = kind === 'chord' ? 'chord' : (kind === 'sub' ? 'subsequence' : 'note');
        // Step Div section only makes sense for subsequence wraps —
        // each subStep has its own subdivision controlling its slice
        // of the run's cadence. Chord wraps share one subdivision via
        // the parent step (all voices fire simultaneously), and single-
        // note wraps don't need a per-note picker either.
        const stepDivHtml = (!onWrapTab && kind === 'sub') ? `
          <details class="sm-fold">
            <summary>Step Div</summary>
            <div class="sm-fold-body">
              <div class="sm-waves" id="wn-stepdiv-row"></div>
            </div>
          </details>` : '';
        // The wrap-level tab has no pitch of its own — it only carries a tone.
        const noteFoldHtml = onWrapTab ? '' : `
          <details class="sm-fold" open>
            <summary>Note</summary>
            <div class="sm-fold-body">
              <div class="sm-section-label" style="margin-top:0;">Octave</div>
              <div class="sm-waves" id="wn-octave-picker"></div>
              <div class="sm-section-label">Pitch</div>
              <div class="sm-waves" id="wn-note-picker"></div>
            </div>
          </details>`;
        // Sound-fold copy depends on which target is selected.
        const overrideLabel = onWrapTab ? 'Override master tone (whole wrap)' : 'Override master tone (this note)';
        const overrideHint = onWrapTab
          ? (overridden
              ? 'The whole wrap uses this tone instead of the master. Notes with their own override still win.'
              : 'Following the master tone. Enable to give the whole wrap its own tone.')
          : (overridden
              ? 'This note keeps its own tone — wrap and master tone changes won’t affect it.'
              : (wrapOverrideWorking
                  ? 'Following the wrap-level tone (set on the All tab). Enable to override just this note.'
                  : 'Following the master tone. Enable to give this note its own tone.'));
        // Preserve which folds are open across re-render (tab switch /
        // override toggle) so the panel doesn't collapse under the user.
        const _prevFoldOpen = {};
        modal.querySelectorAll('details.sm-fold').forEach(d => {
          const k = d.querySelector('summary')?.textContent || '';
          _prevFoldOpen[k] = d.open;
        });
        modal.innerHTML = `
          <div class="sm-title">Edit wrap ${titleLabel}</div>
          <div class="wn-tabs">${tabsHtml}</div>
          ${noteFoldHtml}
          ${stepDivHtml}
          <details class="sm-fold"${onWrapTab ? ' open' : ''}>
            <summary>Sound</summary>
            <div class="sm-fold-body">
              <label class="wn-tone-override"><input type="checkbox" id="wn-tone-override" ${overridden ? 'checked' : ''} /> ${overrideLabel}</label>
              <div class="wn-tone-hint">${overrideHint}</div>
              <div id="wn-sound-controls"${overridden ? '' : ' class="wn-controls-disabled"'}>
                <div class="sm-waves" id="wn-wave-row" style="margin-bottom:14px;"></div>
                <div class="sm-param"><div class="sm-param-row">Attack <span class="sm-val" id="wn-atk-v">${p.attack} ms</span></div><input type="range" id="wn-atk" min="1" max="500" value="${p.attack}" /></div>
                <div class="sm-param"><div class="sm-param-row">Decay <span class="sm-val" id="wn-dec-v">${p.decay} ms</span></div><input type="range" id="wn-dec" min="10" max="1000" value="${p.decay}" /></div>
                <div class="sm-param"><div class="sm-param-row">Sustain <span class="sm-val" id="wn-sus-v">${p.sustain}%</span></div><input type="range" id="wn-sus" min="0" max="100" value="${p.sustain}" /></div>
                <div class="sm-param"><div class="sm-param-row">Release <span class="sm-val" id="wn-rel-v">${p.release} ms</span></div><input type="range" id="wn-rel" min="100" max="3000" value="${p.release}" /></div>
                <div class="sm-param"><div class="sm-param-row">Volume <span class="sm-val" id="wn-vol-v">${p.volume}%</span></div><input type="range" id="wn-vol" min="0" max="100" value="${p.volume}" /></div>
                <div class="sm-param"><div class="sm-param-row">Tune <span class="sm-val" id="wn-tune-v">${p.detune} ¢</span></div><input type="range" id="wn-tune" min="-100" max="100" value="${p.detune}" /></div>
                <div class="sm-param"><div class="sm-param-row">Pan <span class="sm-val" id="wn-pan-v">${p.pan === 0 ? 'C' : (p.pan < 0 ? 'L' : 'R') + Math.abs(p.pan)}</span></div><input type="range" id="wn-pan" min="-100" max="100" value="${p.pan}" /></div>
              </div>
            </div>
          </details>
          <div class="sm-footer">
            <button type="button" class="sm-preview" id="wn-cancel">Cancel</button>
            <button type="button" class="sm-apply" id="wn-save">Save</button>
          </div>
        `;
        modal.querySelectorAll('details.sm-fold').forEach(d => {
          const k = d.querySelector('summary')?.textContent || '';
          if (k in _prevFoldOpen) d.open = _prevFoldOpen[k];
          // The wrap tab only has the Sound fold — keep it open so its
          // controls are visible even if Sound was collapsed on a note tab.
          if (onWrapTab && k === 'Sound') d.open = true;
        });

        // Tabs — switch active note (working copies retain their edits).
        // -1 is the wrap-level "All" tab.
        modal.querySelectorAll('.wn-tab').forEach(t => {
          t.addEventListener('click', () => {
            const i = parseInt(t.dataset.idx, 10);
            if (i === -1 || (Number.isFinite(i) && i >= 0 && i < notes.length)) {
              activeNoteIdx = i;
              render();
            }
          });
        });

        // Octave + pitch pickers — only on note tabs (the wrap tab is tone-
        // only, no pitch).
        if (!onWrapTab) {
        const octavePicker = modal.querySelector('#wn-octave-picker');
        const notePicker   = modal.querySelector('#wn-note-picker');
        let octavePickerCurrent = Math.max(OCT_MIN, Math.min(OCT_MAX, _parseOct(n.label)));
        const renderPitchRow = () => {
          notePicker.innerHTML = '';
          const octNotes = notesForOctaveAt(octavePickerCurrent);
          octNotes.forEach((nn) => {
            const btn = document.createElement('button');
            btn.className = 'sm-wave' + (Number.isFinite(n.freq) && Math.abs(nn.freq - n.freq) / nn.freq < 0.001 ? ' active' : '');
            btn.textContent = nn.label;
            btn.addEventListener('click', () => {
              n.freq = nn.freq;
              n.label = nn.label;
              const gridIdx = (typeof _findCellIdxForFreq === 'function') ? _findCellIdxForFreq(nn.freq) : -1;
              n.cellIndex = (gridIdx >= 0) ? gridIdx : null;
              // Update the tab label to match the new pitch.
              const tab = modal.querySelector(`.wn-tab[data-idx="${activeNoteIdx}"]`);
              if (tab) tab.textContent = nn.label;
              notePicker.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
              btn.classList.add('active');
            });
            notePicker.appendChild(btn);
          });
        };
        const renderOctaveRow = () => {
          octavePicker.innerHTML = '';
          for (let o = OCT_MIN; o <= OCT_MAX; o++) {
            const btn = document.createElement('button');
            btn.className = 'sm-wave' + (o === octavePickerCurrent ? ' active' : '');
            btn.textContent = String(o);
            btn.addEventListener('click', () => {
              octavePickerCurrent = o;
              renderOctaveRow();
              renderPitchRow();
            });
            octavePicker.appendChild(btn);
          }
        };
        renderOctaveRow();
        renderPitchRow();
        }

        // Step Div row (sub wraps only). Buttons map to the same
        // subdivision values used by the Step Div picker elsewhere.
        // Mutates n.subdivision so each subStep's playback length
        // can be tuned independently.
        if (!onWrapTab && kind === 'sub') {
          const stepDivRow = modal.querySelector('#wn-stepdiv-row');
          if (stepDivRow) {
            const STEP_DIVS = [
              ['1/32', 0.125], ['1/16', 0.25], ['1/8', 0.5],
              ['1/4',  1],     ['1/2',  2],    ['1/1', 4],
              ['2/1',  8],     ['3/1',  12],   ['4/1', 16],
            ];
            const currentSub = (n.subdivision != null) ? n.subdivision : stepSubdivision;
            STEP_DIVS.forEach(([label, v]) => {
              const btn = document.createElement('button');
              btn.className = 'sm-wave' + (Math.abs(currentSub - v) < 0.0001 ? ' active' : '');
              btn.textContent = label;
              btn.addEventListener('click', () => {
                n.subdivision = v;
                stepDivRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
              });
              stepDivRow.appendChild(btn);
            });
          }
        }

        // Wave type row.
        const waveRow = modal.querySelector('#wn-wave-row');
        SOUNDS.forEach(s => {
          const btn = document.createElement('button');
          btn.className = 'sm-wave' + (s === p.type ? ' active' : '');
          btn.textContent = s.charAt(0).toUpperCase() + s.slice(1);
          btn.addEventListener('click', () => {
            p.type = s;
            if (n) n.sound = s;
            waveRow.querySelectorAll('.sm-wave').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
          waveRow.appendChild(btn);
        });

        // Sliders mutate p (n.params) directly.
        const sliderDefs = [
          ['wn-atk',  'wn-atk-v',  'attack',  ' ms'],
          ['wn-dec',  'wn-dec-v',  'decay',   ' ms'],
          ['wn-sus',  'wn-sus-v',  'sustain', '%'],
          ['wn-rel',  'wn-rel-v',  'release', ' ms'],
          ['wn-vol',  'wn-vol-v',  'volume',  '%'],
          ['wn-tune', 'wn-tune-v', 'detune',  ' ¢'],
          ['wn-pan',  'wn-pan-v',  'pan',     'pan'],
        ];
        sliderDefs.forEach(([id, valId, key, unit]) => {
          const input = modal.querySelector(`#${id}`);
          const label = modal.querySelector(`#${valId}`);
          if (!input) return;
          input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            p[key] = v;
            if (!label) return;
            if (unit === 'pan') {
              label.textContent = v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v);
            } else {
              label.textContent = v + unit;
            }
          });
        });

        // Override toggle — when off, the target follows its fallback tone
        // (wrap tone for a note when the wrap override is on, else master)
        // and the Sound controls are disabled; when on, the target keeps its
        // own tone. On the wrap tab this drives the wrap-level override; on a
        // note tab it drives that note's per-note override.
        const soundControls = modal.querySelector('#wn-sound-controls');
        if (soundControls && !overridden) {
          soundControls.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
        }
        const overrideChk = modal.querySelector('#wn-tone-override');
        if (overrideChk) {
          overrideChk.addEventListener('change', () => {
            if (onWrapTab) wrapOverrideWorking = overrideChk.checked;
            else           n.toneOverride      = overrideChk.checked;
            render();
          });
        }

        // Footer
        modal.querySelector('#wn-cancel').addEventListener('click', () => overlay.remove());
        modal.querySelector('#wn-save').addEventListener('click', () => {
          if (kind === 'chord') {
            wrapTemplate.chord = notes.map(nn => ({ ...nn, params: { ...(nn.params || {}) } }));
            wrapTemplate.label = wrapTemplate.chord.map(nn => nn.label).join('·');
          } else if (kind === 'sub') {
            wrapTemplate.subSteps = notes.map(nn => ({ ...nn, params: { ...(nn.params || {}) } }));
          } else {
            const nn = notes[0];
            wrapTemplate.freq         = nn.freq;
            wrapTemplate.label        = nn.label;
            wrapTemplate.cellIndex    = nn.cellIndex;
            wrapTemplate.sound        = nn.sound;
            wrapTemplate.params       = { ...(nn.params || {}) };
            wrapTemplate.toneOverride = !!nn.toneOverride;
          }
          // Wrap-level override tone (applies to notes without their own).
          wrapTemplate.wrapToneOverride = wrapOverrideWorking;
          if (wrapOverrideWorking && wrapToneWorking) {
            wrapTemplate.wrapToneParams = { ...wrapToneWorking };
          } else {
            delete wrapTemplate.wrapToneParams;
          }
          if (typeof refreshWrapVisuals === 'function') refreshWrapVisuals();
          if (typeof renderSequence === 'function') renderSequence();
          if (typeof syncActiveWrapToBank === 'function') syncActiveWrapToBank();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          overlay.remove();
        });
      };
      render();
    }
    // Maps a signed semitone delta into a short interval name. Anything
    // beyond our explicit table falls back to "Nst" so wrap drone
    // bursts a few octaves apart still render something. Direction is
    // marked with a leading ↓ for descending intervals so Run wraps
    // (where order is musical, not just enumeration) read correctly.
    function intervalNameFromSemis(semitones) {
      const abs = Math.abs(semitones);
      const dir = semitones < 0 ? '↓' : '';
      const NAMES = [
        'P1', 'min2', 'maj2', 'min3', 'maj3', 'P4',
        'TT', 'P5', 'min6', 'maj6', 'min7', 'maj7',
        'P8',
        'min9', 'maj9', 'min10', 'maj10', 'P11', 'TT11', 'P12',
        'min13', 'maj13', 'min14', 'maj14', '2P8',
      ];
      if (abs < NAMES.length) return dir + NAMES[abs];
      return dir + abs + 'st';
    }

    // Build the wrap-notes summary in either plain (dot-joined) or
    // interval-aware form. In interval mode each adjacent note pair gets
    // a small interval token between them; a "?" stands in for any pair
    // missing a frequency so the layout doesn't collapse.
    function wrapNotesSummary(notes, withIntervals) {
      if (!Array.isArray(notes) || notes.length === 0) return '';
      if (!withIntervals) {
        return notes.map(n => (n && n.label) || '—').join(' · ');
      }
      const parts = [];
      for (let i = 0; i < notes.length; i++) {
        const cur = notes[i];
        parts.push((cur && cur.label) || '—');
        if (i < notes.length - 1) {
          const nxt = notes[i + 1];
          if (_wrapNoteHasFreq(cur) && _wrapNoteHasFreq(nxt)) {
            const semis = Math.round(12 * Math.log2(nxt.freq / cur.freq));
            parts.push(`<span class="we-int">${intervalNameFromSemis(semis)}</span>`);
          } else {
            parts.push('<span class="we-int">?</span>');
          }
        }
      }
      return parts.join(' ');
    }

    function showWrapEditMenu() {
      if (!_activeWrapNoteList() && !wrapTemplate) return;
      // Click-outside / OK both close. The menu re-reads wrap state
      // every render so subsequent operations show the latest counts.
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay wrap-edit-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal wrap-edit-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      // Per-user preference: persisted so the Int view sticks across
      // re-opens. The pressed button mirrors the persisted state.
      const INT_KEY = 'bloops-wrap-edit-intervals';
      let showIntervals = false;
      try { showIntervals = localStorage.getItem(INT_KEY) === '1'; } catch (e) {}
      // Cycle-repeats: the active User wrap's per-wrap dwell count (presses
      // before the cycle steps on). Only editable on a saved User wrap.
      const _weActiveSavedWrap = () => {
        if (typeof activeWrapBankId === 'undefined' || activeWrapBankId == null) return null;
        if (typeof savedWraps === 'undefined' || !Array.isArray(savedWraps)) return null;
        return savedWraps.find(w => w.id === activeWrapBankId) || null;
      };
      const _weCycReps = () => { const e = _weActiveSavedWrap(); return (e && e.repeats > 0) ? (e.repeats | 0) : 1; };
      const _weSetCycReps = (n) => {
        const e = _weActiveSavedWrap(); if (!e) return;
        e.repeats = Math.max(1, Math.min(16, n | 0));
        try { if (typeof persistSavedWraps === 'function') persistSavedWraps(); } catch (x) {}
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (x) {}
        try { if (typeof renderWrapBank === 'function') renderWrapBank(); } catch (x) {}
        render();
      };
      const render = () => {
        const ref = _activeWrapNoteList();
        const count = ref ? ref.notes.filter(_wrapNoteHasFreq).length : 0;
        const summary = ref
          ? wrapNotesSummary(ref.notes, showIntervals)
          : '(no active wrap)';
        const shape = _wrapCurrentShape();
        const shapeLabel = shape === 'set' ? 'Set (cycle)' : shape === 'run' ? 'Run (sub)' : 'Stack (chord)';
        const isSet = (shape === 'set');
        const sv = (wrapTemplate && wrapTemplate.variance) ? wrapTemplate.variance : null;
        const svOrder = sv ? (sv.randomEachIter ? 'shuffle' : (sv.mode === 'backward' ? 'backward' : (sv.mode === 'linear' ? 'forward' : 'shuffle'))) : 'forward';
        const svReps = (sv && Number.isFinite(sv.itersPerVariant) && sv.itersPerVariant > 0) ? sv.itersPerVariant : 1;
        modal.innerHTML = `
          <div class="sm-title">Edit wrap</div>
          <div class="we-summary-row">
            <div class="we-summary">${summary}</div>
            <button type="button" class="we-int-toggle${showIntervals ? ' active' : ''}" id="we-int-toggle" aria-pressed="${showIntervals ? 'true' : 'false'}" title="Show interval names between consecutive notes">(Int)</button>
          </div>
          <div class="we-row">
            <span class="we-label">Invert</span>
            <div class="we-row-btns">
              <button type="button" class="we-btn" id="we-inv-up"${count < 2 ? ' disabled' : ''}>Up +</button>
              <button type="button" class="we-btn" id="we-inv-dn"${count < 2 ? ' disabled' : ''}>Down −</button>
            </div>
          </div>
          <div class="we-row">
            <span class="we-label" title="Stack = chord (all together) · Run = subsequence (one after another) · Set = the step cycles through the notes across loops">Shape</span>
            <button type="button" class="we-btn we-toggle${isSet ? ' active' : ''}" id="we-runstack" title="Cycle Stack → Run → Set">${shapeLabel}</button>
          </div>
          ${isSet ? `
          <div class="we-row">
            <span class="we-label" title="The order the step steps through its notes across loop passes">Order</span>
            <div class="we-row-btns">
              <button type="button" class="we-btn${svOrder==='forward'?' active':''}" data-order="forward" title="Cycle forward through the notes">→</button>
              <button type="button" class="we-btn${svOrder==='backward'?' active':''}" data-order="backward" title="Cycle backward through the notes">←</button>
              <button type="button" class="we-btn${svOrder==='shuffle'?' active':''}" data-order="shuffle" title="Shuffle — each note once per cycle, random order">?</button>
            </div>
          </div>
          <div class="we-row">
            <span class="we-label" title="How many loop passes each note repeats before swapping to the next">Repeat</span>
            <div class="we-row-btns">
              <button type="button" class="we-btn" id="we-rep-dn"${svReps<=1?' disabled':''}>−</button>
              <span class="we-summary" id="we-rep-val" style="min-width:2.2em;text-align:center">×${svReps}</span>
              <button type="button" class="we-btn" id="we-rep-up"${svReps>=64?' disabled':''}>+</button>
            </div>
          </div>` : ''}
          <div class="we-row">
            <span class="we-label" title="When on, pressing wraps appends them to playback so rapid presses sound one after another (across Grid / Graph / etc) instead of overlapping.">Queue</span>
            <button type="button" class="we-btn we-toggle${(typeof wrapQueueMode !== 'undefined' && wrapQueueMode) ? ' active' : ''}" id="we-queue" aria-pressed="${(typeof wrapQueueMode !== 'undefined' && wrapQueueMode) ? 'true' : 'false'}">${(typeof wrapQueueMode !== 'undefined' && wrapQueueMode) ? 'On' : 'Off'}</button>
          </div>
          <div class="we-row">
            <span class="we-label" title="How a borrowed chord (root outside the current scale) is voiced. Snap: bent into the current key. Local: kept as its own literal chord (brings its own key / tonicization).">Borrowed</span>
            <button type="button" class="we-btn we-toggle${(typeof _wrapTonicizePolicy !== 'undefined' && _wrapTonicizePolicy === 'local') ? ' active' : ''}" id="we-tonicize" aria-pressed="${(typeof _wrapTonicizePolicy !== 'undefined' && _wrapTonicizePolicy === 'local') ? 'true' : 'false'}">${(typeof _wrapTonicizePolicy !== 'undefined' && _wrapTonicizePolicy === 'local') ? 'Local' : 'Snap'}</button>
          </div>
          <div class="we-row">
            <span class="we-label" title="Cycle mode: how many presses this wrap repeats before the cycle steps to the next wrap. Saved per wrap.">Cycle ×</span>
            <div class="we-row-btns">
              <button type="button" class="we-btn" id="we-cyc-dn"${(!_weActiveSavedWrap() || _weCycReps() <= 1) ? ' disabled' : ''}>−</button>
              <span class="we-summary" id="we-cyc-val" style="min-width:2.2em;text-align:center">×${_weCycReps()}</span>
              <button type="button" class="we-btn" id="we-cyc-up"${(!_weActiveSavedWrap() || _weCycReps() >= 16) ? ' disabled' : ''}>+</button>
            </div>
          </div>
          <div class="we-row">
            <span class="we-label">Edit</span>
            <button type="button" class="we-btn" id="we-open-editor"${wrapTemplate ? '' : ' disabled'} title="${wrapTemplate ? 'Open the full step editor on this wrap' : 'Commit the wrap (Close) before editing fields'}">Open editor…</button>
          </div>
          <div class="sm-footer">
            <button type="button" class="sm-apply we-ok" id="we-ok">OK</button>
          </div>
        `;
        modal.querySelector('#we-int-toggle')?.addEventListener('click', () => {
          showIntervals = !showIntervals;
          try { localStorage.setItem(INT_KEY, showIntervals ? '1' : '0'); } catch (e) {}
          render();
        });
        modal.querySelector('#we-inv-up')?.addEventListener('click', () => {
          invertActiveWrap(+1);
          render();
        });
        modal.querySelector('#we-inv-dn')?.addEventListener('click', () => {
          invertActiveWrap(-1);
          render();
        });
        modal.querySelector('#we-runstack')?.addEventListener('click', () => {
          toggleWrapRunStack();
          render();
        });
        // Set-only: cycle order + repeats-per-note. Edits the active wrap's
        // variance pool (the same engine that drives per-step variance).
        const _editSetVariance = (mut) => {
          if (!wrapTemplate || !wrapTemplate.variance) return;
          snapshotForUndo('Set cycle');
          mut(wrapTemplate.variance);
          if (typeof syncActiveWrapToBank === 'function') syncActiveWrapToBank();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          render();
        };
        modal.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', () => {
          const o = b.dataset.order;
          _editSetVariance(v => {
            v.randomEachIter = false;
            v.mode = (o === 'backward') ? 'backward' : (o === 'shuffle') ? 'shuffle' : 'linear';
          });
        }));
        modal.querySelector('#we-rep-dn')?.addEventListener('click', () => _editSetVariance(v => { v.itersPerVariant = Math.max(1, (Number.isFinite(v.itersPerVariant) ? v.itersPerVariant : 1) - 1); }));
        modal.querySelector('#we-rep-up')?.addEventListener('click', () => _editSetVariance(v => { v.itersPerVariant = Math.min(64, (Number.isFinite(v.itersPerVariant) ? v.itersPerVariant : 1) + 1); }));
        modal.querySelector('#we-queue')?.addEventListener('click', () => {
          if (typeof setWrapQueueMode === 'function') setWrapQueueMode(!(typeof wrapQueueMode !== 'undefined' && wrapQueueMode));
          render();
        });
        modal.querySelector('#we-tonicize')?.addEventListener('click', () => {
          if (typeof setWrapTonicizePolicy === 'function') {
            setWrapTonicizePolicy((typeof _wrapTonicizePolicy !== 'undefined' && _wrapTonicizePolicy === 'local') ? 'snap' : 'local');
          }
          render();
        });
        modal.querySelector('#we-cyc-dn')?.addEventListener('click', () => _weSetCycReps(_weCycReps() - 1));
        modal.querySelector('#we-cyc-up')?.addEventListener('click', () => _weSetCycReps(_weCycReps() + 1));
        modal.querySelector('#we-open-editor')?.addEventListener('click', () => {
          // Close this menu first — the step editor stacks its own
          // overlay and we don't want both modals open at once.
          overlay.remove();
          openWrapEditor();
        });
        modal.querySelector('#we-ok')?.addEventListener('click', () => {
          overlay.remove();
        });
      };
      render();
    }
    document.getElementById('wrap-edit-btn')?.addEventListener('click', (e) => {
      // Key mode: the ✎ Edit button edits the current chord on the pad.
      if (document.body.classList.contains('prog-mode') && typeof _progEditChord === 'function') {
        _progEditChord(e.currentTarget);
        return;
      }
      showWrapEditMenu(e);
    });

