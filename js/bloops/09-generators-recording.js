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

    function generateRandomSequence(numSteps, maxChordSize, includeRests = true, includeChords = true, scaleName = null, tones = null, octavesToUse = null) {
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
            return {
              freq: pickNotes[idx].freq,
              label: pickNotes[idx].label,
              cellIndex: cellIdxFor(idx),
              sound,
              params: randomStepParams(sound),
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
        out.push({
          freq: pickNotes[idx].freq,
          label: pickNotes[idx].label,
          cellIndex: cellIdxFor(idx),
          sound,
          params: randomStepParams(sound),
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
        const tones         = Array.from(selectedTones);
        snapshotForUndo('Random sequence');
        stopSequence();
        // Use the grid's current scale + octaveCount so generation stays
        // anchored to the active voice instead of forcing user choices.
        const generated = generateRandomSequence(n, c, includeRests, includeChords, currentScale, tones, octaveCount);
        // Keep on: append; Keep off: replace (original behavior).
        sequence = keepMode ? sequence.concat(generated) : generated;
        pendingChord = [];
        insertionPoint = null;
        renderSequence();
        document.getElementById('save-btn').disabled = sequence.length === 0;
        overlay.remove();
      });
    }

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

    document.getElementById('save-btn').addEventListener('click', () => {
      if (subEditState) {
        commitSubEditAndExit();
        return;
      }
      if (sequence.length === 0) return;

      // Save also resets the selection state and unchecks Multi so a fresh
      // edit session starts from a clean slate.
      const resetSelectionAndMulti = () => {
        clearSelection();
        multiSelectMode = false;
        const multiCb = document.getElementById('multi-select-toggle');
        if (multiCb) multiCb.checked = false;
      };

      // Re-save: when a saved sequence is loaded, Save overwrites that entry
      // in place (preserving its name) and leaves the workspace alone so the
      // user can keep iterating. New entries get pushed and clear the workspace.
      const existing = activeSeqIndex !== null ? savedSequences[activeSeqIndex] : null;
      if (existing && existing.type !== 'audio') {
        const updated = {
          ...existing,
          ...currentSequenceSnapshot({ name: existing.name }),
        };
        savedSequences[activeSeqIndex] = updated;
        persistSaved();
        // Propagate to any track items that came from this saved sequence so
        // edits show up everywhere the sequence appears, not just in the bank.
        propagateSavedToTracks(existing.name, updated);
        renderSavedSequences();
        flashSaveConfirm();
        resetSelectionAndMulti();
        renderSequence();
        return;
      }

      const name = seqName(savedSequences.length);
      savedSequences.push({ name, ...currentSequenceSnapshot() });
      persistSaved();

      // Clear the sequence workspace — the saved entry is in the bank now.
      stopSequence();
      sequence = [];
      pendingChord = [];
      activeSeqIndex = null;
      insertionPoint = null;
      document.getElementById('save-btn').disabled = true;
      resetSelectionAndMulti();

      renderSequence();
      renderSavedSequences();
      // Persist the post-save workspace state. Without this the user's
      // most recent edits across lanes (which may not have triggered a
      // persist on their own — addToSequence aside, many mutation
      // paths don't auto-persist) would be lost on reload, since
      // persistSaved only writes the bank, not the workspace snapshot.
      if (typeof persistWorkspace === 'function') persistWorkspace();
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
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    document.getElementById('random-btn').addEventListener('click', showRandomDialog);
    document.getElementById('seed-btn').addEventListener('click', showSeedDialog);

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
    function _mergeStepPair(a, b) {
      const aPlay = a && !isRestStep(a);
      const bPlay = b && !isRestStep(b);
      if (!aPlay && !bPlay) return makeRestStep();
      if (aPlay && a.isSub) return cloneStep(a);
      if (bPlay && b.isSub) return cloneStep(b);
      if (aPlay && !bPlay) return cloneStep(a);
      if (!aPlay && bPlay) return cloneStep(b);
      const voices = [];
      const collect = (step) => {
        if (!step || isRestStep(step) || step.isSub) return;
        if (Array.isArray(step.chord)) {
          step.chord.forEach(n => {
            if (n && Number.isFinite(n.freq)) voices.push({
              freq: n.freq, label: n.label, cellIndex: n.cellIndex,
              sound: n.sound, params: n.params ? { ...n.params } : {},
            });
          });
        } else if (Number.isFinite(step.freq)) {
          voices.push({
            freq: step.freq, label: step.label, cellIndex: step.cellIndex,
            sound: step.sound, params: step.params ? { ...step.params } : {},
          });
        }
      };
      collect(a); collect(b);
      if (voices.length === 0) return makeRestStep();
      const duration    = (Number.isFinite(a.duration)    && a.duration    > 0) ? a.duration    : (b.duration    || 1);
      const subdivision = (a.subdivision != null) ? a.subdivision
                        : (b.subdivision != null ? b.subdivision : stepSubdivision);
      const kcSrc = a.keyContext || b.keyContext || null;
      if (voices.length === 1) {
        const v = voices[0];
        const out = {
          freq: v.freq, label: v.label, cellIndex: v.cellIndex,
          sound: v.sound, params: v.params,
          duration, subdivision,
        };
        if (kcSrc) out.keyContext = { root: kcSrc.root, scale: kcSrc.scale };
        return out;
      }
      const out = {
        freq: null,
        label: voices.map(v => v.label).join('·'),
        chord: voices,
        duration, subdivision,
        params: a.params ? { ...a.params } : (b.params ? { ...b.params } : {}),
      };
      if (kcSrc) out.keyContext = { root: kcSrc.root, scale: kcSrc.scale };
      return out;
    }
    function _doMergeLanes(srcAIdx, srcBIdx) {
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
      const len = Math.max(stepsA.length, stepsB.length);
      const merged = [];
      for (let i = 0; i < len; i++) {
        merged.push(_mergeStepPair(stepsA[i], stepsB[i]));
      }
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

      // Entering a fresh wrap: show the Run/Stack picker so the user
      // commits to a shape upfront. The choice lives in _wrapShape and
      // overrides gridMode at commit time, so the result no longer
      // depends on the global note-mode banner being set correctly.
      // Cancel closes the modal without entering chord mode.
      if (!chordMode) {
        showRunStackPrompt((shape) => {
          if (!shape) return;
          _wrapShape = shape;
          chordMode = true;
          refreshWrapVisuals();
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
        let newStep;
        if (useRun) {
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
    function toggleWrapRunStack() {
      // Committed wrap — restructure wrapTemplate.
      if (wrapTemplate) {
        snapshotForUndo('Toggle wrap chord/sub');
        if (Array.isArray(wrapTemplate.chord)) {
          // Chord → Sub: each voice becomes a subStep at 1-step duration.
          const baseSub = (wrapTemplate.subdivision != null) ? wrapTemplate.subdivision : stepSubdivision;
          const subSteps = wrapTemplate.chord.map(n => ({
            freq:        n.freq,
            label:       n.label,
            cellIndex:   n.cellIndex,
            sound:       n.sound,
            params:      n.params ? { ...n.params } : undefined,
            duration:    1,
            subdivision: baseSub,
          }));
          wrapTemplate = {
            isSub:       true,
            subSteps,
            label:       '▤',
            duration:    wrapTemplate.duration || 1,
            subdivision: 1,
          };
        } else if (wrapTemplate.isSub && Array.isArray(wrapTemplate.subSteps)) {
          // Sub → Chord: collapse subSteps that have a freq into chord
          // voices. Inner durations / subdivisions don't apply to chords.
          const chord = wrapTemplate.subSteps
            .filter(s => Number.isFinite(s.freq))
            .map(s => ({
              freq:      s.freq,
              label:     s.label,
              cellIndex: s.cellIndex,
              sound:     s.sound,
              params:    s.params ? { ...s.params } : undefined,
            }));
          wrapTemplate = {
            chord,
            label:       chord.map(n => n.label).join('·'),
            duration:    wrapTemplate.duration || 1,
            subdivision: wrapTemplate.subdivision || stepSubdivision,
          };
        }
        refreshWrapVisuals();
        if (typeof syncActiveWrapToBank === 'function') syncActiveWrapToBank();
        if (typeof persistWorkspace === 'function') persistWorkspace();
        return;
      }
      // Pending wrap (build in progress) — flip the wrap shape so the
      // next Close commits the opposite form. _wrapShape was set by the
      // Wrap-press picker and is what the commit path reads.
      if (chordMode) {
        _wrapShape = (_wrapShape === 'run') ? 'stack' : 'run';
        refreshWrapVisuals();
      }
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
      let activeNoteIdx = 0;
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

      const render = () => {
        const n = notes[activeNoteIdx];
        if (!n.params) n.params = {};
        const p = n.params;
        // Fill defaults so sliders always have a starting value.
        if (!Number.isFinite(p.attack))  p.attack  = 10;
        if (!Number.isFinite(p.decay))   p.decay   = 100;
        if (!Number.isFinite(p.sustain)) p.sustain = 50;
        if (!Number.isFinite(p.release)) p.release = 1400;
        if (!Number.isFinite(p.volume))  p.volume  = 100;
        if (!Number.isFinite(p.detune))  p.detune  = 0;
        if (!Number.isFinite(p.pan))     p.pan     = 0;
        if (!p.type) p.type = n.sound || 'sine';

        const tabsHtml = notes.map((nn, i) =>
          `<button type="button" class="wn-tab${i === activeNoteIdx ? ' active' : ''}" data-idx="${i}">${(nn.label || ('Note ' + (i+1)))}</button>`
        ).join('');
        const titleLabel = kind === 'chord' ? 'chord' : (kind === 'sub' ? 'subsequence' : 'note');
        // Step Div section only makes sense for subsequence wraps —
        // each subStep has its own subdivision controlling its slice
        // of the run's cadence. Chord wraps share one subdivision via
        // the parent step (all voices fire simultaneously), and single-
        // note wraps don't need a per-note picker either.
        const stepDivHtml = kind === 'sub' ? `
          <details class="sm-fold">
            <summary>Step Div</summary>
            <div class="sm-fold-body">
              <div class="sm-waves" id="wn-stepdiv-row"></div>
            </div>
          </details>` : '';
        modal.innerHTML = `
          <div class="sm-title">Edit wrap ${titleLabel}</div>
          <div class="wn-tabs">${tabsHtml}</div>
          <details class="sm-fold" open>
            <summary>Note</summary>
            <div class="sm-fold-body">
              <div class="sm-section-label" style="margin-top:0;">Octave</div>
              <div class="sm-waves" id="wn-octave-picker"></div>
              <div class="sm-section-label">Pitch</div>
              <div class="sm-waves" id="wn-note-picker"></div>
            </div>
          </details>
          ${stepDivHtml}
          <details class="sm-fold">
            <summary>Sound</summary>
            <div class="sm-fold-body">
              <div class="sm-waves" id="wn-wave-row" style="margin-bottom:14px;"></div>
              <div class="sm-param"><div class="sm-param-row">Attack <span class="sm-val" id="wn-atk-v">${p.attack} ms</span></div><input type="range" id="wn-atk" min="1" max="500" value="${p.attack}" /></div>
              <div class="sm-param"><div class="sm-param-row">Decay <span class="sm-val" id="wn-dec-v">${p.decay} ms</span></div><input type="range" id="wn-dec" min="10" max="1000" value="${p.decay}" /></div>
              <div class="sm-param"><div class="sm-param-row">Sustain <span class="sm-val" id="wn-sus-v">${p.sustain}%</span></div><input type="range" id="wn-sus" min="0" max="100" value="${p.sustain}" /></div>
              <div class="sm-param"><div class="sm-param-row">Release <span class="sm-val" id="wn-rel-v">${p.release} ms</span></div><input type="range" id="wn-rel" min="100" max="3000" value="${p.release}" /></div>
              <div class="sm-param"><div class="sm-param-row">Volume <span class="sm-val" id="wn-vol-v">${p.volume}%</span></div><input type="range" id="wn-vol" min="0" max="100" value="${p.volume}" /></div>
              <div class="sm-param"><div class="sm-param-row">Tune <span class="sm-val" id="wn-tune-v">${p.detune} ¢</span></div><input type="range" id="wn-tune" min="-100" max="100" value="${p.detune}" /></div>
              <div class="sm-param"><div class="sm-param-row">Pan <span class="sm-val" id="wn-pan-v">${p.pan === 0 ? 'C' : (p.pan < 0 ? 'L' : 'R') + Math.abs(p.pan)}</span></div><input type="range" id="wn-pan" min="-100" max="100" value="${p.pan}" /></div>
            </div>
          </details>
          <div class="sm-footer">
            <button type="button" class="sm-preview" id="wn-cancel">Cancel</button>
            <button type="button" class="sm-apply" id="wn-save">Save</button>
          </div>
        `;

        // Tabs — switch active note (working copies retain their edits).
        modal.querySelectorAll('.wn-tab').forEach(t => {
          t.addEventListener('click', () => {
            const i = parseInt(t.dataset.idx, 10);
            if (Number.isFinite(i) && i >= 0 && i < notes.length) {
              activeNoteIdx = i;
              render();
            }
          });
        });

        // Octave + pitch pickers.
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

        // Step Div row (sub wraps only). Buttons map to the same
        // subdivision values used by the Step Div picker elsewhere.
        // Mutates n.subdivision so each subStep's playback length
        // can be tuned independently.
        if (kind === 'sub') {
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
            n.sound = s;
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
            wrapTemplate.freq      = nn.freq;
            wrapTemplate.label     = nn.label;
            wrapTemplate.cellIndex = nn.cellIndex;
            wrapTemplate.sound     = nn.sound;
            wrapTemplate.params    = { ...(nn.params || {}) };
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
      const render = () => {
        const ref = _activeWrapNoteList();
        const count = ref ? ref.notes.filter(_wrapNoteHasFreq).length : 0;
        const summary = ref
          ? wrapNotesSummary(ref.notes, showIntervals)
          : '(no active wrap)';
        const isSub = _wrapIsSubLike();
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
            <span class="we-label">Shape</span>
            <button type="button" class="we-btn we-toggle" id="we-runstack">${isSub ? 'Run (sub)' : 'Stack (chord)'}</button>
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
    document.getElementById('wrap-edit-btn')?.addEventListener('click', showWrapEditMenu);

