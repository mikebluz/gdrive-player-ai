    // ---- Arpeggio / Chord grid modes -----------------------------------
    // Both modes leave the saved sequence untouched and just re-pitch the
    // playback: clicking a cell sets the "root" the sequence is transposed
    // to. Arpeggio plays the steps in time; Chord stacks every note into
    // a single sustained chord.
    function transposeFreqHz(freq, semitones) {
      if (typeof freq !== 'number') return freq;
      return freq * Math.pow(2, semitones / 12);
    }
    function firstSequenceFreqHz() {
      const visit = (s) => {
        if (!s) return null;
        if (s.isSub && Array.isArray(s.subSteps)) {
          for (const sub of s.subSteps) { const f = visit(sub); if (f != null) return f; }
          return null;
        }
        if (Array.isArray(s.chord) && s.chord[0] && s.chord[0].freq != null) return s.chord[0].freq;
        if (s.freq != null) return s.freq;
        return null;
      };
      for (const step of sequence) { const f = visit(step); if (f != null) return f; }
      return null;
    }
    function semitonesBetweenHz(fromHz, toHz) {
      try {
        return Math.round(Tone.Frequency(toHz).toMidi() - Tone.Frequency(fromHz).toMidi());
      } catch (e) {
        return 0;
      }
    }

    // Collapse every step in the workspace sequence (single notes, chord
    // voices, subsequence subSteps) into one chord step. Used when the
    // user enters Chord mode so the rest of the saved sequence becomes
    // the "base chord" that subsequent cell clicks transpose and append.
    function consolidateSequenceToChord() {
      if (!Array.isArray(sequence) || sequence.length === 0) return false;
      const voices = [];
      // No frequency dedup — under note-lock-mode, mode transitions need
      // to be lossless so any step the user added (including transposed
      // copies that landed on a freq already in the chord) survives the
      // round-trip Spell ↔ Run ↔ Stack. Same-freq voices stack up; a
      // chord with two C4s is sonically just a louder C4, harmless.
      const pushVoice = (n) => {
        if (!n || n.freq == null) return;
        voices.push({
          freq: n.freq,
          label: n.label,
          cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
          sound: n.sound,
          params: n.params ? { ...n.params } : undefined,
        });
      };
      const collect = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) { s.subSteps.forEach(collect); return; }
        if (Array.isArray(s.chord)) { s.chord.forEach(pushVoice); return; }
        if (s.freq != null) pushVoice(s);
      };
      sequence.forEach(collect);
      if (voices.length === 0) return false;
      const first = sequence[0] || {};
      const baseDur = first.duration || 1;
      const baseSub = (first.subdivision != null) ? first.subdivision : stepSubdivision;
      const collapsed = (voices.length === 1)
        ? { ...voices[0], duration: baseDur, subdivision: baseSub }
        : {
            chord: voices,
            label: voices.map(v => v.label).join('·'),
            duration: baseDur,
            subdivision: baseSub,
          };
      snapshotForUndo('Consolidate to chord');
      stopSequence();
      sequence = [collapsed];
      pendingChord = [];
      insertionPoint = null;
      return true;
    }

    // Lock-mode helper: walk the workspace sequence and unmerge every
    // chord and subsequence step into its constituent single-note (or
    // rest) steps, preserving order. The resulting sequence is the
    // canonical "flat" form used to round-trip between Spell ↔ Run ↔
    // Stack — every grouped mode rebuilds its grouping from this flat
    // list, so re-entering Run after a Spell pass regroups exactly
    // the notes that had been grouped before.
    function flattenSequenceForLock() {
      if (!Array.isArray(sequence) || sequence.length === 0) return false;
      // If a sequence is mid-playback when the user hops back to Spell
      // (lockMode reshapes the workspace under the running scheduler),
      // the recursion's pending setTimeout would advance into the new
      // flat array out of phase — first note plays partially-released
      // synths from the previous shape. Stop cleanly first so the next
      // play gets a fresh _playBaseTime.
      stopSequence();
      const out = [];
      const visit = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) {
          s.subSteps.forEach(visit);
          return;
        }
        if (Array.isArray(s.chord)) {
          // Each voice becomes its own single-note step. Carry the
          // chord's duration/subdivision through to every voice so
          // re-consolidating to a chord reproduces the same length.
          const dur = s.duration || 1;
          const sub = (s.subdivision != null) ? s.subdivision : stepSubdivision;
          s.chord.forEach(n => {
            if (!n || n.freq == null) return;
            out.push({
              freq: n.freq,
              label: n.label,
              cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
              sound: n.sound,
              params: n.params ? { ...n.params } : undefined,
              duration: dur,
              subdivision: sub,
            });
          });
          return;
        }
        // Single note or rest — clone so later edits don't mutate.
        out.push(cloneStep(s));
      };
      sequence.forEach(visit);
      // No structural change if everything was already flat.
      const wasAlreadyFlat = sequence.every(s => s && !s.isSub && !Array.isArray(s.chord));
      if (wasAlreadyFlat && out.length === sequence.length) return false;
      sequence = out;
      pendingChord = [];
      insertionPoint = null;
      return true;
    }

    // Wrap the entire workspace sequence into a single subsequence step.
    // Used when entering Run mode so the rest of the saved sequence
    // becomes the "base subsequence" that subsequent cell clicks
    // transpose, replay, and append.
    // Run → Stack helper: convert each subsequence step in the
    // workspace to its own chord step in place, preserving the
    // sequence's position layout. Non-sub steps pass through untouched.
    // Used by the non-lockMode mode-banner transition so a Run mode
    // that built up several ▤ chips lands in Stack as several distinct
    // chords (rather than merging into one big chord, which is what
    // consolidateSequenceToChord does).
    // Convert a single chord-or-single-note step into a subsequence
    // step (each voice / the lone note becomes a subStep). Used by the
    // mode-banner handler when a wrapTemplate exists and the user
    // switches to Run note mode — the saved Wrap form is reshaped so
    // the cell-click audition plays a sub instead of a chord.
    function wrapStepAsSub(step) {
      if (!step) return step;
      if (step.isSub) return step;
      const baseDur = step.duration || 1;
      const baseSub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
      const voices = Array.isArray(step.chord)
        ? step.chord
        : (step.freq != null ? [step] : []);
      if (voices.length === 0) return step;
      const subSteps = voices.map(v => ({
        freq: v.freq,
        label: v.label,
        cellIndex: (v.cellIndex != null) ? v.cellIndex : null,
        sound: v.sound,
        params: v.params ? { ...v.params } : undefined,
        duration: 1,
        subdivision: baseSub,
      }));
      return {
        isSub: true,
        subSteps,
        label: '▤',
        duration: baseDur,
        subdivision: 1,
      };
    }

    // Convert a single subsequence step into a chord step by collecting
    // every nested voice into one chord. Mirror of wrapStepAsSub —
    // used when the user switches the note mode to Stack with a
    // wrapTemplate set.
    function wrapStepAsChord(step) {
      if (!step) return step;
      if (Array.isArray(step.chord)) return step;
      if (!step.isSub || !Array.isArray(step.subSteps)) return step;
      const voices = [];
      const collect = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) { s.subSteps.forEach(collect); return; }
        if (Array.isArray(s.chord)) {
          s.chord.forEach(n => {
            if (n && n.freq != null) voices.push({
              freq: n.freq,
              label: n.label,
              cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
              sound: n.sound,
              params: n.params ? { ...n.params } : undefined,
            });
          });
          return;
        }
        if (s.freq != null) voices.push({
          freq: s.freq,
          label: s.label,
          cellIndex: (s.cellIndex != null) ? s.cellIndex : null,
          sound: s.sound,
          params: s.params ? { ...s.params } : undefined,
        });
      };
      step.subSteps.forEach(collect);
      if (voices.length === 0) return step;
      const baseDur = step.duration || 1;
      return {
        chord: voices,
        label: voices.map(v => v.label).join('·'),
        duration: baseDur,
        subdivision: stepSubdivision,
      };
    }

    // Stack → Run helper (lockMode): convert each chord step into its
    // own subsequence step at the same position, so a workspace with
    // multiple chords lands in Run as multiple ▤ chips (one per chord)
    // rather than consolidateSequenceToSub's single mega-sub.
    // Non-chord steps (singles, rests, existing subs) pass through.
    function chordsToSubsInPlace() {
      if (!Array.isArray(sequence) || sequence.length === 0) return false;
      let changed = false;
      const next = sequence.map(step => {
        if (!step || !Array.isArray(step.chord) || step.chord.length === 0) {
          return step;
        }
        const baseDur = step.duration || 1;
        const baseSub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
        const subSteps = step.chord
          .filter(n => n && n.freq != null)
          .map(n => ({
            freq: n.freq,
            label: n.label,
            cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
            sound: n.sound,
            params: n.params ? { ...n.params } : undefined,
            duration: 1,
            subdivision: baseSub,
          }));
        if (subSteps.length === 0) return step;
        changed = true;
        return {
          isSub: true,
          subSteps,
          label: '▤',
          duration: baseDur,
          subdivision: 1,
        };
      });
      if (!changed) return false;
      snapshotForUndo('Chords → subsequences');
      stopSequence();
      sequence = next;
      pendingChord = [];
      insertionPoint = null;
      return true;
    }
    function subsToChordsInPlace() {
      if (!Array.isArray(sequence) || sequence.length === 0) return false;
      let changed = false;
      const next = sequence.map(step => {
        if (!step || !step.isSub || !Array.isArray(step.subSteps) || step.subSteps.length === 0) {
          return step;
        }
        const voices = [];
        const collect = (s) => {
          if (!s) return;
          if (s.isSub && Array.isArray(s.subSteps)) { s.subSteps.forEach(collect); return; }
          if (Array.isArray(s.chord)) {
            s.chord.forEach(n => {
              if (n && n.freq != null) voices.push({
                freq: n.freq,
                label: n.label,
                cellIndex: (n.cellIndex != null) ? n.cellIndex : null,
                sound: n.sound,
                params: n.params ? { ...n.params } : undefined,
              });
            });
            return;
          }
          if (s.freq != null) {
            voices.push({
              freq: s.freq,
              label: s.label,
              cellIndex: (s.cellIndex != null) ? s.cellIndex : null,
              sound: s.sound,
              params: s.params ? { ...s.params } : undefined,
            });
          }
        };
        step.subSteps.forEach(collect);
        if (voices.length === 0) return step; // nothing audible — leave it
        changed = true;
        const baseDur = step.duration || 1;
        const baseSub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
        if (voices.length === 1) {
          return { ...voices[0], duration: baseDur, subdivision: baseSub };
        }
        return {
          chord: voices,
          label: voices.map(v => v.label).join('·'),
          duration: baseDur,
          subdivision: baseSub,
        };
      });
      if (!changed) return false;
      snapshotForUndo('Subsequences → chords');
      stopSequence();
      sequence = next;
      pendingChord = [];
      insertionPoint = null;
      return true;
    }

    function consolidateSequenceToSub() {
      if (!Array.isArray(sequence) || sequence.length === 0) return false;
      // Already a single sub — nothing to do.
      if (sequence.length === 1 && sequence[0]?.isSub) return false;
      const subSteps = sequence.map(cloneStep);
      const collapsed = {
        isSub: true,
        subSteps,
        label: '▤',
        duration: 1,
        subdivision: 1,
      };
      snapshotForUndo('Consolidate to subsequence');
      stopSequence();
      sequence = [collapsed];
      pendingChord = [];
      insertionPoint = null;
      return true;
    }

    // Pick the base step Run mode transposes from. Selection wins:
    // if the user has a ▤ chip selected (or a chord/single step), it's
    // used as the base, so the user can choose which subsequence to
    // base subsequent Run-mode clicks off. Falls back to the first ▤
    // in the workspace, then the first chord/single, so the very first
    // tap still has something to transpose-from even with no selection.
    function runModeBaseStep() {
      if (Array.isArray(selectedStepRefs) && selectedStepRefs.length > 0) {
        for (const s of selectedStepRefs) {
          if (s && s.isSub && Array.isArray(s.subSteps) && s.subSteps.length > 0) return s;
        }
        for (const s of selectedStepRefs) {
          if (s && (s.freq != null || (Array.isArray(s.chord) && s.chord.length > 0))) return s;
        }
      }
      for (const s of sequence) {
        if (s && s.isSub && Array.isArray(s.subSteps) && s.subSteps.length > 0) return s;
      }
      for (const s of sequence) {
        if (s && (s.freq != null || (Array.isArray(s.chord) && s.chord.length > 0))) return s;
      }
      return null;
    }

    // Deep-clone a step (or sub of steps) and shift every freq by `delta`
    // semitones. Returns a fresh object so the source isn't mutated.
    // cellIndex is dropped on transposed voices since they no longer
    // correspond to the original grid cell.
    function transposeStepRec(s, delta) {
      if (!s) return s;
      const factor = Math.pow(2, delta / 12);
      if (s.isSub && Array.isArray(s.subSteps)) {
        return {
          ...s,
          subSteps: s.subSteps.map(child => transposeStepRec(child, delta)),
        };
      }
      if (Array.isArray(s.chord)) {
        const newChord = s.chord.map(n => {
          if (n.freq == null) return { ...n };
          const f = n.freq * factor;
          let label = n.label;
          try { label = Tone.Frequency(f).toNote(); } catch (e) {}
          return {
            ...n,
            freq: f,
            label,
            cellIndex: null,
            params: n.params ? { ...n.params } : undefined,
          };
        });
        return {
          ...s,
          chord: newChord,
          label: newChord.map(n => n.label).join('·'),
          params: s.params ? { ...s.params } : undefined,
        };
      }
      if (s.freq != null) {
        const f = s.freq * factor;
        let label = s.label;
        try { label = Tone.Frequency(f).toNote(); } catch (e) {}
        return {
          ...s,
          freq: f,
          label,
          cellIndex: null,
          params: s.params ? { ...s.params } : undefined,
        };
      }
      return { ...s };
    }

    // Snap a single frequency to the nearest in-scale pitch under the
    // current scale + root. Returns the input unchanged on chromatic
    // (or unknown) scales since every PC is in scale there. When two
    // in-scale pitches are equidistant (e.g., chromatic step between two
    // diatonic neighbours), prefers the upward direction so the wrap
    // keeps its forward motion.
    function snapFreqToScale(freq) {
      if (!Number.isFinite(freq) || freq <= 0) return freq;
      const intervals = (currentScale && SCALES[currentScale]) || SCALES['chromatic'];
      if (!intervals || intervals.length >= 12) return freq;
      const midi = 12 * Math.log2(freq / 440) + 69;
      const midiRound = Math.round(midi);
      const offset = ((midiRound - rootIdx) % 12 + 12) % 12;
      if (intervals.includes(offset)) return freq;
      let bestAdj = 12;
      for (const iv of intervals) {
        const up   = ((iv - offset) + 12) % 12;       // 1..11
        const down = ((offset - iv) + 12) % 12;       // 1..11
        // Equal-distance ties round up (positive adjustment) for forward
        // motion through the scale.
        const adj = (up <= down) ? up : -down;
        if (Math.abs(adj) < Math.abs(bestAdj) ||
            (Math.abs(adj) === Math.abs(bestAdj) && adj > bestAdj)) {
          bestAdj = adj;
        }
      }
      return freq * Math.pow(2, bestAdj / 12);
    }
    // Walk a step (chord / sub / single) and snap every leaf freq to
    // the current scale. Updates per-leaf labels so the chip text
    // matches the snapped pitch. Used by the wrap-template audition
    // path so a transposed wrap never plays an out-of-scale note.
    function snapStepToScale(step) {
      if (!step) return step;
      const intervals = (currentScale && SCALES[currentScale]) || SCALES['chromatic'];
      if (!intervals || intervals.length >= 12) return step; // chromatic — no-op
      if (step.isSub && Array.isArray(step.subSteps)) {
        return { ...step, subSteps: step.subSteps.map(snapStepToScale) };
      }
      if (Array.isArray(step.chord)) {
        const chord = step.chord.map(n => {
          if (!Number.isFinite(n.freq)) return { ...n };
          const f = snapFreqToScale(n.freq);
          if (f === n.freq) return { ...n };
          let label = n.label;
          try { label = Tone.Frequency(f).toNote(); } catch (e) {}
          return { ...n, freq: f, label };
        });
        return {
          ...step,
          chord,
          label: chord.map(n => n.label).join('·'),
        };
      }
      if (Number.isFinite(step.freq)) {
        const f = snapFreqToScale(step.freq);
        if (f === step.freq) return step;
        let label = step.label;
        try { label = Tone.Frequency(f).toNote(); } catch (e) {}
        return { ...step, freq: f, label };
      }
      return step;
    }
    // Diatonic transpose of a wrap step for per-cell audition. Moves
    // every leaf note by the same number of SCALE DEGREES that the wrap's
    // root moved (baseFreq -> targetFreq), so a chord keeps its diatonic
    // shape instead of each note snapping independently to the nearest
    // scale tone — the latter mangled chords (a C-major triad auditioned
    // on D in C major used to play D-G-A because the major third F#
    // tie-rounded UP to G; this plays the correct D-F-A instead).
    // Chromatic scales fall back to a plain semitone transpose. Updates
    // every leaf label to match the new pitch.
    function transposeStepToScaleDegrees(step, baseFreq, targetFreq) {
      const intervals = (currentScale && SCALES[currentScale]) || SCALES['chromatic'];
      const deltaSemi = semitonesBetweenHz(baseFreq, targetFreq);
      // Chromatic (or unknown / 12-tone) scale: degree-space is identical
      // to semitone-space, so a plain chromatic transpose is exact.
      if (!intervals || intervals.length >= 12) {
        return transposeStepRec(step, deltaSemi);
      }
      const N = intervals.length;
      const A = masterFreqA || 440;
      // Map a freq to an absolute scale-degree index (octave*N + degree)
      // using the nearest scale tone. Octave is anchored on the scale
      // root so degree + octave reconstruct the pitch exactly.
      const freqToAbsDegree = (freq) => {
        const midi = Math.round(12 * Math.log2(freq / A) + 69);
        const pc = (((midi - rootIdx) % 12) + 12) % 12;
        let bestI = 0, bestD = 99;
        for (let i = 0; i < N; i++) {
          const up   = ((intervals[i] - pc) % 12 + 12) % 12;
          const down = ((pc - intervals[i]) % 12 + 12) % 12;
          const d = Math.min(up, down);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        return Math.floor((midi - rootIdx) / 12) * N + bestI;
      };
      const absDegreeToMidi = (absDeg) => {
        const oct = Math.floor(absDeg / N);
        const i = ((absDeg % N) + N) % N;
        return rootIdx + oct * 12 + intervals[i];
      };
      const degreeDelta = freqToAbsDegree(targetFreq) - freqToAbsDegree(baseFreq);
      const mapNote = (n) => {
        if (!n || !Number.isFinite(n.freq)) return { ...n };
        const midi = absDegreeToMidi(freqToAbsDegree(n.freq) + degreeDelta);
        const freq = A * Math.pow(2, (midi - 69) / 12);
        let label = n.label;
        try { label = Tone.Frequency(freq).toNote(); } catch (e) {}
        return { ...n, freq, label };
      };
      const walk = (s) => {
        if (!s) return s;
        if (s.isSub && Array.isArray(s.subSteps)) {
          return { ...s, subSteps: s.subSteps.map(walk) };
        }
        if (Array.isArray(s.chord)) {
          const chord = s.chord.map(mapNote);
          return { ...s, chord, label: chord.map(n => n.label).join('·') };
        }
        if (Number.isFinite(s.freq)) {
          const m = mapNote(s);
          return { ...s, freq: m.freq, label: m.label };
        }
        return { ...s };
      };
      return walk(step);
    }

    // Shift one step (recursively, returning a fresh copy) by a fixed number
    // of SCALE degrees under the current scale + root. On chromatic / 12-tone
    // scales a degree equals a semitone, so this is a plain chromatic
    // transpose; on an N-note scale each note hops to the scale tone
    // `degreeDelta` positions away, so the semitone interval varies per note
    // (a true diatonic shift). Shares its degree math with
    // transposeStepToScaleDegrees, but takes the delta directly instead of
    // deriving it from a base/target freq pair. Used by the Riff Shift Up /
    // Shift Down actions. Shifted notes drop cellIndex — they no longer
    // correspond to the grid cell they came from.
    function transposeStepByScaleDegree(step, degreeDelta) {
      if (!degreeDelta) return step;
      const intervals = (currentScale && SCALES[currentScale]) || SCALES['chromatic'];
      // Chromatic / unknown / 12-tone: degree-space == semitone-space.
      if (!intervals || intervals.length >= 12) {
        return transposeStepRec(step, degreeDelta);
      }
      const N = intervals.length;
      const A = masterFreqA || 440;
      const freqToAbsDegree = (freq) => {
        const midi = Math.round(12 * Math.log2(freq / A) + 69);
        const pc = (((midi - rootIdx) % 12) + 12) % 12;
        let bestI = 0, bestD = 99;
        for (let i = 0; i < N; i++) {
          const up   = ((intervals[i] - pc) % 12 + 12) % 12;
          const down = ((pc - intervals[i]) % 12 + 12) % 12;
          const d = Math.min(up, down);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        return Math.floor((midi - rootIdx) / 12) * N + bestI;
      };
      const absDegreeToMidi = (absDeg) => {
        const oct = Math.floor(absDeg / N);
        const i = ((absDeg % N) + N) % N;
        return rootIdx + oct * 12 + intervals[i];
      };
      const mapNote = (n) => {
        if (!n || !Number.isFinite(n.freq)) return { ...n };
        const midi = absDegreeToMidi(freqToAbsDegree(n.freq) + degreeDelta);
        const freq = A * Math.pow(2, (midi - 69) / 12);
        let label = n.label;
        try { label = Tone.Frequency(freq).toNote(); } catch (e) {}
        return { ...n, freq, label, cellIndex: null };
      };
      const walk = (s) => {
        if (!s) return s;
        if (s.isSub && Array.isArray(s.subSteps)) {
          return { ...s, subSteps: s.subSteps.map(walk) };
        }
        if (Array.isArray(s.chord)) {
          const chord = s.chord.map(mapNote);
          return { ...s, chord, label: chord.map(n => n.label).join('·') };
        }
        if (Number.isFinite(s.freq)) {
          const m = mapNote(s);
          return { ...s, freq: m.freq, label: m.label, cellIndex: null };
        }
        return { ...s };
      };
      return walk(step);
    }

    // Schedule a subsequence's subSteps starting at `baseTime` audio time.
    // No transposition — the steps are assumed to already be tuned.
    function playSubStepsAtTime(subSteps, baseTime) {
      if (!Array.isArray(subSteps) || subSteps.length === 0) return;
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      let offsetSec = 0;
      const stepWaitMs = (s) => {
        const dur = s.duration || 1;
        const sub = (s.subdivision != null) ? s.subdivision : stepSubdivision;
        return Math.round(60000 / bpm * sub) * dur;
      };
      const scheduleStep = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) {
          s.subSteps.forEach(scheduleStep);
          return;
        }
        const waitMs = stepWaitMs(s);
        const at = baseTime + offsetSec;
        if (Array.isArray(s.chord)) {
          const size = s.chord.length;
          s.chord.forEach(n => {
            if (n.freq == null) return;
            playNote(n.freq, paramsWithBend(chordVoiceParams(n.params || n.sound || 'sine', size, s), s.bend), waitMs, at);
          });
        } else if (s.freq != null) {
          playNote(s.freq, paramsWithBend(s.params || s.sound || 'sine', s.bend), waitMs, at);
        }
        offsetSec += waitMs / 1000;
      };
      subSteps.forEach(scheduleStep);
    }

    // Click handler for Run mode. Two flavors:
    //  - Note-lock-mode ON: each click appends the clicked note as a
    //    fresh subStep INSIDE the existing ▤. Stack/Spell round-trips
    //    then preserve every Run-mode addition as a real voice/note.
    //  - Note-lock-mode OFF: each click transposes the entire base sub
    //    by the clicked-cell delta and appends a new ▤ chip — the
    //    original "Run = transposed playback" behavior.
    // Wraps carry no timbre of their own by default — at play time every
    // voice adopts the grid's current (master-lane) tone. Tone precedence,
    // highest first:
    //   1. per-note override  — a leaf flagged `toneOverride` keeps its own
    //      sound/params (set per note in the wrap step-editor)
    //   2. wrap-level override — when the wrap's top step is flagged
    //      `wrapToneOverride`, every non-per-note-overridden leaf uses the
    //      wrap's `wrapToneParams`
    //   3. master (grid) tone — the default for everything else
    // The chosen "base" (wrap tone or master) is computed once from the top
    // step, then applied recursively so sub steps inherit it too.
    function _stampWrapTone(step, masterParams) {
      if (!step || !masterParams) return step;
      const base = (step.wrapToneOverride && step.wrapToneParams)
        ? step.wrapToneParams
        : masterParams;
      const apply = (leaf) => {
        if (!leaf || leaf.toneOverride) return;   // per-note override wins
        leaf.sound = base.type || 'sine';
        leaf.params = { ...base };
      };
      const walk = (s) => {
        if (!s) return;
        if (s.isSub && Array.isArray(s.subSteps)) {
          s.subSteps.forEach(walk);
        } else if (Array.isArray(s.chord)) {
          s.chord.forEach(apply);
        } else {
          apply(s);
        }
      };
      walk(step);
      return step;
    }

    // Click handler used while a wrapTemplate is set. Plays a transposed
    // copy of the saved Wrap form at the clicked cell's pitch (its first
    // note becomes the clicked note). With keepMode on, also appends
    // the transposed copy to the sequence; with keepMode off, the
    // sequence is left alone (audition only).
    function playWrapTemplateOnCell(cellIdx) {
      if (!wrapTemplate) return false;
      const note = notes[cellIdx];
      if (!note) return false;
      const visit = (s) => {
        if (!s) return null;
        if (s.isSub && Array.isArray(s.subSteps)) {
          for (const sub of s.subSteps) { const f = visit(sub); if (f != null) return f; }
          return null;
        }
        if (Array.isArray(s.chord) && s.chord[0]?.freq != null) return s.chord[0].freq;
        if (s.freq != null) return s.freq;
        return null;
      };
      const baseFreq = visit(wrapTemplate);
      if (baseFreq == null) return false;
      // Diatonic transpose: shift every voice by the same number of
      // scale degrees the root moved so the chord keeps its shape in
      // key. Chromatic scale → exact semitone transpose.
      const transposed = transposeStepToScaleDegrees(wrapTemplate, baseFreq, note.freq);
      // Adopt the pressed cell's current tone (the master grid tone) for
      // every voice — wraps don't store their own timbre.
      const masterTone = (typeof cellParams !== 'undefined' && cellParams[cellIdx]) ? cellParams[cellIdx] : null;
      if (masterTone) _stampWrapTone(transposed, masterTone);
      const at = Tone.now();
      if (transposed.isSub && Array.isArray(transposed.subSteps)) {
        playSubStepsAtTime(transposed.subSteps, at);
      } else if (Array.isArray(transposed.chord)) {
        const size = transposed.chord.length;
        transposed.chord.forEach(n => {
          if (n && n.freq != null) {
            playNote(n.freq, paramsWithBend(chordVoiceParams(n.params || n.sound || 'sine', size, transposed), transposed.bend));
          }
        });
      } else if (transposed.freq != null) {
        playNote(transposed.freq, paramsWithBend(transposed.params || transposed.sound || 'sine', transposed.bend));
      }
      // Surface the transposed chord in the readout so the user sees
      // (e.g.) "A Major 7" when an "E Major 7" template gets retargeted
      // to A. Stays set until the wrap exits or another transposition
      // overwrites it.
      _wrapTransposeDisplayStep = transposed;
      updateChordDisplay();
      if (keepMode) {
        // Route through addToSequence so the Save button enables, the
        // workspace persists, and any active insertion cursor is honored
        // — mirrors every other Keep-mode append path.
        addToSequence(transposed);
        if (typeof maybePromptStepDiv === 'function') maybePromptStepDiv(transposed);
      }
      return true;
    }

    // Sustained variant of playWrapTemplateOnCell — used by the cell
    // pointerdown wrap branch so press-and-hold rings each chord voice
    // for as long as the user holds the cell. Returns a release handle
    // on success (chord / single-note wraps), or null when the wrap
    // shape can't be sustained (sub-step wraps schedule sequentially —
    // we play them one-shot and return null so the poly session skips
    // sustaining bookkeeping).
    // Expand a chord note whose voice is an ensemble into one note per member
    // (so the inline wrap voice builder, which only knows synths/samples, can
    // build each member). Honors octave/detune/pan/level offsets in
    // stack-offset / round-robin modes; falls back to sine if the ensemble is
    // missing. Non-ensemble notes pass through unchanged.
    function _expandEnsembleNote(n) {
      const t = n && n.params && n.params.type;
      if (!(typeof isEnsembleType === 'function' && isEnsembleType(t))) return [n];
      const id = t.slice(9);
      const def = (typeof ensembles !== 'undefined') ? ensembles.get(id) : null;
      if (!def || !Array.isArray(def.members) || !def.members.length) {
        return [{ ...n, sound: 'sine', params: { ...n.params, type: 'sine' } }];
      }
      const useOffsets = (def.mode || 'stack') !== 'stack';
      return def.members.filter(m => m && m.type && !isEnsembleType(m.type)).map(m => {
        const p = { ...n.params, type: m.type };
        ['attack', 'decay', 'sustain', 'release'].forEach(k => { if (Number.isFinite(m[k])) p[k] = m[k]; });
        let f = n.freq;
        if (useOffsets) {
          if (Number.isFinite(m.octave) && m.octave) f = n.freq * Math.pow(2, m.octave);
          if (Number.isFinite(m.detune) && m.detune) p.detune = (p.detune || 0) + m.detune;
          if (Number.isFinite(m.pan)) p.pan = m.pan;
          if (Number.isFinite(m.level)) { const b = (p.volume != null ? p.volume : 100); p.volume = Math.max(0, Math.min(100, Math.round(b * (m.level / 100)))); }
        }
        return { ...n, freq: f, sound: m.type, params: p };
      });
    }
    function startSustainedWrapOnCell(cellIdx, opts = {}) {
      if (!wrapTemplate) return null;
      const note = notes[cellIdx];
      if (!note) return null;
      // Radial Tone bend (cents) — applied uniformly to every voice in
      // the wrap chord so the whole chord bends together. Synth voices
      // can be live-updated via setDetune; sample voices bake the bend
      // into the attack frequency since Tone.Sampler doesn't expose a
      // clean per-voice detune ramp.
      const bendCents = Number.isFinite(opts.detune) ? opts.detune : 0;
      const visit = (s) => {
        if (!s) return null;
        if (s.isSub && Array.isArray(s.subSteps)) {
          for (const sub of s.subSteps) { const f = visit(sub); if (f != null) return f; }
          return null;
        }
        if (Array.isArray(s.chord) && s.chord[0]?.freq != null) return s.chord[0].freq;
        if (s.freq != null) return s.freq;
        return null;
      };
      const baseFreq = visit(wrapTemplate);
      if (baseFreq == null) return null;
      // Diatonic transpose (see playWrapTemplateOnCell) — keeps the
      // chord's in-key shape instead of snapping voices independently.
      const transposed = transposeStepToScaleDegrees(wrapTemplate, baseFreq, note.freq);
      // Adopt the pressed cell's current tone (the master grid tone) for
      // every voice — wraps don't store their own timbre.
      const masterTone = (typeof cellParams !== 'undefined' && cellParams[cellIdx]) ? cellParams[cellIdx] : null;
      if (masterTone) _stampWrapTone(transposed, masterTone);

      _wrapTransposeDisplayStep = transposed;
      updateChordDisplay();
      if (keepMode) {
        // Route through addToSequence so the Save button enables, the
        // workspace persists, and any active insertion cursor is honored
        // — mirrors every other Keep-mode append path.
        addToSequence(transposed);
        if (typeof maybePromptStepDiv === 'function') maybePromptStepDiv(transposed);
      }

      if (transposed.isSub && Array.isArray(transposed.subSteps)) {
        // Sub wraps play sequentially via Tone scheduling; there's no
        // single sustain to hold. Fire one-shot, no handle.
        playSubStepsAtTime(transposed.subSteps, Tone.now());
        return null;
      }

      // Chord wraps: build a voice object per chord note (handles both
      // synth-based AND sample-based instruments like Piano/Organ),
      // then trigger every one in a tight loop with a single shared
      // audio timestamp captured AFTER construction. Construction is
      // separated from triggering so per-voice JS work doesn't slide
      // later voices' attack times — every voice fires at exactly
      // `wrapAt`. Returns a release handle so pressing-and-holding the
      // cell sustains the chord until pointerup.
      // Wake the audio context if it's still suspended — Tone.now() on
      // a suspended ctx pins to a stale currentTime, so a wrapAt
      // computed against it can land in the past after ctx resumes,
      // which is exactly when voices are most prone to staggering.
      try {
        const _ac = Tone.context && Tone.context.rawContext;
        if (_ac && _ac.state === 'suspended') _ac.resume();
      } catch (e) {}
      const _chordNotes = Array.isArray(transposed.chord) ? transposed.chord.flatMap(_expandEnsembleNote) : [];
      if (_chordNotes.length > 0) {
        const size = _chordNotes.length;
        const voices = _chordNotes.map(n => {
          if (!n || n.freq == null) return null;
          const p = chordVoiceParams(n.params || n.sound || 'sine', size, transposed);
          const vol = Math.max(0.001, (p.volume ?? 100) / 100);
          // Sample-based instrument (Piano, Organ, etc.) — route via
          // the shared Tone.Sampler instead of constructing a synth.
          if (isSampleType(p.type)) {
            const entry = getSampleEntry(p.type);
            if (!entry || !entry.sampler || !entry.sampler.loaded) return null;
            const baseFreq = snapDrumKitFreq(p.type, n.freq);
            const tunedFreq = (typeof baseFreq === 'number')
              ? baseFreq * Math.pow(2, ((p.detune || 0) + bendCents) / 1200)
              : baseFreq;
            // Pads must loop while held; the shared Tone.Sampler is one-shot, so
            // build a dedicated looping ADSR voice (mirrors the single-note path).
            const _isPad = !!(((typeof sampleSamplers !== 'undefined' && sampleSamplers.get(p.type.slice(7))) || {}).padLoop);
            if (_isPad && typeof _buildSampleAdsrVoice === 'function') {
              const senv = {
                attack:  Math.max((p.attack  ?? 300) / 1000, 0.005),
                decay:   Math.max((p.decay   ?? 0)   / 1000, 0.001),
                sustain: Math.max((p.sustain ?? 100) / 100,  0.001),
                release: Math.max((p.release ?? 800) / 1000, 0.1),
              };
              const dest = fxOverrideGlobal ? masterLimiter : globalSendTap;
              const sv = _buildSampleAdsrVoice(entry.sampler, p.type.slice(7), tunedFreq, senv, dest,
                { filterCutoff: p.filterCutoff, filterQ: p.filterQ });
              if (sv) {
                return {
                  attack:  (at) => { try { sv.source.start(at); if (sv.padLoop && typeof _padLoopNativeSource === 'function') _padLoopNativeSource(sv.source); sv.ampEnv.triggerAttack(at, vol); } catch (e) {} },
                  release: () => { try { sv.ampEnv.triggerRelease(); } catch (e) {} setTimeout(() => { try { _disposeSampleAdsrVoice(sv); } catch (e) {} }, (senv.release + 0.3) * 1000); },
                  setDetune: () => {},
                  env: { release: senv.release },
                };
              }
            }
            return {
              attack:  (at) => { try { entry.sampler.triggerAttack(tunedFreq, at, vol); } catch (e) {} },
              release: () => { try { entry.sampler.triggerRelease(tunedFreq, undefined); } catch (e) {} },
              // Sampler doesn't expose a live per-voice detune ramp, so
              // setDetune is a no-op here — the bend is baked into the
              // attack frequency above.
              setDetune: () => {},
              env: { release: 1.0 },
            };
          }
          // Synth-based voice.
          const env = {
            attack:  Math.max((p.attack  ?? 10)   / 1000, 0.005),
            decay:   Math.max((p.decay   ?? 100)  / 1000, 0.01),
            sustain: Math.max((p.sustain ?? 50)   / 100,  0.001),
            release: Math.max((p.release ?? 1400) / 1000, 0.1),
          };
          const oscType = p.type === 'fat'   ? 'fatsawtooth'
                        : p.type === 'pulse' ? 'pulse'
                        : (p.type || 'sine');
          let synth;
          if (p.type === 'fm') {
            synth = new Tone.FMSynth({ oscillator: { type: 'sine' }, envelope: env });
          } else if (p.type === 'am') {
            synth = new Tone.AMSynth({ oscillator: { type: 'sine' }, envelope: env });
          } else if (p.type === 'mono') {
            synth = new Tone.MonoSynth({ oscillator: { type: 'sawtooth' }, envelope: env });
          } else if (p.type === 'bass') {
            synth = new Tone.MonoSynth({
              oscillator: { type: 'square' }, envelope: env,
              filterEnvelope: { attack: 0.005, decay: 0.18, sustain: 0.4, release: 0.4,
                                baseFrequency: 80, octaves: 3.2 },
              filter: { Q: 4, type: 'lowpass', rolloff: -24 },
            });
          } else if (p.type === 'pad') {
            synth = new Tone.AMSynth({
              harmonicity: 1.5,
              oscillator: { type: 'sine' },
              envelope: { attack: 1.2, decay: 0.5, sustain: 0.7, release: 2.5 },
              modulation: { type: 'sine' },
              modulationEnvelope: { attack: 1.0, decay: 0.5, sustain: 0.5, release: 2.0 },
            });
          } else if (p.type === 'xylo') {
            synth = new Tone.FMSynth({
              harmonicity: 7, modulationIndex: 4,
              oscillator: { type: 'sine' },
              envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 },
              modulation: { type: 'sine' },
              modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 },
            });
          } else if (p.type === 'bell') {
            synth = new Tone.FMSynth({
              harmonicity: 2.14, modulationIndex: 4,
              oscillator: { type: 'sine' },
              envelope: { attack: 0.001, decay: 2.0, sustain: 0.5, release: 0.8 },
              modulation: { type: 'sine' },
              modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.5 },
            });
          } else if (p.type === 'duo') {
            // DuoSynth — Tone.OmniOscillator (used by Tone.Synth) doesn't
            // accept 'duo' as a type, so the generic fallback below
            // would silently produce no sound. Mirrors the playNote
            // and startSustainedNote duo branches.
            synth = new Tone.DuoSynth({
              voice0: { oscillator: { type: 'sine'    }, envelope: env },
              voice1: { oscillator: { type: 'sawtooth'}, envelope: env },
              harmonicity: 1.5,
              vibratoAmount: 0.3,
              vibratoRate: 5,
            });
          } else if (typeof p.type === 'string' && p.type.startsWith('noise')) {
            // NoiseSynth — also rejected by OmniOscillator. Triggered
            // with (time, velocity) below since NoiseSynth has no freq.
            const colour = p.type.includes(':') ? p.type.split(':')[1] : 'white';
            synth = new Tone.NoiseSynth({
              noise: { type: colour },
              envelope: env,
            });
          } else {
            synth = new Tone.Synth({ oscillator: { type: oscType }, envelope: env });
          }
          // Route to globalSendTap (not masterBus) so the master FX
          // panel — reverb, delay, chorus, etc. — actually colours
          // the wrap-chord audition. masterBus sits AFTER the FX
          // returns in the master chain, so connecting straight to
          // it bypassed every send and the wrap-chord cell press
          // came out completely dry no matter what the FX panel said.
          synth.connect(globalSendTap);
          try { synth.volume.value = Tone.gainToDb(vol); } catch (e) {}
          const baseDetune = Number.isFinite(p.detune) ? p.detune : 0;
          if (synth.detune) synth.detune.value = baseDetune + bendCents;
          const isNoise = typeof p.type === 'string' && p.type.startsWith('noise');
          return {
            attack:  (at) => {
              try {
                if (isNoise) synth.triggerAttack(at, 1);
                else         synth.triggerAttack(n.freq, at, 1);
              } catch (e) {}
            },
            release: () => {
              try { synth.triggerRelease(); } catch (e) {}
              setTimeout(() => { try { synth.dispose(); } catch (e) {} }, (env.release + 0.5) * 1000);
            },
            // Live Radial Tone update — ramps detune (not frequency)
            // so it can't fight the attack's own freq scheduling.
            setDetune: (cents) => {
              try {
                if (!synth.detune) return;
                const target = baseDetune + cents;
                const raw = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : null;
                const t = raw ? raw.currentTime + 0.005 : Tone.now();
                if (typeof synth.detune.linearRampToValueAtTime === 'function') {
                  try { synth.detune.setValueAtTime(synth.detune.value, t); } catch (e) {}
                  synth.detune.linearRampToValueAtTime(target, t + 0.02);
                } else {
                  synth.detune.value = target;
                }
              } catch (e) {}
            },
            env,
          };
        }).filter(Boolean);
        if (voices.length === 0) return null;
        // Capture wrapAt AFTER all construction so per-voice setup time
        // doesn't push later voices' triggers past it. Tone.now() already
        // includes the scheduling lookAhead (~25 ms), which is enough
        // headroom for a tight trigger loop on a warm audio context.
        // Cold-start (suspended ctx) still gets an extra 80 ms cushion
        // because the resume() race + first-trigger overhead can spike
        // beyond what lookAhead alone covers, which manifested as
        // audibly staggered chord voices.
        const _wrapAcSuspended = !!(Tone.context?.rawContext && Tone.context.rawContext.state === 'suspended');
        const _wrapPad = _wrapAcSuspended ? 0.08 : 0;
        const wrapAt = (typeof Tone.now === 'function')
          ? Tone.now() + _wrapPad
          : ((Tone.context?.rawContext?.currentTime || 0) + _wrapPad);
        // Tight trigger loop — every voice attacks at exactly wrapAt.
        voices.forEach(v => v.attack(wrapAt));
        let released = false;
        return {
          release: () => {
            if (released) return; released = true;
            voices.forEach(v => v.release());
          },
          // Radial Tone live bend — fans out to every voice so the
          // whole chord shifts together as the user drags.
          setDetune: (cents) => {
            voices.forEach(v => { try { v.setDetune?.(cents); } catch (e) {} });
          },
        };
      }

      const handles = [];
      if (transposed.freq != null) {
        try {
          const h = startSustainedNote(
            transposed.freq,
            paramsWithBend(transposed.params || transposed.sound || 'sine', transposed.bend),
            wrapAt
          );
          if (h) handles.push(h);
        } catch (e) {}
      }
      if (handles.length === 0) return null;
      return {
        release: () => handles.forEach(h => { try { h.release(); } catch (e) {} }),
      };
    }

    function runModeOnCell(cellIdx) {
      const note = notes[cellIdx];
      if (!note) return;
      if (lockMode) {
        const params = { ...cellParams[cellIdx] };
        const newSubStep = {
          freq: note.freq,
          label: note.label,
          cellIndex: cellIdx,
          sound: params.type,
          params,
          duration: 1,
          subdivision: stepSubdivision,
        };
        if (keepMode) {
          // Find (or seed) the first ▤ and append into it.
          let baseSub = sequence.find(s => s && s.isSub && Array.isArray(s.subSteps));
          snapshotForUndo('Add note in Run');
          if (!baseSub) {
            baseSub = {
              isSub: true,
              subSteps: [newSubStep],
              label: '▤',
              duration: 1,
              subdivision: 1,
            };
            sequence.push(baseSub);
          } else {
            baseSub.subSteps.push(newSubStep);
          }
          renderSequence();
        }
        playNote(note.freq, params);
        return;
      }
      const base = runModeBaseStep();
      if (!base) {
        // Empty workspace — there's no sub to transpose. With Keep on,
        // seed a one-step ▤ so future taps have a base. With Keep off,
        // just play the clicked note (no seed).
        const params = { ...cellParams[cellIdx] };
        if (keepMode) {
          const seed = {
            freq: note.freq,
            label: note.label,
            cellIndex: cellIdx,
            sound: params.type,
            params,
            duration: 1,
            subdivision: stepSubdivision,
          };
          snapshotForUndo('Seed run');
          sequence.push({
            isSub: true,
            subSteps: [seed],
            label: '▤',
            duration: 1,
            subdivision: 1,
          });
          renderSequence();
        }
        playNote(note.freq, params);
        return;
      }
      const visit = (s) => {
        if (!s) return null;
        if (s.isSub && Array.isArray(s.subSteps)) {
          for (const sub of s.subSteps) { const f = visit(sub); if (f != null) return f; }
          return null;
        }
        if (Array.isArray(s.chord) && s.chord[0]?.freq != null) return s.chord[0].freq;
        if (s.freq != null) return s.freq;
        return null;
      };
      const baseFreq = visit(base);
      if (baseFreq == null) return;
      const delta = semitonesBetweenHz(baseFreq, note.freq);

      let newStep;
      if (base.isSub) {
        newStep = transposeStepRec(base, delta);
      } else {
        // Promote the non-sub base into a one-step subsequence so the
        // workspace ends up with consistent ▤ chips after the first tap.
        const single = transposeStepRec(base, delta);
        newStep = {
          isSub: true,
          subSteps: [single],
          label: '▤',
          duration: 1,
          subdivision: 1,
        };
      }
      // Keep gates the sequence mutation; the audio always plays so the
      // user hears the transposed sub regardless.
      if (keepMode) {
        snapshotForUndo('Add run');
        sequence.push(newStep);
        renderSequence();
      }
      playSubStepsAtTime(newStep.subSteps || [], Tone.now());
    }

    // Locate the chord-mode "base" — the first sequence step we can
    // transpose from. Single-note steps return as a 1-voice chord.
    function chordModeBaseStep() {
      for (const s of sequence) {
        if (!s) continue;
        if (Array.isArray(s.chord) && s.chord.length > 0) return s;
        if (s.freq != null) return s;
      }
      return null;
    }

    // Click handler for Chord mode: transpose the base chord to the
    // clicked cell's root, append the new chord step to the sequence, and
    // play it back with cell highlights for every voice's pitch class.
    // Note-lock-mode override: instead of stacking transposed copies of
    // the chord, append the clicked note as a NEW VOICE in the existing
    // chord. Preserves every Stack-mode click as a discrete note across
    // round-trips through Run / Spell.
    function chordModeOnCell(cellIdx) {
      const note = notes[cellIdx];
      if (!note) return;
      if (lockMode) {
        const params = { ...cellParams[cellIdx] };
        const newVoice = {
          freq: note.freq,
          label: note.label,
          cellIndex: cellIdx,
          sound: params.type,
          params,
        };
        if (keepMode) {
          let baseIdx = sequence.findIndex(s => s && Array.isArray(s.chord));
          snapshotForUndo('Add voice in Stack');
          let _promptStep = null;
          if (baseIdx === -1) {
            const firstNoteIdx = sequence.findIndex(s => s && s.freq != null && !s.isSub);
            if (firstNoteIdx >= 0) {
              const first = sequence[firstNoteIdx];
              const firstVoice = {
                freq: first.freq, label: first.label,
                cellIndex: first.cellIndex,
                sound: first.sound,
                params: first.params ? { ...first.params } : undefined,
              };
              const chordStep = {
                chord: [firstVoice, newVoice],
                label: [firstVoice.label, newVoice.label].join('·'),
                duration: first.duration || 1,
                subdivision: (first.subdivision != null) ? first.subdivision : stepSubdivision,
              };
              sequence.splice(firstNoteIdx, 1, chordStep);
              _promptStep = chordStep;
            } else {
              const seed = {
                freq: note.freq,
                label: note.label,
                cellIndex: cellIdx,
                sound: params.type,
                params,
                duration: 1,
                subdivision: stepSubdivision,
              };
              sequence.push(seed);
              _promptStep = seed;
            }
          } else {
            const baseChord = sequence[baseIdx];
            baseChord.chord.push(newVoice);
            baseChord.label = baseChord.chord.map(v => v.label).join('·');
            _promptStep = baseChord;
          }
          renderSequence();
          maybePromptStepDiv(_promptStep);
        }
        playNote(note.freq, params);
        return;
      }
      const base = chordModeBaseStep();
      if (!base) {
        const params = { ...cellParams[cellIdx] };
        if (keepMode) {
          const seed = {
            freq: note.freq,
            label: note.label,
            cellIndex: cellIdx,
            sound: params.type,
            params,
            duration: 1,
            subdivision: stepSubdivision,
          };
          snapshotForUndo('Seed chord');
          sequence.push(seed);
          renderSequence();
          maybePromptStepDiv(seed);
        }
        playNote(note.freq, params);
        return;
      }
      const sourceVoices = Array.isArray(base.chord) ? base.chord : [{
        freq: base.freq, label: base.label, cellIndex: base.cellIndex,
        sound: base.sound, params: base.params,
      }];
      const baseFreq = sourceVoices[0].freq;
      const delta = semitonesBetweenHz(baseFreq, note.freq);
      const newVoices = sourceVoices.map(v => {
        const f = transposeFreqHz(v.freq, delta);
        let label = v.label;
        try { label = Tone.Frequency(f).toNote(); } catch (e) {}
        return {
          freq: f,
          label,
          cellIndex: null,
          sound: v.sound,
          params: v.params ? { ...v.params } : undefined,
        };
      });
      const baseDur = base.duration || 1;
      const baseSub = (base.subdivision != null) ? base.subdivision : stepSubdivision;
      const newStep = (newVoices.length === 1)
        ? { ...newVoices[0], duration: baseDur, subdivision: baseSub }
        : {
            chord: newVoices,
            label: newVoices.map(v => v.label).join('·'),
            duration: baseDur,
            subdivision: baseSub,
          };
      // Keep gates the sequence mutation; the audio always plays so the
      // user hears the transposed chord regardless.
      if (keepMode) {
        snapshotForUndo('Add chord');
        sequence.push(newStep);
        renderSequence();
        maybePromptStepDiv(newStep);
      }

      // Play the new chord + highlight matching cells.
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      const sustainMs = Math.round(60000 / bpm * 4);
      const at = Tone.now();
      newVoices.forEach(v => {
        playNote(
          v.freq,
          paramsWithBend(chordVoiceParams(v.params || v.sound || 'sine', newVoices.length), null),
          sustainMs,
          at
        );
      });
      const pcs = new Set(newVoices.map(v => {
        try { return ((Math.round(Tone.Frequency(v.freq).toMidi()) % 12) + 12) % 12; }
        catch (e) { return -1; }
      }));
      clearHighlights();
      cells.forEach((cell, idx) => {
        const n = notes[idx];
        if (!n) return;
        try {
          const pc = ((Math.round(Tone.Frequency(n.freq).toMidi()) % 12) + 12) % 12;
          if (pcs.has(pc)) cell.classList.add('active-loop');
        } catch (e) {}
      });
      setTimeout(() => clearHighlights(), sustainMs + 200);
    }

    // ---- Whole-sequence transpose (long-press menu helper) --------------
    // Shifts every step's pitch by `semitones`, preserving rests and the
    // structure of subsequences / chords. Snapshot for undo.
    function transposeWholeSequence(semitones) {
      if (!semitones || sequence.length === 0) return;
      snapshotForUndo('Transpose');
      stopSequence();
      // Scope = selection: transpose only the selected steps when there's a
      // selection, else the whole lane (empty selection = lane-wide).
      const sel = (typeof selectedStepRefs !== 'undefined' && selectedStepRefs.length)
        ? selectedStepRefs.filter(s => sequence.indexOf(s) >= 0) : null;
      const targets = (sel && sel.length) ? sel : sequence;
      targets.forEach(s => modulateStepRec(s, semitones));
      renderSequence();
    }
    function showTransposeDialog(stepIndex) {
      const baseFreq = firstSequenceFreqHz();
      if (baseFreq == null) return;
      let basePc;
      try { basePc = ((Math.round(Tone.Frequency(baseFreq).toMidi()) % 12) + 12) % 12; }
      catch (e) { basePc = 0; }
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.innerHTML = `
        <div class="sm-title">Transpose</div>
        <div style="color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.8rem;padding:0 0 12px;line-height:1.45;">
          Pick the new root note. Every step's pitch shifts by the same interval — chords, subsequences, and rests are preserved.
        </div>
        <div class="sm-section-label" style="margin-top:0;">New root</div>
        <div class="sm-waves" id="trans-roots"></div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="trans-cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      modal.querySelector('#trans-cancel').addEventListener('click', () => overlay.remove());
      const row = modal.querySelector('#trans-roots');
      CHROMATIC.forEach((name, pc) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sm-wave' + (pc === basePc ? ' active' : '');
        b.textContent = name;
        b.addEventListener('click', () => {
          let delta = pc - basePc;
          // Normalize into the smallest absolute interval (-6 to +5) so a
          // tap on the next-door neighbour doesn't always shift by 11
          // semitones in one direction.
          if (delta > 6)  delta -= 12;
          if (delta < -6) delta += 12;
          if (delta !== 0) transposeWholeSequence(delta);
          overlay.remove();
        });
        row.appendChild(b);
      });
    }

    // Cheap active-chip update for the playback hot path — toggling a class
    // on existing nodes instead of rebuilding the whole sequence-display
    // DOM. The full renderSequence runs only when the sequence structure
    // actually changes (mutations call renderSequence themselves).
    // Cache the per-mode "currently active chip" refs so playback
    // highlight can swap a single class instead of running
    // querySelectorAll + forEach over every chip on every note. The
    // querySelectorAll path was responsible for ~100ms per tick on
    // medium-sized sequences and was starving the scheduler tick.
    let _activeChipMono = null;
    const _activeChipsByLane = new Map(); // laneIdx -> chip element

    function _findChipInScope(scope, stepIdx) {
      if (!scope) return null;
      // Iterate immediate children for speed (chips are usually
      // direct kids of the scope). Descend once into any
      // .key-group-container child so chips wrapped in a visual
      // key-group still get counted at the right step index.
      // Skip pending chord chips and continuation segments so the
      // step-index count matches the sequence array's own indexing.
      let n = 0;
      const visit = (el) => {
        if (!el.classList) return null;
        if (el.classList.contains('key-group-container')) {
          for (const child of el.children) {
            const hit = visit(child);
            if (hit) return hit;
          }
          return null;
        }
        if (!el.classList.contains('seq-step')) return null;
        if (el.classList.contains('chord-pending')) return null;
        if (el.classList.contains('cont-segment')) return null;
        if (n === stepIdx) return el;
        n++;
        return null;
      };
      for (const el of scope.children) {
        const hit = visit(el);
        if (hit) return hit;
      }
      return null;
    }
    // Toggle the .active class on a chip AND every continuation
    // segment that belongs to the same step. Steps that wrap across
    // rows render as a head chip plus one or more .cont-segment
    // clones; this walks the immediately-following siblings so the
    // whole bar lights up as one unit when its step plays.
    function _setChipActive(chip, on) {
      if (!chip) return;
      chip.classList.toggle('active', on);
      let next = chip.nextElementSibling;
      while (next && next.classList && next.classList.contains('cont-segment')) {
        next.classList.toggle('active', on);
        next = next.nextElementSibling;
      }
    }

    function setActiveSequenceChip(index) {
      const display = document.getElementById('sequence-display');
      if (!display) return;
      // Scope the playback highlight to the active lane's chip strip.
      let activeRow = null;
      for (const c of display.children) {
        if (c.classList && c.classList.contains('active')) { activeRow = c; break; }
      }
      const scope = activeRow ? activeRow.querySelector(':scope > .lane-chips') : null;
      const newChip = _findChipInScope(scope, index);
      if (_activeChipMono && _activeChipMono !== newChip) {
        _setChipActive(_activeChipMono, false);
      }
      if (newChip) _setChipActive(newChip, true);
      _activeChipMono = newChip;
    }

    // Update just the label segment of a chip's text without rebuilding
    // the whole chip — used by the variance scheduler to show which
    // alternate note will play next. The chip's text format is
    //   `${label}\n${sound abbr?}\n${dur suffix?}`
    // so replacing only the first \n-delimited segment preserves the
    // sound abbreviation and duration suffix.
    function _updateChipLabelText(stepIdx, laneIdx, label) {
      const display = document.getElementById('sequence-display');
      if (!display) return;
      const li = Number.isFinite(laneIdx) ? laneIdx : activeLaneIdx;
      // Lane rows can be direct children OR nested inside a
      // .lane-row-collapsed-strip wrapper (consecutive collapsed
      // lanes share a horizontal strip). Document order still
      // matches lane order, so a flat .lane-row query indexes
      // correctly regardless.
      const rows = display.querySelectorAll('.lane-row');
      const row = rows[li];
      if (!row) return;
      const chipsScope = row.querySelector(':scope > .lane-chips');
      const chip = _findChipInScope(chipsScope, stepIdx);
      if (!chip) return;
      const parts = (chip.textContent || '').split('\n');
      parts[0] = String(label || '');
      chip.textContent = parts.join('\n');
    }

    // Highlight the currently-playing chip inside a specific lane.
    // Each lane's chip strip is independent in Poly mode, so the
    // 'active' class is scoped per-lane and multiple lanes can have
    // their own active chip simultaneously.
    function setActiveChipForLane(laneIdx, index) {
      const display = document.getElementById('sequence-display');
      if (!display) return;
      // Skip the lane-expander when indexing AND look inside
      // .lane-row-collapsed-strip wrappers for collapsed lanes. A
      // flat `.lane-row` query returns rows in document order which
      // matches lane order regardless of nesting.
      const rows = display.querySelectorAll('.lane-row');
      const row = rows[laneIdx];
      if (!row) return;
      const chipsScope = row.querySelector(':scope > .lane-chips');
      const newChip = _findChipInScope(chipsScope, index);
      const prev = _activeChipsByLane.get(laneIdx);
      if (prev && prev !== newChip) _setChipActive(prev, false);
      if (newChip) _setChipActive(newChip, true);
      if (newChip) _activeChipsByLane.set(laneIdx, newChip);
      else         _activeChipsByLane.delete(laneIdx);
      // Auto-scroll the single-row timeline so the playing step stays centered.
      if (newChip && chipsScope) _centerChipInLane(chipsScope, newChip);
    }
    // Scroll a lane's step strip so `chip` sits centered in the viewport.
    // Computed from bounding rects so nesting (key-group containers) is fine.
    function _centerChipInLane(scope, chip) {
      try {
        const sRect = scope.getBoundingClientRect();
        const cRect = chip.getBoundingClientRect();
        const chipLeftInContent = (cRect.left - sRect.left) + scope.scrollLeft;
        const target = chipLeftInContent - (scope.clientWidth - cRect.width) / 2;
        const max = scope.scrollWidth - scope.clientWidth;
        scope.scrollLeft = Math.max(0, Math.min(max, target));
      } catch (e) {}
    }

    function playSequence(index = 0, freshStart = true) {
      // Always-poly: need at least one non-empty lane to play. Mute /
      // solo are honored live per-tick so the user can flip lanes on
      // and off without restarting.
      // Bloom (ambientMode) lanes are generative — driven by their Bloom
      // engine, NOT step-sequenced. Excluding them here stops the main
      // transport from also playing their raw steps (which carry the source
      // voices, e.g. a merged lane's square notes) on top of / instead of the
      // Bloom output.
      const playable = lanes.filter(l => (l.steps || []).length > 0 && !l.ambientMode);
      if (playable.length === 0) { stopSequence(); return; }
      document.getElementById('play-btn').textContent = '⏹';
      // Build the streams array FIRST so any synchronous setup work
      // (per-lane Tone.Sampler creation, lane-bus node creation,
      // collect() walks of the sources for prefetch) doesn't push
      // _playBaseTime into the past — that was making the very first
      // scheduler tick try to schedule events at audio times already
      // behind rawAudioNow(), which Tone fires "soonest possible" all
      // at once and produces a rushed catch-up at start of play.
      // One stream per playable lane, all sharing the (post-build)
      // _playBaseTime so they start together.
      {
        // Include every non-empty lane as its own stream — mute / solo
        // are checked LIVE per step inside the scheduler so the user
        // can toggle them during playback without restarting.
        // Lanes with a locked drift offset start their stream at that
        // offset so the lag persists across stop / play cycles and
        // round-trips through save/load.
        _schedStreams = lanes
          .map((lane, laneIdx) => ({ lane, laneIdx }))
          .filter(({ lane }) => (lane.steps || []).length > 0 && !lane.ambientMode)
          .map(({ lane, laneIdx }) => {
            const baseOffset = Number.isFinite(lane.driftOffsetSec) ? lane.driftOffsetSec : 0;
            // Warm up the lane's per-sample Tone.Samplers eagerly so
            // their async buffer loads kick off before the first
            // scheduler tick. Without this prefetch, the first few
            // events on a freshly-created lane would have to fall
            // back to the shared sampler (or sine) until the lane
            // sampler finishes loading.
            try {
              const sampleTypes = new Set();
              const collect = (arr) => {
                if (!Array.isArray(arr)) return;
                for (const s of arr) {
                  if (!s) continue;
                  if (s.isSub && Array.isArray(s.subSteps)) { collect(s.subSteps); continue; }
                  if (Array.isArray(s.chord)) {
                    s.chord.forEach(n => {
                      const t = (n && n.params && n.params.type) || (n && n.sound);
                      if (typeof t === 'string' && t.startsWith('sample:')) sampleTypes.add(t.slice(7));
                    });
                  } else {
                    const t = (s.params && s.params.type) || s.sound;
                    if (typeof t === 'string' && t.startsWith('sample:')) sampleTypes.add(t.slice(7));
                  }
                  if (s.variance && Array.isArray(s.variance.notes)) {
                    s.variance.notes.forEach(v => {
                      const t = (v && v.params && v.params.type) || (v && v.sound);
                      if (typeof t === 'string' && t.startsWith('sample:')) sampleTypes.add(t.slice(7));
                    });
                  }
                }
              };
              collect(lane.steps);
              sampleTypes.forEach(id => { try { getOrCreateLaneSampler(laneIdx, id); } catch (e) {} });
            } catch (e) {}
            return {
              source:           lane.steps,
              idx:              0,
              subStack:         [],
              offsetSec:        baseOffset,
              laneIdx,
              iter:             0,
              driftAccumSec:    baseOffset,
              pendingClearDrift: false,
              ended:            false,
            };
          });
      }
      if (freshStart) {
        // Anchor _playBaseTime AFTER all stream-building synchronous
        // work so the first scheduler tick lines up with the actual
        // current audio time. Tone.now() includes the scheduling
        // lookAhead so the audio thread still has its usual head-room.
        _playBaseTime = Tone.now();
        _playOffsetSec = 0;
        // Re-phase the BPM digit pulse so its red-peak frame lands on
        // the first note attack.
        scheduleVisual(() => restartBpmDigitAnimation(), _playBaseTime);
        // Re-phase the metronome (if it's on) to fire its first click
        // at the same synchronous moment _playBaseTime is captured.
        // Both the sequence's first event and the metronome's first
        // triggerAttackRelease() default to Tone.now(), which includes
        // the same lookAhead — so the click lands on top of beat 1
        // instead of wherever its prior interval happened to land.
        _restartMetronomeIfActive();
      }
      _schedStopping    = false;
      _schedTailEndTime = _playBaseTime;
      // Fire-and-forget the worklet load on first play — the walk's
      // _scheduleDispatch() falls back to direct dispatch until the
      // node is up, then automatically switches over once it's ready.
      // No await: blocking here would delay the synchronous first tick
      // below and clip the start of the very first note.
      if (typeof _ensureBloopsSchedulerNode === 'function') {
        try { _ensureBloopsSchedulerNode(); } catch (e) {}
      }
      // Synchronous first tick so the first batch of audio events lands
      // immediately rather than waiting one SCHED_TICK_MS.
      schedulerTick();
    }

    document.getElementById('play-btn').addEventListener('click', async () => {
      // Stop-toggle FIRST. The "is anything playable?" check has to
      // come after — in Poly mode `sequence` is aliased to the active
      // lane, and that lane can be empty while OTHER lanes are still
      // running, in which case the user still needs to be able to stop.
      await Tone.start();
      if (sequenceTimer !== null) {
        stopSequence();
        return;
      }
      // Need at least one playable source to start — any lane with
      // content (the active lane may be empty while another plays).
      const playable = lanes.some(l => (l.steps || []).length > 0);
      if (!playable) return;
      // Wait for any pending sample buffers — without this the first
      // sample-based attack would be silent on a cold load. BUT cap the
      // wait: the app registers ~130 remote GM-instrument samplers that
      // stream from a third-party CDN (gleitz.github.io). If that CDN is
      // slow or unreachable, those buffers stay "pending" forever and a
      // bare `await Tone.loaded()` would block playback indefinitely —
      // the user clicks Play and nothing happens. Race it against a short
      // timeout so local samples still get their moment to load while a
      // dead/slow CDN can't hold the whole transport hostage.
      try {
        await Promise.race([
          Tone.loaded(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      } catch (e) {}
      // Skip the warmup pad when the audio context is already running;
      // the 60ms cushion is only needed on a true cold-start where the
      // first attack can otherwise clip. Warm-state taps now play
      // immediately.
      const ac = Tone.context && Tone.context.rawContext;
      const warm = !!(ac && ac.state === 'running');
      const startNow = () => {
        if (sequenceTimer !== null) return;
        const stillPlayable = lanes.some(l => (l.steps || []).length > 0);
        if (stillPlayable) playSequence(0);
      };
      if (warm) startNow();
      else setTimeout(startNow, 60);
    });

    // ---- WebMIDI input ----
    // A MIDI key press should behave identically to clicking the
    // matching grid cell — including chord-mode wrap building, smart
    // wrap diatonic triads, jump mode, wrap-template auditioning,
    // sustain, and Keep-mode step capture. The simplest way to
    // achieve that parity is to find the cell whose pitch matches
    // the incoming MIDI note and dispatch a synthetic pointerdown
    // on it. Note-off dispatches pointerup. Out-of-window notes
    // (the user played a key the visible grid doesn't show) fall
    // back to a direct audition via playNote so MIDI input is
    // always audible.
    //
    // No UI toggle: just plug in a controller and play. The MIDI
    // permission request happens on the first user gesture so the
    // browser prompt isn't surprising.
    let _midiBound = false;
    // Track which cell each live MIDI note is "pressing" so the
    // note-off can dispatch pointerup on the same cell. midi → cellIdx
    // (or null for direct-audition notes that bypassed the grid).
    const _midiActiveByNote = new Map();
    function _midiCellIdxForNote(midi) {
      for (let i = 0; i < notes.length; i++) {
        if (notes[i] && _midiOfFreq(notes[i].freq) === midi) return i;
      }
      return -1;
    }
    // Pointer ID range carved out for MIDI events so they can never
    // collide with real touch / mouse / pen IDs (which typically sit
    // in 1-N or browser-specific large ints; 200000+ is safely apart).
    const _MIDI_POINTER_ID_BASE = 200000;
    function _dispatchSyntheticPointer(cell, type, midi) {
      try {
        const evt = new PointerEvent(type, {
          pointerId: _MIDI_POINTER_ID_BASE + midi,
          pointerType: 'pen',
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          isPrimary: true,
        });
        cell.dispatchEvent(evt);
      } catch (e) {
        // PointerEvent constructor is universal in modern browsers,
        // but defend against ancient ones — log once and bail so
        // MIDI doesn't spam the console.
        console.warn('[bloops-midi] synthetic ' + type + ' failed:', e);
      }
    }
    function _midiHandleNoteOn(midi, velocity) {
      // Re-trigger guard: some controllers send note-on twice without
      // a note-off (sticky keys). Treat the second as a no-op so the
      // existing press isn't released.
      if (_midiActiveByNote.has(midi)) return;
      // Best-effort start the audio context. Tone.start() is a no-op
      // when already running; when not, the MIDI message itself isn't
      // a "user gesture" the browser recognizes — but the click that
      // triggered _bindMidiOnce probably was, so this usually
      // succeeds. If it doesn't, the user's next click will warm it.
      try { Tone && Tone.start && Tone.start(); } catch (e) {}
      const cellIdx = _midiCellIdxForNote(midi);
      if (cellIdx >= 0 && cells[cellIdx]) {
        _midiActiveByNote.set(midi, cellIdx);
        _dispatchSyntheticPointer(cells[cellIdx], 'pointerdown', midi);
        return;
      }
      // No matching cell — the user played outside the visible grid
      // window. Audition the freq directly using the active lane's
      // first-cell sound as a reasonable proxy. Marked with null
      // cellIdx so note-off knows not to dispatch pointerup.
      _midiActiveByNote.set(midi, null);
      try {
        const freq = masterFreqA * Math.pow(2, (midi - 69) / 12);
        const baseParams = (cellParams && cellParams[0]) || { type: 'sine' };
        const params = { ...baseParams };
        // Scale velocity into the existing 0-100 volume domain so
        // a hard-hit key is louder than a feather-tap.
        const vel = Math.max(1, Math.min(127, velocity || 100)) / 127;
        params.volume = Math.max(1, Math.min(100, Math.round((baseParams.volume ?? 100) * vel)));
        playNote(freq, params, 250);
      } catch (e) {}
    }
    function _midiHandleNoteOff(midi) {
      const cellIdx = _midiActiveByNote.get(midi);
      _midiActiveByNote.delete(midi);
      if (cellIdx == null) return; // never pressed, or was a direct audition
      if (cells[cellIdx]) _dispatchSyntheticPointer(cells[cellIdx], 'pointerup', midi);
    }
    function bindWebMidi() {
      if (_midiBound) return;
      if (!navigator.requestMIDIAccess) return;
      _midiBound = true;
      navigator.requestMIDIAccess({ sysex: false }).then(access => {
        const wire = (input) => {
          if (!input || input._bloopsBound) return;
          input._bloopsBound = true;
          input.onmidimessage = (e) => {
            if (!e || !e.data || e.data.length < 2) return;
            const status = e.data[0];
            const d1     = e.data[1];
            const d2     = e.data[2] || 0;
            const cmd    = status & 0xf0;
            // Note-on with velocity 0 is the disguised note-off some
            // controllers send (saves a status byte). Handle both as
            // a release. True note-off (0x80) gets the same path.
            if (cmd === 0x90 && d2 > 0)        _midiHandleNoteOn(d1, d2);
            else if (cmd === 0x80 || cmd === 0x90) _midiHandleNoteOff(d1);
            // Other MIDI commands (program change, CC, pitch bend,
            // aftertouch, etc.) intentionally ignored for now —
            // they'd need their own routing decisions.
          };
        };
        access.inputs.forEach(wire);
        access.onstatechange = (e) => {
          if (e.port && e.port.type === 'input' && e.port.state === 'connected') wire(e.port);
        };
      }).catch(() => { /* user denied or no MIDI — silent fall-back */ });
    }
    // Defer binding to the first user gesture so the permission prompt
    // doesn't fire before the user has interacted with the page.
    const _bindMidiOnce = () => {
      bindWebMidi();
      document.removeEventListener('pointerdown', _bindMidiOnce);
      document.removeEventListener('keydown',     _bindMidiOnce);
    };
    document.addEventListener('pointerdown', _bindMidiOnce, { once: true });
    document.addEventListener('keydown',     _bindMidiOnce, { once: true });

    document.getElementById('clear-btn').addEventListener('click', () => {
      if (sequence.length === 0) {
        // Sequence is already empty, but the XY pad may still be
        // showing trail dots from a prior recording — let Clear wipe
        // those too so the visual matches the audible state.
        try { _clearXyTrail(); } catch (e) {}
        return;
      }
      // While Step Mode is on, Clear empties the cells but keeps the grid:
      // Clear empties everything — the user re-adds slots via the
      // size-chip row.
      if (stepMode) {
        if (sequence.length === 0) return;
        snapshotForUndo('Clear');
        stopSequence();
        sequence = [];
        pendingChord = [];
        activeSeqIndex = null;
        insertionPoint = null;
        renderSequence();
        renderSavedSequences();
        try { _clearXyTrail(); } catch (e) {}
        return;
      }
      snapshotForUndo('Clear');
      stopSequence();
      sequence = [];
      pendingChord = [];
      activeSeqIndex = null;
      insertionPoint = null;
      renderSequence();
      renderSavedSequences();
      document.getElementById('save-btn').disabled = true;
      try { _clearXyTrail(); } catch (e) {}
    });

    document.getElementById('reverse-btn').addEventListener('click', () => {
      if (sequence.length < 2) return;
      snapshotForUndo('Reverse');
      stopSequence();
      if (keepMode) {
        // Keep on: append a reversed copy so the original stays put and
        // the user gets a longer sequence ending in the mirror.
        const reversed = sequence.map(cloneStep).reverse();
        sequence = sequence.concat(reversed);
      } else {
        sequence.reverse();
      }
      pendingChord = [];
      insertionPoint = null;
      renderSequence();
    });

    document.getElementById('shuffle-btn').addEventListener('click', () => {
      if (sequence.length < 2) return;
      snapshotForUndo('Shuffle');
      stopSequence();
      const shuffleInPlace = (arr) => {
        // Fisher-Yates
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      };
      if (keepMode) {
        // Keep on: append a shuffled copy of the current sequence.
        const shuffled = sequence.map(cloneStep);
        shuffleInPlace(shuffled);
        sequence = sequence.concat(shuffled);
      } else {
        shuffleInPlace(sequence);
      }
      pendingChord = [];
      insertionPoint = null;
      renderSequence();
    });

    // Rotate — same cyclic shift the Generate Sequence "Rotate" control does
    // to the Euclidean pattern: a left rotation by one (the first step moves
    // to the end, everything else shifts one place earlier). Each press
    // rotates by one more. Keep off rotates the current sequence in place;
    // Keep on leaves the original and appends a rotated copy (matching how
    // Reverse / Shuffle behave with Keep on).
    document.getElementById('rotate-btn').addEventListener('click', () => {
      if (sequence.length < 2) return;
      snapshotForUndo('Rotate');
      stopSequence();
      const rotateLeftInPlace = (arr) => { if (arr.length > 1) arr.push(arr.shift()); };
      if (keepMode) {
        const rotated = sequence.map(cloneStep);
        rotateLeftInPlace(rotated);
        sequence = sequence.concat(rotated);
      } else {
        rotateLeftInPlace(sequence);
      }
      pendingChord = [];
      insertionPoint = null;
      renderSequence();
    });

    // Shift Up / Shift Down — move every note in the sequence by one scale
    // degree (one semitone on chromatic). Keep off shifts the current
    // sequence in place; Keep on leaves the original and appends a shifted
    // copy (same convention as Reverse / Shuffle / Rotate).
    const _riffShiftByDegree = (dir, undoLabel) => {
      if (sequence.length === 0) return;
      snapshotForUndo(undoLabel);
      stopSequence();
      const shifted = sequence.map(s => transposeStepByScaleDegree(s, dir));
      sequence = keepMode ? sequence.concat(shifted) : shifted;
      pendingChord = [];
      insertionPoint = null;
      renderSequence();
    };
    document.getElementById('shift-up-btn')?.addEventListener('click', () => _riffShiftByDegree(1, 'Shift up'));
    document.getElementById('shift-down-btn')?.addEventListener('click', () => _riffShiftByDegree(-1, 'Shift down'));

    document.getElementById('repeat-btn').addEventListener('click', () => {
      if (sequence.length === 0) return;
      snapshotForUndo('Repeat');
      stopSequence();
      const copy = sequence.map(cloneStep);
      sequence = sequence.concat(copy);
      pendingChord = [];
      insertionPoint = null;
      renderSequence();
    });

    // Hold: when steps are selected, edit those steps' durations in place
    // (all of them when Multi is on; just the primary otherwise). With no
    // selection, update the global default for the next note added.
    // Step Div: edits the selected steps' subdivisions (all of them when
    // Multi is on; just the primary otherwise). With no selection, sets
    // the global next-note default.
    document.getElementById('subdivision-select')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value) || 1;
      if (selectedStepRefs.length > 0) {
        // Selection is the scope — size applies to every selected step.
        const targets = selectedStepRefs.filter(Boolean);
        if (targets.length > 0) snapshotForUndo('Size');
        targets.forEach(s => { if (s && !s.isSub) s.subdivision = v; });
        renderSequence();
      } else if (wrapTemplate && wrapTemplate.isSub && Array.isArray(wrapTemplate.subSteps) && wrapTemplate.subSteps.length > 0) {
        // Active sub-shaped wrap (Run mode): retime every voice in the
        // wrap to the new Step Div so the held audition (and any saved
        // copy of this wrap in the sequence) plays at the chosen size.
        snapshotForUndo('Size');
        wrapTemplate.subSteps.forEach(s => { if (s) s.subdivision = v; });
        stepSubdivision = v;
        renderSequence();
        refreshBpmDigits();
      } else {
        stepSubdivision = v;
        // The flash cycle is keyed off step duration — refresh so the
        // pulse rate matches the new subdivision.
        refreshBpmDigits();
      }
      refreshHoldEnabled();
    });

    document.getElementById('multi-select-toggle').addEventListener('change', (e) => {
      multiSelectMode = !!e.target.checked;
      // When turning multi off, collapse to just the primary so the user
      // doesn't accidentally bulk-edit one chip while thinking only one
      // is selected.
      if (!multiSelectMode && selectedStepRefs.length > 1) {
        const primary = lastSelectedStep();
        selectedStepRefs = primary ? [primary] : [];
      }
      renderSequence();
    });

    // ---- Quantize-holds toggle ----------------------------------------
    // When on, _holdStepDurationFromMs rounds press durations to the
    // NEAREST step division instead of the original round-UP behavior.
    // Persisted across reloads via localStorage so the user's preference
    // sticks; default off so existing behavior doesn't shift on upgrade.
    let quantizeHolds = (() => {
      try { return JSON.parse(localStorage.getItem('sounds-quantize-holds') || 'false') === true; }
      catch (e) { return false; }
    })();
    (function initQuantizeHoldsToggle() {
      const cb = document.getElementById('quantize-holds-toggle');
      if (!cb) return;
      cb.checked = quantizeHolds;
      cb.addEventListener('change', (e) => {
        quantizeHolds = !!e.target.checked;
        try { localStorage.setItem('sounds-quantize-holds', JSON.stringify(quantizeHolds)); } catch (e) {}
      });
    })();

    // Grid dimension inputs (rows × cols). `change` fires on commit
     // (Enter / blur), `input` fires per keystroke; we re-render on
     // change so a partially-typed value doesn't reflow mid-typing.
    function readGridDimsFromInputs() {
      const rowsEl = document.getElementById('grid-rows-input');
      const colsEl = document.getElementById('grid-cols-input');
      if (rowsEl) {
        const r = parseInt(rowsEl.value, 10);
        gridRows = Number.isFinite(r) && r > 0 ? Math.min(8, r) : 1;
        rowsEl.value = String(gridRows);
      }
      if (colsEl) {
        const c = parseInt(colsEl.value, 10);
        gridColumns = Number.isFinite(c) && c > 0 ? Math.min(8, c) : 1;
        colsEl.value = String(gridColumns);
      }
    }
    function applyGridDimsChange() {
      readGridDimsFromInputs();
      // The rows count drives the lane count — resize the lanes array
      // up/down accordingly so changing Grid rows adds or trims lanes.
      _resizeLanesToGridRows();
      renderSequence();
    }
    document.getElementById('grid-rows-input')?.addEventListener('change', applyGridDimsChange);
    document.getElementById('grid-cols-input')?.addEventListener('change', applyGridDimsChange);

    // Mono / Poly toggle removed — workspace is always lane-based.
    // Button stays in the DOM (hidden) so any lingering selectors that
    // expect to find it don't error out on a missing element.

    // ---- Fixed-mode size chips ----
    // Each chip appends a programmable rest slot of its Step Div size
    // to the current sequence. The slot keeps that subdivision when a
    // pitch is later assigned via the arm + slot-click flow.
    document.querySelectorAll('#size-chips-row .size-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const sub = parseFloat(chip.dataset.sub);
        if (!Number.isFinite(sub) || sub <= 0) return;
        addToSequence({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision: sub });
      });
    });

    // Step Mode toggle: Free (append-as-you-click) ↔ Fixed (step-sequencer
     // grid). The single source of truth for the label/active state on the
     // button is this helper — every state-change site below calls it
     // instead of rewriting textContent + .active by hand.
    function refreshStepModeBtn() {
      const btn = document.getElementById('step-mode-btn');
      if (!btn) return;
      btn.textContent = stepMode ? 'Fixed' : 'Free';
      btn.classList.toggle('active', stepMode);
      // Rows controls lane count (always-poly) and Fixed-mode slot
      // grid count. Always enabled now.
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.disabled = false;
      // Size-chip row is the slot builder — only meaningful in Fixed mode.
      const sizeRow = document.getElementById('size-chips-row');
      if (sizeRow) sizeRow.hidden = !stepMode;
    }
    refreshStepModeBtn();

    document.getElementById('step-mode-btn').addEventListener('click', () => {
      stepMode = !stepMode;
      refreshStepModeBtn();
      if (stepMode) {
        // Fixed-mode entry no longer pre-populates the lane with rests
        // — the lane keeps whatever it had. Pressing Keep starts the
        // sequential edit flow (see _fixedSeqStart below): the first
        // step in the active lane gets selected, the next grid press
        // writes it, selection advances. Empty lanes need at least
        // one step in place before Keep arms the flow.
        if (keepMode) _fixedSeqStart();
      } else {
        clearStepModeArm();
        // Fixed-mode exit: also clear any in-progress sequential edit
        // so the next entry starts fresh from the first step.
        _fixedSeqActive = false;
        // Trim trailing rest slots from EVERY lane so
        // the cleanup mirrors the entry's all-lanes padding. Lanes that
        // contain only rests get fully cleared (no leftover placeholder
        // chips); lanes with real notes just lose trailing silences.
        const trimLane = (steps) => {
          if (!Array.isArray(steps)) return steps;
          if (steps.length > 0 && steps.every(isRestStep)) return [];
          let trimEnd = steps.length;
          while (trimEnd > 0 && isRestStep(steps[trimEnd - 1])) trimEnd--;
          if (trimEnd < steps.length) steps.length = trimEnd;
          return steps;
        };
        if (Array.isArray(lanes) && lanes.length > 0) {
          stopSequence();
          lanes.forEach(lane => { lane.steps = trimLane(lane.steps || []); });
          _aliasSequenceToActiveLane();
          pendingChord = [];
          insertionPoint = null;
          if (sequence.length === 0) {
            const saveBtn = document.getElementById('save-btn');
            if (saveBtn) saveBtn.disabled = true;
          }
        } else {
          if (sequence.length > 0 && sequence.every(isRestStep)) {
            stopSequence();
            sequence = [];
            pendingChord = [];
            insertionPoint = null;
            document.getElementById('save-btn').disabled = true;
          } else {
            let trimEnd = sequence.length;
            while (trimEnd > 0 && isRestStep(sequence[trimEnd - 1])) trimEnd--;
            if (trimEnd < sequence.length) {
              stopSequence();
              sequence.length = trimEnd;
              if (insertionPoint != null && insertionPoint > sequence.length) {
                insertionPoint = sequence.length;
              }
            }
          }
        }
      }
      renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    });

    function resetUIToDefault() {
      stopSequence();
      stopAllTracks();
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch (e) {}
      }
      if (_previewAudio) { try { _previewAudio.pause(); } catch (e) {} _previewAudio = null; }
      sequence = [];
      pendingChord = [];
      insertionPoint = null;
      chordMode = false;
      loopMode = false;
      noteLength = 1;
      stepSubdivision = 0.5;
      gridColumns = 8;
      gridRows = 1;
      rootIdx = 0;
      baseOctave = 4;
      octaveCount = 1;
      masterFreqA = 440;
      currentScale = 'chromatic';
      // Fresh project: dispose existing lane audio nodes, then seed a
      // single empty lane (always-poly invariant — lanes is never []).
      if (typeof disposeAllLaneAudio === 'function') disposeAllLaneAudio(lanes);
      lanes = [];
      activeLaneIdx = 0;
      _stashedLanes = null;
      ensureLanesInitialized();
      if (typeof refreshPolyModeBtn === 'function') refreshPolyModeBtn();
      palette = [...DEFAULT_PALETTE];
      chipPalette = [...palette];
      restColor = DEFAULT_REST_COLOR;
      applyRestColor();
      activeSeqIndex = null;

      document.getElementById('root-select').value       = '0';
      const octRange0 = document.getElementById('octave-range-select');
      if (octRange0) octRange0.value = '4x1';
      document.getElementById('master-freq-slider').value = '440';
      document.getElementById('master-freq-input').value  = '440';
      document.getElementById('scale-select').value     = 'chromatic';
      document.getElementById('tempo-slider').value     = '120';
      document.getElementById('tempo-input').value      = '120';
      wrapTemplate = null;
      activeWrapBankId = null;
      refreshWrapVisuals();
      renderWrapBank();
      clearWrapPendingHighlights();
      document.getElementById('loop-btn').classList.remove('active');
      document.getElementById('subdivision-select').value = '0.5';
      const colsEl0 = document.getElementById('grid-cols-input');
      const rowsEl0 = document.getElementById('grid-rows-input');
      if (colsEl0) colsEl0.value = '8';
      if (rowsEl0) rowsEl0.value = '1';
      document.getElementById('save-btn').disabled = true;
      refreshHoldEnabled();

      rebuildGrid({ resetTones: true });
      renderSequence();
      renderSavedSequences();
    }

