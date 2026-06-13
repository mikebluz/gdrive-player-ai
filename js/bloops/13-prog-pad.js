    // ---- Prog mode (chord-block progression builder) ----------------------
    // Standard progression templates — keyed by scale family (major or
    // minor). Each step is [scaleDegree (1-based), chordQuality]. The
    // Auto popover instantiates the picked template into progBlocks
    // resolving each step against the chosen key root + scale.
    const PROGRESSIONS = {
      major: [
        { name: 'I — IV — V',                          steps: [[1,'maj'],[4,'maj'],[5,'maj']] },
        { name: 'I — V — I (Authentic cadence)',       steps: [[1,'maj'],[5,'maj'],[1,'maj']] },
        { name: 'IV — I (Plagal "Amen")',              steps: [[4,'maj'],[1,'maj']] },
        { name: 'I — V — vi — IV (Pop)',               steps: [[1,'maj'],[5,'maj'],[6,'min'],[4,'maj']] },
        { name: 'I — vi — IV — V (50s)',               steps: [[1,'maj'],[6,'min'],[4,'maj'],[5,'maj']] },
        { name: 'I — vi — iii — IV (50s ballad)',      steps: [[1,'maj'],[6,'min'],[3,'min'],[4,'maj']] },
        { name: 'vi — IV — I — V',                     steps: [[6,'min'],[4,'maj'],[1,'maj'],[5,'maj']] },
        { name: 'I — IV — vi — V',                     steps: [[1,'maj'],[4,'maj'],[6,'min'],[5,'maj']] },
        { name: 'I — iii — IV — V',                    steps: [[1,'maj'],[3,'min'],[4,'maj'],[5,'maj']] },
        { name: 'I — ii — iii — IV — V (Stepwise)',    steps: [[1,'maj'],[2,'min'],[3,'min'],[4,'maj'],[5,'maj']] },
        { name: 'I — IV — iv — I (Modal mix)',         steps: [[1,'maj'],[4,'maj'],[4,'min'],[1,'maj']] },
        { name: 'I — V/V — V — I (Secondary dom)',     steps: [[1,'maj'],[2,'7'],[5,'maj'],[1,'maj']] },
        { name: 'ii — V — I (Jazz turnaround)',        steps: [[2,'min7'],[5,'7'],[1,'maj7']] },
        { name: 'I — vi — ii — V (Jazz)',              steps: [[1,'maj7'],[6,'min7'],[2,'min7'],[5,'7']] },
        { name: 'iii — vi — ii — V (Jazz)',            steps: [[3,'min7'],[6,'min7'],[2,'min7'],[5,'7']] },
        { name: 'vi — ii — V — I (Turnaround)',        steps: [[6,'min7'],[2,'min7'],[5,'7'],[1,'maj7']] },
        { name: 'I — IV — I — V (Folk)',               steps: [[1,'maj'],[4,'maj'],[1,'maj'],[5,'maj']] },
        { name: 'I — V — IV — V (Rock)',               steps: [[1,'maj'],[5,'maj'],[4,'maj'],[5,'maj']] },
        { name: '12-bar Blues',                        steps: [[1,'7'],[1,'7'],[1,'7'],[1,'7'],[4,'7'],[4,'7'],[1,'7'],[1,'7'],[5,'7'],[4,'7'],[1,'7'],[5,'7']] },
        { name: '8-bar Blues',                         steps: [[1,'7'],[5,'7'],[4,'7'],[4,'7'],[1,'7'],[5,'7'],[1,'7'],[5,'7']] },
        { name: 'Pachelbel',                           steps: [[1,'maj'],[5,'maj'],[6,'min'],[3,'min'],[4,'maj'],[1,'maj'],[4,'maj'],[5,'maj']] },
        { name: 'Circle of 5ths',                      steps: [[1,'maj7'],[4,'maj7'],[7,'m7b5'],[3,'min7'],[6,'min7'],[2,'min7'],[5,'7'],[1,'maj7']] },
      ],
      minor: [
        { name: 'i — iv — v',                          steps: [[1,'min'],[4,'min'],[5,'min']] },
        { name: 'i — V — i (Cadence)',                 steps: [[1,'min'],[5,'maj'],[1,'min']] },
        { name: 'i — iv — V — i (Harmonic minor)',     steps: [[1,'min'],[4,'min'],[5,'maj'],[1,'min']] },
        { name: 'i — VII — VI — V (Andalusian)',       steps: [[1,'min'],[7,'maj'],[6,'maj'],[5,'maj']] },
        { name: 'i — VI — III — VII (Aeolian)',        steps: [[1,'min'],[6,'maj'],[3,'maj'],[7,'maj']] },
        { name: 'i — VI — VII — i',                    steps: [[1,'min'],[6,'maj'],[7,'maj'],[1,'min']] },
        { name: 'i — VII — VI — VII',                  steps: [[1,'min'],[7,'maj'],[6,'maj'],[7,'maj']] },
        { name: 'i — iv — VII — III (Minor pop)',      steps: [[1,'min'],[4,'min'],[7,'maj'],[3,'maj']] },
        { name: 'i — III — VII — VI',                  steps: [[1,'min'],[3,'maj'],[7,'maj'],[6,'maj']] },
        { name: 'i — iv — i — V',                      steps: [[1,'min'],[4,'min'],[1,'min'],[5,'maj']] },
        { name: 'i — VI — iv — V (Sad)',               steps: [[1,'min'],[6,'maj'],[4,'min'],[5,'maj']] },
        { name: 'i — III — iv — VII (Rock minor)',     steps: [[1,'min'],[3,'maj'],[4,'min'],[7,'maj']] },
        { name: 'ii° — V — i (Minor jazz)',            steps: [[2,'dim'],[5,'7'],[1,'min']] },
        { name: 'i — bIII — VII — iv (Epic minor)',    steps: [[1,'min'],[3,'maj'],[7,'maj'],[4,'min']] },
        { name: 'Minor 12-bar Blues',                  steps: [[1,'min7'],[1,'min7'],[1,'min7'],[1,'min7'],[4,'min7'],[4,'min7'],[1,'min7'],[1,'min7'],[5,'7'],[4,'min7'],[1,'min7'],[5,'7']] },
      ],
      dorian: [
        { name: 'i — IV (Dorian vamp)',                steps: [[1,'min'],[4,'maj']] },
        { name: 'i — IV — i — VII',                    steps: [[1,'min'],[4,'maj'],[1,'min'],[7,'maj']] },
        { name: 'i — VII — IV — i',                    steps: [[1,'min'],[7,'maj'],[4,'maj'],[1,'min']] },
        { name: 'i — ii — IV — i',                     steps: [[1,'min'],[2,'min'],[4,'maj'],[1,'min']] },
        { name: 'i — IV — VII — III',                  steps: [[1,'min'],[4,'maj'],[7,'maj'],[3,'maj']] },
        { name: 'i — IV — v — i',                      steps: [[1,'min'],[4,'maj'],[5,'min'],[1,'min']] },
        { name: 'ii — V — i (Modal jazz)',             steps: [[2,'min7'],[5,'min7'],[1,'min7']] },
      ],
      phrygian: [
        { name: 'i — II (Phrygian cadence)',           steps: [[1,'min'],[2,'maj']] },
        { name: 'i — II — III — II (Spanish)',         steps: [[1,'min'],[2,'maj'],[3,'maj'],[2,'maj']] },
        { name: 'II — i (Phrygian half-cadence)',      steps: [[2,'maj'],[1,'min']] },
        { name: 'i — II — vii — i',                    steps: [[1,'min'],[2,'maj'],[7,'min'],[1,'min']] },
        { name: 'i — VI — II — i (Flamenco)',          steps: [[1,'min'],[6,'maj'],[2,'maj'],[1,'min']] },
        { name: 'i — vii — VI — II',                   steps: [[1,'min'],[7,'min'],[6,'maj'],[2,'maj']] },
      ],
      lydian: [
        { name: 'I — II (Lydian vamp)',                steps: [[1,'maj'],[2,'maj']] },
        { name: 'I — II — V — I',                      steps: [[1,'maj'],[2,'maj'],[5,'maj'],[1,'maj']] },
        { name: 'I — II — vii — V',                    steps: [[1,'maj'],[2,'maj'],[7,'min'],[5,'maj']] },
        { name: 'I — vii — II — V',                    steps: [[1,'maj'],[7,'min'],[2,'maj'],[5,'maj']] },
        { name: 'I — II — I — vi',                     steps: [[1,'maj'],[2,'maj'],[1,'maj'],[6,'min']] },
      ],
      mixolydian: [
        { name: 'I — VII (Mixo vamp)',                 steps: [[1,'maj'],[7,'maj']] },
        { name: 'I — VII — IV — I',                    steps: [[1,'maj'],[7,'maj'],[4,'maj'],[1,'maj']] },
        { name: 'I — VII — IV',                        steps: [[1,'maj'],[7,'maj'],[4,'maj']] },
        { name: 'I — v — VII — IV',                    steps: [[1,'maj'],[5,'min'],[7,'maj'],[4,'maj']] },
        { name: 'I — IV — VII — IV (Rock)',            steps: [[1,'maj'],[4,'maj'],[7,'maj'],[4,'maj']] },
        { name: 'I — v — IV — I',                      steps: [[1,'maj'],[5,'min'],[4,'maj'],[1,'maj']] },
      ],
      'harmonic minor': [
        { name: 'i — iv — V — i',                      steps: [[1,'min'],[4,'min'],[5,'maj'],[1,'min']] },
        { name: 'i — V — i',                           steps: [[1,'min'],[5,'maj'],[1,'min']] },
        { name: 'i — VI — V (Lament)',                 steps: [[1,'min'],[6,'maj'],[5,'maj']] },
        { name: 'i — VI — V — i',                      steps: [[1,'min'],[6,'maj'],[5,'maj'],[1,'min']] },
        { name: 'i — iv — V (Flamenco)',               steps: [[1,'min'],[4,'min'],[5,'maj']] },
        { name: 'i — III+ — VI — V (Augmented)',       steps: [[1,'min'],[3,'aug'],[6,'maj'],[5,'maj']] },
      ],
      'melodic minor': [
        { name: 'i — ii — V — i',                      steps: [[1,'min'],[2,'min'],[5,'maj'],[1,'min']] },
        { name: 'i — IV — V (Jazz minor)',             steps: [[1,'min'],[4,'maj'],[5,'maj']] },
        { name: 'i — IV — V — i',                      steps: [[1,'min'],[4,'maj'],[5,'maj'],[1,'min']] },
        { name: 'ii — V — i (Minor ii-V-i)',           steps: [[2,'min7'],[5,'7'],[1,'minMaj7']] },
      ],
    };
    function _progScaleDegreeToSemi(scale, degree) {
      const intervals = (SCALES && SCALES[scale]) || (SCALES && SCALES['chromatic']) || [];
      if (!Array.isArray(intervals) || degree < 1 || degree > intervals.length) return null;
      return intervals[degree - 1];
    }
    function _progAutoFillProgression(keyRoot, keyScale, template) {
      const out = [];
      if (!template || !Array.isArray(template.steps)) return out;
      for (const [degree, quality] of template.steps) {
        const semi = _progScaleDegreeToSemi(keyScale, degree);
        if (semi == null) continue;
        const chordRoot = (((keyRoot + semi) % 12) + 12) % 12;
        out.push({ keyRoot, keyScale, chordRoot, chordQuality: quality });
      }
      return out;
    }

    // Per-lane state lives here as a single shared list for now; can be
    // moved into lane state alongside fluidGridMode/gameMode if needed.
    let progBlocks = []; // [{ keyRoot, keyScale, chordRoot, chordQuality }]
    let _progInited = false;
    let _progPadEl = null, _progBlocksEl = null;
    // Defaults the popover pre-fills when nothing is queued yet; subsequent
    // adds carry the previous block's values through.
    const _progLastForm = {
      keyRoot: 0, keyScale: 'major',
      chordRoot: 0, chordQuality: 'maj',
    };

    function _progIsDiatonic(block) {
      if (!block) return true;
      return _progIsChordDiatonic(block.chordRoot, block.chordQuality, block.keyRoot, block.keyScale);
    }
    function _progIsChordDiatonic(chordRoot, chordQuality, keyRoot, keyScale) {
      const chordType = CHORDS && CHORDS[chordQuality];
      if (!chordType) return true;
      const intervals = (SCALES && SCALES[keyScale]) || (SCALES && SCALES['chromatic']) || [];
      if (intervals.length === 0) return true;
      const scalePCs = new Set(intervals.map(s => (((keyRoot + s) % 12) + 12) % 12));
      for (const semi of chordType.semis) {
        const pc = (((chordRoot + semi) % 12) + 12) % 12;
        if (!scalePCs.has(pc)) return false;
      }
      return true;
    }
    // Chord qualities that read as "dominant" — major triads and any
    // 7-family member without a major 7th. Restricted because secondary
    // dominants need the major-3rd-and-flat-7-or-bare-triad shape.
    const _PROG_DOM_QUALITIES = new Set(['maj', '7', '9', '11', '13', '7sus4', '7b9', '7#9', '7b5', '7#11']);
    function _progParallelScale(keyScale) {
      if (keyScale === 'major' || keyScale === 'ionian') return 'minor';
      if (keyScale === 'minor' || keyScale === 'aeolian') return 'major';
      return null;
    }
    function _progDegreeOfRoot(rootPC, keyRoot, keyScale) {
      const intervals = (SCALES && SCALES[keyScale]) || [];
      const offset = (((rootPC - keyRoot) % 12) + 12) % 12;
      const idx = intervals.indexOf(offset);
      return idx === -1 ? -1 : idx + 1; // 1-indexed scale degree
    }
    function _progRomanDiatonic(rootPC, keyRoot, keyScale, chordQuality) {
      const degree = _progDegreeOfRoot(rootPC, keyRoot, keyScale);
      if (degree < 1) return '';
      const majSet = ['I','ii','iii','IV','V','vi','vii°'];
      const minSet = ['i','ii°','III','iv','v','VI','VII']; // natural minor diatonic triads
      if (keyScale === 'major' || keyScale === 'ionian') return majSet[degree - 1] || String(degree);
      if (keyScale === 'minor' || keyScale === 'aeolian') return minSet[degree - 1] || String(degree);
      return String(degree); // fallback for exotic modes
    }
    function _progSecondaryTarget(chordRoot, chordQuality, keyRoot, keyScale) {
      if (!_PROG_DOM_QUALITIES.has(chordQuality)) return null;
      const targetPC = (((chordRoot - 7) % 12) + 12) % 12;
      if (targetPC === keyRoot) return null; // V of I is just V — not "secondary"
      const degree = _progDegreeOfRoot(targetPC, keyRoot, keyScale);
      if (degree < 1) return null;
      const roman = _progRomanDiatonic(targetPC, keyRoot, keyScale, chordQuality);
      return { rootPC: targetPC, degree, roman };
    }
    function _progIsBorrowed(chordRoot, chordQuality, keyRoot, keyScale) {
      const parallel = _progParallelScale(keyScale);
      if (!parallel) return false;
      return _progIsChordDiatonic(chordRoot, chordQuality, keyRoot, parallel);
    }
    // { category: 'diatonic'|'secondary'|'borrowed'|'chromatic',
    //   roleLabel: string for display, target?: { rootPC, degree, roman } }
    function _progClassifyRoot(rootPC, chordQuality, keyRoot, keyScale) {
      if (_progIsChordDiatonic(rootPC, chordQuality, keyRoot, keyScale)) {
        const roman = _progRomanDiatonic(rootPC, keyRoot, keyScale, chordQuality);
        return { category: 'diatonic', roleLabel: roman || 'diatonic' };
      }
      const sec = _progSecondaryTarget(rootPC, chordQuality, keyRoot, keyScale);
      if (sec) {
        const note = (typeof CHROMATIC !== 'undefined' && CHROMATIC[sec.rootPC]) || '';
        return {
          category: 'secondary',
          target: sec,
          roleLabel: 'V/' + (sec.roman || ('°' + sec.degree)) + ' → ' + note,
        };
      }
      if (_progIsBorrowed(rootPC, chordQuality, keyRoot, keyScale)) {
        const parallel = _progParallelScale(keyScale);
        const tonicName = (typeof CHROMATIC !== 'undefined' && CHROMATIC[keyRoot]) || '';
        const parallelName = tonicName + ' ' + (parallel === 'major' ? 'Major' : 'Minor');
        return { category: 'borrowed', roleLabel: 'borrowed from ' + parallelName };
      }
      return { category: 'chromatic', roleLabel: 'chromatic passing' };
    }
    function _progKeyLabel(keyRoot, keyScale) {
      const root = (typeof CHROMATIC !== 'undefined' && CHROMATIC[keyRoot]) || '';
      const scale = (keyScale === 'chromatic') ? 'Chromatic'
                    : (typeof prettyScaleName === 'function' ? prettyScaleName(keyScale) : keyScale);
      return (root + ' ' + scale).trim();
    }
    function _progBlockLabel(block) {
      const root = (typeof CHROMATIC !== 'undefined' && CHROMATIC[block.chordRoot]) || '';
      const q = (CHORDS && CHORDS[block.chordQuality] && CHORDS[block.chordQuality].label) || block.chordQuality;
      return (root + ' ' + q).trim();
    }
    function _progRenderBlocks() {
      if (!_progBlocksEl) return;
      _progBlocksEl.innerHTML = '';
      let currentKey = null;
      let currentGroup = null;
      for (let i = 0; i < progBlocks.length; i++) {
        const b = progBlocks[i];
        const keyId = b.keyRoot + '|' + b.keyScale;
        if (keyId !== currentKey) {
          currentGroup = document.createElement('div');
          currentGroup.className = 'prog-key-group';
          // Corner label is now a real button so the user can edit the
          // group's key (root + scale) in place; clicks open the edit
          // popover anchored to the label. The start index is captured
          // via closure so the popover knows which range to re-tune.
          const startIdx = i;
          const labelBtn = document.createElement('button');
          labelBtn.type = 'button';
          labelBtn.className = 'prog-key-group-label';
          labelBtn.textContent = _progKeyLabel(b.keyRoot, b.keyScale);
          labelBtn.title = 'Edit key for this group';
          labelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _progOpenEditKeyPopover(labelBtn, startIdx);
          });
          currentGroup.appendChild(labelBtn);
          // Clone button — duplicates the whole group of consecutive
          // same-key chords and inserts the copy immediately after.
          const cloneBtn = document.createElement('button');
          cloneBtn.type = 'button';
          cloneBtn.className = 'prog-key-group-clone';
          cloneBtn.textContent = '⎘';
          cloneBtn.title = 'Clone this key set in a new key';
          cloneBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _progOpenCloneKeyPopover(cloneBtn, startIdx);
          });
          currentGroup.appendChild(cloneBtn);
          _progBlocksEl.appendChild(currentGroup);
          currentKey = keyId;
        }
        const blockEl = document.createElement('button');
        blockEl.type = 'button';
        const diatonic = _progIsDiatonic(b);
        blockEl.className = 'prog-block' + (diatonic ? '' : ' non-diatonic');
        blockEl.textContent = _progBlockLabel(b);
        blockEl.title = (diatonic ? 'Play ' : 'Play (non-diatonic) ') + _progBlockLabel(b);
        blockEl.addEventListener('click', () => _progPlayBlock(b));
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'prog-block-remove';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          progBlocks.splice(i, 1);
          _progRenderBlocks();
          if (typeof persistWorkspace === 'function') persistWorkspace();
        });
        blockEl.appendChild(rm);
        currentGroup.appendChild(blockEl);
      }
      // Trailing + button (always shown).
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'prog-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add a chord';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _progOpenAddPopover(addBtn);
      });
      // Auto button — always visible next to + so a standard
      // progression can be appended at any time (lands as its own
      // key-group thanks to the new keyRoot / keyScale).
      const autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'prog-auto-btn';
      autoBtn.textContent = 'Auto';
      autoBtn.title = 'Append a standard progression (I-IV-V, ii-V-I, 12-bar Blues, etc.) in a chosen key';
      autoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _progOpenAutoPopover(autoBtn);
      });
      _progBlocksEl.appendChild(autoBtn);
      _progBlocksEl.appendChild(addBtn);
      // Publish the current progression to the master Bloom's Notes menu so
      // Bloom layers can use it as a (time-advancing) pitch source.
      if (progBlocks.length) {
        const pubBtn = document.createElement('button');
        pubBtn.type = 'button';
        pubBtn.className = 'prog-auto-btn';
        pubBtn.textContent = '🌸 → Bloom';
        pubBtn.title = 'Publish this progression to Bloom (selectable under a layer’s Notes ▸ Progression)';
        pubBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const entry = (typeof _ambPublishProg === 'function') ? _ambPublishProg(null, progBlocks) : null;
          if (typeof showToast === 'function') showToast(entry ? ('Published “' + entry.name + '” to Bloom Notes') : 'Could not publish');
        });
        _progBlocksEl.appendChild(pubBtn);
      }
    }
    function _progPlayBlock(block) {
      if (!block || typeof playNote !== 'function') return;
      const chordType = CHORDS && CHORDS[block.chordQuality];
      if (!chordType) return;
      // Build the root freq directly from rootIdx + an octave offset that
      // matches the cell grid's lowest cell (notes[0]) — keeps the prog
      // chord in the same octave register as the rest of the project.
      const baseFreq = (Array.isArray(notes) && notes[0]) ? notes[0].freq : 261.63;
      const rootOffset = (((block.chordRoot - rootIdx) % 12) + 12) % 12;
      const rootFreq = baseFreq * Math.pow(2, rootOffset / 12);
      const baseParams = (Array.isArray(cellParams) && cellParams[0]) ? cellParams[0] : {};
      const voices = chordType.semis.map(semi => {
        const freq = rootFreq * Math.pow(2, semi / 12);
        const noteIdx = (((rootIdx + rootOffset + semi) % 12) + 12) % 12;
        const label = (typeof CHROMATIC !== 'undefined') ? (CHROMATIC[noteIdx] || '') : '';
        return {
          freq,
          label,
          cellIndex: 0,
          sound: baseParams.type,
          params: { ...baseParams },
        };
      });
      for (const v of voices) {
        try { playNote(v.freq, v.params); } catch (e) {}
      }
      if (typeof keepMode !== 'undefined' && keepMode && typeof addToSequence === 'function') {
        try {
          const chordStep = {
            chord: voices,
            label: voices.map(v => v.label).join('·'),
            duration: 1,
            subdivision: (typeof stepSubdivision === 'number') ? stepSubdivision : 1,
          };
          addToSequence(chordStep);
          // Same Step-div prompt the Grid + Wrap Keep paths show after
          // a chord/note lands — keeps Prog presses consistent.
          if (typeof maybePromptStepDiv === 'function') {
            try { maybePromptStepDiv(chordStep); } catch (_) {}
          }
        } catch (e) {}
      }
    }

    function _progScalePCsFor(keyRoot, keyScale) {
      const intervals = (SCALES && SCALES[keyScale]) || (SCALES && SCALES['chromatic']) || [];
      return intervals.map(s => (((keyRoot + s) % 12) + 12) % 12);
    }

    // Walks forward from startIdx through every consecutive block that
    // shares its (keyRoot, keyScale). Used by edit-key and clone — both
    // operate on whole same-key runs.
    function _progFindGroupRange(startIdx) {
      const b0 = progBlocks[startIdx];
      if (!b0) return null;
      let end = startIdx + 1;
      while (end < progBlocks.length) {
        const b = progBlocks[end];
        if (b.keyRoot !== b0.keyRoot || b.keyScale !== b0.keyScale) break;
        end++;
      }
      return { startIdx, endIdx: end, oldKeyRoot: b0.keyRoot, oldKeyScale: b0.keyScale };
    }
    // Re-tune a key group. Transposes every block's chordRoot by
    // (newRoot − oldRoot) mod 12 so chords move with the key
    // signature. Scale-only change leaves chordRoots alone. Round-trip
    // (K1 → K2 → K1) returns chordRoots to their exact original values
    // since each delta is the inverse of the other.
    function _progDeleteGroup(startIdx) {
      const range = _progFindGroupRange(startIdx);
      if (!range) return;
      progBlocks.splice(range.startIdx, range.endIdx - range.startIdx);
      _progRenderBlocks();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _progRetuneKeyGroup(startIdx, newKeyRoot, newKeyScale) {
      const range = _progFindGroupRange(startIdx);
      if (!range) return;
      const dRoot = (((newKeyRoot - range.oldKeyRoot) % 12) + 12) % 12;
      for (let i = range.startIdx; i < range.endIdx; i++) {
        const b = progBlocks[i];
        b.keyRoot  = newKeyRoot;
        b.keyScale = newKeyScale;
        if (dRoot !== 0) {
          b.chordRoot = (((b.chordRoot + dRoot) % 12) + 12) % 12;
        }
      }
      _progRenderBlocks();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    // Clone a key group into a new same-shape group in a different key.
    // Chord roots transpose by (newKey − oldKey) mod 12 so the same
    // scale degrees / role-positions land in the new key. Same
    // deterministic math as the edit-key path; quality is preserved
    // verbatim. The clones are spliced immediately after the source
    // group so they render as their own labelled group right beside
    // the original.
    function _progCloneGroupWithKey(startIdx, newKeyRoot, newKeyScale) {
      const range = _progFindGroupRange(startIdx);
      if (!range) return;
      const dRoot = (((newKeyRoot - range.oldKeyRoot) % 12) + 12) % 12;
      const clones = [];
      for (let i = range.startIdx; i < range.endIdx; i++) {
        const src = progBlocks[i];
        clones.push({
          keyRoot: newKeyRoot,
          keyScale: newKeyScale,
          chordRoot: (((src.chordRoot + dRoot) % 12) + 12) % 12,
          chordQuality: src.chordQuality,
        });
      }
      progBlocks.splice(range.endIdx, 0, ...clones);
      _progRenderBlocks();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }
    function _progOpenCloneKeyPopover(anchorBtn, startIdx) {
      const range = _progFindGroupRange(startIdx);
      if (!range) return;
      const existing = document.querySelector('.prog-popover');
      if (existing) existing.remove();

      // Pre-fill with the source group's key so the user can simply
      // change one field and confirm, or hit Save to clone in-place
      // (which is still a new group, just identically tuned).
      let curKeyRoot  = range.oldKeyRoot;
      let curKeyScale = range.oldKeyScale;

      const pop = document.createElement('div');
      pop.className = 'prog-popover';
      const title = document.createElement('div');
      title.className = 'prog-popover-title';
      title.textContent = 'Clone group in new key';
      pop.appendChild(title);

      const mkLabel = (text, child) => {
        const lab = document.createElement('label');
        lab.appendChild(document.createTextNode(text));
        lab.appendChild(child);
        return lab;
      };
      const keyRootSel  = document.createElement('select');
      const keyScaleSel = document.createElement('select');
      if (typeof CHROMATIC !== 'undefined') {
        CHROMATIC.forEach((n, i) => {
          const opt = document.createElement('option');
          opt.value = String(i); opt.textContent = n;
          keyRootSel.appendChild(opt);
        });
      }
      keyRootSel.value = String(curKeyRoot);
      const scaleKeys = Object.keys(SCALES || {}).filter(n => n !== 'chromatic').sort();
      ['chromatic', ...scaleKeys].forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = (typeof prettyScaleName === 'function') ? prettyScaleName(name) : name;
        keyScaleSel.appendChild(opt);
      });
      keyScaleSel.value = curKeyScale;
      pop.appendChild(mkLabel('Key root ',  keyRootSel));
      pop.appendChild(mkLabel('Key scale ', keyScaleSel));

      const actions = document.createElement('div');
      actions.className = 'prog-popover-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'prog-popover-cancel';
      cancelBtn.textContent = 'Cancel';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'prog-popover-save';
      saveBtn.textContent = 'Clone';
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      pop.appendChild(actions);
      // Disable Clone while the destination key still matches the
      // source — same-key clones aren't allowed. The button re-enables
      // as soon as the user changes either field away from the source.
      function updateCloneBtn() {
        const same = curKeyRoot === range.oldKeyRoot && curKeyScale === range.oldKeyScale;
        saveBtn.disabled = same;
        saveBtn.title = same
          ? 'Pick a different key root or scale to clone'
          : '';
      }
      updateCloneBtn();
      keyRootSel.addEventListener('change', () => {
        curKeyRoot = parseInt(keyRootSel.value, 10) || 0;
        updateCloneBtn();
      });
      keyScaleSel.addEventListener('change', () => {
        curKeyScale = keyScaleSel.value || 'major';
        updateCloneBtn();
      });

      document.body.appendChild(pop);
      const anchorRect = anchorBtn.getBoundingClientRect();
      const popW = pop.offsetWidth, popH = pop.offsetHeight;
      const vw = document.documentElement.clientWidth  || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      let left = anchorRect.left, top = anchorRect.bottom + 6;
      if (top + popH + 8 > vh) {
        const above = anchorRect.top - popH - 6;
        if (above >= 8) top = above;
        else top = Math.max(8, vh - popH - 8);
      }
      left = Math.max(8, Math.min(vw - popW - 8, left));
      pop.style.left = left + 'px';
      pop.style.top  = top  + 'px';

      const close = () => {
        pop.remove();
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey);
      };
      const onOutside = (e) => {
        if (pop.contains(e.target) || anchorBtn.contains(e.target)) return;
        close();
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
      cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        _progCloneGroupWithKey(startIdx, curKeyRoot, curKeyScale);
      });
      keyRootSel.focus();
    }
    function _progOpenAutoPopover(anchorBtn) {
      const existing = document.querySelector('.prog-popover');
      if (existing) existing.remove();

      let curKeyRoot  = (typeof rootIdx === 'number') ? rootIdx : 0;
      // Default to the workspace's current scale when we have
      // progressions for it; fall back to major otherwise. Aeolian
      // aliases to minor.
      const _workingScale = (currentScale === 'aeolian') ? 'minor' : currentScale;
      let curKeyScale = (PROGRESSIONS[_workingScale]) ? _workingScale : 'major';
      let curTemplate = PROGRESSIONS[curKeyScale][0];

      const pop = document.createElement('div');
      pop.className = 'prog-popover';
      const mkLabel = (text, child) => {
        const lab = document.createElement('label');
        lab.appendChild(document.createTextNode(text));
        lab.appendChild(child);
        return lab;
      };
      const keyRootSel  = document.createElement('select');
      const keyScaleSel = document.createElement('select');
      const tempSel     = document.createElement('select');

      if (typeof CHROMATIC !== 'undefined') {
        CHROMATIC.forEach((n, i) => {
          const opt = document.createElement('option');
          opt.value = String(i); opt.textContent = n;
          keyRootSel.appendChild(opt);
        });
      }
      keyRootSel.value = String(curKeyRoot);

      Object.keys(PROGRESSIONS).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = (typeof prettyScaleName === 'function') ? prettyScaleName(s) : s;
        keyScaleSel.appendChild(opt);
      });
      keyScaleSel.value = curKeyScale;

      const refreshTemplates = () => {
        const prev = curTemplate && curTemplate.name;
        tempSel.innerHTML = '';
        const list = PROGRESSIONS[curKeyScale] || [];
        list.forEach((t, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = t.name;
          tempSel.appendChild(opt);
        });
        let pick = 0;
        if (prev) {
          const found = list.findIndex(t => t.name === prev);
          if (found >= 0) pick = found;
        }
        tempSel.value = String(pick);
        curTemplate = list[pick];
      };
      refreshTemplates();

      pop.appendChild(mkLabel('Key root ',    keyRootSel));
      pop.appendChild(mkLabel('Scale ',       keyScaleSel));
      pop.appendChild(mkLabel('Progression ', tempSel));

      const actions = document.createElement('div');
      actions.className = 'prog-popover-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'prog-popover-cancel';
      cancelBtn.textContent = 'Cancel';
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'prog-popover-preview';
      previewBtn.textContent = '▶ Preview';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'prog-popover-save';
      saveBtn.textContent = 'Save';
      actions.appendChild(cancelBtn);
      actions.appendChild(previewBtn);
      actions.appendChild(saveBtn);
      pop.appendChild(actions);

      keyRootSel.addEventListener('change', () => {
        curKeyRoot = parseInt(keyRootSel.value, 10) || 0;
      });
      keyScaleSel.addEventListener('change', () => {
        curKeyScale = keyScaleSel.value || 'major';
        refreshTemplates();
      });
      tempSel.addEventListener('change', () => {
        const idx = parseInt(tempSel.value, 10);
        const list = PROGRESSIONS[curKeyScale] || [];
        curTemplate = list[idx] || list[0];
      });

      let previewTimers = [];
      const clearPreview = () => {
        for (const t of previewTimers) clearTimeout(t);
        previewTimers = [];
      };
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearPreview();
        const blocks = _progAutoFillProgression(curKeyRoot, curKeyScale, curTemplate);
        if (blocks.length === 0) return;
        const stepMs = 700;
        blocks.forEach((b, i) => {
          previewTimers.push(setTimeout(() => _progPlayBlock(b), i * stepMs));
        });
      });

      document.body.appendChild(pop);
      const anchorRect = anchorBtn.getBoundingClientRect();
      const popW = pop.offsetWidth, popH = pop.offsetHeight;
      const vw = document.documentElement.clientWidth  || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      let left = anchorRect.left, top = anchorRect.bottom + 6;
      if (top + popH + 8 > vh) {
        const above = anchorRect.top - popH - 6;
        if (above >= 8) top = above;
        else top = Math.max(8, vh - popH - 8);
      }
      left = Math.max(8, Math.min(vw - popW - 8, left));
      pop.style.left = left + 'px';
      pop.style.top  = top  + 'px';

      const close = () => {
        clearPreview();
        pop.remove();
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey);
      };
      const onOutside = (e) => {
        if (pop.contains(e.target) || anchorBtn.contains(e.target)) return;
        close();
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
      cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const blocks = _progAutoFillProgression(curKeyRoot, curKeyScale, curTemplate);
        if (blocks.length > 0) {
          progBlocks.push(...blocks);
          // Pre-seed the next Add-Chord pop's defaults so the user can
          // tack on a follow-up chord in the same key.
          const last = blocks[blocks.length - 1];
          Object.assign(_progLastForm, last);
          _progRenderBlocks();
          if (typeof persistWorkspace === 'function') persistWorkspace();
        }
        close();
      });
      keyRootSel.focus();
    }

    function _progOpenEditKeyPopover(anchorBtn, startIdx) {
      const range = _progFindGroupRange(startIdx);
      if (!range) return;
      const existing = document.querySelector('.prog-popover');
      if (existing) existing.remove();

      let curKeyRoot  = range.oldKeyRoot;
      let curKeyScale = range.oldKeyScale;

      const pop = document.createElement('div');
      pop.className = 'prog-popover';

      const mkLabel = (text, child) => {
        const lab = document.createElement('label');
        lab.appendChild(document.createTextNode(text));
        lab.appendChild(child);
        return lab;
      };
      const keyRootSel = document.createElement('select');
      const keyScaleSel = document.createElement('select');
      if (typeof CHROMATIC !== 'undefined') {
        CHROMATIC.forEach((n, i) => {
          const opt = document.createElement('option');
          opt.value = String(i); opt.textContent = n;
          keyRootSel.appendChild(opt);
        });
      }
      keyRootSel.value = String(curKeyRoot);
      const scaleKeys = Object.keys(SCALES || {}).filter(n => n !== 'chromatic').sort();
      ['chromatic', ...scaleKeys].forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = (typeof prettyScaleName === 'function') ? prettyScaleName(name) : name;
        keyScaleSel.appendChild(opt);
      });
      keyScaleSel.value = curKeyScale;
      keyRootSel.addEventListener('change', () => {
        curKeyRoot = parseInt(keyRootSel.value, 10) || 0;
      });
      keyScaleSel.addEventListener('change', () => {
        curKeyScale = keyScaleSel.value || 'major';
      });

      pop.appendChild(mkLabel('Key root ', keyRootSel));
      pop.appendChild(mkLabel('Key scale ', keyScaleSel));

      const actions = document.createElement('div');
      actions.className = 'prog-popover-actions';
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'prog-popover-delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.title = 'Delete every chord in this key group';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'prog-popover-cancel';
      cancelBtn.textContent = 'Cancel';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'prog-popover-save';
      saveBtn.textContent = 'Save';
      actions.appendChild(deleteBtn);
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      pop.appendChild(actions);

      document.body.appendChild(pop);
      const anchorRect = anchorBtn.getBoundingClientRect();
      const popW = pop.offsetWidth, popH = pop.offsetHeight;
      const vw = document.documentElement.clientWidth  || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      let left = anchorRect.left, top = anchorRect.bottom + 6;
      if (top + popH + 8 > vh) {
        const above = anchorRect.top - popH - 6;
        if (above >= 8) top = above;
        else top = Math.max(8, vh - popH - 8);
      }
      left = Math.max(8, Math.min(vw - popW - 8, left));
      pop.style.left = left + 'px';
      pop.style.top  = top  + 'px';

      const close = () => {
        pop.remove();
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey);
      };
      const onOutside = (e) => {
        if (pop.contains(e.target) || anchorBtn.contains(e.target)) return;
        close();
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
      cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        _progDeleteGroup(startIdx);
      });
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        _progRetuneKeyGroup(startIdx, curKeyRoot, curKeyScale);
      });
      keyRootSel.focus();
    }
    function _progOpenAddPopover(anchorBtn) {
      // Close any existing popover first.
      const existing = document.querySelector('.prog-popover');
      if (existing) existing.remove();

      // Seed the form with the previous block's values when one exists.
      // For the very first chord, key root/scale default to the
      // workspace key+scale; chord type starts UNCHOSEN so chord-root
      // stays disabled until the user picks a quality.
      const prev = progBlocks.length > 0 ? progBlocks[progBlocks.length - 1] : null;
      const hasSeed = !!prev;
      const seed = prev || _progLastForm;
      let curKeyRoot = (typeof seed.keyRoot === 'number') ? seed.keyRoot : 0;
      let curKeyScale = seed.keyScale || 'major';
      let curChordRoot = (typeof seed.chordRoot === 'number') ? seed.chordRoot : curKeyRoot;
      let curChordQuality = hasSeed ? (seed.chordQuality || '') : '';

      const pop = document.createElement('div');
      pop.className = 'prog-popover';

      const mkLabel = (text, child) => {
        const lab = document.createElement('label');
        lab.appendChild(document.createTextNode(text));
        lab.appendChild(child);
        return lab;
      };
      const keyRootSel = document.createElement('select');
      const keyScaleSel = document.createElement('select');
      const chordQualSel = document.createElement('select');
      const chordRootSel = document.createElement('select');

      // Build actions row up-front so updateSaveBtn (called inside
      // refreshChordRoot below) doesn't reference a TDZ saveBtn.
      const actions = document.createElement('div');
      actions.className = 'prog-popover-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'prog-popover-cancel';
      cancelBtn.textContent = 'Cancel';
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'prog-popover-preview';
      previewBtn.textContent = '▶ Preview';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'prog-popover-save';
      saveBtn.textContent = 'Save';
      actions.appendChild(cancelBtn);
      actions.appendChild(previewBtn);
      actions.appendChild(saveBtn);
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (saveBtn.disabled) return;
        _progPlayBlock({
          keyRoot: curKeyRoot,
          keyScale: curKeyScale,
          chordRoot: curChordRoot,
          chordQuality: curChordQuality,
        });
      });
      function updateSaveBtn() {
        const blocked = !curChordQuality
          || !Number.isFinite(curChordRoot)
          || chordRootSel.disabled
          || chordRootSel.options.length === 0;
        saveBtn.disabled = blocked;
        previewBtn.disabled = blocked;
      }

      // Key Root (12 chromatic).
      if (typeof CHROMATIC !== 'undefined') {
        CHROMATIC.forEach((n, i) => {
          const opt = document.createElement('option');
          opt.value = String(i); opt.textContent = n;
          keyRootSel.appendChild(opt);
        });
      }
      keyRootSel.value = String(curKeyRoot);

      // Key Scale (chromatic + every named scale).
      const scaleKeys = Object.keys(SCALES || {}).filter(n => n !== 'chromatic').sort();
      ['chromatic', ...scaleKeys].forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = (typeof prettyScaleName === 'function') ? prettyScaleName(name) : name;
        keyScaleSel.appendChild(opt);
      });
      keyScaleSel.value = curKeyScale;

      // Chord Type — placeholder first; full CHORDS catalog after.
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.textContent = 'Choose…';
      placeholderOpt.disabled = true;
      chordQualSel.appendChild(placeholderOpt);
      Object.keys(CHORDS || {}).forEach(key => {
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = CHORDS[key].label;
        chordQualSel.appendChild(opt);
      });
      chordQualSel.value = curChordQuality;

      // Chord Root — categorised by musical role relative to the active
      // key + chord type. Disabled until a chord type is picked.
      const refreshChordRoot = () => {
        chordRootSel.innerHTML = '';
        if (!curChordQuality) {
          chordRootSel.disabled = true;
          updateSaveBtn();
          return;
        }
        chordRootSel.disabled = false;
        const groups = { diatonic: [], secondary: [], borrowed: [], chromatic: [] };
        for (let pc = 0; pc < 12; pc++) {
          const cls = _progClassifyRoot(pc, curChordQuality, curKeyRoot, curKeyScale);
          groups[cls.category].push({ pc, cls });
        }
        const mkGroup = (title, items) => {
          if (!items.length) return;
          const og = document.createElement('optgroup');
          og.label = title;
          for (const it of items) {
            const opt = document.createElement('option');
            opt.value = String(it.pc);
            const note = (typeof CHROMATIC !== 'undefined' && CHROMATIC[it.pc]) || '';
            opt.textContent = note + ' (' + it.cls.roleLabel + ')';
            og.appendChild(opt);
          }
          chordRootSel.appendChild(og);
        };
        mkGroup('Diatonic', groups.diatonic);
        mkGroup('Secondary Dominant', groups.secondary);
        mkGroup('Borrowed / Modal Interchange', groups.borrowed);
        mkGroup('Chromatic Passing', groups.chromatic);
        // Try to restore previous selection if still present.
        const wantPC = String(curChordRoot);
        const opts = Array.from(chordRootSel.querySelectorAll('option'));
        if (opts.some(o => o.value === wantPC)) {
          chordRootSel.value = wantPC;
        } else if (groups.diatonic.length > 0) {
          chordRootSel.value = String(groups.diatonic[0].pc);
          curChordRoot = groups.diatonic[0].pc;
        } else if (opts.length > 0) {
          chordRootSel.value = opts[0].value;
          curChordRoot = parseInt(opts[0].value, 10);
        }
        updateSaveBtn();
      };

      pop.appendChild(mkLabel('Key root ', keyRootSel));
      pop.appendChild(mkLabel('Key scale ', keyScaleSel));
      pop.appendChild(mkLabel('Chord type ', chordQualSel));
      pop.appendChild(mkLabel('Chord root ', chordRootSel));
      pop.appendChild(actions);

      // Live updates.
      keyRootSel.addEventListener('change', () => {
        curKeyRoot = parseInt(keyRootSel.value, 10) || 0;
        refreshChordRoot();
      });
      keyScaleSel.addEventListener('change', () => {
        curKeyScale = keyScaleSel.value || 'major';
        refreshChordRoot();
      });
      chordQualSel.addEventListener('change', () => {
        curChordQuality = chordQualSel.value || '';
        refreshChordRoot();
      });
      chordRootSel.addEventListener('change', () => {
        curChordRoot = parseInt(chordRootSel.value, 10) || 0;
        updateSaveBtn();
      });

      refreshChordRoot();
      updateSaveBtn();

      // Mount on <body> with position: fixed so the Prog pad's overflow
      // can't clip it. Position is clamped into the viewport so the
      // whole popover is always visible, with a fallback to flip above
      // the anchor when there isn't room below it.
      document.body.appendChild(pop);
      const anchorRect = anchorBtn.getBoundingClientRect();
      const popW = pop.offsetWidth;
      const popH = pop.offsetHeight;
      const vw = document.documentElement.clientWidth  || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      let left = anchorRect.left;
      let top  = anchorRect.bottom + 6;
      if (top + popH + 8 > vh) {
        const above = anchorRect.top - popH - 6;
        if (above >= 8) top = above;
        else top = Math.max(8, vh - popH - 8);
      }
      left = Math.max(8, Math.min(vw - popW - 8, left));
      pop.style.left = left + 'px';
      pop.style.top  = top + 'px';

      const close = () => {
        pop.remove();
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey);
      };
      const onOutside = (e) => {
        if (pop.contains(e.target) || anchorBtn.contains(e.target)) return;
        close();
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);

      cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const block = {
          keyRoot: curKeyRoot,
          keyScale: curKeyScale,
          chordRoot: curChordRoot,
          chordQuality: curChordQuality,
        };
        progBlocks.push(block);
        Object.assign(_progLastForm, block);
        close();
        _progRenderBlocks();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });

      keyRootSel.focus();
    }

    function _progInit() {
      if (_progInited) return;
      _progInited = true;
      _progPadEl = document.getElementById('prog-pad');
      _progBlocksEl = document.getElementById('prog-blocks');
      if (!_progBlocksEl) return;
      _progRenderBlocks();
    }
    function _onProgModeChanged(active) {
      if (active) {
        _progInit();
        _progRenderBlocks();
      } else {
        // Close any open popover.
        const open = document.querySelector('.prog-popover');
        if (open) open.remove();
      }
    }
    // Toggle button — flips body class for the CSS visual change and
    // ends any in-flight fluid press when leaving fluid mode so a stuck
    // sustain doesn't ring on indefinitely.
    (function initFluidGridToggle() {
      const btn = document.getElementById('fluid-grid-toggle');
      if (!btn) return;
      // Grid vs. Graph is now a per-lane setting (lane.fluidGridMode);
      // _syncFluidGridToActiveLane pulls the active lane's value into
      // the global mirror, body class, and button. Run once at boot so
      // the editor surface matches the active lane on first paint —
      // applyProjectSnapshot calls the same sync later when it loads
      // saved lanes.
      try { _syncFluidGridToActiveLane(); } catch (e) {}
      btn.addEventListener('click', () => {
        const lane = lanes[activeLaneIdx];
        if (lane) {
          // Cycle: Grid → Graph → Game → Prog → Bloom → TEXT → Grid
          if (!lane.fluidGridMode && !lane.gameMode && !lane.progMode && !lane.ambientMode && !lane.textMode) {
            lane.fluidGridMode = true;  lane.gameMode = false; lane.progMode = false; lane.ambientMode = false; lane.textMode = false;
          } else if (lane.fluidGridMode) {
            lane.fluidGridMode = false; lane.gameMode = true;  lane.progMode = false; lane.ambientMode = false; lane.textMode = false;
          } else if (lane.gameMode) {
            lane.fluidGridMode = false; lane.gameMode = false; lane.progMode = true;  lane.ambientMode = false; lane.textMode = false;
          } else if (lane.progMode) {
            lane.fluidGridMode = false; lane.gameMode = false; lane.progMode = false; lane.ambientMode = true;  lane.textMode = false;
          } else if (lane.ambientMode) {
            lane.fluidGridMode = false; lane.gameMode = false; lane.progMode = false; lane.ambientMode = false; lane.textMode = true;
          } else {
            lane.fluidGridMode = false; lane.gameMode = false; lane.progMode = false; lane.ambientMode = false; lane.textMode = false;
          }
        }
        _syncFluidGridToActiveLane();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();
    // Mode tabs — banner-row tab strip that replaces the old cycle button.
    // Each tab sets the active lane's mode flags directly, then syncs.
    (function initModeTabs() {
      const tabs = document.getElementById('mode-tabs');
      if (!tabs) return;
      tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.mode-tab[data-mode]');
        if (!tab) return;
        const lane = lanes[activeLaneIdx];
        if (!lane) return;
        const m = tab.dataset.mode;
        lane.fluidGridMode = (m === 'graph');
        lane.gameMode      = (m === 'game');
        lane.progMode      = (m === 'prog');
        lane.ambientMode   = (m === 'bloom');
        lane.textMode      = (m === 'text');
        _syncFluidGridToActiveLane();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      });
    })();
    // Octave-nudge buttons (grid rail) — bump baseOctave by ±1 within the
    // Octaves dropdown's 1–7 range, then rebuild + persist exactly like a
    // dropdown change so labels / banner / undo all line up.
    (function initOctaveNudge() {
      const up   = document.getElementById('octave-up-btn');
      const down = document.getElementById('octave-down-btn');
      if (!up && !down) return;
      const OCT_MIN = 1, OCT_MAX = 7;
      const nudge = (dir) => {
        const next = (baseOctave | 0) + (dir > 0 ? 1 : -1);
        if (next < OCT_MIN || next > OCT_MAX) return;
        if (typeof snapshotForUndo === 'function') snapshotForUndo(dir > 0 ? 'Octave up' : 'Octave down');
        baseOctave = next;
        if (typeof rebuildGrid === 'function') rebuildGrid();
        if (typeof window.syncOctaveRangeSelect === 'function') window.syncOctaveRangeSelect();
        if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels();
        if (typeof updateScaleBanner === 'function') updateScaleBanner();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      };
      if (up)   up.addEventListener('click', () => nudge(1));
      if (down) down.addEventListener('click', () => nudge(-1));
    })();
    // ± note-shift buttons (on either side of the Sounds banner).
    //
    // Two modes, toggled via the °/½ pill between − and Sounds:
    //
    //  • Degree mode (default) — when a non-chromatic scale is active,
    //    each click shifts the grid's lowest cell to the next / prev
    //    SCALE NOTE while the scale's tonic stays put. Polarity is
    //    deliberately inverted (+ shifts the view DOWN one degree,
    //    − shifts it UP), matching the user's spec where + brings a
    //    lower note in at the bottom of the grid. Chromatic falls
    //    through to the semitone path since "degree == semitone" with
    //    no scale to step through.
    //  • Semitone mode (legacy) — each click shifts BOTH rootIdx and
    //    _scaleTonic by 1 semitone, transposing the whole key. Same
    //    polarity the buttons always had: + = up, − = down.
    //
    // The mode pill persists per-session via localStorage. Snapshot
    // labels capture the direction in user-language terms (degree vs
    // semitone) so the undo stack reads cleanly.
    (function initNoteShiftButtons() {
      const upBtn   = document.getElementById('note-shift-up');
      const downBtn = document.getElementById('note-shift-down');
      const modeBtn = document.getElementById('note-shift-mode-btn');
      if (!upBtn && !downBtn) return;
      const MIN_OCT = 0, MAX_OCT = 9;
      const SHIFT_MODE_KEY = 'bloops-note-shift-mode';
      let shiftMode = 'degree';
      try {
        const v = localStorage.getItem(SHIFT_MODE_KEY);
        if (v === 'semitone' || v === 'degree') shiftMode = v;
      } catch (e) {}
      const refreshModeBtn = () => {
        if (!modeBtn) return;
        const semi = (shiftMode === 'semitone');
        modeBtn.classList.toggle('semitone', semi);
        modeBtn.textContent = semi ? '½' : '°';
        modeBtn.setAttribute('aria-pressed', semi ? 'true' : 'false');
      };
      refreshModeBtn();
      // Push every shift through the same post-update path the
      // dropdowns use so labels / banners / persist hooks line up.
      const _commitShift = (newRoot, newOct, newScaleTonic, label) => {
        snapshotForUndo(label);
        rootIdx    = newRoot;
        baseOctave = newOct;
        if (newScaleTonic !== undefined) _scaleTonic = newScaleTonic;
        const rootSel  = document.getElementById('root-select');
        const octRange = document.getElementById('octave-range-select');
        if (rootSel)  rootSel.value  = String(rootIdx);
        if (octRange) octRange.value = `${baseOctave}x${octaveCount}`;
        rebuildGrid();
        if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels();
        if (typeof updateScaleBanner === 'function') updateScaleBanner();
        if (typeof refreshKeyButton === 'function') refreshKeyButton();
        if (typeof persistWorkspace === 'function') persistWorkspace();
      };
      // Semitone mode (or chromatic): shift rootIdx + _scaleTonic
      // together by 1 semitone in the natural direction.
      const _shiftSemitone = (dir) => {
        let r = rootIdx + (dir > 0 ? 1 : -1);
        let oct = baseOctave;
        if (r >= 12) { r = 0;  oct = Math.min(MAX_OCT, oct + 1); }
        if (r < 0)   { r = 11; oct = Math.max(MIN_OCT, oct - 1); }
        const newTonic = (currentScale && currentScale !== 'chromatic')
          ? r : null;
        _commitShift(r, oct, newTonic, dir > 0 ? 'Shift grid up' : 'Shift grid down');
      };
      // Degree mode (non-chromatic only): walk through the scale's
      // notes so the lowest cell jumps to the previous / next scale
      // pitch. _scaleTonic stays put — the scale is anchored, only
      // the view scrolls. degDir is +1 for "view up one degree"
      // (next scale note above current rootIdx) or −1 for "down".
      const _shiftDegree = (degDir) => {
        const intervals = SCALES[currentScale];
        if (!intervals || intervals.length === 0) { _shiftSemitone(degDir); return; }
        const tonic = _effectiveScaleTonic();
        const scalePCs = intervals
          .map(semi => (((tonic + semi) % 12) + 12) % 12)
          .sort((a, b) => a - b);
        const curPC = ((rootIdx % 12) + 12) % 12;
        let deltaSemi = 0;
        if (degDir > 0) {
          // up to next scale PC above curPC; wrap to (lowest + 12)
          let next = null;
          for (let i = 0; i < scalePCs.length; i++) {
            if (scalePCs[i] > curPC) { next = scalePCs[i]; break; }
          }
          if (next == null) next = scalePCs[0] + 12;
          deltaSemi = next - curPC;
        } else {
          // down to prev scale PC below curPC; wrap to (highest - 12)
          let prev = null;
          for (let i = scalePCs.length - 1; i >= 0; i--) {
            if (scalePCs[i] < curPC) { prev = scalePCs[i]; break; }
          }
          if (prev == null) prev = scalePCs[scalePCs.length - 1] - 12;
          deltaSemi = prev - curPC; // negative
        }
        const absMidi   = (baseOctave + 1) * 12 + rootIdx + deltaSemi;
        const newRoot   = ((absMidi % 12) + 12) % 12;
        const newOct    = Math.max(MIN_OCT, Math.min(MAX_OCT, Math.floor(absMidi / 12) - 1));
        // _scaleTonic intentionally NOT passed — keep the scale's
        // tonic anchored. _commitShift's `undefined` triggers no-op.
        _commitShift(newRoot, newOct, undefined,
          degDir > 0 ? 'Shift grid up a degree' : 'Shift grid down a degree');
      };
      const applyShift = (delta) => {
        // delta = +1 from the + button, -1 from the − button.
        // Degree mode inverts polarity per the user's spec.
        const isDegree = (shiftMode === 'degree')
          && currentScale && currentScale !== 'chromatic';
        if (isDegree) {
          _shiftDegree(-delta);  // + button → degree DOWN, − → UP
        } else {
          _shiftSemitone(delta);
        }
      };
      if (upBtn)   upBtn.addEventListener('click',   () => applyShift(+1));
      if (downBtn) downBtn.addEventListener('click', () => applyShift(-1));
      if (modeBtn) modeBtn.addEventListener('click', () => {
        shiftMode = (shiftMode === 'degree') ? 'semitone' : 'degree';
        try { localStorage.setItem(SHIFT_MODE_KEY, shiftMode); } catch (e) {}
        refreshModeBtn();
        try { modeBtn.blur(); } catch (e) {}
      });
    })();

